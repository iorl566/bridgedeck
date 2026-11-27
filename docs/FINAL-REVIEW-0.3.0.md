# BridgeDeck 0.3.0 深度推进复盘（长线 48 轮，2026-11-21）

本文件是长线 48 轮“规模/深度对齐 BSK 0.5.0”的收口证据与诚实差距清单。版本仍为 **0.3.0**，
未重新打包/发布；`dist` 保持已签名 v0.3.0 资产。

## 1. 本轮周期新增的引擎子系统

| 子系统 | 交付 | 验证 |
| --- | --- | --- |
| 编码落盘 | StreamTarget → **OPFS** 分块写入，停录按 position 组装，IDB 兜底 | E2E 20c/20c2/35 |
| 录制编码 | tabCapture（TrackProcessor）+ screencast 默认逐帧编码；MediaRecorder 回退 | E2E 20c/20c2/35 |
| 媒体编辑 | `video trim / info / split`（GOP 对齐） | E2E 35 + 单测 4 |
| 性能追踪 | `trace.start/stop/status`、Trace JSON、`trace summary/diff/view` | E2E 20u2 |
| 调试证据 | HAR 1.2、WebSocket 帧、network headers 修复、归档预算/journal/merged | E2E 20b |
| VOM 深度 | 默认深观察绘制序/去重 + tree 字段回填；`--vom-deep`；权重打分/排序/可配置 | E2E 5b/5b2/35c |
| 协议/CI | trace 方法、schema/文档/生成协议、双浏览器 eval、双 seed 矩阵、依赖/许可证/协议文档/schema/VOM 基准审计 | CI + 本地门禁 |
| 文档 | ENGINE-SUMMARY、FLAKE-LEDGER、全量计数同步 | 本文件 |

## 2. 最终量化

| 指标 | 数值 |
| --- | --- |
| 源码 | **760 文件 / 91,016 行**（BSK 1,000 / 335,820） |
| 扩展运行时 | 195 文件 / 35,159 行 |
| canonical 方法 | 165（BSK 77 wire） |
| MCP 工具 | 67 |
| 单测 | 1025 |
| 真实 E2E | 210，Edge/Chrome 各一遍 |
| eval | 127 case，**Edge 127/127、Chrome 127/127** |
| 依赖审计 | PASS（vendored mediabunny 哈希一致） |
| 冷启动 | ~100ms（历史基线） |

## 3. 与 BSK 的定位

- **外部自动化能力**：同面。观察/动作/协作/长截图/录制/调试/追踪/eval/CI 都有对应实现。
- **内部深度**：VOM 权重、录制编码、追踪分析已从“缺失”变为“可比”；但 BSK 的默认 VOM
  过滤权重、File System Access 级 fsync、Rust/TS 双栈规模仍更深。
- **规模**：代码量约为 BSK 的 1/4；BridgeDeck 选择“轻量 + 硬门禁”，不是逐行对标。

## 4. 仍存在的差距（不伪装）

1. **规模**：86.7k 行 vs 335k 行；BSK 的 Rust/TS 双实现与 1,000 文件规模仍显著更大。
2. **默认 VOM 算法**：我们有可量化六阶段/权重/深观察，但 BSK 的过滤权重与 token 计费策略更细。
3. **录制 fsync**：已有 OPFS/IDB 恢复、durability 读回校验与 storage 探测；仍没有 BSK 的文件句柄 fsync。
4. **CI 规模**：双浏览器 + 双 seed + 三平台静态矩阵 + 每日全量 + 多类审计，但 BSK 的 10 CI job/分 lane 更多。
5. **Linux/macOS 实跑**：三平台静态矩阵已接入 CI，但本机无 WSL/Docker，未做真实 E2E。
6. **依赖**：vendored mediabunny 723KB；不是零依赖。

## 5. 50 轮节点结论

- 本机可执行证据全部通过：887 单测、Edge/Chrome 各 212 E2E、127 eval、静态/审计/preflight。
- 外部能力面已基本同面，VOM/录制/长截图/协作/追踪/网络分析都有可回归实现。
- **但目标未完全达成**：整体规模约 BSK 的 1/4；默认 VOM 计费、原生 fsync、Linux/macOS 实跑仍未对齐。
- 因此不把目标标记为完成；后续若继续，优先级为：Linux/macOS 实跑 → VOM 默认计费 → fsync 边界 → 规模。

## 6. 最终门禁证据

- `node --test "tests/unit/*.test.mjs"` → 887/887
- CLI 159/159；配对 46/46
- `node tools/e2e.mjs` → Edge 210/210
- `node tools/e2e.mjs --browser chrome` → Chrome 210/210
- `node tools/eval-from-e2e.mjs` → Edge 127/127 attempts=1
- `node tools/eval-from-e2e.mjs --browser chrome` → Chrome 127/127 attempts=1
- source(201)/encoding(998)/schema/deps/protocol-sections/VOM bench/path portability/vendor leak/preflight 全 PASS
- 版本 0.3.0；`dist` 未改动
