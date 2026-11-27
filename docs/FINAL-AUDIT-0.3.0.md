# BridgeDeck 0.3.0 最终审计（Round 256 / 2026-11-22）

> 目的：在外部环境（Linux/macOS/原生 fsync）不可用的前提下，判断“可本地验证的
> 可执行差距”是否清零，并明确剩余项属于外部环境还是结构性投入。

## 1. 审计结论

| 问题 | 结论 |
| --- | --- |
| 可执行行为是否还有未闭环项？ | **本地清单内没有**；Edge/Chrome 212、eval 127、单测 1023 全绿 |
| 4x 规模是否达成？ | **没有**：760 文件 / 91,016 行，约 BSK 的 **27.5%** |
| 是否可以宣称“完成对标”？ | **不可以**：仍有非外部的深度/规模差距 |
| 版本/发布状态 | **0.3.0**，未升号、未重新打包、`dist` 未动 |
| 外部环境项 | Linux/macOS 真实启动、原生 fsync、跨平台安装/签名 |

## 2. 最新门禁证据（Round 255）

| 门禁 | 结果 |
| --- | --- |
| 单测 | **1025/1025** |
| CLI / MCP selftest | 159/159 / **21/21** |
| 配对 selftest | **46/46** |
| Edge eval | **127/127，attempts=1** |
| Edge E2E | **212/212** |
| Chrome E2E | **212/212** |
| source / encoding / schema / 协议 / deps / VOM / path / page-lib / scale | 全部 PASS |
| release preflight | PASS |
| 规模 | **760 文件 / 91,016 行** |

## 3. 已闭环的可执行行为（按域）

| 域 | 证据 |
| --- | --- |
| VOM/观察 | o200k 默认计费、深观察六阶段、权重/排序、语义图 v2、groups/context、ARIA snapshot、layers/field/options/rowAnchor |
| 动作事务 | committed/unknown、pointer unknown、fill matches/expected、虚行防护、浮层 180s TTL |
| 录制/恢复 | 分片/OPFS、manifest seal、durability readback、stop 重试、恢复幂等、sidx/faststart |
| 长截图 | 分数 DPR、固定顶/底栏、stale 补拍、IDB tile、recover、>40000px 分段、流式 read/release |
| 协作 | 共享 tab、控制权/租约/handoff、hold、frameState、归因时钟、借用确认 |
| 协议/MCP | 165 canonical、67 MCP 工具、schema/协议/docs 一致性门禁 |
| DSH 插件 | 37 工具；plan/ledger/recipe/act 契约测试 |
| 发布/CI | 9 制品、签名 manifest、preflight、三平台静态矩阵、Edge/Chrome 双浏览器 lane |

## 4. 非外部剩余差距

### 4.1 规模（主差距）

- 当前约 **27.5%**（产品口径约 27.4%）；
- 见 [COMPARISON-BSK-0.5.0.md](COMPARISON-BSK-0.5.0.md) 与 [SCALE-REPORT.txt](SCALE-REPORT.txt)；
- 差的不是“有无功能”，而是：
  - VOM 内部模型/affordance 类型化；
  - 动作事务快路径/WAL；
  - 协作 capture suppression/passthrough；
  - DSH 插件体量（约 1/16）；
  - Rust 多平台发布。

### 4.2 `page-lib` 单文件注入

- 源码已拆为 23 个 `.part`，运行时仍是 4,158 行单文件；
- 受 MV3 注入/CSP/跨帧投影约束，未拆成多文件；
- 这是结构性限制，不是行为缺口。

### 4.3 协议 catalog 多源

- BSK 用单一 `methods!` catalog 生成 schema/TS codec/策略；
- BridgeDeck 有方法表/生成物/映射表多源，靠 schema/协议审计兜底；
- 不是行为缺口，但长期回归面更大。

## 5. 外部环境项

| 项 | 状态 |
| --- | --- |
| Linux/macOS 真实浏览器启动 | 未在本机执行 |
| 原生 fsync | 浏览器录制只有 readback，`fsync_supported:false` |
| 跨平台安装/签名 | Windows 0.3.0 已验证；不重新打包 |

## 6. 决策建议

1. **若目标是“Agent 可用的外部能力”**：当前可以冻结 0.3.0，不再加功能；
2. **若目标是“达到 BSK 级深度/4x 规模”**：需要架构性投入（VOM 内部模型、
   动作事务快路径、DSH 插件、Rust/多平台），不是继续拆小文件能解决；
3. 在外部环境可用前，不要声称“原生 fsync/Linux/macOS 已验证”。

## 7. 证据入口

- [TEST-STATUS.md](TEST-STATUS.md)
- [COMPARISON-BSK-0.5.0.md](COMPARISON-BSK-0.5.0.md)
- [BSK-0.5.0-GAPS.md](BSK-0.5.0-GAPS.md)
- [SCALE-REPORT.txt](SCALE-REPORT.txt)
- [HANDOFF-NEXT-SESSION.md](HANDOFF-NEXT-SESSION.md)
