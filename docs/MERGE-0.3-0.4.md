# 0.3 → 0.4 UI/UX 资产盘点与合并计划

> 任务：G2 / `task-96`（方案 B 的移植清单）。
> 类型：**只读盘点 + 计划**。写域仅本文件；本轮不修改 `extension/**`（0.3）与 `0.4/**`。
> 位置约束：本文档是仓库内部文档（`docs/`），**不进入 0.4 产品路径**，不会被 `0.4/scripts/*` 或 `tools/build-extension*.mjs` 打包（两者都只复制各自源目录内的白名单条目）。
> 盘点时间：2026-11-24（17:47 开始；17:50–17:57 有并发任务改动 0.4，相关事实在 §2.5 单独标注）。基线：0.3.0 冻结源码 `extension/`（6,251,997 B ≈ 6,107.8 KiB / 269 文件）+ `0.4/extension-ingress`（盘点初 520,083 B / 15 文件；收尾时 623,231 B / 23 文件，含测试）。

---

## 0. 结论摘要（先读这一段）

1. **0.4 原本没有任何扩展侧 UI 面；盘点期间（2026-11-24 17:50–17:56）并行任务已经落地了一个「0.4 原创」UI 骨架**。盘点开始时 `0.4/extension-ingress/manifest.json`（37 行）只有 `background.service_worker` + 1 个内容脚本 `content/human-watch.js`，**没有 `action`（popup）、没有 `options_ui`、没有图标**；0.4 现有 operator UI 是 `0.4/dashboard`（服务端单页，与浏览器扩展两回事）。17:50 起并发任务（G4）新增了 `0.4/extension-ingress/ui/{popup.html,popup.js,popup.css,options.html,options.js,options.css,settings.js}` + `test/ui.test.mjs`（23 个 test）并给 manifest 加上 `action`/`options_ui`。**该实现是 0.4 原创（中文硬编码、只读 `ui.status` 消息、`bb04.ui.*` 设置），不是 0.3 UI 的移植**。→ 本文档 §3 的 0.3 资产清单仍然是「可复用资产」的完整账本，§5 的 B1 清单改为**对该已落地骨架的验收/裁剪基线**（详见 §2.5 与 §5 的「B1 现状对齐」）。
2. **但 0.4 已经有一套自己的页内浮层体系，不能整包搬 0.3 的 overlay**。`0.4/packages/browser-adapter/src/overlay-render.js`（33,766 B / `createOverlayRenderer`）用 CDP `Runtime.evaluate` 画 shadow-DOM 浮层（host id 可配，已用于 `cooperate-handlers.js` 的协作浮层与 `help-handlers.js` 的 `bridgedeck-help-overlay` 帮助浮层，含 `clickTrusted` 经 CDP `Input.dispatchMouseEvent` 派发可信点击）。0.3 的 `overlay-ui.js`（760 行 / 44,887 B）走的是 `chrome.scripting.executeScript` 注入四函数。**两条注入通道必须二选一或明确分工，否则同一页面会同时出现两套浮层。**
3. **0.4 没有事件推送面**：`packages/protocol/src/events.js` 只定义了 10 个 `EventKind`（`session.activity` / `session.interaction_changed` / `session.ended` / `session.user_interrupt` 等），但 `0.4/daemon/ws-transport.mjs:302` 明确「notifications (missing `id`) are not supported」，全仓库只有 `0.4/scripts/bsk-event-check.mjs` 引用 `EVENT_KINDS`。→ **B1 的 popup 只能用「轮询 `ui.status`（已落地的只读 SW 消息）/ `system.status` + 读 `bridge.snapshot()`」拿状态**（与 0.3 popup 的 2.5 s 轮询同构），事件面留给后续任务。
4. **规模**：本轮点名 + 同族直接依赖共 **51 个文件 / 15,398 行 / 713,127 B（696.4 KiB）**。其中 `ui/locales.js`（168,119 B）与 `injected/page-lib.js`（180,712 B）两者合计 **48.9%**，是体积决策的全部重点。
5. **分类结论**（详见 §3）：可直接移植 14 文件 / 4,829 行；小改可移植 15 文件 / 3,025 行；需重写 7 文件 / 611 行；不移植 15 文件 / 6,933 行（含 page-lib 与 3 个内容脚本）。
6. **对接结论**（详见 §4）：0.3 的 `hello/call/res/event` 四类帧 → 0.4 的 `extension.register` + JSON-RPC 2.0 + `extension.pull/complete` + `extension.event`；0.3 的 165 canonical 方法里**扩展侧服务的有 126 个**（109 session + 17 instance，见 `docs/PROTOCOL-METHODS.md` 实测 170 行：44 local + 109 session + 17 instance），0.4 的扩展只保留 **6 个 `ext.*` 命令**，其余全部由 0.4 daemon 的 CDP 面接管。**UI 必须改成「读 0.4 面」，而不是「读 165 方法的回执」。**

---

## 1. 盘点范围、方法与证据

### 1.1 读过的文件（全部只读）

| 组 | 路径 | 说明 |
| --- | --- | --- |
| UI 共享 | `extension/ui/common.js`、`direction.js`、`i18n.js`、`locales.js`、`ui.css`、`popup.css`、`tab-picker.js` | 7 个基础模块 |
| UI 主入口 | `extension/ui/popup.{html,js,css}`、`options.{html,js}`、`quick.{html,js}`、`privacy.html` | 7 个 |
| UI 特性页 | `extension/ui/{audit,debug,longshot,ops,preview,record}.{html,js}` | 12 个 |
| UI 面板 | `extension/ui/panels/{audit,debug,longshot,ops,video}-panel.js` | 5 个 |
| 浮层/决策 | `extension/src/overlay-ui.js`、`overlay-locales.js`、`overlay-theme.js`、`overlay-texts.js`、`overlay-state.js`、`overlay-controller.js`、`overlay-suppress.js`、`borrow-ui.js`、`takeover.js`、`human-decisions.js`、`human-state.js`、`action-notifications.js`、`settings.js` | 13 个 |
| 内容脚本 | `extension/content/human-watch.js`、`cooperation.js`、`record-capture.js` | 3 个 |
| 注入库 | `extension/injected/page-lib.js`（180,712 B）+ `parts/*.part`（26 块）、`main-console.js` | 仅评估 |
| 构建/清单 | `tools/build-extension.mjs`、`tools/build-page-lib.mjs`、`extension/manifest.json` | 3 个 |
| 0.4 对面 | `0.4/extension-ingress/{manifest.json,background.js,README.md,src/*,content/*,test/smoke.mjs,test/ui.test.mjs,ui/*}`、`0.4/daemon/{extension-ingress.mjs,server.mjs,ws-transport.mjs}`、`0.4/scripts/{build-extension-ingress.mjs,test-all.mjs,stage-gate.mjs,product-compliance.mjs}`、`0.4/packages/{protocol,browser-adapter,vom}` 目录、`0.4/dashboard/README.md`、`0.4/tests/extension-ingress-e2e.mjs` | 对接前提 |
| 既有文档 | `docs/PROTOCOL-METHODS.md`、`docs/0.4-ARCHITECTURE-PLAN.md`、`docs/UI-COMPONENTIZATION.md`、`docs/I18N-COVERAGE.md`、`docs/UI-BUTTON-AUDIT.md`、`docs/UI-DESIGN-BRIEF.md`（并发 G1 产出的 0.4 设计简报） | 交叉核对 |

### 1.2 计数方法（可复现）

```powershell
# 行数用 \n 切分（与 read 工具一致；Get-Content .Count 在部分文件上会少算 1 行）
$t=[IO.File]::ReadAllText($p); $n=($t -split "`n").Count; if($t.EndsWith("`n")){$n-=1}
# 字节数
(Get-Item $p).Length
# 体积
(Get-ChildItem 'D:\浏览器桥\extension' -Recurse -File | Measure-Object Length -Sum).Sum   # 6,251,997 B ≈ 6,107.8 KiB
```

> 提醒：0.3 仓库里 `ui/panels/*.js` 的中文在 `Get-Content` 默认管道下会显示成乱码，**文件本身是合法 UTF-8**（全文用 `[Text.Encoding]::GetEncoding('utf-8', ExceptionFallback, ExceptionFallback)` 逐文件校验通过，无 BOM）。这不是编码缺陷，但移植时建议顺手统一读取方式，避免误判为 GBK 文件。

---

## 2. 0.4 侧现状（对接前提，先看清对面）

### 2.1 0.3 vs 0.4 扩展对比

| 项 | 0.3 `extension/`（冻结） | 0.4 `extension-ingress/` |
| --- | --- | --- |
| manifest 行数 | 100 | 37 → **45**（17:51 并发任务加了 `action`/`options_ui`） |
| 名称/版本 | BridgeDeck 0.3.0 | BridgeDeck 0.4 Ingress |
| `action`（popup） | `ui/popup.html` | **盘点时无 → 17:51 起为 `ui/popup.html`**（0.4 原创，见 §2.5） |
| `options_ui` | `ui/options.html`（open_in_tab） | **盘点时无 → 17:51 起为 `ui/options.html`（open_in_tab）** |
| 图标 | 4 个（16/32/48/128） | **仍无**（`action` 未配 `default_icon`，Edge 用默认拼图图标） |
| permissions | 14 项：tabs/scripting/storage/alarms/idle/notifications/windows/downloads/webNavigation/**debugger**/**tabCapture**/**offscreen**/tabGroups/**declarativeNetRequest** | 7 项：tabs/windows/storage/alarms/scripting/tabGroups/notifications |
| content_scripts | 4 个：page-lib（ISOLATED）、human-watch、cooperation、record-capture | 1 个：human-watch（`match_about_blank:false`） |
| 通道 | 端口 52900–52909 + 自定义帧（`hello`/`call`/`res`/`event`）+ 配对码 | `ws://…/ws?token=` + JSON-RPC 2.0 + 子协议 `bridgedeck.v1` |
| daemon→扩展命令 | 126 个方法（session/instance scope） | **6 个** `ext.*` |
| 扩展→daemon | `call`/`event`（任意方法） | `extension.event`（仅 `human.input`、`session.ended` 被消费） |
| 存储键 | `bb.*` | `bb04.*`（`bb04.ingress.instanceId/wsUrl/token/borrowConfirm`） |

### 2.2 0.4 通道与命令（`0.4/extension-ingress/src/commands.js:61-66`、`0.4/daemon/server.mjs:4001-4005`）

```
extension.register {instance_id, version, browser, capabilities} -> {ok, daemon_version, heartbeat_ms}
extension.pull     {instance_id, wait_ms} -> {command_id, method, params} | null     （长轮询 25s）
extension.complete {instance_id, command_id, ok, result?|error?} -> {ok:true}
extension.event    {instance_id, event, params} -> {ok:true}                        （扩展 -> daemon）
```

扩展侧只实现 6 个方法：

| 命令 | 作用 | 对应 0.3 能力 |
| --- | --- | --- |
| `ext.session_start` | 建 Agent Window（`chrome.windows.create`） | 0.3 `session.start` 的扩展侧动作 |
| `ext.session_stop` | 归还借用 tab + 关窗口 | 0.3 `session.stop` |
| `ext.tab_borrow` | 快照 + 真实确认 + `tabs.move` | 0.3 `tab.borrow`，但多了 A3a 快照/回滚 |
| `ext.tab_return` | 按快照精确还原（pin/group/邻居锚点/fallback） | 0.3 `tab.return`，保真度更高 |
| `ext.status` | 只读窗口/tab/会话计数 | 0.3 `status`/`view` 的一小部分 |
| `ext.arm_input` | 给内容脚本下发人类输入匹配期望 | 0.3 **无**（0.3 只有 10s 宽限抑制） |

daemon 侧把这 6 个命令包装成 `extensionClient`（`server.mjs:673-681`），并由 BSK 控制面方法 `session.start` / `session.stop` / `tab.borrow` / `tab.return` 调用（`packages/browser-adapter/src/borrow-handlers.js` 头注释明确：纯 CDP 不能移窗口，必须扩展 ingress）。

### 2.3 0.4 已有的 UI/浮层资产（决定「不重复造」）

| 资产 | 路径 | 事实 |
| --- | --- | --- |
| CDP 浮层渲染器 | `0.4/packages/browser-adapter/src/overlay-render.js` | `createOverlayRenderer({cdp, hostId})`；shadow DOM、`pointer-events:none` + 按钮 `auto`、幂等 show/update/hide、epoch 乐观并发、`clickTrusted` 走 CDP 输入 |
| 协作浮层 | `cooperate-handlers.js`（80,217 B） | 用独立 host id 画 mode = human/agent/paused |
| 帮助浮层 | `help-handlers.js`（26,576 B） | host id `bridgedeck-help-overlay`，`RequestHelpResult`，`BSK_REQUEST_HELP=off` 可关 |
| 借用确认条 | `extension-ingress/content/borrow-confirm.js`（354 行 / 13,386 B） | shadow-DOM 右下角单条，页内 60s 超时 + SW 兜底；不活动 tab 走 `chrome.notifications`；**单语混排标题、无 RTL/主题/倒计时环** |
| 人类输入归因 | `extension-ingress/content/human-watch.js`（546 行 / 22,821 B） | arm 期望 + DOM 事件类型/±1.5 ms/±2px/key 匹配 + 派生事件抑制（明确写着「不照抄 0.3 的缺陷」） |
| 0.4 运维 UI | `0.4/dashboard`（服务端单页） | 只读视图 + accounts 模式的 `session.open/close/act`；**不是浏览器扩展 UI** |

### 2.4 0.4 可用的只读 JSON-RPC 面（popup 状态来源）

`0.4/daemon/server.mjs:3961-4027` 路由表实测（与 0.3 的 165 方法**不是**一一对应）：

| 类别 | 方法 |
| --- | --- |
| 运维/读 | `daemon.status`、`session.list`、`session.open`、`session.close`、`session.recover`、`tab.list`、`tab.create`、`tab.close`、`browser.list`、`system.handshake/ping/status` |
| 记录/取证 | `ledger.list/pending/resolve`、`audit.request`、`record.start/stop/list/get`、`debug.start/stop/status/query/export` |
| 视频/传输 | `video.start/stop/status/list/save/discard`、`transfer.begin/chunk/finish/finalize/resume/read/release` |
| 协作 | `cooperate.enable/sync/status/wait` |
| extension | `extension.register/pull/complete/event` |
| BSK 控制面 | `session.start/start_tracked/request/stop/stop_all/run_log` |

`system.status` 的形状（`server.mjs:2170-2213`）已经够 popup 用：`daemon_version` / `protocol_version` / `running` / `session_count` / `sessions[]`（`bskSessionEntry`：`session_id`、`agent_window_id`、`created_at_ms`、`controller:null`、`interaction:null`）/ `browsers[]` / `local_auth` / `ws_endpoint` / `extension{instances,queued,in_flight,human_events,lifecycle_events,last_event}`。

### 2.5 并发更新：0.4 已落地的 UI 骨架（2026-11-24 17:50–17:56，G4）

本盘点与另一个任务并行进行。读盘点期间 0.4 侧新增（**非本任务写入**，此处只记录事实，供对接与去重）：

| 新文件 | 行 | 字节 | 事实 |
| --- | ---: | ---: | --- |
| `0.4/extension-ingress/ui/popup.html` | 48 | 2,271 | 3 张卡：daemon 连接 / 人类输入 / 活动会话 + 页脚（刷新/复制诊断/设置）；`<html lang="zh-CN">`，**中文硬编码** |
| `.../ui/popup.js` | 583 | 21,891 | 纯函数 `describeConnection`/`describeHuman`/`buildPopupViewModel`/`buildDiagnosticsText` + DOM 渲染；数据源唯一 = SW 只读消息 `{kind:'ui.status'}`；**不 import 0.3 任何文件** |
| `.../ui/popup.css` | 337 | 6,286 | 自有 `bb-popup__*`/`bb-card`/`bb-status` 类 + `prefers-color-scheme` |
| `.../ui/options.html` / `.js` / `.css` | 60 / 208 / 194 | 2,938 / 6,820 / 3,535 | 刷新间隔 `refreshMs`、诊断级别、显示技术信息开关；change 即写 `chrome.storage.local` |
| `.../ui/settings.js` | 143 | 5,790 | `UI_STATUS_MESSAGE_KIND='ui.status'`、`bb04.ui.{refreshMs,diagnosticLevel,showTechnical}`、损坏值回落默认 |
| `.../test/ui.test.mjs` | 1,060 | 42,929 | 23 个 `node:test`：渲染/options/`ui.status` 路由（不吃 `human.input`、不发 pull）/人类三态/CSP 与禁词扫描/manifest 接线/`node --check` |
| `0.4/extension-ingress/src/bridge.js` | 1,678（盘点初）→ **≈2,022**（并发任务仍在改，行数会浮动） | 71,451 → 81,958 | 新增 `UI_STATUS_MESSAGE_KIND`、`UI_STATUS_VERSION`、`handleUiMessage`、`createUiMessageListener`、`resolveHumanState`、`HUMAN_STATE_FRESH_MS`（`:1746-1984` 附近） |
| `0.4/extension-ingress/manifest.json` | 37 → 45 | 804 → 988 | 新增 `action.default_popup`、`options_ui`；**权限未增加** |
| `docs/UI-DESIGN-BRIEF.md`（仓库 docs） | — | — | G1 的 0.4 UI 设计简报：信息层级 L0–L3、状态词表、禁止项（不抄参考产品） |
| `0.4/scripts/product-compliance.mjs` + `0.4/compliance-baseline.json` | — | 9,3xx / 4.2 KB | 产品面禁词门禁（`extension-ingress/` 的 HTML/CSS 是 **hard** 级） |

**这块已覆盖**：popup 骨架 + options 骨架 + `ui.status` 只读面 + 人类三态推导 + 23 条单测 + manifest 接线。

**这块没覆盖（正是本文档 B1 的剩余价值）**：

| 缺口 | 证据 | 本文档对应项 |
| --- | --- | --- |
| **完全没有 i18n**：popup/options 文案全中文硬编码，未接 `ui/locales.js`/`overlay-locales.js` | `popup.html:2` `lang="zh-CN"`；`popup.js` 内联 `'未连接'`/`'已连接'` 等 | B1.1 / B1.6 |
| **没有 0.3 的语言/主题/RTL 资产** | 无 `ui/i18n.js`、`ui/locales.js`、`ui/direction.js`；popup.js 无 RTL | B1.1 / B1.6 |
| **没有借用确认相关的 UI/设置** | popup 只有 连接/人类/会话 三卡；无 `borrowConfirm` 设置（只在 `config.json`） | B1.5 / B1.7 / B1.8 |
| **没有借用确认视觉移植** | `content/borrow-confirm.js` 仍是 0.4 原版（单语混排、无倒计时环/RTL/主题） | B1.7 |
| **没有 modal↔toast 重定位** | 0.4 非活动 tab 走系统通知，无 0.3 `rehomeBorrowUi` | B1.8 |
| **无偏好设置（实例名、语言、长截图模式等）** | `ui/settings.js` 只有 3 个 UI 偏好键 | B1.5 |
| **无图标** | manifest `action` 无 `default_icon` | B3.2 |
| **无 staging 打包接线** | `0.4/scripts/build-extension-ingress.mjs` 的 `RUNTIME_ENTRIES` 仍是 `manifest.json/background.js/src/content`，**不含 `ui/`** | B3.1 |

> 结论：**不要重写第二个 popup**。以 G4 的 `ui/popup.*` 为壳（它已接好 `ui.status` 与 `bb04.ui.*`），把 0.3 的 **i18n/locales、direction、overlay theme、借用确认视觉与重定位** 以「资产注入」的方式补进去；这部分恰好是 0.4 原创骨架的空白。

---

## 3. 资产清单（任务第 1 点）

分类定义：

- **可直接移植**：文件级复制即可用，或只改 import 路径 / 存储键前缀。
- **小改可移植**：结构与逻辑保留，需替换状态来源、消息类型、注入通道或配置键（≤ 1 人日/项）。
- **需重写**：职责仍需要，但契约（消息/方法/权限）在 0.4 不存在或语义冲突，只能借用设计。
- **不移植**：0.4 已有更优实现、或依赖 0.4 已废弃的权限/通道（`debugger`/`tabCapture`/`offscreen`/DNR）。

### 3.1 汇总表

> 「0.3 耦合」列：`SW:bb.x` = 经 `chrome.runtime.sendMessage` 打给 service worker 的消息类型；`M:方法名` = 165 方法族；`chrome.*` = 直接调用需要权限的 API。

#### A. UI 共享模块（7）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `ui/common.js` | 23 | 785 | `$`/`toast`/`formatBytes`/`send` | 无 | 可直接移植 |
| `ui/direction.js` | 23 | 972 | 首帧 RTL（CSP 禁内联脚本） | 无 | 可直接移植 |
| `ui/i18n.js` | 407 | 23,455 | DOM 文本翻译 + MutationObserver + 257 条 DICT + PATTERNS | `chrome.storage.local('bb.uiLang')` | 小改（键改 `bb04.uiLang`） |
| `ui/locales.js` | 3,268 | 168,119 | 251 源串 × 11 语言 = 2,761 条语义语言包（`translation/*.json` 汇总） | 无 | 可直接移植（体积见 §6） |
| `ui/ui.css` | 221 | 11,150 | 设置页/子页样式 + `:root` token + 深色 | 无 | 可直接移植 |
| `ui/popup.css` | 208 | 13,098 | 弹窗自有视觉（`--bg/--fg/--accent…`） | 无 | 可直接移植 |
| `ui/tab-picker.js` | 56 | 1,829 | 子页共用「目标标签页」选择器（`chrome.tabs.query`） | `chrome.tabs` | 可直接移植 |

#### B. UI 主入口（7）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `ui/popup.html` | 275 | 17,582 | 三视图（main/features/sub）+ 5 个内嵌 panel 容器 + 连接/配对/设备/升级提示 + 4 个 `aria-describedby` 提示 | DOM 契约由 `tests/unit/popup-dom.test.mjs` 锁定 | 小改（删 0.3 配对/协议偏差块，换 0.4 连接区；panel 容器按 §5 B1 收窄） |
| `ui/popup.js` | 629 | 32,710 | 渲染 `bb.state`、4 个安全开关、配对保存/链接解析、复制指令、`?selftest=` 全量自测（开关/配对/5 个特性页/远程不被轮询弹回/a11y） | SW:`bb.state`、`bb.settings.set`、`bb.connection`、`bb.devices.list/revoke`、`bb.cooperation.state`(tabs.sendMessage)；import `src/protocol-version.js`、5 个 panel | 小改（状态源换 §4.3；自测内容随页面裁剪） |
| `ui/options.html` | 99 | 3,712 | 设置页表单（名称/借用确认/人工协助/输入锁/页面守卫/语言/长截图模式） | 无（纯 DOM） | 小改（文案与开关语义对齐 0.4） |
| `ui/options.js` | 72 | 2,382 | 读写 `src/settings.js`（`chrome.storage.local['bb.settings']`）+ 复制启动命令 | `chrome.storage.local` | 小改（换 0.4 配置模型，见 §4.8） |
| `ui/quick.html` | 78 | 3,560 | 独立快捷功能入口页（iframe/popup 复用） | 无 | 可直接移植 |
| `ui/quick.js` | 30 | 947 | 入口按钮 → `ui/<page>.html` | `chrome.tabs.create/getCurrent/remove` | 可直接移植 |
| `ui/privacy.html` | 47 | 1,956 | 隐私说明（本地数据、30 天保留、不上传） | 无 | 小改（文案随 0.4 通道改） |

#### C. UI 特性页（12）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `ui/audit.html` / `audit.js` | 49 / 74 | 1,954 / 3,018 | 任务审计（扩展本地记录，默认关） | SW:`bb.audit.list`/`bb.audit.clear` | 需重写（0.4 走 `audit.request` / `ledger.list`，见 §4.6） |
| `ui/debug.html` / `debug.js` | 133 / 433 | 6,407 / 17,590 | 网站调试：请求/控制台/上下文/规则/回放/历史 | SW:`bb.debug.*` 10 个消息；`bb.call`（**无 handler，见 §6.2-R7**）；M:`debug.*` | 不移植（0.4 `debug.start/query/export` 在 daemon，UI 应在 dashboard） |
| `ui/longshot.html` / `longshot.js` | 83 / 200 | 3,441 / 7,844 | 长截图：自动/手动拼接、预览、保存 | SW:`bb.capture`/`bb.file.save`/`bb.manual.*`；import `src/lib/longshot-store.js`、`capture-manifest.js`、`src/longshot-render.js`；`chrome.tabs.captureVisibleTab` | 小改（截图源换 0.4 screenshot 面；domain 模块随 B2） |
| `ui/ops.html` / `ops.js` | 60 / 169 | 2,346 / 6,667 | 操作录制历史（导出/删除/JSON） | SW:`bb.ops.*` 5 个；M:`record.*` | 不移植（0.4 `record.*` 在 daemon；UI 归 dashboard） |
| `ui/preview.html` / `preview.js` | 40 / 63 | 2,028 / 2,055 | 标签页预览 + 聚焦（截图只在本扩展页显示） | `chrome.tabs.captureVisibleTab`、`tabs.update`、`windows.update` | 小改（0.4 有 `<all_urls>`，`captureVisibleTab` 可用） |
| `ui/record.html` / `record.js` | 59 / 273 | 2,314 / 11,207 | 视频录制页（读 IndexedDB `bb-videos`） | SW:`bb.rec.*`；**需要 0.3 的 `tabCapture`+`offscreen`** | 不移植（0.4 无 tabCapture/offscreen；`video.*` 在 daemon） |

#### D. UI 内嵌面板（5）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `ui/panels/longshot-panel.js` | 58 | 2,597 | 弹窗内长截图（auto/visible） | SW:`bb.capture`；import `capture-manifest`/`longshot-store` | 小改 |
| `ui/panels/audit-panel.js` | 87 | 3,155 | 弹窗内审计开关 + 最近 5 条 | SW:`bb.state`/`bb.settings.set`/`bb.audit.list` | 不移植（随 audit 页） |
| `ui/panels/debug-panel.js` | 64 | 2,115 | 弹窗内调试采集开关 | SW:`bb.debug.current/start/stop` | 不移植 |
| `ui/panels/ops-panel.js` | 79 | 2,824 | 弹窗内操作录制 | SW:`bb.ops.*` | 不移植 |
| `ui/panels/video-panel.js` | 66 | 2,140 | 弹窗内视频录制状态 | SW:`bb.rec.state/start/stop` | 不移植 |

#### E. 浮层 / 决策 / 接管（13）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `src/overlay-theme.js` | 90 | 3,357 | 18 个 `--bb-*` token × light/dark；WCAG AA 由 `tests/unit/overlay-theme.test.mjs` 守 | 无 | 可直接移植（**建议直接作为 0.4 浮层唯一 token 源**） |
| `src/overlay-texts.js` | 30 | 1,855 | 语义语言包 → 各浮层 `T` 对象 | 无 | 可直接移植 |
| `src/overlay-locales.js` | 675 | 33,646 | 12 语言 × 54 键 = 648 条浮层文案 | 无 | 可直接移植 |
| `src/overlay-controller.js` | 66 | 2,175 | 浮层注册/互斥/捕获锁（纯逻辑、可单测） | 无 | 可直接移植（需与 0.4 `collaboration.createOverlay` 去重） |
| `src/overlay-state.js` | 35 | 942 | 上者的单例 + 导出 | 无 | 可直接移植 |
| `src/overlay-ui.js` | 760 | 44,887 | 4 个自包含注入函数：`borrowBanner`（倒计时环/焦点陷阱/Esc）、`borrowToast`（非活动 tab）、`helpOverlayFunc`（闭包 shadow host）、`installTakeover`（8 种模式 + 暂停/停止二次确认 + 控制者配色 + `storage.onChanged` 联动） | 函数体内 `chrome.runtime.sendMessage`（`bb.borrow.decision`/`bb.help.resolved`/`bb.takeover.*`）、`chrome.storage.onChanged` | **拆开**：`borrowBanner`/`borrowToast` 小改可移植；`helpOverlayFunc`/`installTakeover` 需重写（0.4 已有 CDP 帮助/协作浮层，见 §4.4） |
| `src/borrow-ui.js` | 139 | 5,079 | 借用确认注入、modal↔toast 随活动 tab 重定位（`rehomeBorrowUi`）、清理 | `chrome.scripting.executeScript`、`chrome.tabs.query`、`chrome.windows.update`；`bb.borrow.decision` 回包 | 小改（挂到 0.4 `ext.tab_borrow` + `borrow-confirm.js` 通道） |
| `src/takeover.js` | 128 | 5,347 | 接管浮层状态机（`showTakeover`/`hide`/`syncControlHintsVisible`），读 `bb.agentWindowIds` | `chrome.tabs`/`scripting`/`storage.session`；M:`control-hint`；daemon 事件 `takeover.state`/`takeover.hide` | 需重写（0.4 状态来自 `session.interaction_changed` + cooperation overlay） |
| `src/human-state.js` | 17 | 553 | 记录 human 状态（供 takeover 模式切换） | SW:`bb.human.activity` | 需重写（0.4 由 ingress `human.input` 归因自带） |
| `src/human-decisions.js` | 26 | 812 | `requestId` → waiter Map，超时兜底 | SW:`bb.borrow.decision`/`bb.help.resolved` | 可直接移植（改为 Promise 注册即可） |
| `src/action-notifications.js` | 79 | 2,852 | 系统通知（Allow/Deny 按钮）+ 铃铛列表 `bb.notifications` | `chrome.notifications`、`overlayTexts` | 小改（0.4 也有 `notifications` 权限；按钮→`E_BORROW_DENIED/TIMEOUT` 语义） |
| `src/overlay-suppress.js` | 74 | 2,740 | 截图期间撤浮层、恢复 | `chrome.scripting.executeScript` | 小改（0.4 截图在 daemon，时机要换成 CDP 截图前后） |
| `src/settings.js` | 114 | 3,945 | `bb.settings` 模型 + 归一 + 订阅 + `settings.get/set` + 人工开关保护 | `chrome.storage.local`、M:`settings.get/set` | 需重写（0.4 配置 = `config.json` + `bb04.ingress.*`，见 §4.8） |

#### F. 内容脚本（3）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `content/human-watch.js` | 95 | 3,731 | 监听 `keydown/pointerdown/input/change/focusin`，用 `data-bb-agent-input` + **10 s 宽限**抑制；快照 `fields/media/textTail` 上报 | SW:`bb.human.activity`/`bb.human.input`/`bb.human.blur` | **不移植**（0.4 `content/human-watch.js` 511 行已有 arm 匹配/±1.5 ms/±2px/派生抑制，README 明确说 0.3 的 10 s 宽限会吞掉真人输入） |
| `content/cooperation.js` | 477 | 21,441 | 页内输入锁/协作抑制（点击滚动拦截、暂停开关） | SW:`bb.cooperation.*`、`bb.takeover.*` | 不移植（0.4 `packages/collaboration` 已重做 authority/passthrough） |
| `content/record-capture.js` | 618 | 23,254 | 常驻操作记录采集器（document_start、all_frames、flush 队列） | SW:`bb.ops.event`、`bb.record.*`；M:`record.start/stop` | 不移植（0.4 `record.*` 在 daemon 侧，B2 只评估其元素定位/去抖逻辑） |

#### G. 注入库（仅评估，2）

| 文件 | 行 | 字节 | 职责 | 0.3 耦合 | 分类 |
| --- | ---: | ---: | --- | --- | --- |
| `injected/page-lib.js`（+ `parts/*.part` 26 块） | 4,158 | 180,712 | ISOLATED world 页内能力库：§A 状态/代数、§B 工具、§C VOM/视觉扫描/命中/对比度、§D 解析、§E 动作、§F 视觉/等待、§G 签名/读取、§H 提取、§I 指针/拖拽/滚轮/上传/fetch、§J `handle()` 分派（约 45 个页内方法）+ `installHumanWatchers`；`LIB_VERSION 53`，经 `chrome.scripting.executeScript(files)` 按需补注入 | 由 `src/inject.js` 的 `pageCallFunc` 调 `globalThis.__BB_PAGE__.handle(name,args)`；`installHumanWatchers` 直接 `chrome.runtime.sendMessage('bb.human.input')` | 不移植（整包）。0.4 已有 `packages/vom`（4,389 行）+ `browser-adapter`（16,557 行 CDP 面）覆盖同一职责；**只提取「快路径」算法**，见 §5.B2 |
| `injected/main-console.js` | 162 | 6,377 | 主世界 fetch/XHR/console 钩子 | 与 SW `bb.record` 事件配合 | 不移植（0.4 走 CDP `Runtime`/`Network`） |

构建工具与清单（任务第 3 点 B3 的输入）：

| 文件 | 行 | 字节 | 职责 | 分类 |
| --- | ---: | ---: | --- | --- |
| `extension/manifest.json` | 100 | 2,127 | MV3 清单：14 permissions、4 content scripts、popup/options/图标 | 需重写（给 0.4 ingress 加 `action`/`options_ui`/图标，权限只留 `tabs/windows/storage/alarms/scripting/tabGroups/notifications`） |
| `tools/build-extension.mjs` | 129 | 5,336 | `Compress-Archive` 打包 zip + 校验必需条目 + 更新 `release.json`/`SHA256SUMS` + 剔除 reference-only + 失效旧签名 | 需重写（0.4 已有 `0.4/scripts/build-extension-ingress.mjs`：staging + `config.json` + 目录白名单；缺签名/发布账本与 UI 产物校验） |
| `tools/build-page-lib.mjs` | 28 | 1,389 | `injected/parts/*.part` 按序合并 + `--check` | 直接沿用模式（B2 若拆 0.4 页内库可复用） |

### 3.2 分类统计（51 文件 / 15,398 行 / 713,127 B）

| 分类 | 文件数 | 行数 | 字节 | 代表项 |
| --- | ---: | ---: | ---: | --- |
| 可直接移植 | 14 | 4,829 | 243,247 | `locales.js`、`overlay-locales/theme/texts`、`ui.css`、`popup.css`、`common.js`、`tab-picker.js` |
| 小改可移植 | 15 | 3,025 | 155,320 | `popup.*`、`i18n.js`、`options.*`、`overlay-ui.js`（借用 2 函数）、`borrow-ui.js`、`action-notifications.js` |
| 需重写 | 7 | 611 | 22,280 | `takeover.js`、`human-state.js`、`settings.js`、`ui/audit.*`、`manifest.json`、`tools/build-extension.mjs` |
| 不移植 | 15 | 6,933 | 292,280 | `page-lib.js`、`main-console.js`、3 个 content script、`ui/debug*`、`ui/record*`、`ui/ops*`、4 个 panel |
| **合计** | **51** | **15,398** | **713,127** | — |

### 3.3 关键判定理由（只写有争议的）

1. **`ui/locales.js` 判「直接移植」但需决策**：它是 12 语言里 11 个的唯一来源（`zh` 是源串），删掉等于砍掉全部非中文 UI；保留就是 168 KB（原始）／约 +30–40 KB（zip 压缩后估算）。0.3 的 `docs/I18N-COVERAGE.md` 显示 10 个页面的静态中文 0 缺失，`tests/unit/locale-pack.test.mjs` + `i18n-coverage.test.mjs` 守住质量 → **建议保留，但改为「按需加载」（见 §6.3）**。
2. **`overlay-ui.js` 必须拆**：它是 4 个互不相干的注入函数塞在一个 760 行文件里。`borrowBanner`（倒计时环、焦点陷阱、Esc、RTL、主题、12 语言）比 0.4 的 `borrow-confirm.js` 明显更强，是**真资产**；`installTakeover` 与 `helpOverlayFunc` 与 0.4 的 CDP 协作/帮助浮层职责重叠，硬搬会变成双写的第二套状态机。
3. **`popup.js` 判「小改」而非「重写」**：它的 629 行里约 300 行是纯 DOM 渲染（可留），真正的重写面是「状态来源 + 配对/协议偏差区块 + 5 个特性页入口」。`tests/unit/popup-dom.test.mjs`（59 行）已经把 DOM id 契约锁住，改动可机械验证。
4. **`page-lib.js` 判「不移植」而不是「需重写」**：0.4 的 `packages/vom`（21 文件 / 4,389 行）与 `browser-adapter`（16,557 行）已经是同职责的不同实现；它的价值是**具体算法**（unchanged 快路径、视觉命中、closed-shadow 穿透、grid 提取），而算法应在 0.4 包里重写，不是把 180 KB IIFE 搬进去。
5. **`content/human-watch.js` 判「不移植」有明确证据**：0.4 ingress README 第 150–153 行写着「派生事件抑制（不照抄 0.3 `human-watch.js` 的缺陷）：0.3 用 `data-bb-agent-input` 标记 + 10 秒宽限期，会把 10 秒内的真人输入全部吞掉」。这一条是 0.4 有意修正的行为，回退即回退 bug。
6. **`ui/record*`/`ui/ops*`/`ui/debug*` 判「不移植」**：它们依赖 0.3 manifest 独有权限（`tabCapture`/`offscreen`/`debugger`/`DNR`）。0.4 ingress 刻意不含这些权限（README §MV3 限制第 3 条）。相同功能在 0.4 是 **daemon 的 `video.*`/`record.*`/`debug.*`**，其 UI 归宿是 `0.4/dashboard`，不是扩展 popup。

---

## 4. 与 0.4 extension-ingress 的对接方案（任务第 2 点）

### 4.1 通道总览

```
0.3（冻结）                                    0.4（目标）
┌──────────────┐  bb.* (72 分派点)  ┌──────────────┐
│ ui/*.html/js │ ─────────────────► │  SW bridge   │
└──────────────┘                    │  MESSAGE_    │
        ▲                           │  HANDLERS    │
        │ bb.state                  └──────┬───────┘
        │                                    │ hello/call/res/event（自定义帧）
        │                             ┌──────▼───────┐
        │                             │ 0.3 daemon   │  126 扩展侧方法 + 44 local
        └─────────────────────────────┴──────────────┘

0.4（目标）                                   0.4 daemon
┌──────────────┐  ui.status/ui.settings  ┌──────────────────────┐
│ ui/popup etc │ ──────────────────────► │ ingress bridge (SW)  │
└──────────────┘ ◄────────────────────── │ createIngressBridge  │
        ▲            snapshot()          └───┬──────────────┬───┘
        │                                    │ JSON-RPC 2.0 │ extension.pull
        │ 轮询（无事件推送）                  │ (rpc-client) │ extension.complete
        │                              ┌─────▼──────────────▼─────┐
        └──────────────────────────────│ 0.4 daemon server.mjs    │
                                       │ + extension-ingress.mjs  │
                                       │ + browser-adapter (CDP)  │
                                       └──────────────────────────┘
```

要点：**0.4 的 SW 里没有「通用 call」通道**。`createIngressBridge` 只负责 register/pull/complete/event 与内容脚本消息（`bridge.handleContentMessage`）；`IngressRpcClient.call(method, params, {timeoutMs})` 存在（`src/rpc-client.js:192`）但没有对 UI 暴露。→ B1 必须在 SW 增量加一个**只读 `ui.*` 面**（§4.7）。

### 4.2 0.3 帧 → 0.4 帧映射

| 0.3（`src/ws-client.js`） | 0.4 去向 | 差异/风险 |
| --- | --- | --- |
| `hello {role, browser, browserVersion, extVersion, instanceId, browserId, protocol, capabilities, label, settings{borrowConfirm,allowHelp,pageGuard,controlHint,longShotMode}, userAgent, authChallenge, authKeyId, pairCode}`（`ws-client.js:301-323`） | `extension.register {instance_id, version, browser, capabilities}` + `?token=` | `label`/`settings`/`protocol`/配对码**全部没有对应字段**。settings 只能落在扩展本地（`bb04.*`）并自己消费；`protocol` 换成 `daemon_version` 回执 + `system.status.protocol_version` |
| `{type:'call', id, method, params}` / `{type:'res', id, ok, result|error}` | JSON-RPC 2.0 request/response（daemon 全方法白名单，`ws-transport.mjs:53`） | 0.3 是「daemon 主动下命令、扩展执行」；0.4 是「daemon 只下 6 个 `ext.*`」 |
| daemon→扩展 126 方法 | 仅 `ext.session_start/stop`、`ext.tab_borrow/return`、`ext.status`、`ext.arm_input` | 其余 120 方法在 0.4 由 CDP 执行，**不经过扩展** |
| `{type:'event', event:'human.input'|'human.blur', params:{tabId, at}}` | `extension.event {event:'human.input', params:{tab_id, frame_id, url, state, attribution, session_id?}}` | 0.4 带 frame/attribution/session 映射，语义强得多 |
| `{type:'event', event:'settings', params:{...}}` | 无 | 需要在扩展本地消化（或未来 `extension.event` 加 `settings` 事实） |
| `{type:'event', event:'takeover.state'/'takeover.hide'}`（daemon→扩展） | 无 | 0.4 的协作状态在 daemon 的 `packages/collaboration` + `cooperate.*` 面 |
| `{type:'event', event:'tab-removed'}` | `extension.event {event:'session.ended', params:{reason:'tab_closed'|'user_moved_tab'|'window_closed'}}`（`bridge.js:109-131`） | 0.4 自带 `LIFECYCLE_*` 监视器，含去重/抑制（`self_operation`） |
| `bb.operation.await/cancel`、`bb.dialog.*` | 无扩展侧 | 0.4 由 `browser-adapter` 的 `operation-handlers`/`dialog-handlers` 在 daemon |

### 4.3 popup 状态字段 → 0.4 来源（逐字段）

0.3 `popupState()`（`src/quick.js:146-191`）返回的字段与 0.4 的对应：

| popup 字段 | 0.3 来源 | 0.4 来源（B1 方案） | 备注 |
| --- | --- | --- | --- |
| `connected` / `connectionState` / `retryCount` / `lastError` | `BridgeSocket.getSnapshot()`（hello 后） | `bridge.snapshot()`：`state`/`connected`/`last_error`/`counters`（`0.4/extension-ingress/src/bridge.js`） | 直接可替换，`ws_url` 已打码 |
| `instanceId` | socket.instanceId | `snapshot().instance_id`（`bb04.ingress.instanceId` 持久化） | 语义一致 |
| `daemonVersion` / `cliVersion` | hello-ack | `snapshot().daemon_version` | 一致 |
| `port` | `socket.port`（默认 52900） | **无端口概念**（`ws_url` 自带端口） | popup 的「本机端口」输入框应删除 |
| `protocolSkew` / `protocol` | `protocol-version.js` 比对 hello-ack | 无协议版本协商，只有 `daemon_version` | **升级提示区块（含 `bridge update apply` 文案）需删除或重设计** |
| `localAuth`（verified/unpaired/pairing_required…） | 0.3 本地认证握手 | daemon `system.status.local_auth`（`server.mjs:2206`） | 可映射，但 0.3 的 6 位配对码流程在 0.4 是 `?token=`，无配对码 |
| `label` | `bb.settings.instanceLabel` | `bb04.ingress.label`（新增）或 `browser` 字段 | 需新增本地键；0.4 `register` 无 label 字段 |
| `sessions` / `tasks` | `chrome.storage.session['bb.controlledTabs']` | `system.status.sessions[]`（`session_id`/`agent_window_id`）∪ `ext.status.sessions`（借用明细，需 SW `ui.status` 转发） | **借用中的 tab 明细只在 `ext.status`**（`commands.js:846`） |
| `settings` | `bb.settings` | `bb04.*` + 扩展本地 settings（§4.8） | 见下 |
| `notifications` | `chrome.storage.local['bb.notifications']` | 同（本地铃铛，不依赖 daemon） | 可保留 |
| `extVersion` | `chrome.runtime.getManifest().version` | 同 | 一致 |

### 4.4 借用（borrow）状态与 UI 落点

0.3 链路：daemon `tab.borrow` → SW（`MESSAGE_HANDLERS` 之外，由 `src/tools/*` 里 `notifyActionRequest('borrow')` 分支）→ `injectBorrowModal`/`injectBorrowToast` → 页内 `borrowBanner`/`borrowToast` → `bb.borrow.decision` → `resolveHumanDecision` → 回 daemon 结果。

0.4 链路（已实现）：daemon `tab.borrow` → `extensionClient.tabBorrow` → `ext.tab_borrow` → `src/borrow.js`（快照/回滚/保真）→ `borrowConfirm:'always'` 时注入 `content/borrow-confirm.js` 或 `chrome.notifications` → 决策回 SW → `extension.complete` 结果 `{tab_id, original_window_id, original_index, agent_window_id}` + 附加字段（`confirm_surface`、`snapshot_degraded`、`pinned`、`group_restored`…）。

**移植建议（B1.5）**：把 0.3 的**视觉与交互**搬进 0.4 的确认面，而不是把 0.3 的注入通道搬过来：

1. 目标 tab 是活动 tab：用 0.3 `borrowBanner` 的渲染逻辑（倒计时环、焦点陷阱、Esc、RTL、`overlayTexts(lang)` 12 语言）替换 `content/borrow-confirm.js` 的卡片体；保留 0.4 的 **shadow DOM 隔离 + `sendResponse` 决策协议 + 60s 超时 + fail-closed**。
2. 目标 tab 非活动：0.3 的 `borrowToast`（在活动 tab 上显示、不抢前台）可以作为 0.4「通知兜底」的补充通道；但 0.4 目前用 `chrome.notifications`（系统通知），二者可并存，优先级 = 页内 toast > 系统通知。
3. `rehomeBorrowUi`（modal↔toast 跟随活动 tab，`borrow-ui.js:95-123`）是 0.3 的**真实用户价值**（用户切 tab 后确认条不丢），0.4 现在是「不活动 tab → 通知」，没有重定位。**建议移植**（监听 `tabs.onActivated`，0.4 `bridge.js` 已有 `onActivated` 相关注册点可挂）。
4. 主题：0.4 的确认条是**硬编码深色渐变**，0.3 的 `OVERLAY_THEME`（18 token × light/dark，WCAG AA 测试）应成为 0.4 唯一 token 源。

### 4.5 human（人类输入）状态来源

| 层 | 0.3 | 0.4 |
| --- | --- | --- |
| 页内检测 | `content/human-watch.js`（95 行）+ `page-lib` `installHumanWatchers`（重复实现） | `content/human-watch.js`（511 行）：arm 期望匹配、`isTrusted`、节流 100 ms、派生事件 50/250 ms 窗 |
| 期望下发 | 无（只有 `data-bb-agent-input` 属性 + 10 s 宽限） | `ext.arm_input` → `tabs.sendMessage(所有 frame)`（`commands.js:877+`） |
| 上报 | `bb.human.input`/`bb.human.activity` → SW → daemon `event human.input {tabId}` | `human.input` → SW 200 ms 去重 → `extension.event`（含 `state`/`attribution`/`session_id`） |
| daemon 消费 | SW 侧 `isAgentInputWindow` 过滤后转发 | daemon `onExtensionEvent('human.input')` → 暂停协作面；`system.status.extension.human_events` 计数 |
| UI 表现 | `takeover` 模式切到 `human`/`editing`；`cooperation` 输入锁 | 0.4 cooperation overlay 的 mode `human`（`cooperate-handlers.js`）+ `session.interaction_changed` |

结论：**popup 不需要自己算 human 状态**。B1 只在 popup 显示「人类输入累计 / 最近一次」时可读 `system.status.extension.human_events/last_event`，或读 `bridge.snapshot().counters.human_*`。

### 4.6 165 方法替换矩阵（哪些 0.3 依赖必须换掉）

> 数字口径：`docs/PROTOCOL-METHODS.md` 现有 **170** 行（44 local + 109 session + 17 instance）；`docs/0.4-ARCHITECTURE-PLAN.md` 记的 canonical 是 **165**。扩展侧服务的是 **126**（109 + 17）。

| 0.3 方法族 | 0.3 用途 | 0.4 替代 | 影响到的 UI 资产 | 状态 |
| --- | --- | --- | --- | --- |
| `session.start` / `start_tracked` / `stop` / `stop_all` / `list` / `run_log` / `request_*` | 会话生命周期 | 0.4 同名 + `session.open/close/recover/list`；会话窗口靠 `ext.session_start/stop` | 无（popup 不建会话） | ✅ 有替代 |
| `tab.borrow` / `tab.return` | 借/还用户 tab | `ext.tab_borrow` / `ext.tab_return`（+ 确认面） | `borrow-ui.js`、`overlay-ui.js` 借用 2 函数、`human-decisions.js` | ✅ 有替代（形态不同） |
| `tab.list` / `tab.new` / `tab.close` / `tab.select` / `tab.alias` / `tab.policy` / `tab.move` / `tab.cleanup` | tab 管理 | 0.4 只有 `tab.list` / `tab.create` / `tab.close`；**`tab.move`/`tab.select`/`tab.alias`/`tab.policy` 无对应** | `ui/tab-picker.js`、popup 任务列表 | ⚠️ 部分缺口 |
| `window.list` / `focus` / `newAgent` / `ensureAgent` / `close` / `resize` | 窗口管理 | `session.open`（建 Agent Window）+ `ext.status.windows`；`window.focus`/`window.list` 无对应 | popup 无直接依赖 | ⚠️ 部分缺口 |
| `status` / `view` / `browsers` | 状态快照 | `system.status` / `daemon.status` / `browser.list` | popup 全部状态 | ✅ 有替代（形状不同） |
| `settings.get` / `settings.set` | 扩展设置 | **0.4 无对应方法**；`config.json` + `bb04.ingress.*` 是唯一配置面 | `ui/options.*`、`src/settings.js` | ❌ 缺口（靠本地模型） |
| `pair.*` / `local.pair` / `local.trust` | 配对/凭据 | 0.4 `?token=` + `config.json`（构建时写入）+ dashboard `--auth-token` | popup 配对区（`pairSave`/`pairLink`/`pairCode`/设备列表） | ❌ 语义不兼容，删 |
| `control-hint` / `diagnostics.ui` | 控制提示开关/诊断 | 0.4 无；浮层由 `cooperate.*` 的状态驱动 | `takeover.js`、`overlay-suppress.js` | ❌ 缺口 |
| `observe` / `snapshot` / `read` / `extract*` / `screenshot*` / `get-html` / `evaluate` / `actionable` | 页面读/截图 | 0.4 daemon CDP（`browser-adapter` + `vom`）；扩展不参与 | `ui/longshot*`、`ui/debug*` | ✅ 有替代（通道不同） |
| `click`/`fill`/`press`/`hover`/`select`/`focus`/`blur`/`scroll-to`/`drag`/`wheel`/`upload`/`download`/`navigate*`/`reload`/`press`/`shadow.*` | 动作 | 0.4 `act` + `dispatch-handlers`（CDP） | 无（popup 不做动作） | ✅ 有替代 |
| `debug.*`（28 个） | 网站调试 | 0.4 `debug.start/stop/status/query/export`（daemon） | `ui/debug.*`、`ui/panels/debug-panel.js` | ✅ 有替代（UI 归 dashboard） |
| `record.*` / `video.*` / `trace.*` | 录制/视频 | 0.4 `record.*`、`video.*`（daemon） | `ui/record.*`、`ui/ops.*`、2 个 panel | ✅ 有替代（UI 归 dashboard） |
| `network.*` / `console` / `pdf` / `emulate` / `refs.negotiate` / `webmcp.*` / `wait-*` | 读/等待/模拟 | 0.4 CDP 面（`network-*`、`emulate-*`、`wait-probe`） | `ui/debug.*`（网络） | ✅ 有替代 |
| `request-help` / `cooperate.*` | 人工协助/协作 | 0.4 `request_help`（`help-handlers.js`）+ `cooperate.*` | `overlay-ui.js` 的 `helpOverlayFunc`、`action-notifications.js` | ✅ 有替代（浮层已重做） |
| `audit.list` / `ledger.*` / `operations.*` | 审计/账本 | 0.4 `audit.request` / `ledger.list/pending/resolve` / `transfer.*` | `ui/audit.*`、`ui/panels/audit-panel.js` | ✅ 有替代（形状不同，需重写 UI） |
| `dialog.*` | 原生对话框 | 0.4 `dialog-handlers`（daemon） | 无 popup 依赖 | ✅ 有替代 |
| `ui.open` / `command.cancel` / `daemon.stop` / `inflight.list` | 本地运维 | 0.4 无 `ui.open`；`daemon.status`/`system.status` 覆盖只读部分 | 无 | ⚠️ 部分缺口 |

**替换要点（给实现者的硬约束）**：

1. UI **不许**再引用 `bb.daemon.call`（0.3 的通用 passthrough，`bridge.js:485`）。0.4 WS token 是 daemon 全权凭据，popup 一旦有通用 call，扩展页面的任何 XSS 就能 `session.start`/`transfer.*`。
2. UI **不许**假设「方法会由扩展执行」。0.4 的扩展只执行 6 个 `ext.*`，页面动作发生在 daemon 的 CDP 侧；UI 若需要「动作结果」应读 `session.run_log` / `ledger.*`，不是等扩展回执。

### 4.7 `ui.*` 面的现状与缺口（属 `0.4/extension-ingress/**` 写域，不在本任务）

**现状（已落地，2026-11-24 17:5x）**：`ui.status` 已存在且是 popup/options 的唯一状态面——

- `src/bridge.js:42` `UI_STATUS_MESSAGE_KIND = 'ui.status'`、`:44` `UI_STATUS_VERSION`；
- `:1746` `buildUiStatus()`、`:1778` `handleUiMessage(message)`、`:1875` `createUiMessageListener`；
- `:1963-1975` 顶层 `runtime.onMessage` 按 `message.kind` 分流：`ui.status` 只读内存/`storage.session`，**不进 pull 循环、不触发重连**（`test/ui.test.mjs` 断言 `counters.pulls === 0`）；
- 内容脚本的 `human.input` 分支不被抢占（同文件 `createContentMessageListener`）。

**缺口**（B1 需要补的，仍然只读）：

| 消息 | 现状 | 建议 |
| --- | --- | --- |
| `ui.status` | ✅ 已实现（bridge 快照 + 人类三态 + 会话） | 保持不变；可加 `ingress.session` 借用明细（`ext.status` 缓存），若不想加就维持现状 |
| `ui.settings.get` | ❌ 只有 `bb04.ui.*` 三个 UI 偏好（`ui/settings.js`），**没有 ingress 配置的只读视图** | 新增只读：返回 `{wsUrl(打码), instanceId, borrowConfirm, pullWaitMs, reconnectMs}`（读 `config.json` + `config.js` 的 `loadConfig`） |
| `ui.settings.set` | ❌ 无（options 只写 `bb04.ui.*`） | 若要暴露 `borrowConfirm` 开关：只允许 `always|never` 两值，写 `bb04.ingress.borrowConfirm` 后由 bridge 重连生效；**禁止**改 `token`/`wsUrl` |
| `ui.diagnose` | ✅ 部分（`buildDiagnosticsText` 在 popup.js，复制诊断信息） | 保持 |
| 通用 RPC passthrough | ❌ 不存在（**这是对的**） | 不要加。只读白名单仅限 `system.status`/`daemon.status`/`session.list`/`browser.list`/`ledger.list`，且只给 SW 内部用 |

**安全边界**（不变）：`ui.*` 是扩展页面 ↔ SW 的 `chrome.runtime` 消息，不直接连 daemon；WS token 永远不出 SW。popup 不显示 token 明文。

### 4.8 配置 / 存储键 / 权限映射

| 0.3 | 0.4 目标 | 说明 |
| --- | --- | --- |
| `chrome.storage.local['bb.settings']`（14 字段，`src/settings.js:7-20`） | `config.json {wsUrl, token, instanceId, borrowConfirm}`（构建时）+ `chrome.storage.local['bb04.ingress.*']`（运行期覆盖） | 0.4 `src/config.js` 只认 `wsUrl/token/borrowConfirm/instanceId` |
| `bb.uiLang` | `bb04.uiLang` | i18n 键前缀迁移 |
| `bb.notifications` | `bb04.notifications` | 本地铃铛 |
| `bb.agentWindowIds`（`transfer.session`） | 无（0.4 `sessions.js` 的 `bb04.ingress.sessions`） | takeover 状态源改读 0.4 sessions |
| `bb.controlledTabs` | `bb04.ingress.sessions[].borrowed[]` + `borrowSnapshots` | 借用明细 |
| borrowConfirm: `true/false` | `'always' / 'never'` | **语义升级**：`always` 是 fail-closed（无确认面就拒绝），不是「弹个条」 |
| allowHelp: `true/false` | 环境变量 `BSK_REQUEST_HELP=off` 或 `request_help({enabled:false})` | 没有扩展侧开关，只有 daemon 侧 |
| pageGuard: `true` | 0.4 ingress **已内置** tab 路由（`createTabRouter`，`session.tab_observed`/`tab_released`，含 250 ms/1 s/3 s 重试） | 不需要 UI 开关；若要保留，需新增本地开关禁用 router |
| cooperationGuard / controlHint | 无对应 | 0.4 协作面 `cooperate.enable/status` 在 daemon；overlay 由 collaboration 状态驱动 |
| 端口 52900–52909 / 配对码 | `ws://host:port/ws?token=` | UI 输入框从「端口」改为「WS URL + token」或完全由构建期 `config.json` 供给 |
| permissions 14 项 | 7 项（+ 若要 popup：`action` 无需权限） | **popup/options 不需要新权限**：tabs/windows/storage/notifications 已有；`captureVisibleTab`（preview 页）靠 `<all_urls>` host 权限 |

### 4.9 安全边界（必须在 B1 设计里写死）

1. **token 是 daemon 全权凭据**：`ws-transport.mjs` 的认证是「Bearer / 子协议 / `?token=`」三通道，认证后可用 **全部** 方法（与 HTTP 同一 allowlist）。扩展页面里持有 token 的上下文一旦被注入脚本利用，等于拿到控制面。
2. 因此：`ui.*` 面**只读白名单**；`ui.settings.set` 只允许 `borrowConfirm`；**绝不**把 `bb.daemon.call` 式通用透传搬进 0.4（0.3 里它存在，`bridge.js:485`，是 0.4 不应继承的设计）。
3. 借用确认的决策通道必须保持 fail-closed：页内无回执 / 通知被勿扰吞掉 / 页面受限 → 拒绝，不伪造 allow（0.4 已实现，移植 UI 时不要破坏）。
4. popup 不显示 token 明文（`config.json` 读取即打码，沿用 `bridge.snapshot().ws_url` 的 redact 做法）。

---

## 5. 分阶段清单（任务第 3 点）

总原则：**B1 只做「浏览器侧 UI 面」，B2 只做「页内能力评估/快路径迁移」，B3 才碰发布链**。每个阶段都必须是「可单独合入、可单独回滚」。

### B1 —— UI / popup / options / overlay / i18n

> 写域：`0.4/extension-ingress/**`（`ui/**` 增量、`src/bridge.js` 的 `ui.*` 面、manifest、`content/borrow-confirm.js` 内改）。**B1 不改 0.3**。

**B1 现状对齐（以 2026-11-24 17:56 的 `0.4/extension-ingress` 为准）**：

| 本计划项 | 现状 | 动作 |
| --- | --- | --- |
| B1.1 共享层（i18n/direction/theme/locales） | ❌ 未落地（0.4 无 i18n/locales/direction） | **要做**（本阶段核心增量） |
| B1.2 popup 骨架 | ✅ 已由 G4 落地（`ui/popup.*`，`ui.status` 驱动） | 改为「验收 + 补借用/设置卡」，不重写 |
| B1.3 `ui.*` SW 面 | 🟡 `ui.status` 已落地；`ui.settings.get/set`、只读白名单缺失 | 增量补，不改已有 `ui.status` 契约 |
| B1.4 popup 状态接线 | ✅ 已接 `ui.status`（不是本计划设想的 `rpc.call('system.status')`） | 保留 G4 的只读设计（更安全），只在需要会话/借用明细时再议 |
| B1.5 options 页 | 🟡 已落地（3 个 UI 偏好键），**缺 ingress 偏好与语言/主题** | 增量加设置项，键沿用 `bb04.ui.*` |
| B1.6 i18n 全量 | ❌ 未落地 | 要做 |
| B1.7 借用确认视觉移植 | ❌ 未落地（`borrow-confirm.js` 仍是原版） | 要做 |
| B1.8 借用 toast/重定位 | ❌ 未落地 | 要做 |

| # | 任务 | 改动 | 验收（真实 Edge E2E 或 DOM 断言） |
| --- | --- | --- | --- |
| B1.1 | 迁移共享层 | 复制 0.3 的 `ui/common.js`、`direction.js`、`ui.css`、`popup.css`、`tab-picker.js` → `0.4/extension-ingress/ui/`（避免覆盖 G4 的 `popup.css`/`options.css`，用 `ui/bb-shared.css` + `ui/direction.js` 形式）；`i18n.js` 键改 `bb04.uiLang`；`overlay-theme.js`/`overlay-texts.js`/`overlay-locales.js` 作为 `ui/overlay-*` 落地 | `node --test 0.4/extension-ingress/test/ui-i18n.test.mjs`（新）：断言 `loadLang()` 读 `bb04.uiLang`、`translate('已连接')==='Connected'`、`dir` 首帧正确；`node 0.4/extension-ingress/test/ui.test.mjs` 仍 23/23 绿（不回归 G4）；真实 Edge：popup `?lang=ja` 日文、`?lang=ar` 时 `dir=rtl` |
| B1.2 | popup 骨架（验收 + 补卡） | **保留 G4 的 `ui/popup.*`**；增量补两张卡/一节：① 借用确认策略状态（读 `ui.settings.get`）；② 实例名与 daemon 版本（已有 `#bb-connection-details` 可扩）；③ 「打开 dashboard」链接。**不重写、不替换 DOM id**（`#bb-popup`/`#bb-connection-state`/`#bb-human-state`/`#bb-sessions`/`#bb-refresh`/`#bb-copy`/`#bb-options` 是 `test/ui.test.mjs` 的契约） | `node --test 0.4/extension-ingress/test/ui.test.mjs`（既有 23 条）全绿；新增断言：popup 渲染出借用策略卡、点「设置」`chrome.runtime.openOptionsPage` 被调 1 次；真实 Edge（headed）：`session.open` 后「活动会话」出现 1 条，关闭后回空态 |
| B1.3 | `ui.*` SW 面补全 | 在 `src/bridge.js` 已有 `handleUiMessage` 上增量：`ui.settings.get`（只读 ingress 配置，token 打码）、`ui.settings.set`（**仅** `borrowConfirm: 'always'|'never'`）；只读 RPC 白名单硬编码在 `ui-bridge` 内 | `node --test 0.4/extension-ingress/test/ui.test.mjs` 增断言：`ui.settings.set({token:'x'})` → `ok:false, code:'E_UI_SETTINGS_READONLY'`；白名单外方法不可达；`counters.pulls` 仍为 0；`node 0.4/extension-ingress/test/smoke.mjs` 全绿 |
| B1.4 | popup 状态扩展（可选） | 仅在需要「借用中 tab 明细」时，由 SW 读 `ext.status` 缓存进 `ui.status`；否则保持 G4 现状 | 真实 Edge E2E：`tab.borrow` 期间 popup 显示借用 tab 标题（若做）；不做则断言「popup 无借用明细」属预期（记录在 README） |
| B1.5 | options 增量 | 在 G4 的 `ui/options.*` 上增：UI 语言选择（`bb04.uiLang`）、借用确认策略（`always/never`，带 fail-closed 说明）、长截图模式（沿用 0.3 `longShotMode`）；保留 `refreshMs/diagnosticLevel/showTechnical` | `node --test 0.4/extension-ingress/test/ui.test.mjs` 增断言：改语言写 `bb04.uiLang` 且 `location.reload`；`borrowConfirm=never` 时弹 `role=alertdialog` 二次确认；真实 Edge：保存后重开 options 值保持 |
| B1.6 | i18n 全量 | `locales.js` + `i18n.js`（25 万字符）随包发布；补 `0.4/scripts/i18n-coverage.mjs` 复用 0.3 `tools/i18n-coverage-report.mjs` 的口径 | `node 0.4/scripts/i18n-coverage.mjs --check`：10 个页面静态中文缺失 = 0；真实 Edge：`popup.html?lang=ja` 标题/按钮日文，`?lang=ar` 时 `dir=rtl` |
| B1.7 | 借用确认视觉移植 | `content/borrow-confirm.js` 换 0.3 `borrowBanner` 渲染体（倒计时环/焦点陷阱/Esc/RTL/`overlayTexts` 12 语言）+ `OVERLAY_THEME` token；保留 0.4 shadow DOM + `sendResponse` 协议 + 60 s 超时 | `node 0.4/extension-ingress/test/smoke.mjs` 的 A3a 段必须全绿（allow/deny/timeout/dismiss/受限页 fail-closed）；新增 DOM 断言（复用 `0.3/tools/lib/overlay-dom-harness.mjs` 模式）：`borrowBanner` 在真实 Chromium 里渲染出 `[data-allow]`/`[data-deny]`/`[data-ring]`，倒计时文本随语言变化，Esc = deny |
| B1.8 | 借用 toast/重定位 | 移植 `borrow-ui.js` 的 `rehomeBorrowUi`（`tabs.onActivated`）+ `borrowToast` 作为「非活动 tab」的页内通道（系统通知降为兜底） | 真实 headed Edge E2E：借 A tab（A 不活动）→ 系统通知出现；切到 A → 页内 toast/modal 出现；再切走 → toast 回活动 tab；全程 `ext.tab_borrow` 的回执 `confirm_surface` 与会话状态一致；拒绝/超时后 tab **未移动**（读 `chrome.tabs` 真实坐标） |

B1 的**硬性顺序**：B1.1 → B1.3 →（B1.2 || B1.6）→ B1.4/B1.5 → B1.7 → B1.8。B1.7/B1.8 依赖 `src/borrow.js` 的确认通道，不要先改 UI 再改通道。

### B2 —— page-lib 快路径 / capture / HAR

> 结论先说：**page-lib 不整体移植**（0.4 `packages/vom` + `browser-adapter` 已覆盖），B2 是「按需提取算法 + 把 capture 面接进 0.4」。写域：`0.4/packages/{vom,browser-adapter}/**`（+ 测试），**不碰 0.3**。

| # | 任务 | 评估结论 / 改动 | 验收 |
| --- | --- | --- | --- |
| B2.1 | 快路径对齐审计 | 逐条比对 page-lib 的 §A mutation tracker/`unchanged` 快路径、§C 视觉扫描/`hitAt`、§D 阻塞层/增量观察、§H grid/table 提取 与 0.4 `vom`（funnel/layers/active-region/table-fold/render）| 产出 `0.4/docs/VOM-FASTPATH-PARITY.md`（新）：每条快路径标注「已有/缺失/语义不同」，并给出 0.3 侧对应行号；**不写代码的审计也算验收**（评审通过） |
| B2.2 | 缺失快路径移植 | 只移植 B2.1 判定「缺失且有收益」的算法（预期：closed-shadow 穿透、`hitAt` 命中校验、`rowAnchors` 虚拟行守卫），实现为 `0.4/packages/vom/src/*.js` 的新模块 | `node --test 0.4/packages/vom/test/*.test.mjs` 新增断言 ≥ 每条路径 3 条；真实 Edge：`0.4/fixtures/observe-vom-real.json` 对新模块的输出与 0.3 夹具对拍（差异必须解释） |
| B2.3 | capture 面（截图/长截图） | 0.4 截图走 CDP（`browser-adapter/src/screenshot.js`）；把 0.3 `ui/longshot*` 的「预览/保存/拼接计划」（`longshot-render.js` 的 `planStitch`、`longshot-store.js`、`capture-manifest.js`）评估为 dashboard 侧复用 | `node --test 0.4/dashboard/test/longshot.test.mjs`（新，DOM/纯函数）：`planStitch` 对 3 张 / 8 张图的重叠裁剪结果与 0.3 `tests/unit` 对拍；真实 Edge：dashboard 上一键长截图 → 保存 PNG 尺寸 = 预期 |
| B2.4 | HAR / 网络取证 | 0.3 **没有 HAR 导出**（实证：`grep -i har extension/` 只命中 `character` 等假阳性）；0.3 的等价物是 `src/network.js`（≤500 条 entries + waterfall）+ `ui/debug.js` 的 JSON 导出。0.4 侧已有 `debug.export` + `network-*`，B2 只补「HAR 1.2 导出」作为 dashboard 的下载格式 | `node --test 0.4/packages/browser-adapter/test/har.test.mjs`（新）：给定固定 entries → 输出符合 HAR 1.2（`log.version/log.entries[].request/response/timings`）；真实 Edge：`debug.start → 请求若干页 → debug.export --format har` 可被 Chrome DevTools 的 HAR 导入器解析（手工 + 断言 JSON schema） |
| B2.5 | 体积回归守门 | page-lib 180 KB 不进 0.4；给 0.4 新增代码设预算 | `node 0.4/scripts/budget-check.mjs` 全绿；`node tools/build-page-lib.mjs --check` 仍绿（0.3 冻结侧不变） |

### B3 —— 发布工具

> 写域：`tools/**`（0.3 仓库）或 `0.4/scripts/**`（二选一，建议 0.4 侧新增，0.3 侧只读）。

| # | 任务 | 改动 | 验收 |
| --- | --- | --- | --- |
| B3.1 | 0.4 扩展打包器补全 | 在 `0.4/scripts/build-extension-ingress.mjs` 的 `RUNTIME_ENTRIES` 加 `content`（**README 第 40–43 行已标记这是必须的集成事项**，否则 Edge 因缺内容脚本拒绝加载）与新增 `ui/`、`icons/`；产物校验清单加 `ui/popup.html`、`ui/options.html`、`content/human-watch.js`、`content/borrow-confirm.js` | `node 0.4/scripts/build-extension-ingress.mjs --ws-url ws://127.0.0.1:52910/ws --json` 输出 files 含上述条目；`node 0.4/tests/extension-ingress-e2e.mjs` 用该 staging 真实加载成功（headed） |
| B3.2 | 发布账本/校验和 | 0.3 `tools/build-extension.mjs` 的 `release.json` + `SHA256SUMS` + 旧签名失效逻辑迁到 0.4 侧（0.4 目前只有 staging，无账本） | `node 0.4/scripts/build-extension-ingress.mjs --release --json` → `0.4/dist-*/release.json` 含 `{name,bytes,sha256}` 且 `sha256` 与 `tar -tf` 后独立计算一致；篡改 zip 1 字节 → 校验失败 |
| B3.3 | 打包前门禁 | 断言 `0.4/dist-*` 里**不出现** `docs/MERGE-0.3-0.4.md`、不出现 0.3 `extension/` 任何文件、不出现 `test/` | `node 0.4/scripts/stage-gate.mjs` 全绿（含 `source guard` / `scale` / `schema` 步骤）；失败用例：手动把一个 `docs/` 文件塞进 staging → 构建拒绝 |
| B3.4 | 真实 Edge 验收矩阵 | 把 B1 的 E2E 挂到 `0.4/scripts/stage-gate.mjs --with-extension`（现有两个 opt-in 步骤：`extension ingress`、`cooperate attribution`），新增 `ui popup` 步骤 | `node 0.4/scripts/stage-gate.mjs --with-extension` 全部步骤 PASS，且输出报告里 popup 步骤的断言条数 ≥ 15 |
| B3.5 | UI 截图/按钮审计（可选） | 0.3 的 `tools/ui-shot.mjs`、`tools/ui-button-audit.mjs`、`tools/overlay-dom-selftest.mjs` 迁到 0.4 做视觉回归 | `node 0.4/scripts/ui-shot.mjs` 生成 popup/options/overlay 三张 PNG（人工比对基线）；`node 0.4/scripts/ui-button-audit.mjs` 报 0 个无名字按钮 |

---

## 6. 体积 / 维护风险（任务第 4 点）

### 6.1 体积现状与预算

| 项 | 0.3 现状 | 若 B1 全量搬入 0.4（估算） | 备注 |
| --- | ---: | ---: | --- |
| `ui/locales.js` | 168,119 B（23.6% 本轮盘点体积） | 168 KB 原始 / **+30–40 KB zip**（估算） | 11 种语言 × 251 串；不压缩的话占 popup 包一半 |
| `injected/page-lib.js` | 180,712 B（25.3%） | **0**（不移植） | 保持 0.4 的 `packages/vom` + CDP |
| overlay 家族（7 文件） | 86,592 B（`overlay-ui` 44,887 + locales 33,646 + theme 3,357 + texts 1,855 + controller 2,175 + state 942 + suppress 2,740） | 约 +45–60 KB zip（`overlay-ui` 只留借用 2 函数后可减约 30%） | 0.3 的 overlay 45 KB 是任务点名的风险项 |
| `ui/**` 其余 | 361,959 − 168,119 = 193,840 B | 裁剪掉 debug/record/ops/audit/panels 后剩约 60–70 KB | 特性页不搬 |
| 0.3 扩展 zip（整包） | 443,292 B | — | 6.1 MB 原始里 4.25 MB 是 `vendor/`（mediabunny + o200k），与 UI 无关 |
| 0.4 ingress 现状 | 623,231 B（其中 `test/` 占 257,844 B = 41%；`ui/` 49,531 B 是 17:5x 并发新增） | B1 全量后估算 700–800 KB（+`ui/locales.js` 168 KB 原始） | 运行时 zip 预计 200–260 KB |

### 6.2 风险清单（按严重度）

| # | 风险 | 证据 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| R1 | **两套浮层打架** | 0.3 `overlay-ui.js`（executeScript 注入 light DOM）vs 0.4 `overlay-render.js`（CDP shadow DOM，host id `bridgedeck-overlay`/`bridgedeck-help-overlay`） | 同一页面出现两个状态条；用户点错；截图重复 | B1 明确分工：**页内状态/协作/帮助 = 0.4 CDP 浮层**；**借用确认 = 扩展注入**（唯一例外，因为要在移动 tab 前拿到真人决策）。移植前先写一张「谁画什么」的表并评审 |
| R2 | i18n 168 KB 常驻内存 | `locales.js` 3268 行，`i18n.js:1` 顶层 import | popup 打开慢、内存高（尤其移动端） | 改按语言动态 `import()`（`ui/locales/${lang}.js`），zh 走内联默认；`i18n-coverage` 门禁保留 |
| R3 | popup 状态字段语义漂移 | 0.3 `protocolSkew`/`localAuth`/`port` 在 0.4 无对应（§4.3） | 显示「已连接 · 未配对」等误导文案 | B1.2 删字段 + 门禁断言「不存在 0.3 文案 key」（`grep -n '未配对\|协议偏差' 0.4/extension-ingress/ui/` 应为空） |
| R4 | borrowConfirm 语义升级 | 0.3 `true/false`（弹条与否）vs 0.4 `always/never`（fail-closed 与否） | 用户以为「关了确认=更顺手」，实际 `never` 是无人值守语义 | options 文案改写 + popup 开关加 `title` 解释；禁止把 `never` 设为默认 |
| R5 | **`page-lib` 单文件 IIFE 与 0.4 多模块** | 0.3 `build-page-lib.mjs` 合并 26 块成单文件；0.4 `vom` 是 ESM 包 | 若直接把 page-lib 塞进 0.4 会形成第二套页内能力，且无法 tree-shake | 坚持 §5.B2：只提算法，不搬文件 |
| R6 | 0.4 无事件推送 | `ws-transport.mjs:302` 明确不支持 notification；`EVENT_KINDS` 只有定义 | popup 只能轮询，状态延迟 ≤ 2.5 s；`session.ended` 在 popup 上不可实时感知 | B1 用 2.5 s 轮询（与 0.3 一致）；把「事件推送」记为 0.4 后续任务（不在本计划承诺） |
| R7 | 0.3 UI→SW 契约不集中，已有死链 | `ui/debug.js:131` 调 `bb.call`，但 `bridge.js` 的 `MESSAGE_HANDLERS` **没有** `bb.call`（只有 `bb.daemon.call`）→ 永远 undefined；`bb.debug.start` 在 284–520 行**重复定义两次**（后者覆盖前者） | 移植时会把死链一起搬 | 0.4 侧新增 `0.4/scripts/ui-message-contract.mjs`：扫描 `ui/**` 的 `type:'bb.*'` 与 SW 注册表做集合差，**必须为空**才能构建 |
| R8 | 构建产物混入非运行时文件 | 0.3 `build-extension.mjs` 依赖 `tools/lib/extension-runtime.mjs` 的 reference-only 清单；0.4 只有 `RUNTIME_ENTRIES` 白名单 | 测试/文档被打进扩展 | B3.1 白名单 + B3.3 断言；本文档明确不进入 0.4 路径 |
| R9 | 权限面扩大 | 0.3 有 `debugger/tabCapture/offscreen/DNR`；搬 ui/debug、ui/record 会逼着加回这些权限 | 商店审核风险 + 用户信任 | 坚持 §3.3-6：这三页不搬；因此 popup 的「快捷功能」从 5 项减为 **1–2 项**（长截图/预览），其余指向 dashboard |
| R10 | 借用确认 UI 的可访问性回归 | 0.3 `borrowBanner` 有焦点陷阱/`aria-modal`/Esc/`previousFocus` 恢复；0.4 的 `borrow-confirm.js` 只有 `aria-label` | 屏幕阅读器/K 键盘用户无法确认或逃逸 | B1.7 验收必须含 a11y 断言（`role=dialog`、`aria-modal`、Esc=deny、焦点回到原节点） |
| R11 | i18n 与 overlay 语言包双份 | `ui/locales.js`（251 串 × 11）与 `overlay-locales.js`（54 键 × 12）是两套口径 | 同一句文案两处维护 | B1 只搬一次：页内浮层用 `overlay-*`，扩展页面用 `ui/locales`；在 README 写清边界 |
| R12 | 0.4 扩展 SW 生命周期 | MV3 30 s 空闲回收（0.4 README §MV3 限制 1） | popup 打开时 SW 可能刚被唤醒，`ui.status` 首次可能拿不到 daemon 数据 | `ui.status` 必须能「无 daemon 也返回 snapshot」，并给 popup 一个 ≤ 1 s 的 loading 态；E2E 覆盖「SW 冷启动后立刻打开 popup」 |
| R13 | **双 popup 风险**（并发任务） | 0.4 已有 G4 的原创 `ui/popup.*`（`ui.status` 驱动）；0.3 还有一套 popup 资产 | 若按「移植 0.3 popup」执行，会产出第二个 popup 或把 G4 的 DOM 契约撞坏（`test/ui.test.mjs` 23 条断言按 `#bb-*` id 写死） | **以 G4 为壳**（§2.5/§5 现状对齐表）；0.3 popup 只作为「信息层级/自测模式」的参考，不做文件级移植 |
| R14 | **0.4 popup 无 i18n**（已确认缺口） | `popup.html:2` `lang="zh-CN"`；`popup.js` 内联中文；无 `locales.js`/`i18n.js`/`direction.js` | 非中文用户体验回退到 0.3 之前；与 0.4 的 12 语言目标冲突 | B1.1/B1.6 补 i18n；验收要求 `?lang=ja/ar` 生效且 `dir` 正确；`tests/ui.test.mjs` 的「硬编码文案」断言需同步放宽/改造（不要为了过测试而保留硬编码） |
| R15 | 产品面合规门禁 | `0.4/scripts/product-compliance.mjs`：`extension-ingress/` 的 **HTML/CSS 全文 hard**，源码字符串含空白的散文 hard；禁词含 `ported-from`/`inspired-by`/`bsk-*` 等 | 移植 0.3 UI 时若在注释/文案里写「from 0.3 extension」之类来源说明，会触发 hard 失败 | 移植文件保留自有命名（`bb`/`bb04.`/`bb-*`）；不要在产品面写来源注记；B3 验收跑 `node 0.4/scripts/product-compliance.mjs --check` |

### 6.3 取舍建议（给 lead 的决策项）

1. **i18n 要不要全量？** 建议：**保留但按语言懒加载**。0.3 已证明 0 缺失、有测试；直接删会把 0.4 变成纯中文，回退 0.3 的国际化成果。若必须砍体积，第一刀砍 `ar/he`（RTL 两种），可省约 30 KB 原始。
2. **overlay 45 KB 要不要全搬？** 建议：**只搬借用 2 函数 + theme/texts/locales**（约 60% 体积），`installTakeover`/`helpOverlayFunc` 交给 0.4 的 CDP 浮层。这样既有「0.3 的好视觉」，又不引入第二套状态机。
3. **特性页（debug/record/ops/audit）要不要搬？** 建议：**都不搬**。它们依赖 0.3 独有权限，且 0.4 的对应能力在 daemon；搬 UI 不搬后端 = 死页面。用户需要的入口放 `0.4/dashboard`。
4. **popup 是否值得做？** 已经做了（G4 的 0.4 原创 `ui/popup.*`，583 行 + 23 条单测）。剩下要判断的是「**要不要往上加东西**」：建议只加 ① i18n（B1.1/B1.6）、② 借用确认策略状态（B1.3/B1.5）、③ 「打开 dashboard」入口；**不要再把 0.3 的 5 个特性页塞回 popup**。
5. **「复制启动命令」「升级命令」区块**：0.3 这两块依赖 0.3 CLI 文案（`bridge session start --browser`、`bridge update apply`），而 0.4 的 popup 目前没有这两块。若 B1.2/B1.5 决定加回，**先核对 0.4 CLI 实际命令**（`0.4/cli/bridge-remote.mjs`），不要给用户一条不存在的命令。

---

## 7. 开放问题（本任务无法只读解决，需 lead / 其它任务拍板）

| # | 问题 | 为什么需要决策 | 建议归属 |
| --- | --- | --- | --- |
| Q1 | 借用确认到底用**扩展注入**还是 **CDP 浮层**？ | 0.4 两种通道都在；这决定 `borrow-confirm.js` 是否继续存在、B1.7 是改它还是删它 | G2 + A3a 负责人 |
| Q2 | 0.4 要不要补 `settings.get/set` 或事件推送？ | popup 的实时性、跨实例一致性都依赖它；目前只能轮询 | 0.4 daemon 协议侧任务 |
| Q3 | `tab.move/tab.select/tab.alias/tab.policy`、`window.list/focus` 在 0.4 缺口是否补齐？ | 0.3 popup「任务列表点击聚焦」这类交互需要 | 0.4 协议/适配器任务 |
| Q4 | 0.4 dashboard 是否吸收 0.3 的 debug/record/ops UI？ | 决定 §6.3-3 的「不搬」是否最终成立 | 0.4 dashboard 负责人 |
| Q5 | popup 的 token 从哪来：构建期 `config.json` 还是用户手填？ | 影响 options 页设计与安全边界（§4.9） | G2 + 安全评审 |
| Q6 | 0.3 的 `ui/quick.html`（独立入口页）在 0.4 还要不要？ | 0.4 的 dashboard 已经能当「完整页」 | G2 |
| Q7 | G4 的 0.4 原创 popup 与 0.3 UI 资产的最终归属 | 已决定「G4 为壳、0.3 只补 i18n/借用视觉」吗？若未拍板，B1.1/B1.7 的实现落点会反复 | G2 + G4 + lead |
| Q8 | 0.4 popup 的中文硬编码要不要在 B1 一次清掉（改 key 化） | 改动面覆盖 `popup.js` 全部文案 + `ui.test.mjs` 的字符串断言；不清则 i18n 只能「半覆盖」 | G2 + G4 |

---

## 附录 A：验收命令速查（0.3 / 0.4 各自现成）

```powershell
# ── 0.3（冻结侧，只读运行，用于对拍） ─────────────────────────────
node --test tests/unit/overlay-*.test.mjs tests/unit/popup-dom.test.mjs tests/unit/locale-pack.test.mjs tests/unit/i18n-coverage.test.mjs
node tools/overlay-dom-selftest.mjs        # 真实 Chromium 内联浮层 DOM（借用/Help/Takeover/深色）
node tools/e2e.mjs                          # 真实 Edge 全量 E2E（含 popup selftest / a11y）
node tools/ui-shot.mjs                      # popup/options 截图
node tools/ui-button-audit.mjs              # 按钮可访问名审计
node tools/i18n-coverage-report.mjs         # 生成 docs/I18N-COVERAGE.md

# ── 0.4（目标侧） ────────────────────────────────────────────────
node --test 0.4/extension-ingress/test/ui.test.mjs   # G4 已落地：popup/options/ui.status/禁词/CSP/manifest（23 条）
node 0.4/extension-ingress/test/smoke.mjs   # fake chrome + 300+ 断言（含 A3a 借用保真、human 归因）
node 0.4/tests/extension-ingress-e2e.mjs    # 真实 headed Edge：register/pull/complete + session/tab 真实状态
node 0.4/tests/cooperate-attribution-e2e.mjs# 真实 headed Edge：人类输入归因（agent 不计人类、伪人类 → paused）
node 0.4/scripts/test-all.mjs               # 0.4 全包单测（真实浏览器文件串行）
node 0.4/scripts/stage-gate.mjs --with-extension   # 阶段门禁（含 extension ingress、cooperate attribution 两个 opt-in 步骤）
node 0.4/scripts/product-compliance.mjs --check    # 产品面禁词门禁（HTML/CSS hard）
node 0.4/scripts/build-extension-ingress.mjs --ws-url ws://127.0.0.1:52910/ws --json
```

## 附录 B：本轮实证的关键行号

| 结论 | 证据位置 |
| --- | --- |
| 0.4 ingress 盘点初无 popup/options | `0.4/extension-ingress/manifest.json`（盘点开始时 37 行，无 `action`/`options_ui`/`icons`；17:51 起 45 行，见 §2.5） |
| 0.4 只有 6 个 `ext.*` 命令 | `0.4/extension-ingress/src/commands.js:61-66` |
| 0.4 扩展侧消息面 | `0.4/extension-ingress/src/bridge.js`（`bootstrapIngressBridge` 顶层 `safeRegister('runtime.onMessage')`） |
| 0.4 WS 不支持服务端通知 | `0.4/daemon/ws-transport.mjs:302` |
| 0.4 事件面只有定义 | `0.4/packages/protocol/src/events.js`（10 个 EventKind）；全仓仅 `0.4/scripts/bsk-event-check.mjs` 引用 |
| 0.4 daemon 路由表 | `0.4/daemon/server.mjs:3961-4027` |
| 0.4 `system.status` 形状 | `0.4/daemon/server.mjs:2170-2213`；`bskSessionEntry` 在 2059-2072 |
| 0.4 CDP 浮层 | `0.4/packages/browser-adapter/src/overlay-render.js:387`（`createOverlayRenderer`）；`help-handlers.js:21-24`；`cooperate-handlers.js:94,1377` |
| 0.4 借用确认现状 | `0.4/extension-ingress/content/borrow-confirm.js`（354 行；单语混排标题、无 RTL/主题/倒计时） |
| 0.4 明确不照抄 0.3 human-watch | `0.4/extension-ingress/README.md:150-153` |
| 0.3 消息面 72 分派点 | `extension/src/bridge.js:284-520`（66 个 `MESSAGE_HANDLERS` 键）+ 582-634 内联 6 个分支 |
| 0.3 popup 状态字段 | `extension/src/quick.js:146-191` |
| 0.3 hello 帧 | `extension/src/ws-client.js:301-323` |
| 0.3 方法总数 | `docs/PROTOCOL-METHODS.md`（170 行：44 local / 109 session / 17 instance）；`docs/0.4-ARCHITECTURE-PLAN.md:15` 记 canonical 165 |
| 0.3 无 HAR 导出 | `grep -i 'har' extension/**/*.js` 只命中 `character`/`charAt` 等假阳性 |
| 0.3 UI 死链 `bb.call` | `extension/ui/debug.js:131`（`bridge.js` 无 `bb.call` 处理器） |
| 0.4 已落地 popup/options（并发 G4） | `0.4/extension-ingress/ui/{popup.html,popup.js,popup.css,options.html,options.js,options.css,settings.js}`；`test/ui.test.mjs`（1,060 行 / 23 test） |
| 0.4 `ui.status` 只读面 | `0.4/extension-ingress/src/bridge.js:42,44,1746,1778,1875,1963-1975` |
| 0.4 manifest 现有 popup/options | `0.4/extension-ingress/manifest.json`（45 行；`action.default_popup`、`options_ui`；权限仍 7 项、无图标） |
| 0.4 UI 无 i18n（缺口实证） | `0.4/extension-ingress/ui/popup.html:2`（`lang="zh-CN"`）；`popup.js` 内联中文；无 `locales.js`/`i18n.js`/`direction.js` |
| 0.4 产品面禁词门禁 | `0.4/scripts/product-compliance.mjs` + `0.4/compliance-baseline.json`（`extension-ingress/` HTML/CSS = hard） |
| 0.4 staging 尚未打包 ui/ | `0.4/scripts/build-extension-ingress.mjs:37`（`RUNTIME_ENTRIES = ['manifest.json','background.js','src','content']`） |
