import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { SOURCES, fmtClock, projectLabel, sourceOf, sourceStatus } from './sources'
import {
  MINI_PROGRAM_FILE,
  bridgeArgs,
  bridgeScript,
  isSourceKind,
  parseBridgeResult,
  safeJson,
  str,
  type BridgeConfig,
} from './lib'
import type { ActiveSource, Detection, ProjectKind, SourceKind } from '../types'

/**
 * wxmp-preview：微信小程序 UI 实时预览。
 *
 * 引擎的追踪规则：`$` 只能流进**本文件顶层声明的函数**（函数声明或
 * 绑定函数表达式的 const），不能跨 import、不能进闭包里的局部函数。
 * 所以下面所有接收 `$` 的函数都在顶层，配置通过参数传入；
 * lib.ts / sources.ts / state.ts 保持纯函数与数据。
 */

/** ui.render 收到的 Pane 实例里，本插件实际读的字段 */
interface PaneRender {
  surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'
  props: { bodyColumns?: number; placement?: 'dock' | 'inline' }
  viewport?: { rows?: number }
}

/** pane 的 requestId（`$.ui.open({ id })` 与 `ui.render` 的 matcher 用同一个） */
const PANE = 'wxmp'

// $.state 的值引用必须声明在本文件（状态扫描只读本文件的 const）；
// 契约（PluginState）在 types/index.d.ts。
const screen = atom({ plugin: 'wxmp-preview', key: 'screen' } as const, 'chooser')
const detection = atom({ plugin: 'wxmp-preview', key: 'detection' } as const, null)
const active = atom({ plugin: 'wxmp-preview', key: 'active' } as const, null)
const remember = atom({ plugin: 'wxmp-preview', key: 'remember' } as const, 'project')

const DEVTOOLS_BINARIES = ['wechat-devtools-cli', 'wechat-devtools']

const storeKey = (root: string): string => `wxmp:choice:${root}`

/** 同一时刻至多一次刷新在跑（模块变量：防抖/并发闸，不参与绘制） */
let inFlight = false
/** 挂起的防抖定时器 */
let pendingRefresh: { cancel: () => void } | null = null

// ---------- 核心动作（全部顶层声明，接收 `$`） ----------

/** 选用某个方案：写状态、记住选择、排一次首帧 */
const choose = async ($: EngineInterface, kind: SourceKind, cfg: BridgeConfig): Promise<void> => {
  const startedAt = await $.clock.now()
  const next: ActiveSource = {
    kind,
    startedAt,
    refreshes: 0,
    frameSeq: 0,
    framePath: null,
    frameAt: null,
    frameWidth: null,
    frameHeight: null,
    lastError: null,
    busy: false,
  }
  await update($, active, () => next)
  await update($, screen, () => 'preview')
  const mode = await read($, remember)
  if (mode === 'project') {
    try {
      const root = await $.session.cwd()
      await $.store.set(storeKey(root), kind)
    } catch {
      // 记不住就记不住，不影响本次选用
    }
  }
  scheduleRefresh($, 600, cfg)
}

const redetect = async ($: EngineInterface, cfg: BridgeConfig): Promise<void> => {
  const det = await detect($, cfg)
  await update($, detection, () => det)
}

/**
 * 跑一次桥接：截图 → blit 进 pane + 写回状态。
 * 任何失败都落到 active.lastError，绝不抛出。
 */
const refresh = async ($: EngineInterface, cfg: BridgeConfig): Promise<void> => {
  if (inFlight) return
  inFlight = true
  try {
    const cur = await read($, active)
    if (cur === null) return

    await update($, active, a => (a === null ? a : { ...a, busy: true }))
    $.ui.status(`wxmp · ${cur.kind}：刷新中…`)

    const argv = ['node', bridgeScript(cur.kind, $.plugin.root), ...bridgeArgs(cur.kind, cfg)]
    if (cur.kind === 'simulate') {
      // simulate 桥按项目根找 app.json；显式传 --project，不赌 process.run 的 cwd
      try {
        argv.push('--project', await $.session.cwd())
      } catch {
        // 拿不到 cwd 就让桥用 process.cwd() 默认值
      }
    }
    const res = await $.process.run(argv, { timeoutMs: 90000 })
    const payload = parseBridgeResult(res.stdout)

    if (payload.ok === true && typeof payload.path === 'string') {
      const seq = cur.frameSeq + 1
      const now = await $.clock.now()
      const width = typeof payload.width === 'number' ? payload.width : null
      const height = typeof payload.height === 'number' ? payload.height : null
      const next: ActiveSource = {
        ...cur,
        frameSeq: seq,
        framePath: payload.path,
        frameAt: now,
        frameWidth: width,
        frameHeight: height,
        lastError: null,
        busy: false,
        refreshes: cur.refreshes + 1,
      }
      await update($, active, () => next)
      try {
        // pane 未挂载/未显示时会 deny，状态重绘会兜底显示同一帧
        await $.ui.blit({
          requestId: PANE,
          key: 'frame',
          source: { file: payload.path, format: 'png', generation: seq },
        })
      } catch {
        // blit 只是"立刻换帧"的加速路径，失败无所谓
      }
      $.ui.status(`wxmp · ${cur.kind}：✓ ${fmtClock(now)}`)
    } else {
      const error = typeof payload.error === 'string' ? payload.error : `bridge 异常（exit ${res.exitCode}）`
      await update($, active, a => (a === null ? a : { ...a, lastError: error, busy: false }))
      $.ui.status(`wxmp · ${cur.kind}：✗ 刷新失败`)
      $.ui.toast(`wxmp 刷新失败：${error.slice(0, 120)}`)
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, active, a => (a === null ? a : { ...a, lastError: error, busy: false })).catch(() => undefined)
    $.ui.status('wxmp：✗ 刷新出错')
  } finally {
    inFlight = false
  }
}

/** 防抖刷新：编辑事件连续到来时合并成一次 */
const scheduleRefresh = ($: EngineInterface, ms: number, cfg: BridgeConfig): void => {
  if (pendingRefresh !== null) pendingRefresh.cancel()
  pendingRefresh = $.clock.after(ms, () => {
    pendingRefresh = null
    void refresh($, cfg)
  })
}

/**
 * 探测当前工作区是什么样的小程序项目、环境里有什么工具。
 * 所有 $ 调用就地 try/catch，探测失败当"没有"，绝不抛。
 */
const detect = async ($: EngineInterface, cfg: BridgeConfig): Promise<Detection> => {
  const evidence: string[] = []
  let project: ProjectKind = 'unknown'
  let h5Script: string | null = null

  let pkgText = ''
  try {
    pkgText = await $.fs.read('package.json')
  } catch {
    pkgText = ''
  }
  const pkg = pkgText === '' ? null : safeJson(pkgText)
  const deps = new Set<string>([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ])
  const scripts = Object.keys(pkg?.scripts ?? {})

  let hasProjectConfig = false
  try {
    hasProjectConfig = await $.fs.exists('project.config.json')
  } catch {
    hasProjectConfig = false
  }

  if (pkg === null) {
    project = hasProjectConfig ? 'native' : 'none'
    evidence.push(hasProjectConfig ? '存在 project.config.json → 原生小程序' : '未发现 package.json / project.config.json')
  } else {
    evidence.push(`package.json：${deps.size} 个依赖，${scripts.length} 个脚本`)
    const hasDep = (prefix: string): boolean => [...deps].some(d => d.startsWith(prefix))
    if (hasDep('@tarojs/')) {
      project = 'taro'
      evidence.push('依赖 @tarojs/* → Taro')
    } else if (hasDep('@dcloudio/')) {
      project = 'uni'
      evidence.push('依赖 @dcloudio/* → uni-app')
    } else if (hasDep('@mpxjs/') || deps.has('mpx')) {
      project = 'mpx'
      evidence.push('依赖 mpx → mpx 项目')
    } else if (hasProjectConfig) {
      project = 'native'
      evidence.push('存在 project.config.json → 原生小程序')
    } else {
      evidence.push('未识别出跨端框架，也无 project.config.json')
    }
    h5Script =
      scripts.find(s => /^dev:h5\b/i.test(s)) ??
      scripts.find(s => /^dev[\w:]*h5/i.test(s)) ??
      null
    if (h5Script !== null) evidence.push(`dev 脚本 ${h5Script} 可起 H5`)
  }

  // DevTools CLI：显式配置优先，其次在 PATH 里找
  let devtoolsCli: string | null = null
  if (cfg.devtoolsCli !== '') {
    let cliExists = false
    try {
      cliExists = await $.fs.exists(cfg.devtoolsCli)
    } catch {
      cliExists = false
    }
    if (cliExists) devtoolsCli = cfg.devtoolsCli
  }
  if (devtoolsCli === null) {
    for (const name of DEVTOOLS_BINARIES) {
      try {
        const res = await $.process.run(['which', name])
        if (res.exitCode === 0 && res.stdout.trim() !== '') {
          devtoolsCli = res.stdout.trim()
          break
        }
      } catch {
        // PATH 里没有，继续找下一个名字
      }
    }
  }
  if (devtoolsCli !== null) evidence.push(`DevTools CLI：${devtoolsCli}`)
  else if (cfg.devtoolsCli !== '') evidence.push(`配置的 devtoolsCli 不存在：${cfg.devtoolsCli}`)

  let recommend: SourceKind | 'none' = 'none'
  if (project === 'taro' || project === 'uni' || project === 'mpx') {
    recommend = 'h5'
  } else if (project === 'native') {
    recommend = devtoolsCli !== null ? 'devtools' : 'simulate'
  } else if (project === 'unknown' && devtoolsCli !== null) {
    recommend = 'devtools'
  }

  return { project, evidence, recommend, devtoolsCli, h5Script }
}

/** Claude 编辑小程序相关文件后，防抖刷新当前方案 */
const maybeSchedule = (
  $: EngineInterface,
  input: { file_path?: string } | undefined,
  enabled: boolean,
  cfg: BridgeConfig,
): void => {
  if (!enabled) return
  const path = input?.file_path ?? ''
  if (path !== '' && MINI_PROGRAM_FILE.test(path)) scheduleRefresh($, 500, cfg)
}

// ---------- 选择器 ----------

const drawChooser = async ($: EngineInterface, e: PaneRender, cfg: BridgeConfig): Promise<RenderElement> => {
  const det = await read($, detection)
  const act = await read($, active)
  const rem = await read($, remember)
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)

  const header =
    det === null
      ? '*尚未检测工作区 —— 按「重新检测」*'
      : [
          `**工作区检测** · ${projectLabel(det.project)}`,
          ...det.evidence.map(s => `- ${s}`),
          det.recommend === 'none'
            ? '⇒ 未给出自动建议，请手动选择'
            : `⇒ 建议方案：**${sourceOf(det.recommend).title}**`,
        ].join('\n')

  const cards: RenderElement[] = SOURCES.map(s => {
    const isRecommended = det?.recommend === s.kind
    const status = det === null ? null : sourceStatus(s.kind, det)
    return (
      <Box key={`card-${s.kind}`} borderStyle="round" flexDirection="column" paddingX={1}>
        <Text bold>
          {s.title}
          {isRecommended ? '  ⭐ 推荐' : ''}
          {act?.kind === s.kind ? '  · 当前' : ''}
        </Text>
        <Text dimColor>
          {s.fps} · 保真 {s.fidelity} · 前提：{s.requires}
        </Text>
        <Markdown dimColor text={s.intro} />
        {status !== null && <Text color={status.color}>{status.text}</Text>}
        <Button
          key={`use-${s.kind}`}
          label="使用此方案"
          hotkey={s.hotkey}
          variant={isRecommended ? 'primary' : 'secondary'}
          onPress={() => {
            void choose($, s.kind, cfg)
          }}
        />
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      <Markdown text={header} />
      {cards}
      <Box gap={1}>
        <Button
          key="redetect"
          label="重新检测"
          onPress={() => {
            void redetect($, cfg)
          }}
        />
        <Button
          key="remember"
          label={rem === 'project' ? '记住选择：本项目 ✓' : '记住选择：每次询问'}
          onPress={() => {
            void update($, remember, r => (r === 'project' ? 'ask' : 'project'))
          }}
        />
      </Box>
      {e.surface === 'terminal' ? (
        <Text dimColor>点击「使用此方案」，或 ctrl+x → tab 切入面板后按 1/2/3；/wxmp h5 直达。</Text>
      ) : (
        <Text dimColor>点击「使用此方案」，或 /wxmp h5 直达。</Text>
      )}
    </Box>
  )
}

// ---------- 预览屏 ----------

const drawPreview = async ($: EngineInterface, e: PaneRender, cfg: BridgeConfig): Promise<RenderElement> => {
  const act = await read($, active)
  const { Box, Text, Button } = $.ui.resolve(e)

  const bodyColumns = e.props.bodyColumns ?? 54
  const viewportRows = e.viewport?.rows ?? 24
  const imageColumns = Math.max(8, bodyColumns - 2)
  const frameWidth = act?.frameWidth ?? null
  const frameHeight = act?.frameHeight ?? null
  const aspect =
    frameHeight !== null && frameWidth !== null && frameWidth > 0
      ? frameHeight / frameWidth
      : 667 / 375
  const imageRows = Math.max(4, Math.min(viewportRows - 4, Math.round((imageColumns * aspect) / 2), 255))

  const statusText =
    act === null
      ? '未选择方案'
      : `${sourceOf(act.kind).title}` +
        (act.frameAt !== null ? ` · ${fmtClock(act.frameAt)} · 第 ${act.refreshes} 帧` : ' · 尚未刷新') +
        (act.busy ? ' · 刷新中…' : '')

  let frame: RenderElement | null = null
  if (e.surface === 'terminal' && act !== null && act.framePath !== null) {
    // 像素帧只有终端 surface 画得出（Image 元素）
    const { Image } = $.ui.resolve(e)
    frame = (
      <Image
        key="frame"
        source={{ file: act.framePath, format: 'png', generation: act.frameSeq }}
        columns={imageColumns}
        rows={imageRows}
        alt="小程序预览画面"
      />
    )
  }

  const placeholder =
    e.surface !== 'terminal'
      ? `像素画面仅在终端 surface 渲染（当前 ${e.surface}）。\n在终端（含 VS Code 集成终端）里运行 claude 即可看到画面。`
      : act === null || act.framePath === null
        ? '尚未取得画面。点击 [刷新] 抓取第一帧（或输 /wxmp refresh）；\n若失败，看上方红色错误行排查（依赖 / 端口 / DevTools）。'
        : ''

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Button
          key="refresh"
          label="刷新"
          hotkey="r"
          variant="primary"
          onPress={() => {
            void refresh($, cfg)
          }}
        />
        <Button
          key="switch"
          label="切换方案"
          hotkey="s"
          onPress={() => {
            void update($, screen, () => 'chooser')
          }}
        />
        <Text dimColor wrap="truncate">{statusText}</Text>
      </Box>
      {e.surface === 'terminal' && (
        <Text dimColor wrap="truncate">点 [刷新] 或 /wxmp refresh；ctrl+x→tab 后按 r/s</Text>
      )}
      {/* placement 引擎决定（全屏 + ≥110 列才 dock 右侧）；inline 时给用户指路 */}
      {e.surface === 'terminal' && e.props.placement === 'inline' && (
        <Text dimColor wrap="truncate">终端拉宽到 110 列以上（全屏模式）时，预览会停靠到对话右侧</Text>
      )}
      {act !== null && act.lastError !== null && (
        <Text color="red" wrap="wrap">✗ {act.lastError}</Text>
      )}
      {frame !== null ? (
        frame
      ) : (
        <Box borderStyle="round" height={imageRows} padding={1}>
          <Text dimColor wrap="wrap">{placeholder}</Text>
        </Box>
      )}
    </Box>
  )
}

// ---------- 事件注册 ----------

export const register: Register = (on, options) => {
  const config = options as Record<string, unknown>
  const cfg: BridgeConfig = {
    h5Url: str(config['h5Url'], 'http://localhost:10086'),
    browser: str(config['browser'], ''),
    devtoolsCli: str(config['devtoolsCli'], ''),
    devtoolsPort: str(config['devtoolsPort'], '9420'),
  }
  const autoRefresh = config['autoRefresh'] !== 'off'
  const defaultSource = str(config['defaultSource'], 'auto')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wxmp',
      description: '微信小程序 UI 预览（右侧面板，可选渲染方案）',
      argumentHint: '[h5|devtools|simulate|auto|ask|refresh]',
    })
    return next(e)
  })

  on('command.run', { command: 'wxmp' }, async ($, e) => {
    const det = await detect($, cfg)
    await update($, detection, () => det)

    const arg = e.args.trim()

    // /wxmp refresh：不动当前选择，只刷一帧（面板点击/热键不可用时的命令候补）
    if (arg === 'refresh') {
      const act = await read($, active)
      await $.ui.open({ id: PANE, title: '小程序预览', columns: 56 })
      if (act === null) return { text: 'wxmp：尚未选择方案——先用 /wxmp 挑一个' }
      void refresh($, cfg)
      return { text: `wxmp：刷新中（${sourceOf(act.kind).title}）` }
    }

    let kind: SourceKind | null = null
    if (isSourceKind(arg)) {
      kind = arg
    } else if (arg === '' || arg === 'auto') {
      if (isSourceKind(defaultSource)) {
        kind = defaultSource
      } else {
        const mode = await read($, remember)
        if (mode === 'project') {
          try {
            const root = await $.session.cwd()
            const stored = await $.store.get(storeKey(root))
            if (isSourceKind(stored)) kind = stored
          } catch {
            // 读不到记忆，走检测建议
          }
        }
        if (kind === null && det.recommend !== 'none') kind = det.recommend
      }
    }
    // arg === 'ask' 或没选出任何方案 → 停在选择器

    if (kind !== null) await choose($, kind, cfg)
    else await update($, screen, () => 'chooser')
    await $.ui.open({ id: PANE, title: '小程序预览', columns: 56 })
    return {
      text:
        kind === null
          ? 'wxmp：请在右侧面板选择渲染方案（热键 1/2/3）'
          : `wxmp：使用 ${sourceOf(kind).title}`,
    }
  })

  // tool.call 事件的工具参数平铺在事件顶层（没有 tool_input 包装字段），
  // Edit/Write/MultiEdit 都带 file_path；NotebookEdit 没有（.ipynb 也不是
  // 小程序文件，走到 maybeSchedule 里自然不匹配）
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    maybeSchedule($, e, autoRefresh, cfg)
    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    maybeSchedule($, e, autoRefresh, cfg)
    return ran
  })
  on('tool.call', { tool: 'MultiEdit' }, async ($, e, next) => {
    const ran = await next(e)
    maybeSchedule($, e, autoRefresh, cfg)
    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    maybeSchedule($, e, autoRefresh, cfg)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e: PaneRender) => {
    const mode = await read($, screen)
    return mode === 'preview' ? drawPreview($, e, cfg) : drawChooser($, e, cfg)
  })
}
