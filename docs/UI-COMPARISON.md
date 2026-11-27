# UI 对比：BridgeDeck vs 参考实现（2026-11-26）

> **运行时 UI 对比（执行期浮层）**：`docs/UI-RUNTIME-COMPARISON.md`（借用确认/协助卡片/接管控制条/录制指示器截图 + 行为差异 + 系统通知差距）。
>
> **截图对比（真实 Edge，已打通）**：`docs/UI-SCREENSHOT-COMPARISON.md`（我们 11 页 / 参考实现 5 页逐页截图 + 视觉差距 + 增强记录）。
>
> 方法：源码/产物静态清点 + DOM/测试/可访问性证据；**截图状态：本环境未能取到可用截图**（Edge 阻止 CDP 顶层 chrome-extension 导航、headless 不加载扩展、隔离 profile 中扩展 SW 未唤醒；详见 `docs/FEATURE-COMPARISON.md` §5，工具骨架 `tools/ui-shots.mjs` 已保留）（扩展页在 headless 下不加载、
> 有头窗口截屏脚本在本机拿不到窗口句柄），所以本文是“结构 + 交互 + 状态 + 可访问性”的对比，
> 视觉像素级差异需要后续用截图基线补。证据文件：`extension/ui/**`、`extension/src/**`、
> `ref/bsk-0.5.0-src/.../apps/extension/src/entrypoints/**`、`packages/ui/**`、`ref/bsk-0.5.0-ext/**`。

## 1. 界面清单

| 界面 | 参考实现 | 我们 | 差异 |
| --- | --- | --- | --- |
| 弹出主面板 | `popup/App.tsx`（19.8 KB）+ 5 个功能入口（视频/调试/长截图/审计/录制），图标 Remixicon，连接状态徽章/版本偏差/升级提醒 | `ui/popup.html` + `popup.js`（33.9 KB）+ 同 5 个功能入口内嵌面板（审计/长截图/视频/调试/录制） | 功能入口集合相同；参考实现是 React 组件树，我们是原生 DOM 单页 + 视图切换 |
| 连接设置/配对 | `connection-settings.tsx`（23 KB）+ `local-pairing.tsx`（5.3 KB）+ `use-connection-state.ts`+ 21.9 KB 测试：本机/远端模式、端口、配对链接、验证状态、撤销、过期/重试/跳过验证文案 | 无独立连接页；`options.html` 有实例名/复制启动命令/开关；配对通过 CLI + `a11y-dialog.js` 撤销配对；`error-hints.js` 覆盖 E_PAIR_* 文案 | **参考实现有完整“配对向导 + 状态消息矩阵”，我们缺成型 UI** |
| daemon 升级提示 | `daemon-upgrade-notice.tsx`（3.9 KB）+ 通知/复制命令/详情/协议版本 | `popup.js` 有协议不一致提示与“复制升级命令”文案（v0.1.8 UI），无独立组件/通知流程 | 参考实现更完整（含通知按钮与降级说明） |
| 当前任务 | `current-tasks.tsx`（2.1 KB） | `popup.js` 有“当前任务”会话列表 | 基本对齐 |
| 浏览器名称/档案说明 | `browser-profile.tsx` + `profile-instructions.tsx` + 8.4 KB 测试 | `options.html` 实例名 + `popup.js` 复制启动命令 | 参考实现有更细的“当前浏览器/指令复制/不可用提示” |
| 自动化设置 | `interaction-settings.tsx`（2.7 KB）：借用确认、请求协助开关 + 说明标签 | `options.html`：borrowConfirm / allowHelp / cooperationGuard / pageGuard 复选框 + 说明 | 设置项对齐；参考实现是带 info-label 的组件 |
| 操作录制页/浮层 | `record-frame.content.ts` + `recordOverlay` 文案 + `record` 指令模板（含 trace 路径说明） | `ops.html`（操作录制页）+ `record.js`（20 KB）+ `record-overlay` 注入 | 页面能力相当；参考实现更强调“给 Agent 的指令模板” |
| 视频页 | `video/index.html` + `video/main.tsx` + `video-panel.tsx`（8.3 KB）+ `video-offscreen`：质量/时长/任务/标签页选择、prompt 复制、最近录制、保留 24h、状态/原因/保存 | `record.html` + `record.js`（20 KB）+ `popup` 视频面板 | 基础能力相当；参考实现的“质量档位/时长上限/保留期/library/另存”文案更细 |
| 长截图页 | `long-screenshot/preview.tsx`（8.8 KB）+ `tiled-preview.tsx` + `export.worker.ts` + 完整错误文案（changed/tooLarge/timeout/alignment/storageFull…） | `longshot.html` + `longshot.js`（17 KB）+ `preview.html` | 我们页面更多（含 preview 独立页），参考实现把 tile 预览/导出 worker 做在一页 |
| 审计页 | `audit/App.tsx`（16 KB）+ `audit-panel.tsx` + 时间线/隐私/导出/删除确认文案 | `audit.html` + `audit.js`（22 KB）+ `ui/lib` 的 filter/paging/diff/selection | 能力相当；我们数据面更宽（diff/筛选/分页工具），参考实现组件测试更细 |
| 调试页 | `debug/App.tsx`（35 KB）+ `analysis.tsx`（13 KB）+ `evidence.tsx`（19 KB）+ `network-controls.tsx`（23.8 KB）+ 4 个测试 | `debug.html` + `debug.js`（40.7 KB，单文件） | 功能都很深；参考实现按 analysis/evidence/network-controls 拆分并有组件测试，我们单文件偏重 |
| 接管/协助浮层 | `controlOverlay`、`helpRequest`、`borrowConfirmation` 的 i18n + content 注入 | `cooperate-control-ui` / `borrow-ui` / `help-card` / `takeover` 浮层 + `a11y-dialog` | 均有；参考实现文案矩阵更全（撤销/过期/通知） |
| 隐私页 | 无独立页（审计页内 `privacyShort/privacyFull` 说明） | `privacy.html` 独立页 + 审计页隐私文案 | 我们多一个独立隐私页 |
| 数据工作区/快捷页 | 无对应页 | `workspace.html`（Data workspace，36 KB JS）+ `quick.html` 快捷功能 | **我们多出的两页**（数据导入/导出/差异与快捷操作） |

页面数量：参考实现 **6 页**（popup/audit/debug/long-screenshot/video/video-offscreen）+ 浮层；
我们 **11 页**（popup/options/quick/debug/audit/ops/record/longshot/preview/workspace/privacy）+ 浮层。
**页面广度我们更大，配对/连接与升级引导这类“状态型 UI”参考实现更完整。**

## 2. 组件化与设计系统

| 维度 | 参考实现 | 我们 |
| --- | --- | --- |
| 技术 | React + TypeScript；`packages/ui` 提供 `Button/Card/Badge/Input/Label` 等基础组件；每页拆 `App.tsx` + 子组件 + hooks | 原生 DOM + ES 模块；`extension/ui/lib` 20 个共享 helper（`aria-live/focus/keyboard-grid/diff/filter/paging/selection/empty-state/states/i18n/render/rpc/...`） |
| 规模 | `apps/extension/src` UI 相关 TS/TSX + CSS 约 12,500 行；popup 目录 13 个 `.test.tsx` | `extension/ui`：17 JS（9,356 行）+ 11 HTML（932 行）+ 3 CSS（1,045 行）；`tests/browser` 28 个 DOM/浮层测试 + 单元 a11y 套件 |
| 一致性 | 组件级复用 + 统一 label/info-label/switch；类型约束 | 共享 helper + CSS 类约定；无类型化组件库（TS 架构轨道有 React，但不是发布 UI） |
| 测试 | 组件单测覆盖高（popup App.test 31 KB、connection-settings.test 22 KB、debug App.test 21 KB…）；共 255 个测试文件（含 Rust/逻辑） | 以 DOM 集成 harness + a11y/contrast/RTL 静态门禁为主；缺“每个面板一个组件单测”的粒度 |

**结论：参考实现的 UI 组件化和组件级测试更强；我们的优势是页面多、helper 工具全、a11y 门禁系统化。**

## 3. 状态与边界覆盖

参考实现把大量“状态文案”写进 i18n（`zh-CN/en-US` 双语对照可见，约 10 个 locale）：

- 连接：disconnected/connecting/connected/version_skew/disabled；配对 required/verified/unverified/paired/expired/skip/server_unverified/daemon_too_old/busy；
- 功能：长截图 phase（preparing/capturing/saving/complete/cancelled/error/paused）+ 12 类错误（unsupported/unavailable/busy/changed/tooLarge/timeout/captureFailed/saveFailed/interrupted/storageFull/alignment/autoUnavailable）；
- 视频：starting/recording/finalizing/ready/failed + 11 类原因（user_stopped/duration_limit/size_limit/tab_closed/session_ended/disconnected/debugger_detached/capture_failed/encoding_failed/storage_failed/browser_restarted）+ 24h 保留/另存；
- 审计：partial/privacy/redacted/empty/disconnected/unsupported/requestFailed + 30 天保留；
- 调试：coverage/partial/gap_* 二十余条“证据缺口”说明、性能指标状态 available/provisional/partial/unavailable/unsupported + 原因。

我们对应覆盖：`ui/lib/states.js`、`empty-state.js`、`error-hints.js`（45 KB，含 12 语言错误提示）、
`popup.js` 的版本偏差/升级提示、各面板 loading/empty/error 文案（`extension/ui/*.js` 共 371 处状态相关词）。
**差距不在“有没有状态”，而在参考实现把状态矩阵做成了组件/i18n 键的系统化清单。**

## 4. i18n / 可访问性 / 视觉

| 维度 | 参考实现 | 我们 |
| --- | --- | --- |
| 语言 | **10 locale**（de/en/es/fr/it/ja/ko/pt/zh-CN/zh-TW），`packages/i18n` + chrome.storage 同步 + 组件内 `t()` | `extension/ui/i18n.js`/`locales.js` 覆盖 **12+ 语言**（含 ar/he RTL、zh-hk/zh-tw），12 语言覆盖门禁 |
| a11y | 138 处 `aria-*`（源）+ 组件测试里的语义断言 | **237 处 `aria-*`**（源）+ 系统化 a11y 门禁：focus trap、对比度、RTL、aria-live、dialog/overlay 单测 |
| 视觉系统 | `packages/ui` 基础组件 + 34 处 CSS 变量 token；每页 style.css 较薄（组件内类名为主） | `popup.css`/`ui.css`/`workspace.css`（1,045 行）+ `--bb-*` 主题 token + 浅色兜底；无组件库 |
| 键盘/焦点 | switch/button 等组件有键盘语义测试 | `ui/lib/keyboard.js`、`keyboard-grid.js`、`focus.js` + 键盘门禁 |
| 截图回归 | 本环境未取到截图（headless 不加载扩展页） | 同左；**双方都缺视觉截图基线** |

**a11y/i18n 是我们的相对强项；视觉一致性与组件化是参考实现的强项。**

## 5. 差距结论（按优先级）

| 优先级 | 差距 | 证据 | 建议 |
| --- | --- | --- | --- |
| **P1** | 缺“配对/连接设置”完整 UI：本机/远端模式、端口、配对链接、验证状态矩阵、撤销/重试/过期/跳过验证 | 参考实现 `connection-settings.tsx` 23 KB + `local-pairing.tsx` 5.3 KB + 21.9 KB 测试；我们只有 `options` 开关 + 撤销对话框 + E_PAIR_* 错误文案 | 新增 `ui/connection.html` 向导（复用 `ui/lib` 的 form/aria/dialog），并补 E2E/单测 |
| **P1** | 缺组件化设计系统与组件级测试 | 参考实现 `packages/ui` primitives + 13 个 popup 组件测试；我们无 typed primitives，`ui/lib` 是 helper 集合 | 把 `ui/lib` 提炼为 `ui/components`（button/card/switch/dialog/tabs），再给 popup/audit/debug 面板补组件测试 |
| **P2** | daemon 升级/版本偏差提示不完整 | 参考实现 `daemon-upgrade-notice.tsx`（通知按钮/复制命令/详情/协议）；我们 popup 只有文案提示 | 抽 `ui/components/upgrade-notice`，接 `notifications` 与复制命令 |
| **P2** | 视觉/交互一致性（间距、状态色、图标、空态）缺基线 | 双方均无截图回归；我们 3 个 CSS 文件 + 手写类名 | 引入截图基线（puppeteer/playwright 或现有 Edge）+ 设计 token 收敛 |
| **P2** | 功能面板“引导式说明”密度 | 参考实现 video/longshot/debug 的 i18n 说明非常细（prompt 模板、质量档位、保留期、证据缺口） | 复用我们的 `error-hints` 风格补齐面板说明与复制提示 |
| **P3** | 调试页单文件偏大（40.7 KB） | 参考实现拆 `App/analysis/evidence/network-controls` + 4 测试 | 按面板拆分 `debug.js`（参考我们已有的 replay 拆分经验） |

**我们领先/不落后**：页面广度（11 vs 6）、`workspace`/`quick`/`privacy` 独有页、i18n 语言与 RTL 覆盖、
a11y 静态/对比度/焦点/RTL 门禁、DOM 浮层集成测试（28 个 harness）、错误提示 12 语言化。

## 6. 下一步（可执行）

1. **配对向导 UI**（P1）：新增页面 + 复用 `a11y-dialog`/`focus`/`i18n`，覆盖参考实现的连接状态矩阵；补 `tests/browser` harness 与 CLI 配对 E2E。
2. **组件化抽取**（P1）：`extension/ui/lib` → `extension/ui/components`（button/card/switch/dialog/tabs/empty-state），先迁移 popup 与 audit 两页，行为不变。
3. **视觉回归**（P2）：用有头 Edge + CDP screenshot（或 Playwright）给 11 页 + 6 个浮层做基线截图，纳入门禁。
4. **调试页拆分**（P3）：`debug.js` 按 analysis/evidence/network-controls 拆分，补对应单测。

> 局限：本文不含截图证据，且静态计数受 PowerShell 编码影响（中文路径）；建议在能取到截图的机器上补一份
> `docs/ui-shots/` 基线后做二次视觉评审。
