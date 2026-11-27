# UI 一致性报告：0.3 vs 0.4（像素级 E2E，task-138）

- 脚本：`0.4/tests/ui-parity-e2e.mjs`（opt-in，不进默认门禁；真实 headed Edge）
- 证据：`0.4/tests/fixtures/ui-parity/parity-report.json`（`--evidence` 运行时写出）
- 判定边界：16×16 网格平均色，严格「每格每通道 ≤ 10/255」；否则模式 B「>10/255 的格子 ≤ 12% 且 256 格平均差 ≤ 3.0」；截图尺寸必须精确等于固定 viewport。
- 结论：**PASS**（退出码 0；`--repeat 2` 两轮、7 个变体共 14 次对比全部严格模式通过：每格差 ≤ 10/255，最大 8.69/255；
  options 三个变体两侧逐像素完全一致；跨轮网格互比全 0）。详见 §5。

## 1. 目的与边界

目标：证明 **0.4 从 0.3 移植过来的 popup / options UI 外壳**在真实浏览器里渲染出的像素与 0.3 一致，
并把无法消除的内容差异（扩展版本号、实例 ID、连接错误文案、状态词）逐项量化，而不是靠调阈值"过"。

看这个报告前需要知道的三件事：

1. **这不是 DOM 断言测试**。截图是 CDP `Page.captureScreenshot` 抓到的真实渲染帧，
   PNG 由 `node:zlib` 手写解码（IHDR/IDAT/5 种 filter），不依赖任何图像库；比较的是 16×16 网格平均色。
2. **两侧状态被对齐到同一可对比态**（关键，见 §3）。0.3 与 0.4 在"没有 daemon"时的连接重试语义不同，
   直接截图会出现"整页内容上下位移"，那时像素差反映的是布局位移而不是 UI 移植差异。
3. **动态文案不冻结**。版本号 / 实例 ID / 错误文案 / 状态词每侧不同，属于内容差异；
   报告把它们列成清单，像素判定由网格容差负责。

不做什么：不改 0.4 产品代码，不改 0.3 `extension/`（只读复制并在运行前后校验 sha256），
不装依赖，不改 `dist` 与 `D:\CTRM自动录入`，不跑阶段门；不复制 0.3 的 daemon/产品代码进 0.4。

## 2. 测试装置

| 项 | 0.3 起点 | 0.4 起点 |
| --- | --- | --- |
| staging | `extension/` **原样只读复制**到临时目录（manifest 校验 0.3.x） | `0.4/scripts/build-extension-ingress.mjs` 构建 staging（含 `ui/` + `config.json`） |
| 浏览器 | 独立 headed Edge profile + `--load-extension` | 独立 headed Edge profile + `--load-extension` |
| 扩展定位 | 浏览器 CDP → 扩展 MV3 service worker → `chrome.runtime.getManifest()` 按名字匹配 → `chrome.runtime.id` | 同左（manifest name 区分 Edge 内置扩展） |
| 页面 | `chrome-extension://<id>/ui/popup.html`、`options.html` | 同左 |
| viewport | popup 420×760、options 900×1000（`Emulation.setDeviceMetricsOverride`，deviceScaleFactor=1） | 同左 |
| 主题 | `prefers-color-scheme` 浅/暗固定；`prefers-reduced-motion: reduce` | 同左 |
| 语言/方向 | URL `?lang=zh`（ltr）或 `?lang=ar`（rtl），两侧同一参数 | 同左 |
| 截图 | CDP `Page.captureScreenshot`（page surface，非浏览器 chrome），PNG 只落临时目录 | 同左 |

对比变体（7 个）：

| 变体 | 页面 | 参数 | 预期 lang / dir |
| --- | --- | --- | --- |
| `popup-light-zh` | popup | `?lang=zh`，浅色 | `zh-CN` / `ltr` |
| `popup-dark-zh` | popup | `?lang=zh`，暗色 | `zh-CN` / `ltr` |
| `popup-light-ar-rtl` | popup | `?lang=ar`，浅色 | `ar` / `rtl` |
| `popup-dark-ar-rtl` | popup | `?lang=ar`，暗色 | `ar` / `rtl` |
| `options-light-zh` | options | `?lang=zh`，浅色 | `zh-CN` / `ltr` |
| `options-dark-zh` | options | `?lang=zh`，暗色 | `zh-CN` / `ltr` |
| `options-light-ar-rtl` | options | `?lang=ar`，浅色 | `ar` / `rtl` |

除像素外还断言（硬）：两侧截图尺寸 == 固定 viewport 且彼此相等；`html lang` / `dir` / `data-bb-dir`
两侧一致且等于预期；页面标题与 `document.body` 计算背景色两侧一致；popup 静态状态
（连接开关、控制提示/借用确认/人工协助/输入锁开关的 class、连接文案、设备区、任务区）两侧一致；
options 表单状态（输入值/勾选/下拉/预览命令）两侧一致；两侧页面均无未捕获异常；非白屏保护
（非背景像素 ≥ 1%、颜色数 ≥ 8）。静态元素 `getBoundingClientRect` 差异作为**软报告项**记录，
不作为硬失败（像素判定由网格负责）。

## 3. 状态对齐（唯一的"替身"，必须如实说明）

问题：0.3 popup 只在 `lastError` 非空时显示错误行。真实 0.3 在 52900–52909 端口全部连接失败时
**不写 `lastError`**，因此 popup 在「连接中 / 未连接」之间每 3s 重试且**不显示**错误行；
0.4 ingress 则会把 `WebSocket 连接失败: <url>` 写进 `lastError` 并每 3s 重连，popup 稳定显示 **1 行错误**。
两边卡片高度因此差一行 → 整页内容上下推移，像素对比会变成"布局位移对比"。

做法（E2E-only，不改任何产品代码）：

- **0.3 侧**：在本机 `127.0.0.1:52900` 起一个只做 WebSocket 握手的替身端点，握手成功后回
  `{type:'hello-error', code:'E_E2E_STATE_ALIGNED', message:'E2E 对齐态：daemon 拒绝连接'}`。
  0.3 收到 `hello-error` 后 `stopped=true`、状态定格 `rejected`、不再重试 → popup 稳定「未连接 + 1 行错误」。
- **0.4 侧**：staging `config.json` 的 `wsUrl=ws://127.0.0.1:9/ws`（本机 9 端口确定未监听，TCP 立即被拒；
  脚本运行前会用真实 TCP 连接预检，不是"连接被拒"就 BLOCKED）。0.4 记录 1 行「WebSocket 连接失败」并重连，
  popup 稳定「连接中 + 1 行错误」。

因此两侧都是「未连接 + 恰好 1 行错误」的同一卡片布局；错误文案本身不同（0.3 hello-error 文案 vs
0.4 WS 失败文案），属于内容差异，见 §5。该替身只影响"显示哪条错误文案"，不改变扩展代码、
不伪造成功连接、不承载任何真实 RPC；`52900` 若被真实 daemon 占用会直接 BLOCKED（否则 0.3 会进入已连接态）。

## 4. 判定与运行

- 退出码：`0` = PASS，`1` = FAIL，`2` = BLOCKED（找不到 Edge / 检测到并发浏览器测试 /
  52900 被占 / 9 端口不是确定失败端点 / 0.3 扩展无法加载或定位 service worker）。
- 默认 `--repeat 2`：两轮都必须逐变体 PASS，且**跨轮同侧同变体网格互比**也在同一容差内（证明可重复）。
- 清理：两套 staging、两个临时 profile、浏览器进程树（`taskkill /T`）、临时截图；`--keep` 保留排障。
- 复跑：

```powershell
node 0.4/tests/ui-parity-e2e.mjs --repeat 2 --evidence   # 正式验收（JSON 报告写到 fixtures）
node 0.4/tests/ui-parity-e2e.mjs --keep --repeat 1       # 排障：保留 staging/profile/PNG
```

## 5. 最终运行结果

### 5.1 命令与环境

| 项 | 值 |
| --- | --- |
| 命令 | `node 0.4/tests/ui-parity-e2e.mjs --repeat 2 --evidence` |
| 结果 | **PASS**（`status=pass`，退出码 0，`ok=true`） |
| 总耗时 | 84,628ms（run1 42,185ms / run2 41,984ms） |
| 环境 | Windows；Microsoft Edge **158.0.4370.33**；Node **v24.21.0**；`findBrowser({browserKind:"edge"})` |
| 并发检查 | 正式跑时干净（`conflicts=[]`）。此前一次尝试因并发 `0.4/tests/ui-visual-baseline.mjs`（+ 其 bd-daemon profile）被 **BLOCKED**（退出码 2，未起任何浏览器，JSON 如实记录）；对方结束后重跑本结果 |
| 0.3 staging | `extension/` 只读复制，269 文件；manifest 0.3.0 |
| 0.4 staging | `build-extension-ingress` 产物 61 文件；BridgeDeck 0.4 Ingress 0.4.0；`wsUrl=ws://127.0.0.1:9/ws`、`instanceId=parity` |
| 状态对齐 | 0.3 `hello-error` 每轮命中 2 次（连接尝试即命中）；0.4 目标端口 9 预检为 `ECONNREFUSED` |
| 0.3 完整性 | manifest + `ui/` 共 **32 文件**，运行前后 sha256 digest 一致（`150e0e11…`，`unchanged=true`） |
| 清理 | 每轮关闭 14 个页面 target、2 个 CDP 浏览器连接；两个 Edge 进程均由脚本 `taskkill /T` 兜底结束（`browserExited` 全部 `true`，`fallbackKilled` 如实记录）；两套 staging + 临时 workRoot 全部删除，无 `--keep` 残留 |

### 5.2 逐变体数字（run1 与 run2 完全一致）

| 变体 | 截图尺寸 | 最大格差 | 平均格差 | >10/255 格数 | 判定模式 | 两侧 PNG sha256 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `popup-light-zh` | 420×760 | 7.07 | 0.400 | 0 | `all-cells`（严格） | 不同（动态文案） |
| `popup-dark-zh` | 420×760 | 7.46 | 0.341 | 0 | `all-cells`（严格） | 不同（动态文案） |
| `popup-light-ar-rtl` | 420×760 | **8.69** | 0.332 | 0 | `all-cells`（严格） | 不同（动态文案） |
| `popup-dark-ar-rtl` | 420×760 | 7.65 | 0.299 | 0 | `all-cells`（严格） | 不同（动态文案） |
| `options-light-zh` | 900×1000 | **0** | **0** | 0 | `all-cells`（严格） | **相同**（`56e48ba5ae…`） |
| `options-dark-zh` | 900×1000 | **0** | **0** | 0 | `all-cells`（严格） | **相同**（`18bc477e2a…`） |
| `options-light-ar-rtl` | 900×1000 | **0** | **0** | 0 | `all-cells`（严格） | **相同**（`1ddce51d59…`） |

汇总（来自报告的 `findings.summary` / `stability`）：

- 7 变体 × 2 轮 = **14 次对比全部 `pass=true`**，且 **14/14 都是严格模式**（`mode=all-cells`，没有一次落到模式 B）；
  全局最大格差 **8.69/255**（`popup-light-ar-rtl`），远低于 10/255 严格阈值。
- 跨轮一致性：7 变体 × 两侧 = 14 对网格互比，最大差/平均差**全部为 0**（逐格一致 → 可重复）。
- 同侧同一变体的 PNG sha256 两次运行完全相同（如 0.3 `popup-light-zh` = `aea36fd5e524…`，0.4 = `9febb0d9deda…`），
  说明截图路径与状态对齐是确定的，差异只与内容有关。
- options 三个变体两侧 PNG sha256 **完全相同**：不只是 16×16 网格一致，而是逐像素一致。
- 每个变体的 11 项（popup）/ 10 项（options）断言全部通过：尺寸、lang、dir/data-bb-dir（RTL）、标题、
  body 计算背景色、静态状态、状态对齐（1 行错误且高度相同）、文档高度、非白屏保护、网格容差、无未捕获异常。
- 每轮 4 项阶段断言全部通过（staging 就绪、两个 headed Edge 启动、扩展 id 合法且不同、0.3 hello-error 命中）。


## 6. 差异归因

### 6.1 popup：像素差 100% 来自 4 个动态文本

popup 四个变体的网格最大差 7.07–8.69、平均 0.299–0.400，**全部 < 10/255（严格模式）**；逐项对照 DOM 文本，
差异只出现在这四处：

| 字段 | 0.3（BridgeDeck 0.3.0 外壳） | 0.4（BridgeDeck 0.4 Ingress，0.3 外壳移植） | 性质 |
| --- | --- | --- | --- |
| `#extVersion` | `0.3.0` | `0.4.0` | 扩展版本号（`chrome.runtime.getManifest().version`） |
| `#instanceId` | `—`（未连接态没有实例 ID） | `parity`（E2E staging 指定的短 instanceId） | 未连接态占位 vs ingress 在连接前已持久化实例 ID |
| `#stateLabel` | `未连接` / `غير متصل` | `连接中` / `جارٍ الاتصال` | 连接状态词：0.3 收到 hello-error 后定格 `rejected`（停止重试）；0.4 对连接失败保持重连循环 |
| `#stateError` | `E2E 对齐态：daemon 拒绝连接`（E2E 替身文案） | `WebSocket 连接失败: ws://127.0.0.1:9/ws` | 两侧错误文案本来就不同；真实 0.3 无 daemon 时甚至没有这一行（见 §3） |

除这四处外：

- 静态元素 `getBoundingClientRect` 差异为空（`layoutDeltas=[]`）——没有布局位移；
- `document` 宽高/滚动尺寸两侧一致（420×760、scrollHeight=760）；
- 连接开关、控制提示/借用确认/人工协助/输入锁开关的 class、连接模式文案、设备区、任务区两侧一致；
- `document.body` 计算背景色一致（浅色 `rgb(255,255,255)`、暗色 `rgb(21,25,34)`）；
- 两侧都没有未捕获异常。

### 6.2 options：逐像素一致

`options.html` / `ui.css` / `i18n.js` / `locales.js` 在 0.3 与 0.4 是同一份拷贝（只有 `options.js` 的 import 路径
`../src/settings.js` → `./support/settings.js` 不同），因此三种变体（zh 浅色、zh 暗色、ar RTL）两侧 PNG sha256
完全相同：**maxCellDiff=0、meanCellDiff=0**。这是"移植后像素 1:1"的最强证据。

### 6.3 两个需要产品/设计决策的内容性差异

1. **未连接态的实例身份**：0.3 在未连接时 `#instanceId` 显示 `—`；0.4 ingress 在连接前就持久化并显示 instanceId。
   这是 0.4 的语义改进（提前暴露实例身份，便于用户复制/排查），但用户可见文本不同。
2. **未连接态的状态词/错误行**：真实 0.3 无 daemon 时不显示错误行、在「连接中/未连接」间重试；0.4 会稳定显示
   "连接中 + WebSocket 连接失败"。这是 0.4 的 UX 改进（把失败原因摆到用户面前），但意味着 0.3→0.4 的
   "未连接态"并非逐像素相同，属于**有意的产品差异**，不是移植缺陷。

### 6.4 E2E 装置层面的说明（不是产品差异）

- E2E staging 的 0.4 `instanceId` 取短值 `parity`（而非 23 字符随机 id）：`#instanceId` 是底部 meta 行的弹性内容，
  过长会把 0.4 侧 meta 行换行、推开几 px 静态区域，从而把"内容差异"混进"布局差异"。这是测试装置的内容选择；
  真实部署时 daemon 分配的实例 ID 长度两侧本来就不同，不属于 UI 移植差异。
- 0.3 侧的 `hello-error` 与 0.4 侧的"9 端口拒连"是 E2E 专用输入（见 §3）；两次正式运行里 0.3 命中 `hello-error`
  2 次/轮、0.4 端口 9 预检为 `ECONNREFUSED`，对齐态稳定。
- 并发协调事实（双向 BLOCKED 都如实记录，未把 BLOCKED 当 PASS）：本任务早期一轮 parity 曾让对方的
  `ui-visual-baseline` 并发检查 BLOCKED（exit 2，对方未跑）；随后我方正式验收前一次尝试被对方正在跑的
  `ui-visual-baseline`（+ bd-daemon profile）检出而 BLOCKED（exit 2、未起浏览器）；对方 kill 后重跑得到
  本报告结果，之后对方补跑 2 次视觉基线 PASS。两次运行都完整清理（每轮 14 页面 / 2 浏览器退出、staging 与临时目录删除）。


## 7. 与参考产品 0.5.0 的交互差距清单（popup / options / overlay 层面）

> 仅设计观察，**不含参考产品的任何截图/图标/文案资产**；"参考产品 0.5.0"指本仓库 `ref/` 下用于只读研究的
> 0.5.0 源码（结论来自 `docs/bsk-study/*` 与 `docs/COMPARISON-BSK-0.5.0.md` 等内部研究文档）。
> 本节只谈"用户可见交互"，不重复协议/方法面的对齐情况。

### 7.1 popup

| 交互点 | 参考 0.5.0 的做法 | 0.4（0.3 外壳移植后）现状 | 判断 |
| --- | --- | --- | --- |
| 状态呈现 | 组件化 popup，状态徽标/详情/连接态分区（React 组件 + i18n key） | 0.3 外壳：连接态/当前浏览器/连接设置/设备/自动化开关/任务区/版本 meta；2.5s 轮询刷新 | **对齐（信息面）**；实现方式不同（原生 DOM） |
| 控制粒度 | 完整 controller/toolbar（接管、暂停、中断、最小化等在浮层/弹层协同） | popup 是"最小控制面"：连接开关、设置开关、复制指令；`bb.call` 白名单只放 `session.open/session.close/act` | **部分**：接管/暂停/中断没有 popup 入口（在页内浮层） |
| 实时性 | 事件/推送驱动（overlay version、状态机推送） | 2.5s 轮询 `bb.state`（0.3 外壳行为） | **部分**：状态变化最多滞后约 2.5s |
| 写操作路径 | popup 可触达控制面 | 移植后 popup 的写面被限制在 `bb.settings.set` / `bb.connection` 与极少数 `bb.call`，不直连 WebSocket、不排队重试 | **对齐/更保守**（安全边界更清晰） |
| 快捷功能入口 | popup 内多 App 入口（审计/调试/长截图/预览等） | 5 个快捷功能：视频录制 / 网站调试 / 长截图 / 操作录制 / 操作审计 | **对齐/更宽**（入口数量） |
| 可访问性 | 组件化 + 部分 a11y 测试，但存在 i18n key 盲点、manifest 仅英文等已知问题 | 0.3 外壳有 `?selftest=a11y` 钩子（lang/按钮名/switch aria-checked/img alt），但 a11y 无组件级测试 | **部分**（我们是 DOM 自检，不是组件级 a11y 体系） |

### 7.2 options

| 交互点 | 参考 0.5.0 的做法 | 0.4（0.3 外壳移植后）现状 | 判断 |
| --- | --- | --- | --- |
| 语言/方向 | 约 10 语言，RTL 不作为门禁 | 12 语言（含 ar/he 全量 RTL），`?lang=<code>` 真实切换 html lang/dir | **领先** |
| 配置范围 | 组件化设置面板（含 per-tool/诊断类选项） | 0.3 表单：实例名/借用确认/人工协助/输入锁/页面守卫/界面语言/长截图模式 | **部分**：0.4 骨架曾有 `bb04.ui.*`（刷新间隔/诊断级别/技术信息），移植后 options 不再暴露这些 |
| 即时反馈/校验 | 组件级状态与校验反馈 | 保存/恢复默认 toast；表单字段无 per-field 校验反馈 | **部分** |
| 语言桥接浮层 | 单一语言源 | options 选 ar 写 `bb.uiLang`（0.3 key），页内 `content/status-overlay.js` 读 `bb04.ui.language`，两层**尚未自动桥接** | **缺**（已知，见 `docs/bsk-study/BSK-0.5.0-COVERAGE.md` round 55 §24.1） |

### 7.3 overlay

| 交互点 | 参考 0.5.0 的做法 | 0.4 现状 | 判断 |
| --- | --- | --- | --- |
| 浮层组织 | 单个 shadow host 内 4 个 sibling overlay（control/help/record/borrow），统一 `(epoch, generation)` 排序与重置 | 两类分工：`content/status-overlay.js`（浏览器级只读提示，不做决策）+ daemon/CDP 驱动决策浮层（request_help / cooperate） | **不同分工**；无"多浮层组合 + 统一顺序"的单宿主模型 |
| 工具条/最小化 | cooperation toolbar、最小化/恢复、暂停/中断按钮 | 有协作控制/暂停/收起（0.3 输入锁语义、0.4 authority/revision/frameEpoch），但**没有**参考产品那种统一 toolbar/最小化组合 | **部分/缺** |
| capture suppression / input passthrough | 引用计数 + host remount 重放 + per-click passthrough token | 0.4 已有 cooperation capture/suppress 与 passthrough 第一版（`docs/COMPARISON-BSK-0.5.0.md` 记"接近，BSK 更深"） | **部分** |
| 借用确认 | active tab shadow-DOM banner + inactive tab 通知回退，60s 超时 fail-closed | 0.4 ingress `borrow.js` 同一设计（A3a：banner + notifications 回退 + 60s 超时 + fail-closed deny） | **对齐** |
| RTL | 无 RTL（物理 left/right 定位、shadow root 不设 lang），自评为缺口 | 页内状态浮层/确认条支持 12 语言含 RTL；UI 层 `direction.js` + i18n 全量 RTL | **领先** |
| 页面可控性（安全） | open shadow root，页面脚本可查询/点击浮层按钮（自评为风险） | 决策浮层由 daemon 驱动并带 document token/authority 校验；状态浮层只读 | **领先/更保守**（仍需独立安全评审） |
| 浮层主题一致性 | 仅 cooperation 卡有 dark token，其余浮层硬编码浅色 | 0.3 UI 全量 `prefers-color-scheme` 暗色；状态浮层与确认条随 UI 语言/主题 | **领先** |

### 7.4 与本轮像素结论的关系

- popup/options 的"外壳像素"已对齐（见 §5/§6）；上面列的是**交互能力/模型**差距，不改变像素结论。
- 其中两项会直接影响用户观感，建议下一轮优先：
  1. **popup 状态实时性**（2.5s 轮询 → 事件推送或至少连接态即时刷新）；
  2. **options 语言 → 页内状态浮层的桥接**（`bb.uiLang` ↔ `bb04.ui.language`）。
- 状态对齐小节暴露的真实语义差异（0.3 无 daemon 不显示错误行，0.4 会显示 1 行错误）在 UX 上是
  **0.4 的改进**（把失败原因摆到用户面前），但它意味着"0.3 → 0.4 未连接态像素并非逐像素相同"，
  这是设计变化而非移植缺陷，报告不把它算作 FAIL。

## 8. 复现与证据字段

`node 0.4/tests/ui-parity-e2e.mjs --repeat 2 --evidence` 的输出 JSON（stdout 最后一行，或
`0.4/tests/fixtures/ui-parity/parity-report.json`）主要字段：

| 字段 | 含义 |
| --- | --- |
| `status` / `exitCode` / `ok` | PASS/FAIL/BLOCKED 与退出码 |
| `runs[].variants[].comparison` | 每变体 `pass/mode/maxCellDiff/meanCellDiff/overCells/ratio`（`over` 最多列 40 个超差格坐标） |
| `runs[].variants[].dynamicDiffs` | popup 动态文案差异（`stateLabel/stateError/extVersion/instanceId`） |
| `runs[].variants[].layoutDeltas` | 静态元素 rect 差异（软报告项，px） |
| `runs[].variants[].legacy/modern` | 两侧尺寸、scroll 尺寸、PNG sha256、网格 digest、像素统计、状态文案 |
| `stability.crossRun` | 两轮同侧网格互比结果（可重复性） |
| `legacyIntegrity` | 0.3 `extension/`（manifest + ui/）运行前后 sha256 digest，`unchanged=true` 证明没写 0.3 |
| `stateAlignment` | 状态对齐替身端点的说明与命中统计（0.3 hello-error 次数） |
| `cleanup` | staging/profile 删除结果、浏览器进程是否退出 |

## 9. 边界与风险

- **不冻结时钟**：popup 的版本号/实例 ID/错误文案/状态词会变；本报告只保证网格容差内的稳定，不做逐像素相等声明。
- **只覆盖 popup/options 两个扩展页的静态渲染**：不覆盖交互（点击/输入/浮层动画）、不覆盖 dashboard、不覆盖 0.3 daemon 侧行为。
- **状态对齐替身**：0.3 侧的 `hello-error` 与 0.4 侧的"9 端口拒连"是 E2E 专用输入；真实无 daemon 时两侧文案/重试节奏不同（见 §3）。
- **环境**：Windows + Microsoft Edge（`findBrowser({browserKind:'edge'})` 或 `BB_BROWSER_EDGE`）；并发浏览器测试会让脚本 BLOCKED。
- **0.4 产品代码零改动**：本任务只新增 `0.4/tests/ui-parity-e2e.mjs`、`docs/UI-PARITY-REPORT.md`，
  以及（可选）`0.4/tests/fixtures/ui-parity/parity-report.json` 证据。
