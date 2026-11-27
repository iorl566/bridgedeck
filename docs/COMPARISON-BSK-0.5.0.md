# BridgeDeck 0.3.0 vs BSK 0.5.0：全面差异（2026-11-22）

对照口径：

- BridgeDeck：当前工作树 **0.3.0**（未升号、未重新打包）。行数来自
  `node tools/scale-report.mjs`。
- BSK：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0` 源码静态统计；协议方法数来自
  `crates/bsk-protocol/src/method.rs`，测试数来自源码 `#[test]` / `it/test` 调用。
- 这里只比较**外部行为、工程指标与架构取舍**，不复制参考实现。

## 1. 一句话结论

**外部自动化能力面已基本对齐，部分面更宽；内部深度与规模仍明显落后 BSK。**
BridgeDeck 用约 **27.4%** 的代码量做到相近的 Agent 浏览器操作面，
但 VOM 内部模型、动作事务/快路径、协作抑制、DSH 插件与多平台发布仍是 BSK 更深。

## 2. 量化差异

| 指标 | BSK 0.5.0 | BridgeDeck 0.3.0 | 差异 |
| --- | ---: | ---: | --- |
| 全部文件（含 docs/json） | 1,237 / 373,752 行 | 753 / 90,694 行 | 约 1/4 |
| 代码文件（rs/ts/tsx/js/mjs） | 约 329,630 行 | 90,395 行 | **约 27.4%** |
| 扩展运行时（不含测试） | 304 文件 / 90,991 行 | 222 文件 / 38,971 行 | 约 1/2.3 |
| 扩展测试 | 255 文件 / 98,049 行 | 432 文件 / 27,823 行 | BSK 测试体量大得多 |
| CLI + daemon/协议运行时 | 约 73,923 行 Rust | 约 21,144 行 JS | 约 1/3.5 |
| VOM 子系统 | 独立 `packages/vom` 11 文件 / 5,011 行 | 分散在 page-lib/observation/vom-*.js，约 1.5k 行 | BSK 模型更深 |
| DSH 插件 | 81 文件 / 25,407 行 | 8 文件 / 1,591 行 | 约 1/16 |
| eval 语料 | 59 文件 / 10,326 行 / 57 case | 127 eval case + 212 E2E | 形态不同 |
| 协议 wire 方法 | 77 | 165 canonical | BridgeDeck 更宽 |
| 协议特性位 | 9 个 feature floor | 5 个 | BSK 更严 |
| MCP 工具 | 55 个 `tool_*` schema | 67 个 MCP 工具 | BridgeDeck 更宽 |
| 协议版本 | 1.9 | 1.9 | 对齐 |
| UI 语言 | 约 10 语言 | 12 语言（含 ar/he RTL） | BridgeDeck 领先 |
| 发布形态 | Rust 多平台二进制 | Node + Windows 安装器为主 | BSK 更平台化 |

> 行数不是能力。上表解释的是“为什么 BSK 在复杂页面、极端录制、跨端发布上更稳”，
> 不是“BridgeDeck 功能缺失”。

## 3. 架构差异

### 3.1 技术栈

| 维度 | BSK | BridgeDeck |
| --- | --- | --- |
| CLI | Rust（`crates/bsk-cli`） | Node（`cli/bridge.mjs` + `cli/commands/*`） |
| daemon | Rust，UDS/IPC | Node，HTTP `/rpc` + WebSocket 扩展接入 |
| 扩展 | TypeScript/WXT/React 体系 | 原生 MV3 JS + 无构建 UI |
| 协议 | `bsk-protocol` 单一 catalog 同时生成 schema/TS codec/执行策略 | `lib/method-catalog.mjs` + 生成 `protocol.js` + schema 审计 |
| 页面内脚本 | 扩展源码模块化 | `page-lib` 单文件注入，源码 23 个 `.part` |
| 依赖 | Cargo + pnpm | pnpm；vendored mediabunny（视频）与 o200k tokenizer |

**取舍**：BridgeDeck 单栈、轻构建、易本地验证；BSK 双栈、类型化协议、原生性能和多平台发布更强。

### 3.2 协议模型

- BSK：77 个 wire 方法，**单一 `methods!` catalog** 同时约束 owner/effect/action-metadata/
  feature floor/schema/TS codec；9 个 feature floor；协议 1.9。
- BridgeDeck：165 个 canonical 方法（含本地/实例方法），5 个 feature floor；
  生成 `extension/src/generated/protocol.js`，schema 单独审计；MCP 67 工具。
- 结论：**BridgeDeck 方法面更宽，BSK 协议元数据更集中、兼容性闸门更细。**

### 3.3 状态机

- BSK 把 daemon/extension 两侧的会话、tab 所有权、input transaction、cooperation、
  capture、video 均做成显式状态机；Rust 类型系统承担大量不变量。
- BridgeDeck 用 JS 模块 + 单测 + 真实 E2E 承担不变量；关键路径已有
  transaction ledger、control generation、frameState、run log、intent ledger。
- 结论：**行为对齐，内部状态机的“可证明性”BSK 更强。**

## 4. 能力矩阵

| 能力 | BSK 0.5.0 | BridgeDeck 0.3.0 | 判断 |
| --- | --- | --- | --- |
| VOM 捕获 | 6 阶段漏斗、paint-order、affordance 类型化、layers、stable refs、token budget | AX/VOM/facts 合并、深观察 6 阶段、VOM 权重/排序、**o200k 默认计费**、语义图 v2、groups/context、ARIA snapshot | 外部接近；BSK 内部模型/affordance 更深，BridgeDeck 计费/语义图更可读 |
| Ref 身份 | backendNodeId + frameId + cdpSessionId + revision + stable refs 协商 | ref + backendNodeId + documentId + revision + cdpSessionId + stableRef | 基本对齐 |
| 动作事务 | 预写 ledger `<3ms`、restart UNKNOWN、pointer/file transaction、native input clock、3 步 fill 快路径、virtual row guard | transaction ledger、committed/unknown/cleanupState、stableRef 全动作、pointer unknown、fill matches/expected、rowAnchor、浮层 180s TTL | 行为接近；BSK 事务/快路径更深 |
| 跨帧几何 | owner-quad、target/session、soft detach | 仿射 + matrix3d + perspective、嵌套 iframe owner 链、OOPIF 投影、scale/scroll/rotate/skew 夹具 | 对齐；BSK target 生命周期更深 |
| 协作 authority | 完整 controller、4 revision/epoch、capture suppression 引用计数、passthrough token、toolbar | control/authority/revision/frameEpoch 四项计数、frameState、±1.5ms 归因、hold/handoff、借用确认 | 接近；BSK capture suppression/passthrough 更深 |
| 长截图 | 磁盘 512px 分片、3 次 stale、多段固定带、index.json | 2D CDP 分块、分数 DPR 1–3、固定顶/底栏、stale 补拍、IDB tile、`longshot.recover`、>40000px 分段、流式 read/release | 接近；BSK 极端页更深，BridgeDeck 流式/恢复更实用 |
| 视频录制 | fragmented MP4、worker 完帧重封装、恢复 | StreamTarget/OPFS 分块、manifest seal、durability 校验、崩溃恢复、sidx/faststart、mediabunny remux | 接近；BSK 原生 fsync 更强，BridgeDeck 浏览器持久化更完整 |
| 调试/网络 | journal/IndexedDB/coverage/gaps、源保留脱敏 | HAR 1.2/重放、waterfall、WebSocket 帧、trace summary/diff/view、evidence/archive | BridgeDeck 网络面更宽；BSK journal 持久化更深 |
| 会话/账本 | WAL JSONL、重启 UNKNOWN、sync reconcile、implicit scope、open/sync/close | 原子 ledger.json、`E_LEDGER_PENDING`、scope、open/sync/close、session run log → recipe draft | 对齐；BSK 性能/恢复细节更强 |
| 配对/安全 | 双向证明、pending-commit、断点恢复、rotation、revoke、trust-local | 同类实现 + 46 项配对 selftest | 对齐 |
| MCP/SDK | MCP 内建、55 tool schema | MCP 67 工具、Node/Python SDK | BridgeDeck 面更宽 |
| UI/i18n | 约 10 语言、React 组件化 | 12 语言、ar/he 全量 RTL、原生 DOM | BridgeDeck RTL/语言领先；BSK 组件化/a11y 更深 |
| 测试/CI | 1,223 Rust `#[test]` + 3,145 TS test 调用、57 eval、11 CI job | 1,014 单测 + 212 E2E（Edge/Chrome 各一遍）+ 127 eval + 159 CLI + 21 MCP + 46 配对；三平台静态矩阵 | BSK 测试金字塔更深；BridgeDeck 真实浏览器门禁更硬 |
| 发布 | Rust 多平台二进制、签名流水线 | 9 制品、签名 manifest/preflight、Windows 安装器 | BSK 平台覆盖更广；BridgeDeck 发布门禁更硬 |

## 5. BridgeDeck 已经领先/对齐的点

1. **真实浏览器回归**：212 条 E2E，Edge/Chrome 各一遍，0 skip；127 eval 全真实浏览器。
2. **门禁硬度**：source/encoding/path/schema/protocol/vendor/scale/preflight 全硬阻断。
3. **RTL/i18n**：12 语言全量 UI + 浮层（ar/he），BSK 未把 RTL 作为门禁。
4. **跨帧矩阵**：scale/scroll/rotate/skew/matrix3d/perspective 都有夹具 + E2E。
5. **可恢复 capture**：长截图 IndexedDB tiles、视频 OPFS 分片恢复都有真实 E2E。
6. **协议/MCP 宽度**：165 canonical、67 MCP 工具，超过 BSK 的 77 wire。
7. **网络/追踪**：HAR 导入/导出/重放、waterfall、WebSocket、trace，BSK 无直接对应。
8. **单栈可维护性**：Node/JS 统一，无需 Rust 工具链；本地全量门禁可重复执行。

## 6. 仍然落后的点（按优先级）

### P0 深度

1. **VOM 内部模型**：BSK 的 affordance 类型化、layers、stable refs 协商、token budget
   仍是更完整的“可决策观察”；BridgeDeck 的 o200k 计费/语义图是不同方向的加强。
2. **动作事务/快路径**：BSK 的 WAL `<3ms`、pointer/file transaction、native input clock、
   3 步 fill、virtual row guard 更细；BridgeDeck 行为对齐但内部事务层更薄。
3. **协作 capture**：BSK 的引用计数 suppression、2 rAF ack、passthrough token、
   toolbar/controller 更完整。

### P1 规模/工程

4. **DSH 插件**：BSK 81 文件 / 24k 行；BridgeDeck 8 文件 / 1.6k 行，差距约 15x。
5. **VOM 包**：BSK 独立 5k 行；BridgeDeck 分散且更小。
6. **eval 语料**：BSK 57 case + 三态 oracle/fake adapter；BridgeDeck 127 eval 但语料组织更轻。
7. **Rust 多平台发布**：BSK 原生二进制；BridgeDeck Node + Windows 安装器为主。

### P2 结构

8. **`page-lib` 单文件注入**：源码已 23 个 `.part`，运行时仍 4,158 行单文件；
   BSK 扩展源码模块化、可类型检查。
9. **协议 catalog**：BSK 单一 catalog 生成全部；BridgeDeck 方法表/映射/生成物多源，
   容易出现“方法已加、schema/映射漏改”的回归（已有审计兜底）。
10. **平台外部项**：Linux/macOS 真实启动、原生 fsync 未在本机验证。

## 7. 规模差距怎么解释

- BSK 多出来的体量主要买到了：
  - Rust 类型化状态机与协议 catalog；
  - 独立 VOM 包与更深的观察算法；
  - 1,223 个 Rust 单测 + 3,145 个 TS test 调用 + 57 eval；
  - 81 文件 DSH 插件；
  - 多平台二进制发布。
- BridgeDeck 用更少代码换到了：
  - 更宽的方法/MCP 面；
  - 更硬的真实浏览器门禁；
  - 12 语言 RTL；
  - 单栈可维护性。
- 因此 **27.4% 不是“能力 27.4%”**，而是“实现体量 27.4%”；但也不能据此说 4x 已达成。

## 8. 最终判断

| 问题 | 回答 |
| --- | --- |
| 外部常用自动化能力是否对齐？ | **基本对齐，部分更宽**（MCP、网络、RTL、流式截图） |
| 内部引擎深度是否对齐？ | **没有**：VOM、动作事务、协作抑制、DSH 插件仍落后 |
| 规模是否达到 BSK 4x？ | **没有**：约 27.4% |
| 是否可以宣称“完成对标”？ | **不可以**；只能宣称“可执行行为面基本闭环，深度/规模仍有差距” |
| 最值得补的三件事 | VOM 内部模型、动作事务快路径、DSH 插件/评测语料 |

（本文只做能力与工程对照；不包含参考实现代码，发布包仍不含参考实现标识。）
