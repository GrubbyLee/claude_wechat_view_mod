# HANDOFF.md — 会话交接（写于 2026-10-04）

> **读者**：在 `/home/arabica/codes/claude_wechat_view` 目录里新开的 claude 会话。
> 读这一份 + `AGENTS.md`（工程规则，常青），你应当能完全接手本项目。
> 原会话跑在 `/home/arabica/tempDIR/c`（一个空目录，与本项目无关），已结束。

---

## 0. 三分钟版

**项目**：`wxmp-preview`——一个 Claude Code mod（function-hooks 插件）。`/wxmp` 在右侧
pane 里实时预览微信小程序 UI：打开时显示工作区检测 + 三个渲染方案的选择器卡片，
选一个后变成像素帧预览，Claude 每编辑一次小程序文件自动防抖刷新。

**现状**（2026-10-05 更新）：方案 A **端到端实测通过**——taro 4.3 测试项目
（`/home/arabica/codes/taro-min-e2e`）→ dev:h5（10086）→ A 桥截图 → Ghostty
pane 里渲染出帧。validate / test 全绿。期间修复 snap chromium 假成功坑、重写
UI 文案为大白话、新增 `/wxmp refresh` 命令。方案 C 仍为诚实占位。

**你接手后的第一件事**：按 §6 Roadmap 推进（下一个是方案 C 渲染桥）；
taro 测试项目的用法见 §7。

---

## 1. 起源与需求（从代码推导不出来的背景）

用户（arabica，中文交流，Linux 桌面）用 Claude Code 开发**微信小程序**，痛点：
改 UI 要切到微信开发者工具窗口看效果，想要「编辑器右侧 pane 实时预览」。

2026-10-04 的讨论链（按序）：

1. 起因是腾讯新闻上极客公园的文章《Claude Code 的"乐高"模式》
   （`news.qq.com/rain/a/20261004A052H900`）——介绍了 2026-10-01 正式上线的 Mods 机制。
2. 讨论确认：pane 里嵌浏览器没有原生 webview 元素，但官方为像素流设计了
   `Image`（PNG 文件源）+ `$.ui.blit`（帧级换源）管线——API 文档示例名就叫 `'browser'`。
3. 方案设计成三渲染源：**A**（H5 构建 + headless Chromium 截图，~1-3s/帧，适合
   Taro/uni-app/mpx）、**B**（微信开发者工具 + miniprogram-automator，保真 100%，模拟器直出）、
   **C**（miniprogram-simulate 浏览器渲染，免工具但保真中等）。
4. 用户的明确需求（原话要点）：**一个插件集中三方案**；打开 pane 时让开发者**自行选择**，
   每个方案**有介绍内容**；最好还有**针对工作区小程序的自动方案建议**。
5. 交付位置：`/home/arabica/codes/claude_wechat_view`（目录本身即插件，可
   `--plugin-dir` 直加载）。

用户工作偏好：先出方案、确认后动手；占位就明说（反对假装能跑）；每个结论要有
验证证据链；交付后喜欢一条「下一步」建议。

---

## 2. 现状快照（截至本文件写下）

| 项 | 状态 | 证据 |
|---|---|---|
| 引擎校验 | ✅ 通过 | `claude plugin validate .` → `✔ Validation passed`（hooks/calls/state 读写全部被追踪） |
| 测试 | ✅ 2/2 | `claude plugin test .` → 选择器↔预览屏切换 + 四 surface 控件存在性 |
| 桥 A 冒烟 | ✅ | `node bridges/h5-bridge.mjs` → 无 dev server 时输出引导 JSON（fetch 探活路径工作） |
| 桥 B 冒烟 | ✅ | `node bridges/devtools-bridge.mjs` → **miniprogram-automator 导入成功**，连不上 9420 时输出引导 JSON |
| 桥 C 冒烟 | ✅ | 占位 JSON（按设计） |
| npm 依赖 | ✅ 已装 | 77 个包（miniprogram-automator 及其依赖树；若干 deprecation 警告，无害） |
| 端到端实测 | ✅ 全链路（含自动刷新） | 2026-10-05 夜：PTY 驱动真交互会话，编辑 index.tsx 后 500ms 防抖 → 桥 → 新帧（6166→6514 字节） |

**环境事实**（都在本机验证过）：

- Linux（Kernel 7.0），Node v22.22.3（nvm）。
- 浏览器：`/snap/bin/chromium`、`/usr/bin/google-chrome`、`/usr/bin/google-chrome-stable`
  都在——**方案 A 随时可用**（只要有个跑着的 H5 dev server）。
- **没有微信开发者工具**（`which wechat-devtools-cli/wechat-devtools` 均空）——方案 B
  在本机只能走到「连接失败 + 引导文案」，出画面需要先装 DevTools（Linux 无官方版，
  需社区移植或 wine）。
- 本仓库**自己不是小程序项目**：`package.json` 存在但无框架依赖 → `detect()` 会判
  `unknown`、推荐 `none`、选择器显示「未识别出跨端框架」——这是预期行为，不是 bug。
- Claude Code 版本 2.1.289（npm 全局，二进制 `bin/claude.exe`）。
- 终端 **Ghostty**（kitty graphics 可用，像素帧正常渲染；但鼠标点击 pane 按钮
  未见生效——已加 `/wxmp refresh` 命令与 ctrl+x→tab 键盘路径候补）。
- 后端 glm-5.3[1m]：auto 模式安全分类器**间歇超时**，会话内无法根治，应对见 §4.9。

**历史注脚**（只影响理解，不影响你）：原会话把仓库拷到过它自己的 dev-mods 热加载目录
（`~/.claude/dev-mods/378e269f-…/wxmp-preview`）做过一次真机加载验证（`.claude-plugin/types/`
被引擎铺出 = 加载成功的标志）。那个目录是旧会话私有的，你用不到，也**别**指望它同步
（它没有 node_modules 链接，且已是过期副本）。你测试加载用 `claude --plugin-dir .`。

---

## 3. 架构与数据流（细节层）

### 状态（`$.state`，契约在 `types/index.d.ts`）

| 键 | 类型/初值 | 含义 |
|---|---|---|
| `screen` | `'chooser' \| 'preview'`，`'chooser'` | 面板当前屏 |
| `detection` | `Detection \| null`，`null` | 最近一次工作区探测（project/evidence/recommend/devtoolsCli/h5Script） |
| `active` | `ActiveSource \| null`，`null` | 当前方案与帧状态（kind/startedAt/refreshes/frameSeq/framePath/frameAt/frameWidth/frameHeight/lastError/busy） |
| `remember` | `'project' \| 'ask'`，`'project` | 选择器底部「记住选择」的开关 |

跨会话记忆：`$.store` 键 `wxmp:choice:<session cwd>` → SourceKind。

### 命令与参数

`/wxmp [h5|devtools|simulate|auto|ask]`（`command.run` 钩子）：
显式方案名直达；空/`auto` = userConfig `defaultSource`（若固定）→ 记住的选择
（remember=project 时）→ 检测建议；`ask` 或全落空 → 停选择器。开 pane：
`$.ui.open({ id: 'wxmp', title: '小程序预览', columns: 56 })`。

### 刷新管线

```
tool.call{Edit|Write|MultiEdit|NotebookEdit}（后缀匹配 MINI_PROGRAM_FILE）
  → await next(e)（编辑落盘后）→ 防抖 500ms（$.clock.after，pendingRefresh 可取消）
  → refresh($, cfg)：inFlight 闸 → busy 置位 → $.process.run(['node', bridge, …], 90s)
  → parseBridgeResult(stdout) → 成功：frameSeq++ / framePath / blit + state.set
     （blit 被拒也没事，state 重绘兜底显示同一帧；ImageSource.generation=frameSeq
      告诉终端"同路径新内容"）→ $.ui.status ✓
  → 失败：lastError + status ✗ + toast（错误截断到 120 字）
```

选中方案（`choose`）后 600ms 排首帧——故意走 `clock.after` 而不是直接 refresh：
测试环境里睡在 mock clock 上的定时器不会推进，避免测试挂起（这是个有意的取舍）。

### 渲染（`ui.render{component:Pane, requestId:'wxmp'}`）

- `drawChooser`：检测头（Markdown）+ 三张卡片（Box borderStyle=round，标题/参数行/
  介绍 Markdown/环境状态行/「使用此方案」Button，推荐卡 variant=primary + ⭐）+
  「重新检测」「记住选择」两按钮 + 热键提示行。按钮 key：`use-h5`/`use-devtools`/
  `use-simulate`/`redetect`/`remember`；热键 1/2/3。
- `drawPreview`：工具条（`refresh` r primary / `switch` s / 状态 Text）+ 错误红字 +
  像素帧。**Image 只在 `e.surface === 'terminal'` 且有 framePath 时画**（其他 surface
  画占位文案解释原因）；尺寸按 frame 宽高比（默认 667/375）算行数，÷2 是终端 cell
  约 1:2 的纵横比，上限 255。
- 元素从 `$.ui.resolve(e)` 取；跨 surface 共有名（Box/Text/Button/Markdown）直接
  解构，terminal 独有名（Image）在 narrow 后取。

### 桥接脚本（bridges/，纯 Node .mjs）

- 约定见 AGENTS.md；**设计取舍**：v1 全部是**一次性短进程**（每次刷新起一个），
  避免长命子进程在 hook dispatch 生命周期里被中断的问题；B 桥先 `automator.connect`
  已开的自动化端口（快），失败且有 `--cli` 才 `launch`（首启慢）并保持 DevTools
  常驻，后续帧再走 connect。B 桥截图前 `--wait 1200` 等文件变更重编译稳定。
- A 桥：先 `fetch` 探活 dev server（截 Chrome 错误页没有意义），然后
  `chromium --headless=new --screenshot=<abs> --window-size=375,667
  --virtual-time-budget=2500`，浏览器按候选名单逐个 `--version` 探测。

### userConfig（6 项）

`defaultSource`（auto/h5/devtools/simulate）、`h5Url`（默认
`http://localhost:10086`——**taro 默认端口**，uni-app 可能是别的，按项目改）、`browser`、
`devtoolsCli`、`devtoolsPort`（9420）、`autoRefresh`（on/off）。经 `/config` 菜单或
settings.json `pluginConfigs["wxmp-preview"]` 生效，改动热重载生效。

---

## 4. 踩坑记录（引擎规则是怎么发现的——按报错顺序）

这些全部来自 `claude plugin validate` / `plugin test` 的真实报错，新会话改代码时
**先读 AGENTS.md 的规则，再看这里的原因**：

1. **`$` 不能传给 import 的函数**：最初 detect/refresh 放在 `detect.ts`/`bridge.ts`，
   报 `$ is passed to "detect", imported from "./detect": $ is followed only into a
   function declared in this same file, never across an import`。→ 并回 register.tsx。
2. **`$` 的接收函数必须在文件顶层**：并回后放在 register 闭包里，报
   `which is not a function declared at the top of this file (a function
   declaration, or a const bound to one)`。→ 全部提到模块顶层，cfg 走参数。
3. **atom 不能 import**：atoms 原在 `state.ts`，报
   `the state library's update takes a source the scan can read: … written there or
   in a const of this file`。→ atoms 并入 register.tsx（state.ts 删除）。这也是官方
   示例 pane.tsx 把 atom 写在模块顶部的原因。
4. **userConfig schema**：连字符键 → `Invalid key in record`；只写 `title` →
   `description: expected string`。→ camelCase + 两个必填字段。
5. **测试 mount 的 requestId 是顶层字段**：放 props 里导致引擎另铸 id、render
   matcher 匹配不上，报 `no implementation for ui.render`。→ MountTarget 文档确认。
6. **测试要装 mock 底座**：交互触碰 `$.clock.now` 报
   `no implementation for clock.now`。→ `mock.clock(on)` / `mock.store(on)`。

另外两个一次性坑：会话后半段安全分类器长时间不可用（Write/新命令被挡，已绕过/
由用户手动执行），以及 npm 装包时的 deprecation 警告（无害）。

2026-10-05 会话新增（均已修复或已有绕行）：

7. **snap chromium 假成功**：`/snap/bin/chromium` 截图 exit 0 但文件落进 snap
   私有 /tmp，桥在系统侧 `access()` 不到 → 报「未产出截图文件」。修复：
   `findBrowsers` 返回全部候选（deb 系优先）+ 截图失败/文件缺失自动换下一个。
8. **Taro 4.3 CLI 旗标枚举大小写敏感**：`--npm npm`、`--css none` 被 NpmType/
   CSSType 枚举拒收（合法值是 `None` 这类），交互式列表只给合法值——**建仓走
   交互，别猜旗标值**。
9. **glm-5.3 分类器间歇超时**（auto 模式下所有 Bash/Write 被卡，会话内无法
   根治）：应对 = 用户 `!` 前缀代跑。白名单 settings.local.json 对运行中会话
   不生效；插件给自己写权限配置会被分类器正确拦下，需用户明示确认。
10. **tool_input 幽灵字段（v1 致命 bug，已修）**：tool.call 事件的工具参数平铺
    在事件顶层（`e.file_path`），没有 `e.tool_input` 包装——v1 的 maybeSchedule
    读 `e.tool_input` 永远拿到空路径，**自动刷新从未生效过**。用户 01:11 编辑
    测试无反应即此因（不是 snap 坑；snap 只影响手动刷新路径，两个 bug 分踞
    两条路径）。教训：管线逻辑必须配自动化测试，人眼验证会漏掉「从未触发」
    类 bug。另外 `-p`/`--resume` 会话的插件 `$.state` 不随 resume 恢复、
    进程退出会掐掉防抖定时器——无头模式测不了时序逻辑，用测试环境的
    mock clock（见 tests 第三个测试）。

---

## 5. 已知限制（诚实清单）

- **方案 C 是占位**：选 C 只会在面板里报「渲染桥尚未实现」。这是有意的（宁可诚实
  占位也不写假装能跑的代码）。
- 帧率是「预览级」：单次截图 0.5-3s/帧，不是实时视频流。
- 像素帧走 kitty graphics 协议：kitty/Ghostty 最佳；不支持的终端显示 alt 文案；
  VS Code 里必须在**集成终端**跑 claude（终端 surface 才有 Image 元素）。
- 方案 B 在本机走不通（没有 DevTools），Linux 无官方版。
- `h5Url` 默认值只对 taro 成立，uni-app 项目要改配置。
- Ghostty 里鼠标点击 pane 按钮未生效（根因未查，疑似 mouse-reporting 交互）；
  已有 `/wxmp refresh` 命令和 ctrl+x→tab 键盘路径候补。
- pane 停靠位置插件控制不了（引擎按「全屏渲染模式 + 终端 ≥110 列」决定 dock 右侧，
  否则 inline 在 prompt 上方；anthropics/claude-code#99404 是开放的功能请求）。
  插件端已在 inline 时显示指路文案；用户侧自查：`/tui` 看模式、终端拉宽 ≥110 列、
  确认没设 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。
- `tsc -p` 全量类型检查没跑过（validate 已按引擎方式编译过模块；引擎铺的
  `.claude-plugin/types` 在旧会话的 dev-mods 副本里，源目录没有）。想跑的话在
  仓库根建一个 tsconfig（include: hooks/types/tests，types 指向引擎声明文件——
  重新 `--plugin-dir` 加载一次就会在源目录铺出 `.claude-plugin/types/`）。
- 没做过任何真实小程序项目的端到端验证（最重要的一条）。

---

## 6. Roadmap（按优先级）

1. ~~端到端实测方案 A~~ ✅ 2026-10-05：全链路跑通（含编辑→自动刷新的真会话
   实测），snap 坑与 tool_input 幽灵字段双修复，文案重写，管线测试锁定。
2. **方案 C 渲染桥**：miniprogram-simulate + headless 浏览器，按 AGENTS.md 的桥约定写。
3. **方案 A 升级 CDP screencast**：`Page.startScreencast` + WebSocket 常驻连接，
   60fps；需要把桥改成长命子进程（参考 `$.process.spawn` 的流式文档和
   "session.start 拉起、模块卸载即终止"的示例）。
4. **点击穿透**：`Client` 元素 + `onPointer` 亚像素坐标 + automator 的
   `element.offset()/size()` 反查 rect → `element.tap()`。
5. 常驻桥进程（同 3 的基础设施）。

---

## 7. 你接手后的验证清单（建议顺序）

```bash
cd /home/arabica/codes/claude_wechat_view
claude plugin validate .                        # 应：✔ Validation passed
claude plugin test .                            # 应：2 pass / 0 fail
node bridges/simulate-bridge.mjs                # 应：占位 JSON
node bridges/h5-bridge.mjs --url http://localhost:10086   # 应：不可达引导 JSON
node bridges/devtools-bridge.mjs --port 9420    # 应：连接失败引导 JSON（依赖已装）
```

上面这版已全部跑过且全绿（2026-10-05：validate ✔ / test 2/2 ✔ / 三桥冒烟 ✔）；
日常改完代码跑前两条即可。

taro 测试项目在 `/home/arabica/codes/taro-min-e2e`（React+TS · weapp+H5 ·
webpack5；起服务：`cd /home/arabica/codes/taro-min-e2e && nohup npm run dev:h5
> /tmp/taro-h5.log 2>&1 &`，10086 端口）。体验 pane：在**那个目录**里
`claude --plugin-dir /home/arabica/codes/claude_wechat_view` → `/wxmp`（自动
认出 taro 项目、推荐方案 A）→ `/wxmp refresh` 手动刷帧。

**已全部验证**（2026-10-05 夜）：PTY 驱动的真交互会话里 `/wxmp h5` 出首帧、
Claude 编辑 `index.tsx` 后自动出新帧；管线另有自动化测试锁定（tests 第三个）。
注意 taro 项目的 `dev:h5` 需在跑（起法见上）；`index.tsx` 当前文案为
「你好，微信小程序 v2」（e2e 测试改的，无需恢复）。

---

## 8. 维护这份文档

- 每次「会话要结束了/要交接了」就更新 §2/§5/§6/§7；规则性的东西进 AGENTS.md，
  状态性的东西留这里。
- 踩到新的引擎规则（validate/test 报新错），补进 AGENTS.md 的规则清单和这里 §4。
