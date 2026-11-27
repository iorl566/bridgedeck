# 全功能对比：BridgeDeck 0.3.1 vs 参考实现 0.5.0（2026-11-26）

> 汇总口径：功能面以 `docs/BSK-DIFF-MATRIX.md`（646 格）+ `docs/BEHAVIOR-DIFF-BSK.md`（19 个真实浏览器
> 任务）为准；UI 结构以 `docs/UI-COMPARISON.md` 为准；行为证据为真实 Edge 运行结果。
> **UI 截图：本轮未取得可用截图**（原因与方法见 §5），不以错误页冒充。

## 1. 总览记分卡

| 维度 | 参考实现 0.5.0 | 我们 0.3.1 | 判定 |
| --- | --- | --- | --- |
| CLI 命令面 | 56 | **79** 动词 | 更广；矩阵 CLI 轴 79 格（equal 8 / partial 48 / extra 23 / missing 0） |
| RPC 方法 | 77 | **165 canonical + 7 daemon-only** | 更广；RPC 轴 172 格（equal 10 / partial 60 / missing 4 / extra 78 / unknown 20） |
| MCP 工具 | 7 + recipe（8），56 action | **92 工具** | 更广；MCP 轴 148 格（partial 104 / extra 44 / missing 0） |
| Feature floor | 9 | **15** | 更广；feature 轴 15 格（equal 1 / partial 8 / extra 6 / missing 0） |
| 错误码 | 15 ErrorCode + 102 reason | **161 统一码** | 更细；error 轴 223 格 |
| 扩展能力面 | 9 行 | 同 9 行 | extension 轴 equal 1 / partial 8（borrow 的协议特性门等仍是差距） |
| 真实浏览器行为（同任务集） | — | — | **19 任务 15 equal / 3 diff / 1 unsupported** |
| UI 页面 | **6 页** + 浮层 | **11 页** + 浮层 | 页面更广；配对向导/组件化落后（见 UI 对比） |
| 测试 | Rust 单测 1,223 + 305 测试文件 | 单测 5,051 + CLI 404 + MCP 216 + Python 181 + TS 649 + E2E 222 | 我们测试量更大；参考实现组件级前端测试更细 |
| i18n | 10 locale | **12+ 语言**（含 RTL） | 我们更广 |
| a11y | 源内 138 处 aria | **237 处 aria** + a11y 门禁 | 我们更系统 |
| 打包分发 | 单二进制 + 少文件扩展包（34 文件/4.66 MB） | Node CLI + 源码树扩展包（426 文件/≈3.6 MB） | 参考实现更轻；我们保留可审计性 |
| UI 组件化 | React + `packages/ui` primitives + 13 popup 组件测试 | 原生 DOM + `ui/lib` 20 helper | 参考实现领先 |

## 2. 功能逐项对比

### 2.1 会话 / 窗口 / 标签页

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 会话开始/停止/列表/请求 | session start/stop/list/request | 同 | equal/partial |
| Agent 窗口 | window resize 等 | window list/focus/ensure | partial（能力更细） |
| 标签页 | tab list/create/close/select/borrow/return | 同 + alias/group/move/cleanup/policy | 我们更广 |
| 借用用户标签页 | `tab borrow <id>` + 确认 UI（UIA 可点） | `tab borrow` + closed-shadow/human-only 确认 | **行为差异**：我们确认不可自动化（安全取舍） |
| 多会话 | scope | 多 session + 租约/仲裁 | 我们更细 |

### 2.2 观察 / VOM / 读取

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| observe / snapshot | VOM 文本 + probe | observe + `--vom` 系列 + ARIA 语义 | 形状对齐；矩阵 extension 轴 partial |
| read 字段 | read --selector/--ref | read --selector/--all/--fields-json | 有差异：**我们返回输入框 value，参考实现返回空 text**（行为 diff） |
| get-html | 整页/子树/最大字节 | 同 | equal |
| extract discover/table/list | 有 | 有（+覆盖度/游标/预算） | 我们更细 |
| iframe / OOPIF / 变换帧 | 有（VOM 投影） | 有（owner 链/matrix 投影） | 行为 equal（真实浏览器验证） |
| 动态读取校验 | 有（文档） | node-scope/detached/stale 校验 | 相当 |

### 2.3 动作 / 输入

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| click/hover/fill/press/select/drag/wheel/scroll-to/focus/blur | 有 | 有（+trusted/stableRef/click-backend/拟人输入） | 我们更广 |
| upload/download | 有 | 有（+覆盖策略/结果态） | 相当 |
| expect/observation 严格模式 | 有（严格 observation 要求） | 有（`--expect`/observation 收据） | 相当，触发方式不同 |
| wait-for-element/navigation/ms | 有 | 有（+operation cancel 中止） | 相当 |

### 2.4 网络 / 调试

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| network 读取（请求/响应/HAR） | 有 + debug 面板 | 有 + waterfall/HAR merge/回放 | 我们更细 |
| rule fulfill/modify/block | 有（Fetch） | 有（derivedNetwork/rule replay） | 相当 |
| debug 请求/上下文/证据/性能 | `tool.debug` 单方法 action 分发，UI 拆 analysis/evidence/network-controls | `debug.*` 20+ 方法，UI 单文件 40.7 KB | 能力相当；**接口粒度/UI 结构不同** |
| 性能指标（TTFB/FCP/LCP/CLS/长任务） | UI 有指标与状态矩阵 | 有 performance 采集 + 预算门禁 | 相当；参考实现 UI 文案更系统 |

### 2.5 录制 / 回放 / 视频 / 长截图

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| record（录制） | 交互式 `record start`（录真人操作）→ `trace.json` + states | `record start/stop`（Agent 动作/真人动作）→ Trace v3 | **行为 equal**（19 任务验证） |
| replay（回放） | 无 `replay` 子命令（仅 recipe run） | 引擎存在但无对等 `replay <trace>` CLI | **共同缺口（unsupported）** |
| video（录屏） | start/status/stop/save/list/discard，quality/duration/保留 24h | start/stop/status/save/verify/recover/trim/merge，预算/分片/恢复 | 我们更细；行为 equal |
| 长截图 | 单页脚本 + tiled preview + worker 导出 | CDP 分块/固定带/DPR/分片恢复/流式读 + 独立 preview 页 | 我们更细；整页截图行为 equal（有环境敏感项） |

### 2.6 协作 / 人工接管 / 审计

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| cooperate（共享控制） | context_id + control_policy | context/policy + passthrough token/lease/hold | 相当；矩阵 partial |
| borrow 确认 | 确认条 + 通知，UIA 可点 | closed shadow + human-only，UIA 不可达 | **设计差异**（见用户窗口场景） |
| request-help / handoff | help card + 通知 | help card + handoff/epoch | 相当 |
| operation/dialog | await/cancel + dialog 决策 | 同 + cancel/ledger | 相当；RPC cancel 仍 missing |
| audit（操作审计） | 时间线/隐私/导出/删除 | 时间线/筛选/分页/导出/证据链 | 我们数据面更宽 |

### 2.7 平台 / 集成

| 功能 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| MCP | stdio 7 工具 + recipe | stdio **92 工具** + Node/Python MCP client | 我们更广 |
| SDK | Rust protocol crate | Node SDK + Python SDK | 我们语言覆盖更广 |
| DSH 插件 | dsh-plugin-browserskill | dsh-plugin + skill | 相当 |
| 配对/安全通道 | 本机配对（可选） | WS + 本机配对 + TLS（pairing 46/TLS 8 测试） | 我们门禁更细；UI 向导落后 |
| 版本/兼容 | 协议 + feature floor | 协议 4 门禁 + floor 矩阵 + migration planner | 相当 |
| 发布/签名 | 单二进制 + 发布流水线 + 签名/公证（已发布） | 0.3.1 本地流水线 16/16 全绿；CI 待生产私钥 | 参考实现已公网发布 |

## 3. UI 功能对比（结构）

| UI 界面 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 弹出主面板（5 功能入口） | React，图标/连接徽章/升级提示 | 原生 DOM，5 功能内嵌面板 | 功能对齐，组件化落后 |
| 连接设置/配对 | **完整向导**（本机/远端/端口/配对链接/状态矩阵/撤销/过期/跳过） | options 开关 + 撤销对话框 + 错误文案 | **P1 差距** |
| daemon 升级提示 | 独立组件 + 通知/复制命令/详情 | 文案提示 | P2 差距 |
| 当前任务 | 组件 | 会话列表 | 对齐 |
| 录制/视频/长截图/审计/调试页 | 6 页，组件化 + 细文案 | 11 页，单文件 + 数据面深 | 各有优势 |
| 隐私页 | 无独立页 | 独立 privacy 页 | 我们多 |
| 数据工作区/快捷页 | 无 | workspace + quick | 我们多 |
| 浮层（接管/借用/协助/录制） | content 注入 + i18n | 注入 + a11y dialog + focus trap | 相当 |

## 4. 测试与证据

- **行为证据（真实 Edge）**：19 任务 15 equal / 2 diff（read_after_fill、fullpage 环境敏感）/ 1 unsupported（record→replay）——其中 borrow 在真实用户窗口场景为“设计差异”项。
  - `fullpage` 视遮挡情况可能 diff（参考实现要求页面可见）；
  - `tab_borrow` 参考实现 UIA 可确认、我们 human-only/closed shadow。
- **线格式矩阵**：646 格（equal 33 / partial 305 / missing 31 / extra 257 / unknown 20），`--check` 可复现。
- **门禁**：单测 5,051、CLI 404、MCP 216、Python 181、TS 649、E2E 222、15+ 类静态/质量门禁全绿。

## 5. UI 截图状态（重要，如实）

本轮为“全功能 + 全部 UI 截图”做了三条路线，均在本环境失败：

1. **headless Edge + --load-extension**：Edge headless 不加载 unpacked 扩展，页面不渲染（无 PNG 产出）。
2. **CDP 顶层导航 chrome-extension://**：被 Edge 拦截（`ERR_BLOCKED_BY_CLIENT`）。
3. **CDP 从扩展 service worker `chrome.tabs.create`**：隔离 profile 里我们的扩展 SW 未被唤醒（可见的 SW 都是 Edge 内置扩展）；用本地 http 页唤醒的路线运行挂起，已终止。

已产出的 PNG 是浏览器错误页（`ERR_FILE_NOT_FOUND` / `ERR_BLOCKED_BY_CLIENT`），**不能作为 UI 证据**，
因此没有放进对比文档。工具骨架已保留：`tools/ui-shots.mjs`（有头 Edge + CDP + SW tabs.create 路线）。

**可执行的下一步**（任一即可取到全部截图）：
- 在你的桌面环境直接运行 `node tools/ui-shots.mjs --side all`（有头 Edge、无沙箱 Job 限制时扩展 SW 可唤醒）；
- 或用 E2E 的已验证启动路径：先起我们的 daemon + 扩展（E2E 同款），再用 CDP `Page.captureScreenshot` 截
  `chrome-extension://<真实 id>/ui/*.html`（需要先按 E2E 方式确认扩展已加载并拿到真实 id）；
- 或引入 Playwright（允许新依赖时）以 `launchPersistentContext + --load-extension` 直接截图。

## 6. 结论

- **功能面**：我们 CLI/RPC/MCP/feature/错误码/录制回放/长截图/视频/审计/工作区更广；参考实现在扩展少文件
  分发、配对向导 UI、组件化前端测试上更强。
- **行为面**：同任务 19 项 15 equal，差异集中在“输入值读取”“整页截图可见性要求”“借用确认安全设计”“回放 CLI 缺口”。
- **UI 面**：页面广度/a11y/i18n 我们领先；组件库、配对/升级向导、视觉一致性参考实现领先。
- **截图**：本环境受阻，需按 §5 的方式补采；在此之前不用错误页充当截图。
