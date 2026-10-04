# wxmp-preview · 微信小程序 UI 实时预览（Claude Code Mod）

在 Claude Code 里用 **`/wxmp`** 打开右侧预览面板：先看到工作区自动检测和三个渲染方案的介绍卡片，选一个后面板变成**像素帧实时预览**——Claude 每编辑一次小程序文件，预览自动刷新。

本项目是一个 [Claude Code function-hooks 插件](https://claudemods.ai)（Mod），目录本身即插件。

## 三个渲染方案

| | A · 网页版预览 | B · 开发者工具直出 | C · 轻量渲染 |
|---|---|---|---|
| 帧率 | ~1-3s/帧 | ~0.5-3s/帧 | ~1-3s/帧 |
| 保真 | 高（真 Chromium） | **100%（模拟器直出）** | 中（组件级，wx.* 模拟） |
| 前提 | 项目能跑 `dev:h5`；本机有 Chromium | 本机可跑微信开发者工具；`npm i -D miniprogram-automator` | 无（`npm i` 即用） |
| 适用 | Taro / uni-app / mpx 项目 | 原生小程序（或任何想要 100% 保真的场景） | 没有 DevTools 时的轻量方案 |

自动检测逻辑：`package.json` 里找 `@tarojs/*` / `@dcloudio/*` / `@mpxjs*` → 推荐 A；存在 `project.config.json` → 原生项目，找到 DevTools CLI 推荐 B，否则推荐 C。

## 安装

```bash
# 一次性（可选，仅方案 B 需要）
cd <本仓库目录> && npm install

# 方式一：本会话热重载开发（写入 dev-mods 后按提示 Enable）
# 方式二：每个会话临时加载
claude --plugin-dir /home/arabica/codes/claude_wechat_view

# 方式三：长期启用（settings.json 的 env）
#   CLAUDE_CODE_PLUGIN_DIRS=/home/arabica/codes/claude_wechat_view
```

## 使用

```
/wxmp              # 打开面板：检测 + 建议，选择方案（面板里热键 1/2/3）
/wxmp h5           # 直达方案 A（devtools / simulate 同理）
/wxmp refresh      # 手动刷一帧（面板点击/热键不可用时的命令候补）
/wxmp ask          # 强制停在方案选择器
```

面板操作：

- 选择器：每张卡片有介绍与环境状态（✅/⚠️），「使用此方案」；「重新检测」；「记住选择」按项目记住
- 预览屏：`[刷新]`（热键 r）、`[切换方案]`（热键 s）切换方案随时回选择器
- Claude 编辑 `.wxml/.wxss/.json/.ts/...` 后自动防抖刷新（可用 `autoRefresh` 配置关闭）

> 像素帧通过 kitty graphics protocol 绘制，支持 kitty / Ghostty；其他终端
> 会显示 alt 文案。VS Code 里请在**集成终端**中运行 claude（终端 surface）。

## 配置（/config 菜单或 settings.json 的 pluginConfigs）

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultSource` | `auto` | `auto` / `h5` / `devtools` / `simulate` |
| `h5Url` | `http://localhost:10086` | 方案 A 的 dev server 地址 |
| `browser` | 空 | Chromium 路径（留空自动探测 PATH） |
| `devtoolsCli` | 空 | 开发者工具 CLI 路径（Linux 社区版需指定） |
| `devtoolsPort` | `9420` | 自动化端口 |
| `autoRefresh` | `on` | 编辑后自动刷新 |

## 架构

```
.claude-plugin/plugin.json   清单 + userConfig
types/index.d.ts             $.state 契约（screen / detection / active / remember）
hooks/
  hooks.json                 指向唯一入口 register.tsx
  register.tsx               所有事件钩子 + atom 定义 + 全部接收 $ 的函数（$ 不出本文件顶层）
  sources.ts                 三个方案的静态介绍/状态文案（纯数据）
  lib.ts                     参数拼装 / JSON 解析（纯函数）
bridges/                     纯 Node 脚本，$.process.run 拉起，stdout 回一行 JSON
  h5-bridge.mjs              A：fetch 探活 → chromium --headless --screenshot
  devtools-bridge.mjs        B：automator.connect / launch → miniProgram.screenshot
  simulate-bridge.mjs        C：simulate + jsdom 渲染 WXML/WXSS → headless 浏览器截图
tests/wxmp-preview.test.ts   UI 测试（claude plugin test）
```

刷新管线：`tool.call`(Edit/Write/…) → 防抖 500ms → `$.process.run(node bridge.mjs …)`
→ 解析 stdout JSON → `$.ui.blit`（keyed Image 换帧）+ `$.state` 更新（重绘兜底）。

## 开发与验证

```bash
claude plugin validate /home/arabica/codes/claude_wechat_view
claude plugin test /home/arabica/codes/claude_wechat_view
```

调试：`claude --debug` 里看 `wxmp-preview:` 前缀的拒绝/失败行；热重载会话里
transcript 有一行 dim 提示。桥接脚本可以单独手跑（stdout 就是 JSON）。

## 安全提示

Mod 与 Claude Code 本体拥有相同的机器权限。本插件只执行：读项目文件、
`which` 探测、`node bridges/*.mjs`（其中 devtools 桥会调用
`miniprogram-automator`）。**不要安装来路不明的第三方 mod**；本插件也
建议只在自己机器上使用，对外分发前先审计。

## Roadmap

- [x] 方案 C 渲染桥（miniprogram-simulate + jsdom + headless 浏览器）
- [ ] 方案 A 升级为 CDP screencast（60fps）
- [ ] 点击穿透：pane 里的指针事件 → automator 元素 rect 反查 → `element.tap()`
- [ ] 常驻桥进程（session.start 拉起，`process.spawn` 流式收帧）
