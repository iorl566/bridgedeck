# BridgeDeck 0.4 功能范围审计：只按 0.3.0 + BSK 0.5.0 已有功能（AF3 / task-167）

> **执行状态（round 64 / 2026-11-25，task-168/169/170 已执行）**：本审计的 **P0/P1 删除面已落地**——
> ① popup 自造面（快捷栏 8 项、更多菜单 9 项、最近使用记忆、单键/组合键与快捷键帮助层、
> 协助通知开关、视频保存面板、录制中导航警告、TraceV3 录制控制台、弹窗回答表单、HELP 徽标、
> dashboard 入口）已从 `0.4/extension-ingress/ui/` 与 `src/`/`background.js`/`manifest.json` 删除；
> ② 对应 E2E（`ui-quick-record-e2e.mjs`、`ui-more-menu-e2e.mjs`、`ui-help-e2e.mjs`）与 stage-gate
> opt-in 步骤（`--with-quick-record`/`--with-more-menu`/`--with-help`）已删除，`ui-popup-e2e.mjs`
> 重写为「0.3 原面 + 5 面板 + 无自造入口」并保留借用确认/状态浮层断言；
> ③ 文档（STATUS round 64 / TEST-STATUS 第 64 条 / HANDOFF §50 / SCOPE-DECISIONS §33 /
> 0.4-CAPABILITY-ACCEPTANCE / READMEs / 覆盖看板）已同步收缩口径。
> **未执行/仍开放的项**（如实，不在本轮范围）：dashboard 本体（E8，冻结为 0.4 自建面）、
> 页内协助备注输入（D2 ALIGN，需单独安全评审）、三份内嵌 12 语言表合并（D6）、
> 5 面板数据面到真实后端的映射（A3/B3），以及 `web_accessible_resources` 删除（E9，取决于 D6）。
> 本文以下内容保留为**执行依据与证据留档**，其「现状（round 63）」表述只在当时有效。
>
> 只读审计产出。**不改任何产品代码、不跑门禁、不装依赖**；本文件是唯一写域。
> 用途：作为“砍/留/对齐”的执行依据（精确到文件 / DOM id / 消息名 / 存储键 / 权限 / 测试）。
>
> - **0.4 现状证据**：`0.4/extension-ingress/**`、`0.4/dashboard/**`、`0.4/STATUS.md`、`0.4/extension-ingress/README.md`。
> - **0.3.0 基线（已冻结）**：仓库根 `extension/**`（manifest `0.3.0`，`ui/` + `src/` + `content/` + `injected/`）。
> - **BSK 0.5.0（只读参考）**：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/**`（下文简称 `BSK/src/...`）。
>   参考材料只在 `docs/` 内部使用，不写入 `0.4/` 产品路径。
> - 判定口径（用户已明确）：**只按 0.3.0 与 BSK 0.5.0 的已有功能来；乱加的砍掉；该有的对齐**。
>   - **KEEP**：0.3 或 BSK 有，且 0.4 当前实现可用 → 保留（写明对齐哪一边）。
>   - **CUT**：0.3 与 BSK 都没有（0.4 自造）→ 砍掉（写清删除点）。
>   - **ALIGN**：0.3 或 BSK 有、0.4 缺失或形态偏离 → 按已有能力恢复/改写（不新增能力）。
> - 证据格式 `path:line`。行号是本轮读取时的快照；执行前需按当前树复核。

---

## 0. 结论摘要（TL;DR）

0.4 相对 0.3 外壳（round 47-48 移植）在 round 56-62 期间新增了一批用户可见面（task-141/142/144/145/146/147/148/151/156/158/161）。逐项对 0.3.0 与 BSK 0.5.0 复核后：

| 结论 | 对象 |
| --- | --- |
| **CUT（6 大类）** | ① `#quickBar` 快捷栏 8 项；② `#qaMore`/`#moreMenu` 更多菜单 9 项；③ 最近使用记忆排序（`bb.quick.recent*` 两键 + `#qaOrderReset`）；④ 单键 `r`/`d`/`?` + 组合键 + 快捷键帮助层；⑤ 0.4 内建 dashboard 入口（`dashboard.open`/`#qaDashboard`/`#recordDashboard`/通知按钮 2/`bb.dashboard.*`）；⑥ 其余 0.4 自造件（badge `HELP`、`#helpNotify` 开关、`#videoSavePanel`、`#recordNavWarn`、`bb.quick.recent` 之外的 session 详情项、`ui/locales/*.json` override + `web_accessible_resources`、`bb04.ui.statusOverlayHidden`）。 |
| **ALIGN（4 项）** | ① 录制卡 `#recordCard` → BSK 的“目的/起始 URL + 复制录制指令”面板；② 帮助回答输入 → 0.3/BSK 的**页内**协助卡备注输入（0.4 目前只有 popup 表单，页内浮层只读）；③ 快捷功能 5 面板（视频/调试/长截图/操作录制/审计）→ 数据面接回真实后端（0.3 可用、0.4 全 typed unsupported）；④ 三个“假开关”：`controlHint`/`cooperationGuard`/`pageGuard` → 按 0.3 语义生效或删除。 |
| **KEEP（5 项）** | ① 借用人工确认（页内确认条 + 通知兜底 + fail-closed）；② 协助/借用系统通知（0.3 有按钮、BSK 有通知）；③ 页内状态浮层（0.3 takeover 卡 / BSK ControlOverlay 同面）；④ 页内录制胶囊（0.3 `__bb_record_host` / BSK RecordOverlay 同面）；⑤ `ext.collect` 快路径 B（内部 seam、默认关、无用户入口；observe 能力 0.3/BSK 都有）。 |
| **badge** | **ALIGN**：保留 `REC`（BSK `daemon-upgrade-notice.ts:40-52` 有 `REC`），砍 `HELP`（0.3 无 badge、BSK 无 help badge）。 |
| **dashboard 帮助/产物入口** | **CUT**：0.3 与 BSK 都**没有** HTTP dashboard（BSK `apps/` 只有 `extension`；0.3 无任何 dashboard/server），ext 侧入口与 dashboard 的帮助/产物写面均为 0.4 自造。 |

一句话：**0.4 的“更快/更多”增量（快捷栏、更多菜单、记忆、快捷键、HELP 徽标、dashboard 入口、popup 内录制控制台）全部超出 0.3/BSK 功能范围，应砍；而 0.3 移植外壳本该工作的 5 个面板、3 个设置开关、页内协助输入反而缺失/失效，属“该有未对齐”，应补。**

---

## 1. 判定基线：0.3.0 与 BSK 0.5.0 到底有什么

### 1.1 0.3.0（仓库根 `extension/`，冻结）

| 面 | 0.3 证据 | 要点 |
| --- | --- | --- |
| popup 布局 | `extension/ui/popup.html`（275 行） | 品牌头 + `#openFeatures` → `#featuresView`（**5 个** `.feature[data-page]`：record/debug/longshot/ops/audit）+ `#subView`（`#auditPanel/#longshotPanel/#videoPanel/#debugPanel/#opsPanel`）+ `#mainView`（连接卡 `#stateLabel/#stateDot/#connToggle`、`#localAuthBadge`、升级提示、当前浏览器 `#browserLabel/#rename/#copyCmd`、连接设置 `#connSettings`（本机端口/远程配对）、`#deviceSettings`、控制提示 `#controlHint`、自动化设置 `#borrowConfirm/#allowHelp/#cooperationGuard`、`#tasksSection/#taskList`、meta `#cliVersion/#extVersion/#instanceId`）。**没有** `#quickBar`、`#moreMenu`、`#recordCard`、`#helpCard`、`#shortcutHelp`、`#helpNotify`。 |
| popup 行为 | `extension/ui/popup.js`（32,710 B） | 2.5s/3s 轮询 `bb.state`；面板通过 `bb.rec.*`/`bb.ops.*`/`bb.debug.*`/`bb.capture`/`bb.audit.*` 取真实数据（0.3 `src/bridge.js:313-447` 全部有 handler）。 |
| 页内浮层 | `extension/src/takeover.js:38`（接管浮层，含 controller/paused/borrowed/minimized）、`extension/src/overlay-ui.js`（`installTakeover`、`helpOverlayFunc:237`、借用确认卡）、`extension/src/record-overlay.js:7`（`__bb_record_host`，计时 + Finish + 可拖拽） | 接管卡=控制提示（`controlHint`）；协助卡=**页内备注 textarea + 取消/完成**；借用卡=允许/拒绝；录制浮层=计时+结束。 |
| 人工协助 | `extension/src/tabs-help.js:17`（`request-help`，页面卡片 + `waitHumanDecision` + 完成条件轮询）、`extension/src/human-decisions.js`、`extension/src/action-notifications.js:26`（协助/借用系统通知，带按钮：协助=取消/完成，借用=允许/拒绝） | 用户决策在**页内卡片 + 系统通知**上完成。 |
| 输入锁 | `extension/content/cooperation.js`（BLOCKER_ID `__bb_input_blocker`、passthrough、归因）、`extension/src/settings.js:15` `cooperationGuard` | 默认关；接管浮层可见且未暂停/收起时锁点击/滚动。 |
| 页面守卫 | `extension/src/bridge.js:637` `installPageGuard()`（只读 `settings.pageGuard`，把误入 Agent 窗口的标签移回用户窗口）、`extension/src/settings.js:12` | 设置项 `pageGuard` 真实生效。 |
| 借用确认 | `extension/src/borrow-ui.js`、`extension/src/tabs-borrow.js`、`src/action-notifications.js`、`human-decisions.js` | 页内确认条 + 通知按钮 + 60s fail-closed（0.3 会强制把标签页置前）。 |
| 视频录制页 | `ui/record.html` + `ui/record.js`（`bb.rec.state/start/stop` → `src/video.js`、`offscreen`、`tabCapture` 权限） | 扩展自录视频（MP4/WebM）+ 文件列表 + 预览。 |
| 操作录制页 | `ui/ops.html` + `ui/ops.js`（`bb.ops.start/stop/list/active/delete`）、`src/ops.js`、`content/record-capture.js` | **人类操作示范录制** → JSON 导出（`download`/clipboard）。 |
| 网站调试页 | `ui/debug.html` + `ui/debug.js`（`bb.debug.start/stop/current/history/…`） | 扩展侧 CDP 采集/回放。 |
| 长截图页 | `ui/longshot.html` + `ui/longshot.js`、`bb.capture`/`bb.manual.*`/`bb.file.save` | 自动拼接 + 手动拼接 + 预览。 |
| 审计页 | `ui/audit.html` + `ui/audit.js`、`bb.audit.list/clear`、`settings.auditEnabled` | 任务操作审计列表。 |
| 快捷功能页 | `ui/quick.html`（5 项，与 popup `#featuresView` 同构）；仅被 `src/diagnostics.js:27` 引用，popup 不链接 | “存在但不可达”，与 0.4 现状一致。 |
| 无 | **无** 工具栏 badge（全扩展 grep 无 `setBadgeText`）、`chrome.commands`/`contextMenus`（manifest 无）、单键快捷键（popup 仅输入框 keydown）、HTTP dashboard、quick recent 记忆、更多菜单。 | 这些正是 0.4 的加面：0.3 一个都没有。 |

### 1.2 BSK 0.5.0（`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src`，只读）

| 面 | BSK 证据 | 要点 |
| --- | --- | --- |
| popup 布局 | `BSK/src/entrypoints/popup/App.tsx`（495 行）、`features.ts:31-47` | 主视图：连接卡、控制提示开关（`data-slot="popup-control-hints-toggle"`）、`InteractionSettings`（`confirmTabBorrow` + `requestHelpEnabled` 两个开关）、`CurrentTasks`、meta；头部 `data-slot="popup-launcher"` → `features` 视图（**5 项**：video / debug / long-screenshot / record / audit）。**没有** quick bar、更多菜单、记忆排序、单键快捷键。 |
| 录制面板 | `App.tsx:411-491` | **只有** purpose + start URL + 只读 prompt + 复制按钮；**没有“开始录制”按钮**（录制由 Agent/CLI 执行）。 |
| 视频面板 | `popup/video-panel.tsx:49-212` | 面板内 开始/停止/中断 + 最近录制；完整视频库是独立页 `entrypoints/video`。 |
| 调试面板 | `popup/debug-panel.tsx`、`entrypoints/debug/*` | 开始/停止采集、计数、独立调试页（证据/时间线/导出）。 |
| 长截图 | `popup/long-screenshot.tsx`、`long-screenshot/*` | 面板 + 预览页。 |
| 审计 | `components/audit-panel.tsx`、`entrypoints/audit/*` | 开关 + 最近任务 + 独立审计页。 |
| 页内控制浮层 | `content/ControlOverlay.tsx`（`role=toolbar`、`data-slot="cooperation-toolbar"`、`control-overlay-stop-all`、暂停/最小化）、`content/overlay-controller.ts` | 接管浮层是**可操作**控制面（暂停/交还/停止/最小化），不是只读状态。 |
| 页内协助浮层 | `content/HelpRequestOverlay.tsx`（`data-slot="help-request-banner"`、`help-highlight`、`bsk-help-note-input`、Continue/Cancel）、`content/help-request.ts` | 协助 = **页内备注输入 + 完成/取消**（note 回传 daemon）。 |
| 页内录制浮层 | `content/RecordOverlay.tsx`（计时 250ms 刷新、拖拽阈值 8px、Finish） | 录制 = 页内胶囊 + Finish。 |
| 借用确认 | `content/BorrowConfirmationOverlay.tsx`、`tools/borrow-confirmation.ts`（`chrome.notifications.create:221`、`onClicked:148`/`onButtonClicked:174`、Allow/Deny 按钮） | 页内确认 + 通知兜底。 |
| 输入锁/放行 | `content/ControlInputBlocker.tsx`、`content/input-passthrough.ts`、`content/capture-suppress.ts` | 接管时阻止页面输入 + Agent 派发放行。 |
| 工具栏徽标 | `lib/daemon-upgrade-notice.ts:40-52` | 徽标文案 = 升级问题 `"!"`；否则**录制中 `REC`**；否则空。颜色 `#dc2626`。**没有** `HELP`。 |
| 通知 | `tools/human-loop.ts:866-886`（协助通知，无按钮）、`tools/borrow-confirmation.ts:148/174/221`（借用通知，按钮 Allow/Deny）、`lib/daemon-upgrade-notice.ts:82-88`（升级通知 + 1 按钮） | 系统通知存在，但不带“打开 dashboard”。 |
| 窗口路由 | `session-manager/window-routing.ts`（`AgentWindowRouting`，`tabs.onCreated/onAttached/onUpdated/onRemoved/webNavigation.onCreatedNavigationTarget`） | 页面自开/外部标签路由出 Agent Window（0.3 `pageGuard` 的同类能力）；**无用户开关**。 |
| 无 | manifest（`wxt.config.ts:35-72`）**无** `commands`/`contextMenus`；`apps/` 只有 `extension`（**无 dashboard**）；**无** 单键快捷键、**无** 记忆排序、**无** `HELP` badge、**无** popup 内开始/停止录制按钮、**无** 录制摘要步骤表。 | 即 0.4 的这些面在 BSK 也没有对应物。 |

---

## 2. 0.4 当前用户可见面全量枚举（逐项到文件 / DOM / 消息）

### 2.1 popup（`0.4/extension-ingress/ui/popup.html` 473 行 + `ui/popup.js` 1702 行 + `ui/popup.css` 19,044 B）

| 区块 | DOM id | 来源 | 后端消息 |
| --- | --- | --- | --- |
| 品牌头 | `#openFeatures`、`#backFromFeatures`、`#app` | 0.3 移植 | — |
| 快捷功能视图（5） | `#featuresView`、`.feature[data-page=record.html/debug.html/longshot.html/ops.html/audit.html]` | 0.3 移植 | — |
| 5 个内嵌面板 | `#subView` → `#auditPanel`（`#auditToggle/#auditStatus/#auditRuns/#auditOpen`）、`#longshotPanel`（`#longshotMode/#longshotStatus/#longshotStart/#longshotOpen`）、`#videoPanel`（`#videoStatus/#videoStart/#videoStop/#videoOpen`）、`#debugPanel`（`#debugStatus/#debugSummary/#debugStart/#debugStop/#debugHistory`）、`#opsPanel`（`#opsStatus/#opsRuns/#opsStart/#opsStop/#opsOpen`） | 0.3 移植（**数据面在 0.4 全部 typed unsupported**） | `bb.audit.list`、`bb.capture`、`bb.rec.state/start/stop`、`bb.debug.current/start/stop`、`bb.ops.active/list/start/stop`（`ui-compat.js` 顶部表 = unsupported） |
| **快捷栏（0.4 新增，8 项）** | `#quickBar`（`role=toolbar`）> `#quickBarItems` > `#qaRecord`(data-action=record)、`#qaHelp`(help)、`#qaBorrow`(borrow)、`#qaCopyTrace`(trace)、`#qaDashboard`(dashboard)、`#qaPause`(pause)、`#qaScreenshot`(screenshot)、`#qaSettings`(settings) | 0.4 task-141/144 | 点击 → `bb.quick {action}`（`record.start/stop`、`help.request`、`tab.borrow`、`dashboard.open`、`screenshot.capture`）或 popup 本地动作（pause/settings） |
| **快捷栏页脚（0.4 新增）** | `#qaOrderReset`、`#shortcutHelpOpen`、`#qaMore`、`#quickStatus`、`#quickReasons`、静态快捷键说明行 | 0.4 task-156 | `chrome.storage.local['bb.quick.recent']`/`['bb.quick.recent.more']` |
| **更多菜单（0.4 新增，9 项）** | `#moreMenu[role=menu]` > `#moreVideoStart/Stop/Save`(data-action video.start/stop/save)、`#moreDebugStart/Stop/Export`(debug.*)、`#moreLongshot`(screenshot.capture fullPage)、`#moreAudit`(ledger.list)、`#moreSession`(localOnly)，以及 `#moreStatus`、`#moreReasons` | 0.4 task-145/151 | `bb.quick`/`bb.call`（同上白名单） |
| **视频保存面板（0.4 新增）** | `#videoSavePanel`（`#videoSaveHint/#videoSaveName/#videoSaveConfirm/#videoSaveCancel/#videoSaveStatus`） | 0.4 task-151/X1 | `bb.call video.list` → `video.save {id,out}` |
| **录制中导航警告（0.4 新增）** | `#recordNavWarn`（`#recordNavWarnText/#recordNavWarnContinue/#recordNavWarnCancel`） | 0.4 task-156 | `bb.call video.status` |
| **录制卡（0.4 新增）** | `#recordCard`：`#recordState`、`#recordPurpose` + `#recordPurposePresets`、`#recordMeta`、`#recordTimer`、`#recordStart`、`#recordStop`、`#recordClear`、`#recordSummary`（`#recordSummaryMeta/#recordDigest/#recordStepTable/#recordSteps/#recordStepsEmpty`）、`#recordExport`、`#recordCopyCli`、`#recordDashboard`、`#recordActionStatus`、`#recordSummaryNote` | 0.4 task-142/148 | `bb.call record.start/stop/status`、`trace.get/list`、`dashboard.open`；`chrome.storage.local['bb.record.workflow']`、`['bb.record.purpose']` |
| **人工协助卡（0.4 新增）** | `#helpCard`：`#helpState`、`#helpMeta`、`#helpMessage`、`#helpAnswerArea`（`#helpAnswer` textarea、`#helpAnsweredBy`、`#helpAnswerSubmit`、`#helpAnswerDismiss`、`#helpAnswerStatus`）、`#helpResolvedText` | 0.4 task-148/158 | `bb.quick help.request`、`bb.call session.request_help/request_status/answer_help` |
| 连接卡 / 设置 / 任务 / meta（0.3 外壳） | `#stateDot/#stateLabel/#connToggle/#stateError/#upgradeNotice/#localAuthBadge/#browserLabel/#rename/#labelInput/#copyCmd/#connSettings/#connMode/#daemonInfo/#modeLocal/#modeRemote/#daemonPort/#savePort/#pairLink/#pairCode/#pairGuide/#pairError/#pairSave/#pairClear/#pairUrl/#pairToken/#deviceSettings/#deviceCount/#deviceList/#deviceRevokeAll/#tasksSection/#taskList/#cliVersion/#extVersion/#instanceId/#copyInstance` | 0.3 移植 | `bb.state`、`bb.connection`、`bb.settings.set`、`bb.devices.list/revoke` |
| 设置开关行 | `#controlHint`、`#borrowConfirm`、`#allowHelp`、`#cooperationGuard`、（0.4 新增）`#helpNotify` | 0.3 移植 + 0.4 增 1 | `bb.settings.set`（`helpNotify` 走 `chrome.storage.local['bb.help.notify']`） |
| **快捷键帮助层（0.4 新增）** | `#shortcutHelp`（`#shortcutHelpTitle/#shortcutHelpList/#shortcutHelpClose`），7 条词条 | 0.4 task-156 | 无 |

`ui/popup.js` 关键入口（行号快照）：快捷栏事件 `:855-877`；更多菜单 `MORE_ITEMS :890-955`、`renderMoreMenu :1511`、`wireMoreMenu :1543-1624`；视频保存 `:1248-1447`；录制导航 `:1449-1497`；帮助通知开关 `:240-262/:321-345/:465-472`；记忆 `:30-120`；快捷键帮助 `:122-165`；键盘 `:1626-1676`；`?syncTest` 死钩子 `:760-770`；`?selftest=a11y` `:1684-1702`。

### 2.2 options / 其它页（`0.4/extension-ingress/ui/`）

- `options.html|options.js`：**与 0.3 逐字节同构**（0.3 `3712 B`/`2382 B` vs 0.4 `3712 B`/`2385 B`，只差 import 路径 → `ui/support/settings.js`）。字段：`#instanceLabel/#copyCmd/#cmdPreview/#borrowConfirm/#allowHelp/#cooperationGuard/#pageGuard/#uiLang/#longShotMode`、恢复默认 —— **无 0.4 新增设置**。
- `audit.html|js`、`record.html|js`、`longshot.html|js`、`debug.html|js`、`ops.html|js`、`quick.html|js`、`preview.html|js`、`privacy.html|js`、`direction.js`、`i18n.js`、`locales.js`、`ui.css`：0.3 同构；`privacy.js` 是 0.4 为 MV3 CSP 把 0.3 的内联 `onclick` 改成外链脚本（**合规修复，不是新功能**）。
- `ui/i18n.js` 0.3 `23,455 B` → 0.4 `41,938 B`：新增的全部是快捷栏/更多菜单/录制卡/帮助卡/快捷键/dashboard 的界面文案词条（示例 `:279-288`「快捷操作/录制（Ctrl+Shift+R）/打开 dashboard（Alt+Shift+D）」）。
- `ui/locales.js` 两侧同为 `168,119 B`（12 语言单表，251 键，0.3 原样拷贝）。

### 2.3 内容脚本（`manifest.json:44-89`，3 条声明式 + 1 条按需注入）

| 文件 | 注入方式 | host/DOM | 消息 | 来源 |
| --- | --- | --- | --- | --- |
| `content/human-watch.js` | 声明式，`<all_urls>`，`document_start`，`all_frames:true` | 无（只监听） | 收 `{kind:'bb04.human.arm'}`；发 `{kind:'human.input'}` | 0.3 `content/human-watch.js` 移植 + 修 0.3 的 10s 宽限缺陷（README:266-270） |
| `content/status-overlay.js` | 声明式，主帧，`document_idle` | `#__bb04_status_overlay_host`，`[data-bb04-status-overlay]`、`data-role/data-state/data-tone`、折叠/迷你态、`role=status` | 收 `{kind:'bb04.status'}`、`{kind:'bb04.status.event'}`；发 `{kind:'ui.status'}`；`chrome.storage.local['bb04.ui.statusOverlayHidden']`、`['bb04.ui.language']` | 0.4 新写（视觉语言对齐 0.3 takeover；`status-overlay.js:16-25`） |
| `content/collect.js` | 声明式，主帧，`document_idle` | `globalThis.__bb04Collect()` | 收 `{kind:'bb04.collect', opts}` → 回 CompactTree v1 | 0.4 fastpath B（task-121） |
| `content/record-capsule.js` | 声明式，主帧，`document_idle` | `#__bb04_record_capsule_host`，`role=group`、`role=timer`、Finish、折叠/关闭、拖拽 | 发 `{kind:'bb04.record.state'}`、`{kind:'bb04.record.finish', session_id}` | 0.4 T3；形态对齐 0.3 `src/record-overlay.js` |
| `borrow-confirm.js` + `borrow-i18n.js` | `chrome.scripting.executeScript` 按需注入（不声明） | `#__bb04_borrow_confirm_host`、`#__bb04_borrow_confirm_state_host`；`role=dialog`、倒计时 ring、Esc=拒绝、`role=status/alert` | 收 `{kind:'bb04.borrow.confirm', request}`、`{kind:'bb04.borrow.confirm.dismiss'}`；通知降级 `bb04.borrow.confirm.<request_id>` | 0.3 `borrow-ui.js` + `overlay-ui.js` 借用卡移植（0.4 不强制置前标签页） |

### 2.4 service worker / 徽标 / 通知（`src/bridge.js`、`background.js`、`src/borrow.js`）

- **徽标（0.4 新增）**：`ui-compat.js:202-212` `ACTION_BADGE_TEXT={recording:'REC', help:'HELP'}`、`ACTION_BADGE_COLORS`、`ACTION_BADGE_TITLES`；`deriveLegacyBadge :937-975`；`src/bridge.js:146` `createActionBadge`、`:2919` `refreshActionBadge`（help pending → `HELP`；否则录制 → `REC`；否则空）。
- **协助通知（0.4 新增）**：`src/bridge.js:112-131` `HELP_NOTIFICATION_PREFIX='bb04.help.'`、`HELP_NOTIFICATION_PAGE='ui/popup.html'`、两个按钮 `打开弹窗回答`(0) / `打开 Dashboard`(1)、`createHelpNotifier :226`（`requireInteraction`、打包 `icons/icon128.png`）；`help_notify` 开关 `storage.local['bb.help.notify']`（`ui-compat.js:201`）。
- **通知点击路由（0.4 新增）**：`background.js:163-229` `registerHelpNotificationRouting`：`onClicked` → popup（`windows.create` → `tabs.create` 降级）；`onButtonClicked` 0 → popup、1 → `openHelpDashboard`（`background.js:122-153`，复用 `bb.quick dashboard.open`，失败降级 popup）；全局快照 `__bridgeDeckHelpNotificationRouting`。
- **借用通知（0.3 有）**：`src/borrow.js` 用 `chrome.notifications` 兜底（允许/拒绝按钮，`borrow.js:677`），关闭通知=拒绝。

### 2.5 manifest（`0.4/extension-ingress/manifest.json`，100 行）

- 入口：`action.default_popup=ui/popup.html`、`options_ui=ui/options.html`、4 条声明式内容脚本（见上）、`web_accessible_resources: ui/locales/*.json`（**0.3 manifest 没有这一项**）。
- 权限：`tabs, windows, storage, alarms, scripting, tabGroups, notifications`；`host_permissions:<all_urls>`。相对 0.3 少 `debugger/tabCapture/offscreen/webNavigation/downloads/idle/declarativeNetRequest`（**已是最小面，保留**）。
- **无** `commands`/`contextMenus`（与 BSK 一致；但 popup 自己在 JS 里做单键快捷键，见 §4.4）。

### 2.6 0.4 新增存储键 / 消息名（本轮新增或仅 0.4 使用的）

存储键：`bb.quick.recent`、`bb.quick.recent.more`、`bb.record.workflow`、`bb.record.purpose`、`bb.help.notify`、`bb.dashboard.url`、`bb.dashboard.port`、`bb04.ui.statusOverlayHidden`、`bb04.ui.language`、`bb04.ingress.*`（wsUrl/token/instanceId/borrowConfirm/sessions/borrowSnapshots）、`bb04.help.<request_id>`（通知 id，不是 storage）。
消息名：`bb.quick`、`bb.takeover.sync`（0.4 无 handler，见 §4）；内容脚本 `bb04.human.arm`、`bb04.status`、`bb04.status.event`、`bb04.collect`、`bb04.record.state`、`bb04.record.finish`、`bb04.borrow.confirm`、`bb04.borrow.confirm.dismiss`；`ui.status`、`ui.intent`、`human.input`；`bb.state/bb.call/bb.settings.set/bb.connection/bb.devices.list`（0.3 兼容层 5 类）。
0.3 消息里被 0.4 **typed unsupported** 的：`bb.rec.*`、`bb.ops.*`、`bb.debug.*`、`bb.capture`、`bb.manual.*`、`bb.file.save`、`bb.audit.*`、`bb.video.*`、`bb.longshot.*`、`bb.takeover.stop/pause/minimized`、`bb.takeover.sync`、`bb.devices.revoke` 等（`ui-compat.js:11-27`、`:584-593`）。

### 2.7 compatibility 白名单 / 快捷动作表（`src/ui-compat.js`）

- `UI_COMPAT_SUPPORTED_TYPES`（`ui-compat.js:80-86`）= `bb.state / bb.call / bb.settings.set / bb.connection / bb.devices.list`。
- `UI_COMPAT_WRITE_METHODS`（`:117-156`，27 项）：`session.open/close/act`、`tab.borrow`、`record.start/stop/status`、`screenshot.capture`、`trace.get/list`、`debug.query/status/start/stop/export`、`session.request`、`session.request_help/request_status/answer_help`、`cooperate.status`、`video.status/start/stop/save/list`、`ledger.list/pending`。
- `UI_COMPAT_QUICK_ACTIONS`（`:249-301`，25 项，含 `help.request/help.answer/dashboard.open`）。
- `UI_COMPAT_LOCAL_METHODS=['dashboard.open']`（`:219`）、`DASHBOARD_SETTINGS_KEYS={url:'bb.dashboard.url',port:'bb.dashboard.port'}`（`:229-232`）、`HELP_NOTIFY_SETTINGS_KEY='bb.help.notify'`（`:201`）。
- `deriveLegacyBadge`（`:937`）。

### 2.8 dashboard（`0.4/dashboard/`）

0.4 自建独立进程 HTTP 控制面（`server.mjs` + 18 模块）。与“帮助 / 产物”相关的面：

- 帮助：`dashboard/help-handlers.mjs`（`GET /api/session/help` 只读 `session.request_status`；`POST /api/session/help/answer` → `session.answer_help`，operator + tenant + CSRF + 审计），页面 `page-detail-script.mjs` 的 `#detail-help*`（`#detail-help-answer/#detail-help-submit/#detail-help-result/#detail-help-cli`）。
- 产物：`dashboard/artifact-handlers.mjs`（`GET /api/video/download?id=`，catalog 校验 + realpath 限制 + 64 MiB 上限）、`GET /api/video`（`/api/video` 分页）、`page-detail-script.mjs` 的下载锚点（`anchor.download`）。
- 入口/门禁：扩展弹窗/通知/dashboard.open → dashboard（见 §3）；`0.4/tests/dashboard-session-e2e.mjs`、`--with-dashboard` 门禁步骤。
- **对应面判定：0.3 与 BSK 都没有 dashboard**（0.3 的对应面是 `extension/ui/audit.html|record.html|ops.html|debug.html|longshot.html`；BSK 的对应面是扩展内 audit/debug/video/long-shot 页面与面板）。因此 dashboard 的帮助/产物面在 0.3/BSK 无对应物。

---

## 3. 对照表（功能 / 0.4 证据 / 0.3 证据 / BSK 证据 / 判定 / 动作 / 风险）

> “0.3 证据/BSK 证据”写“无”即两方都没有；“— ”表示不适用。

### A. popup 布局与入口

| # | 功能 | 0.4 证据 | 0.3 证据 | BSK 证据 | 判定 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | 品牌头 + 5 快捷功能入口（`#openFeatures`/`#featuresView`） | `ui/popup.html:13-52`、`popup.js:471-525` | `extension/ui/popup.html:13-52`（同构） | `App.tsx:174-192,379-405`、`features.ts:31-47` | **KEEP**（对齐 0.3 外壳 / BSK 5 features） | 保留；把 `data-page` 面板接到真实后端（见 B3） | 面板当前点了就失败 |
| A2 | 连接卡 / 端口 / 配对 / 设备 / 任务 / meta | `ui/popup.html:244-449` | `extension/ui/popup.html:121-270` | `App.tsx:198-298`、`connection-settings.tsx`、`current-tasks.tsx` | **KEEP**（对齐 0.3；BSK 同面） | 不改 | — |
| A3 | 5 个内嵌面板（审计/长截图/视频/调试/操作录制） | `ui/popup.html:54-117`、`ui/panels/*.js`、`popup.js:494-517` | `extension/ui/popup.html:54-117` + 0.3 bridge handler `:313-447`（真实可用） | video/debug/long-shot/audit 面板 + 独立页 | **KEEP + ALIGN（数据面）** | 把面板消息从 `bb.audit.*/bb.capture/bb.rec.*/bb.debug.*/bb.ops.*` 改为 `bb.call/bb.quick`（详细映射见 §5.2） | 映射错→假成功；须逐面板验收 |
| A4 | 快捷功能独立页 `ui/quick.html`（5 项） | `ui/quick.html`（0.3 原样） | `extension/ui/quick.html` 同构，仅 `diagnostics.js` 引用 | 无（BSK 用 launcher 子视图） | **KEEP（0.3 原样）** | 保留；**不新增入口**（0.3 也不可达） | 与 T2 的“更多”不要混 |
| A5 | **`#quickBar` 快捷栏 8 项** | `ui/popup.html:121-155`、`ui/panels/record-panel.js:55-77`、`popup.js:833-877` | **无**（0.3 popup 无快捷栏；grep `quickBar` 0 命中） | **无**（`App.tsx` 无 toolbar/qa 按钮） | **CUT** | 删 `#quickBar`、`#quickBarItems`、`#qaRecord/#qaHelp/#qaBorrow/#qaCopyTrace/#qaDashboard/#qaPause/#qaScreenshot/#qaSettings`、`#quickStatus`、`#quickReasons`、`QUICK_DEFS`、`QUICK_BAR_DEFAULT_IDS`、`quickAvailability/renderQuickBar`、qaPause/qaSettings 处理 | 少了 1 击入口；0.3/BSK 的入口是 2 击（features→面板），可接受 |
| A6 | **`#qaOrderReset` + 最近使用记忆排序** | `ui/popup.html:156-158`、`popup.js:30-120`、`record-panel.js:42-49,132-205`；键 `bb.quick.recent`/`bb.quick.recent.more` | **无** | **无**（features 列表固定顺序） | **CUT** | 删两键读写 + `normalizeQuickRecent/orderIdsByRecent/readQuickRecent/rememberQuickRecent/clearQuickRecent` + `#qaOrderReset` + 收起/展开重排 | 无功能损失（纯记忆） |
| A7 | **`#qaMore`/`#moreMenu` 更多菜单 9 项** | `ui/popup.html:159-203`、`popup.js:890-955,1511-1624`；9 个 menu-item | **无**（0.3 无溢出菜单） | **无**（BSK 只有 5 features 列表；`features.ts:31-47`） | **CUT** | 删 `#qaMore/#moreMenu/#moreStatus/#moreReasons`、`MORE_ITEMS`、`renderMoreMenu/wireMoreMenu/activateMoreItem`、菜单记忆 | 9 项能力多数应回到 5 面板（B3/§5.2） |
| A8 | **视频保存面板 `#videoSavePanel`** | `ui/popup.html:204-212`、`popup.js:1248-1447` | 0.3 视频页有文件列表/预览（`ui/record.js`），无“保存到产物目录”表单 | BSK 视频页有保存/下载（`entrypoints/video`） | **CUT（popup 表单）** | 删 `#videoSavePanel` 整块 + `startVideoSaveFlow/confirmVideoSave/openVideoSavePanel`（`video.list` 白名单可留作面板只读） | 保存入口改由视频面板/完整页承担（ALIGN） |
| A9 | **录制中导航警告 `#recordNavWarn`** | `ui/popup.html:213-219`、`popup.js:1449-1497` | 无 | 无 | **CUT** | 删整块 + `showRecordNavWarning/resolveRecordNavWarning/guardNavigationWhileRecording` | 随录制卡一起删 |
| A10 | **录制卡 `#recordCard`（TraceV3 开始/停止/摘要/导出）** | `ui/popup.html:311-353`、`ui/panels/record-panel.js`（1922 行）、`popup.js:494` | 无（0.3 是 `ops` 人类操作录制页 + `record` 视频页；无 Agent TraceV3 控制器） | **有 record 面板但只做 prompt 复制**（`App.tsx:411-491`）；明确“UI 无步骤表/摘要”（`docs/QUICK-ACTIONS-BRIEF.md:122`） | **ALIGN（对齐 BSK）** | 保留 `#recordPurpose`（+预设）；加起始 URL；只读 prompt + 复制；**删** `#recordStart/#recordStop/#recordTimer/#recordState/#recordMeta/#recordSummary/#recordSummaryMeta/#recordDigest/#recordStepTable/#recordSteps/#recordStepsEmpty/#recordExport/#recordCopyCli/#recordDashboard/#recordClear/#recordActionStatus/#recordSummaryNote` 及 `record-panel.js` 的轮询/摘要/导出/持久化逻辑（`RECORD_STORAGE_KEY/SCHEMA/MAX_ROWS/TRACE_STORAGE_LIMIT`、`stepRowOf/summarizeTrace/digestOf/export/restore`） | 录制改由 Agent/CLI 发起；须提供 `bridge ... record start` 命令文案 |
| A11 | **人工协助卡 `#helpCard`（pending + popup 回答表单）** | `ui/popup.html:225-242`、`record-panel.js:1260-1524` | 0.3 协助在**页内卡**（`overlay-ui.js:237-404`，note textarea + 取消/完成） | **页内** `HelpRequestOverlay.tsx`（note input + Continue/Cancel） | **ALIGN** | 保留 `#helpCard` 作为 pending/resolved **展示**；回答输入按 0.3/BSK 回页内（见 D2）；若保留 popup 输入，必须是“额外入口”而非唯一入口 | 页内回答需走 内容脚本→SW→daemon（0.3 `bb.help.resolved` 模式），不得把 daemon token 给页面 |
| A12 | **快捷键帮助层 `#shortcutHelp`（7 词条）** | `ui/popup.html:451-468`、`popup.js:122-165,876-877` | **无** | **无**（无快捷键体系，`wxt.config.ts` 无 commands） | **CUT** | 删整层 + `shortcutHelpVisible/setShortcutHelpOpen/toggleShortcutHelp` + 入口 | 与 A5 一起删 |

### B. 设置项

| # | 功能 | 0.4 证据 | 0.3 证据 | BSK 证据 | 判定 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | `#borrowConfirm` 借用前确认 | popup.html:387-396；`ui-compat.js:477`；`src/commands.js` 读 config `always/never` | `src/settings.js:44`、`src/tabs-borrow.js`、`src/borrow-ui.js` | `InteractionSettings` `confirmTabBorrow`（interaction-preferences.ts） | **KEEP**（对齐 0.3+BSK） | 不改 | 0.4 的开关写 `bb.settings.borrowConfirm` 但 command 读 `config.borrowConfirm`；见 R4 |
| B2 | `#allowHelp` 允许人工协助 | popup.html:397-408；`ui-compat.js:478` | `src/settings.js:45`、`src/tabs-help.js:23` | `requestHelpEnabled` | **KEEP**（对齐双方） | 不改 | 0.4 需把 `allowHelp` 接到 `ext.help_request` 的拒绝路径（当前只在 daemon 侧） |
| B3 | `#controlHint` 控制提示 | popup.html:365-380；`ui-compat.js:481`；**0.4 无任何读取方**（`content/status-overlay.js` 读 `bb04.ui.statusOverlayHidden`，该键无人写） | `src/takeover.js:49-53,107`（关闭时移除接管浮层，打开时恢复）、`src/bridge.js:408-411` | `use-control-hints-hidden` → 控制浮层隐藏（`App.tsx:300-323`） | **ALIGN（0.3/BSK 同面）** | 让 `status-overlay.js` 读 `bb.settings.controlHint`（经 `bb.state.settings`/storage 监听），删 `bb04.ui.statusOverlayHidden` | 现状是“假开关”，用户点了无效 |
| B4 | `#cooperationGuard` 接管时阻止页面点击/滚动 | popup.html:421-432；options.html:49-55；`ui-compat.js:483`；**0.4 无输入锁内容脚本**（`manifest.content_scripts` 无 cooperation） | `content/cooperation.js`（`__bb_input_blocker`、passthrough、归因）、`src/settings.js:15`、`src/bridge.js:299`、`src/control.js:76` | `content/ControlInputBlocker.tsx` + `input-passthrough.ts` | **ALIGN** | 恢复 0.3 输入锁内容脚本（或 BSK 等价实现）并接 `cooperationGuard`；若不恢复则**必须 CUT 该开关**（不能留假开关） | 恢复涉及 `bb.cooperation.*` 消息与 passthrough；不得引入新权限 |
| B5 | options `#pageGuard` 页面守卫 | options.html:56-62；**0.4 无读取方**（`bridge.js:1447` `onCreated` 无条件路由，不读 settings） | `src/bridge.js:637` `installPageGuard()` 读 `settings.pageGuard` | `session-manager/window-routing.ts`（无条件路由，无开关） | **ALIGN** | 让 `onCreated` 路由尊重 `bb.settings.pageGuard === false`（0.3 语义）；或按 BSK 无条件并 CUT 该 checkbox（二选一，不能留假开关） | 路由是真实能力；仅开关呈现问题 |
| B6 | **`#helpNotify` 协助请求系统通知开关** | popup.html:409-420；`popup.js:240-262,321-345,465-472`；键 `bb.help.notify` | **无**（0.3 协助通知按请求无条件发，无用户开关） | **无**（BSK 帮助通知无开关） | **CUT** | 删设置行 + `setHelpNotify` + `storage.local['bb.help.notify']` + `ui-compat.js:201,1240` 与该键的分支；通知本身保留（C1） | 通知能力保留，仅去掉自造开关 |
| B7 | options 其它（实例名/语言/长截图模式/恢复默认） | options.html 全量 | 同构（0.3 原样） | 连接设置/交互设置 | **KEEP（0.3 原样）** | 不改 | — |

### C. SW / 徽标 / 通知

| # | 功能 | 0.4 证据 | 0.3 证据 | BSK 证据 | 判定 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 协助请求系统通知（`bb04.help.<id>`，`requireInteraction`，图标=扩展 PNG） | `src/bridge.js:112-131,226-312`、`background.js:68-71` | `src/action-notifications.js:26-58`（协助/借用通知，带按钮；图标 `icons/icon128.png`） | `tools/human-loop.ts:866-886`（协助通知，无按钮） | **KEEP（对齐 0.3，图标对齐 BSK 的打包 PNG 做法）** | 保留；通知按钮见 C2 | — |
| C2 | 协助通知按钮：0=打开弹窗回答、1=**打开 Dashboard** | `src/bridge.js:126-131,275-283`、`background.js:188-212` | 0.3 按钮=取消/完成（真实决策 `bridge.js:545-556`） | BSK 协助通知无按钮；借用通知有 Allow/Deny | **ALIGN** | 删按钮 1（dashboard，无 0.3/BSK 对应）；按钮 0 保留但改为“打开协助面”（若回答回页内，则为聚焦/激活请求标签页，0.3 行为）；或按 0.3 用 取消/完成 两个真实动作 | 需要把点击路由与页内/daemon 决策接好 |
| C3 | 协助通知点击 → 独立 popup 窗口 | `background.js:81-109` | 0.3 点击 → 激活请求标签页（`bridge.js:557-566`） | `lib/daemon-upgrade-notice.ts:106` `chrome.action.openPopup()` | **ALIGN** | 按 0.3：点击聚焦/激活请求所在标签页（页内协助卡在页内）；popup 打开可作为降级 | 若回答入口回页内，则必须聚焦标签页而非弹窗 |
| C4 | 借用系统通知（Allow/Deny 按钮） | `src/borrow.js:677`；`commands.js:568-572` | `src/action-notifications.js:47-55`、`bridge.js:551-554` | `tools/borrow-confirmation.ts:117-198,221`（Allow/Deny + onClicked/onButtonClicked） | **KEEP（对齐双方）** | 保留 | — |
| C5 | **工具栏徽标 `REC`** | `ui-compat.js:203,968-971`、`bridge.js:2919-2959` | **无**（0.3 无 `setBadgeText`） | `daemon-upgrade-notice.ts:40-52`（录制中 `REC`，`#dc2626`） | **KEEP（对齐 BSK）** | 保留 `REC`（含颜色/标题），移除 help 分支 | 徽标只应反映真实录制事实 |
| C6 | **工具栏徽标 `HELP`** | `ui-compat.js:203,957-967`、`bridge.js:2888,3007` | **无** | **无**（BSK 只有 `!` 升级与 `REC`） | **CUT** | 删 `ACTION_BADGE_TEXT.help`、`ACTION_BADGE_COLORS.help`、`ACTION_BADGE_TITLES.help`、`deriveLegacyBadge` 的 help 分支、`refreshActionBadge('help.*')` 调用 | 帮助状态仍由页内浮层/popup 卡展示 |
| C7 | 通知点击路由的 SW 全局快照 `__bridgeDeckHelpNotificationRouting` | `background.js:29-53,222-228` | 无（0.3 无） | 无 | **KEEP（测试/排障用，非用户面）** | 保留或随 C2 简化 | — |

### D. 页内浮层 / 内容脚本

| # | 功能 | 0.4 证据 | 0.3 证据 | BSK 证据 | 判定 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | 借用确认（页内卡 + 通知兜底 + fail-closed） | `content/borrow-confirm.js`（`#__bb04_borrow_confirm_host`）、`content/borrow-i18n.js`、`src/borrow.js:509` | `src/borrow-ui.js`、`overlay-ui.js` 借用卡、`action-notifications.js`、`human-decisions.js` | `content/BorrowConfirmationOverlay.tsx`、`tools/borrow-confirmation.ts` | **KEEP（对齐双方；0.4 不强制置前标签页是合理的改进，保留）** | 不改核心；12 语言去重（见 D6） | 0.4 的 `web_accessible_resources` 只服务于 i18n override（见 D6） |
| D2 | 协助页内卡（目标高亮 + 备注输入 + 完成/取消） | **缺失**：0.4 页内只有只读状态浮层；回答在 popup | `overlay-ui.js:237-404`（`helpOverlayFunc`：highlight + `.note` textarea + 取消/完成 → `bb.help.resolved`） | `HelpRequestOverlay.tsx`（`help-highlight`、`bsk-help-note-input`、Continue/Cancel）+ `help-request.ts` | **ALIGN（补 0.3/BSK 的页内回答）** | 在页内协助状态卡上加备注输入 + 取消/完成；内容脚本 → SW → daemon `session.answer_help`（0.4 已有该 RPC/白名单） | 页内文本不得携带 token；需 `document_idle` 注入、closed shadow、12 语言/RTL |
| D3 | 页内状态浮层（连接/human/paused/borrowed/help/record） | `content/status-overlay.js`（`#__bb04_status_overlay_host`，优先级 recording>help>disconnected>human>paused>borrowed，折叠/迷你，`role=status`） | 0.3 是**多个分面**浮层：`src/takeover.js:38`（接管卡，含暂停/收起/停止 `bb.takeover.stop/pause/minimized`）、`src/record-overlay.js:7`、help/borrow 卡 | `content/ControlOverlay.tsx`（`role=toolbar`，暂停/交还/停止/最小化）、`overlay-controller.ts`（互斥/抑制） | **KEEP + ALIGN** | 保留只读状态面；**补** 0.3/BSK 的控制动作（暂停/交还/停止）或明确声明“0.4 状态浮层只读”；读 `controlHint`（B3） | 只读面与 0.3/BSK 的“可操作控制面”偏离；补齐需要 cooperate 消息面 |
| D4 | 页内录制胶囊（计时 + Finish + 折叠/关闭 + 拖拽） | `content/record-capsule.js`（`#__bb04_record_capsule_host`，2s 轮询 `bb04.record.state`，Finish → `bb04.record.finish` → SW `record.stop`） | `src/record-overlay.js:7-76`（`__bb_record_host`，计时 + Finish + 拖拽；Finish → `bb.record.finish`） | `content/RecordOverlay.tsx`（计时 250ms、拖拽 8px、Finish） | **KEEP（对齐双方）** | 保留；**文案对齐语义**：0.4 记录的是 Agent 动作（TraceV3），不得写“正在录制你的操作”（0.3 人类示范语义） | 措辞误导是产品风险 |
| D5 | 胶囊“同页录制”提示（`role=note` 整句 + 12 语言） | `record-capsule.js`（`record.capsule.samePageHint`，`[KEY.HINT]` 12 个语言块）、popup README:489-492 | 无 | 无 | **CUT** | 删该提示文案/渲染/12 语言词条与相关断言 | 纯 0.4 自造说明 |
| D6 | 页内 12 语言词表（borrow/status/record 各带一份） | `content/borrow-i18n.js`（38 KB）、`status-overlay.js`（词表段）、`record-capsule.js`（词表段）；override `ui/locales/*.json` + `manifest.web_accessible_resources` | `src/overlay-locales.js`（33 KB，12 语言单表）+ `overlay-texts.js` | BSK 用 `@browser-skill/i18n` 包（~10 语言） | **ALIGN** | 12 语言保留；把三份内嵌表合并成一份共享 classic 词表（对齐 0.3 单表）；**删 override 层与 `web_accessible_resources`**（0.3 无此暴露） | 合并会触及 3 个脚本的加载顺序；override 删除需同步 borrow/status/record 的 fetch 代码 |
| D7 | 人类输入归因（arm → exact match → human.input） | `content/human-watch.js`（`bb04.human.arm`/`human.input`，±1.5ms/±2px/派生抑制） | `content/human-watch.js`（±10s 宽限缺陷）、`src/bridge.js:440,696` | `content/cooperation-capture.ts`、`browser-driver/native-input-*` | **KEEP（对齐 0.3 能力，不复制其缺陷）** | 保留 | — |
| D8 | 快路径 B `ext.collect`（页内 CompactTree v1） | `content/collect.js`（`__bb04Collect`）、`src/bridge.js:1694-1730`、`register.capabilities` 方法表 | 0.3 页内提取面：`injected/page-lib.js`（180 KB，动作/观测提取） | 提取走 CDP `Runtime.evaluate`（`tools/vom/capture.ts:342-378`），无 content-script collector | **KEEP（内部 seam，非用户功能）** | 保留且**默认关**（`BB_FASTPATH_B` 默认 false，`fastpath-b-e2e` opt-in）；**不新增 UI 入口**、不宣传为功能 | v1 仅主帧；启用前需产品决策 |

### E. 兼容层 / 消息 / dashboard

| # | 功能 | 0.4 证据 | 0.3 证据 | BSK 证据 | 判定 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | `bb.state/bb.call/bb.settings.set/bb.connection/bb.devices.list` 5 类兼容 | `ui-compat.js:80-86` | 0.3 popup/面板真实发送这些消息 | 无（BSK React 组件直连） | **KEEP（0.3 兼容层）** | 保留 | 白名单过宽也是风险面（见 E2） |
| E2 | 27 方法白名单 | `ui-compat.js:117-156` | 0.3 对应能力分散在 `bb.rec.*/bb.ops.*/bb.debug.*/…`（0.4 不搬） | BSK wire 方法 | **KEEP（按 A3 面板对齐后精简）** | 只保留对齐后 UI 真正使用的方法；未被任何面板使用的方法从白名单与 quick actions 表移除 | 白名单 = 攻击面；应最小化 |
| E3 | `bb.quick` 25 动作表 + `ui_compat.quick_actions` | `ui-compat.js:249-301` | 0.3 无 `bb.quick`（0.4-compat 自造信封） | 无 | **ALIGN/CUT 依 UI** | 快捷栏/更多菜单删除后，`quick_actions` 仅作为面板可用性来源保留（或并入 `read_methods`）；删除 `dashboard.open`、`help.answer`（若回答回页内）、`video.save`（若无 popup 表单）等无 UI 消费者的动作 | 删除时同步 `bb.state.ui_compat` 形状与测试 |
| E4 | `dashboard.open` 本地动作 + `bb.dashboard.url/port` | `ui-compat.js:219,229-238`；`background.js:122-153`；`popup.js` 记录卡/快捷栏 | 无 | 无 | **CUT** | 删 `UI_COMPAT_LOCAL_METHODS`、`DASHBOARD_SETTINGS_KEYS`、`DASHBOARD_OPEN_METHOD`、`openHelpDashboard`、记录卡 `#recordDashboard`、快捷栏 `#qaDashboard`、通知按钮 2 | 见 §4.12 |
| E5 | `bb.takeover.sync`（popup `?syncTest` 钩子） | `popup.js:760-770`；`ui-compat.js` 无 handler（0.3 亦无此消息） | 无（0.3 用 `chrome.scripting` 直接同步） | 无 | **CUT** | 删 `?syncTest` 钩子与死消息 | 纯诊断死码 |
| E6 | dashboard 帮助面（`GET /api/session/help`、`POST /api/session/help/answer`、`#detail-help*`） | `dashboard/help-handlers.mjs`、`dashboard/page-detail-script.mjs` | 无（0.3 协助在扩展页内） | 无（BSK 无 dashboard；协助在页内） | **CUT（0.4 范围外）** | 若执行：删 help-handlers 路由与页面 help 表单；否则必须在产品文档标记为 0.4 自建面并说明与页内回答的分工 | 三处回答面（popup/CLI/dashboard）重复、状态易分歧 |
| E7 | dashboard 产物面（`GET /api/video`、`GET /api/video/download`） | `dashboard/artifact-handlers.mjs`、`dashboard/page-detail-script.mjs`（下载锚点） | 0.3 视频页/操作录制页的文件列表与导出（`ui/record.js`、`ui/ops.js:90-95` 下载） | BSK 视频页/录制页（`entrypoints/video`） | **CUT（0.4 范围外）** | 若执行：删路由与页面下载入口；0.3/BSK 的产物浏览由扩展页承担 | 与 BSK 视频页重复 |
| E8 | `dashboard` 本体（status/trace/capture/HAR/accounts/tenant…） | `0.4/dashboard/**` | **无** | **无** | **冻结/单独立项（不属本次扩展审计删除范围）** | 本次只砍扩展入口与帮助/产物面；dashboard 作为 0.4 自建控制面由产品决策 | 若整体退役，影响 `--with-dashboard`、`dashboard-session-e2e`、`size-budget`、多份文档 |
| E9 | `web_accessible_resources: ui/locales/*.json` | `manifest.json:90-99` | 0.3 manifest **无**该字段 | BSK manifest 无 | **CUT（随 D6 override 层）** | 删 override 层与 manifest 条目 | 会缩小页面可读扩展资源面（安全收益） |
| E10 | popup 死钩子 `?selftest=a11y`/`?reload`/`?fixSettings`/`?guard`/`?preview` | `popup.js:1684-1702,771-811` | 0.3 有同类钩子（`popup.js:553-609`） | 无 | **KEEP（0.3 原样）**，仅 `?syncTest` 随 E5 删 | 保留（验收/排障依赖） | — |

---

## 4. 争议点逐项判决（12 项 = 任务清单 11 项 + 录制卡）

### 4.1 快捷栏 vs 0.3 popup 布局 → **CUT**

- **0.3**：popup 无快捷栏（`extension/ui/popup.html` 全文 275 行无 `#quickBar`/`.qa`）；入口是 `#openFeatures` → 5 features（2 击到面板）。
- **BSK**：popup 无快捷栏；头部 launcher → 5 features 列表（`features.ts:31-47`）。
- **0.4**：`#quickBar` 8 项 + 页脚 3 个入口（`popup.html:121-223`），并引入 `bb.quick` 25 动作表（`ui-compat.js:249`）。
- **理由**：快捷栏整体是 0.4 自造布局；每项能力在 0.3/BSK 都有既有入口（features/面板/设置/系统通知），只是换了位置。按用户口径=乱加。
- **动作**：删 8 项与页脚（见 §5.1 A5/A6/A12），popup 回到 0.3 布局 + BSK 的两块设置卡（控制提示、交互设置）。其余能力由 A3 面板与 C 通知承载。

### 4.2 更多菜单 vs BSK 5 个快捷图标 → **CUT**

- **0.3/BSK**：两边都只有“5 个快捷功能”（0.3 featuresView；BSK launcher）。0.3 的 5 个面板在 0.3 里**真实可用**（`src/bridge.js:313-447`），BSK 的 5 面板也真实可用。
- **0.4**：既保留 `#featuresView`，又新增 `#moreMenu` 9 项（视频×3、调试×3、长截图、账本、会话详情），造成同一能力两个入口。
- **理由**：9 项里 8 项是 5 面板能力的重复入口；`#moreSession`（本地只读会话详情）在 0.3/BSK 无对应面。
- **动作**：CUT `#moreMenu` 整组；把面板接真实后端（A3）；`#moreSession` 彻底删；视频保存改由视频面板/完整页。

### 4.3 记忆排序 → **CUT**

- **0.3/BSK 证据**：无（0.3 面板/列表顺序固定；BSK features 列表固定，`features.ts` 常量）。
- **0.4**：`bb.quick.recent`/`bb.quick.recent.more` 两键 + `#qaOrderReset` + 打开时前置（`popup.js:30-120`、`record-panel.js:132-205`）。
- **理由**：纯 0.4 自造 UX；不改变能力，只改顺序，且引入额外 storage 写与 E2E 断言。
- **动作**：CUT 两键、排序函数、重置按钮、相关 i18n 词条与 E2E 断言。

### 4.4 单键快捷键 → **CUT**

- **0.3**：无（popup 仅 `#labelInput` keydown；manifest 无 `commands`）。
- **BSK**：manifest 无 `commands`/`contextMenus`（`wxt.config.ts:35-72`）；内部设计简报也明确“无键盘快捷键体系，不要新增”（`docs/QUICK-ACTIONS-BRIEF.md:70-72`）。
- **0.4**：`r`/`d`/`?`/`Esc` + `Ctrl+Shift+R`/`Alt+R`/`Alt+Shift+D` + `aria-keyshortcuts` + 快捷键帮助层（`popup.js:1626-1676`）。
- **理由**：超出双方范围；且单键 `r`/`d` 在 popup 里与浏览器/输入法语义冲突面被自造规避（`isTypingTarget`），属于无证据的快捷键体系。
- **动作**：删 keydown 处理、`QUICK_SINGLE_KEYS`、`aria-keyshortcuts`、`#shortcutHelp*`、帮助文案；保留 0.3 的输入框 keydown。

### 4.5 帮助回答输入框 → **ALIGN**

- **0.3**：页内协助卡有备注 textarea + 取消/完成（`overlay-ui.js:237-404`），决定经 `bb.help.resolved` 回 SW；通知按钮=取消/完成。
- **BSK**：页内 `HelpRequestOverlay` 有 note input + Continue/Cancel（`help-request.ts`，`HelpRequestOverlay.tsx` 的 `bsk-help-note-input`）。
- **0.4**：只有 popup 表单（`#helpAnswer/#helpAnsweredBy/#helpAnswerSubmit`，`session.answer_help`）；页内状态浮层只读（`status-overlay.js` 只有折叠按钮）。
- **理由**：回答能力存在（双方都有），但 0.4 把入口从“页内 1 击”改成“打开弹窗再填表单”，且丢掉了 0.3/BSK 的页面内决策面。按“该有的对齐”应恢复页内输入。
- **动作**：ALIGN —— ①页内协助卡加备注 + 取消/完成（内容脚本 → SW → daemon `session.answer_help`，SW 已有白名单/RPC）；②popup `#helpCard` 保留为 pending/resolved 展示（可保留提交作为补充入口，但不得是唯一入口）；③删 dashboard 回答面（E6）避免三处回答。
- **风险**：页内回答必须复用 0.3 的安全边界（closed shadow、序列化注入、无 token）；0.4 不能在页面侧拿 daemon token。

### 4.6 badge HELP/REC → **ALIGN（保留 REC，砍 HELP）**

- **0.3**：无 badge（无 `setBadgeText`）。
- **BSK**：`daemon-upgrade-notice.ts:40-52`：升级问题 `"!"`、录制中 `REC`、否则空，颜色 `#dc2626`。**只有 REC，没有 HELP**。
- **0.4**：`HELP`（琥珀 `#d97706`）/ `REC`（红 `#dc2626`）双态（`ui-compat.js:202-212,937-975`）。
- **理由**：REC 有 BSK 证据 → 保留（帮助状态在 0.3/BSK 由页内浮层/通知表达，不需要 badge）。HELP 双方皆无 → 砍。
- **动作**：`deriveLegacyBadge` 只保留 recording 分支；删 HELP 文案/颜色/标题、相关刷新调用与 E2E 断言（`ui-help-e2e.mjs:12,814+`）。

### 4.7 系统通知 → **KEEP（并做 3 处对齐）**

- **0.3**：协助/借用通知 + 按钮（`action-notifications.js:26-58`；按钮回调 `bridge.js:545-566`）。
- **BSK**：协助通知（`human-loop.ts:866-886`，无按钮）、借用通知（`borrow-confirmation.ts`，Allow/Deny）、升级通知。
- **0.4**：协助通知（打包 PNG 图标 + `requireInteraction` + 2 按钮 + 独立 popup 窗口 + dashboard 路由）+ 借用通知。
- **理由**：通知能力双方都有 → KEEP。对齐点：①删 dashboard 按钮（C2）；②点击行为按 0.3 聚焦真实协助面（C3）；③删 `#helpNotify` 开关（B6）。
- **动作**：见 C1-C4/B6。

### 4.8 页内录制胶囊 → **KEEP（措辞对齐）**

- **0.3**：`src/record-overlay.js:7-76`（`__bb_record_host`，计时 + Finish + 拖拽，`bb.record.finish`）。
- **BSK**：`content/RecordOverlay.tsx`（计时 250ms、拖拽 8px、Finish，`data-phase` intro/timer）。
- **0.4**：`content/record-capsule.js`（`#__bb04_record_capsule_host`，2s 轮询、Finish→`record.stop`、折叠/关闭/拖拽、12 语言 RTL）。
- **理由**：双方同面 → KEEP。差异：0.3/BSK 的录制对象是**人类示范**；0.4 是 **Agent TraceV3**。0.4 不得沿用“正在录制你的操作”语义；`role=note` 同页提示是 0.4 自造（D5）→ 砍。
- **动作**：保留胶囊；改文案为中性“录制中/Rec”；删同页提示；Finish 语义保留（停止 daemon 录制）。

### 4.9 状态浮层 → **KEEP + ALIGN**

- **0.3**：接管浮层（`src/takeover.js:38`，含 controller/paused/minimized、暂停/收起/停止 → `bb.takeover.pause/stop/minimized`）+ 录制/协助/借用分面浮层（`overlay-state.js` 互斥优先级）。
- **BSK**：`ControlOverlay.tsx`（`role=toolbar`，暂停/交还/停止/最小化）+ `overlay-controller.ts` 互斥/抑制。
- **0.4**：合并成一个只读状态胶囊（`content/status-overlay.js`），只有折叠按钮；隐藏键 `bb04.ui.statusOverlayHidden` **无人写入**（options 页无该控件，`options.html` 是 0.3 原样）。
- **理由**：状态浮层本身双方都有 → KEEP；但 0.4 偏离了“0.3/BSK 的可操作控制面”，且隐藏开关是死键。
- **动作**：ALIGN —— ①读 `controlHint`（B3）；②恢复 0.3/BSK 的页面控制动作（暂停/交还/停止）或明确文档化为“只读状态镜像”；③删死键 `bb04.ui.statusOverlayHidden`。

### 4.10 collect / 快路径 → **KEEP（内部 seam，默认关，无 UI）**

- **0.3**：页内提取存在（`extension/injected/page-lib.js` 180 KB，动作/观测提取）。
- **BSK**：提取走 CDP `Runtime.evaluate`（`tools/vom/capture.ts:342-378`），无 content-script collector。
- **0.4**：`content/collect.js` + `ext.collect`（`src/bridge.js:1694-1730`），默认关，daemon `treeProvider` opt-in，E2E `fastpath-b-e2e.mjs`（106/106×2），`[2]` 方法表通过 `register.capabilities` 发现。
- **理由**：observe/snapshot 能力 0.3/BSK 都有；collect 是 0.4 的实现路径（default-off、无用户入口），不是新增用户功能 → 保留，但**不得默认开启、不得做 UI 入口、不得宣传为功能**。
- **动作**：KEEP，补“默认关 + 无 UI”的文档声明；method 表保持现状。

### 4.11 借用人机确认 → **KEEP**

- **0.3**：页内确认条 + 通知按钮 + 60s 超时 + fail-closed（`src/borrow-ui.js`、`overlay-ui.js`、`action-notifications.js`、`human-decisions.js`），0.3 会强制激活标签页。
- **BSK**：`BorrowConfirmationOverlay.tsx` + `tools/borrow-confirmation.ts`（active tab 页内条；inactive → 通知 Allow/Deny；60s；fail-closed）。
- **0.4**：`content/borrow-confirm.js`（`#__bb04_borrow_confirm_host`、倒计时 ring、Esc=拒绝、`role=dialog`、≥44px、reduced-motion、RTL）+ inactive → `chrome.notifications`（`borrow.js:677`）+ 注入失败/受限页 `E_BORROW_CONFIRM_UNAVAILABLE`；**不强制激活用户标签页**（README:290，改进点）。
- **理由**：双方都有且 0.4 实现完整 → KEEP；不强制置前是合理偏离（保留）。仅需 D6 词表合并与 E9 资源面收缩。
- **动作**：KEEP；顺手对齐 D6（合并词表、删 override）。

### 4.12 dashboard 帮助/产物入口 → **CUT**

- **0.3**：无 dashboard（无 HTTP server）。对应面：扩展内 `audit.html/record.html/ops.html/debug.html/longshot.html` 页与面板。
- **BSK**：`apps/` 只有 `extension`；对应面同样是扩展内页面/面板。
- **0.4**：`dashboard.open` 本地动作、`#qaDashboard`、`#recordDashboard`、通知按钮 1、`bb.dashboard.url/port`；dashboard 侧 `/api/session/help`、`/api/session/help/answer`、`/api/video`、`/api/video/download` 与页面 `#detail-help*`、下载锚点。
- **理由**：dashboard 是 0.4 自建控制面（Wave C/D 战略项），0.3/BSK 完全没有对应物；“帮助/产物入口”同时制造了三处回答面（popup/CLI/dashboard）与两处产物面（扩展页/dashboard）。
- **动作**：CUT 扩展侧全部 dashboard 入口（E4）；CUT dashboard 帮助/产物路由与页面入口（E6/E7）；dashboard 本体冻结/单独立项（E8）。
- **风险**：dashboard 删除面大（~13k 行 + 测试 + 门禁 + 文档），建议作为独立任务；扩展侧入口可以先行删除（互不阻塞）。

---

## 5. 砍掉清单（精确到文件与入口）

> 顺序即建议执行顺序：P0 = 纯删除/无依赖；P1 = 需同步测试/文档；P2 = 需要产品决策（dashboard 本体）。

### 5.1 P0：popup / 面板删除点

**`0.4/extension-ingress/ui/popup.html`**
1. 删除 `#quickBar` 整段（`:121-223`）：`#quickBarItems`、`#qaRecord/#qaHelp/#qaBorrow/#qaCopyTrace/#qaDashboard/#qaPause/#qaScreenshot/#qaSettings`、`#qaOrderReset`、`#shortcutHelpOpen`、`#qaMore`、`#moreMenu`（含 9 个 `.menu-item`：`#moreVideoStart/#moreVideoStop/#moreVideoSave/#moreDebugStart/#moreDebugStop/#moreDebugExport/#moreLongshot/#moreAudit/#moreSession`）、`#moreStatus`、`#moreReasons`、`#videoSavePanel`、`#recordNavWarn`、`#quickStatus`、`#quickReasons`、快捷键说明行（`:222`）。
2. 删除 `#shortcutHelp` 整段（`:451-468`），含 `#shortcutHelpTitle/#shortcutHelpList/#shortcutHelpClose`。
3. 删除 `#helpNotify` 设置行（`:409-420`）。
4. 录制卡改为 BSK 形态（`:311-353`）：保留 `#recordPurpose` + `#recordPurposePresets`；新增起始 URL 输入与只读 prompt + 复制按钮；删除 `#recordState/#recordTimer/#recordMeta/#recordStart/#recordStop/#recordClear/#recordSummary/#recordSummaryMeta/#recordDigest/#recordStepTable/#recordSteps/#recordStepsEmpty/#recordExport/#recordCopyCli/#recordDashboard/#recordActionStatus/#recordSummaryNote`。
5. 帮助卡（`:225-242`）：保留 `#helpCard/#helpState/#helpMeta/#helpMessage/#helpResolvedText`；回答输入 `#helpAnswerArea`（`#helpAnswer/#helpAnsweredBy/#helpAnswerSubmit/#helpAnswerDismiss/#helpAnswerStatus`）在页内回答落地后可删（依赖 D2）。

**`0.4/extension-ingress/ui/popup.js`**
6. 删除 import（`:7-18`）中 `QUICK_BAR_DEFAULT_IDS/QUICK_RECENT_KEY/QUICK_RECENT_MORE_KEY/QUICK_SINGLE_KEYS/normalizeQuickRecent/orderIdsByRecent/readQuickRecent/rememberQuickRecent/clearQuickRecent`。
7. 删除记忆排序（`:30-120`）、快捷键帮助（`:122-165`）、帮助通知开关（`:240-262,321-345,465-472`）、qaPause/qaSettings（`:833-877`）、更多菜单（`:879-1210,1511-1624`）、视频保存/导航警告（`:1248-1497`）、键盘处理（`:1626-1676`）、`?syncTest`（`:760-770`）。
8. 删除 `moreState/moreActiveId` 等仅更多菜单使用的模块级状态；`refresh()` 里对 `renderMoreMenu` 的调用（`:311`）一并删。

**`0.4/extension-ingress/ui/panels/record-panel.js`（1922 行，删除后应接近空/整合进 popup 的小模块）**
9. 删除快捷栏部分：`QUICK_DEFS`（`:55-62`）、`QUICK_BAR_DEFAULT_IDS`（`:68-77`）、`ROLE_PATTERNS/ROLE_FALLBACK_METHOD/ROLE_LABEL`（`:80-117`）、`quickStorage/normalizeQuickRecent/orderIdsByRecent/readQuickRecent/rememberQuickRecent/clearQuickRecent`（`:123-205`）、`capabilityState/matchRole/findEntry/roleMethod/roleAvailability`（`:251-334`）、`quickAvailability/renderQuickBar`（`:700-788`）。
10. 删除 TraceV3 录制工作流：`RECORD_STORAGE_KEY/SCHEMA/MAX_ROWS/TRACE_STORAGE_LIMIT`（`:24-32`）、`RECORD_PURPOSE_KEY` 保留（若保留 purpose）、`stepRowOf/summarizeTrace/canonicalJson/toHex/digestOf/backendDigest/traceFileName`（`:335-448`）、轮询/计时/摘要/导出/持久化/恢复（`:468-698,790-1260,1600-1922` 中相关工作流函数）、`#recordExport/#recordCopyCli/#recordDashboard` 绑定。
11. 帮助卡：保留 `renderHelpCard/dismissHelpCard`、`helpOutcome` 事实回显（若 popup 仅展示）；删除 `submitHelpAnswer`（`:1463-1524`）——前提 D2 页内回答已落地；否则保留并标注“过渡”。
12. `mountQuickRecordPanel/mountQuickRecordPanelOnce/restoreRecordWorkflow/currentRecordController`（`:468,1901-1922`）删除或替换为 `mountRecordPromptPanel`。

**`0.4/extension-ingress/ui/popup.css`**
13. 删除 0.4 新增样式块：`.quick-card/.quick-bar/.qa/.quick-more/.order-reset/.more-toggle/.menu/.menu-item/.save-panel/.warn-panel/.shortcut-help*/.record-*`（popup.css 19,044 B 相对 0.3 的 13,098 B 增量部分）；保留 0.3 样式。

**`0.4/extension-ingress/ui/i18n.js`**
14. 删除为上述删除面新增的词条（快捷操作/更多/录制卡/帮助卡/快捷键/dashboard/记忆），保留语言键桥接（`bb.uiLang` ↔ `bb04.ui.language`）与 0.3 词条。同步 `ui-i18n.test.mjs` 的键数断言。

### 5.2 P1：对齐/删除点（src、content、background、manifest、dashboard）

**`0.4/extension-ingress/src/ui-compat.js`**
15. 删 `UI_COMPAT_LOCAL_METHODS`（`:219`）与 `DASHBOARD_SETTINGS_KEYS/DASHBOARD_OPEN_METHOD/MAX_DASHBOARD_URL_LENGTH`（`:229-238`）及 `dashboard.open` 分支与 quick action（`:290-296`）。
16. 删 `HELP_NOTIFY_SETTINGS_KEY`（`:201`）及 `bb.state.help_notify` 字段/分支（`:1240` 附近）。
17. `deriveLegacyBadge`（`:937-975`）：删 help 分支；`ACTION_BADGE_TEXT/COLORS/TITLES` 只留 recording（`:202-212`）。
18. 快速动作表（`:249-301`）：删除无 UI 消费者的动作（`dashboard.open`、`help.answer`（若 D2 页内回答落地）、`video.save`（若删 popup 表单）、`session.open/close`（若面板不使用））；`UI_COMPAT_QUICK_ACTIONS` 改名或降级为内部可用性表（与测试同步）。
19. 白名单（`:117-156`）：按 A3 面板实际使用最小化；至少保留 `record.*/trace.*/debug.*/video.*/ledger.*/screenshot.capture/tab.borrow/session.*/help.*`，未被任何面板调用的方法删除。
20. `UI_COMPAT_SUPPORTED_TYPES` 不变；`bb.*` unsupported 表（`:11-27`）中把已由面板改发 `bb.call` 的类型补进说明（文档项）。

**`0.4/extension-ingress/src/bridge.js`**
21. 删 `HELP_NOTIFICATION_BUTTON_OPEN_DASHBOARD`、`HELP_NOTIFICATION_BUTTONS[1]`（`:126-131`）、`createHelpNotifier` 的 dashboard 相关文案/按钮、`help_notify` 开关读取（`:535` 附近）、help 徽标刷新（`:2888,3007`）。
22. 保留 `REC` 徽标、通知创建/清理、`ext.collect`、`ext.arm_input`、人类输入归因、借用/会话/生命周期、页内录制胶囊 handler（`record.state/finish`）。

**`0.4/extension-ingress/background.js`**
23. 删 `openHelpDashboard`（`:122-153`）、`HELP_NOTIFICATION_BUTTON_OPEN_DASHBOARD` import/分支（`:20-25,205-208`）、`routingState` 中 dashboard 相关字段（可按需保留快照）。
24. 通知点击对齐 C3（按 0.3 聚焦标签页）或保留 popup 打开作为降级（需明确写）。

**`0.4/extension-ingress/src/borrow.js` / `commands.js` / `sessions.js`**：不改（借用确认、会话/窗口/生命周期能力属 0.3/BSK 对齐面）。

**`0.4/extension-ingress/content/status-overlay.js`**
25. 删 `SETTINGS_KEY='bb04.ui.statusOverlayHidden'` 分支（`:79`），改读 `bb.settings.controlHint`（经 `bb.state`/`storage.onChanged`）；如需保留全局隐藏，写入点必须是 0.3 的 `controlHint`。
26. （ALIGN）恢复 0.3/BSK 页面控制动作（暂停/交还/停止），或文档明确“只读镜像”。

**`0.4/extension-ingress/content/record-capsule.js`**
27. 删 `record.capsule.samePageHint` 文案/渲染/相关 12 语言词条与断言；措辞改中性（不得暗示“录制你的操作”）。

**`0.4/extension-ingress/content/borrow-confirm.js` / `borrow-i18n.js` / `status-overlay.js` / `record-capsule.js`**
28. （ALIGN/D6）合并三份内嵌 12 语言表为一份共享 classic 词表；删除 `ui/locales/*.json` override 与 `manifest.web_accessible_resources`（`manifest.json:90-99`）。

**`0.4/extension-ingress/manifest.json`**
29. 删 `web_accessible_resources` 段（随 D6）；权限不再新增（`tabs/windows/storage/alarms/scripting/tabGroups/notifications` 保留，均 ≤0.3 权限集且 0.3/BSK 都在用）。

**`0.4/extension-ingress/ui/panels/{audit,debug,longshot,ops,video}-panel.js`（ALIGN，不是删文件）**
30. 消息替换：
    - `bb.rec.state/start/stop` → `bb.call video.status/start/stop`（daemon 原生面，已存在）；
    - `bb.debug.current/start/stop` → `bb.call debug.status/query/start/stop`；
    - `bb.capture`（长截图）+ `bb.manual.*` → `bb.call screenshot.capture {fullPage:true}`（自动模式）；手动拼接能力 0.4 无对应 RPC → 如实禁用并给 CLI 指令；
    - `bb.audit.list` + `settings.auditEnabled` → `bb.call ledger.list`（只读）；`audit.request`/`session.run_log` 若加入白名单则显示真实运行记录；
    - `bb.ops.*`（人类操作录制）→ 0.4 无人类示范录制数据面（TraceV3 只录 adapter 动作）→ 按 0.3 语义无法对齐：要么如实禁用 + “复制 CLI 指令”，要么重命名“Agent 录制”并接 `record.*`（需产品决策，禁止点了就失败）。
31. 面板的“打开完整页”按钮保留（0.3 原样），但完整页本身的数据面同样按上述替换；`ui/record.html`（0.3 视频页）在 0.4 无 `bb.rec.*` 后端 → 对齐到 daemon `video.*` 或隐藏入口。

**`0.4/dashboard/**`（P2）**
32. 若执行 CUT：删 `help-handlers.mjs` 的 `GET /api/session/help`、`POST /api/session/help/answer`；删 `artifact-handlers.mjs` 的 `/api/video/download`；删 `page-detail-script.mjs` 的 `#detail-help*` 表单与产物下载锚点；同步 `dashboard/README.md` 路由表、`dashboard/server.test.mjs`、`dashboard-session-e2e.mjs`、`stage-gate.mjs` 的 `--with-dashboard`、`0.4/dashboard/size-budget.json` 与 0.4 文档。若产品决定保留 dashboard，则至少删除扩展侧入口（E4），并在产品文档声明 dashboard 为 0.4 自建面。

### 5.3 需要一并删除的测试断言（不弱化，只删除被砍面）

见 §7；原则：**删除“为已砍功能写的断言”，不降低任何剩余断言的严格度**。禁止把 `checksTotal>=N` 之类门槛下调来“过”。

---

## 6. 保留 / 对齐清单

### 6.1 KEEP（直接保留，写明对齐边）

| 面 | 对齐 | 说明 |
| --- | --- | --- |
| 借用确认（页内条 + 通知兜底 + fail-closed） | 0.3 + BSK | `content/borrow-confirm.js`、`borrow-i18n.js`、`src/borrow.js`；不强制置前标签页（0.4 改进，保留） |
| 借用通知（Allow/Deny） | 0.3 + BSK | `src/borrow.js:677`；`action-notifications` 语义 |
| 协助系统通知 | 0.3（+BSK 图标做法） | 保留创建/清理/打包 PNG；删 dashboard 按钮与开关（C2/B6） |
| 页内录制胶囊 | 0.3 + BSK | 保形态；改措辞（非人类示范）；删同页提示 |
| 页内状态浮层 | 0.3 + BSK | 保只读状态面；补 `controlHint`/控制动作或明确只读 |
| 人类输入归因 | 0.3（修其缺陷）+ BSK 同面 | ±1.5ms/±2px/派生抑制 |
| `ext.collect` 快路径 B | 0.3 页内提取模型 | 默认关、无 UI、内部 seam |
| 5 快捷功能入口与 5 面板 | 0.3 + BSK | 面板数据面 ALIGN（§5.2-30） |
| options 页 + 12 语言/RTL/i18n 桥接 | 0.3 原样 | `options.html` 逐字节同构；`i18n.js` 语言桥接保留 |
| 连接/配对/设备/任务/meta | 0.3 原样 | `bb.state/bb.connection/bb.devices.list` 兼容层 5 类 |
| `privacy.js`（CSP 修复） | 0.3 能力 + MV3 合规 | 不是新功能 |
| `quick.html` 5 项页 | 0.3 原样 | 不新增入口（0.3 也不可达） |
| 逐项死钩子 `?selftest/?reload/?fixSettings/?guard/?preview` | 0.3 原样 | 仅 `?syncTest` 删（E5） |
| 权限最小面（无 debugger/tabCapture/offscreen…） | 0.3 子集 + BSK | 保持 |

### 6.2 ALIGN（按已有能力恢复/改写）

| 项 | 对齐边 | 动作 | 验收 |
| --- | --- | --- | --- |
| 5 面板数据面 | 0.3（真实可用） | 消息改 `bb.call/bb.quick`（§5.2-30） | 每个面板真实读写一次 + 不可用时有真实 reason |
| `#controlHint` | 0.3 + BSK | 状态浮层读它（B3） | 开关往返：浮层显示/隐藏 |
| `#cooperationGuard` | 0.3 + BSK | 恢复输入锁或删开关（B4） | 开：点击/滚动被拦；关：不拦 |
| `#pageGuard` | 0.3 | 路由尊重设置或删 checkbox（B5） | 关：不移动标签；开：移回 |
| `allowHelp` 生效 | 0.3 + BSK | 拒绝协助请求的路径可见 | 关：请求被拒且原因可见 |
| `borrowConfirm` 生效 | 0.3 + BSK | 设置键与 config 的统一（R4） | 开：弹确认条；关：直接借用 |
| 录制卡 | BSK（prompt 面板） | §4.10/A10 | 生成命令可运行；无假成功 |
| 帮助回答输入 | 0.3 + BSK（页内） | §4.5/D2 | 页内回答→daemon 记录→popup 显示已解决 |
| 徽标 | BSK（REC） | §4.6/C5-C6 | 录制中 `REC`；无 help badge |
| 通知按钮/点击 | 0.3 | §4.7/C2-C3 | 按钮动作真实；无 dashboard |
| 12 语言词表 | 0.3 单表 | D6 | 12 语言 + RTL 仍全过 |
| `ops` 面板语义 | 0.3（人类示范）或 BSK（Agent 录制） | 产品二选一（§5.2-30） | 不许“点了就失败” |

---

## 7. 受影响测试 / E2E / 门禁 / 文档

### 7.1 单元测试（`0.4/extension-ingress/test/`，全部已由 `0.4/scripts/test-all.mjs` 收集）

| 文件 | 现状（round 63） | 影响 | 动作 |
| --- | --- | --- | --- |
| `ui.test.mjs` | 46/46 | 快捷栏 8 项、更多菜单、录制卡、记忆、快捷键、帮助卡、`#helpNotify` | 重写为对齐后的面；保留 0.3 外壳/面板/借用/状态断言 |
| `ui-help.test.mjs` | 通过（test-all 收集） | popup 回答表单、badge、通知开关 | 按 §4.5/4.6/4.7 改写；补页内回答用例 |
| `background.test.mjs` | 13/13 | 通知两按钮、点击路由（弹窗/降级/dashboard） | 删 dashboard 路由用例；保留创建/清理/图标/失败降级；补“聚焦标签页”用例 |
| `ui-compat.test.mjs` | 35/35 | 5 类消息、27 白名单、25 quick actions、badge 派生、`dashboard.open`、`help.answer`、脱敏 | 更新白名单/动作表/badge；删 `dashboard.open`/`help_notify`/HELP 用例；**不得**降低脱敏/未连接 fail-closed 断言 |
| `ui-i18n.test.mjs` | 通过 | 新增键的 12 语言 parity（`popup.control.*` 等） | 删被砍词条，保留语言键桥接/12 语言/RTL 用例 |
| `record-capsule.test.mjs` | 38/38 | 胶囊状态机/Finish/12 语言/同页提示 | 删同页提示断言；补中性措辞断言 |
| `status-overlay.test.mjs` | 通过 | 状态优先级/折叠/`bb04.ui.statusOverlayHidden` | 改为 `controlHint`；若补控制动作则加用例 |
| `borrow-confirm-ui.test.mjs` / `borrow-i18n.test.mjs` / `human-match.test.mjs` / `collect.test.mjs` | 通过 | 保留面 | 基本不动；borrow-i18n 若合并词表则同步 |
| `smoke.mjs`（standalone，347/347） | 方法表/内容脚本扫描/断线/fail-closed | 若 manifest 删 `web_accessible_resources`、内容脚本集合不变 | 同步 manifest 断言；不降断言数 |

### 7.2 E2E（`0.4/tests/`，全部 opt-in，不在默认门禁）

| 文件 | 现状 | 影响 | 动作 |
| --- | --- | --- | --- |
| `ui-quick-record-e2e.mjs` | 198 checks | 快捷栏 8 项、录制卡、记忆、快捷键帮助层、胶囊 | 拆分为“胶囊 + 录制 prompt”最小 E2E；删快捷栏/录制卡/记忆/快捷键断言 |
| `ui-more-menu-e2e.mjs` | 185 checks | 更多菜单 9 项、视频保存、菜单记忆 | **删除**（含 `--with-more-menu` 门禁步骤，见 7.3） |
| `ui-help-e2e.mjs` | 74 checks | HELP badge、通知两按钮、popup 回答、默认门禁断言 | 删 badge/仪表盘按钮/开关断言；按 §4.5/4.7 改；保留通知真实 create ok:true、CLI 回答、过期/重复拒绝 |
| `ui-popup-e2e.mjs` | 150 checks | popup 外壳 + 页脚/快捷键/`#helpNotify` 断言 | 删被砍面断言；保留 0.3 外壳/options/借用确认/RTL |
| `ui-visual-baseline.mjs` | 3 页基线（popup/options/dashboard 详情） | popup 初屏变化 → 必须重录 | 用一次专用 `--write-baseline` 重录 `0.4/tests/fixtures/ui-baseline/*.json`，verify 两次；**不得**放宽容差 |
| `ui-parity-e2e.mjs` | 0.3 vs 0.4 像素 parity（7 变体） | 当前 popup 追加面已破坏 0.3 parity（15 项静态状态断言之外，整页像素无法一致） | 砍完后应恢复 PASS；作为“回到 0.3 外壳”的验收步骤重跑（`--repeat 2 --evidence`） |
| `borrow-confirm-e2e.mjs` / `extension-ingress-e2e.mjs` / `fastpath-b-e2e.mjs` / `cooperate-attribution-e2e.mjs` | 82/128/106/129 checks | 保留面 | 基本不动；`extension-ingress-e2e` 若断言 badge/通知则同步 |
| `dashboard-session-e2e.mjs` | 45 checks | dashboard 帮助/产物 | 若 E6/E7 执行 → 删除/重写；若 E8 冻结 → 保留但标记 0.4 自建面 |

### 7.3 门禁与脚本

- `0.4/scripts/stage-gate.mjs`：删 `--with-more-menu` 步骤；`--with-quick-record` 改名/收窄为 `--with-capsule`（或并入 `--with-ui`）；`--with-help`/`--with-ui`/`--with-ui-visual` 保留（断言更新）；`--with-dashboard` 视 E8；步骤计数/矩阵注释与 `0.4/STATUS.md` 的 19..34 组合表同步，**不得**改默认 19/20/21 语义。
- `0.4/scripts/test-all.mjs`：文件集合不变；用例数会下降（删除被砍面用例），必须在文档如实记录（不是“覆盖率下降”而是“范围收缩”）。
- `0.4/scripts/size-budget` 相关：`0.4/dashboard/size-budget.json` 的 ingress UI 上限在 round 60 为适配新增面从 524,288 B 提到 **655,360 B**；砍掉后可在一次“容量-only”变更里降回（当前 UI 约 534 KB，砍后会低于 0.3 的 ~380 KB 量级），但**必须与代码删除同批**，不得为了过门禁单独提额。
- `0.4/scripts/product-compliance.mjs`：本审计不删除任何产品可见品牌文案；不变。
- `0.4/scripts/build-extension-ingress.mjs`：staging 文件清单若删 `ui/locales/*.json` 需同步（当前 glob 无匹配时会怎样需复核）。

### 7.4 文档（需要同步，避免“文档宣称已对齐/已可用”）

- `0.4/extension-ingress/README.md`（762 行）：§335-560 是本次删除/对齐的主要章节（UI 面、快捷栏/更多菜单/录制工作流/胶囊/帮助/badge/通知/兼容层/gates/E2E 计数）；§167-334（collect/human-watch/借用确认/状态浮层）需按 D4/D6 微调。
- `0.4/dashboard/README.md`（路由表、help/artifact 段、非目标段）——若 E6/E7/E8 执行。
- `0.4/STATUS.md`、`docs/TEST-STATUS.md`、`docs/HANDOFF-2026-11-23-session-loss.md`、`docs/0.4-CAPABILITY-ACCEPTANCE.md`：round 56-63 的“已落地/check 数/steps 矩阵”表述。
- `docs/0.4-BEYOND-BSK.md`：Wave D 1b-1h 与 round 60-63 段落中的 quick bar / memory / shortcuts / HELP badge / dashboard help-answer 描述；把“已落地”改为“已砍/已对齐”。
- `docs/UI-PARITY-REPORT.md` §7.1（“5 个快捷功能/交互差距”表）与 §5 像素基线结论。
- `docs/PANELS-PORT-PLAN.md`、`docs/QUICK-ACTIONS-BRIEF.md`（内部资料，标注“后续落地被本审计否决/收窄”）、`docs/UI-DESIGN-BRIEF.md`、`docs/MERGE-0.3-0.4.md`、`docs/COMPARISON-BSK-0.5.0.md`、`docs/BSK-0.5.0-GAPS.md`（若引用上述面）。
- `0.4/FINAL-AUDIT.md`、`0.4/ROUND-644-REPORT.md`：如引用 UI 面/E2E 计数需复核。
- 商店/隐私文档（`docs/STORE-*`、`docs/privacy-policy.html`）：本次不含可见文案变更；若删 `helpNotify`/dashboard 入口，隐私说明中“界面入口”描述需同步。

---

## 8. 风险与开放问题

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 快捷栏/录制卡删除后，用户失去“popup 内开始录制”的能力 | 录制改为 Agent/CLI 发起（0.3/BSK 语义），但用户需要看到命令 | 录制卡按 BSK 给 prompt+复制；文档/README 明确 `bridge ... record start` |
| R2 | 5 面板数据面映射是“重写”而非“删除”，容易做成假成功 | 面板仍点了失败，与砍前等价 | 统一 `bb.call` 通道 + 每个动作真实 reason + E2E 真实后端断言；未实现的能力如实禁用 |
| R3 | 帮助回答回页内 = 新增内容脚本消息面 | 安全边界（token 泄漏/XSS） | 复用 0.3 `bb.help.resolved` 模式：页面只发 request_id/note，SW 持有 daemon token；closed shadow；12 语言/RTL |
| R4 | `borrowConfirm`/`allowHelp`/`cooperationGuard`/`pageGuard` 的“设置键 vs 实际读取点”不统一 | 设置开关与行为不一致（当前 3 个是假开关） | 每个开关配一条 DOM 往返 + 行为断言；删掉未实现的开关 |
| R5 | dashboard 范围大（~13k 行 + 6 个 E2E/门禁/文档/预算） | 一次任务做不完，易夹带 | P2 单独立项；扩展入口（E4）先删，dashboard 本体冻结为“0.4 自建面” |
| R6 | 删除会改变 popup/options 像素基线 | `ui-visual-baseline` 必红 | 专用 `--write-baseline` 重录 + verify 两次；不放宽容差；不自动写 |
| R7 | 12 语言词表三份重复合并 | 改动横跨 3 个内容脚本 + override 删除 | 先合并词表再删 `web_accessible_resources`；borrow-confirm 注入顺序保持“顺序无关” |
| R8 | 录制胶囊语义（人类示范 vs Agent 录制）与 BSK 不同 | 文案误导用户以为在“学习人类操作” | 中性文案；不得复用 0.3“正在录制你的操作”句 |
| R9 | `quick.html`/`preview.html` 等 0.3 页在 0.4 数据面缺失 | “有页面没数据” | 随面板映射一起处理；不新增入口；无法对齐的按钮禁用 + CLI 指令 |
| R10 | E2E check 数下降会被误读为覆盖退化 | 文档/STATUS 数字 | 在 STATUS/TEST-STATUS 注明“范围收缩导致用例删除，非断言放宽”；保留的 check 数不变 |
| R11 | `bb.quick.recent*` 键残留会影响老用户 storage | 无害但是死数据 | 删除时不做迁移（0.4 未发布给普通用户）；若已发布，加一次 `storage.local.remove` 清理 |
| R12 | 0.3 冻结区 / `dist` / `D:\CTRM自动录入` 被误改 | 违反冻结约束 | 本审计只读；执行任务必须重新声明写域，禁止触碰 |

---

## 9. 建议执行顺序与验收口径

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | popup/面板纯删除（§5.1） | `node 0.4/extension-ingress/test/ui.test.mjs` 等单测在删除对应用例后全绿；`ui-parity-e2e.mjs` 恢复 PASS（0.3 外壳） |
| P1a | 5 面板数据面 ALIGN（§5.2-30） | 真实 headed Edge：每个面板至少 1 个真实读写；不可用项 disabled + 真实 reason；无假成功 |
| P1b | 设置开关对齐（B3/B4/B5/B1/B2） | 每个开关：DOM 往返 + 行为断言（显示/拦截/路由） |
| P1c | 帮助回答回页内 + 通知对齐（D2/C2/C3） | `ui-help-e2e` 改后：页内回答 → daemon 记录 → popup 显示；通知真实 create + 点击聚焦；无 dashboard |
| P1d | badge REC only + 删 HELP（C5/C6） | `chrome.action.getBadgeText` 录制中=`REC`，无 `HELP` |
| P1e | 词表合并 + 删 `web_accessible_resources`（D6/E9） | borrow/status/record 12 语言 + RTL 全过；manifest 无 WAR |
| P2 | dashboard 入口/帮助/产物 CUT（E4/E6/E7） | 扩展侧无 `dashboard.open`/`bb.dashboard.*`/通知按钮 1；dashboard 若保留则在文档标记自建面 |
| P3 | 文档/STATUS/基线同步（§7.4/7.2） | 文档与代码一致；E2E 计数如实记录；`ui-visual-baseline` verify 全绿；门禁默认语义不变 |

**总原则**：删的是“0.3/BSK 没有的入口与自造状态”，补的是“0.3/BSK 已有但 0.4 丢了/假了的能力”；不新增任何 0.3/BSK 之外的权限、消息面或 RPC；任何不可用都必须是“如实禁用 + 真实原因”，不得空成功。
