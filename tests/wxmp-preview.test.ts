import { test, expect, mock } from 'claude-code/testing'

/**
 * wxmp-preview 的 UI 测试：选择器 → 预览屏 → 切回选择器。
 * requestId 是 mount 的顶层字段（pane 的 id，与 render hook 的 matcher 对应）；
 * mock.clock / mock.store 在测试的 `on` 上装好插件之下的世界。
 */

const PANE = { component: 'Pane', requestId: 'wxmp', props: { bodyColumns: 60 } } as const

test('chooser offers the three sources; a use-press switches to the preview screen and back', async ($, on) => {
  mock.clock(on)
  mock.store(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'wxmp-preview', surface, ...PANE })

    // 选择器：三张卡片各有一个「使用此方案」按钮
    expect(await ui.find({ key: 'use-h5' })).toBeDefined()
    expect(await ui.find({ key: 'use-devtools' })).toBeDefined()
    expect(await ui.find({ key: 'use-simulate' })).toBeDefined()

    // 选用方案 A → 预览屏带刷新 / 切换方案
    // （choose 里的 session.cwd / store.set 在 try/catch 里；600ms 的首帧
    //   定时器睡在 mock clock 上，不推进就不会跑 bridge。）
    await ui.press({ key: 'use-h5' })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'switch' })).toBeDefined()

    // 切回选择器
    await ui.press({ key: 'switch' })
    expect(await ui.find({ key: 'use-h5' })).toBeDefined()

    await ui.unmount()
  }
})

test('chooser controls are present on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'wxmp-preview', surface, ...PANE })
    expect(await ui.find({ key: 'remember' })).toBeDefined()
    expect(await ui.find({ key: 'redetect' })).toBeDefined()
    await ui.unmount()
  }
})

/**
 * 自动刷新管线：选方案 → 600ms 首帧；编辑小程序文件 → 500ms 防抖刷新；
 * 无关文件不触发。桥在 process.run 事件上伪造（测试环境没有真进程），
 * mock clock 的 advance 负责推进防抖定时器。
 */
test('an edit schedules a debounced refresh through the bridge', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)

  let bridgeRuns = 0
  on('process.run', async () => {
    bridgeRuns += 1
    return {
      value: {
        exitCode: 0,
        stdout: `{"ok":true,"path":"/tmp/wxmp-fake-${bridgeRuns}.png","width":375,"height":667}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // 测试栈下面没有真工具，垫一个 Edit 的执行结果给 next(e) 用
  on('tool.call', async () => ({ result: { result: 'edited', text: 'edited' } }))

  const ui = await $.ui.mount({ plugin: 'wxmp-preview', surface: 'terminal', ...PANE })

  // 选用方案 A → 600ms 防抖后首帧
  await ui.press({ key: 'use-h5' })
  await clock.advance(600)
  expect(bridgeRuns).toBe(1)
  expect(await ui.find({ type: 'Text', text: /第 1 帧/ })).toBeDefined()

  // Claude 编辑 .tsx → 500ms 防抖 → 第二帧
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/pages/index/index.tsx', old_string: 'a', new_string: 'b' })
  await clock.advance(500)
  expect(bridgeRuns).toBe(2)
  expect(await ui.find({ type: 'Text', text: /第 2 帧/ })).toBeDefined()

  // 与小程序无关的文件（.md 不在后缀名单）不触发刷新
  await $.tool.call({ tool: 'Edit', file_path: '/proj/README.md', old_string: 'a', new_string: 'b' })
  await clock.advance(2000)
  expect(bridgeRuns).toBe(2)

  await ui.unmount()
})

/**
 * 直播模式（h5Live on）：选方案 A 起常驻守护（process.spawn），
 * stdout 逐行驱动 started/帧/断流三事件；帧走 blit + 节流回写状态，
 * 错误落 lastError 红字。守护流由 mock 生成器伪造。
 */
test('live mode streams frames from the daemon', { options: { h5Live: 'on' } }, async ($, on) => {
  mock.clock(on)
  mock.store(on)

  let spawned = 0
  on('process.spawn', async function* () {
    spawned += 1
    yield { stream: 'stdout', text: '{"ok":true,"event":"started","pid":1,"path":"/tmp/wxmp-live-frame.png"}\n' }
    yield {
      stream: 'stdout',
      text: '{"ok":true,"event":"frame","frame":1,"path":"/tmp/wxmp-live-frame.png","width":750,"height":870}\n',
    }
    yield { stream: 'stdout', text: '{"ok":false,"error":"演示断流"}\n' }
    return { value: { code: 0, signal: null } }
  })

  const ui = await $.ui.mount({ plugin: 'wxmp-preview', surface: 'terminal', ...PANE })

  // 选用方案 A（h5Live on）→ 起守护而非排单帧刷新
  await ui.press({ key: 'use-h5' })
  expect(spawned).toBe(1)
  // 帧已流入状态（第 1 帧）；守护断流 → lastError 红字
  expect(await ui.find({ type: 'Text', text: /第 1 帧/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /演示断流/ })).toBeDefined()

  await ui.unmount()
})

/**
 * 点击穿透：直播模式下画面上盖 liveview 捕获层（Client），tap 坐标 post 回
 * 插件，按区域尺寸换算成帧像素后转发守护的 HTTP 控制口。
 */
test('live mode forwards pane taps to the daemon', { options: { h5Live: 'on' } }, async ($, on) => {
  mock.clock(on)
  mock.store(on)

  // 闸门：守护常驻（流不结束）——流结束 = 守护退出，会把 live 翻回 false
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"ok":true,"event":"started","pid":1,"path":"/tmp/wxmp-live-frame.png","port":18080}\n',
    }
    yield {
      stream: 'stdout',
      text: '{"ok":true,"event":"frame","frame":1,"path":"/tmp/wxmp-live-frame.png","width":750,"height":870}\n',
    }
    await gate
    return { value: { code: 0, signal: null } }
  })

  const fetches: { url: string; body: { x?: unknown; y?: unknown } }[] = []
  on('http.fetch', async (_$, e) => {
    fetches.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: { status: 200, ok: true, headers: {}, body: '{"ok":true}' } }
  })

  const ui = await $.ui.mount({ plugin: 'wxmp-preview', surface: 'terminal', ...PANE })
  await ui.press({ key: 'use-h5' })

  // 给捕获层定区域尺寸（真实终端测量后才有的值），再喂一个 tap（up 事件）
  await ui.resize({ columns: 54, rows: 24, in: 'liveview' })
  await ui.pointer({ type: 'up', x: 27, y: 12, button: 'left' })

  expect(fetches).toHaveLength(1)
  expect(fetches[0]?.url).toBe('http://127.0.0.1:18080/click')
  // 模块把格中心 (27.5, 12.5) post 上来，插件按 54x24 区域 → 750x870 帧换算
  expect(Math.round(Number(fetches[0]?.body.x))).toBe(Math.round((27.5 / 54) * 750))
  expect(Math.round(Number(fetches[0]?.body.y))).toBe(Math.round((12.5 / 24) * 870))

  release()
  await ui.unmount()
})
