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
