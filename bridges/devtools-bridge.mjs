#!/usr/bin/env node
// wxmp-preview · 方案 B：连接微信开发者工具自动化端口，截取模拟器画面。
// 依赖: 在本插件目录执行 npm install -D miniprogram-automator
// 用法: node devtools-bridge.mjs [--port 9420] [--cli PATH] [--project DIR]
//                                [--wait 1200] [--out PATH]
// 输出: stdout 最后一行 JSON { ok, path?, launched?, error? }
//
// 连接策略：先 connect 已开的自动化端口（快）；失败且有 --cli 时
// automator.launch 拉起开发者工具（首次较慢），之后的帧再走 connect。

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
const PORT = Number(argv.port ?? 9420)
const WAIT = Number(argv.wait ?? 1200)
const PROJECT = argv.project ?? process.cwd()
const OUT = argv.out ?? join(tmpdir(), `wxmp-devtools-${process.pid}-${Date.now()}.png`)

const emit = msg => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  let automator
  try {
    automator = (await import('miniprogram-automator')).default
  } catch {
    return emit({
      ok: false,
      error: '缺少依赖 miniprogram-automator —— 在插件目录执行 npm install -D miniprogram-automator',
    })
  }

  let mini = null
  let launched = false
  try {
    try {
      mini = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` })
    } catch {
      if (!argv.cli) {
        return emit({
          ok: false,
          error:
            `连接自动化端口 ${PORT} 失败，且未配置 DevTools CLI —— ` +
            '打开微信开发者工具并开启「设置→安全设置→服务端口/自动化」，' +
            '或在插件配置 devtools-cli 里指定 CLI 路径',
        })
      }
      mini = await automator.launch({ cliPath: argv.cli, projectPath: PROJECT, port: PORT })
      launched = true
    }

    // 等文件变更重编译稳定后再截图
    if (WAIT > 0) await sleep(WAIT)

    await mini.screenshot({ path: OUT })
    emit({ ok: true, path: OUT, launched })
  } catch (err) {
    emit({ ok: false, error: err?.message ?? String(err) })
  } finally {
    // connect 出来的连接随手断开；launch 出来的让 DevTools 继续跑，
    // 下一帧改走 connect，省去再次拉起
    if (mini !== null && !launched) {
      try {
        await mini.disconnect()
      } catch {
        // 断不开就算了
      }
    }
  }
}

main()
