/**
 * wxmp-preview 的共享类型与 `$.state` 契约。
 *
 * 契约里的每个值对应 `hooks/register.tsx` 顶层声明的 atom；
 * 引擎按 `interface PluginState` 校验 `$.state` 的每次读写。
 */

export type SourceKind = 'h5' | 'devtools' | 'simulate'

export type ProjectKind = 'none' | 'native' | 'taro' | 'uni' | 'mpx' | 'unknown'

export type Detection = {
  /** 工作区判定结果 */
  project: ProjectKind
  /** 给用户看的证据行 */
  evidence: string[]
  /** 自动建议的方案；'none' = 不建议 */
  recommend: SourceKind | 'none'
  /** 探测到的微信开发者工具 CLI；null = 未找到 */
  devtoolsCli: string | null
  /** package.json 里能启动 H5 的脚本名；null = 未找到 */
  h5Script: string | null
}

export type ActiveSource = {
  kind: SourceKind
  /** 启用时刻（epoch ms） */
  startedAt: number
  /** 成功帧数 */
  refreshes: number
  /** 帧序号：ImageSource 的 generation，内容变了要递增 */
  frameSeq: number
  /** 最近一帧 PNG 的绝对路径；null = 还没有画面 */
  framePath: string | null
  /** 最近一帧时刻（epoch ms） */
  frameAt: number | null
  frameWidth: number | null
  frameHeight: number | null
  /** 最近一次失败的原因；null = 无 */
  lastError: string | null
  busy: boolean
  /** CDP screencast 直播模式（方案 A 专属）：常驻守护在跑，帧自动流入 */
  live: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'wxmp-preview': {
      screen: 'chooser' | 'preview'
      detection: Detection | null
      active: ActiveSource | null
      remember: 'project' | 'ask'
    }
  }
}
