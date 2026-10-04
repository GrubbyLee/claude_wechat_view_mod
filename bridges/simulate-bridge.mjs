#!/usr/bin/env node
// wxmp-preview · 方案 C：miniprogram-simulate + jsdom 渲染 WXML/WXSS，
// 产出的 HTML/CSS 交给 headless 浏览器截图（免微信开发者工具）。
// 用法: node simulate-bridge.mjs [--project DIR] [--page pages/index/index]
//                                [--out PATH] [--width 375] [--height 667]
//                                [--wait 800] [--timeout 30000]
// 输出: stdout 最后一行 JSON { ok, path?, width?, height?, browser?, error? }
//
// 尺寸约定：simulate 注入样式时按 1rpx=1px 直换（transformRpx），所以浏览器
// 窗口开 2 倍、--force-device-scale-factor=0.5 截图，正好得到 750rpx=屏宽 的
// 标准映射（代价：页面里混用的真实 px 也会被等比缩小，小程序样式以 rpx 为主）。
//
// 页面写法支持：js 用 Component()（组件化页面）直接加载；经典 Page() 写法
// 兜底为「拷贝页面四件套到临时目录、Page( 改写成 Component(」后加载——初始
// data 可渲染，生命周期/页面方法不执行；含 usingComponents 的 Page 页面不兜底
// （相对路径会断），如实报错。

import { spawn } from 'node:child_process'
import { access, constants, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
const WAIT = Number(argv.wait ?? 800)
const TIMEOUT = Number(argv.timeout ?? 30000)
const OUT = argv.out ?? join(tmpdir(), `wxmp-simulate-${process.pid}-${Date.now()}.png`)

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

/** app.json 的第一个页面，返回不带扩展名的绝对路径；失败返回 null */
async function firstPage(project) {
  try {
    const text = await readFile(join(project, 'app.json'), 'utf8')
    const pages = JSON.parse(text)?.pages
    if (Array.isArray(pages) && pages.length > 0 && typeof pages[0] === 'string') {
      return join(project, pages[0])
    }
  } catch {
    // app.json 缺失/坏 JSON 都按"找不到页面"处理
  }
  return null
}

/** 经典 Page() 页面兜底：临时目录拷贝四件套，Page( 改写成 Component( */
async function pageFallbackCopy(pagePath) {
  const jsText = await readFile(`${pagePath}.js`, 'utf8')
  const json = JSON.parse(await readFile(`${pagePath}.json`, 'utf8'))
  if (json.usingComponents && Object.keys(json.usingComponents).length > 0) {
    throw new Error('经典 Page() 页面含 usingComponents，方案 C 暂不支持（组件路径解析会失效）；请改用组件化页面写法（js 用 Component()）')
  }
  const dir = await mkdtemp(join(tmpdir(), 'wxmp-sim-page-'))
  const target = join(dir, 'page')
  await copyFile(`${pagePath}.wxml`, `${target}.wxml`)
  await copyFile(`${pagePath}.wxss`, `${target}.wxss`)
  await writeFile(`${target}.json`, JSON.stringify({ component: true, usingComponents: {} }))
  await writeFile(`${target}.js`, jsText.replace(/\bPage\s*\(/g, 'Component('))
  return target
}

/** app.wxss 的全局样式：page 选择器映射成 body，rpx 直换 px 后注入 */
async function globalStyles(project) {
  try {
    const text = await readFile(join(project, 'app.wxss'), 'utf8')
    return text.replace(/(?<![.\w-])page\s*\{/g, 'body {').replace(/(\d+)rpx/ig, '$1px')
  } catch {
    return ''
  }
}

async function main() {
  const project = resolve(argv.project ?? process.cwd())
  const resolved = argv.page ? resolve(project, argv.page) : await firstPage(project)
  if (resolved === null) return emit({ ok: false, error: `找不到页面：${project} 缺 app.json 或 pages 为空` })

  try {
    await access(`${resolved}.wxml`, constants.F_OK)
  } catch {
    return emit({ ok: false, error: `找不到页面 WXML：${resolved}.wxml（--project 指向小程序项目根目录）` })
  }

  try {
    // 1. jsdom 铺全局（要在 import simulate 之前：node 环境的 polyfill 会用 window）
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { pretendToBeVisual: true })
    const w = dom.window
    globalThis.window = w
    for (const name of ['document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'navigator', 'getComputedStyle']) {
      // 只在全局缺失时铺（node 22 的 navigator 是只读全局，跳过）
      if (w[name] !== undefined && globalThis[name] === undefined) {
        try {
          globalThis[name] = w[name]
        } catch {
          // 只读全局，忽略
        }
      }
    }

    // 2. simulate 渲染：组件化页面直载；经典 Page() 走临时副本兜底
    const simulate = (await import('miniprogram-simulate')).default
    let loadPath = resolved
    let pageStyle = await globalStyles(project)
    try {
      const jsText = await readFile(`${resolved}.js`, 'utf8').catch(() => '')
      if (/\bPage\s*\(/.test(jsText)) loadPath = await pageFallbackCopy(resolved)
    } catch (err) {
      return emit({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }

    const id = simulate.load(loadPath, 'page')
    const comp = simulate.render(id, {})
    const parent = w.document.createElement('parent-wrapper')
    w.document.body.appendChild(parent)
    comp.attach(parent)
    if (pageStyle !== '') {
      const style = w.document.createElement('style')
      style.textContent = pageStyle
      w.document.head.appendChild(style)
    }
    const html = w.document.documentElement.outerHTML

    // 3. 临时 HTML → headless 浏览器 2x 窗口 + 0.5 缩放截图
    const dir = await mkdtemp(join(tmpdir(), 'wxmp-sim-'))
    const htmlPath = join(dir, 'page.html')
    await writeFile(htmlPath, html)

    const browsers = await findBrowsers(argv.browser)
    if (browsers.length === 0) {
      return emit({ ok: false, error: '未找到 Chromium/Chrome —— 安装一个，或在插件配置 browser 里指定路径' })
    }

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
          `--window-size=${WIDTH * 2},${HEIGHT * 2}`,
          '--force-device-scale-factor=0.5',
          `--virtual-time-budget=${WAIT}`,
          `file://${htmlPath}`,
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
  } catch (err) {
    emit({ ok: false, error: `simulate 渲染失败：${err instanceof Error ? err.message : String(err)}` })
  }
}

main()
