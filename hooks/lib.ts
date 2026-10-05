import type { SourceKind } from '../types'

/**
 * 纯工具：不接收 `$`（引擎要求 `$` 只留在 register.tsx 里流动），
 * 只做参数拼装、解析和判定。
 */

export interface BridgeConfig {
  h5Url: string
  browser: string
  devtoolsCli: string
  devtoolsPort: string
  /** 方案 A 的 CDP screencast 直播模式（userConfig h5Live） */
  h5Live: boolean
}

export const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback

export const isSourceKind = (value: unknown): value is SourceKind =>
  value === 'h5' || value === 'devtools' || value === 'simulate'

/** 编辑这些后缀的文件会触发预览刷新 */
export const MINI_PROGRAM_FILE = /\.(wxml|wxss|wxs|json|ts|tsx|js|jsx|vue|less|scss|css)$/i

export interface PkgShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

export const safeJson = (text: string): PkgShape | null => {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? (value as PkgShape) : null
  } catch {
    return null
  }
}

export const bridgeScript = (kind: SourceKind, root: string): string => {
  const name = kind === 'devtools' ? 'devtools-bridge' : kind === 'h5' ? 'h5-bridge' : 'simulate-bridge'
  return `${root}/bridges/${name}.mjs`
}

export const bridgeArgs = (kind: SourceKind, cfg: BridgeConfig): string[] => {
  if (kind === 'h5') {
    return cfg.browser !== '' ? ['--url', cfg.h5Url, '--browser', cfg.browser] : ['--url', cfg.h5Url]
  }
  if (kind === 'devtools') {
    const args = ['--port', cfg.devtoolsPort, '--wait', '1200']
    return cfg.devtoolsCli !== '' ? [...args, '--cli', cfg.devtoolsCli] : args
  }
  return []
}

/** 桥接脚本约定：结束时在 stdout 打一行 JSON；从后往前找第一个合法 JSON 行 */
export const parseBridgeResult = (stdout: string): Record<string, unknown> => {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // 不是 JSON 行，继续往前找
    }
  }
  return { ok: false, error: `bridge 输出无法解析：${stdout.trim().slice(0, 200)}` }
}

/** 直播守护的 stdout 单行 JSON；坏行返回 null（流式协议，坏行跳过不致命） */
export const parseLiveLine = (line: string): Record<string, unknown> | null => {
  if (!line.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
