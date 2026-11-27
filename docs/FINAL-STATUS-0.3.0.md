# BridgeDeck 0.3.0 最终状态（2026-11-22）

> 版本保持 0.3.0；未重新打包/发布；`dist` 未改。

## 1. 门禁（最近一次全量）

| 门禁 | 结果 |
| --- | --- |
| 单测 | 1025/1025 |
| CLI selftest | 159/159 |
| MCP selftest | 21/21 |
| Edge eval | 127/127，attempts=1 |
| Edge E2E | 212/212 |
| Chrome E2E | 212/212 |
| source guard | clean（212 files） |
| encoding guard | clean（1023 files） |
| page-lib check | 通过（4,168 行） |
| path / schema / 协议 / VOM / deps | 通过 |
| release preflight | PASS |
| 规模 | 760 文件 / 91,016 行 |
| 协议 / MCP | 165 方法 / 67 工具 |

备份：`D:\BridgeDeck-backups\BridgeDeck-src-20261122-021310.zip`。

## 2. 本轮完成

### VOM / 计费
- weights/profiles/compact/section/groups/semantic/funnel/payload 模块化；
- **真实 o200k**：vendor 词表 3.6MB + 纯 JS BPE；
- **默认 billing model = o200k**，保留 cjk/chars-per-4；
- 已知计数测试（hello world=2、提交=1、😀=1）。

### 动作事务
- `transaction-ledger` 统一 committed/unknown；
- pointer/fill/file 全接入；
- fill matches/expected、upload/download effectState 保持。

### 模块化
- interaction 700+ 行 → ~30 行编排层；
- 拆出 pointer-actions/pointer-primitives/fill-actions/fill-verify/keyboard/visual-drag/action-common；
- CLI 拆出 files/ui-settings/misc，bridge 3,199 → 1,946。

### 稳定性
- 20g 先等录制落库再 prune；
- 35 视频 stop 重发/回读兜底（前序轮）。

## 3. 未清零

1. **4x 规模**：约 1/4，模块化开始但未完成；需继续拆 CLI 剩余命令、offscreen/video、page-lib 构建约束。
2. **VOM 语义图**：轻量组节点+member 边，不是 BSK 的完整 AX/DOMSnapshot 语义合并。
3. **动作细节**：overlay TTL、download 归因仍比 BSK 粗。
4. **外部环境**：Linux/macOS 真机 E2E、原生 fsync、多平台发布形态。

## 4. 判定

- 本地行为面已收口（212/212、eval attempts=1、unit 1025）；
- o200k 从“接口”变成“默认真实计费”；
- **不能声称“完全对标”**：上述 1–4 是实质差距；
- 下一阶段应按 [architecture.md](architecture.md) 的路线继续重写，而不是继续加小特性。
