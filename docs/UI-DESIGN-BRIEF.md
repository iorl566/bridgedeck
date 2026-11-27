# UI Design Brief（G1 参考扩展 UI 学习审计）

状态：0.4 内部研究文档，**不进入任何产品包**（`0.4/**/dist*` 不得包含本文件或其截图）。
范围：只读审计参考产品扩展 UI，产出 0.4 **原创**界面的最小实现清单、信息层级与对接点。
约束：只描述设计模式；不抄代码/文案/图标/布局/标识；不改 0.4 产品代码；不起服务、不装依赖。

审计对象（只读）：
- 参考实现 UI 源码：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/`（popup、content 浮层、audit/debug/video/long-screenshot 全页、`packages/ui` 设计 token、`packages/i18n`）
- 0.4 现状：`0.4/extension-ingress/`（无 popup/options，仅有借用确认条 + 人类输入归因）、`0.4/packages/collaboration/src/overlay.js`、`0.4/packages/browser-adapter/src/overlay-render.js`、`0.4/daemon/extension-ingress.mjs`、`docs/PROTOCOL-METHODS.md`、`extension/ui/*`（0.3.0 冻结基线，9 页）

---

## 1. 参考产品的信息架构（事实）

| 表面 | 入口 | 职责 | 关键证据 |
| --- | --- | --- | --- |
| 浏览器工具栏 popup | `action` | 连接状态/开关、浏览器名、连接设置（本机端口/远程配对）、控制提示开关、自动化设置、当前任务、错误、版本页脚；二级功能列表与内嵌面板 | `entrypoints/popup/App.tsx`、`features.ts`、`connection-settings.tsx` |
| popup 内二级面板 | 功能列表卡片 | 录制指令复制、视频、长截图、审计、调试；各自一个子视图 + 返回 | `popup/*.tsx`、`components/audit-panel.tsx` |
| 全页查看器（新标签页） | popup 按钮/行内链接 | 审计时间线、调试控制台、长截图预览、视频播放库 | `entrypoints/audit|debug|long-screenshot|video` |
| 页内浮层：协作条 | 会话控制期间 | 状态 + 控制权按钮（暂停/交还/停止）+ 控制器身份 + 目标光圈 + 呼吸边框 + 输入遮罩 | `content/ControlOverlay.tsx`、`ControlGlow.tsx`、`ControlInputBlocker.tsx` |
| 页内浮层：借用确认 | tab 借用请求 | 活动 tab 用遮罩模态；非活动 tab 用右上角 toast 栈；倒计时环/进度条，超时自动拒绝 | `content/BorrowConfirmationOverlay.tsx` |
| 页内浮层：帮助请求 | 人类协助请求 | 目标高亮框 + 可拖拽/折叠横幅 + 备注输入 + 继续/取消 | `content/HelpRequestOverlay.tsx` |
| 页内浮层：录制指示 | 录制会话 | 可拖拽胶囊，前 10s 显示“录制中”后切 mm:ss 计时，完成按钮 | `content/RecordOverlay.tsx` |
| 系统通知 | 借用确认无法在页内渲染（非活动 tab/受限页） | 承载同一决策，避免“默认同意” | 参考实现 notification 路径 |

切换关系：
- popup 内部单一 `view` 状态机：`main → features → <feature>`，返回键回 `features` 再回 `main`；无独立 options 页，设置全部内嵌。
- popup 与后台是 **快照推送**（`chrome.runtime.Port` 收 `snapshot`，UI 只发 intent：`set_label`/`set_connection_enabled`）。
- 页内浮层是独立 content-script React 根，状态由后台 `OverlayController` 统一拥有；优先级规则：帮助/录制浮层存在时 **压掉**协作遮罩；用户可全局隐藏“控制提示”（状态卡/光圈/遮罩）；录制结束后抑制协作遮罩直到会话真正结束（防闪）。
- `Agent Window` 是浏览器级容器：任务 tab 借入/归还、任务结束时归还而非关闭用户 tab；popup 只显示当前任务，不管理窗口。

---

## 2. 关键交互（参考产品做法 → 0.4 应吸收的不变量）

| 主题 | 参考做法 | 0.4 应保留的不变量 |
| --- | --- | --- |
| 会话状态展示 | 状态点颜色 + 文案 + 徽章：connected（绿）/version_skew（琥珀）/disconnected（灰）/disabled（更淡灰）；`connecting` 在 UI 层被抑制避免闪烁；不匹配时给 protocol 版本说明 | 用**一个**状态词表跨所有表面；瞬时状态不刷新 UI（去抖）；状态颜色不是唯一信息（必须配文案/aria） |
| 借用确认 | 活动 tab：400px 模态 + 倒计时环 + 允许/拒绝 + 30 字标题截断；非活动 tab：toast 栈 + 进度条；倒计时归零自动拒绝（transitionend + 定时器双保险）；无“默认同意”路径 | 决策必须来自真实用户动作；超时/关闭一律 fail-closed；确认条不得为弹窗强行激活用户 tab |
| 人工接管 | 协作条显示模式：ready/acting（Agent 就绪/工作中）、human（你已接管）、editing（你在编辑）、held（Agent 暂停）、yielding（等待当前动作）、syncing（同步最新页面）、unavailable（页面不可用）；每种模式有固定图标 + 一句 hint；主按钮随模式在“暂停/交还”间切换 | 模式 → 图标 → 文案 → 主操作必须一一对应；控制权变化带 revision/epoch，UI 显示服务端权威值，不做乐观切换 |
| 帮助请求 | 目标选择器/矩形高亮随滚动/resize/500ms 刷新；备注可空；继续/取消；可折叠但目标高亮保留；紧凑模式去掉高亮 | 请求有超时与唯一 request id；结果回执（continued/cancelled）必须带备注；不允许重复提交 |
| 录制 | 胶囊可拖拽（8px 阈值），钳制在视口内；计时 250ms 刷新、tabular-nums；来源时间戳跨导航保持 | 录制状态跨页面导航仍准确；指示器不遮挡页面关键操作；结束入口始终可达 |
| 错误呈现 | 4 层：行内小字（hint）、红色 `role=alert` 块（可重试）、`role=alert` 升级公告（复制升级命令 + `<details>` 技术细节）、断连说明 | 错误分“可自愈/需用户操作/需升级”三类，文案给下一步动作；技术细节默认折叠 |
| 设置项 | 全部用同一 `Switch`（统一尺寸；层级靠文案/图标而非控件大小）；交互设置自动保存并显示 loaded/saving/error；连接设置分段控件（本机/远程）+ 配对链接 + 可选跳过校验 + 替换配对 `role=alertdialog` 二次确认 | 设置必须幂等、可回滚、有失败提示；危险操作二次确认；保存中禁用控件 |
| i18n 组织 | 2 命名空间（common/extension），键按表面前缀分组（popup./cooperation./helpRequest./recordOverlay./audit./debug./video./longScreenshot.）；10 语言；`chrome.i18n.getUILanguage()` 优先、与 `chrome.storage` 双向同步；中文按脚本/地区归一化 | 0 硬编码文案；新增语言 = 只加资源文件；插值变量统一 `{{name}}` 风格；键名表达语义而非英文句子 |

---

## 3. 视觉 / 布局 / 可访问性 / 主题 / RTL

| 维度 | 参考做法 | 0.4 决策建议 |
| --- | --- | --- |
| 组件分层 | popup 用共享 UI 包（button/badge/card/input/label，shadcn 风格 token：oklch CSS 变量 + `.dark` class + `radius`）；页内浮层独立手写 CSS 变量（暖橙系），互不复用 | 0.4 保持**自有** `--bb-*` token（`extension/src/overlay-theme.js`、`extension/ui/ui.css`）与蓝主色；popup 与页内浮层共享 token 名与圆角/阴影/间距刻度，不共享实现 |
| 状态色/图标语义 | 绿=在线、琥珀=版本偏差/警告、灰=断开、红=错误/危险、橙=协作高亮；图标：光标=Agent、手=人类、暂停=held、时钟=yielding、刷新=syncing、警告=unavailable | 0.4 沿用语义但用自有色值；禁止只用颜色区分（图标+文案+`aria-label`）；危险与警告分级 |
| 尺寸/密度 | popup 320–340px、卡片 12px 圆角、文字 10–14px、次级信息 10–11px；页内协作条 300px 固定右下、20px 圆角；触控 44px 最小按钮 | 0.4 popup 保持 352px 现状；给出 1 套类型/间距刻度表（10/11/12/13/14 与 4/8/12/16），新表面只允许引用刻度 |
| 可访问性 | `role=switch`+`aria-checked`；`role=status`+`aria-live=polite`；`role=alert`；`aria-describedby` 信息图标 tooltip；`aria-expanded` 折叠；icon-button 必有 `aria-label`；`focus-visible` ring；`prefers-reduced-motion` 关闭呼吸动画；粗指针 44px | 全部继承为**硬性要求**；页内 shadow DOM 浮层需 `:host` 隔离 + 不劫持焦点；倒计时必须同时有文本（秒数）与图形 |
| 主题 | popup 跟随 `prefers-color-scheme` 切换到 `.dark`；页内浮层有独立 dark 变量组 | 两处都要有 dark；dark 对比度按 WCAG AA 检查（0.4 已有 overlay-theme 对比度单测可扩展） |
| RTL | 参考实现页内样式多为 `right/left` 物理属性，RTL 覆盖有限；仅用户可控文本用 `<bdi>` | 0.4 必须更好：全部用逻辑属性（`inset-inline-*`/`margin-inline-*`/`text-align:start`）、方向性图标 `[dir="rtl"]` 镜像、`ui/direction.js` 首帧定方向；0.4 有 ar/he 两种 RTL 语言，浮层也要支持 |

---

## 4. 0.4 原创设计建议（可执行清单）

### 4.1 最小 UI 面（按优先级）

| ID | 表面 | 优先级 | 职责（一句话） | 实现落点（0.4） |
| --- | --- | --- | --- | --- |
| S0 | 状态 popup | P0 | 一眼看到“扩展↔daemon 是否通、当前有没有任务、要不要处理借用/帮助” | `0.4/extension-ingress/` 新增 `ui/popup.html|js|css` + manifest `action`（当前缺失） |
| S1 | 页内协作条 | P1 | 任务进行中显示控制权、主操作（暂停/继续/交还）与“停止任务” | content script host（新）+ 复用 `overlay-render.js` 的渲染约定（host id/`data-*` 动作属性/epoch 校验） |
| S2 | 借用确认 | P1 | 借用用户 tab 前拿真实决策，超时/失败一律拒绝 | `content/borrow-confirm.js` 改造（已有，见 §4.4 缺口） |
| S3 | 帮助请求 | P2 | 目标高亮 + 原因 + 备注回复 + 继续/取消 | 新 content 浮层；与 daemon `request-help` / `session.request_status` 对接 |
| S4 | 录制指示 | P2 | 录制中持续可见、可结束；计时跨导航 | 新 content 胶囊；无录制后端时**不显示**而非假装 |
| S5 | 会话详情全页 | P3 | 一次任务的步骤/证据/耗时下钻 | 0.3 `extension/ui/audit.html|debug.html` 重写为 0.4 单一“会话详情”页（只读 + 导出） |
| S6 | 设置 | P3 | 连接（wsUrl/token/instanceId）、借用确认策略、帮助开关、语言、主题 | 收进 popup `<details>`；键沿用 `bb04.ingress.*` + daemon `settings.get/set` |
| S7 | Dashboard（Web） | P3 | 账号/RBAC/会话列表（无浏览器扩展时） | 0.4 既有 `0.4/dashboard/`，与扩展 UI 共享状态词表与 token |

### 4.2 每个面的信息层级（统一 L0–L3）

- **L0 状态行**（一行，永远可见）：状态标记 + 状态词 + 主体（浏览器名/任务名/tab 标题截断）。
- **L1 主体卡**：谁（任务/控制器/用户）、在哪个 tab、何时开始。
- **L2 动作区**：1 个主操作（同屏唯一强调）+ 最多 2 个次操作 + 危险操作置末（停止/拒绝）。
- **L3 细节**：版本、instance id、计数、错误详情——默认折叠（`<details>`），可复制。

各面最低层级要求：
- S0：L0 连接状态 + L1 当前任务/借用请求 + L2 连接开关/进入设置 + L3 daemon/ext 版本、instance id。
- S1：L0 模式 + L1 控制器（名称/项目/颜色点）+ L2 暂停/交还/停止 + L3 会话 id、epoch。
- S2：L0 倒计时 + L1 目标 tab 标题（≤30 字）+ L2 允许/拒绝 + L3 借用后去向说明（移回原窗口）。
- S3：L0 请求方 + L1 原因/目标高亮 + L2 备注输入/继续/取消 + L3 超时倒计时。
- S4：L0 录制点 + L1 计时 + L2 结束 + L3 保存/丢弃（结束后）。
- S5：L0 任务标题/状态 + L1 时间线与步骤 + L2 导出/返回 + L3 原始 JSON。

### 4.3 与 0.4 extension-ingress 现有 bridge/protocol 的对接点（不新增方法）

| 表面 | 现有通道 / 方法 | 说明 |
| --- | --- | --- |
| S0 状态 | SW `snapshot()`（`0.4/extension-ingress/src/bridge.js:1611`）：`state/running/connected/instance_id/daemon_version/heartbeat_ms/ws_url/borrow_confirm/last_error/counters/methods`；daemon `status`、`session.list`、`session.control_status` | popup 通过**新增** `chrome.runtime.connect` port 取 snapshot 子集；UI 只发 intent，不改 SW 内部状态 |
| S0 设置 | `chrome.storage`：`bb04.ingress.wsUrl|token|instanceId|borrowConfirm`（+`bb04.ingress.sessions`、`borrowSnapshots` 只读展示） | 设置写 storage → SW 重连；popup 不直连 daemon |
| S1 协作条 | daemon `session.claim_control`/`control_status`/`control_mode`/`pause`/`resume`/`handback`、`cooperate.enable|sync|status|wait|hold|handback`；扩展侧 `ext.session_start|stop`、`ext.status` | 模式与动作以 daemon 权威状态为准；`epoch`/`revision` 回显到 UI，拒绝过期点击 |
| S2 借用 | `ext.tab_borrow` / `ext.tab_return`（ingress 命令）；决策通道 `bb04.borrow.confirm` / `.dismiss`；错误码 `E_BORROW_DENIED|E_BORROW_TIMEOUT|E_BORROW_CONFIRM_UNAVAILABLE` | 决策只能来自页面 UI 或通知，不允许“无 UI 直接 allow”；非活动 tab 用通知，受限页 fail-closed |
| S3 帮助 | daemon `request-help`、`session.request_status`、`session.request_cancel`；扩展 `extension.event` `human.input`（人类接管事实） | 帮助请求与人类接管是两件事：前者是 Agent 提问，后者是用户抢控制；UI 不混用同一张卡 |
| S4 录制 | daemon `session-record` 相关方法 / 任务状态 | 只有后端真实录制状态才显示胶囊；无状态源时隐藏 |
| 全局事件 | `extension.event`：`human.input`、`session.tab_observed`、`session.ended`；`extension.pull/complete` 长轮询 | UI 只消费派生视图；断连时显示降级态，不缓存伪造状态 |

跨表面状态模型（建议）：
- SW 内一个 `viewState` reducer：`connection`、`session[]`、`activeTask`、`borrowQueue`、`helpRequest`、`recording`、`lastError`，全部带 `revision`。
- 三个渲染器（popup HTML / content shadow DOM / CDP 注入 shadow DOM）只读**同一份字符串表 + token 字符串 + 状态词表**，不共享框架；禁止各自发明状态文案。
- 交互协议统一：UI → `{kind, action, request_id?, revision?}`；SW 回 `{ok, state?}`；过期 revision 一律拒绝并回推最新快照。

### 4.4 审计中发现的 0.4 UI 缺口（实现时一并解决）

1. `0.4/extension-ingress/content/borrow-confirm.js` 文案硬编码中英双语（`heading/allow/deny/hint`），未走 0.4 i18n，也不处理 RTL/其他 10 语言 → 改为从 `ui/locales.js` 同源词表注入 + `dir` 跟随。
2. `0.4/extension-ingress` 无 `action`/popup/options：用户看不到连接状态与“当前有任务在借用/控制”，只能靠页面浮层感知 → S0 是当前最大可用性缺口。
3. 0.3 冻结的 9 个 UI 页与 0.4 新表面存在职责重叠（popup/audit/debug）；建议按 §4.1 指定唯一归属，避免双套 UI 并行。
4. 页内浮层与 CDP overlay（`bridgedeck-overlay`）视觉/词表可能分叉；统一 token 名与状态词表，但渲染路径保持隔离（content script vs CDP）。
5. 新增文案必须同时更新 `translation/*.json` 与生成物（`extension/ui/locales.js`、`overlay-locales.js`），并过 i18n 覆盖门禁（见 `docs/ARCHITECTURE-EXTENSION.md` UI 章节）。

---

## 5. 明确禁止项（0.4 产品中）

1. **名称/品牌/来源**：不得出现参考产品名称、CLI 名、缩写、域名、版权头、"inspired by/ported from" 字样；不得沿用其 logo/图标/截图/字体。
2. **文案**：不得逐句或近义改写其 UI 文案、错误提示、tooltip、通知、占位符；0.4 文案必须按自有词表重写（可保留功能语义，如“借用确认”“接管”）。
3. **标识与结构**：不得复制其 class/`data-slot`/`data-*` 命名体系、DOM 层级、组件 API、状态机命名（如 `PopupStatusState` 一类结构）、图标选型组合；0.4 使用自有前缀（现有 `bb`, `bd-`, `bb04.`）。
4. **布局与视觉**：不得复刻其页面骨架（同一卡片顺序/同一 header/同一浮层位置与尺寸/同一暖橙配色+大圆角+呼吸边框组合）；0.4 以自有蓝主色和既有 token 为准，只借鉴“信息层级/状态语义”这类设计方法。
5. **代码/资产**：不得 import、复制或改写 `ref/` 下任何源码、翻译 JSON、图标、SVG、图片、Web 字体；不得新增对参考仓库的构建/运行依赖。
6. **研究材料入包**：`docs/UI-DESIGN-BRIEF.md` 及截图仅限内部；不得进入 `0.4/**/dist*`、扩展包或发布产物（发布前用 `tools/check-vendor-leak.mjs` 同类检查扫描禁用字符串）。
7. **协议命名**：沿用 0.4 已有方法/错误码与 `E_*` 约定，不引入参考产品的术语体系或错误码命名习惯。
8. **降级诚实**：不得为了“看起来完整”而伪造状态、计数或同意；没有 backend 状态的 UI 面（如录制）宁可不显示。

---

## 6. 验收（设计冻结前自查）

- [ ] §4.1 中每个面都有 L0–L3 文案骨架，且无硬编码字符串（全部走 0.4 词表）。
- [ ] 每个面标明数据来源方法/事件（§4.3），无 UI 自造状态。
- [ ] 状态词表、颜色、图标、token 与既有 0.3 `ui.css` / `overlay-theme.js` 一致。
- [ ] 12 语言（含 ar/he）中英文/RTL 走查通过；`dir` 首帧正确；逻辑属性 0 物理属性新增。
- [ ] 键盘可达（Tab/Enter/Esc）、`role=switch`/`status`/`alert` 齐全、reduced-motion 生效、触控 ≥44px。
- [ ] 借用/帮助/停止类动作 fail-closed 有单测或 E2E 覆盖；错误分层符合 §2。
- [ ] 禁用项 §5 自查 + 受限词扫描通过。
