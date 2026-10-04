#!/usr/bin/env node
// wxmp-preview · 方案 A：headless Chromium 给 H5 页面截图。
// 用法: node h5-bridge.mjs [--url URL] [--browser PATH] [--width 375] [--height 667]
//                          [--wait 2500] [--timeout 30000] [--out PATH]
// 输出: stdout 最后一行 JSON { ok, path?, width?, height?, browser?, error? }

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
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
const WIDTH = Number(argv.width ?? 375)
const HEIGHT = Number(argv.height ?? 667)
const WAIT = Number(argv.wait ?? 2500)
const TIMEOUT = Number(argv.timeout ?? 30000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-h5-${process.pid}-${Date.now()}.png`)

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

async function main() {
  const url = argv.url ?? 'http://localhost:10086'

  // 1. dev server 可达性（直接截 chrome 的错误页没有意义，先拦掉）
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' })
    if (!res.ok) return emit({ ok: false, error: `H5 dev server 返回 HTTP ${res.status}：${url}` })
  } catch (err) {
    return emit({ ok: false, error: `H5 dev server 不可达：${url} —— 先启动（如 npm run dev:h5）。${err?.message ?? err}` })
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
