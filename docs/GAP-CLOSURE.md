# 本地差距清零清单（2026-11-22）

目标：把“外部环境不可用”与“本地仍可执行”分开，避免把前者当成已完成，也避免把
VOM/规模这类内部差距藏起来。

## 1. 本地已完成（可回归）

| 项 | 证据 |
| --- | --- |
| VOM 权重/预算/档位/漏斗/explain/基线 | 941 单测、5b、vom-bench |
| VOM section/row/form/groups/semantic + billing | 新模块，5b |
| **真实 o200k tokenizer（vendor 词表 + 纯 JS BPE）** | 单测含已知计数；默认 billing |
| 录制恢复：OPFS/IDB、durability、seal、幂等、stop 重发/回读 | 35/35r、unit |
| 长截图：默认 512px、tile 256–8192、stale、恢复、分段 | 31 全家 14/14 |
| 协作 FrameState：结构/选区/媒体/字段/事件 completeness | 23h2、unit |
| 动作事务：committed/unknown、fill matches/expected、upload/download | 20z/5i/23g/16/5f |
| 协议/MCP：165 方法、67 工具 | schema/协议文档、selftest 21 |
| 网络：HAR 导出/导入/重放、waterfall、WS 帧 | 20b、20j |
| CI：三平台 static matrix 含 MCP selftest、双浏览器 E2E | quality.yml / real-browser-e2e.yml |
| 模块化：interaction 编排层 + pointer/fill/keyboard/visual-drag 等 | 全量 212 |
| CLI 拆分：files / ui-settings | bridge 3,044 |

## 2. 本地仍可做（尚未清零）

1. **VOM 完整语义图**：已有轻量 semantic graph（组节点+member 边），
   但不是 BSK 的 AX/DOMSnapshot 语义合并；o200k 计费已对齐。
2. **动作事务细节**：overlay TTL、download 归因仍比 BSK 粗；
   已补 unknown/不重放、fill 读回、文件事务。
3. **4x 规模**：已拆多个巨石，但总规模仍约 BSK 1/4（660 / 88,575 对约 953 / 329,630）。
4. **page-lib**：4,168 行单文件注入受 MV3 限制，尚未模块化。

## 3. 外部环境项（本机不可执行）

1. Linux / macOS 真实浏览器 E2E；
2. 原生 fsync / 文件句柄语义；
3. 多平台原生发布形态。

## 4. 判定

- **o200k 已从“接口”变成“默认真实计费”**；
- 本地行为面已收口（212/212、eval attempts=1、unit 1025）；
- 仍不能标记“完全对标”：semantic graph 等价性、4x 规模、外部平台是实质差距；
- 每次收口以 Edge/Chrome **212/212** + eval attempts=1 + unit **1025/1025** 为准。
