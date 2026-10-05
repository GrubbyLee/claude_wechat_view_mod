# wxmp-preview

**Live-preview your WeChat Mini Program UI right inside Claude Code.** Type `/wxmp`, pick a renderer, and every file you edit shows up as pixels in a side pane — no more window-switching between your editor and the simulator.

> **微信小程序 UI 实时预览**：在 Claude Code 里 `/wxmp` 打开右侧面板，选一种渲染引擎，改完代码即刻看到画面——告别编辑器和模拟器之间的来回切换。

## 特性

- 🎬 **三种渲染引擎**，按项目自动推荐、随时手动切换（见下表）
- 🗂 **monorepo 感知**：小程序不在仓库根目录也能扫到（`apps/mobile`、`packages/*` 等常见布局）
- 🚀 **dev server 自动拉起**：探活失败自动 `npm run dev:h5`（后台运行、幂等、日志落盘）
- 🛡 **归属校验**：端口被别的项目占用时直接拒用，绝不显示别人的页面
- ⚡ **实时直播模式**（`h5Live`）：CDP screencast 常驻，改代码即出帧
- 🖱 **点击穿透**：直播模式下直接点面板画面，交互穿透到页面
- 🔍 **纯本地**：不联网、不上传，所有渲染都在本机完成

## 环境要求

| 依赖 | 说明 |
|---|---|
| Claude Code ≥ 2.1.289 | 需要 function-hooks（Mods）机制 |
| Node.js ≥ 22 | 桥接脚本使用原生 `WebSocket` / `fetch` |
| Chromium / Chrome | 方案 A 需要；自动探测 PATH，snap 版有沙箱坑会自动绕开 |

## 快速开始

```bash
git clone https://github.com/GrubbyLee/claude_wechat_view_mod.git
cd claude_wechat_view_mod
npm install        # 方案 B/C 的依赖（miniprogram-automator / simulate / jsdom）
```

**临时体验**（任意项目目录）：

```bash
claude --plugin-dir /path/to/claude_wechat_view_mod
```

**永久启用**（推荐）——在 `~/.claude/settings.json` 的 `env` 块加一行：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude_wechat_view_mod"
  }
}
```

之后在任何小程序项目里：

```
/wxmp              # 打开面板：自动检测 + 推荐方案，热键 1/2/3 选择
/wxmp h5           # 直达方案 A（devtools / simulate 同理）
/wxmp refresh      # 手动刷一帧
```

> 像素画面走 kitty graphics 协议：kitty / Ghostty 原生支持；其他终端显示占位说明。建议配合 `"tui": "fullscreen"`（Claude Code 全屏布局）使用，面板会停靠在对话右侧。

## 三种渲染引擎

| | A · 网页版预览 | B · 开发者工具直出 | C · 轻量渲染 |
|---|---|---|---|
| 原理 | H5 dev server + headless Chromium 截图 | CDP 直抓 DevTools 模拟器 webview | miniprogram-simulate + jsdom 渲染 |
| 帧率 | ~1-3s/帧（直播模式即改即出） | ~0.5-3s/帧 | ~1-3s/帧 |
| 保真 | 高（真浏览器；wx.* 为 H5 行为） | **100%（模拟器直出）** | 中（组件级，wx.* 模拟） |
| 前提 | 有 `dev:h5` 脚本（未运行会自动拉起） | DevTools 以 `--remote-debugging-port=9333` 启动 | 无（`npm i` 即用） |
| 适用 | Taro / uni-app CLI 工程 | 原生小程序、HBuilderX / mp-weixin 工作流 | 无 DevTools 环境的快速预览 |

## 自动检测

打开面板时自动扫描工作区：

1. 根目录 `package.json` 找 `@tarojs/*` / `@dcloudio/*` / `@mpxjs*`，或 `manifest.json + pages.json`（HBuilderX）
2. 根目录不是小程序工程时**扫子目录**（一层全部 + `apps/*` / `packages/*`）
3. 推荐规则：有 `dev:h5` → **A**；纯 mp-weixin / HBuilderX 工作流 → **B**；原生无 DevTools CLI → **C**

## 配置（`/config` 菜单或 settings.json `pluginConfigs`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultSource` | `auto` | `auto` / `h5` / `devtools` / `simulate` |
| `h5Url` | `http://localhost:10086` | 方案 A 的 dev server 地址（不通时自动探测 5173/8080/3000） |
| `browser` | 空 | Chromium 路径（留空自动探测） |
| `h5Live` | `off` | `on` = 方案 A 实时直播 + 画面可点击 |
| `devtoolsCli` | 空 | DevTools CLI 路径 |
| `devtoolsCdpPort` | `9333` | 工具需以 `--remote-debugging-port=此值` 启动 |
| `autoRefresh` | `on` | 编辑小程序文件后自动刷新（直播模式自动让位） |

## 方案 B 的准备（微信开发者工具）

1. 装工具：官方版（macOS / Windows），Linux 用社区移植版（如 [msojocs/wechat-devtools-linux](https://github.com/msojocs/wechat-devtools-linux)）
2. **以调试参数启动**（一次性）：

   ```bash
   wechat-devtools-cli quit
   wechat-devtools --remote-debugging-port=9333
   ```

3. 在工具里打开你的项目——uni-app 等编译型框架打开**编译产物目录**（如 `apps/mobile/dist/build/mp-weixin`，插件检测时会自动定位并提示）

> 为什么不走官方 automator 截图：社区 Linux 移植版的 `App.captureScreenshot` 指令无响应（协议层实测），CDP 直抓 `__pageframe__` webview 是稳定通道。

## 工作原理

```
Claude 编辑小程序文件
  → tool.call 钩子 → 500ms 防抖
  → $.process.run 拉起桥接脚本（bridges/，纯 Node，stdout 回一行 JSON）
  → 解析 → $.ui.blit 帧级换图（免渲染直通）+ $.state 兜底重绘
```

| 桥 | 职责 |
|---|---|
| `h5-bridge.mjs` | 探活（含归属校验）→ 自动拉起 dev server → chromium 截图 |
| `live-bridge.mjs` | 常驻守护：CDP screencast 流式吐帧 + localhost 控制口（点击穿透） |
| `devtools-bridge.mjs` | CLI 定向打开项目 → CDP attach 模拟器 webview → 截图 |
| `simulate-bridge.mjs` | jsdom 里跑 miniprogram-simulate 渲染 WXML/WXSS → 浏览器截图 |

## 开发与测试

```bash
claude plugin validate .    # 引擎规则静态检查
claude plugin test .        # 5 个测试（含刷新管线/直播/点击穿透全链路）
```

贡献约定见 `AGENTS.md`，项目状态与踩坑史见 `HANDOFF.md`。

## 已知限制

- 直播模式同机同一时刻一个实例（帧文件与 pidfile 固定在 `/tmp/wxmp-live-*`）
- 方案 B 多项目窗口时抓第一个模拟器（已做 CLI 定向打开缓解）
- 方案 C：组件化页面直渲，经典 `Page()` 自动转换（初始数据可渲），含 `usingComponents` 的 Page 页不支持
- 像素帧需 kitty graphics 终端（kitty / Ghostty）；VS Code 请在集成终端运行 claude

## Roadmap

- [x] 方案 A 端到端（自动刷新 + dev server 自动拉起 + 归属校验）
- [x] 方案 B CDP 直抓（Linux 社区版实测）
- [x] 方案 C simulate 渲染
- [x] CDP screencast 实时直播（改代码即出帧）
- [x] 点击穿透（A·直播通道：面板点击 → 页面交互）
- [x] monorepo 工作区扫描
- [ ] 点击穿透 B / C 通道（automator tap / simulate dispatch）
- [ ] 多直播实例与远程工作区
