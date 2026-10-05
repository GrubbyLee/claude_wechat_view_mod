import type { ClientModule } from 'claude-code'

/**
 * 直播画面的点击捕获层（Roadmap #4 点击穿透的 pane 端）：
 * 透明覆盖在 Image 上（register.tsx 里用绝对定位 Box 包裹），不画任何
 * 可见内容——像素永远来自底下的 Image。指针抬起（tap）时把区域内的
 * 亚像素坐标 post 给插件（ui.message 事件），由插件换算帧坐标后转发
 * 直播守护的 HTTP 控制口。
 */
const LiveClient: ClientModule<Record<string, never>> = (_props, surface) => {
  surface.onPointer(e => {
    // tap 语义取 up（down+up 序列的尾）；坐标补半格得到格中心
    if (e.type !== 'up') return
    const x = e.fine?.x ?? e.x + 0.5
    const y = e.fine?.y ?? e.y + 0.5
    surface.post({ type: 'tap', x, y, cols: surface.columns, rows: surface.rows })
  })
  return surface.elements.Box({ key: 'overlay' })
}

export default LiveClient
