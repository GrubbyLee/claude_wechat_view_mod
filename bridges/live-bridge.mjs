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
import { rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 2) {
    const key = list[i]?.replace(/^--/, '')
    if (key) out[key] = list[i + 1]
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))
const PAGE_URL = argv.url ?? 'http://localhost:10086'
const WIDTH = Number(argv.width ?? 375)
const HEIGHT = Number(argv.height ?? 667)
const MAX_FPS = Number(argv['max-fps'] ?? 15)
const IDLE_EXIT_MS = Number(argv['idle-exit-ms'] ?? 900000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-live-${process.pid}.png`)
/** 插件用来孤儿回收的 PID 文件；退出时只在内容仍是自己 PID 时才删（防误删新守护的） */
const PIDFILE = argv.pidfile ?? null

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

async function main() {
  // 1. dev server 探活（与 A 截图模式同一防呆：连不上不开浏览器）
  try {
    const res = await fetch(PAGE_URL, { signal: AbortSignal.timeout(5000), redirect: 'follow' })
    if (!res.ok) return emit({ ok: false, error: `H5 dev server 返回 HTTP ${res.status}：${PAGE_URL}` })
  } catch (err) {
    return emit({ ok: false, error: `H5 dev server 不可达：${PAGE_URL} —— 先启动（如 npm run dev:h5）。${err?.message ?? err}` })
  }

  // 2. 找浏览器
  const browsers = await findBrowsers(argv.browser)
  if (browsers.length === 0) {
    return emit({ ok: false, error: '未找到 Chromium/Chrome —— 安装一个，或在插件配置 browser 里指定路径' })
  }

  // 3. 起 chromium：调试端口自动分配，从 stderr 解析 DevTools WS 地址。
  //    视口按手机 CSS 尺寸（375x667），dsf=2 让 screencast 出 2x 清晰度的帧
  const chrome = spawn(browsers[0], [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
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
    try { ws?.close() } catch { /* 已关 */ }
    try { chrome.kill('SIGTERM') } catch { /* 已退 */ }
    process.exit(code)
  }
  let idleTimer = null
  let ws = null
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

  // 5. 开页面 + screencast
  let session = null
  try {
    const { targetId } = await send('Target.createTarget', { url: PAGE_URL })
    const attached = await send('Target.attachToTarget', { targetId, flatten: true })
    session = attached.sessionId
    await send('Page.enable', {}, session)
    await send(
      'Page.startScreencast',
      { format: 'png', maxWidth: WIDTH * 2, maxHeight: HEIGHT * 2, everyFrameIfNecessary: false },
      session,
    )
  } catch (err) {
    cleanup(0)
    return emit({ ok: false, error: `CDP 启动失败：${err instanceof Error ? err.message : String(err)}` })
  }
  if (PIDFILE !== null) writeFileSync(PIDFILE, String(process.pid))
  emit({ ok: true, event: 'started', pid: process.pid, path: OUT })

  // 6. 帧循环：ack 每帧必发（流控）；节流只影响写盘与上报
  let frame = 0
  let lastEmit = 0
  let lastFrameAt = Date.now()
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
