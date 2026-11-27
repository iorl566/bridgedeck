# 与 BSK 0.5.0 相比：当前仍存在的不足（全面复核）

> 复核时间：2026-11-27。依据：`tools/bsk-diff/matrix.json`（641 格：equal 36 / partial 333 / missing 0 / extra 252 / unknown 20；**P0 = 0**）、
> `docs/BSK-FULL-COMPARISON.md`、`docs/LIFECYCLE-DIFF-BSK.md`、`docs/UI-RUNTIME-COMPARISON.md`、
> 真实 popup/page 截图与 CDP 计算样式。
> 本文只列**不足**与差距；我们的领先项在 §8 单列，避免误判。

## 1. 结论摘要（按严重度）

| 级别 | 差距 | 影响 |
| --- | --- | --- |
| **P0** | 分发/发布链路未打通（CI 未上传商店、二进制未发布、-release 包本地签名） | 用户装不上/不敢装，是最大产品差距 |
| **P0** | 页面级 UI 仍比 BSK 粗糙：BSK 页面有品牌头+面包屑、大标题、大留白、大空态；我们页面偏密、偏技术 | 观感与品牌感差距（popup 已对齐，页面未） |
| **P0** | 协议/CLI 字段与错误码覆盖不齐（32 条 P0、27 个 BSK 错误码缺失、4 个 RPC missing） | Agent/第三方按 BSK 文档调用会缺参或无法区分错误 |
| **P0** | 借用/协助浮层 closed-shadow + human-only；BSK 在可访问性树里可被 UIA 点击 | 自动化、辅助技术、无人值守场景体验差距 |
| **P1** | 录制工作流不同：BSK 阻塞式真人录制 + Agent 指令；我们非阻塞、面板一键录 | 各有优劣，但“Agent 发起录制→人操作→结束”交接体验 BSK 更顺 |
| **P1** | trace/录制产物格式差异（已补：`record start --blocking --out trace` 直接产出 BSK 形状 `trace.json` + `states/`；purpose/redact 支持） | 迁移成本已降低 |
| **P1** | 页面功能面板深度不一：BSK long-screenshot/video 面板较完整；我们面板够用但视觉弱 | 用户感知“完成度” |
| **P2** | 扩展/构建复杂度：单 bundle 2.59MB vs 我们 2.99MB（已做 o200k 前缀压缩词表，扩展 zip 3.67MB→2.99MB，约 -18%） | 已接近，仍多文件 |
| **P2** | 部分细节字段（tab-switch 录制步骤、screenshot.scope、upload.mode/timeout、wheel modifiers 等） | 边界场景兼容性 |

## 2. 协议 / CLI / RPC 差距（矩阵证据）

> 2026-11-27 复核：borrow 的 `confirmationTimeoutMs` 参数门（floor 1.9）由 daemon `requireFeatures` 真实执行；cooperate 已支持 target/strict/auto 控制策略（BSK 单控制面超集）。两者从 P0 调整为 P1 contract partial。

### 2.1 P0 条目（32 条中的代表）

| 维度 | 条目 | 差距 |
| --- | --- | --- |
| CLI | `step` | ✅ 已补齐：支持 `--action/--method/--params`，位置参数 0 必选；`--params` 合并、非法 JSON 报错；单测 4 条 |
| RPC | `tool.debug` | 缺 24 个 BSK 字段：`action run_id name since limit part offset max_chars pointer rule replay…` |
| RPC | `tool.drag` | 缺 `source mode target delta hold_ms duration_ms timeout_ms`（7 个） |
| RPC | `tool.extract` | 缺 `action target_id item_selector fields timeout_ms`（5 个） |
| RPC | `tool.read` | 缺 `fields timeout_ms`（2 个） |
| RPC | `tool.record_start` | 缺 `url redact_values trace_version supports_tab_switch_steps`（4 个） |
| RPC | `tool.screenshot_full_page` | 缺 `scope`；BSK 整页截图是独立方法 |
| RPC | `tool.upload` | 缺 `mode timeout_ms` |
| RPC | `tool.wheel` | 缺 `ref selector modifiers timeout_ms` |
| RPC | `cancel` / `ledger.request` | **missing**：我们无通用 cancel；账本只在 daemon 本地/CLI |
| RPC | `system.handshake` / `system.ping` | **missing**：握手/健康检查在 WS 信封实现，不是 RPC 方法 |
| extension | borrow / cooperate | 借用确认、协作上下文/控制策略与 BSK 的 feature floor/行为仍有 partial |

### 2.2 错误码：27 个外部线名已做兼容别名

新增 `lib/error-codes.mjs` 的 `ERROR_CODE_ALIASES` / `resolveErrorCode`：把 27 个外部错误线名（`cdp_failed`、`tab_not_active`、`window_resize_*` 等）解析到我方 canonical 错误码；`normalizeErrorCode`/`recoveryHint` 均先走别名。明细表：`docs/ERROR-CODE-ALIASES.md`；单测 `tests/unit/error-code-aliases.test.mjs`。矩阵中这些行从 missing 变为 partial（别名映射），**missing 从 31 降到 4（仅剩 RPC）**。


### 2.4b tool.debug 复合字段（已接受，语义 partial）

tool.debug 的 24 个字段（action/run_id/since/limit/part/offset/max_chars/pointer/rule/replay/budget/slow_ms/window_ms/include_controlled/url/method/resource_type/status/state/kind/fields/wait_ms/command_id）已进入 debug.start/debug.request 的 schema（行列对齐）；当前实现只消费既有 debug.* 子集，复合 action 语义仍未等价，矩阵按 partial（P1）记账。

### 2.5 浮层无障碍（P1，已完成）

新增「无障碍浮层（读屏可访问）」设置：open shadow DOM + role/aria-label/aria-live；默认 closed；12 语言词条与 options 截图基线已更新。

## 3. 页面级 UI 差距（截图对照）

| 页面 | 我们 | BSK | 差距 |
| --- | --- | --- | --- |
| debug | 页面头 + 多张卡片、折叠性能/规则、时间线，偏密；字号小（1200×900 下正文 ~11–12px） | 品牌头 + 面包屑 + 大标题 + 大留白 + 大虚线空态 | 版式、留白、空态层级 |
| audit / workspace / ops / longshot | 功能丰富但信息密集、标题层级偏弱 | 同类页更简洁、卡片留白大 | 视觉完成度 |
| video | 功能多（列表/筛选/导入导出） | 极简页 | 我们功能领先，但首屏观感不同 |
| options | 设置项多、较密 | 同类设置页更松 | 字号/间距 |
| 运行时浮层 | 已品牌化、字号与 BSK 同档 | 暖色、圆点/图标体系 | 颜色=品牌差异；可访问性差异见 §4 |

结论：**popup 主面板/快捷功能已对齐**；**页面级 UI 未对齐**（视觉密度、标题层级、留白、空态）。

## 4. 可访问性 / 自动化差距（浮层）

- BSK 借用确认/协助卡片在**可访问性树**中，差分环境里 UIA 能点“允许”并成功借用；
- 我们前者是 **closed shadow + borrrowConfirm human-only**（有意安全设计），面板无法被 UIA 驱动；
- 影响：无人值守、辅助技术用户、E2E 之外的自动化脚本；建议提供**可选的无障碍模式**（light DOM + 仅键盘/AT），默认保持 closed shadow。

## 5. 录制/回放/产物差距

| 项 | BSK | 我们 | 差距 |
| --- | --- | --- | --- |
| 录制启动 | `bsk record start` 阻塞、打开窗口、录真人 | `bridge record start` 非阻塞，可录 Agent/真人 | 交接流程 BSK 更顺 |
| 录制指令 | popup 生成 prompt 给 Agent（主题/起始网址） | 已支持（本轮吸收） | 已对齐 |
| 产物 | `./trace` 目录包（trace.json + states/） | Trace v3 + 审计/证据 | 格式不兼容 |
| tab 切换步骤 | `supports_tab_switch_steps` 字段 | 缺字段 | P2 |
| 回放 | 无 replay CLI | 已加 `replay <trace>` | 我们领先 |

## 6. 分发 / 发布差距（P0）

- BSK 已发布 Windows 二进制 + 商店扩展（用户可一键装/更新）；
- 我们：CI 发布被生产签名私钥/凭证阻塞，Release 包为**本地签名**，未上 GitHub/Edge 商店；
- 影响：安装门槛、信任、自动更新能力全面落后；
- 需要：生产签名密钥托管、商店 listing 素材（截图/描述/privacy）、CI 上传流程、版本回滚策略。

## 7. 构建/性能/维护差距（P2）

### 7.1 构建瘦身（o200k 词表，已完成）

- `vendor/o200k/o200k_base.tiktoken` 3.61MB（zip 压缩 1.69MB）→ 前缀压缩二进制 `o200k_base.bin` 1.41MB（zip 压缩约 1.02MB）；
- 运行期 `loadO200k` 优先加载二进制，保留文本回退；
- 发布 zip **3.67MB → 2.99MB（约 -18%）**；
- 工具：`node tools/pack-o200k.mjs` / `--check`；单测：`tests/unit/o200k-packing.test.mjs`。

| 项 | BSK | 我们 |
| --- | --- | --- |
| 扩展打包 | 单 bundle 2.59MB | 426 文件 / 1.26MB（ESM 模块树） |
| 源规模 | 较小 | 1,466 文件 / 354k 行 + 786 roots / 311 模块 |
| 启动路径 | 单 bundle 直读 | 多模块导入/握手/feature floor |
| 维护成本 | 低 | 高（但换来测试/文档/审计能力） |

## 8. 我们领先的项（避免误判）

- 真实 Edge E2E **222/222**、单元 **5060**、MCP **216**、CLI **404**、Python 181；BSK 无同规模测试；
- MCP 92 工具、审计/证据链、网络调试/规则/HAR、长截图分片/DPR/恢复、视频恢复/分片/清理；
- 12 语言（BSK 10）；错误码 161 个、feature floor 15、schema 155、矩阵 647 格；
- 更严格的本地配对/TLS/strict 模式；更完整的 daemon 运维（queue/lease/batch/doctor）。

## 9. 建议的下一步（按优先级）

1. **P0（已完成）**：页面级 UI 重排（品牌头 + 面包屑、标题/字号/留白）。
2. **P0（已完成）**：`step --action/--method/--params`；27 个错误码别名；CLI/页面/商店文案与品牌清理。
3. **P0（待办）**：`tool.*` 缺失字段映射（debug/drag/extract/read/record_start/screenshot.scope/upload/wheel）；发布上传需有效凭证。
4. **P0（待办）**：生产签名密钥托管 + GitHub/Edge 上传（材料已备齐，见 `docs/STORE-PUBLISH-RUNBOOK.md`）。
4. **P1**：浮层无障碍模式（可选 light DOM/AT 可操作），默认仍 closed-shadow。
5. **P1**：录制交接：提供“阻塞式录制”选项 + BSK trace 目录导出兼容。
6. **P2**：构建瘦身（bundle/预构建）、tab-switch 录制字段、screenshot.scope/upload.mode/wheel modifiers 等边界字段。

> 注：矩阵中的 partial 大多来自“命名/字段/契约声明”差异，不等于功能缺失；但按 BSK 文档直接调用时仍会暴露，所以列为 P0/P1。
