import type { Detection, ProjectKind, SourceKind } from '../types'

export interface SourceInfo {
  kind: SourceKind
  /** pane 里按这个数字键直接选用 */
  hotkey: string
  title: string
  blurb: string
  fps: string
  fidelity: string
  requires: string
  intro: string
}

export const SOURCES: readonly SourceInfo[] = [
  {
    kind: 'h5',
    hotkey: '1',
    title: '方案 A · 网页版预览',
    blurb: '把小程序当网页渲染，浏览器截图',
    fps: '约 1-3 秒/帧',
    fidelity: '高（真浏览器渲染）',
    requires: '项目能跑 dev:h5；本机有 Chrome/Chromium',
    intro:
      '在本地把项目跑成网页版，无界面浏览器打开并截图。适合 Taro / uni-app / mpx 项目，' +
      '上手最快、依赖最少。注意：微信专属能力（支付、登录等 wx.* API）' +
      '在网页版的行为与真机不完全一致。',
  },
  {
    kind: 'devtools',
    hotkey: '2',
    title: '方案 B · 开发者工具直出',
    blurb: '截取模拟器画面，和平时看到的一样',
    fps: '约 0.5-3 秒/帧',
    fidelity: '100%（模拟器直出）',
    requires: '本机可运行微信开发者工具',
    intro:
      '连接微信开发者工具，直接截取模拟器画面——和你手动切到工具窗口看到的完全一致，' +
      'wx.* 行为也与真机一致。首次使用需在工具里打开「设置 → 安全设置 → 服务端口」，' +
      '并用工具打开本项目。Linux 无官方版，社区移植版（如 msojocs wechat-devtools-linux）可用。',
  },
  {
    kind: 'simulate',
    hotkey: '3',
    title: '方案 C · 轻量渲染',
    blurb: '不装任何工具，直接渲 WXML/WXSS',
    fps: '约 1-3 秒/帧',
    fidelity: '中（组件级渲染，wx.* 为模拟）',
    requires: '无外部工具（依赖随插件 npm i 安装）',
    intro:
      '用 miniprogram-simulate 在本地渲染 WXML/WXSS 并截图：不需要开发服务器，也不需要微信开发者工具。' +
      '组件化页面（js 用 Component()）完整渲染；经典 Page() 写法自动转换，初始数据可渲、页面方法不执行。' +
      'wx.* API 为模拟实现，与真机行为有差异。',
  },
]

export const sourceOf = (kind: SourceKind): SourceInfo =>
  SOURCES.find(s => s.kind === kind) ?? SOURCES[0]!

export const projectLabel = (project: ProjectKind): string =>
  ({
    none: '未发现小程序项目',
    native: '原生小程序',
    taro: 'Taro 项目',
    uni: 'uni-app 项目',
    mpx: 'mpx 项目',
    unknown: '无法判定',
  })[project]

/** 每张卡片下面的环境状态行 */
export const sourceStatus = (kind: SourceKind, det: Detection): { text: string; color: string } => {
  if (kind === 'h5') {
    return det.h5Script !== null
      ? { text: `✅ 检测到脚本 ${det.h5Script}`, color: 'green' }
      : { text: '⚠️ 未找到 dev:h5 类脚本，需先启动 H5 dev server', color: 'yellow' }
  }
  if (kind === 'devtools') {
    return det.devtoolsCli !== null
      ? { text: `✅ DevTools CLI：${det.devtoolsCli}`, color: 'green' }
      : { text: '⚠️ 未检测到 DevTools CLI（Linux 社区版需在配置里指定 devtools-cli）', color: 'yellow' }
  }
  return { text: 'ℹ️ 无外部依赖；经典 Page() 页面自动转换渲染（初始数据）', color: 'cyan' }
}

/** epoch ms → "HH:MM:SS" */
export const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}
