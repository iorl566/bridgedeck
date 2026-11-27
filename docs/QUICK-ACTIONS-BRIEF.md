# 快捷操作与录制工作流设计简报（R1 / task-139）

> **内部设计资料，只读审计产出。不得进入 0.4 产品路径**：不复制到 `0.4/`、不作为产品文档发布或引用、
> 不进入发布物（README/商店页/CLI help/MCP 描述/HTML 文案）。本文中的参考产品名称/路径仅用于内部溯源；
> 产品面对外一律称 BridgeDeck 0.4 自身设计。
>
> - 审计对象：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src`（只读学习设计模式；
>   **未复制代码、文案、图标、布局或组件标识**）。
> - 目标：BridgeDeck 0.4（0.3.0 冻结）。本文只给建议，**不改产品代码、不装依赖、不跑门禁**。
> - 审计方式：逐文件阅读 + i18n 键结构提取 + 与 0.4 现有 daemon RPC/ingress UI 对照；行号即证据。
> - **快照与并发提示**：审计窗口为 2026-11-25 00:10–00:30（Asia/Shanghai）。期间并行任务正在修改
>   `0.4/daemon/server.mjs`、`0.4/daemon/transport.mjs`、`0.4/extension-ingress/src/ui-compat.js`
>   （观测到 00:22–00:24 落地 `record.status` / `trace.get` / `trace.list` 与 `bb.call`/`bb.quick` 白名单）。
>   因此本文对**参考产品**用行号证据，对**0.4 活动文件**用符号名（函数/常量/方法名）为主；
>   落地前须按当前树复核一次，行号可能已漂移。
> - 结论一句话：参考产品的"快捷"核心不是更多按钮，而是 **弹窗 2 击内到达 + 页内 1 击兜底 + 一次性动作用"复制指令给 Agent"代替自建控制台**；
>   0.4 移植后的 5 个快捷面板目前**数据面全是 typed unsupported**，录制语义也与参考产品不同（0.4 录的是 Agent 动作，不是人类示范），
>   因此最小落地必须先补"后端映射 + 如实失败态"，而不是先做视觉。

---

## 1. 审计范围（实际读过的内容）

| 区域 | 文件 | 读到的设计信息 |
| --- | --- | --- |
| 弹窗主视图 | `entrypoints/popup/App.tsx`、`features.ts`、`current-tasks.tsx`、`debug-panel.tsx` | 主视图卡片顺序、快捷功能入口、5 项 feature 列表、状态反馈体系 |
| 弹窗面板 | `entrypoints/popup/video-panel.tsx`、`long-screenshot.tsx`、`components/audit-panel.tsx` | 面板内状态机、复制 prompt、进度/计数/列表、空态与错误态 |
| 页内浮层 | `content/RecordOverlay.tsx`、`ControlOverlay.tsx`、`HelpRequestOverlay.tsx`、`BorrowConfirmationOverlay.tsx`、`overlay-controller.ts`、`overlay.css` | 浮层形态、可拖拽、状态优先级、互斥/抑制规则、ARIA |
| 录制采集 | `content/record-capture.ts`、`record-hover-surface.ts`、`lib/recording/types.ts`、`lib/record-bridge.ts` | 录制步骤类型（click/hover/fill/press/select/scroll/switch_tab/navigate）、脱敏、焦点/悬浮面判定 |
| 录制后端 | `tools/record.ts`、`entrypoints/background.ts`、`lib/recording/*` | `record.start/step/stop/await` 生命周期、重试/rearm、失败文案策略 |
| CLI 契约 | `crates/bsk-cli/src/cli/record.rs`、`recipe.rs` | trace bundle 落盘（`trace.json` + `states/`）、24h await、Finish 语义、recipe 与录制的边界 |
| 文案结构 | `packages/i18n/src/locales/*/extension.json` | 命名空间与键结构（`popup.record.*`、`recordOverlay.*`、`controlOverlay.*`、`video.*`、`longScreenshot.*`、`debug.*`、`audit.*`、`cooperation.*`、`borrowConfirmation.*`、`helpRequest.*`） |
| 0.4 现状 | `0.4/extension-ingress/ui/**`、`src/ui-compat.js`、`content/status-overlay.js`、`manifest.json` | 移植后 DOM、`bb.*` 兼容层支持面、现有页内状态胶囊 |
| 0.4 后端 | `0.4/daemon/server.mjs`、`0.4/daemon/transport.mjs`、`0.4/packages/browser-adapter/src/record-handlers.js`/`trace-recorder.js`、`0.4/packages/protocol/src/methods-legacy.js` | 已有 RPC、路由白名单、TraceV3 录制对象、声明未实现的接口 |

**证据约定**：本文行号指上表文件；参考产品源码仅作只读证据，不进入 0.4 产品树。

---

## 2. 参考产品快捷操作清单

### 2.1 入口与最少点击

| # | 动作 | 最少点击 | 默认位置 | 状态反馈方式 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Q1 | 打开快捷功能总入口 | 弹窗内 1 击（浏览器工具栏图标 → 弹窗） | popup 头部右侧图标按钮（`aria-expanded`） | 头部标题切换 + 返回按钮 + 图标显隐 | `App.tsx:147-192`、`features.ts:31-47` |
| Q2 | 进入某个快捷面板（5 项：视频/调试/长截图/操作录制/操作审计） | 再 1 击（总入口 → 面板） | popup 内 `features` 子视图（列表项 2 行文案 + 图标 + chevron） | 子视图标题 + 返回；部分面板另有"打开完整页"按钮 | `App.tsx:379-405`、`App.tsx:196-409` |
| Q3 | 连接开/关 | 1 击 | popup 主视图连接卡片 | 圆点颜色 + 状态标签 + 版本偏斜 badge/警告 + 连接开关 `role=switch` | `App.tsx:198-298`、i18n `popup.stateLabel/stateBadge` |
| Q4 | 复制实例 ID / 复制启动指令 | 1 击 | popup 主视图底部 meta / 浏览器配置区 | 图标短暂变对勾 + 1.5s 后复原；剪贴板失败回退 | `App.tsx:95-99`、`App.tsx:348-375` |
| Q5 | 控制提示开/关 | 1 击 | popup 主视图开关卡片 | `role=switch` + 说明气泡（`aria-describedby`） | `App.tsx:300-323` |
| Q6 | 复制"录制指令"给 Agent | 3 击（入口→操作录制→复制） | popup 操作录制面板 | 只读 prompt 文本域 + 复制按钮 + 复制 toast；未连接禁用并给提示 | `App.tsx:411-491` |
| Q7 | 视频：开始/停止任务级录像 | 有活动录制时 2–3 击 | popup 视频面板 + 独立视频库页 | 状态文本/剩余时长/进度 + 停止/中断 + 最近录制列表（完整/部分/未保存） | `video-panel.tsx:49-212` |
| Q8 | 调试：开始/停止采集、看证据 | 2–3 击 | popup 调试面板 + 独立调试页 | 收集中/已停止、三项计数（操作/请求/异常）、证据跳转、复制 prompt | `debug-panel.tsx:39-182`、`current-tasks.tsx:7-45` |
| Q9 | 长截图：开始/暂停/续/结束/预览 | 面板内 1–2 击 | popup 长截图面板 + 预览页 | 阶段文案 + 百分比 progressbar + 尺寸 + 部分完成提示 + 内联错误（按错误码映射） | `long-screenshot.tsx:72-241` |
| Q10 | 审计：开关 + 展开完整审计 | 1 击 | popup 审计面板 + 独立审计页 | 开关 + 最近任务列表（状态/操作数/错误数/partial 标记）+ 轮询刷新 | `audit-panel.tsx:83-190` |
| Q11 | 页内"结束录制" | 1 击 | 页内录制浮层（底部居中胶囊，可拖拽） | 红色脉冲点 + 首 10s 文案后切计时 `mm:ss` + 圆形 Finish；`data-phase` 标记 intro/timer | `RecordOverlay.tsx:155-283` |
| Q12 | 页内暂停/交接/停止任务 | 1 击 | 页内控制浮层（`role=toolbar`） | 模式图标 + 状态标签 + 提示 + 主按钮（暂停/交还）+ 停止 + 最小化（迷你胶囊） | `ControlOverlay.tsx:112-228` |
| Q13 | 页内人工协助完成/取消 | 1 击 | 页内协助浮层（可拖拽，目标元素高亮） | 目标高亮框 + 面板状态 + 可选备注 + 完成/取消/收起 + `aria-live` | `HelpRequestOverlay.tsx:14-29`、i18n `helpRequest.*` |
| Q14 | 借用标签页允许/拒绝 | 1 击 | 页内借用确认浮层 + 系统通知按钮 | 倒计时圆环 + 允许/拒绝 + 超时自动拒绝（fail-closed）+ 结果 toast | `BorrowConfirmationOverlay.tsx`、`tools/borrow-confirmation.ts:117-198` |
| Q15 | Agent 需要协助/借用被借用等系统级提醒 | 0 击（通知弹出） | 操作系统通知（按钮式）+ 工具栏徽标 | 通知点击数打开弹窗（`chrome.action.openPopup`）；升级用 badge 文本+背景色+title | `lib/daemon-upgrade-notice.ts:48-140`、`background.ts:532-554` |

### 2.2 放置位置规律（可迁移的设计模式）

1. **常驻状态 = popup**：连接态、实例名、当前任务、开关、复制类动作。弹窗内保持"主视图一屏内可完成"。
2. **一次性/可复制动作 = popup 面板**：录制指令、调试 prompt、视频 prompt 都走"生成文本 → 复制"，
   UI 不自己承担长流程控制台（详见 §3.1）。
3. **进行中的会话态 = 页内浮层**：控制、录制、协助、借用都在页面浮层中，1 击可执行；
   浮层与 popup 通过后台/存储同步，**关闭 popup 不中断操作**（`long-screenshot.tsx:24-49` 从 `chrome.storage` 回读）。
4. **系统级 = 通知 + 徽标**：借用允许/拒绝可从系统通知直接完成；版本不匹配用徽标提示。
5. **没有**：`chrome.commands` 键盘快捷键、`action.onClicked` 快捷启动、右键菜单。
   manifest 未声明 `commands`/`contextMenus`，全部快捷路径都是 popup/浮层/通知。
   → 0.4 若要"更快"，应先考虑工具链（命令行/Agent 指令），不要新增无证据的快捷键体系。

### 2.3 状态反馈规律（可迁移的反馈矩阵）

| 反馈类型 | 使用场景 | 参考实现要点 |
| --- | --- | --- |
| 行内状态文本 + aria-live | 面板内状态、进度 | `role=status`/`aria-live=polite`；错误 `role=alert` |
| 图标对勾 + 短暂 toast | 复制成功 | 1.5s 自动隐藏，重复复制重置计时（`App.tsx:44-77`） |
| 禁用 + 原因提示 | 未连接、无活动任务 | 按钮 disabled 且给出可读原因，不静默 |
| 计数/摘要卡 | 调试、审计、视频 | 大数字 + 标签；列表行带状态与数量 |
| 页内胶囊 | 会话进行中 | 优先级互斥（见 §3.2）；折叠/最小化；可拖拽 |
| 确认/倒计时 | 高风险动作（借 tab） | 倒计时自动拒绝，明确默认安全 |
| 徽标/通知 | 需要用户注意但不在当前页 | badge 文本/颜色/title + 通知按钮 |

---

## 3. 参考产品录制工作流（完整交互链）

### 3.1 开始：purpose/目标由用户输入，开录由 Agent/CLI 执行

- popup「操作录制」面板只有两个输入：**主题（可选，用于 LLM 上下文）**、**起始 URL（可选）**；
  下方只读 prompt 生成完整命令行（包含 browser 实例、URL、purpose 与 3 步操作说明），一键复制给 Agent。
  面板本身 **没有"开始录制"按钮**（`App.tsx:411-491`、i18n `popup.record.promptTemplate`）。
- CLI 侧 `record start`：先起 daemon/session，再 `record.start`（携带 `session_id`、`url`、`purpose`、
  `max_page_tokens`、`redact_values`、`trace_version=3`、`supports_tab_switch_steps=true`），
  然后阻塞在 `record.await`（上限 24h），直到用户在浏览器点 Finish 或终端 `record stop`。
  URL 缺省用固定 http(s) 落地页（`crates/bsk-cli/src/cli/record.rs:51-100`、`apps/extension/src/tools/record.ts:130-133`）。
- 设计意图：**录制是"用户示范 + Agent 观察"的协作动作**，Agent 必须持有会话/窗口上下文，
  所以 UI 只负责"把意图参数化并交给 Agent"，避免扩展自己成为录制调度器。

### 3.2 录制中指示：极简、可拖动、事件驱动

- 页内胶囊（底部居中，固定定位、zIndex 最高、可拖拽、8px 阈值、视口内 clamp）：
  - 首 10s：红色脉冲点 + "正在录制你的操作"文案；
  - 10s 后：同一点 + `mm:ss` 计时；宽度收窄到固定值，数字用等宽数字（`RecordOverlay.tsx:155-255`）。
  - 计时基准来自后台记录的 `startedAtMs`，**跨导航连续**；250ms 刷新（`RecordOverlay.tsx:82-98`）。
  - 唯一动作：圆形 Finish 按钮（`aria-label` 有可读名），点击后发 `RECORD_FINISH`（`RecordOverlay.tsx:257-283`）。
- **没有**步数、没有暂停、没有时间轴/缩略图。录制中的"进度感"只靠计时与脉冲点。
- 互斥规则：录制浮层出现时隐藏"Agent 正在控制"控制浮层；Finish 后到 session teardown 之间继续抑制，
  避免控制遮罩闪一下；录制清理时同时清零 automation-bypass 计数（`overlay-controller.ts:171-180`、`clearAgentRecordRequest`）。
- 后台侧保证：`RECORD_START` 内容脚本 ack 失败会重试 3 次；页面导航/重新注入时用 `RECORD_QUERY` rearm
  恢复浮层；`RECORD_STOP` 只清浮层，已捕获步骤保留（`tools/record.ts:113-119, 517-533, 853-960`）。

### 3.3 停止与摘要：UI 只"点结束"，摘要交给 trace bundle + Agent

- 停止路径：
  1) 页内 Finish → `RECORD_FINISH` → 后台 finish（最多 10 轮排空步）+ `record.stop` → 返回 `{ trace }`；
  2) 终端 `record stop` 作为 fallback，可在 `record start` 被 await 阻塞时执行。
- CLI 落盘：`<output>/trace.json` + `<output>/states/*.txt`（默认 `./trace`），并打印
  "saved N steps … M states"、trace 版本、路径；v2 回退时给警告（`record.rs:301-362`）。
- **UI 没有步骤表/耗时卡/失败列表**；摘要由 Agent 读取 bundle 后生成（`popup.record.promptTemplate` 第 3 步）。
  失败态：flush 失败返回可重试错误（提示重试 `record stop`，录制仍 active）、未导出恢复
  （`record stop --output` 恢复上一次未导出的录制）（`record.rs:299-305`、`record.ts:1105-1130`）。
- 步骤语义（供 0.4 摘要表设计参考）：`click | hover | fill | press | select | scroll | switch_tab | navigate`；
  `fill` 带值/提交方式/脱敏标记；目标含 name/role/ref/ctx；状态是观察快照（state-action-state）
  （`lib/recording/types.ts:47-85`、`content/record-capture.ts`）。
- 敏感输入：密码等敏感控件值置空/打码，不进入 trace（`record-capture.ts:17-18`）。

### 3.4 导出/回放/复用（保存 recipe 的边界）

- 导出：就是 trace bundle 目录（JSON + states 文本），可直接给 Agent/人工阅读。
- **回放/recipe 与录制是两件事**：参考产品明确 recipe 是"显式、可审阅、只回放已确认的只读/可逆步骤"的文件，
  不是录制自动生成、也不是逐步复演录制（`crates/bsk-cli/src/cli/recipe.rs:1-10`）。
- 复用方式：把 trace bundle 作为上下文交给 Agent，"下次做类似任务"由 Agent 重新决策，而不是机械重放。
- 结论：**不要**把"录制 → 自动 recipe → 一键回放"当成参考产品的既有能力；0.4 也没有 recipe 平面（见 §4.2）。

---

## 4. 与 0.4 后端映射建议

> 0.4 现状三句话：
> (a) daemon 已有一套**会话级** record/trace/video/debug/cooperate RPC，但录制对象是 **Agent 通过 adapter 执行的动作**
> （state-action-state），不是人类示范；
> (b) 审计窗口内并行任务已把 `record.status` / `trace.get` / `trace.list` 落到 daemon，并在
> `src/ui-compat.js` 增加通用 `bb.call` / `bb.quick` 通道（白名单：录制/追踪/诊断只读 + 会话请求 + 账本）；
> (c) 但**移植的 0.3 面板仍只发旧的 `bb.ops.*` / `bb.rec.*` / `bb.debug.*` / `bb.capture` / `bb.audit.*`**，
> 这些类型仍是 typed `E_UI_COMPAT_UNSUPPORTED`；面板必须先改发 `bb.call`/`bb.quick`（产品代码小改）
> 才有数据面，否则"点了就失败"。

### 4.1 已有可用的 0.4 daemon RPC（直接能支撑快捷动作）

| 快捷动作 | 0.4 RPC（daemon 名） | 现状/证据（审计快照；标"已落地"的仍需落地前复核当前树） |
| --- | --- | --- |
| 开始/停止录制（TraceV3） | `record.start`（`sessionId,url?,purpose?,redactValues?`）→ `{sessionId,recording,recordingId,started_at,start_url,purpose,redacted}`；`record.stop` → `{trace}` | **已实现**（`server.mjs` 的 `recordStart/recordStop`；`transport.mjs` METHODS_04） |
| 录制中状态（时长/步数） | `record.status`（`sessionId`）→ `{recording,started_at,started_at_ms,duration_ms,url,purpose,states,steps,skipped}` | **审计窗口内已落地**（`server.mjs` `recordStatus` + `transport.mjs` 路由） |
| 录制历史/摘要读取 | `trace.get`（`sessionId`）→ 摘要 + `duration_ms` + sha256 `digest` + `trace`；`trace.list`（`limit?,sessionId?,include_trace?`）；另有 `record.list`/`record.get` | **审计窗口内已落地**（`server.mjs` `traceGet/traceList`、`recordList/recordGet`） |
| 会话历史聚合（live+finished） | `session.run_log`（含 live `status:"recording"` + steps/states 聚合） | 已实现（`server.mjs` `sessionRunLogBsk`；`transport.mjs` BSK_METHODS） |
| 可恢复启动（含"开始即录制"） | `session.request`（prepare/status/cancel/claim）+ `session.start_tracked`（= session.start + record.start） | 已实现，token 10min、同参重试复用（`server.mjs` `sessionRequestBsk/sessionStartTrackedBsk`） |
| 视频录制（daemon 侧） | `video.start/stop/status/list/save/discard` | **已实现**，CDP screencast + H.264/fMP4（`transport.mjs` METHODS_04 + `session-video`） |
| 网站调试 | `debug.start/stop/status/query/export` | **已实现**，会话级 CDP 采集（`server.mjs` `debug*` 路由） |
| 借用/归还/策略 | 实际通道：ingress `ext.tab_borrow`/`ext.tab_return`（0.3 `bb.borrow.*`）；协议声明 `tab.borrow`/`tab.return`/`tab.policy` | 借用有真实 chrome 状态 E2E（`0.4/tests/extension-ingress-e2e.mjs`）；协议名未在 UI 兼容白名单放行 |
| 人机协作/接管 | `cooperate.enable/sync/status/wait` | 已实现（`server.mjs` `cooperate*`）；`session.claim_control/release_control/handoff/control_mode` 仅协议 legacy 声明（无 handler） |
| 审计/操作历史 | `session.run_log`、`audit.request`（WAL+traces 摘要） | 已实现（`server.mjs` `sessionRunLogBsk/auditRequestBsk`）；`audit.list`/`operations.list/get` 仅协议 legacy 声明 |
| 截图/长截图 | **daemon 无路由**；0.4 CLI 走 CDP `Page.captureScreenshot`（`--screenshot` / `--full-screenshot`，含分块拼接） | `0.4/cli/bridge-remote.mjs`；`screenshot.manual.*`/`longshot.recover` 仅 legacy 声明 |

### 4.2 缺口（需补 / 建议不补），只列 0.4 RPC / 消息名

> 相对审计早期观察，`record.status`、`trace.get`、`trace.list` 已被并行任务落地（00:22 左右），
> 不再列为缺口；下表是**复核后仍缺**的部分。

| 名称 | 现状 | 建议 |
| --- | --- | --- |
| `record.await` | adapter 有 `tool.record_await`（`0.4/packages/browser-adapter/src/record-handlers.js`），daemon 无路由 | UI 不需要阻塞：用 `record.stop` + `record.status`/`trace.get` 轮询即可；若 CLI/Agent 需要则补路由 |
| `record.step` / `record.append` | 不存在 | **人类示范录制**所需（内容脚本把人类步骤送入录制器）；属新平面，最小版本不建议（见下"语义缺口"） |
| 录制状态事件推送 | ingress 有 `bb04.status.event` 通道与 `recording.started/stopped` 胶囊槽位（`content/status-overlay.js`），但 daemon→ingress 无逐事件转发 | 补轻量事件转发，或 UI 用 1s 轮询 `record.status`；浮层不能"假装录制中" |
| 旧面板消息类型 `bb.ops.*`/`bb.rec.*`/`bb.debug.*`/`bb.capture`/`bb.audit.*` | `ui-compat.js` 顶部映射仍是 typed unsupported（0.3 消息不在新通用通道内） | 面板改发 `bb.call`/`bb.quick`（通用通道已落地）；`bb.quick` 当前放行：`session.open/close`、`act`、`record.start/stop/status`、`trace.get/list`、`debug.query/status`、`session.request`、`cooperate.status`、`video.status`、`ledger.list/pending`；**`session.start_tracked` 未放行** |
| `bb.quick` 明确不可用动作 | `help.request`/`tab.borrow`/`dashboard.open`/`screenshot.capture` 返回 typed `E_UI_COMPAT_UNAVAILABLE` + reason | UI 用 disabled + reason 展示；**不要**改成空成功；后续按需开新白名单（截图、借用） |
| `debug.start`/`debug.stop`、`video.start`/`video.stop`、`audit.request`/`session.run_log` | daemon 有实现，但**当前未进 `bb.call`/`bb.quick` 白名单**（只开了 `debug.query/status`、`video.status`） | 面板若要做"开始采集/开始录像/审计列表"，需按面板逐个扩白名单并写验收；否则只做只读面板 |
| 协议 legacy 死声明 | `trace.start/stop/status`、`session.claim_control/release_control/handoff/control_mode`、`screenshot.manual.*`、`longshot.recover`、`audit.list`/`operations.list/get` 在 `0.4/packages/protocol/src/methods-legacy.js` 有声明，daemon/ingress 无 handler | 补或从注册表移除；保留就必须实现，不能留 typed 空壳让外部按接口集成 |
| 权限面 | 0.4 ingress manifest 无 `debugger/tabCapture/offscreen/webNavigation`（`0.4/extension-ingress/manifest.json`） | 任何录制/长截图 UI 都不得为此加权限；录制/调试/视频走 daemon CDP；长截图暂不可用要如实提示 |

**语义缺口（最重要）**：0.4 的 `record.start` 录的是 adapter 动作（`0.4/packages/browser-adapter/src/trace-recorder.js:1-25`；
`action-handlers.js:5,197-211`），**没有"人类在页面上操作 → 变成 trace 步骤"的数据面**。
所以 0.4 快捷面板里的"操作录制"不能承诺参考产品那种"用户示范录制"；
最小可行定位是"**Agent 录制控制台/回看**"（开始/停止/摘要/导出），人类示范录制列为后续独立立项。

### 4.3 推荐的最小后端路径（0.4，基于当前已落地 RPC）

```
UI（popup 面板 / 页内胶囊）  —— 走 bb.call / bb.quick（不是旧 bb.ops.* / bb.rec.*）
  ├─ 会话准备：session.open（当前白名单）→ record.start{sessionId, purpose, url?}
  │     （或扩白名单后走 session.request{prepare} → session.start_tracked，一步含录制）
  ├─ 录制中：轮询 record.status{sessionId}（duration_ms / steps / states / skipped）
  ├─ 停止：record.stop{sessionId} → {trace}；再 trace.get{sessionId} 取摘要（duration_ms + digest）
  ├─ 复用：下载 trace.json（Blob，无需新权限）/ 复制摘要给 Agent
  └─ 失败：typed error 原样展示 + 重试；不转成功
```
视频/调试的"只读"面已可用（`video.status`、`debug.query/status`）；"开始/停止"需先扩白名单。
长截图在 0.4 **没有 daemon 路由**：UI 只能"复制 CLI 指令给 Agent"（`bridge ... --full-screenshot` 路径）
或明确 typed 不可用，不能承诺按钮直接出图。
审计：`ledger.list/pending` 已放行；`session.run_log`/`audit.request` 需扩白名单后才能展示真实运行记录。
页内"结束录制"需要 ingress 拿到 `sessionId`（`ui.status` 的 sessions_detail 有 session/tab 映射，
`0.4/extension-ingress/src/bridge.js`）。

---

## 5. 0.4 UI（已移植 0.3）可落地的最小改进清单

### 5.0 现状事实（决定改进顺序）

- 当前快捷功能 5 项：`视频录制`、`网站调试`、`长截图`、`操作录制`、`操作审计`
  （`0.4/extension-ingress/ui/popup.html:24-51`；独立页 `ui/quick.html` 同样 5 项，但**没有任何入口引用它**，
  只被单测直接打开 —— 属于"存在但不可达"）。
- 5 个内嵌面板 `#auditPanel/#longshotPanel/#videoPanel/#debugPanel/#opsPanel` 与全页
  `ui/ops.html`、`ui/record.html`（视频）、`ui/debug.html`、`ui/longshot.html`、`ui/audit.html` 都在，
  但面板仍发旧消息 `bb.ops.*`/`bb.rec.*`/`bb.debug.*`/`bb.capture`/`bb.audit.*` → **typed unsupported**，
  用户点按钮只会看到失败。审计窗口内已新增通用 `bb.call`/`bb.quick`（可用 RPC 见 §4.2），
  所以"最小改动"= 把面板消息改发通用通道 + 未开放能力如实 disabled，而不是重做页面。
- 命名冲突：0.4 里 `ops` = 操作录制、`record` = 视频录制；新增"Agent 录制"前必须先把用户可见文案改成
  不会混淆的名字（建议：`操作录制`→`Agent 录制`/`动作录制`；`视频录制`保持）。
- 页内已有状态胶囊 `[data-bb04-status-overlay]`（`.bb04-card`、`data-role=*`、`data-state/data-tone`、
  折叠/迷你态），且预留了 `recording` 状态键与 `recording.started/stopped` 事件槽位
  （`status-overlay.js:25-26,1244-1366,982-988`）——录制指示应复用它，而不是新造浮层。

### 5.1 快捷栏 8 项（5 项保留 + 3 项补/改；每项给 DOM 与验收）

| # | 快捷项 | 位置 | DOM/交互建议 | 数据源（RPC） | 验收（真实 Edge E2E 或 DOM 断言） |
| --- | --- | --- | --- | --- | --- |
| K1 | 连接状态与开关 | popup 主视图 | 维持 `#stateDot/#stateLabel/#connToggle`（`role=switch`）；新增 `data-bb04-conn-state` 便于断言 | `ui.status`（bridge 快照） | `node 0.4/tests/ui-popup-e2e.mjs`：dot 状态类 + `aria-checked` 往返；无控制台错误 |
| K2 | 复制启动指令 | popup 主视图 | 维持 `#copyCmd`；成功态 `aria-live` + 1.5s 复原；文本含实例/端口占位 | `bb.state`/`ui.status` | DOM：点击后按钮文案切换、clipboard 写入（失败路径回退 textarea）；E2E 断言复制内容不含 token |
| K3 | 快捷功能入口（5 面板） | popup 头部 | 维持 `#openFeatures` + `#featuresView`；每个面板入口加 `data-bb04-feature`；**未接数据面的面板给出"需连接/需 Agent"明确提示**，不静默失败 | 无（导航） | DOM：`aria-expanded` 往返、5 个 `.feature[data-page]` 可见、返回主视图 |
| K4 | Agent 录制（重构 ops 面板） | popup 面板 + 全页 | 新增 `#opsPurpose`（主题输入）、`#opsSessionTarget`（会话/tab 选择或只读当前）；`#opsStart/#opsStop/#opsStatus` 复用；按钮 pending/disabled 有因 | `bb.quick`：`session.open` + `record.start` / `record.stop` / `record.status` / `trace.get`（当前白名单已放行；`session.start_tracked` 需扩） | 真实 Edge E2E（扩展 `extension-ingress-e2e.mjs` 场景）：开录 → `#opsStatus` 出现计时 → 执行一次真实动作 → `#opsStop` → 摘要行数 ≥1、下载可用；失败注入 → typed 错误可见且不产生成功假象 |
| K5 | 视频录制 | popup 面板 + 全页 | 维持 `#videoStart/#videoStop/#videoStatus`；**当前只读**：`video.status` 可用、start/stop 未放行 → 按钮 disabled + "复制指令给 Agent"入口；有录像时显示状态/时长（自写文案） | `video.status`（只读）；start/stop 需先扩 `bb.quick` 白名单 | DOM：只读状态渲染 + 未开放按钮 disabled + reason；真实 E2E：在已有录像会话上 `video.status` 返回 recording/ready 如实显示 |
| K6 | 网站调试 | popup 面板 + 全页 | 维持 `#debugStart/#debugStop/#debugStatus/#debugHistory`；**当前只读**：`debug.query/status` 可用（可显示计数/证据），start/stop 未放行 → 面板先做只读+复制指令 | `debug.query` / `debug.status`（只读） | DOM：计数/证据渲染；真实 E2E：真实 debug run 上 `debug.query` 返回 requests>0；start 按钮 disabled + reason |
| K7 | 长截图 | popup 面板 + 全页 | 维持 `#longshotStart/#longshotOpen`；**当前不可用**（`bb.quick` 的 `screenshot.capture` 明确 typed unavailable）→ 按钮 disabled + 文案"复制指令给 Agent / 暂不可用" | 无 daemon RPC；CLI `--full-screenshot` 由 Agent 执行 | DOM：不可用 reason 可见、按钮 disabled、无假进度；E2E：点击不产生成功 toast |
| K8 | 操作审计 | popup 面板 + 全页 | 维持 `#auditToggle/#auditStatus/#auditOpen`；当前白名单只有 `ledger.list/pending` 只读 → 先显示"账本只读摘要"；`session.run_log`/`audit.request` 需扩白名单后才显示运行记录 | `ledger.list` / `ledger.pending`；后续 `session.run_log` / `audit.request` | DOM：账本摘要/空态如实；E2E：真实会话结束后若白名单未扩，列表保持如实空态（不伪造 run） |

> 说明：K4–K8 的"最小"= 只补数据面与失败态，不重做视觉；所有新增文案由 0.4 自写、走 `ui/i18n.js`，
> 键名/命名空间**不得**沿用参考产品（见 §6）。

### 5.2 录制工作流 5 步（0.4 最小闭环）

| 步 | 用户动作 | UI/DOM 交互建议 | 数据/RPC | 验收/失败态 |
| --- | --- | --- | --- | --- |
| R1 入口与目的 | 打开快捷功能 → Agent 录制 | `#opsPurpose`（可选主题）、`#opsSessionTarget`（当前会话/标签页，来自 `ui.status.sessions_detail`）；无会话时显示"复制指令给 Agent"入口 | `ui.status`（只读） | DOM：无会话时开始按钮 disabled + 原因；有会话时可选目标；不得把 tabId 当 sessionId 猜 |
| R2 开始 | 点"开始录制" | 按钮 pending（防重复）→ 录制中；显示 recordingId/主题/起始 URL；失败原位错误 + 重试 | 当前白名单：`session.open` → `record.start{sessionId,purpose,url?}`（两步）；扩白名单后可 `session.request{prepare}` → `session.start_tracked`（一步含录制） | 真实 Edge E2E：开录返回 recording=true；重复点击不产生第二会话；错误注入显示 typed error（含 `E_*` code），按钮回退 |
| R3 录制中指示 | 观察页内胶囊/面板 | 页内复用 `[data-bb04-status-overlay][data-state="recording"]` + 计时文本；popup `#opsStatus` 显示时长/步数；页内提供 `[data-bb04-record-stop]` 结束按钮（1 击）；**不做暂停**（0.4 无暂停录制 RPC） | 轮询 `record.status`（1s，轻量，返回 duration_ms/steps/states/skipped）；停止 `record.stop` | DOM：胶囊出现、计时递增、`aria-live` 不刷屏；真实 E2E：导航后胶囊仍在、计时不回零（用 daemon `duration_ms` 校准，不靠页面本地时钟）；断连时胶囊消失且面板提示，不伪造录制中 |
| R4 停止与摘要 | 点结束/停止 | 摘要卡：步骤数、op 分布（click/fill/select/navigate…）、起止时间/耗时、空 trace/步骤缺失/脱敏提示；步骤表 `[data-bb04-step-row]`（op/目标名/结果）；导出 JSON 按钮 | `record.stop{sessionId}` → `{trace}`；再 `trace.get{sessionId}` 取摘要（duration_ms/digest）；前端渲染，不经 Agent | 真实 E2E：执行 2 个真实动作后停止，摘要步骤数=2 且 op 正确；空录制给"未捕获步骤"提示；导出文件可 JSON.parse、digest 与 daemon 返回一致、不含敏感值 |
| R5 复用 | 复制/下载/再录 | "复制摘要给 Agent"（文本）；"下载 trace.json"（Blob + a download，无需权限）；"再次录制"复用主题/URL 生成**新** request token | 无新 RPC；下载在页面内完成 | DOM：下载触发且文件名含时间戳；再次录制生成不同 request_id（E2E 断言 daemon 侧两个 token）；**不提供"保存 recipe/一键回放"**（0.4 无 recipe 平面） |

### 5.3 验收与门禁建议（只作为建议，不在本任务执行）

1. **DOM 断言**（不需真实浏览器）：
   - `node 0.4/extension-ingress/test/ui.test.mjs`（面板入口/返回/开关）；新增断言用 `data-bb04-*` 选择器。
   - 失败态断言：模拟 unsupported/未连接，按钮 disabled + `[data-bb04-record-state="error"]` + 错误码可见。
2. **真实 Edge E2E**（opt-in，不默认进闸门）：
   - `node 0.4/tests/ui-popup-e2e.mjs`（真实 headed Edge + 真 MV3 + 真 daemon；DOM 级断言；禁词检查）。
   - `node 0.4/tests/extension-ingress-e2e.mjs`（真实 ingress chrome 状态；扩展录制场景：开录/停止/真实动作）。
3. **单测/门禁**：`node 0.4/scripts/test-all.mjs`；**合规**：`node 0.4/scripts/product-compliance.mjs --check`（hard 必须为 0）。
4. **权限零新增断言**：manifest diff 不得出现 `debugger/tabCapture/offscreen/webNavigation` 等；
   录制/调试/视频均走 daemon CDP 路径。
5. **不伪造成功**：任何未接数据面的按钮必须 disabled + 原因，或返回 typed error 并展示；禁止"空成功"。

### 5.4 建议的 DOM 命名（自定，与参考产品标识体系区分）

`data-bb04-record-state`（idle/preparing/recording/stopping/error）、`data-bb04-record-timer`、
`data-bb04-record-stop`、`data-bb04-step-row`、`data-bb04-record-summary`、`data-bb04-record-error`。
页内复用既有 `data-bb04-status-overlay`/`data-role`/`data-state`，**不要**新造参考产品风格的胶囊组件。

---

## 6. 禁止项

### 6.1 不复制参考产品的文案/图标/布局/组件标识

- 不复制任何界面文案（中/英/其他语言）、i18n 键名或命名空间（如 `recordOverlay.*`、`popup.record.*`、
  `controlOverlay.*`、`video.*`、`longScreenshot.*`、`debug.*`、`audit.*`、`cooperation.*`、
  `borrowConfirmation.*`、`helpRequest.*`）；0.4 自己的 i18n 键必须重新命名并走 `ui/i18n.js`。
- 不复制图标资产（录制圆点图标等）与图片；不把 `ref/` 里任何资产放进 `0.4/`、`dist/`、
  `web_accessible_resources` 或商店物料。
- 不复制布局与视觉参数：底部居中白色胶囊 + 脉冲红点 + 首段文案切计时 + 固定宽度数字等组合，
  以及拖拽阈值、计时刷新率、zIndex、阴影/圆角等具体数值，不得照搬；需要"录制指示"时基于 0.4
  既有 `[data-bb04-status-overlay]` 形态自行设计。
- 不复制组件标识：`data-slot="record-overlay-pill"`、`data-bsk-overlay`、`bsk-*` class、
  `OverlayController` 等命名；不照搬其组件/状态机结构到 0.4 代码。

### 6.2 产品面不出现其名称/来源

- 产品可见面（CLI usage/help、MCP/DSH 工具描述、错误消息、dashboard/extension 的 HTML/JS 文案、
  产品 README、商店 listing、隐私政策等）**不得**出现参考产品名、版本号、来源叙述
  （含 `BSK/BrowserSkill/BSK 0.5`、`bsk-*`、`borrowed from`/`inspired by`/`derived from`）。
- 合规闸门必须保持：`node 0.4/scripts/product-compliance.mjs --check` hard=0；新增文案先自查禁词。
- 本简报属内部资料：**不得**复制到 `0.4/` 产品路径、不得被产品文档/README 引用、不得随发布物分发；
  内部引用参考源码时用代码块包裹路径（避免被合规 ratchet 误计）。

### 6.3 工程约束（本次审计同时是纪律约束）

- 0.3.0 冻结：不改根 `extension/`、`lib/`、`daemon/` 等 0.3 产品代码。
- 本任务只写 `docs/QUICK-ACTIONS-BRIEF.md`；不改产品代码、不装依赖、不跑门禁。
- 不给 0.4 扩展新增权限（`debugger`/`tabCapture`/`offscreen`/`webNavigation` 等）；不回到扩展自录视频/自采 debug。
- 不把 typed unsupported 改成空成功；不承诺 0.4 不具备的能力（recipe 自动回放、暂停录制、人类示范录制）。
- 不改 manifest 的 `web_accessible_resources`；不顺手清理（如需清理另立任务）。

---

## 7. 风险与开放问题（交给后续任务决策）

1. **人类示范录制**在 0.4 无数据面（TraceV3 只记录 adapter 动作）。要么新立项（步骤摄入 RPC + 脱敏 +
   存储 + 回放语义），要么产品明确"录制=Agent 录制回看"，UI 文案不得暗示人类示范。
2. 协议注册与实现要对齐：`record.status`/`trace.get`/`trace.list` 已在审计窗口内落地，
   但 `trace.start/stop/status`、`session.claim_control/release_control/handoff/control_mode`、
   `screenshot.manual.*`、`longshot.recover`、`audit.list`/`operations.list/get` 仍是
   "注册表有、实现无"的 legacy 声明；保留就补，不保留就从注册表移除，避免外部调用方按接口存在去集成。
3. daemon→ingress **录制状态事件**缺失；页内胶囊目前只能轮询 `record.status` 或本地推断，
   要确保断连/会话结束时如实消失（`recording` 胶囊不许"假装"）。
4. tab → session 映射：页内"结束录制"需要把当前 tab 映射到 sessionId（`ui.status.sessions_detail` 可用），
   但借用/多会话时要 fail-closed，不能猜。
5. 0.4 命名冲突（`ops`=操作录制 / `record`=视频）必须先统一用户可见命名，否则"操作录制"和"视频录制"会互相误导。
6. `quick.html` 不可达：要么从 popup 增加"在标签页打开快捷功能"，要么删掉，避免"有页面没入口"。
7. 责任边界：trace 回看已有 dashboard `/api/trace`（但它是 `debug.query` 代理，不是 TraceV3 回看）；
   扩展内摘要卡与 dashboard 不要重复造同一套 trace UI，需定主入口（建议扩展摘要 + dashboard 详情）。

---

## 8. 证据索引（参考产品 → 0.4）

| 参考产品结论 | 参考证据（只读） | 0.4 对应事实 |
| --- | --- | --- |
| 快捷入口=popup 头部 + 5 feature 列表 | `entrypoints/popup/App.tsx:147-192,379-405`；`features.ts:31-47` | `ui/popup.html:24-51`、`ui/popup.js:267-318`（同构但数据面 unsupported） |
| 录制=复制指令给 Agent，UI 无开始按钮 | `App.tsx:411-491`；`crates/bsk-cli/src/cli/record.rs:51-100` | `ui/ops.html`、`ui/ops.js:110-133`（本地 bb.ops.*，typed unsupported） |
| 页内录制胶囊：脉冲+计时+Finish、可拖拽 | `content/RecordOverlay.tsx:155-283` | `content/status-overlay.js:1244-1366`（现有状态胶囊可复用，需接数据源） |
| 录制态与控制态互斥/抑制 | `content/overlay-controller.ts:120-180` | `content/status-overlay.js:718-790`（胶囊优先级） |
| 停止→trace bundle+Agent 摘要 | `tools/record.ts:1105-1130`；`record.rs:203-224,301-362` | `record.stop`→`{trace}`（`server.mjs` `recordStop`）+ `trace.get`（`traceGet`）摘要 |
| recipe 独立于录制 | `crates/bsk-cli/src/cli/recipe.rs:1-10` | 0.4 无 recipe 平面（不应承诺） |
| 借用/协助浮层 1 击 + 通知按钮 | `BorrowConfirmationOverlay.tsx`；`tools/borrow-confirmation.ts:117-198` | `content/borrow-confirm.js`（已移植，真实 E2E 覆盖） |
| 无键盘快捷键/右键菜单 | `apps/extension/wxt.config.ts` manifest（无 `commands`/`contextMenus`） | `0.4/extension-ingress/manifest.json`（同样无） |
| 快捷面板数据面：旧 5 类之外为 typed unsupported | — | `ui-compat.js`：顶部 0.3 消息表（`bb.ops.*`/`bb.rec.*`/`bb.debug.*`/`bb.capture`/`bb.audit.*` 仍 unsupported）；新增 `bb.call`/`bb.quick` 通用通道与白名单 |
| 录制对象=adapter 动作 | `lib/recording/types.ts:47-85` | `0.4/packages/browser-adapter/src/trace-recorder.js:1-25`、`action-handlers.js:197-211` |
| 录制写盘/恢复 | `record.ts` finish drain + retry | `0.4` trace store：`record.list/get`、`trace.list/get`（`server.mjs` `recordList/recordGet/traceList/traceGet`） |
