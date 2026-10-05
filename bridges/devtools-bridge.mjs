#!/usr/bin/env node
// wxmp-preview · 方案 B：CDP 直抓微信开发者工具的模拟器 webview。
//
// 为什么不走 automator 截图：msojocs Linux 移植版的 automator 通道连接/
// 页面栈可用，但 App.captureScreenshot 指令无响应（协议层验证过）。好在
// 工具本体是 NW.js（chromium）——用 --remote-debugging-port 启动后，模拟器
// 渲染层是 __pageframe__ 开头的 webview target，Page.captureScreenshot 直出。
//
// 用法: node devtools-bridge.mjs [--cdp 9333] [--out PATH] [--timeout 30000]
// 输出: stdout 最后一行 JSON { ok, path?, width?, height?, error? }
//
// 前提（一次性）：工具要以调试参数启动，并打开小程序项目：
//   wechat-devtools-cli quit
//   wechat-devtools --remote-debugging-port=9333
//   （工具里打开项目后模拟器 webview 才会出现；多项目窗口取第一个 pageframe）

import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'
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
const CDP = Number(argv.cdp ?? 9333)
const TIMEOUT = Number(argv.timeout ?? 30000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-devtools-${process.pid}-${Date.now()}.png`)
/** 工作区小程序的编译产物目录（detect 扫出来的）；有它就用 CLI 打开/聚焦对应窗口 */
const PROJECT = argv.project ?? null

const emit = msg => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function run(cmd, args, timeoutMs) {
  return new Promise(resolveRun => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolveRun({ ok: false, stdout, stderr })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveRun({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** PNG 头 IHDR 里读宽高（大端，偏移 16/20） */
const pngSize = buf => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

async function main() {
  // 1. IDE 的 CDP 口在不在（不在 = 工具没带调试参数启动）
  let ver
  try {
    ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(4000) })).json()
  } catch {
    return emit({
      ok: false,
      error:
        `连不上 DevTools 的 CDP 端口 ${CDP} —— 微信开发者工具要以调试参数启动：` +
        `先 wechat-devtools-cli quit，再 wechat-devtools --remote-debugging-port=${CDP}`,
    })
  }

  // 1.5 指定了工程目录：用 CLI 打开/聚焦它（monorepo 多项目窗口时对准当前工作区）
  if (PROJECT !== null) {
    const cli = argv.cli ?? 'wechat-devtools-cli'
    const abs = resolve(PROJECT)
    const opened = await run(cli, ['open', '--project', abs], 60000)
    if (!opened.ok) {
      emit({
        ok: true,
        event: 'log',
        msg: `cli open 未成功（继续抓当前模拟器）：${((opened.stderr || opened.stdout) || '').trim().slice(0, 100)}`,
      })
    } else {
      // 等窗口与模拟器渲染起来
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  // 2. 找模拟器渲染层（__pageframe__ = 模拟器画面；appservice 是逻辑层，别拿错）
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`, { signal: AbortSignal.timeout(4000) })).json()
  } catch {
    return emit({ ok: false, error: `读取 DevTools target 列表失败（CDP ${CDP}）` })
  }
  const page = (Array.isArray(targets) ? targets : []).find(
    t => typeof t.url === 'string' && t.url.includes('__pageframe__'),
  )
  if (!page) {
    return emit({ ok: false, error: 'DevTools 里没有模拟器画面 —— 在工具里打开小程序项目后再刷新' })
  }

  // 3. attach 到 pageframe 截图（tmp+rename 原子落盘）
  try {
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WS 连接超时')), 5000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('DevTools WS 连接失败'))
      }
    })
    let seq = 0
    const pending = new Map()
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data)
      if (m.id !== undefined && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
      }
    }
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
        }, 15000)
      })
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.id, flatten: true })
    await send('Page.enable', {}, sessionId)
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const buf = Buffer.from(shot.data, 'base64')
    const tmp = `${OUT}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, OUT)
    const { width, height } = pngSize(buf)
    ws.close()
    emit({ ok: true, path: OUT, width, height })
  } catch (err) {
    emit({ ok: false, error: `模拟器截图失败：${err instanceof Error ? err.message : String(err)}` })
  }
}

main().catch(err => {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) })
})
