#!/usr/bin/env node
// wxmp-preview · 方案 A：headless Chromium 给 H5 页面截图。
// 用法: node h5-bridge.mjs [--url URL] [--browser PATH] [--width 375] [--height 667]
//                          [--wait 2500] [--timeout 30000] [--out PATH]
// 输出: stdout 最后一行 JSON { ok, path?, width?, height?, browser?, error? }

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, constants, open, writeFile } from 'node:fs/promises'
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
const WAIT = Number(argv.wait ?? 2500)
const TIMEOUT = Number(argv.timeout ?? 30000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-h5-${process.pid}-${Date.now()}.png`)
/** dev server 未运行时自动拉起用的脚本与目录（detect 提供；null = 不具备自启条件 */
const START_SCRIPT = argv['start-script'] ?? null
const START_DIR = argv['start-dir'] ?? '.'

/** 自动拉起的 dev server 的 pidfile 与日志（同机单实例；手动停：kill $(cat pidfile)） */
const DEV_PID = '/tmp/wxmp-h5-dev.pid'
const DEV_LOG = '/tmp/wxmp-h5-dev.log'

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

// deb 系（google-chrome 等）排前面：snap 版 chromium 退出码 0 但把截图写进
// 沙箱私有 /tmp，系统侧拿不到文件；无 snap 的机器上顺序无所谓
async function findBrowsers(explicit) {
  const candidates = [explicit, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'].filter(Boolean)
  const found = []
  for (const cmd of candidates) {
    const res = await run(cmd, ['--version'], 5000)
    if (res.ok) found.push(cmd)
  }
  return found
}

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
 * 确保 dev server 可用：先探配置的 URL，再探常见端口；全都不通且给了启动脚本时
 * 自动拉起（detached + pidfile，幂等）并轮询等就绪。返回可用 URL 或 null。
 */
async function ensureServer(cfgUrl) {
  if (await alive(cfgUrl)) return cfgUrl
  for (const port of CANDIDATE_PORTS) {
    const alt = await alive(`http://localhost:${port}`)
    if (alt !== null) return alt
  }
  if (START_SCRIPT === null) return null

  // 幂等：pidfile 里活着的进程 = 已在启动中（并发刷新/上次刚拉起），不重复起
  let alreadyStarting = false
  try {
    const pid = Number(readFileSync(DEV_PID, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      alreadyStarting = (await run('kill', ['-0', String(pid)], 3000)).ok
    }
  } catch {
    // 无 pidfile：正常，走拉起
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

  // 轮询等就绪（上限 70s：桥的总超时 90s，要给截图留时间）
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
  let url = argv.url ?? 'http://localhost:10086'
  const ready = await ensureServer(url)
  if (ready === null) {
    return emit({
      ok: false,
      error:
        START_SCRIPT === null
          ? `H5 dev server 不可达：${url} —— 先在小程序工程目录启动（如 npm run dev:h5）。已试端口 10086/5173/8080/3000`
          : `dev server 自动启动后 70s 内未就绪（${START_DIR}: npm run ${START_SCRIPT}）—— 看 ${DEV_LOG} 排查；端口不在 10086/5173/8080/3000 之列时需在插件配置 h5Url 指定`,
    })
  }
  if (ready !== url) {
    emit({ ok: true, event: 'log', msg: `配置的 ${url} 不可达，改用 ${ready}` })
    url = ready
  }

  // 2. 找浏览器（全部可用候选，按优先级排序）
  const browsers = await findBrowsers(argv.browser)
  if (browsers.length === 0) {
    return emit({ ok: false, error: '未找到 Chromium/Chrome —— 安装一个，或在插件配置 browser 里指定路径' })
  }

  // 3. 逐个候选截图：有的浏览器退出码 0 却写不出文件（snap chromium 的
  //    私有 /tmp），遇到就换下一个，直到真拿到文件
  let lastError = '所有浏览器候选均失败'
  for (const browser of browsers) {
    const res = await run(
      browser,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        `--screenshot=${OUT}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        `--virtual-time-budget=${WAIT}`,
        url,
      ],
      TIMEOUT,
    )
    if (!res.ok) {
      lastError = `Chromium 截图失败（exit ${res.code ?? '?'}）：${(res.stderr ?? '').trim().slice(0, 300)}`
      continue
    }
    try {
      await access(OUT, constants.F_OK)
    } catch {
      lastError = `${browser} 未产出截图文件（疑似沙箱私有 /tmp）`
      continue
    }
    return emit({ ok: true, path: OUT, width: WIDTH, height: HEIGHT, browser })
  }
  emit({ ok: false, error: lastError })
}

main()
