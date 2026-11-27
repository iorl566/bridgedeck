# PANELS-PORT-PLAN — 0.3 面板移植评估与 0.4 最小「会话详情页」设计

任务：J4 / task-115。状态：内部研究文档（只读评估，**不进入任何产品包**）。
范围：0.3 冻结侧的 `extension/ui/panels/*`、`ui/audit.*`、`ui/preview.*`、`ui/longshot.*`（对照 `ui/debug.*`、`ui/ops.*`、`ui/record.*`）与 0.4 的 `0.4/dashboard/`、`0.4/extension-ingress/ui/` 现状。
约束：0.3.0 冻结、不改 `dist`/`D:\CTRM自动录入`、不装依赖、不跑阶段门、不改产品代码；本任务只写本文件。

---

## 0. 结论摘要（先读这一段）

1. **0.3 的 5 个 popup 面板不是 daemon 协议资产。** 它们的数据面全部在扩展 SW 内：`chrome.debugger`（网络/console/截图/tabCapture 兜底）、`chrome.tabCapture + offscreen`（视频）、`declarativeNetRequest`（调试规则）、`chrome.storage`/IndexedDB（审计环、录制、长截图分片）。对 0.3 的 165 canonical 方法（`docs/0.4-ARCHITECTURE-PLAN.md:15`）**耦合度为 0**——面板只用 `chrome.runtime.sendMessage({type:'bb.*'})` 调 SW 的本地处理器。因此「移植面板」的真实命题是**能力归属重排**，不是搬文件。
2. **0.4 ingress 的权限面刻意不含这些后端能力**：`manifest.json` 只有 `tabs/windows/storage/alarms/scripting/tabGroups/notifications`（7 项），没有 `debugger`/`tabCapture`/`offscreen`/`declarativeNetRequest`。把 0.3 面板搬进 0.4 扩展，必然要么加回这 4 项权限（商店审核 + 双执行面风险，已明确否定），要么搬一个没有后端的死页面。
3. **建议（本轮结论）**：**5 个面板一律不进 0.4 popup、不新建 0.4 扩展页**；能力收敛到 **dashboard 的一个只读「会话详情」下钻视图**（B3/B4），采集/截图/视频的**驱动动作**留在既有 CLI/MCP/daemon 面。0.3 的真人操作脚本录制（ops）与长截图/预览可视化（longshot/preview）记为**不移植**。
4. **最小详情页不需要任何新 daemon 方法**：0.4 daemon 当前可路由 63 个名字（40 canonical + 23 上游别名，去重 1 个），详情页最多用其中 **13 个只读 + 2 个既有写**；0.3 的 170 条 `LEGACY_METHODS` **一条都不用**，也不引入 0.3 的 `bb.daemon.call` 式通用透传（`0.4/dashboard/README.md:36-39` 的只读白名单原则必须保持）。
5. 分两阶段：**B3 = 只读最小详情页**（1 个新只读组合路由 + 页面下钻，约 1 人日量级）；**B4 = 网络/HAR、审计/账本、视频元数据、协作/human 视图 + 收口**（编号说明见 §4.1）。两者都收口在 `0.4/dashboard/` 内，无新协议面、无新权限、无新依赖。
6. 体积/维护最大风险不是面板本身（5 个面板仅 12,831 B），而是 **dashboard 单文件已 139,815 B 且无体积门禁**（`tools/scale-report.mjs` 跳过 `0.4/`）。B3 起就要把详情渲染拆到新模块，并把预算写死。

---

## 1. 盘点范围与证据

### 1.1 只读过的文件

- 0.3：`extension/ui/panels/{audit,debug,ops,video,longshot}-panel.js`；`extension/ui/{audit,preview,longshot,debug,ops,record}.{html,js}`；`extension/ui/{popup.html,popup.js,ui.css,popup.css,tab-picker.js,common.js}`；`extension/src/{audit,debug,ops,video,screenshot,tiled-capture,network,rules,bridge}.js`；`extension/src/lib/{longshot-store,capture-manifest}.js`、`extension/src/longshot-render.js`；`extension/manifest.json`。
- 0.4：`0.4/dashboard/{server.mjs,server.test.mjs,README.md,auth.mjs}`；`0.4/extension-ingress/{manifest.json,README.md,src/bridge.js,ui/popup.html,ui/popup.js,ui/options.js}`；`0.4/daemon/{server.mjs,transport.mjs,browser-daemon.mjs,session-video.mjs,extension-ingress.mjs}`；`0.4/packages/browser-adapter/src/{screenshot,screenshot-handlers}.js`；`0.4/packages/protocol/src/methods-legacy.js`；`0.4/scripts/{stage-gate,product-compliance,test-all,bsk-coverage}.mjs`；`0.4/STATUS.md`；`docs/{MERGE-0.3-0.4,UI-DESIGN-BRIEF,TEST-STATUS,0.4-ARCHITECTURE-PLAN}.md`。

### 1.2 关键计量（字节数为文件实测；行数取 read 工具口径）

| 项 | 值 | 备注 |
| --- | ---: | --- |
| 0.3 `ui/panels/*` 5 文件 | **12,831 B** | audit 3,155 / debug 2,115 / ops 2,824 / video 2,140 / longshot 2,597 |
| 0.3 `ui/audit.*` + `ui/preview.*` + `ui/longshot.*` | **20,340 B** | 4,972 + 4,083 + 11,285 |
| 0.3 对照页 `ui/debug.*` + `ui/ops.*` + `ui/record.*` | **46,531 B** | 23,997 + 9,013 + 13,521 |
| 0.3 面板后端（核心 8 文件） | **≈159,300 B** | screenshot 35,334 / tiled-capture 14,316 / network 13,912 / video 19,295 / rules 16,766 / debug 10,387 / ops 26,036 / content/record-capture 23,254 |
| 0.3 `injected/page-lib.js` | 180,712 B | 与面板无关，不搬（既有决策） |
| 0.3 `offscreen.js` | 19,949 B | 视频录制容器，不搬 |
| 0.3 共享样式 `ui.css` + `popup.css` | 11,150 + 13,098 B | 视觉资产，禁止复制 |
| 0.4 `dashboard/server.mjs` | **139,815 B**（3,354 行） | 单页 HTML+CSS+JS 内联在模板里 |
| 0.4 dashboard 渲染页 | **≈36,464 B**（默认）/ 36,542 B（accounts+tenants） | `renderPage()` 实测 |
| 0.4 ingress `ui/` | **219,787 B**（21 文件） | 含 12 语言词表与 `popup.js` 53,105 B |
| 0.4 ingress 运行时（`src` + `ui` + `content`，不含 `test/`） | **670,975 B** | |
| 0.4 daemon 可路由方法 | **63**（40 canonical + 23 上游别名，重叠 `session.list`） | `0.4/daemon/transport.mjs`（`METHODS_04` / `BSK_METHODS`） |
| 0.3 legacy 方法目录 | **170** 条 | `0.4/packages/protocol/src/methods-legacy.js`（`LEGACY_METHODS`） |

### 1.3 四条决定性事实

**(a) 0.3 面板的数据源在扩展 SW，不在 daemon。**
审计：`bb.audit.list` → `extension/src/audit.js` 读写 `chrome.storage.local['bb.audit.events']`（≤500 条，默认关）；写入点是每条 daemon 命令进入 SW 时（`extension/src/bridge.js:144-146`）。
调试：`extension/src/debug.js` + `network.js` + `extension/src/debugger.js`（`chrome.debugger`），规则走 `declarativeNetRequest`（`rules.js`）。
操作录制：`extension/src/ops.js` 把页内 recorder 注入主世界 + `chrome.tabs.captureVisibleTab` 缩略图 + storage（`bb.ops.recordings`）。
视频：`extension/src/video.js:22-23`（`chrome.offscreen`）+ `:159`（`chrome.tabCapture`）+ IndexedDB/OPFS。
长截图：`extension/src/screenshot.js:1`（`chrome.tabs.captureVisibleTab` + 调试器 CDP）、`tiled-capture.js:42`（`Page.captureScreenshot` 分片）、`ui/longshot.js`（IndexedDB 分片 + `planStitch`）。
预览：`extension/ui/preview.js:44`（`captureVisibleTab`）+ `:26-29`（`tabs.update`/`windows.update` 聚焦）。

**(b) 0.4 ingress 的权限面（`0.4/extension-ingress/manifest.json:8-16`）**：`tabs, windows, storage, alarms, scripting, tabGroups, notifications` + `<all_urls>` host permission。**无** `debugger`/`tabCapture`/`offscreen`/`declarativeNetRequest`——这不是遗漏，是「0.4 不做第二个执行面」的边界（`0.4/extension-ingress/README.md` 隔离表）。

**(c) 0.4 dashboard 只代理白名单方法**（`0.4/dashboard/README.md:36-39`）：读 `daemon.status` / `session.list` / `system.status` / `debug.query`；accounts 模式只加 `session.open` / `session.close` / `act {click,fill}`。无通用 RPC 代理。页面 CSP 为 `default-src 'none'`，`img-src 'none'`（`server.mjs:2255`），只用 `textContent` 渲染。

**(d) 0.4 daemon 的读面已经够用。** 63 个可路由名字里，与本设计相关的 13 个只读方法全部可路由（逐个用 `isRoutableMethod()` 实测）：`session.list`、`daemon.status`、`system.status`、`debug.status`、`debug.query`、`debug.export`、`session.run_log`、`audit.request`、`ledger.list`、`ledger.pending`、`video.status`、`video.list`、`cooperate.status`。注意 `record.list` / `record.get` **不在** transport allowlist（只有 `record.start/stop`），持久化轨迹要用 `session.run_log` 读。

---

## 2. 面板逐项评估

### 2.1 可移植性分级

| 级别 | 定义 | 落点 |
| --- | --- | --- |
| **P1** | 能力已在 0.4 的既有只读路由里，只需重写呈现 | dashboard 页面 |
| **P2** | 能力已由 0.4 daemon 提供且方法可路由，但需要 1 个只读薄代理路由 | dashboard 新路由 + 页面 |
| **P3** | 需要新协议面/字节流/CSP 变更；本轮不做 | 记 backlog，另行立项 |
| **P4** | 能力或权限模型不兼容 / 产品决策放弃 | 明确「不移植」 |

> 各级别都指**能力**：0.3 代码/文案/视觉/组件一律不复制（§6）。

### 2.2 总表

| # | 0.3 资产 | 职责 | 真源数据 | 对 0.3 协议耦合 | 分级 | 0.4 归属 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `panels/audit-panel.js` + `ui/audit.*` | 审计开关、最近 5 条、全页时间线（1h/24h/7d、清空）；单条仅「方法名 + 时间 + tab/session」 | SW storage `bb.audit.events`（≤500，默认关） | 0（`bb.state`/`bb.settings.set`/`bb.audit.*` 全本地） | **P2** | dashboard 只读「会话审计/账本」区（`audit.request` + `ledger.*`）。0.3 的 SW 审计环本体 = P4 |
| 2 | `panels/debug-panel.js` + `ui/debug.*` | 采集开关、请求/console 实时表、DNR 规则、请求重放、性能指标、历史回看 | `chrome.debugger`（Network/Console/Page）+ 主世界 hooks + DNR + storage 历史（≤50） | 0 | **P2**（trace/请求/console）；规则/重放/性能 = **P4** | dashboard 会话详情页的「网络与 console / 证据」区（已有 `/api/trace`；J2 补 `/api/capture`、`/api/har`） |
| 3 | `panels/ops-panel.js` + `ui/ops.*` | 录**真人**点击/输入/导航成 JSON + 缩略图，「供 Agent 参考」 | 页内注入 recorder + `captureVisibleTab` 缩略图 + storage（20 条/500 事件/30 缩略图） | 0 | **P4**（0.4 无真人操作脚本平面；`human.input` 只做归因事实） | 不移植。Agent 侧轨迹用 `session.run_log`（TraceV3），与「真人脚本」不是同一物，UI 不得混标 |
| 4 | `panels/video-panel.js` + `ui/record.*` | 标签页录像开关 + 视频库（播放/保存/删除） | `chrome.tabCapture` + `chrome.offscreen` MediaRecorder + IndexedDB/OPFS | 0 | **P4**（UI 与录制后端不搬）；能力已由 daemon `video.*` 提供 | dashboard 只读**元数据**列表（`video.status`/`video.list`，B4）；录制/导出动作走 CLI（`--video start|stop`、`--session-video-save`）。播放 = P3 |
| 5 | `panels/longshot-panel.js` + `ui/longshot.*` + `ui/preview.*` | 自动滚动/手动分片长截图、分片恢复、预览保存、活动 tab 预览聚焦 | `chrome.debugger` `Page.captureScreenshot` 分片 + `captureVisibleTab` + IndexedDB + storage manifest | 0 | **P4（本轮）**；若产品坚持在 Web 面可视化则升 **P3** | 截图能力保留在 CLI/MCP（`--full-screenshot`、`tool.screenshot_full_page`）；dashboard 不做（无截图读路由，CSP `img-src 'none'`） |
| 6 | 共享资产 `ui.css`/`popup.css`/`tab-picker.js`/`common.js` | 0.3 页面样式与 tab 选择器 | — | 0 | **P4**（视觉/组件禁止项） | dashboard 用自有 token 与版式（`--card/--line/--accent` 等，见 `server.mjs:558-623`） |

### 2.3 逐项说明（搬什么 / 不搬什么）

**① 审计（audit）**：可移植的是**信息架构**（「这次会话在 daemon 侧发生过什么」），不是 0.3 的 SW 命令审计环。0.4 有两个不同的「审计」，详情页必须分开标注：
- **会话/daemon 审计**：`audit.request`（WAL 计数 + 持久化 trace 计数 + 活跃录制）+ `ledger.list` / `ledger.pending`（未决意图）——这是 0.3 audit 面板在 0.4 的对应物（读的是 daemon 事实，不是扩展命令）。
- **dashboard 自身写审计**：既有 `/api/audit`（accounts 模式登录/写操作），**不是**同一物，不能共用一个「审计」标题。

**② 调试（debug）**：0.4 已经把采集面做进 daemon：`debug.start/stop/status/query/export`（真实 CDP Network/Runtime/Page，模块 `0.4/daemon/session-debug.mjs`，接线见 task-13/15），dashboard 的 Trace 区已在代理 `debug.query`。**可移植**：请求/console 表、采集状态、HAR 导出（J2）。**不移植**：DNR 规则管理、请求重放、性能指标——0.4 没有对应写面，且重放属于「发请求」语义，超出 dashboard 只读/最小写边界。

**③ 操作录制（ops）**：0.4 明确不照抄 0.3 的 `human-watch` 10 秒宽限模型（`0.4/extension-ingress/README.md` §人类输入归因），也没有「把真人操作变成可回放脚本」的平面。`session.run_log` 记录的是 **Agent 的 TraceV3 运行**（steps/states/trace），与 0.3 ops 的真人脚本语义相反。结论：**不移植**；若未来确有需求，应在 daemon 侧新立项（新存储 + 脱敏 + 回放语义），不在 UI 层硬凑。

**④ 视频（video）**：0.4 daemon 的 `video.*` 是真实能力（daemon 侧 screencast，默认 MP4，显式 AVI；持久 catalog + save/discard）。可移植的是**只读元数据**（格式/时长/帧数/大小/artifact 目录/会话归属）。**不搬** 0.3 的 tabCapture/offscreen 录制实现与播放器；**播放= P3**（需要 dashboard 新增字节流路由 + 放宽 CSP `media-src`，且 artifact 在 daemon 主机，涉及路径/租户/上限边界）。

**⑤ 长截图/预览（longshot + preview）**：0.3 的整页拼接算法（`planStitch`、分片 manifest、重叠裁剪）是纯逻辑，但 0.4 侧**已有** CDP 整页截图与分片能力（`0.4/packages/browser-adapter/src/screenshot.js` 的 `captureLongScreenshot`，以及 `screenshot-handlers.js` 的 `tool.screenshot_full_page`），并且 dashboard 没有截图读路由、CSP 禁止 `img-src`。结论：能力留在 CLI/MCP；dashboard 不搬；预览页（`captureVisibleTab` + 强制聚焦）在 0.4 无需求面，**P4**。

### 2.4 汇总

- **P1 = 0**（没有面板可以「只换皮」：数据真源全部不同）。
- **P2 = 2**（audit 的信息架构、debug 的只读子集）→ 都收敛到 dashboard。
- **P3 = 0 本轮**（视频播放、长截图可视化为 backlog 项）。
- **P4 = 5 个面板的主体能力 + preview + 共享视觉资产**。
- **明确「不移植」清单**：SW 命令审计环（`bb.audit.events`）、DNR 规则/重放/性能、真人操作脚本录制、tabCapture/offscreen 录制链路、长截图/预览页、0.3 共享样式与 DOM 结构。
- **popup 决策**：0.4 popup（`0.4/extension-ingress/ui/popup.html`）已有连接/会话/human/借用/控制卡（`ui.status` 驱动），**不再加任何面板**；面板的历史入口改为 dashboard（与 `docs/MERGE-0.3-0.4.md` §6.3-3/§6.3-4 的建议一致）。

---

## 3. 0.4 最小「会话详情页」信息架构

### 3.1 形态

- **落点**：0.4 dashboard 既有单页内**下钻**（不是第二个 HTML 页面）：会话表行点击 → 详情视图；`location.hash = '#/session/<session_id>'` 表达选中态，可复制、可刷新、可后退。不新增静态资源、不改 CSP、不新增页面路由。
- **数据来源**：只经同源 `/api/*`（dashboard 代理 daemon 只读方法）与既有的 dashboard 写路由（accounts + operator，可选）。页面不直连 daemon、不持有 daemon token。
- **刷新**：沿用 2 s 轮询 `/api/status` 只刷新 L0/L1 摘要；**重数据（trace/network/audit/video）只在手动「刷新」或首次进入时拉取**，避免大表每 2 s 重绘（与 J2 的 capture 区块策略一致）。
- **空闲/错误态**：无选中会话显示列表；选中但会话已关闭 → 保留最后一次快照并标 `stale`；上游不可达 → 只显示错误码/消息，不显示旧数据冒充。

### 3.2 线框（信息层级 L0–L3 沿用 `docs/UI-DESIGN-BRIEF.md` §4.2）

```
[L0] ● status   session <id-short>   <tenant> · <browser>   last activity <t>   [← 会话列表] [刷新]
[L1-a 会话]      tab_id · url(复制) · agent_window_id · created_at · idle · 徽章 recording/video/debug
[L1-b 步骤/证据] 运行列表：<run> finished|recording  <steps> 步  <states> 状态  <started→stopped>  purpose
                 └ 选中运行 → 步骤时间线（每步 action/结果/耗时；空则「无步骤」，不造行）
[L1-c 网络/console] 请求表 method/status/duration/size/url（分页/上限）；console 列表 level/text；[下载 HAR]
[L1-d 借用/窗口] agent_window_id · borrowed tab ids · observed tab ids · window released?
[L1-e 人工协作]  human mode/paused/held/last_human_input_at/resume_at；overlay/authority；ingress counters + last event
[L1-f 审计/账本]  WAL 未决/最近意图；trace 计数/摘要（与 dashboard 写审计分开标注）
[L1-g 视频]      录制状态 + 本会话 artifact 元数据（无播放）
[L2 动作]        [刷新] [下载 HAR] [下载 JSON] [返回]     （operator 可选：[关闭会话] [act click|fill]）
[L3 细节]        <details> 原始精简 JSON（clamp 显示）+ run_id/capture counts
```

### 3.3 区块 ↔ 0.4 RPC 映射（全部为既有方法）

| 区块 | daemon 方法 | 参数 | 关键返回字段 | 现状 | 本计划动作 |
| --- | --- | --- | --- | --- | --- |
| L0/L1-a 会话摘要 | `session.list` | `{}` | `sessionId, tabId, url, status, recording, video, debug, idleMs, lastActivityAt, tenant, browser, agentWindowId`；上游别名另加 `session_id, browser_instance_id, created_at_ms, controller:null, interaction:null` | 已用（`/api/status`） | 直接复用 |
| L1-d 借用/窗口 | `daemon.status` | `{}` | `sessions[].borrowedTabIds / observedTabIds / agentWindowId / agentWindowReleased` | RPC 已调，但 `/api/status` 的 `slimDaemonStatus()` 丢掉了 `sessions` 明细 | **B3.1** 在组合路由里补 reduce（不改 `/api/status` 契约） |
| L1-e ingress 计数 | `system.status` | `{}` | `extension.{instances, queued, in_flight, human_events, lifecycle_events, last_event{event,at,handled,session_id,reason}}` | 已用（`/api/status` 已 reduce） | 直接复用 |
| L1-e human/协作 | `cooperate.status` | `{sessionId}` | `human, paused, held, paused_by, mode, last_human_input_at, resume_at, revision, count` + `overlay/authority/context_id/observation_id`；无处理器时 typed unsupported | 未代理 | **B4.4**（unsupported 如实显示） |
| L1-b 采集状态 | `debug.status` | `{sessionId}` | `state, recording, counts, next_since`（未知会话 `state:'idle'`，不抛） | 未代理 | **B3.1**（可选字段，失败降级） |
| L1-c 请求/console | `debug.query` | `{sessionId, since, limit, kinds}` | `requests[], console[], pages[], operations[], counts, next_since, truncated` | 已代理 `/api/trace`；J2 计划 `/api/capture` | **B4.1** 复用 J2，不自建第二套 |
| L2 下载 HAR | `debug.export` | `{sessionId, format:'har'}` | `artifact{path,bytes,mime}`、`counts`（HAR 1.2 由 `0.4/daemon/har-export.mjs` 生成） | 未代理（CLI 有 `--session-debug-export --format har`） | **B4.1** 复用 J2 `/api/har` |
| L1-b 持久化轨迹 | `session.run_log` | `{session_id}` | `entries[]{status,steps,states,started_at/stopped_at,purpose,trace}、sessions[]、session_count、configured`（单会话默认含 `trace`） | 未代理 | **B3.1** |
| L1-f 审计摘要 | `audit.request` | `{session_id?, limit?}` | `ledger{configured,file,counts,state_distribution,recent[]}`、`traces{configured,count,recent[]}`、`recordings`、`summary` | 未代理 | **B4.2** |
| L1-f 意图 | `ledger.list` / `ledger.pending` | `{limit, sessionId?}` | `intents[]{id,action,state,effect,...}`、`pending`、`configured` | 未代理 | **B4.2** |
| L1-g 视频 | `video.status` + `video.list` | `{sessionId}` / `{limit, since}` | `recording, format, mime, frames, duration_ms, artifact_dir`；`entries[]`、`stats` | 未代理（CLI 有 `--session-video-list`） | **B4.3** 只读元数据 |
| L2 关闭会话（写） | `session.close` | `{sessionId}` | `closed, tabClosed` | 已有 `/api/session/close`（operator + 租户 + CSRF + 审计） | **B4.5（可选）** |
| L2 动作（写） | `act` | `{sessionId, action:'click'|'fill', selector|ref, value?}` | `effectState` 等 | 已有 `/api/session/act`（同上） | **B4.5（可选）** |

### 3.4 读不到的东西（诚实边界，UI 不得伪造）

| 读不到 | 原因（证据） | UI 处理 |
| --- | --- | --- |
| 借用 tab 的**标题/URL** | daemon 只记 `tab_id`（`0.4/daemon/browser-daemon.mjs:1965-1970`；`session.list` 连 `borrowedTabIds` 都不带），扩展 `ui.status` 也只有 id | 只显示 tab_id 清单（`daemon.status.sessions[].borrowedTabIds` 仅在借用经 ingress `tool.tab_borrow` 中继时才有值；无 ingress 时为空，按空态显示）；提示「借用明细在扩展 popup」（`ui.status.borrowed`） |
| 真人操作脚本（0.3 ops） | 0.4 无此平面；`human.input` 只是归因事实 | 不显示 |
| 长截图/页面截图预览 | dashboard 无截图读路由 + CSP `img-src 'none'` | 不显示；指 CLI `--full-screenshot` |
| 视频字节/播放 | artifact 在 daemon 本地文件系统；需新字节流路由 + CSP `media-src` | 只列元数据；保存走 CLI `--session-video-save` |
| 0.3 的 SW 命令审计环 | 0.4 ingress 无审计环 | 用 daemon WAL/trace 代替，标题写「daemon 审计」，不冒充「扩展命令审计」 |
| 0.3 的 165 canonical / 170 legacy 方法面 | 0.4 daemon 只路由 63 个名字；`dashboard` 不代理任意 RPC | 不提供通用 RPC 入口 |

### 3.5 与 J2（task-113，dashboard 捕获/HAR 视图）的边界

- J2 拥有 `/api/capture`（`debug.query` 代理）与 `/api/har`（`debug.export format=har` 下载）以及页面「网络/捕获」区块。**B3/B4 不得另建第二套**，B4.1 直接消费 J2 的路由与区块。
- B3.1 的组合路由只用 `session.list`/`daemon.status`/`debug.status`/`session.run_log`，**不碰** `debug.query`/`debug.export`，因此可以在 J2 合并前独立实现；若 J2 先合并，B3.1 只补详情组合，不改 capture 区块。
- 两者都在 `0.4/dashboard/server.mjs` 写域内 → **串行合入**（J2 先，B3 后），否则必然冲突。

### 3.6 安全 / 租户 / CSP 约束（B3/B4 的硬约束）

1. 只同源 `/api/*`；页面脚本内联（现状），不引外部资源、不加 CDN/字体/图标；CSP 保持 `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'`（若将来要图片/视频，必须单独立项评审，不在 B3/B4）。
2. 所有上游字符串 `textContent` 渲染、clamp 长度；**禁止 innerHTML**（现状 `server.mjs` 已如此）。
3. token 边界不变：daemon token 只在出站 `Authorization`；dashboard token 只在 `localStorage` + 请求头；页面/响应/日志/审计不回显任何 token。新路由继承 `redact()`。
4. 租户作用域与 `/api/status` 完全一致：多租户下 `?tenant=` 必填/继承同一解析；跨租户会话 → 404 `E_UNKNOWN_SESSION` 或 403 `E_FORBIDDEN_TENANT`（写路由），不泄漏存在性。
5. 错误码沿用 dashboard 既有映射表（`0.4/dashboard/README.md` §Upstream error mapping），不新增错误码体系。

---

## 4. B3 / B4 分阶段与验收

### 4.1 编号说明

本文件的 **B3/B4** 指「面板移植」的第三/第四段（承接 `docs/MERGE-0.3-0.4.md` 的 B1 UI 共享层、B2 page-lib/capture/HAR）。注意该文档里的 **B3 = 发布工具**（打包/账本/门禁接线），与本文件的 B3 不是同一个东西；若 lead 决定沿用那份编号，本文件两阶段可改称 **P3/P4** 或 **B4/B5**——任务表与编号无关，可原样搬用。

### 4.2 B3 —— 只读最小会话详情页（P1/P2，无新协议面）

| # | 任务 | 改动 | 验收（真实 Edge E2E 或 DOM 断言） |
| --- | --- | --- | --- |
| B3.1 | 详情组合路由 `GET /api/session?session_id=[&tenant=]` | `0.4/dashboard/server.mjs` 新增**只读**路由：并发 `session.list` + `daemon.status` + `debug.status`（可选）+ `session.run_log`（可选）；reduce 成 `{ok, at, session, capture, runs, extension, errors[]}`。规则：缺参 400 `E_INVALID_PARAMS`；会话不存在 404 `E_UNKNOWN_SESSION`；`session.run_log` 不支持/失败 → `runs:[]` + `errors[]` 标记（主信息可用，不用 501 顶掉整页）；`daemon.status` 失败才整页失败（与 `/api/status` 的主信号一致）；租户作用域同 `/api/status`；不回显 token。**不新增 daemon 方法、不改 `/api/status` 契约**。 | `node --test 0.4/dashboard/server.test.mjs` 全绿（当前 55/55，新增 ≥10 断言）：组合字段、缺参 400、未知会话 404、`run_log` 不支持降级、`debug.status` idle、跨租户 404、响应/页面无 token、CSP 头不变、fake daemon 只被调用预期方法（`calls` 断言方法集合）。 |
| B3.2 | 详情视图（只读 L0/L1-a/b/d/e/L3） | 页面：会话行可点（键盘可达、`aria-current`）、`#/session/<id>` 路由、返回/刷新；区块按 §3.2；空态/错误态/`stale` 态；`role=status`+`aria-live` 播报；稳定 DOM 钩子（`id="session-detail"`、`data-session-id`、`#detail-back`、`#detail-refresh`、`#detail-human`、`#detail-borrow` 等，**新命名，沿用 `detail-` 前缀**）。审计/视频区块先给「B4 未启用」空态，不伪造。 | `renderPage()` DOM 断言 ≥8（`server.test.mjs` 内，纯字符串 + 内联脚本可编译）；新增真实 headed Edge opt-in `0.4/tests/dashboard-session-detail-e2e.mjs` **≥15 断言**：真 Edge 起 daemon → `session.open` → 打开 dashboard → 点会话行 → 断言 `session_id/tab_id/url/status` 与 human/借用区块渲染；无采集时显示「无采集」；非法会话 id 显示错误不崩。`node 0.4/tests/ui-popup-e2e.mjs` 不回归。 |
| B3.3 | 文档 / 门禁接线 | `0.4/dashboard/README.md` 补路由表（`/api/session`）+ 详情页说明 + 诚实边界；`stage-gate` 视需要挂 opt-in（默认步数不变）；README 不写来源叙述（合规 hard）。 | `node 0.4/scripts/stage-gate.mjs --with-remote` 全绿且**步数不变**（默认 18 步 / 含 bench 19 步；扩展 20 步，`0.4/scripts/stage-gate.mjs` 文件头矩阵）；`node 0.4/scripts/product-compliance.mjs --check` hard 0 且 dashboard 文件 ratchet 不新增；README 含 `/api/session`。 |

### 4.3 B4 —— 能力补齐与收口（P2/P3 边界）

| # | 任务 | 改动 | 验收 |
| --- | --- | --- | --- |
| B4.1 | 网络/console/HAR 接入详情页 | **复用 J2 的 `/api/capture`、`/api/har`**（不自建）：请求表（method/status/duration/size/url，分页/上限）、console 列表、HAR 下载按钮（`Content-Disposition` 文件名含会话与时间）；手动刷新，不随 2 s 轮询；无 capture → 空态 + 「daemon 无采集」；501/404 原样显示。 | `server.test.mjs` 增断言：详情页引用 capture/har 路由；空/501/404 诚实；HAR 下载头与 JSON 可解析（复用 J2 用例即可）；DOM 断言区块存在。真实 Edge E2E 断言「无采集时为空态、有采集时出现请求行」。 |
| B4.2 | 审计/账本区块 | 新增只读 `GET /api/session/audit?session_id=`：`audit.request` + `ledger.list`/`ledger.pending` 薄代理，租户作用域；页面标注「daemon 审计（WAL/trace）」，与 dashboard 写审计（`/api/audit`）分开。 | `server.test.mjs`：代理参数、租户过滤、`configured:false` 空态、上游 unsupported 降级；DOM 断言两处审计标题不混用；无 token 泄漏。 |
| B4.3 | 视频元数据 | 新增只读 `GET /api/video?session_id=`：`video.status` + `video.list`（`limit` clamp），只展示元数据（format/mime/frames/duration/artifact 目录），**不做播放**；`artifact_dir` 仅作文本展示（clamp，不用于读文件）。 | `server.test.mjs`：参数校验、session 过滤、空态不伪造、`limit` 上界；DOM 断言「仅元数据/无播放器」。 |
| B4.4 | 协作/human 视图 | 新增只读 `GET /api/session/cooperate?session_id=`：`cooperate.status` 薄代理（human/paused/held/last_human_input_at/resume_at/overlay/authority），typed unsupported → 显示「未启用/不支持」；与 `system.status.extension` 的 ingress 计数并列展示，来源标签分开。 | `server.test.mjs`：human 字段透出、unsupported 降级、未知会话 404；E2E：human=ready 时显示默认态、无伪造计数。 |
| B4.5 | 可选写操作（默认不做） | 仅在 accounts + operator 下，详情页提供「关闭会话」「act click/fill」：**复用** `/api/session/close`、`/api/session/act`（CSRF、租户、审计、二次确认全部沿用）；`act` 只用 `selector`（`ref` 来自 observe，dashboard 不暴露 observe）。不新增 navigate/observe 写面。 | `server.test.mjs`：viewer 403、跨租户 403、缺 CSRF 403、审计条目落库（沿用既有用例）；E2E（accounts 模式）：二次确认后才发请求，失败显示 typed `E_*`。 |
| B4.6 | 导出边界 | 详情页「下载 JSON」由前端生成（clamp 后的精简数据）；HAR 走 B4.1；daemon artifact 文件下载**不做**（无文件读路由，保持 CLI `--session-debug-export`）。 | DOM/行为断言：JSON 下载含预期键、不含 token；README 写明「daemon 产物导出走 CLI」。 |
| B4.7 | 收口（体积/合规/回归） | `dashboard/server.mjs` 拆出详情渲染/路由模块（新文件，避免单文件继续膨胀）；预算写死（§5.1）；文档同步 `0.4/STATUS.md` round 记录。 | `node 0.4/scripts/test-all.mjs` 不回归（当前 2,130 passed + 1 skipped）；`node 0.4/scripts/stage-gate.mjs --with-remote` / `--with-ui` 全绿；`product-compliance --check` hard 0 / ratchet 不升；`node 0.4/scripts/eval.mjs run` 43/43 不回归。 |

### 4.4 依赖 / 顺序 / 回滚

- 顺序：**J2 先合 → B3.1 → B3.2 → B3.3 →（B4.1 复用 J2）→ B4.2 → B4.3 → B4.4 → B4.7**；B4.5 可选、最后。
- B3 与 B4 都只改 `0.4/dashboard/**`（+ 新 e2e 文件 + README），可单独合入/单独回滚；不触碰 daemon/adapter/extension，回滚无需协议兼容。
- B3 不依赖 B4 的任何路由（审计/视频区块给空态），因此 B3 可先上线。

---

## 5. 体积 / 维护风险

### 5.1 体积账

| 项 | 现状 | 本计划增量（估算） |
| --- | ---: | ---: |
| 新 daemon 方法 / 新 wire 面 | 0 | **0**（硬约束） |
| 新 chrome 权限（ingress） | 0 新增（7 项） | **0**（硬约束） |
| 新依赖 / CDN / 外部资源 | 0 | **0**（硬约束） |
| dashboard 只读路由 | 现状 2 条（`/api/status`、`/api/trace`；J2 再加 `/api/capture`、`/api/har`） | **新增 ≤4**（session / audit / video / cooperate） |
| dashboard 模板内前端代码（HTML+JS+CSS） | 整文件 139,815 B，其中渲染页 ≈36.5 KB | **≤12,000 B** |
| dashboard 单文件 | 139,815 B（3,354 行），且 `tools/scale-report.mjs` 跳过 `0.4/` → **无体积门禁** | 新增代码放新模块；`server.mjs` 目标 **≤150,000 B**（拆分后应回落，而非继续增长） |
| 0.4 ingress `ui/` | 219,787 B | **0**（面板不进 popup） |
| 0.3 面板 UI（如全搬） | 79,702 B（5 面板 + 6 页面） | 0（不搬） |
| 0.3 面板后端（如全搬） | ≈159,300 B + 4 项扩展权限 | 0（不搬） |

### 5.2 风险清单

| # | 风险 | 证据 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| R1 | **权限回退**：为搬面板给 ingress 加 `debugger`/`tabCapture`/`offscreen`/DNR | 0.4 ingress 现 7 项权限（`manifest.json:8-16`）；0.3 有这 4 项 | 商店审核 + 第二个执行面，与 0.4 架构决策冲突 | 硬禁止（§6）；面板只搬能力到 dashboard |
| R2 | **dashboard 单文件膨胀** | `server.mjs` 139,815 B / 3,354 行；`tools/scale-report.mjs:16` 跳过 `0.4` | 可维护性下降、review 困难、无门禁兜底 | B3 起拆模块；B4.7 把预算写进 README/评审清单；单文件 ≤150,000 B |
| R3 | **双 UI 语义分叉** | 0.4 popup 有 12 语言/RTL 词表（`ui/locales/*.json`），dashboard 是英文单页内联 | 同一状态两种说法、用户困惑 | 只共享**语义**不共享实现；popup 不塞面板；dashboard 不引入半套 i18n（§7-Q5） |
| R4 | **数据真源分裂** | 借用/human 的真源在扩展 SW（`ui.status`）与 daemon（`daemon.status.sessions[].borrowedTabIds`、`cooperate.status`）两侧 | 页面显示与 popup 不一致 | 详情页只展示 daemon 侧事实并标注来源；借用明细明确指回 popup；不合并/不推断 |
| R5 | **与 J2 写域冲突** | J2（task-113）正在改 `0.4/dashboard/server.mjs` + `server.test.mjs` + `README.md` | 并发合并冲突 | 串行合入（J2 先）；B4.1 复用 J2 路由，不自建 |
| R6 | **CSP/字节流** | 页面 CSP `img-src 'none'`、`default-src 'none'`（`server.mjs:2255`） | 视频/截图/播放器无法上线 | 列为 P3 backlog；要动 CSP 必须单独评审 |
| R7 | **合规 ratchet** | `0.4/scripts/product-compliance.mjs:128` 把 `dashboard` 列为产品根；HTML/CSS 全文 hard；新文件 ratchet 基线视为 0 | 新文案/注释出现来源词即 FAIL | 新代码零来源叙述；复用 daemon 的 `E_*` 与自有命名；收口跑 `--check` |
| R8 | **无事件推送** | 0.4 `ws-transport` 不支持服务端 notification（`docs/MERGE-0.3-0.4.md` R6） | 详情页只能轮询/手动刷新 | 页面文案不承诺实时；重数据手动刷新；不伪造「实时」标签 |
| R9 | **租户泄漏** | 详情页新增多个按会话查询的路由 | 跨租户读到别人的会话 | 所有新路由走与 `/api/status` 相同的租户解析和 404/403 语义；测试覆盖越权 |
| R10 | **上游版本差异** | `session.run_log`/`audit.request`/`cooperate.status` 在旧/裁剪 daemon 上可能是 typed unsupported | 详情页部分区块空白 | 每个区块独立降级 + `errors[]` 标注；主信息（会话）不因增值区块失败而丢 |

---

## 6. 禁止项（不抄文案 / 视觉 / 组件 / 标识）

| # | 禁止 | 具体判定 | 门禁 |
| --- | --- | --- | --- |
| F1 | 抄文案 | 不逐句/近义改写 0.3 的中文按钮、标题、空态、错误提示、tooltip；dashboard 保持自有英文文案 | 人工 review + `product-compliance --check`（hard） |
| F2 | 抄视觉 | 不复刻 0.3 的卡片顺序、页头、图标、配色、圆角/阴影刻度；用 dashboard 现有 token 与版式 | 设计评审（`docs/UI-DESIGN-BRIEF.md` §5 禁止项第 4 条） |
| F3 | 抄组件/结构 | 不复制 0.3 DOM 的 id/class（如 `audit-run`、`list-row`、`page-header`、`settings-body`、`panel/toolbar`）与页面骨架；新钩子用 `detail-` 前缀 | DOM 断言 + review |
| F4 | 抄标识 | 产品面不出现参考产品名/版本徽章/图标/截图/logo；不写 `ported from`/`inspired by`/`参考实现` 等来源叙述（注释里也不要） | `node 0.4/scripts/product-compliance.mjs --check` |
| F5 | 复制代码/资产 | 不 import 或复制 `extension/**`、`ref/**` 任何源码/翻译 JSON/图标/SVG/字体；需要算法时按行为写 0.4 原生实现 + 自测 | review + source guard |
| F6 | 协议面 | 不新增 daemon 方法、不加通用 RPC 透传、不复活 0.3 的 `bb.daemon.call` 模式；不把 `extension.*` 方法暴露给浏览器页面 | `server.test.mjs` 方法集合断言 |
| F7 | 权限面 | 不给 0.4 ingress 新增 `debugger`/`tabCapture`/`offscreen`/DNR；不把 daemon token 下发到页面 | `manifest.json` diff 为空 |
| F8 | 安全 | 不引外部资源/CDN；不改 CSP；不回显 token/密码/CSRF；不用 innerHTML | 测试 + review |
| F9 | 造假 | 无数据不显示假步骤/假视频/假 human/假计数；unsupported 就写不支持 | E2E 空态断言 |
| F10 | 范围 | 不改 0.3.0 冻结代码、不改 `dist`/`D:\CTRM自动录入`、不装依赖；本任务只写本文件 | git diff 检查 |

---

## 7. 开放问题（需 lead 拍板）

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| Q1 | 阶段编号用 B3/B4 还是 P3/P4（与 `docs/MERGE-0.3-0.4.md` 的 B3=发布工具冲突） | 文档一致性 | 统一编号；本文件任务表可原样搬用 |
| Q2 | 详情页做成 dashboard 内下钻，还是独立路径/独立页 | 路由与 CSP 面 | 内下钻（复用鉴权/CSP，不新增 HTML 路由） |
| Q3 | 借用 tab 的标题/URL 是否让 ingress 上报（扩大 `extension.event` 面） | 详情页借用区丰富度 vs 协议面 | 不上报，保持 tab_id；标题只在 popup 借用确认时出现 |
| Q4 | 视频播放/长截图是否要在 Web 面可视化（P3） | 需 CSP 放宽 + 字节流路由 + 路径/租户边界 | 本轮不做；要做得单独立项 |
| Q5 | dashboard 是否引入 i18n（现为英文单页） | 12 语言目标 vs 半套词表风险 | 不在 B3/B4 引入；如需，按 dashboard 独立词表另立任务 |
| Q6 | 0.3 ops（真人操作脚本录制）是否有真实产品需求 | 决定 P4 是否终局 | 若无需求，正式记为「不移植」并写入 `0.4/STATUS.md` |

---

## 附录 A：证据（文件:行）

| 结论 | 位置 |
| --- | --- |
| 0.3 5 个面板由 popup 挂载 | `extension/ui/popup.js:2-6`（import）、`:287-291`（mount）；`extension/ui/popup.html:24-117`（features + 内嵌面板 DOM） |
| 0.3 审计环在 SW storage，默认关 | `extension/src/audit.js:1-29`；`extension/src/settings.js:16`；写入点 `extension/src/bridge.js:144-146` |
| 0.3 调试/网络/截图走 `chrome.debugger` | `extension/src/debug.js:1-8`；`extension/src/network.js:4`（`debugger.js`）；`extension/src/screenshot.js:1,4`；`extension/src/tiled-capture.js:42` |
| 0.3 视频走 tabCapture + offscreen | `extension/src/video.js:22-23,159` |
| 0.3 操作录制注入页内 recorder + 缩略图 | `extension/src/ops.js:1-12,15-46,49-80` |
| 0.3 权限面（debugger/tabCapture/offscreen/DNR） | `extension/manifest.json:7-23` |
| 0.3 面板消息面（`bb.*`） | `extension/src/bridge.js:313-517` |
| 0.3 长截图分片/拼接 | `extension/src/lib/longshot-store.js:1-25`；`extension/src/longshot-render.js`；`extension/ui/longshot.js:39-57` |
| 0.3 预览页 = captureVisibleTab + 聚焦 | `extension/ui/preview.js:26-29,44` |
| 0.4 ingress 权限 7 项（无 debugger/tabCapture/offscreen） | `0.4/extension-ingress/manifest.json:8-16` |
| 0.4 ingress popup 已有会话/human/借用/控制卡 | `0.4/extension-ingress/ui/popup.html:21-101`；`ui.status` 生成 `0.4/extension-ingress/src/bridge.js:2058-2082` |
| 0.4 ingress 借用/human 真源为扩展本地 | `0.4/extension-ingress/src/bridge.js:2016-2051`（sessionSummaries/borrowedSummary）、`:110-125`（human 三态） |
| 0.4 dashboard 只代理白名单 | `0.4/dashboard/README.md:36-39`；仅读 4 方法 + 3 写 |
| 0.4 dashboard 路由实现 | `0.4/dashboard/server.mjs:2036-2213`（`/api/status`、`/api/trace`）；`:1448-1466`（daemon reduce）；`:1468-1497`（session reduce）；`:1499-1545`（system reduce）；`:1585-1621`（trace reduce） |
| 0.4 dashboard 页面/区块与 CSP | `0.4/dashboard/server.mjs:626-767`（HTML）；`:2255`（CSP）；`:558-623`（CSS token） |
| 0.4 daemon `session.list` 不含 borrowed 字段 | `0.4/daemon/browser-daemon.mjs:2551-2573`；而 `daemon.status.sessions[]` 含 `borrowedTabIds/observedTabIds/agentWindowId/agentWindowReleased`：`:2520-2542` |
| `session.list` 上游槽位 `controller:null` / `interaction:null` | `0.4/daemon/server.mjs:2072-2085` |
| 0.4 `system.status.extension` 形状 | `0.4/daemon/server.mjs:2146-2177`；整体 `:2183-2226` |
| 0.4 human 状态只在 `cooperate.status` 合并 | `0.4/daemon/browser-daemon.mjs:3557-3620`（humanViewOf/withHumanCooperationView）；`:4235-4240`（cooperateStatus） |
| 0.4 debug 平面（status/query/export） | `0.4/daemon/server.mjs` 文件头 `:132-150`；`0.4/daemon/transport.mjs:228-232`；`0.4/daemon/session-debug.mjs` |
| 0.4 `record.list/get` 不在 transport allowlist | `0.4/daemon/transport.mjs:203-252`（无 `record.list`）；`:275-299`（有 `session.run_log`） |
| 0.4 daemon 可路由 63 名字 | `0.4/daemon/transport.mjs:203-310`；`isRoutableMethod()` 实测 |
| 0.4 0.3 legacy 目录 170 条 | `0.4/packages/protocol/src/methods-legacy.js`（`LEGACY_METHODS`） |
| 详情页与面板的既有设计依据 | `docs/UI-DESIGN-BRIEF.md:73`（S5 会话详情全页 P3）、`:77-90`（L0–L3）、`:119-128`（禁止项）；`docs/MERGE-0.3-0.4.md:535-536`（特性页都不搬） |
| 合规门禁的产品根与 hard 规则 | `0.4/scripts/product-compliance.mjs:11-40,128`；基线比较 `:635-660` |
| 门禁步数与组合矩阵 | `0.4/scripts/stage-gate.mjs:63-83,741-746,805-840`；当前结果 `0.4/STATUS.md:1`（默认 19/19、扩展 20/20、`--with-ui` 19/19、UI E2E 99/99、test-all 2,130 + 1 skipped） |
| 本期 J2 计划（capture/HAR） | task-113（`0.4/dashboard/server.mjs` / `server.test.mjs` / `README.md` 写域） |
| `scale-report` 跳过 `0.4/`（dashboard 无体积门禁） | `tools/scale-report.mjs:16` |

## 附录 B：验收命令速查（B3/B4 实现时；本轮不跑）

```powershell
# 单元 / DOM 断言（browser-free）
node --test 0.4/dashboard/server.test.mjs
node --test 0.4/dashboard/auth.test.mjs

# 真实 headed Edge（opt-in，不属于默认门禁）
node 0.4/tests/dashboard-session-detail-e2e.mjs   # B3.2 新建
node 0.4/tests/ui-popup-e2e.mjs                   # 确认 0.4 popup 不回归

# 门禁 / 合规 / 回归
node 0.4/scripts/stage-gate.mjs --with-remote
node 0.4/scripts/stage-gate.mjs --with-ui
node 0.4/scripts/product-compliance.mjs --check
node 0.4/scripts/test-all.mjs
node 0.4/scripts/eval.mjs run
```
