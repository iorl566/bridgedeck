# BridgeDeck 引擎子系统总览（0.3.0，2026-11-21）

单一事实来源：本文件汇总“引擎由哪些子系统组成、各自入口与门禁”。细节见
[TEST-STATUS.md](TEST-STATUS.md)、[COMPARISON-BSK-0.5.0.md](COMPARISON-BSK-0.5.0.md)、[FLAKE-LEDGER.md](FLAKE-LEDGER.md)。

## 1. 核心引擎

| 子系统 | 主要模块 | 入口/能力 |
| --- | --- | --- |
| 页面观察 | `injected/page-lib.js`（12 parts） | observe / VOM / AX 合并 / 深观察（`--vom-deep`）/ 权重（`--vom-rank`、`--vom-weights`） |
| 动作与引用 | `src/tools/observation.js`、`src/lib/ref-details.js` | `@eN` / stableRef + `cdpSessionId`；fail-closed 动作 |
| 协作 | `content/cooperation.js`、`src/lib/cooperation-aggregate.js` | 四项 authority 计数、时间戳/坐标归因、frameGaps、frameRepairs |
| 长截图 | `src/tiled-capture.js`、`src/lib/capture-freshness.js` | 分块/DPR/固定带、stale、tile 重写、>40000px 自动分段 |
| 录制/编码 | `offscreen.js`、`src/tracing.js`、`video-worker.js` | tabCapture/screencast 逐帧编码、StreamTarget→OPFS、faststart/sidx |
| 媒体编辑 | `cli/lib/video-edit.mjs`、`video-segments.mjs` | `video trim/info/split` |
| 性能追踪 | `src/tracing.js`、`lib/trace-summary.mjs` | trace start/stop、summary、diff、HTML view、MCP |
| 调试证据 | `src/debug.js`、`src/network.js`、`lib/har.mjs` | journal/merged、归档预算、HAR 1.2、WebSocket 帧 |
| 协议/CLI | `cli/bridge.mjs`、`cli/commands/*`、`lib/schemas.mjs` | 165 canonical 方法、schema 审计、MCP 54 工具 |

## 2. 门禁（CI / 本地）

- 单测 `node --test tests/unit/*.test.mjs`
- CLI / 配对 selftest
- 真实 E2E：Edge + Chrome（各自 seed 矩阵）
- eval：Edge 127 case；Chrome 同套（`--browser chrome`）
- source / focus / encoding guard
- page-lib parts 同步、协议 docs、schema、依赖/许可证、VOM 权重基准
- vendor leak + release preflight

## 3. 依赖与被允许的第三方

- `mediabunny`（Apache-2.0）：CLI 与扩展 worker 共用，vendored 副本哈希审计。
- `@remixicon/react`（Remix Icon License）、React（MIT）、Vitest（MIT，dev）。
- 依赖许可证白名单由 `lib/deps-audit.mjs` 维护。

## 4. 与 BSK 的定位

- 外部自动化能力：同面（观察/动作/协作/长截图/录制/调试/追踪/eval）。
- 内部规模：**760 文件 / 91,016 行**，约为 BSK 的 1/4；走“轻量 + 硬门禁”路线。
- 仍是 BSK 更深的部分：默认 VOM 过滤权重、File System Access 级 fsync、Rust/TS 双栈规模、CI lane 数量。

## 5. 维护约定

1. 版本保持 0.3.0；未经用户明确要求不重新打包/发布。
2. 任何新协议方法：schema + generated protocol + PROTOCOL-METHODS + eval/E2E。
3. 任何 flake 修复：先改测试隔离/前置状态，再考虑重试。
