# AGENTS.md — wxmp-preview

本仓库是一个 **Claude Code function-hooks 插件（mod）**，名字 `wxmp-preview`：
在 Claude Code 里 `/wxmp` 打开右侧 pane，实时预览微信小程序 UI。
三个可切换的渲染方案（A·H5+Headless Chromium / B·微信开发者工具+Automator / C·simulate+jsdom 轻量渲染），
打开时先显示工作区自动检测结果和方案选择器。

项目细节、当前状态、待办见 `HANDOFF.md`（先读它）。

## 引擎硬规则（违反 = `claude plugin validate` 直接拒绝，别绕）

1. **`$` 只能流进 `hooks/register.tsx` 顶层声明的函数**（函数声明，或绑定函数表达式的
   const）。不能跨 import（`lib.ts`/`sources.ts` 里不许出现 `$`），不能是 register 闭包
   里的局部函数。所有 `$` 使用必须是 `$.noun.method(...)` 成员调用，不许别名。
   触发 `refresh()` 这类动作时，配置通过参数传（`refresh($, cfg)`）。
2. **atom 必须声明在 `hooks/register.tsx` 本文件里**（`{ plugin, key } as const` 字面量）。
   状态扫描器不追踪 import 来的引用。新增状态值 = atom + `types/index.d.ts` 契约同步改。
3. **hooks.json 只有一个 modules 入口**（`./register.tsx`）。插件内文件只能**静态 import**；
   模块里出现 `import()` 直接不加载。文件名后缀必须是 .ts/.tsx/.jsx/.js/.mjs/.cjs/.mts/.cts。
4. **userConfig 字段**：键必须 camelCase（带连字符 = Invalid key）；每个字段 `title` 和
   `description` 都是必填 string；带 `options` 的 string 字段是下拉选择。
5. **`ui.render` 钩子里禁止写 `$.state`**（渲染期 set 被引擎拒绝）。写状态只能来自
   Button 的 `onPress`、`ui.select`/`ui.input` 回调或其他事件钩子；渲染钩子只 `read`。
   `read` 会订阅实例，之后的 `set`/`update` 自动重绘画读者，不用手动 invalidate。
6. **改完就跑** `claude plugin validate .`——它按引擎的方式编译 hooks 模块源码并报告
   所有会被拒绝的写法，是最快的反馈回路。

## 布局

```
.claude-plugin/plugin.json   清单 + userConfig（6 项，/config 菜单可见）
types/index.d.ts             $.state 契约（PluginState 的 'wxmp-preview' 键）
hooks/hooks.json             modules: ["./register.tsx"]（唯一入口）
hooks/register.tsx           事件注册 + 全部接收 $ 的函数 + 两块屏的 JSX（选择器/预览屏）
hooks/sources.ts             三方案的静态介绍/状态文案（纯数据，无 $）
hooks/lib.ts                 argv 拼装 / stdout JSON 解析 / 判定（纯函数，无 $）
bridges/*.mjs                三个纯 Node 桥接脚本（进程外，$.process.run 拉起）
tests/wxmp-preview.test.ts   UI 测试（第三个是刷新管线全链路）
tests/fixtures/native-demo/  方案 C 冒烟用的原生小程序夹具
package.json                 方案 B/C 的桥接依赖（automator / simulate / jsdom）
README.md                    使用文档；tsconfig.json 引擎铺类型后 tsc -p 用
```

## 桥接脚本约定（bridges/）

- 跑在 Claude Code 进程**外**的普通 Node 里（可以用 node: 全家桶），由
  `$.process.run(['node', <script>, ...flags])` 拉起，`timeoutMs: 90000`。
- **约定：结束时在 stdout 打一行 JSON**（`{ ok, path?, ... }` / `{ ok: false, error }`），
  mod 端从后往前找第一个合法 JSON 行解析（`parseBridgeResult`）。加新桥必须守约。
- 可单独手跑冒烟（无需 Claude Code）：
  - `node bridges/simulate-bridge.mjs --project tests/fixtures/native-demo` → 渲染原生
    演示页出真 PNG（组件化页面直渲；经典 Page() 自动转换；含 usingComponents 的
    Page 页不支持，如实报错）
  - `node bridges/h5-bridge.mjs --url http://localhost:10086` → 无 dev server 时的引导文案
  - `node bridges/devtools-bridge.mjs --port 9420` → 连不上端口时的引导文案
  - `node bridges/live-bridge.mjs --url http://localhost:10086 --out /tmp/live.png`
    → 直播守护（常驻，stdout 流式吐 started/frame 行；需 dev server 在跑，
    Ctrl-C 带走 chromium）
  （以上依赖 `npm install` 装在仓库根的 node_modules）

## 命令

```bash
claude plugin validate .          # 清单 + hooks 模块静态检查（最常用）
claude plugin test .              # 跑 tests/*.test.ts（引擎真实宿主）
claude --plugin-dir .             # 新会话里临时加载，输入 /wxmp 体验
```

## 约定

- UI 文案中文；代码注释密度中等、解释"为什么"而非"是什么"。
- **错误绝不抛**：mod 端落到 `active.lastError`（预览屏红字 + toast + status line），
  桥端用 JSON `error` 表达。用户体验是"看得见的失败"而不是崩溃。
- 防抖/并发闸（`inFlight`/`pendingRefresh`）用模块变量——热重载会重置，可接受
  （不参与绘制，丢失无害）；参与绘制的值一律进 `$.state`。
- 跨会话记忆用 `$.store`，键 `wxmp:choice:<项目根>`；会话内状态用 `$.state`。

## 测试写法（照抄 tests/ 里的模式）

- `$.ui.mount({ plugin, surface, component, props, requestId })`——**requestId 是顶层
  字段**（pane 的 id，必须和 render hook 的 matcher 一致），放 props 里 matcher 匹配不上。
- 会触碰 `$.clock`/`$.store` 的交互，先 `mock.clock(on)` / `mock.store(on)` 装好插件
  之下的世界，否则报 "no implementation for clock.now"。
- 伪造进程/工具调用：`on('process.run', async () => ({ value: { exitCode, stdout, ... } }))`
  ——call 类事件回 **`{ value }`** 包装；给 `$.tool.call` 垫底用
  `on('tool.call', async () => ({ result: { result, text } }))`——回 **`{ result }`**；
  伪造 `$.process.spawn` 流用 async 生成器：yield 裸 `{ stream, text }` 块、
  **return `{ value: { code, signal } }`**（协议不同，报错信息会直说缺哪个）。
  `mock.clock(on)` 的返回值带 `advance(ms)`，用来推进防抖定时器（tests 第三、
  四个测试是完整范例）。
- 同一断言体循环跑多个 surface（有按钮交互的 `['terminal','desktop']`；
  纯存在性断言可加 `vscode`/`mobile`）。
- press 之后立即断言即可——act 会等链、onPress 和未 await 的活儿都 settle；
  睡在 mock clock 上的定时器不推进就不跑。

## 不要做

- 不要把接收 `$` 的函数挪进 lib.ts / sources.ts / 新文件。
- 不要在 bridges 里访问 `$`（那里没有 `$`，是纯 Node）。
- 不要给 userConfig 键加连字符；不要漏 `title`/`description`。
- 不要在渲染钩子里写状态、调 `update`。
- 不要用动态 `import()`（hooks 模块内）；bridges 里的 `await import(...)` 没问题。
- 不要为了"更流肠"把桥改成常驻进程而不读 HANDOFF 的架构章节（有一期规划）。
