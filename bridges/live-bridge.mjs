#!/usr/bin/env node
// wxmp-preview · 方案 A 实时流：CDP screencast 常驻守护。
// 与其他桥不同：不是一次性进程，而是由 $.process.spawn 拉起长驻，
// stdout 持续吐 JSON 行，插件逐行消费并 blit。
// 用法: node live-bridge.mjs --url URL [--out PATH] [--browser PATH]
//                [--max-fps 15] [--width 375] [--height 667]
//                [--idle-exit-ms 900000]
// 输出（stdout 每行一个 JSON）：
//   {"ok":true,"event":"started","pid":...,"path":...}        screencast 已启动
//   {"ok":true,"event":"frame","frame":N,"path":...,"width":..,"height":..}
//   {"ok":false,"error":"..."}                                  致命错误，随后退出
//
// 帧语义：screencast 只在画面变化时出帧（HMR 改页面 → 新帧）；写盘走
// tmp+rename 原子换帧，blit 永远读不到半截 PNG。ack 每帧必发（CDP 流控），
// 节流只影响写盘与上报。空闲 15 分钟自动退出（被遗弃的守护自回收），
// SIGTERM/SIGINT 会带走 chromium。

import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 2) {
    const key = list[i]?.replace(/^--/, '')
    if (key) out[key] = list[i + 1]
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))

const WIDTH = Number(argv.width ?? 375)
const HEIGHT = Number(argv.height ?? 667)
const MAX_FPS = Number(argv['max-fps'] ?? 15)
const IDLE_EXIT_MS = Number(argv['idle-exit-ms'] ?? 900000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-live-${process.pid}.png`)
/** 插件用来孤儿回收的 PID 文件；退出时只在内容仍是自己 PID 时才删（防误删新守护的） */
const PIDFILE = argv.pidfile ?? null
/** dev server 未运行时自动拉起用的脚本与目录（detect 提供；null = 不具备自启条件） */
const START_SCRIPT = argv['start-script'] ?? null
const START_DIR = argv['start-dir'] ?? '.'

/** 自动拉起的 dev server 的 pidfile 与日志（与 h5-bridge 共用，同机单实例） */
const DEV_PID = '/tmp/wxmp-h5-dev.pid'
const DEV_LOG = '/tmp/wxmp-h5-dev.log'
/** 归属校验的工程根（--start-dir 解析）；防的是"别的项目的 dev server 恰好占着端口" */
const OWNERSHIP_ROOT = resolve(START_DIR)

/** 记录被拒用的外来 server，供报错文案说明 */
let foreignNote = ''

const emit = msg => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, error: `${cmd}: ${err.message}`, stdout, stderr })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

// deb 系（google-chrome 等）排前面：snap 版 chromium 的沙箱会吞文件与端口行为，
// 无 snap 的机器上顺序无所谓（与 h5/simulate 桥保持一致）
async function findBrowsers(explicit) {
  const candidates = [explicit, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'].filter(Boolean)
  const found = []
  for (const cmd of candidates) {
    const res = await run(cmd, ['--version'], 5000)
    if (res.ok) found.push(cmd)
  }
  return found
}

/** PNG 头 IHDR 里读宽高（大端，偏移 16/20），帧事件里上报给插件 */
const pngSize = buf => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

/** 探活一个 URL（2.5s 超时） */
const alive = async u => {
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(2500), redirect: 'follow' })
    return res.ok ? u : null
  } catch {
    return null
  }
}

/** 常见 dev server 端口（uni·vite 5173 / webpack 8080·3000） */
const CANDIDATE_PORTS = [5173, 8080, 3000]

/**
 * URL 的监听进程是否属于当前工程（Linux：ss 查监听 pid → /proc/<pid>/cwd）。
 * 查不动（无 ss / 非 Linux / 拿不到 pid）一律放行——宽松优先，别误杀可用路径。
 */
async function serverOwned(url) {
  try {
    const port = Number(new URL(url).port)
    if (!Number.isInteger(port) || port <= 0) return true
    const res = await run('ss', ['-tlnp'], 5000)
    if (!res.ok) return true
    const line = res.stdout.split('\n').find(l => l.includes(`:${port} `))
    if (line === undefined) return true
    const pidMatch = line.match(/pid=(\d+)/)
    if (pidMatch === null) return true
    const cwd = await run('readlink', [`/proc/${pidMatch[1]}/cwd`], 3000)
    if (!cwd.ok) return true
    const dir = cwd.stdout.trim()
    if (dir === '') return true
    return (
      dir === OWNERSHIP_ROOT ||
      dir.startsWith(OWNERSHIP_ROOT + '/') ||
      OWNERSHIP_ROOT.startsWith(dir + '/')
    )
  } catch {
    return true
  }
}

/**
 * 确保 dev server 可用：探活 → 常见端口 → 自动拉起并等就绪（与 h5-bridge
 * 同一套 pidfile，幂等）。返回可用 URL 或 null。
 */
async function ensureServer(cfgUrl) {
  if ((await alive(cfgUrl)) && (await serverOwned(cfgUrl))) return cfgUrl
  if (await alive(cfgUrl)) foreignNote = `${cfgUrl} 上跑着其他工程的 dev server（已拒用）`
  for (const port of CANDIDATE_PORTS) {
    const alt = await alive(`http://localhost:${port}`)
    if (alt !== null && (await serverOwned(alt))) return alt
    if (alt !== null && foreignNote === '') foreignNote = `${alt} 上跑着其他工程的 dev server（已拒用）`
  }
  if (START_SCRIPT === null) return null

  let alreadyStarting = false
  try {
    const pid = Number(readFileSync(DEV_PID, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      alreadyStarting = (await run('kill', ['-0', String(pid)], 3000)).ok
    }
  } catch {
    // 无 pidfile：走拉起
  }
  if (!alreadyStarting) {
    const log = await open(DEV_LOG, 'a')
    const child = spawn('npm', ['run', START_SCRIPT], {
      cwd: resolve(START_DIR),
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.unref()
    // spawn 已 dup fd 给子进程，父侧句柄显式关掉（消 DEP0137）
    await log.close()
    await writeFile(DEV_PID, String(child.pid))
  }

  const candidates = [cfgUrl, ...CANDIDATE_PORTS.map(p => `http://localhost:${p}`)]
  const deadline = Date.now() + 70000
  while (Date.now() < deadline) {
    for (const c of candidates) {
      if (await alive(c)) return c
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

async function main() {
  // 1. dev server：探活 → 常见端口兜底 → 自动拉起并等就绪
  let pageUrl = argv.url ?? 'http://localhost:10086'
  const ready = await ensureServer(pageUrl)
  if (ready === null) {
    return emit({
      ok: false,
      error:
        START_SCRIPT === null
          ? `H5 dev server 不可达：${pageUrl} —— 本项目没有 dev:h5 类脚本，方案 A 不适用${foreignNote === '' ? '' : `；${foreignNote}`}。建议 /wxmp 换方案 B（开发者工具直出）`
          : `dev server 自动启动后 70s 内未就绪（${START_DIR}: npm run ${START_SCRIPT}）—— 看 ${DEV_LOG} 排查；端口不在 10086/5173/8080/3000 之列时需在插件配置 h5Url 指定`,
    })
  }
  if (ready !== pageUrl) {
    emit({ ok: true, event: 'log', msg: `配置的 ${pageUrl} 不可达，改用 ${ready}` })
    pageUrl = ready
  }

  // 2. 找浏览器
  const browsers = await findBrowsers(argv.browser)
  if (browsers.length === 0) {
    return emit({ ok: false, error: '未找到 Chromium/Chrome —— 安装一个，或在插件配置 browser 里指定路径' })
  }

  // 3. 起 chromium：调试端口自动分配，从 stderr 解析 DevTools WS 地址。
  //    视口按手机 CSS 尺寸（375x667），dsf=2 让 screencast 出 2x 清晰度的帧。
  //    注意：不能加 --disable-gpu——screencast 走合成器回读，禁 GPU 只出白帧
  //    （captureScreenshot 有软件兜底不受影响，别被一次性截图的正常骗了）
  const chrome = spawn(browsers[0], [
    '--headless=new',
    '--no-sandbox',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-device-scale-factor=2',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let closed = false
  const cleanup = code => {
    if (closed) return
    closed = true
    clearInterval(idleTimer)
    if (PIDFILE !== null) {
      try {
        if (readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) unlinkSync(PIDFILE)
      } catch {
        // 读不到（已删/权限）就不管
      }
    }
    try { server?.close() } catch { /* 已关 */ }
    try { ws?.close() } catch { /* 已关 */ }
    try { chrome.kill('SIGTERM') } catch { /* 已退 */ }
    process.exit(code)
  }
  let idleTimer = null
  let ws = null
  let server = null
  process.on('SIGTERM', () => cleanup(0))
  process.on('SIGINT', () => cleanup(0))
  chrome.on('close', () => { if (!closed) cleanup(0) })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('10 秒内没等到 DevTools 端口（chromium stderr 无 listening 行）')), 10000)
    chrome.stderr.on('data', d => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
  }).catch(err => err)
  if (wsUrl instanceof Error) {
    chrome.kill('SIGKILL')
    return emit({ ok: false, error: wsUrl.message })
  }

  // 4. CDP：浏览器级 WS + flat session
  ws = new WebSocket(wsUrl)
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WS 连接超时')), 10000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('DevTools WS 连接失败')) }
    })
  } catch (err) {
    cleanup(0)
    return emit({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }

  let seq = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 10000)
    })

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    } else {
      void onEvent(msg).catch(() => undefined)
    }
  }
  ws.onclose = () => { if (!closed) cleanup(0) }

  // 5. 开直播再导航：先开 about:blank 的 screencast，再 Page.navigate——
  //    顺序反过来（先加载后开播）会错过首屏绘制，screencast 只报变化，
  //    静态页面永远停在白帧上
  let session = null
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const attached = await send('Target.attachToTarget', { targetId, flatten: true })
    session = attached.sessionId
    await send('Page.enable', {}, session)
    // headless 的后台标签可能不合成，先调到前台再开直播
    await send('Page.bringToFront', {}, session)
    await send(
      'Page.startScreencast',
      { format: 'png', maxWidth: WIDTH * 2, maxHeight: HEIGHT * 2, everyFrameIfNecessary: false },
      session,
    )
    await send('Page.navigate', { url: pageUrl }, session)
    // SwiftShader 惰性合成：headless 无 GPU 时合成器不主动上屏，静态内容
    // 永远等不来 screencast 帧。导航后用 captureScreenshot 踢一脚强制合成，
    // 首屏内容帧随即流入；之后的真实变化（HMR/点击）由 screencast 自己报
    setTimeout(() => {
      void send('Page.captureScreenshot', { format: 'png' }, session).catch(() => undefined)
    }, 2000)
  } catch (err) {
    cleanup(0)
    return emit({ ok: false, error: `CDP 启动失败：${err instanceof Error ? err.message : String(err)}` })
  }
  // 6. 控制通道：localhost HTTP。spawn 的 stdin 天生关闭，点击指令从这里进；
  //    端口随 started 事件上报，插件拿它 POST /click（坐标为帧像素，÷2 成 CSS）
  server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/click') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"not found"}')
      return
    }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      void (async () => {
        try {
          const { x, y } = JSON.parse(body)
          if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('坐标必须是有限数字')
          }
          // 帧像素 → CSS：按最近一帧的 宽度比 换算（dsf 与视口quirk都吃掉）
          const buf = await readFile(OUT).catch(() => null)
          const frameW = buf === null ? WIDTH * 2 : pngSize(buf).width
          const scale = lastCssWidth / frameW
          const cssX = x * scale
          const cssY = y * scale
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cssX, y: cssY, button: 'left', clickCount: 1 }, session)
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cssX, y: cssY, button: 'left', clickCount: 1 }, session)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })()
    })
  })
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })

  if (PIDFILE !== null) writeFileSync(PIDFILE, String(process.pid))
  emit({ ok: true, event: 'started', pid: process.pid, path: OUT, port: server.address().port })

  // 6. 帧循环：ack 每帧必发（流控）；节流只影响写盘与上报
  let frame = 0
  let lastEmit = 0
  let lastFrameAt = Date.now()
  // 最近一帧的 CSS 视口宽（metadata.deviceWidth），点击坐标按它换算
  let lastCssWidth = WIDTH
  async function onEvent(msg) {
    if (msg.method !== 'Page.screencastFrame') return
    const sid = msg.params?.sessionId
    try {
      await send('Page.screencastFrameAck', { sessionId: sid }, session)
    } catch {
      // ack 失败通常意味着页面在关闭，等 ws close 兜底
    }
    const now = Date.now()
    lastFrameAt = now
    const meta = msg.params.metadata
    if (typeof meta?.deviceWidth === 'number' && meta.deviceWidth > 0) lastCssWidth = meta.deviceWidth
    if (now - lastEmit < 1000 / MAX_FPS) return
    lastEmit = now
    frame += 1
    const buf = Buffer.from(msg.params.data, 'base64')
    const { width, height } = pngSize(buf)
    const tmp = `${OUT}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, OUT)
    emit({ ok: true, event: 'frame', frame, path: OUT, width, height })
  }

  // 7. 空闲自杀：被遗弃的守护（会话已死、无人消费 stdout）最终自回收
  idleTimer = setInterval(() => {
    if (Date.now() - lastFrameAt > IDLE_EXIT_MS) cleanup(0)
  }, 30000)
}

main().catch(err => {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
