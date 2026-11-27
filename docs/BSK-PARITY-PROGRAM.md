# BSK 0.5.0 全面对标路线（2026-11-25 起）

> 目标由用户明确下达：**深度不够 + 体量不够，要全面对标 BSK 0.5.0**。
> 边界（沿用 0.3.0 冻结约定，用户未解除前不越界）：不升版本号、不重新打包、不改 `dist/`、
> 不动 `D:\CTRM自动录入`、不新增第三方依赖。基线 = `D:\浏览器桥-0.3.0-backup-20261125-110641`。
> 对照源：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`（只读参考，不复制代码）。

## 1. 量化差距（代码行，仅 rs/ts/tsx/js/mjs；`node .tmp/recon.mjs` 口径）

| 子系统 | BSK 0.5.0 | BridgeDeck 0.3.0 | 倍数 |
| --- | ---: | ---: | ---: |
| 扩展运行时（apps/extension） | 188,481（559 文件，TS/React/WXT） | 40,701（228 文件，原生 MV3 JS） | 4.6× |
| CLI + daemon（crates/bsk-cli，Rust） | 86,902（177 文件） | 13,199（cli 8,927 + daemon 4,272） | 6.6× |
| DSH 插件 | 25,326（81 文件） | 1,865（9 文件） | 13.6× |
| 协议 | 9,604（39 文件） | 1,663（7 文件） | 5.8× |
| VOM | 5,359（11 文件） | 1,259（12 文件） | 4.3× |
| 测试 | 内嵌于源码（#[test] / it/test） | 33,833（460 文件） | 形态不同 |
| **合计（代码）** | **316,463** | **104,124** | **3.04×** |

结论：**体量 32.9%**；深度差距集中在扩展运行时（TS/React 组件化 + VOM 内部模型 + 动作事务 +
协作 controller）、CLI/daemon（Rust 状态机与协议 catalog）、DSH 插件（工具/技能/资源体系）。

> **全方面对比（2026-11-26）**：体量、产品形态/分发、技术栈与架构、协议 wire、能力面、扩展 manifest/权限、
> 安全、测试质量、性能/可靠性、i18n/a11y、扩展性/生态、差分矩阵摘要与剩余缺口，见
> [`docs/BSK-FULL-COMPARISON.md`](BSK-FULL-COMPARISON.md)。该文同时给出“双口径”体量校正
> （scale 只计 js/mjs；全栈口径我方 ≈442k 行 vs BSK ≈312–316k）。
>
> **发布链路（2026-11-26，用户解除 0.3.0 冻结后验证）**：扩展/CLI bundle/4 平台可移植包/安装器/
> 插件包 + Ed25519 清单签名 + `release-preflight` / `verify-release` 全绿；证据与“距公网发布还缺
> 什么”（生产私钥、CA 证书、macOS 公证、GitHub tag 发布、版本号）见
> [`docs/RELEASE-PIPELINE-VERIFICATION.md`](RELEASE-PIPELINE-VERIFICATION.md)。

## 2. 两条路线与取舍（需要用户决策，不在本轮擅自执行）

- **路线 A（默认，本轮采用）单栈 JS 深度路线**：继续在 0.3.0 工作树上把每个子系统做深
  （状态机、事务层、观察引擎、插件体系、eval 语料、测试金字塔），@约 10–13k 行/轮。
  可把体量推到约 50–60%（160–190k 行），深度真正对齐 BSK 的外部能力面。
- **路线 B（架构级）**：TS/React/WXT 重写扩展（对标 188k）+ Rust CLI/daemon（对标 87k）。
  这是重写量级，且与"不重打包/不升版本"冲突；只有在用户解除冻结后才能启动。
- **判断**：只靠路线 A 无法在合理周期内达到 316k 这一"体量数字"；路线 A 能消除"深度不够"
  和"实用能力不够"，路线 B 才能消除"体量不够"。**本文件按路线 A 推进，路线 B 待用户拍板。**

## 3. 防注水规则（每个工作流必须遵守）

1. 每个新增模块必须被至少一个运行时路径消费（报告给出调用点），或在 page-lib 注入链中；
2. 每个新增模块必须有测试；测试必须有真实断言，禁止 `assert.ok(true)` 类占位；
3. 禁止复制粘贴/空函数/TODO 桩/为凑行数而写的注释；行数目标只是下限参考，不是配额；
4. 不得改既有测试期望来迁就实现（过期断言需先报告，由 lead 裁决）；
5. 不新增依赖、不联网、不改 `tools/e2e.mjs`（真实 E2E 由 lead 统一跑）。

## 4. 波次路线（体量目标：316k 为 100%）

| 波次 | 主题 | 体量目标 | 状态 |
| --- | --- | ---: | --- |
| W0 | 已完成：输入时钟/fill 快路径/row 分类器、suppression+passthrough、affordance+layers+stable refs、fake adapter+eval 三态、协议单源 | 90.7k → 96.3k（+5.6k） | ✅ 2026-11-25 |
| W1 | VOM 引擎、动作事务 WAL、协作 controller、协议状态机、插件体系、eval 语料 | +12.8k 计划 → **实际 +22.7k**（96.3k → 119.0k） | ✅ 2026-11-25 |
| W2 | 长截图状态机、视频状态机、debug journal、CLI 参数/JSON 契约、TS 核心包（M-B） | +12.8k 计划 → **实际 +19.4k**（119.3k → 138.6k） | ✅ 2026-11-25 |
| W3 | 网络/HAR/trace 深度、录制-回放与 recipe 引擎、会话账本 WAL、VOM 关系图、M-C 第一批（TS daemon/RPC） | +12k 计划 → **实际 +16.9k**（138.7k → 155.6k） | ✅ 2026-11-25 |
| W4 | MCP/SDK 完整化、i18n+a11y 门禁、协议/性能/发布门禁、M-B 续、M-C 第二批（TS 动作面） | +12.8k 计划 → **实际 +11.7k**（155.6k → 167.2k，口径差异见下） | ✅ 2026-11-25 |
| W5 | MCP resources/Python SDK、trace/recipe 收口与恢复回归、Rust CLI 第二批、M-C 第三批（TS 只读面）、浮层 a11y 与动态文案 | +12k 计划 → **实际 +10.0k**（167.2k → 177.2k） | ✅ 2026-11-25 |
| W6 | MCP 持久化/进度/取消、CLI 摘要与 README 门禁、协议运行时单源、M-C 第四批（E2E 135）、M-D 第三批（真实 daemon） | +12k 计划 → **实际 +8.9k**（177.2k → 186.1k） | ✅ 2026-11-25 |
| W7 | M-C 第五批（TS 长截图分段 + UI 子页面）、M-D 第四批（Rust TLS/session/observe）、MCP `resources/subscribe` + Node SDK、CLI 严格 specs + `--dry-run`、TS VOM 统一 | 186.1k → **191.2k**（+5,075 行 / +17 文件；无 git，只记“归属 W7 窗口”） | 🟡 **部分达成**：门禁全绿、TS 产物 E2E **146/212**（目标 ≥170 未达，转 M-C 第六批） |
| M-C 第六批 | CDP 通道/OOPIF 投影、VOM 深水区、缺陷/UI、CDP 域（Fetch/PDF/emulate/trace/可信输入/closed-shadow/debug）、35d 异步窗口；TS 产物 E2E ≥170 | 191.2k → **191,332 行**（+111；文件数 1,039 不变，scale 口径只计 js/mjs） | ✅ **达成 ≥170**：TS 产物 E2E **179/212**，0 回退（2026-11-25 夜） |
| M-C 第七批 | 动作/引用层（backend-locator/trusted-input/file-input）、observe/VOM（vom-weights/rich/session/protocol/refs）、人工协作/annotate（cooperation runtime + `capture_id` 分离）、lead 集成 | 191.3k → **191,339 行**（+7；文件数 1,039 不变，scale 口径只计 js/mjs） | ✅ **193/212，0 回退**（+14；2026-11-26 00:20） |
| M-C 第八批 | record 服务（`src/record/**` + record-overlay + ops 页）、video 服务（`src/video/**` 12 模块 + record 页 + offscreen）、replay/takeover、对齐修复、lead 集成；TS 产物 E2E 对齐 JS | 191.3k → **191,343 行**（+4；文件 1,039 → **1,042**，scale 口径只计 js/mjs） | ✅ **212/212 达成，与 JS 全对齐**（+19，0 回退；2026-11-26 01:57） |
| M-C 第九批 | JS video/record（seal/degrade/restore/record-program/record-merge）、daemon/CLI（transfer/queue/ledger-report/doctor/status-views + daemon-views）、HAR/trace（har-merge/waterfall-attribution/trace-budget）、JS 观察/审计（vom-zorder/relations-chain/visual-identity/degrade/frames-depth + audit-journal/integrity） | 191.4k → **211,018 行**（+19,664；文件 1,042 → **1,088**，scale 口径只计 js/mjs） | ✅ **M3 达成：211,018 行 / 66.7%**，双 E2E 212/212（2026-11-26 02:45） |
| M-C 第十批 | protocol/状态机（method-state-machine 165 方法六面）、MCP/SDK（信封/分页/审批/Python 142）、协作/toolbar/borrow、长截图/视频持久化、UI 深度、daemon 租约/恢复 | 211.0k → **253,492 行**（+42,474；文件 1,088 → **1,205**，scale 口径只计 js/mjs） | ✅ **M4 达成：253,492 / 80.1%**，双 E2E 212/212（2026-11-26 03:40） |
| M-C 第十一批 | eval oracle、protocol 二轮（1,166 proof obligations/825 格矩阵/六阶段 migration）、MCP/SDK 二轮（resource graph/订阅 diff/prompts 版本/审批链/Python 181）、回放引擎、长截图/视频三轮、UI 二轮（数据工作台）、daemon/CLI 二轮（quota/batch/lease）、record/协作三轮 | 253.5k → **321,977 行**（+68,485；文件 1,205 → **1,372**，scale 口径只计 js/mjs） | ✅ **M5 达成：321,977 / 101.7%**，双 E2E 212/212（2026-11-26 04:47） |
| M-C 第十二批（M6 深度/质量） | E2E 扩围（212→**222**，10 条新子系统真实用例）、回放执行路径二轮（executor/boundary-exec/diff-exec/failure-matrix）、质量门禁（确定性/幂等/可解释性/反脆弱）、长尾预算（大页面/大 HAR/长 record/百片 video）、**BSK 0.5.0 差分矩阵** | 322.0k → **347,517 行**（+25,540；文件 1,372 → **1,447**） | 🟡 **M6 进行中**：双栈 E2E **222/222**；差分矩阵 619 格（equal 26 / partial 220 / missing 62 / extra 255 / unknown 56）（2026-11-26 09:14） |
| M-C 第十三批（M6 差分矩阵 P0） | MCP 工具主链路 67→**85**（press/hover/select/drag/scroll/wheel/focus/blur、console/reload/back/forward、session request_*/tab borrow/return）、6 个 feature floor 补齐（9→**15**）、daemon 通用 `cancel`/`ledger.request`、CLI 参数对齐（click/drag/evaluate/extract/read/open）、cooperate/borrow `context_id + control_policy` 控制面、差分矩阵刷新 | 347.5k → **351,837 行**（+4,320；文件 1,447 → **1,458**） | 🟡 **M6 进行中**：差分矩阵 **619→639 格**（equal 27 / partial 262 / **missing 62→38** / extra 257 / unknown 55），P0 30（2026-11-26 10:30） |
| M-C 第十四批（M6 P0 第二批） | MCP 工具 85→**92**（inspect html、assist emulate/request_help/operation_await/operation_cancel、session browsers/list）、RPC 轴 unknown 取证（schema 137→**155** + daemon typed 参数证据 + VideoParams 枚举变体）、矩阵证据表/抽取器增强 | 351.8k → **352,924 行**（+1,087；文件 1,458 → **1,459**） | 🟡 **M6 进行中**：差分矩阵 **639→646 格**（equal **33** / partial **301** / missing **31** / extra 257 / **unknown 55→24**），P0 32（2026-11-26 11:30） |
| M-C 第十五批（M6 稳定性） | E2E 抖动根因修复：JS agent-input 宽限 500→2000ms（`E_SESSION_PAUSED` 级联）、TS captureVisibleTab readback 窗口归一+重试（31 系列） | 352.9k → **352,929 行**（+5；文件 1,459） | 🟡 **M6 进行中**：**JS E2E 222/222 + TS 222/222 双栈 clean**；矩阵保持 646 格（2026-11-26 12:10） |
| M-C 第十六批（M6 语义映射 + 收口） | RPC 轴字段级语义等价映射（`FIELD_SEMANTIC_EQUIVALENTS`：operation_id↔id、wait_ms↔timeoutMs、dialog_id↔id、duration_ms↔ms），把 4 个 unknown 降为 partial（线格式不同、行为级仍需对端验证） | 352.9k → **352,967 行**（+38；文件 1,459） | 🟡 **M6 进行中（本轮为 goal 第 12/12 轮）**：双栈 E2E **222/222 + 222/222**；矩阵 **646 格**（partial 305 / unknown 20）（2026-11-26 12:45） |

### W1 实际结果（2026-11-25）

| 工作流 | 主要落地 | 行数 |
| --- | --- | ---: |
| VOM 引擎 | 六阶段漏斗（collect→resolve→filter→enrich→rank→emit，逐阶段计数/丢弃原因/耗时）、visibility/occlusion 统一 gate、token budget 裁剪、关系图 v3（contains/labels/controls/owns+confidence）、row facts 生产者与 `row-anchor` 命令 | +3,583（含 1,159 测试/夹具） |
| 动作事务 | 预写 WAL journal（内存/storage/JSONL+fsync 三形态）、重启 UNKNOWN 恢复与 reconcile、pointer/file 四态事务、输入合并、row guard 端到端（E_TARGET_MISMATCH + 证据）、fill select/date/contenteditable 步骤证据 | +3,808（源码 +2,557 / 测试 +1,251） |
| 协作 controller | 6 状态 33 迁移状态机、四项 revision/epoch 持久化、toolbar 快照、borrow 确认闸门、**capture suppression 真正包住 dispatch 截图/输入**、人类输入归因 | +4,417 |
| 协议 | feature floor 5→9（video/capture.stream/debug.journal/har）、五维方法状态机（owner/effect/partial/unknown/reconcile）、1.8/1.9×9 floor 兼容矩阵、schema 单源 | +1,769 手写（生成物 +2,212） |
| 插件 | 37 工具元数据（分类/风险/幂等/副作用/恢复）、37×4 离线矩阵（148 格）、错误恢复映射（133 码）、4 篇技能补充参考、工具索引生成 | ≈+3,900（含 1,318 测试） |
| eval | 语料分层 70 case + 127 E2E 元数据、三态指标（precision/recall/skip、fp/fn 分类、15 项阈值）、JSON+Markdown 报告器、真实 DOM case | +5,239（含语料/夹具） |

本轮同时启动**架构路线**：`apps/extension`（WXT 0.21.5 + Vite 8 + React 19 + TS 5.9，M-A 达成）与
`crates/bridge-cli`（Rust 骨架，8 项测试通过，M-D 第一步），见 `docs/ARCH-TRACK.md`。

### W1 验收（2026-11-25 16:18 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 `tests/unit/*.test.mjs` | **1402/1402 通过** |
| 真实 Edge E2E（`BB_E2E_SYNC_DOCS=0`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | 159 / 21 / 26 / 46 / 8 / 7 全过 |
| 协议门禁（gen-protocol --check、single-source、protocol-check、sections） | 全 exit 0 |
| page-lib / vom-bench / schema-audit / source+encoding guard | 全 clean |
| eval 报告器 | 70 case 三态 PASS（precision=1.0 / recall=1.0 / skip=0） |
| 体量 | **119,262 行 / 846 文件**（基线 90,694；BSK 316,463 → **37.7%**） |

> 期间修复了两处真实回归：W3 controller 交还后未恢复 daemon 会话（24b~26 六连挂）已修并有真实 E2E
> 证据；失败动作 receipt 在事务已开始时按 `unknown` 记账（35d）。另有 3 处新增测试的随机/并行
> 不确定性（eval 指标随机 id、插件 journal 竞态）已改为确定性断言。
### W2 实际结果（2026-11-25，长截图 / 视频 / 调试 / CLI / M-B）

| 工作流 | 主要落地 | 行数 |
| --- | --- | ---: |
| 长截图状态机 | 7 状态 21 迁移状态机、多段固定带 + 分数 DPR 段规划、分片索引 manifest（hash/seal/refetch）、崩溃恢复标 recovered、像素/内存预算与降级 | +4,787 |
| 视频状态机 | recording/paused/finalizing/sealed/recovered/failed、分段 manifest + seal、OPFS 扫描恢复计划（缺片/截断/校验和不匹配）、完帧与 sidx/faststart 校验、时长/体积/并发预算 | +5,000 |
| debug journal | 单调 seq + 环形缓冲 + 4 种 storage 适配器、8 阶段 coverage/gaps 根因、requestId↔trace↔截图↔journal 关联、持久化前统一脱敏、带 checksum 的导出与分页查询 | +5,006 |
| CLI 契约 | 10 个命令主题的参数契约（单一 spec 源 → 校验引擎 → risk 预检 → JSON 信封 `bb.cli/1`），`--dry-run` 与真实执行共用同一份 plan，CLI selftest 159 → **250** | +3,624 |
| M-B TS 包 | `packages/protocol`（165 方法/9 floor/五维状态，生成器 + 3 条硬校验）与 `packages/vom`（affordance/layers/rows 类型化移植）→ **差分测试 50/50**，两包 `tsc --noEmit` 通过 | +5,368（含 1,805 生成物） |

同时给 `tools/e2e.mjs` 增加 `--ext-dir`：同一套 212 条验收可直接指向 TS 产物，供 M-C 迁移使用（本轮已用它跑通 JS 扩展）。

### W2 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **1619/1619 通过** |
| 真实 Edge E2E（`--ext-dir extension`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | 250 / 21 / 26 / 46 / 8 / 7 全过 |
| 协议门禁、page-lib、vom-bench、schema-audit、source guard | 全 exit 0 / clean |
| TS 核心包 | gen `--check` clean、两包 tsc 0 错、`node --test packages/**/test/*.test.ts` 50/50 |
| 体量 | **138,648 行 / 893 文件**（BSK 316,463 → **43.8%**；scale 目标 42.1%） |

> 本轮修了 W2-D 引入的两处真实 E2E 回归：`tab new` 漏放行全局 `--session`、`extract table/list`
> 误要求 ref/selector（6 条 tab 用例 + 5 条 extract 用例）；修法都是"补全局参数 + 目标可选"，
> 未放宽既有校验语义。另有 `vision-drag` 的源码形状断言随 CLI 重构更新为行为断言。

### W3 实际结果（2026-11-25，网络 / 录制回放 / 账本 / VOM 关系图 / M-C）

| 工作流 | 主要落地 | 行数 |
| --- | --- | ---: |
| 网络/HAR/trace | HAR 1.2 往返（规范化/关联/重放计划/两次重放对比）、waterfall 分项（queueing/TTFB/download、跨 frame、streaming 不伪造完成）、WS 帧索引（分页/截断/淘汰）、trace span 树/因果链/关键路径、DNR 规则离线评估器（与下发同源） | +5,417 |
| 录制-回放 | 录制 step 模型 v2（action/observe/wait/branch/human-gate + 稳定 ref/回退/幂等）、recipe 引擎（参数/if/loop/human gate/失败策略/差异报告）、只读预检与审批 contentHash、错误证据闭环 | +4,100 |
| 会话账本 | intent ledger WAL（预写/fsync/恢复 reconcile/pending→unknown）、会话 8 状态机、tab 所有权租约（互斥/续租/冲突证据）、UNKNOWN 禁重放 + 显式 resolve、崩溃注入 | +3,219 |
| VOM 关系图 | relations v3 六类（labels/controls/owns/describes/invalidates/contains）+ 链/组合控件/跨 frame、landmark/form/table 上下文、语义压缩报告、关系查询分页 | +3,774 |
| M-C 第一批 | TS daemon 客户端（HTTP/client + WS 接入 + 错误映射）、RPC 注册表 + feature gate + 只读白名单、background `bb.rpc` 接线 | +5,004（含 2,047 测试） |

### W3 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **1879/1879 通过** |
| 真实 Edge E2E（`--ext-dir extension`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | 250 / 21 / 26 / 46 / 8 / 7 全过 |
| 协议门禁、page-lib、vom-bench、schema-audit、source guard | 全 exit 0 / clean |
| TS 侧 | `packages/*` 差分 50/50、`apps/extension` 66/66 + `tsc --noEmit` 0 错 + `wxt build` exit 0 |
| 体量 | **155,552 行 / 945 文件**（BSK 316,463 → **49.1%**；scale 目标 47.3%） |

> 本轮修了一个真实闭环缺陷：`recipe draft` 生成的 navigate 带 retry 但未声明幂等，导致
> "draft → approve → run" 被预检以 `E_ARG_CONFLICT` 拒绝（E2E 20s9）。修法是让 draft 显式声明
> `idempotent:true` 并透传（导航到固定 URL 可重复），同步更新对应单测断言。
> 另：新增 10 个账本/会话/租约错误码已登记（共 154 码）并补插件恢复映射。

### W4 实际结果（2026-11-25，MCP/SDK + i18n/a11y + 门禁 + M-B/M-C 续）

| 工作流 | 主要落地 | 自报行数 |
| --- | --- | ---: |
| MCP/SDK | 67 工具 schema↔协议 catalog 双向硬审计（启动即断言，修 3 个真实缺陷）、工具三级分类+annotations、resources/prompts 面、Node/Python SDK 契约（67 工具语义/错误码/分页/feature floor） | +4,402 |
| i18n/a11y | 12 语言覆盖门禁（4126 条，补 14 个真实缺口）、RTL 逻辑属性审计（6 条豁免带过期检测）、焦点陷阱/Escape/aria-live/aria-modal 真实 DOM（10+7 断言）、对比度 AA 门禁（130 组，修 3 处真实不达标）、错误提示 12 语言 | +4,990 |
| 门禁硬化 | daemon 派发点切 `assertProtocolCompatible`（1.8 客户端被 `E_PROTOCOL_UNSUPPORTED` 拒绝，真实 daemon 测试）、性能预算门禁（4 热路径 p50/p95+内存）、发布 preflight 7 项一致性检查、规模门禁与 BSK 对标百分比 | +2,971 |
| M-B 续 | `packages/vom` 移植 relations/context/compress/query（差分 16/13/13×7/12×30 组）、`packages/protocol` schema 单源生成（137 keys/别名）、两包 119 条 TS 测试 | +9,018 |
| M-C 第二批 | TS 动作面（observe/click/fill/read/select/get-html/evaluate）、ref 生命周期（与 JS 差分对拍）、内容脚本最小桥、多端口发现、background 运行时；TS 产物跑 E2E **29/212 通过**（未迁移能力如实分类，不伪装） | +7,600 |

### W4 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **2040/2040 通过** |
| 真实 Edge E2E（`--ext-dir extension`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | 250 / **59** / 26 / 46 / 8 / 7 |
| 协议门禁、page-lib、vom-bench、schema-audit、source/encoding/vendor-leak guard | 全 clean |
| TS 侧 | `packages/*` 119/119、`apps/extension` 142/142、两包 tsc 0 错、`wxt build` exit 0 |
| 体量 | **167,215 行 / 985 文件**（BSK 316,463 → **52.8%**；scale 目标 50.8%） |

> 本轮修了两个真实回归：MCP 对 destructive 工具的审批默认开启会掐断既有本地自动化（E2E 20j）——
> 改为**默认不强制、`BB_MCP_APPROVAL=required` 显式启用**，`browser_update` 恒审批；以及
> `MCP evaluate` 语义与 selftest 显式断言，MCP 自测 21 → 59。
> 另修 vendor-leak：源码注释中的参考实现名称已改中性表述，发布 preflight 的 vendor-leak 门禁转绿。
> 体积口径说明：自报行数含测试/夹具/生成物与 apps/packages，`scale-report` 只统计产品代码面，故两数不同。

### W5 实际结果（2026-11-25，MCP/trace/Rust/M-C/浮层）

| 工作流 | 主要落地 | 自报行数 |
| --- | --- | ---: |
| MCP resources/Python SDK | journal 资源 + 统一分页（cursor/截断，W5 时 `subscribe=false`；**W7-C 起升级 `subscribe=true`，推送 notifications/resources/updated**）、9 个 prompt 模板（含 HAR/网络/长截图恢复/视频校验）、工具成功后回填快照；Python SDK 工具级 `call_tool` 覆盖 67 工具（生成目录 + 校验/审批/超时/分页），三方契约测试 | +3,726 |
| trace/recipe/恢复回归 | trace viewer span 树/关键路径/因果链 + 分页 + 体积降级（真实 Chromium 38 断言）、recipe run 差异报告接入 CLI/JSON/`*.diff.json`、长截图/视频恢复真实夹具（77 + 65 断言） | +2,686 |
| Rust CLI 第二批 | std-only JSON 编解码、`/rpc` 与 WS 帧信封、154 错误码/165 方法/9 floor **由 JS 单源生成**（`--check` 漂移门禁）、8 状态会话状态机、hello 协商（1.8/1.9/2.0） | +6,029（Rust 6,257 行，108 测试） |
| M-C 第三批 | TS 截图（可见/整页/元素/区域/差分/流式，无 debugger）、network 只读、get-html、tab 策略/别名；evaluate 改走 `chrome.scripting` 修 CSP | +5,895（TS 239 测试；E2E **76/212**） |
| 浮层 a11y + 动态文案 | help/borrow 模态焦点陷阱、record/manual/takeover 的 aria-live/Escape/焦点归还；151 词条 × 12 语言动态文案 catalog（生成分片，单文件 <1,100 行） | +5,528 |

### W5 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **2119/2119 通过** |
| 真实 Edge E2E（`--ext-dir extension`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | 250 / **82** / 26 / 46 / 8 / 7 |
| Rust（GNU target + rust-lld） | `cargo test` **108/108**、`cargo check --all-targets` 0 |
| Python SDK | 64 项 unittest 全过 |
| TS 侧 | `packages/*` 119、`apps/extension` 239、tsc 0 错、`wxt build` exit 0、TS 产物 E2E **76/212** |
| 体量 | **177,208 行 / 1,006 文件**（BSK 316,463 → **56.0%**；scale 目标 53.9%） |

> 修的真实问题：`bridge trace view` 因 CLI 未注入 viewer 整体不可用（命令内加兼容回退并加回归单测）；
> 浮层动态文案单文件 2,350 行触发复杂度门禁（改为生成分片，全部 <1,100 行）；overlay a11y 夹具
> 的拍帧时序改为轮询等待（不再 flaky）。

### W6 实际结果（2026-11-25，MCP 深度 / CLI / 协议单源 / M-C 四批 / M-D 三批）

| 工作流 | 主要落地 | 自报行数 |
| --- | --- | ---: |
| MCP 深度 | 快照持久化（原子写/TTL/大小上限/重启恢复）、进度通知（4 档节流 + Python 回调）、取消（抑制响应 + best-effort `command.cancel`）、resources 新鲜度元数据 | +3,408（selftest 82→110，Python 86） |
| CLI | `video/longshot recover` 与 `debug/trace` verdict 化摘要、README 命令索引生成器（`--check` 门禁）、help↔specs 一致性；修 `debug performance --insight` 未导入缺陷 | +4,111（selftest 250→282） |
| 协议单源收口 | `protocol.mjs` 196→71、`methods.mjs` 136→107，手工表全部由 catalog 派生；新增第 13 条审计段（运行时手工表/依赖方向/字面量预算）+ 收口前差分基线 | +2,124（protocol 130 测试） |
| M-C 第四批 | observe VOM/AX/facts、frames、dialog、upload/download、debug 只读域、manual/segmented 截图 | +4,113（TS 23,715 行；E2E **76 → 135/212，0 回退**） |
| M-D 第三批 | daemon 发现、std-only HTTP/1.1、手写 WebSocket（含 Accept 校验/掩码/分片/ping）、真实 `status`/`health`/`ws-hello` | Rust 6,261→**11,096 行**，195 单测 + 3 集成冒烟 |

### W6 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **2314/2314 通过** |
| 真实 Edge E2E（`--ext-dir extension`） | **212/212 通过，0 跳过** |
| CLI / MCP / 插件 / 配对 / TLS / ws | **282** / **110** / 26 / 46 / 8 / 7 |
| Rust | `cargo test` **198**（195 单测 + 3 进程级冒烟）、`cargo check --all-targets` 0 |
| Python SDK | **86** 项 unittest 全过 |
| TS 侧 | `packages/*` 119、`apps/extension` 251、tsc 0 错；TS 产物 E2E **135/212** |
| 体量 | **186,146 行 / 1,022 文件**（BSK 316,463 → **58.8%**；scale 目标 56.6%） |

> 修的真实问题：`debug performance --insight` 引用未导入函数（必然 ReferenceError）；新增 4 个错误码
> （MCP 快照 3 + `E_UNSUPPORTED` 兼容别名）已登记（共 158 码）并补插件恢复映射。
> TS E2E 剩余 77 项失败已按能力分类：CDP/debugger-only ≈29、OOPIF 链 ≈10、VOM 深水区 5、
> 长截图 CDP 路径 4、UI 子页面 15、UIA/浮层 8、其它 4——均为未迁移，非回归。

### W7 实际结果（2026-11-25，长截图/UI + Rust 会话 + MCP subscribe + CLI specs + TS VOM）

| 任务 | 工作流 | 落地内容（行数归属 W7 窗口，不按任务拆分） |
| --- | --- | --- |
| task-37 | M-C 第五批 | TS 长截图分段（`apps/extension/src/capture/longshot.ts`）+ 8 个 UI 子页面（longshot/debug/audit/ops/record/options/quick/preview）+ content VOM facts/summary；TS 产物 E2E 135 → **146/212**（新增 11、0 回退；目标 ≥170 未达） |
| task-38 | M-D 第四批 | Rust TLS 策略（明文/wss 明确拒绝）+ `session start/stop/list` + `observe`；`cargo test` **260**（254 单测 + 6 集成）、`cargo check --all-targets` 0、生成物漂移 0、真实 daemon 冒烟（隔离 `BB_HOME`）通过 |
| task-39 | W7-C | MCP `resources/subscribe` 推送（notifications/resources/updated）+ Node SDK 进度/取消 + 快照并发保护；`tests/mcp/selftest.mjs` **128/128** |
| task-40 | W7-D | `video/longshot/record/debug/trace` 严格 specs + `--dry-run` 白名单 + README 命令索引门禁；CLI selftest **309/309**、`readme-commands --check` clean（15 命令） |
| task-41 | W7-E | TS VOM 统一消费 `packages/vom` + 与 JS 逐字段差分（9/9）；`jsLibsPromise` 断言改 4 元组（`tests/vom-diff.test.ts` 382→387 行）；`tsc --noEmit` **0 错**、TS 测试 **306/306** |

> W7 窗口净增 **+17 文件 / +5,075 行**（186,146 → 191,221）。本机无 git，无法按任务拆分增量，
> 故只记“归属 W7 窗口”，不臆造每任务行数。

### W7 验收（2026-11-25 实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 `node --test tests/unit/*.test.mjs` | **2392/2392 通过**（64.2s） |
| 真实 Edge E2E（JS 工作树 `--ext-dir extension`） | **212/212 通过，0 跳过，0 失败**（21:53–22:00，端口 54007） |
| TS 产物 E2E（`--ext-dir apps/extension/.output/chrome-mv3`） | **146/212**（两次跑分一致、失败集合 diff 空）；**目标 ≥170 未达（差 24）**；vs 上轮 135 **回退 0、新增通过 11** |
| CLI / MCP / 插件 / 配对 / TLS / ws | **309** / **128** / 26 / 46 / 8 / 7，扩展模块加载 PASS、page-guard PASS、overlay 13 |
| Rust（GNU target + rust-lld 口径） | `cargo test` **260**（254 单测 + 6 集成，0 fail）、`cargo check --all-targets` 0、生成物漂移 0（只读复刻：158 码/48 恢复/165 方法/9 floor）；真实 daemon 冒烟（隔离 `BB_HOME`：session start/list/observe/stop + daemon.stop 自清） |
| TS 侧（`apps/extension`） | `tsc --noEmit` **exit 0**、TS 测试 **306/306**；`wxt build` exit 0、`version=0.3.0` |
| 其它门禁 | source/encoding（1,446 文件）/mojibake clean、vendor-leak clean、page-lib clean（23 parts / 4,739 行）、vom-bench ok、schema-audit ok、deps-audit ok、协议门禁（single-source / protocol-check / gen-protocol --check / sections --fail）全 exit 0、`readme-commands --check` clean（15 命令） |
| 体量 | **191,221 行 / 1,039 文件**（BSK 316,463 → **60.4%**）；`tools/scale-baseline.json` 已随本轮更新为 1,039/191,221 |

> **TS 产物 E2E 差额如实记账（未达标，不写成达标）**：66 项失败分类 —— E_UNKNOWN_METHOD 22、
> E_NOT_IMPLEMENTED 2、VOM 深水区 9、CDP 输入/Fetch/journal 8、OOPIF 4（+链式 9）、UI 子页面 7、
> 人工浮层 2、其它 3（35d fail-closed、35e follow rebind、23j4 错误码语义）；差额集中在
> CDP/debugger 域（record/video/emulate/pdf/trace/Fetch/OOPIF/closed-shadow/trusted）与 VOM 深水区。
> 详细报告：`.tmp/w7c-e2e-report.md`。**目标 ≥170 未达（差 24）→ 移交 M-C 第六批（待用户决策）**。
> Rust 口径风险：仍依赖 gnu target + rust-lld + `RUSTC_BOOTSTRAP=1`/`-Z unstable-options`；
> `crates/bridge-cli/README.md:82–83` 已按实际改写为“只装 `stable-x86_64-pc-windows-gnu`、
> rustup host 仍 msvc 但无 MSVC/MinGW 工具链”（收口期间由 B/lead 修正，与实测一致）；
> `--profile minimal` 未完全生效（多装 rust-docs/rustfmt/clippy，无害）。

### M-C 第六批实际结果（2026-11-25 夜，CDP/OOPIF + VOM 深水区 + 缺陷/UI + CDP 域 + 35d 异步窗口）

| 任务 | 主要落地 | 行数（自报） |
| --- | --- | ---: |
| task-6 CDP 通道 + OOPIF | `src/cdp/**` 10 文件：attach 去重/超时/子 session/teardown、frame-owner 投影、frames 接入；翻转 23p3/7/8/9 + 链式 23q/r/s/u/v/w/x2/x4 等 | 3,654 |
| task-7 VOM 深水区 | `packages/vom` graph/frame-vom/color + `src/content/vom-{deep,layers,visual,page-graph,frames}.ts` + `rich.ts` 装配（14 文件）；翻转 35c/35f/35g/35h/15d/15e | 5,242 |
| task-8 缺陷/UI | 35d fail-closed、35e follow/rebind、23j4 `E_TARGET_DETACHED`、29 popup 别名页 + BOM 根因修复、29d RTL；翻转 29/29d/30/35e/23j4 | 未单列 |
| task-10 35d 异步窗口 | 合成 focus + ≤20ms 有界复核、content bridge 异步回包 → 35d 稳定通过 | 未单列 |
| task-9 CDP 域 | Fetch/规则、PDF、emulate、trace、可信输入、closed-shadow pierce、debug CDP 采集（9 新模块 + debug/service/recorder/rules/network/screenshot 改造）；翻转 20b/20f/20u/20u2/20v2/20w/20x/20y/21 等 | 未单列 |
| task-12 回归收口 | 20b3/31g 两回归修复：debug 停止后只读面返回最近快照；emulate reset 硬化 + **仅视口**截图 ≤8px 对齐裁剪（整页/区域/元素仍严格）→ 最终 179/212、0 回退 | 未单列 |

> task-8/10/9/12 的增量已并入本轮工作树，本轮未按任务单列行数，故记“未单列”（不臆造）。
> 上一轮 W7 收口为 146/212；本批 **146 → 179（+33）**，对 135 基线 **回退 0、新通过 44**。
> 途中一轮曾为 177/212（出现 2 个回归 20b3/31g），由 cdp-domains 修复后 **179 复跑 0 回退**。

### M-C 第六批验收（2026-11-25 23:30 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| TS 产物真实 Edge E2E（`--ext-dir apps/extension/.output/chrome-mv3`） | **179/212 通过，0 跳过，33 失败**；对 135 基线 **回退 0、新通过 44**；比 W7 收口的 146 **净增 +33**；**目标 ≥170 已达成** |
| JS 工作树真实 Edge E2E（端口 54007） | **212/212 通过，0 跳过，0 失败** |
| 单测 / CLI / MCP / 插件 / 配对 / TLS / ws / overlay | **2392/2392** / **309** / **128** / 26 / 46 / 8 / 7 / 13；扩展模块加载、page-guard PASS |
| Rust | `cargo test` **260**（254 单测 + 6 集成，0 fail）为 W7 收口复跑值；本批未改 `crates/**`，**未复跑** |
| 协议 / 静态门禁 | single-source、protocol-check、gen-protocol `--check`、sections `--fail` 全 exit 0；page-lib clean（23 parts / 4,739 行）、vom-bench / schema-audit / deps-audit / `readme-commands --check` clean |
| source/encoding（1,446 文件）/mojibake/vendor-leak | clean |
| TS 侧（`apps/extension`） | `tsc --noEmit` **0 错**、TS 测试 **416/416**（W7 收口时 306）、`wxt build` exit 0、产物含 `ui/popup.html` |
| 体量（scale 口径） | **1,039 文件 / 191,332 行**（BSK 316,463 → **60.5%**）；`tools/scale-baseline.json` 已刷成 1,039/191,332，`--check` exit 0 |
| 架构栈行数（口径单列） | `apps/extension` 产品 TS **29,759** 行 + 测试 TS **11,864** 行；`packages/**` TS **13,698** 行；`crates/**` Rust **13,141** 行 |

> **剩余 33 项失败（如实，未达成）→ 按四类移交下一轮**：
> ① 录制/视频类：20c、20c2、20d、20d2~20d10、20g、24c、24d、32、33d、35、35r（按 ID 展开 19 项）；
> ② closed-shadow/trusted/refs 接线（8）：18e、20v、20z、5b、5f、7、7b、35b；
> ③ 人工协作/UIA（5）：23u、23w、23x、24b、24b2；④ annotate（1）：23q。合计 **33**。
> 本轮文档收口会话**未复跑** E2E/cargo/单测，数字均为 lead 本批实测。

### M-C 第七批实际结果（2026-11-26 00:20 前后，动作/引用层 + observe/VOM + 人工协作/annotate）

| 工作流 | 主要落地 |
| --- | --- |
| R2a 动作/引用层 | `actions/backend-locator.ts` 574 行、`trusted-input.ts` 575、`file-input.ts` 314；`registry.ts` 893→**1,153**、`extended.ts` 1,326→**1,476**、`params.ts` 417→**468**、`observation.ts` 173→**185**；测试 **1,274 行 / 34 例** |
| R2b observe/VOM | `content/vom-weights.ts` 733（新）、`rich.ts` 1,296、`session.ts` 1,032、`protocol.ts` 622、`refs/registry.ts` 585；测试 **527 行 / 23 例** |
| R3 人工协作/annotate | `content/cooperation.ts` 663（新）、`runtime/cooperation.ts` 748（新）、`runtime/index.ts` 导出、`capture/screenshot.ts` annotate 修复（`capture_id` 与 `captureId` 分离）；测试 **35 例** |
| lead 集成 | `background.ts`（共享 input/pierce/backend/fileInputs 注入 actions/extended；observe 的 closed-shadow 枚举 + `DOM.getBoxModel`；`refs.negotiate` 注册；`CooperationRuntime` + `createCooperationCommands`；`bb.human.*` / `bb.help.resolved` 消息；click-backend/shadow.click 的 `markAgentInput`；`UploadService` 大文件 CDP 兜底）、`entrypoints/content.ts`（`installHumanWatch`） |

> **本轮翻转 14 项（179 → 193，+14，0 回退）**：`18e`（大文件 input→CDP `setFileInputFiles`）、
> `7`（select+click）、`7b`（stableRef 驱动动作）、`20v`（closed shadow 入 observe + ref 点击/读取）、
> `20z`（`--trusted` 经 CDP Input 通过反爬）、`23q`（annotate 坐标 capture 与流式 id 分离）、
> `23u`（human-watch 检测人工操作）、`23w`（strict context 会话级固定）、`23x`（handback 后立刻 ready）、
> `24b` / `24b2`（request-help 浮层 + 条件自动交还）、`5b`（`observe --vom` 结构化节点 / `refs.negotiate`）、
> `5f`（`--ax` 未映射可交互元素）、`35b`（refDetails `cdpSessionId` + hitTest）。

### M-C 第七批验收（2026-11-26 00:20 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| TS 产物真实 Edge E2E（`--ext-dir apps/extension/.output/chrome-mv3`） | **193/212 通过，0 跳过，19 失败**；比第七批前的 179 **+14**；对 179 与对 135 基线均 **0 回退** |
| JS 工作树真实 Edge E2E（端口 54007） | **212/212 通过，0 跳过** |
| 单测 / CLI / MCP / 插件 / 配对 / TLS / ws / overlay | **2392/2392** / **309** / **128** / 26 / 46 / 8 / 7 / 13；扩展加载、page-guard PASS |
| 协议 / 静态门禁 | single-source、protocol-check、gen-protocol `--check`、sections `--fail` 全 exit 0；page-lib clean（23 parts / 4,739 行）、vom-bench / schema-audit / deps-audit / `readme-commands` clean |
| source/encoding（1,446 文件）/mojibake/vendor-leak | clean |
| TS 侧（`apps/extension`） | `tsc --noEmit` **0 错**、TS 测试 **508/508**（第六批收口时 416，本轮 **+92**）、`wxt build` exit 0 |
| 体量（scale 口径） | **1,039 文件 / 191,339 行**（BSK 316,463 → **60.5%**）；`tools/scale-baseline.json` 已刷成 1,039/191,339，`--check` exit 0 |
| 架构栈行数（口径单列） | `apps/extension` 产品 TS **34,283** 行；`packages/**` TS **13,698** 行；`crates/**` Rust **13,141** 行 |
| Rust | 本批未改 `crates/**`，**未复跑**（沿用 W7 收口 `cargo test` 260） |

> **剩余 19 项失败（如实，未达成）→ 全部 record/video 录制与页面，移交下一轮**：
> 20c、20c2、20d、20d2~20d10、20g、24c、24d、32、33d、35、35r；属 record/video 服务迁移，
> 计划拆「record 核心」+「video 核心/页面」两路。本轮文档收口会话**未复跑** E2E/cargo/单测，
> 数字均为 lead 本批实测。

### M-C 第八批实际结果（2026-11-26 01:57 前后，record/video 服务 + replay/takeover + 对齐修复）

| 工作流 | 主要落地 | 行数（自报） |
| --- | --- | ---: |
| A record 服务 | `src/record/**`（types/steps/sources/store/trace/service/capture/messages/chrome-deps/ops-selftest）+ `src/content/record-overlay.ts` + 重写 `src/ui/pages/ops.ts`；20d/20d2…20d10、24c、32 全通 | 约 3,100 |
| B video 服务 | `src/video/**` 12 模块（service/offscreen/mp4/store/runtime/verify/selftest/state/manifest/hash/protocol/types）+ 重写 `src/ui/pages/record.ts` + `entrypoints/offscreen.html`；20c/20c2/20g/35/35r 全通；headless 证据：tabCapture 被拒 → CDP screencast → 离屏编码器，`ftyp` / `faststart=true` / 分片 sha256 真实 | 约 3,350 |
| C 33d/24d | debug 页真实 replay 面板（`SELFTEST:ok:replay:200`）+ takeover 浮层（closed shadow `__bb_takeover_host`）与截图抑制 hook（hide→capture→restore） | 未单列 |
| 修复批次 | video 字节传输从 JSON 化的 Uint8Array 改为 `data_base64` 线格式 + 僵尸录制全路径清理；record 边界去重/往返；20d5 `tab.new --window` 走 `windows.create`；20d7 E2E alias 选择修正（同一 frame + ref/localRef/`@f<id>eN` 四种等价写法，不弱化断言） | 未单列 |
| lead 集成 | background 的 record/video RPC、`bb.record.*` 消息闸门（async handler 吞消息 bug 修复）、takeover 浮层在 `evaluate` 前强制装好 + 导航后重装、`overlay-suppress` op、`refs.negotiate`、observe closed-shadow；content 入口 human-watch | 未单列 |

> A/B record+video 新模块合计 **6,462 行**；本轮翻转 19 项（193 → 212，+19，0 回退）。

### M-C 第八批验收（2026-11-26 01:57 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| TS 产物真实 Edge E2E（端口 54207） | **212/212 通过，0 跳过，0 失败**；比第七批的 193 **+19**、本轮 **0 回退** |
| JS 工作树真实 Edge E2E（端口 54007） | **212/212 通过，0 跳过，0 失败** |
| 单测 / CLI / MCP / 插件 / 配对 / TLS / ws / overlay | **2392/2392** / **309** / **128** / 26 / 46 / 8 / 7 / 13；扩展加载、page-guard PASS |
| 协议 / 静态门禁 | single-source、protocol-check、gen-protocol `--check`、sections `--fail` 全 exit 0；page-lib clean（23 parts / 4,739 行）、vom-bench / schema-audit / deps-audit / `readme-commands` clean |
| source/encoding（1,446 文件）/mojibake/vendor-leak | clean |
| TS 侧（`apps/extension`） | `tsc --noEmit` **0 错**、TS 测试 **648/648**（第七批收口 508，本轮 **+140**）、`wxt build` exit 0 |
| 体量（scale 口径） | **1,042 文件 / 191,343 行**（BSK 316,463 → **60.5%**）；记账时（02:05）工作树复测 **191,354 行**（+11，来自 `dsh-plugin/lib/skill-content.generated.mjs` 02:01:57 的生成物更新，非本批交付）；`tools/scale-baseline.json` 按复测值记录、`--check` exit 0 |
| 架构栈行数（口径单列） | `apps/extension` 产品 TS **42,235**（本轮 **+7,952**）；`packages/**` TS **13,698**；`crates/**` Rust **13,141**；其中 record+video 新模块 **6,462** 行 |
| Rust | 本批未改 `crates/**`，**未复跑**（沿用 W7 收口 `cargo test` 260） |

> **M-C 里程碑达成：TS 产物 212/212 = JS 基线 212/212**（架构路线最关键的等价性证据）。
> 剩余差距在**体量/深度**：191,343 行 = BSK 的 60.5%；下一轮目标体量 ≥200k（约 63%）并补 depth
> 缺口（长尾 record/video 能力、真实 UI 交互覆盖）。本轮文档收口会话**未复跑** E2E/cargo/单测，
> 数字均为 lead 本批实测。

### M-C 第九批实际结果（2026-11-26 02:45 前后，JS video/record + daemon/CLI + HAR/trace + 观察/审计；均“只加不改”并给运行时消费点）

| 工作流 | 主要落地 | 行数（自报） |
| --- | --- | ---: |
| A JS video/record | `lib/video-{seal,degrade,restore}.js`、`record-program.js`、`record-merge.js`；接入既有 `video.start/status/stop/verify/save/recover/list/prune` 与 `record` 事件入口（`bridge.js:606 → record-events.js`）；manifest seal v2 / 不变量 / 摘要对账、预算降级计划与历史、partial 重组、多源事件去重合并、step 校验、行级 diff 三方归并、重放幂等预检 | +5,367（源码 3,716 + 测试 1,651） |
| B daemon/CLI | `daemon/{transfer-policy,command-queue,ledger-report,doctor,status-views}.js` + `cli/lib/daemon-views.mjs`；`ledger.status/resolve` 快照/对账、transfer 配额/断点续传/整文件 sha 校验、命令队列公平调度 + 诊断（`E_QUEUE_FULL` / `E_SESSION_BUSY` / `E_SESSION_STOPPED`）、`daemon ledger\|transfer\|queue\|doctor` CLI；旧默认载荷不变（selftest 有键集断言） | +5,136（新增 4,285 + 修改 851） |
| C lib HAR/trace | `lib/har-merge.mjs`（多 HAR 合并/去重/时间归一/冲突裁决）、`waterfall-attribution.mjs`（三段归因/慢请求/streaming 伪完成/跨帧）、`trace-budget.mjs`（确定性采样/span 选择/导出计划）；接入 `debug har\|har-import`、MCP `browser_debug_har*`、`trace summary/diff/view`、`record export`；空 trace 摘要 deepEqual 不变 | +4,373（新增 4,117 + 修改 256） |
| D JS 观察/审计 | `lib/vom-{zorder,relations-chain,visual-identity,degrade,frames-depth}.js`、`src/audit-{journal,integrity}.js`；`--vom` 时追加 `vomZOrder/vomRelationChains/vomVisualIdentity/vomEvidence/vomFrameDepth`（默认 observe 字段断言为空），`bb.audit.list` 新增 integrity/snapshot/diff/timeline/journal | +4,561（代码 3,060 + 测试 1,501） |

> 四条工作流自报新增合计 **+19,437**；scale 口径本轮净增 **+19,664 行**（191,354 → 211,018，
> 含工作流外其他增量，未逐项拆分）。

### M-C 第九批验收（2026-11-26 02:45 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| 体量（scale 口径） | **1,088 文件 / 211,018 行**（BSK 316,463 → **66.7%**；本轮 **+19,664 行**）；分组 other 87,767 / extension 74,549 / lib 18,057 / cli 17,063 / daemon 6,988 / mcp 6,594；`--update-baseline` 后 `--check` exit 0 |
| 架构栈行数（口径单列） | `apps/extension` 产品 TS **42,235**；`packages/**` **13,698**；`crates/**` Rust **13,141**（本轮未改） |
| 真实 Edge E2E（JS 工作树 / TS 产物） | **212/212 / 212/212**（各 0 跳过、0 失败） |
| 单测 / CLI / MCP / 插件 / 配对 / TLS / ws / overlay | **2649/2649** / **346/346**（基线 309，**+37**） / **128** / 26 / 46 / 8 / 7 / 13；module-load、page-guard PASS；`unused-extension-modules` unused=0 |
| 协议 / 静态门禁 | single-source、protocol-check、gen-protocol `--check`、sections `--fail` 全 exit 0；page-lib clean（23 parts / 4,739 行）、vom-bench / schema-audit / deps-audit / `readme-commands` clean |
| source/encoding（1,492 文件）/mojibake/vendor-leak | clean |
| TS 侧 | `tsc --noEmit` **0 错**（TS 栈本轮未改） |

> **M3 达成（体量 ≥200k / 约 63%）：211,018 行 = BSK 66.7%**。下一目标 **M4**（≥250k，约 79%）。
> E2E 双 212 保持；本轮无新增 RPC 方法名（B 的视图/快照/批量 reconcile 全走既有方法参数扩展）。
> 本轮文档收口会话**未复跑** E2E/cargo/单测，数字均为 lead 本批实测。

### M-C 第十批实际结果（2026-11-26 03:40 前后，协议/状态机 + MCP/SDK + 协作/toolbar + 长截图/视频持久化 + UI 深度 + daemon 租约/恢复；均“只加不改 + 既有路径消费”）

| 工作流 | 主要落地 | 行数（自报） |
| --- | --- | ---: |
| A protocol/状态机 | `lib/protocol*.mjs`、`method-catalog`、新 `method-state-machine.mjs`（165 方法六面可证明性、69 族规则/47 例外/107 恢复 playbook、floor 协商/降级/迁移）；经 daemon 派发闸门、health/status、SDK contract、MCP floor 审计消费 | +6,537 |
| B MCP/SDK | JSON-RPC 信封/版本协商/启动硬审计、resources/prompts 分页 + 新鲜度、completion、审批三级、错误恢复映射、Node McpClient、Python retry/paging/并发/取消；MCP 128→**166**、Python 93→**142** | +7,127 |
| C 协作/toolbar/borrow | passthrough 引用计数租约、handback 状态机、toolbar controller（焦点/键盘/ARIA）、borrow 哈希链证据闭环；接 `tab.borrow` / borrow-confirm / cooperation 既有路径 | +7,184 |
| D 长截图/视频持久化 | bands/dpr/shard/resume/stale/degrade/stitch 接入 `--full-page` 渲染链；video journal/frames/persist 接入 `video.*` 返回字段；`video.js` 压回 **1,099 行**守预算 | +7,970 |
| E UI 深度 | debug/audit/ops/record/longshot 页面真实 RPC 深交互 + 15 helper + 3 视图；`ui-*` 单测 117、相邻 UI 门禁 64；`SELFTEST:ok:*` 契约逐字保留 | +7,486 |
| F daemon 租约/恢复 | lease-registry/ops、命令边界矩阵、恢复报告、两段式 manual resolve；`status views=['leases'\|'boundary']`、`ledger.status {recovery:true}`、`ledger.resolve {ids,dryRun}`；CLI selftest 346→**356** | +6,239 |

> 六条工作流自报新增合计 **+42,543**；scale 口径本轮净增 **+42,474 行**（211,018 → 253,492，
> 差 69 属口径/取整，未逐项拆分）。

### M-C 第十批验收（2026-11-26 03:40 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| 体量（scale 口径） | **1,205 文件 / 253,492 行**（BSK 316,463 → **80.1%**；本轮 **+42,474 行**）；分组 other 106,688 / extension 89,967 / lib 20,541 / cli 17,063 / daemon 10,308 / mcp 8,925；`--update-baseline` 后 `--check` exit 0 |
| 架构栈行数（口径单列） | `apps/extension` 产品 TS **42,235**；`packages/**` **13,698**；`crates/**` Rust **13,141**（本轮未改） |
| 真实 Edge E2E（JS 工作树 / TS 产物） | **212/212 / 212/212**（各 0 跳过、0 失败） |
| 单测 / CLI / MCP / Python | 单测 **3476/3476**、CLI **356/356**、MCP **166/166**、Python **142 OK**；module-load PASS、`unused-extension-modules` unused=0、architecture-guards / error-codes / performance-budget PASS |
| 其它门禁 | 协议 single-source、protocol-check、gen-protocol `--check`、sections `--fail` 全 exit 0；page-lib / vom-bench / schema-audit / deps-audit / `readme-commands` clean；source/encoding / vendor-leak clean |
| TS 侧 | `tsc --noEmit` **0 错**（TS 栈本轮未改） |

> **M4 达成（体量 ≥250k / 约 79%）：253,492 行 = BSK 80.1%**。下一目标 **M5（≥316k，100%）**。
> E2E 双 212 保持；本轮无新增 RPC 方法名（新能力全部走既有方法参数/视图）。本轮文档收口会话
> **未复跑** E2E/cargo/单测，数字均为 lead 本批实测。

### M-C 第十一批实际结果（2026-11-26 04:47 前后，eval oracle + protocol 二轮 + MCP/SDK 二轮 + 回放引擎 + 长截图/视频三轮 + UI 二轮 + daemon/CLI 二轮 + record/协作三轮；均“只加不改 + 既有路径消费”）

| 工作流 | 主要落地 | 行数（自报） |
| --- | --- | ---: |
| A eval oracle | `tools/eval/**`：seed/收缩/最小反例、102 property、确定性门禁 | +9,464 |
| B protocol 二轮 | 1,166 条可执行 proof obligations、825 格兼容矩阵 runner、六阶段 migration planner | +9,104 |
| C MCP/SDK 二轮 | resource graph/订阅 diff、prompts 版本硬门禁、审批链、恢复 playbook、Python 异步全 67 工具；MCP 166→**196**、Python 142→**181** | +8,900 |
| D 回放引擎 | 确定性计划/边界还原/目标还原/差异校验/错误码解释/自检 + 接线 | +9,230 |
| E 长截图/视频三轮 | 帧级台账/对账/重绘、压缩与存储配额、转码/fMP4 分片预算、分片恢复 | +8,227 |
| F UI 二轮 | 数据工作台：导入导出/DSL 过滤/列配置/对比矩阵/逐行 diff；`SELFTEST` 契约零改动 | +9,479 |
| G daemon/CLI 二轮 | quota/batch/lease arbitration + CLI 命令面；CLI 356→**387** | +9,184 |
| H record/协作三轮 | step 执行图、执行计划 dry-run、回放会话、human/borrow 证据链 | +8,083 |

> 八条工作流自报新增合计 **+71,671**；scale 口径本轮净增 **+68,485 行**（253,492 → 321,977）；
> 差 **3,186** 属口径/取整/任务间调整，未逐项拆分。

### M-C 第十一批验收（2026-11-26 04:47 前后实跑）

| 门禁 | 结果 |
| --- | --- |
| 体量（scale 口径，M5 达成） | **1,372 文件 / 321,977 行**（BSK 316,463 → **101.7%**；本轮 **+68,485 行**；scale target 329,000 → **97.9%**）；记账时（04:48）复测 **321,979 行**（+2，来自 `dsh-plugin/lib/skill-content.generated.mjs` 04:38:16 重生成），`--update-baseline` 后 `--check` exit 0 |
| 真实 Edge E2E（JS 工作树 / TS 产物） | **212/212 / 212/212**（0 跳过、0 失败；TS 侧本轮未改但复跑通过） |
| 单测 / CLI / MCP / Python | **4639/4639** / **387/387** / **196/196** / **181 OK** |
| eval 门禁 | `node tools/eval/run.mjs --check` **PASS**（102 property / 6,528 checks，runtime 69 symbols / 16 modules） |
| 其它门禁 | module-load PASS、unused=0、architecture-guards/reachability 全绿、performance-budget PASS；协议 4 门禁 exit 0；page-lib / vom-bench / schema-audit / deps-audit / readme / source-guard / vendor-leak clean |
| TS 侧 | `tsc --noEmit` **0 错**（TS 栈本轮未改） |

> **集成修复（本轮验收注意事项，5 条）**：
> 1. **scale 护栏调整（有意）**：`tools/scale-report.mjs` 的 `maxFiles 1,400→1,650`、
>    `maxLines 260,000→340,000`；理由 = BSK 对标目标 316,463 行本身高于旧发布护栏；
>    `baseline.regression ±0.5%` 与 `minParity 25%` **未放松**。
> 2. **MV3 真实缺陷**：回放包装层原用动态 `import()`，真实 SW 抛
>    `import() is disallowed on ServiceWorkerGlobalScope`（JS E2E 20b/33d 复现 210/212）→ 改静态
>    import 后 JS 212/212 恢复；对应守卫测试改为“禁止 `await import(`”。
> 3. **新错误码登记**：`E_PROTOCOL_AUDIT` 进 `lib/error-codes.mjs` + `dsh-plugin/lib/error-recovery.mjs`
>    + Python RECOVERY_HINTS，`gen-error-codes` 同步（158→159）。
> 4. **unused 收口**：`record-exec-replay.js` 接进 record export（回放会话摘要 + 幂等 token），unused=0。
> 5. 修复两个“超出 100%”就误报的测试上界（scale parity <150、wiring 守卫）。

### M-C 第十二批实际结果（2026-11-26 09:14 前后，M6 深度/质量：E2E 扩围 + 回放执行 + 质量门禁 + 长尾预算 + 差分矩阵）

- **A E2E 深度扩围**：`tools/e2e.mjs` 在既有 212 条逐字不动的前提下新增 10 条真实 CLI/daemon/Edge 用例
  （`38` network replay 确定性——真实服务端计数递增 `hit=2→3`、`token/fingerprint` 两次一致；`38b` debug replay
  CLI；`38c` status 兼容证据 `obligations=62` + 1.8→1.9 upgrade-required；`38e/38f` batch plan/start（真建 2
  会话+导航+幂等复用）；`38g` lease report/arbitrate（dry-run + `--apply` 缺 `--yes` 拒绝 exit 2）；`38h` status
  `--views queues`；`38i` debug har `_validation`；`38j` video persistence；`38k` longshot shard/restore 证据）。
  套件规模 **212 → 222**。+约 450 行（含夹具 `/api/replay-count` 真实副作用路由与 `rpcDirect`）。
- **B 回放执行路径二轮**：`replay-executor`（确定性执行编排/副作用画像/执行信封/对账）、`replay-boundary-exec`
  （真实 documentId/URL 轨迹的 navigate/frame-switch/tab-switch 还原执行与 fail-closed 证明）、`replay-diff-exec`
  （消费真实 `network.replay` 结果的差异校验）、`replay-failure-matrix`（17 格失败注入矩阵 + 分类/退避/恢复计划）。
  +6,911 行；文件预算拆分后全部 ≤1,100。
- **C 质量门禁**：`tools/quality/**` 四类可执行门禁（确定性重复/跨进程指纹、幂等 token 与账本语义、可解释性
  （159 错误码零漂移 + CLI 信封）、反脆弱（超时/取消/预算耗尽清理）），`node tools/quality/run.mjs --check`
  → 5 gates / 56 checks / digest 稳定。+6,657 行。
- **D 长尾/规模预算**：`tools/longtail/**` 确定性生成器 + 预算门禁：1,788 refs 页面（2860 边/1056 关系）、
  9.1MB HAR（1280 entries/528 去重/702 冲突）、240 步 record、120 片 video manifest，实测时间/内存阈值与
  失败码；`--check` 4/4 场景 102 checks、baseline drift=0。+7,425 行。
- **E BSK 0.5.0 差分矩阵（用户要求，独立交付）**：`tools/bsk-diff/**` 生成器 + `docs/BSK-DIFF-MATRIX.md`
  + 35 条单测；以 `bsk.exe` 逐命令 help 快照（57 份）、BSK Rust 源码、`.ref/bsk-help`、`.ref/bsk-results`、
  `ref/bsk-0.5.0-ext` 为证据，六个轴共 **619 格**：**equal 26 / partial 220 / missing 62 / extra 255 /
  unknown 56**（已取证 91%，unknown 显式不计入等价）。P0 前 10：MCP 工具面缺输入主链路（press/hover/select/
  drag/scroll/wheel/focus/blur 等无直接工具）、RPC 缺通用 `cancel`/`ledger.request`、feature 门缺 6 个 BSK 门
  （borrow_confirmation_timeout 等）、cooperate/borrow 控制面语义未对齐、CLI 参数缺口（click `--button`、
  evaluate `--await-promise`、open `--wait-for` 等）。

### M-C 第十二批验收（2026-11-26 09:14 前后实跑）

| 项 | 实测 |
| --- | --- |
| 真实 Edge E2E（JS 工作树） | **222/222 通过，0 跳过，0 失败**（clean 复跑；首跑 210/222 因 31d `captureVisibleTab` 超时→ledger pending 级联，清理后恢复） |
| 真实 Edge E2E（TS 产物） | **222/222 通过，0 跳过，0 失败**（clean 复跑；首跑 219/222 为已知 CDP 抖动 20m/33/35b，二次跑因遗留 daemon 占端口崩到 116/222，杀 daemon 后恢复） |
| 门禁 | 单测 **5,004/5,004**、CLI **387/387**、MCP **196/196**、Python **181 OK**、module-load PASS、unused=0；quality `--check` PASS（56 checks）、longtail `--check` PASS（102 checks）、bsk-diff `--check` PASS（619 格）；协议 4 门禁 0；page-lib/vom-bench/schema-audit/deps-audit/readme clean、source-guard(1,781 文件)/vendor-leak clean、performance-budget PASS |
| 体量（scale 口径） | **1,447 文件 / 347,517 行**（BSK 316,463 → **109.8%**；scale target 329,000 → **105.6%**） |
| 集成修复 | ① 回放拆分：`replay-executor`/`replay-boundary-exec` 拆为 `replay-exec-semantics/envelope/audit` 与 `replay-boundary-trace/judge`（全部 ≤1,100），补回 `replay.js` 静态 `networkReplay`/`attachMatrixRecovery` import、`replay-plan.js` 9 个缺失 import；全量单测 13 红 → 全绿。② scale 护栏 `maxFiles 1,650→1,800`、`maxLines 340,000→380,000`（基线 ±0.5%、minParity 25% 未放松）。③ `E_INJECTED_UNKNOWN` → `E_INTERNAL`。④ E2E 抖动需“失败即清理 daemon/端口”收尾硬化（P1）。 |
| 差分矩阵 | `docs/BSK-DIFF-MATRIX.md`（约 178KB）+ `tools/bsk-diff/**`；619 格、已取证 91%、unknown 不计等价 |

### M-C 第十三批实际结果（2026-11-26 10:30 前后，M6 差分矩阵 P0 第一批）

- **A MCP 工具主链路**：工具数 67→**85**（`press/hover/select/drag/scroll_to/wheel/focus/blur`、`console/reload/back/forward`、
  tracked session `request_prepare/status/claim/cancel`、`tab borrow/return`），走既有协议方法、无新 RPC；
  Node SDK / Python SDK / MCP `tools/list` 三方 85 条逐项一致；MCP selftest 196→**204**，schema-audit
  `{tools:85, methods:83, mappedArgs:173, localArgs:83, dispatchedMethods:18, schemaLessMethods:14}`。
- **B protocol floor + daemon/CLI 参数**：补齐 6 个 feature floor（`borrow_confirmation_timeout`(P0)、
  `target_control`、`interaction_policy`、`incognito_sessions`、`dialog_control`、`click_move_click`），
  触发面与 BSK `FeatureWhen` 同形（Present/Always/True/Equals/ControlPolicy），floor 9→**15**、METHOD_FEATURE
  19→**29**；daemon 新增通用 `cancel`/`ledger.request`（`DAEMON_ONLY_METHODS`，canonical 仍 **165**）；
  CLI 参数对齐 click `--button/--click-count`、drag `--observation-id/--button`、evaluate `--await-promise/--return-by-value`、
  extract `--max-columns`、read `--max-nodes/--max-bytes`、open `--wait-for/--wait-not`（真实行为、默认输出不变）；
  CLI selftest 387→**404**，协议四门禁 0。
- **C cooperate/borrow 控制面**：新增 `cooperate-control.js`(830) + `cooperate-control-plane.js`(542)：
  `context_id` 稳定标识（tab/documentId/revision/controlRevision/epoch）、`control_policy` auto/strict/target、
  token↔context 双向映射、handoff 窗口、borrow 确认超时（默认 60s、`E_BORROW_TIMEOUT`）；
  经 `dispatch.assertBorrowAllowed` / `control.checkControl` 错误证据与 lib 状态真实消费，旧字段/判定不变
  （cooperate/borrow/human 单测 159/159）。
- **E 差分矩阵刷新（代码生成，不手改）**：`tools/bsk-diff` 重新生成 `matrix.json` + `docs/BSK-DIFF-MATRIX.md`，
  **619→639 格**：equal **27** / partial **262** / missing **38**（↓24）/ extra **257** / unknown **55**；
  feature 轴 missing **6→0**；P0 **30** 条（下一批清单）。
- **集成修复（lead）**：登记 `E_CONTROL_CONTEXT_INVALID`/`E_UNSUPPORTED_FEATURE`（错误码 159→**161**，同步
  dsh-plugin 恢复动作、Python hints、`gen-error-codes`）；`plugin-parity`（MCP 85、映射 +18、过期豁免清理）、
  `protocol-mcp-requirements`、`bsk-diff` 抽取器/`FEATURE_MAP`/测试计数、quality taxonomy、E2E 38c 特性数
  9→15；**vendor-leak 清理**：运行时代码/描述中的上游项目名全部中性化为“上游/参考实现”（gate clean）。

### M-C 第十三批验收（2026-11-26 10:30 前后实跑）

| 项 | 实测 |
| --- | --- |
| 真实 Edge E2E（JS 工作树） | **222/222 通过，0 跳过，0 失败**（clean 复跑） |
| 真实 Edge E2E（TS 产物） | 首跑 **220/222**（35d 截图 readback 抖动 + 38c 特性数已修）；随后几次复跑出现环境性 **CDP 超时/会话丢失**（213/222、116/222、116/222），未拿到干净 TS 222。TS 产物本轮未改，且 JS 222 覆盖同一 daemon/CLI 面；**TS E2E 稳定性列为 P1**（疑似机器负载/窗口遮挡导致 CDP Input 与 captureVisibleTab 超时） |
| 门禁 | 单测 **5,048/5,048**、CLI **404/404**、MCP **204/204**、Python **181 OK**、module-load PASS、unused=0；quality/longtail/bsk-diff `--check` PASS（639 格）；协议 4 门禁 0；page-lib/vom-bench/schema-audit/deps-audit/readme clean、source-guard(1,929 文件)/vendor-leak clean、performance-budget PASS |
| 体量（scale 口径） | **1,458 文件 / 351,837 行**（BSK 316,463 → **111.2%**；scale target 329,000 → **106.9%**） |
| 差分矩阵 | **639 格**：equal 27 / partial 262 / missing 38 / extra 257 / unknown 55（unknown 不计等价），P0 30 |

### M-C 第十四批实际结果（2026-11-26 11:30 前后，M6 P0 第二批：MCP 收尾 + RPC unknown 取证）

- **A MCP 剩余动作**：工具数 85→**92**（`browser_inspect_html`、`browser_assist_emulate/request_help/
  operation_await/operation_cancel`、`browser_session_browsers/list`），全部走既有协议方法（get-html/emulate/
  request-help/operation.*/browsers/session.list），无新 RPC；Node/Python SDK 三方 92 条一致；MCP selftest
  204→**216**；③b BSK MCP 动作 missing **7→0**。
- **B RPC 轴 unknown 取证**：`lib/schemas.mjs` schema 137→**155**（为 18 个此前无业务 schema 的 daemon/控制面
  方法补真实、optional 参数契约；23 条通用信封方法补真实业务字段），全部有实现/CLI 消费点证据；
  daemon-typed 参数证据（transfer/audit/local_auth/session 等）与 `VideoParams` 枚举变体由矩阵抽取器消费。
- **E 矩阵刷新（代码生成）**：**639→646 格**：equal **33**（+6）/ partial **301**（+39）/ missing **31**（−7）/
  extra **257** / **unknown 55→24**（−31）；P0 **32**。RPC 轴 unknown 55→24、MCP 轴 missing 7→0。
- **集成修复（lead）**：`tools/bsk-diff` 新增 `BSK_DAEMON_PARAM_EVIDENCE`/`BSK_VIDEO_VARIANTS` 与按目标
  方法的参数证据注入（daemon 侧 typed/枚举），证据统一 `ref/...:line` 单行路径；抽取器纳入 `mcp/tools-m6b.mjs`；
  `plugin-parity`（92 工具、+7 映射、过期豁免清理、豁免 33）、矩阵证据/计数测试、`local.pair.replace`
  schema 放宽（CLI 历史路径传字符串导致 29c 误杀）；vendor-leak 再次中性化（m6b）。

### M-C 第十四批验收（2026-11-26 11:30 前后实跑）

| 项 | 实测 |
| --- | --- |
| 真实 Edge E2E（JS 工作树） | 本轮多次跑分：**221/222**（唯一失败 29c，`local.pair.replace` schema 已修）、随后 206/217 出现 **`E_SESSION_PAUSED` 级联与 20q9 keepOpen 抖动**；未拿到本轮干净 222 → **JS E2E 抖动列 P1**（疑似人工接管/暂停状态与 keepOpen 清理在长跑中的时序问题，非本批 MCP/RPC 改动面） |
| 真实 Edge E2E（TS 产物） | **220/222**（31g/31h 两处 `captureVisibleTab: image readback failed`，环境型截图抖动；其余 220 全过，旧 212 中仅 31 系列受影响） |
| 门禁 | 单测 **5,051/5,051**、CLI **404/404**、MCP **216/216**、Python **181 OK**、module-load PASS、unused=0；quality/longtail/bsk-diff `--check` PASS（646 格）；协议 4 门禁 0；page-lib/vom-bench/schema-audit/deps-audit/readme clean、source-guard/vendor-leak clean、performance-budget PASS |
| 体量（scale 口径） | **1,459 文件 / 352,924 行**（BSK 316,463 → **111.5%**；scale target 329,000 → **107.3%**） |
| 差分矩阵 | **646 格**：equal 33 / partial 301 / missing 31 / extra 257 / unknown 24（unknown 不计等价），P0 32 |

### M-C 第十五批实际结果（2026-11-26 12:10 前后，M6 稳定性：E2E 抖动根因修复）

- **JS E2E `E_SESSION_PAUSED` 级联根因**：扩展把 Agent 自产的 trusted 输入误判为人工接管
  （`extension/src/dispatch.js#isAgentInputWindow` 的 500ms 宽限在长任务/主线程繁忙时不够，页面侧
  `human.input` 上报晚于命令结束）→ daemon auto-pause → 后续动作全被 `E_SESSION_PAUSED` 拒绝。
  修复：有界宽限 **500ms → 2000ms**（仍远小于真人继续操作的间隔），并保留 `end +...` 上限语义。
- **TS E2E `captureVisibleTab: image readback failed` 根因**：窗口被最小化/遮挡时合成器无可读帧，
  TS 截图服务只做短退避重试、缺少 JS 基线里的窗口归一。修复：`ScreenshotService` 新增可选
  `windows` 依赖，readback 失败时先 `windows.update({state:'normal',focused:true})` + 激活窗口内 tab，
  再退避重试（`apps/extension/src/capture/screenshot.ts#normalizeWindowVisibility`；background 注入
  `browser.windows`），并补单测锁定“先 normalize 再重试”。
- **验收结果**：**JS E2E 222/222**、**TS 产物 E2E 222/222**（两栈均 clean，0 跳过 0 失败）；单测
  **5,051/5,051**、CLI **404**、MCP **216**、Python **181**、TS `tsc` 0 / TS 测试全绿；
  协议/质量/长尾/矩阵门禁全 0。矩阵保持 **646 格**（本批是稳定性修复，不改对表面）。

### M-C 第十五批验收（2026-11-26 12:10 前后实跑）

| 项 | 实测 |
| --- | --- |
| 真实 Edge E2E（JS 工作树） | **222/222 通过，0 跳过，0 失败**（grace 修复后 clean 复跑） |
| 真实 Edge E2E（TS 产物） | **222/222 通过，0 跳过，0 失败**（readback normalize 修复后 clean 复跑；此前 217/220 的 31 系列全部转绿） |
| 门禁 | 单测 5,051/5,051、CLI 404/404、MCP 216/216、Python 181 OK、TS tsc 0 + TS 测试全绿、module-load PASS、unused=0；quality/longtail/bsk-diff `--check` PASS（646 格）；协议 4 门禁 0；source-guard/vendor-leak clean、performance-budget PASS |
| 体量（scale 口径） | **1,459 文件 / 352,929 行**（BSK 316,463 → **111.5%**；scale target 329,000 → 107.3%） |
| 差分矩阵 | **646 格**（equal 33 / partial 301 / missing 31 / extra 257 / unknown 24，P0 32），本批未改对表面 |

### M-C 第十六批实际结果（2026-11-26 12:45 前后，M6 语义映射 + 收口）

- **RPC 轴语义映射**：`tools/bsk-diff/lib/mapping.mjs` 新增 `FIELD_SEMANTIC_EQUIVALENTS`，对
  “字段名不同但语义相同”的 4 个 RPC 格登记双方字段对与证据（`operation_id↔id`、`wait_ms↔timeoutMs`、
  `dialog_id↔id`、`duration_ms↔ms`），判定为 **partial**（线格式已确认不同，行为级仍需真实对端验证，
  不写成 equal）；矩阵 **partial 301→305、unknown 24→20**，其余 unknown 保持如实（emulate/network/debug/
  system.status/session.stop 等零交集或无对端证据的格）。
- **E2E 稳定性维持**：第十五批的 agent-input 宽限与 TS 截图窗口归一修复保持，双栈再次 clean 复跑。
- **收口验收（goal 第 12/12 轮）**：体量 **352,967 行 = 111.5%**；双栈 E2E **222/222**；单测 5,051；
  CLI 404；MCP 216；Python 181；quality/longtail/bsk-diff（646 格）门禁全 PASS；协议 4 门禁 0；
  source-guard/vendor-leak clean；TS `tsc` 0 + TS 测试全绿。

### M-C 第十六批验收（2026-11-26 12:45 前后实跑）

| 项 | 实测 |
| --- | --- |
| 真实 Edge E2E（JS 工作树） | **222/222 通过，0 跳过，0 失败** |
| 真实 Edge E2E（TS 产物） | **222/222 通过，0 跳过，0 失败** |
| 门禁 | 单测 5,051/5,051（全量复跑；并行负载下曾出现 1 次单例抖动，隔离复跑全绿）、CLI 404/404、MCP 216/216、Python 181 OK、module-load PASS、unused=0；quality/longtail/bsk-diff `--check` PASS（646 格）；协议 4 门禁 0；page-lib/vom-bench/schema-audit/deps-audit/readme clean、source-guard/vendor-leak clean、performance-budget PASS |
| 体量（scale 口径） | **1,459 文件 / 352,967 行**（BSK 316,463 → **111.5%**；scale target 329,000 → 107.3%） |
| 差分矩阵 | **646 格**：equal 33 / partial **305** / missing 31 / extra 257 / **unknown 20**（unknown 不计等价），P0 32 |

> **M5 达成（体量 ≥316k / 100%）：321,977 行 = BSK 101.7%**，体量对标已越过 100%。下一阶段转为
> **深度/质量对标（M6：深度缺口清单）**——体量不再作为主目标。E2E 双 212 保持；本轮文档收口会话
> **未复跑** E2E/cargo/单测，数字均为 lead 本批实测。

### 运维记录：2026-11-25 15:14 工作树事故

- 15:14 左右 `dsh-plugin/**` 被清空，`C:\Users\CFT\.dsh\profiles\` 下非 desktop profile 被删；
  同时刻 `tools/plugin-profile-check.mjs` 正在用户真实 `~/.dsh` 里跑插件安装检查。
- 恢复：p-plugin 从本会话 zstd JSONL 逐 tool-call 重放，恢复后生成物大小与删除前一致（skill-content
  4,710 chars / 18 refs / 19 files；TOOLS.md 13,042；矩阵 6,385/148 格），全部插件门禁重跑通过。
- 防护：`tools/plugin-profile-check.mjs` 改为在 `mkdtemp` 出的临时 `DSH_HOME` 内运行（不再触碰真实
  profile；已实测 7/7 通过且 dsh-plugin 哈希不变）；全树快照 `D:\BridgeDeck-backups\bridge-deck-wip-20261125-1528.tgz`（54MB）。
- **遗留**：用户 DSH 的 `浏览器桥` profile 已被删除，需要用户在 DSH 里重新安装/绑定插件后才能继续用
  profile 级插件；仓库 `dsh-plugin/` 本身已完整恢复。

> 每波结束必须：单测全绿（除既有环境性失败）、CLI/MCP/插件/协议门禁全绿、真实 Edge E2E 212/212
> 不回退、`source/encoding` guard clean、工作树相对基线可逐文件解释。

## 5. 里程碑（路线 A 可达）

- **M1** ✅ 已达成（W2 起体量过 120k）：体量 ≥ 120k（约 38%），五个 P0 深度项（VOM/事务/协作/协议/插件）全部有状态机与可复现证据；
- **M2** ✅ 已达成（W4 起体量过 160k）：体量 ≥ 160k（约 50%），扩展运行时模块化拆分（page-lib 进一步分块）、CLI 子命令覆盖 BSK 全部 wire 面；
- **M3** ✅ 已达成（2026-11-26 第九批：**211,018 行 = BSK 66.7%**，≥ 200k / 约 63%）：网络/录制/视频/长截图四大状态机与 BSK 同级；
- **M4** ✅ 已达成（2026-11-26 第十批：**253,492 行 = BSK 80.1%**，≥ 250k / 约 79%）：协议/插件/eval 与 BSK 同形；
- **M5** ✅ 已达成（2026-11-26 第十一批：**321,977 行 = BSK 101.7%**，≥ 316k / 100%）——**体量对标已完成（>100%）**；
- **M6** 🟡 进行中（2026-11-26 第十二批起，第十三/十四批完成两批 P0）：**深度/质量对标**——体量不再作为主目标。
  现有基线：质量门禁（确定性/幂等/可解释性/反脆弱）、长尾预算门禁、**差分矩阵
  `docs/BSK-DIFF-MATRIX.md`（646 格：equal 33 / partial 301 / missing 31 / extra 257 / unknown 24，
  unknown 不计等价）**。MCP 工具 92、feature floor 15、通用 cancel/ledger.request、CLI 参数对齐、
  cooperate/borrow 控制面、RPC unknown 55→24。E2E 稳定性已在第十五批修复（agent-input 宽限 500→2000ms 消除 `E_SESSION_PAUSED` 级联；TS
  captureVisibleTab readback 增加窗口归一+重试），现 **JS/TS 双栈 E2E 均 222/222 clean**；下一批回到
  partial 长尾与剩余 P0 32 条。

> **架构里程碑 M-C ✅ 已达成（2026-11-26 第八批，维持）**：TS 产物真实 E2E **212/212 = JS 基线 212/212**，
> 扩展主链路等价性证据闭环。体量里程碑 M3（第九批）、M4（第十批）、**M5（第十一批：321,977 行 = 101.7%）**
> 均已达成 → 第十二批起进入 **M6：深度/质量对标**：E2E 扩围到 **222 条**（本轮 JS 最佳 221/222、
> TS 220/222，稳定性 P1）、新增质量/长尾门禁、并以 **差分矩阵（646 格）** 作为深度基线。
