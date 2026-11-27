# 架构路线（B 线）：TS/React/WXT 扩展 + Rust CLI/daemon

> 2026-11-25 用户明确指令：**解除冻结，上架构路线**（全面对标 BSK 0.5.0 的深度与体量）。
> 本文件定义架构路线的目标形态、环境工具链、迁移策略与验收口径。0.3.0 的 JS 工作树
> 继续作为**行为参考与回归基线**，直到 TS 栈逐项达到同等能力；`dist/` 与发布物在
> 架构栈达到 M-C 之前不动。

## 1. 为什么必须走架构路线

BSK 的体量由两部分撑起：`apps/extension` 188,481 行（TS/React/WXT 组件化）与
`crates/bsk-cli` 86,902 行 Rust（类型化状态机 + 协议 catalog）。单栈 JS 深度路线在
扩展侧每轮约 +12k 行，达到 316k 体量需要 18–20 轮；架构路线才是"体量全面对标"的正解。

## 2. 环境工具链（本机现状与补齐）

| 工具 | 现状 | 动作 |
| --- | --- | --- |
| Node | 无（仅 Electron-as-node v24.21） | 下载官方 `node-v24.22.3-win-x64` 便携包到 `D:\tools\node`，PATH 只在本会话内注入 |
| npm | 无 | 随 Node 便携包提供 |
| TypeScript / WXT / Vite / React 类型 | 无 | `apps/extension` 内本地 `npm install`（网络已验证可达 npm registry） |
| Rust / Cargo | 无 | `rustup-init`（网络可达 static.rust-lang.org），minimal profile，M-D 阶段再启 |
| Edge/Chrome | 有（E2E 实跑） | 沿用 `tools/e2e.mjs` 的浏览器发现逻辑 |

> 注意：本机此前所有门禁都靠 Electron-as-node 跑（`ELECTRON_RUN_AS_NODE=1`）。补齐 Node 便携包后，
> 命令统一用 `D:\tools\node\node.exe`，Electron 方式保留为兜底。

## 3. 目标仓库结构（与 BSK 的对应）

```
apps/extension/            # TS + React + WXT，对应 BSK apps/extension（188k 行目标）
  entrypoints/             # background / content / popup / options / debug 页面
  components/              # React 组件（浮层、设置、调试面板）
  src/                     # 业务层（观察、动作、协作、截图、录制、网络…）
packages/protocol/         # 对应 crates/bsk-protocol：方法单源、feature floor、schema、状态机表
packages/vom/              # 对应 packages/vom：六阶段漏斗、affordance、layers、stable refs、budget、relations
packages/shared/           # 错误码、limits、脱敏、类型
crates/                    # 对应 crates/bsk-cli：Rust CLI + daemon（M-D 阶段启动）
```

构建：WXT（vite）产出 MV3 到 `apps/extension/.output/chrome-mv3`；发布物仍由既有
`tools/release*.mjs` 在通过全部门禁后决定是否合并，不在本阶段改 `dist/`。

> 已加 `tools/e2e.mjs --ext-dir <dir>`：同一套 212 条验收可以直接指向 TS 产物目录，
> M-C 迁移时无需复制测试脚本（默认仍是 repo 根 `extension/`）。

## 4. 迁移策略（共存，不搞大爆炸）

1. **行为基线**：0.3.0 JS 树 = 212 条真实 E2E 的参照实现；TS 栈每实现一块，就用同一批
   E2E 用例对 TS 产物跑（E2E 支持 `--extension-dir` 或等价开关，由 lead 在集成时加）。
2. **先包后应用**：先 `packages/protocol` + `packages/vom`（纯逻辑、可单测、无浏览器依赖），
   再 `apps/extension` 的 background，最后 React UI。
3. **能力切换**：同一能力在 TS 栈通过 E2E 前，JS 栈保持主力；通过后 TS 栈接管，JS 栈进入维护。
4. **禁止双写**：同一逻辑不得在 JS 与 TS 各写一份长期并存；每块迁移完成后 JS 侧标 `LEGACY:`，
   并在 `docs/ARCH-TRACK.md` 登记。

## 5. 里程碑与验收

| 里程碑 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| **M-A** 骨架 | 便携 Node + WXT + TS + React 工程可 `build`；产物 manifest 合法；React 入口能渲染 | `wxt build` exit 0；产物含 `manifest.json`、background SW、popup HTML；本地静态托管 popup 渲染出根节点 | ✅ 2026-11-25 |
| **M-B** 核心包 | `packages/protocol`（165 方法/9 floors/五维状态）与 `packages/vom`（affordance/layers/rows）移植 | 两包 `tsc --noEmit` 0 错；与 JS 版差分测试 50/50 | ✅ 2026-11-25 |
| **M-C** 扩展主链路（第一~八批） | background/content 迁移到 TS：动作面/截图/网络只读/observe/frames/dialog/debug 只读 + 长截图分段 + UI 子页面 + VOM 统一 + CDP 通道/OOPIF 投影 + VOM 深水区 + CDP 域 + 动作/引用层 + observe/VOM 权重 + 人工协作/annotate + record/video 服务 + replay/takeover | TS 产物 E2E **212/212 通过，0 跳过，0 失败**（比第七批 193 **+19**、0 回退）；**= JS 基线 212/212**；manifest 版本仍 0.3.0、`dist/` 未动 | ✅ **已达成**（2026-11-26 01:57） |
| **M-D** Rust 侧（第一~四批） | `crates/bridge-cli`：协议编解码 + 会话状态机 + daemon 发现/HTTP/WS + TLS 策略 + `session start/stop/list` + `observe` | `cargo test` **260**（254 单测 + 6 集成）、`cargo check --all-targets` 0、生成物漂移 0、真实 daemon 冒烟；口径：gnu target + rust-lld | ✅ **第四批已落地**（2026-11-25） |
| **M-E** 合流 | TS 扩展 + Rust CLI 达到 BSK 同形态；体量与能力双重对标 | 全量 E2E 迁移 + 发布门禁 | 待开始 |

> 体量里程碑（见 `docs/BSK-PARITY-PROGRAM.md` §5）：**M3 ✅**（第九批：211,018 行 = 66.7%）、
> **M4 ✅**（第十批：253,492 行 = 80.1%）、**M5 ✅ 已达成**（第十一批：**321,977 行 = BSK 101.7%**，
> ≥316k / 100%，**体量对标已越过 100%**）；下一阶段 **M6：深度/质量对标**（深度缺口清单，体量不再
> 作为主目标）。

## 6. 当前进度

- 2026-11-25：用户解除冻结；本文件建立；Node 便携包 **v24.22.3 + npm 11.19.1** 已装到
  `D:\tools\node`（本机此前只有 Electron-as-node）；Rust 工具链 rustup 安装中。
- **M-A 已达成**：`apps/extension`（WXT 0.21.5 + Vite 8 + React 19 + TS 5.9）可构建：
  - `wxt build` → `.output/chrome-mv3`（manifest / background SW / content script / React popup）；
  - `tsc --noEmit` 严格模式 exit 0；
  - 4 条 TS 单测通过（消息路由契约、状态构造、设置归一、与 JS 扩展的 manifest 关键字段 parity）。
  - 构建产物与 0.3.0 `extension/manifest.json` 的 permissions/icons/版本/内容脚本入口一致。
- 6 个 JS 深度工作流（VOM/事务/协作/协议/插件/eval）已完成，作为 M-B 的移植源与回归基线；
  本轮合计把工作树从 96.3k 推到约 119.0k 行（36.2%）。
- **Rust 骨架已可编译/可测试（M-D 第一步）**：`crates/bridge-cli` 8 项单测通过，二进制可运行
  （version/protocol/status 退出码 0/0/3）。本机无 MSVC 链接器与 MinGW，采用 Rust 自带 `rust-lld`
  链接 GNU 目标（`RUSTC_BOOTSTRAP=1` + `-Z unstable-options -C linker-flavor=gnu-lld`，见
  `crates/bridge-cli/README.md`）；正式发布前必须换成 MSVC Build Tools 或 MinGW。
- **M-D Rust 第二批已落地（2026-11-25）**：`crates/bridge-cli` 6,257 行 Rust（std-only）：JSON 编解码、
  `/rpc`+WS 帧信封、154 错误码/165 方法/9 floor 由 JS 单源生成（生成器 `--check` 漂移门禁）、
  8 状态会话状态机、hello/hello-ack 版本协商（1.8/1.9/2.0），`cargo test` **108/108**。**未接**：真实
  socket/HTTP 客户端、daemon 发现、`status` 真实数据（仍 exit 3）、WS 连接层。
- **M-D 第三批已落地（2026-11-25）**：daemon 发现（`daemon.json`）、std-only HTTP/1.1 客户端（`/health`、
  `/rpc`，chunked 明确拒绝）、手写 WebSocket（Accept 校验/掩码/分片/ping-pong/close）、真实
  `status`/`health`/`ws-hello`（真机 daemon 验证，hello-ack instanceId/capabilities 齐全）；
  Rust 11,096 行，`cargo test` 198（195 单测 + 3 进程级冒烟）。未做：TLS/wss、更多方法（session 等）。
- **M-C 第四批已落地（2026-11-25）**：observe VOM/AX/facts、frames 列表、dialog、upload/download、
  debug 只读域（console/请求/operations/DNR 规则）、manual/segmented 截图；TS 23,715 行、251 测试；
  TS 产物 E2E **76 → 135/212，0 回退**。
- **M-C 第三批已落地（2026-11-25）**：TS 截图（可见/整页/元素/区域/差分/流式，无 debugger）、
  network 只读、get-html、tab 策略/别名，evaluate 改 `chrome.scripting` 绕开 MV3 CSP；TS 单测 239 条；
  TS 产物真实 E2E **76/212**（136 项按未迁移能力分类：E_UNKNOWN_METHOD 70、E_NOT_IMPLEMENTED 28、
  断言/能力缺口 28 等）。
- **M-C 第二批已落地（2026-11-25）**：TS 动作面（observe/click/fill/read/select/get-html/evaluate +
  参数校验/feature gate/错误映射）、ref 生命周期（与 JS 逐字段差分）、内容脚本最小桥（不用
  `chrome.debugger`）、多端口发现、runtime 命令。`apps/extension` 142 条 TS 测试、`tsc` 0 错、
  `wxt build` exit 0；TS 产物跑真实 E2E **29/212 通过**（session start/navigate/observe/fill/
  get-html/stop/status 已通；183 项按未迁移能力分类：E_UNKNOWN_METHOD 63、E_NOT_IMPLEMENTED 14、
  E_EVAL_FAILED 9、链式 E_NO_SESSION 78、断言 19）。
- **M-C 第一批已落地（2026-11-25）**：`apps/extension/src/daemon/`（HTTP `/rpc` + `/health` 客户端、
  WebSocket 接入：hello/重连退避/心跳/事件/cmd/call）、`src/rpc/registry.ts`（方法注册 + feature gate +
  只读白名单 + 事件分发）、background `bb.rpc` 接线；`apps/extension` 66 条 TS 测试 + `tsc` 0 错 +
  `wxt build` exit 0。**未接**：动作面（cmd 统一 `E_NOT_IMPLEMENTED`）、多端口发现、配对 HMAC、
  React UI 订阅事件；这些是后续 M-C 批次。
- **M-B 已达成（2026-11-25）**：`packages/protocol` 从 JS 单源生成 165 方法/9 floor/五维状态表
  （`gen.mjs --check` 硬校验 + 生成物签名），`packages/vom` 移植 affordance/layers/rows 纯函数；
  两包 `tsc --noEmit` 0 错，差分测试 50/50（同一输入 JS 与 TS 输出逐字段相等）。
  ≥ 消费点：本切片由测试/生成漂移门禁消费，运行时接入在 M-C。
- **工作树事故与防护**：2026-11-25 15:14 `dsh-plugin/**` 被清空、真实 DSH profile 被删；已用会话
  日志精确恢复，并把 `tools/plugin-profile-check.mjs` 改为隔离临时 `DSH_HOME`。全树快照：
  `D:\BridgeDeck-backups\bridge-deck-wip-20261125-1528.tgz`。
- **W7-C 已落地（2026-11-25）**：MCP `resources/subscribe` 推送（notifications/resources/updated）、
  快照并发保护、Node SDK 进度/取消入口；`tests/mcp/selftest.mjs` **128/128**（W5 的 `subscribe=false`
  口径自此升级为 `subscribe=true`）。
- **W7-D 已落地（2026-11-25）**：`video/longshot/record/debug/trace` 严格 specs（单一 spec 源 →
  校验 → risk 预检 → JSON 信封）与 `--dry-run` 共用同一份 plan；CLI selftest **309/309**、
  `readme-commands --check` clean（15 命令）。
- **W7-E 已落地（2026-11-25）**：`apps/extension` content 侧 VOM 统一消费 `packages/vom`
  （vom-facts/vom-summary）+ 与 JS 侧逐字段差分（**9/9**）；`jsLibsPromise` 断言改 4 元组
  （`tests/vom-diff.test.ts` 382→387 行），`tsc --noEmit` **0 错**、TS 测试 **306/306**。
- **M-C 第六批 task-6（CDP 通道 + OOPIF，2026-11-25 夜）**：`src/cdp/**` 10 文件 3,654 行：
  attach 去重/超时/子 session/teardown、frame-owner 投影、frames 接入；翻转 23p3/7/8/9 + 链式
  23q/r/s/u/v/w/x2/x4 等。
- **M-C 第六批 task-7（VOM 深水区，2026-11-25 夜）**：`packages/vom` graph/frame-vom/color +
  `src/content/vom-{deep,layers,visual,page-graph,frames}.ts` + `rich.ts` 装配（14 文件 / 5,242 行）；
  翻转 35c/35f/35g/35h/15d/15e。
- **M-C 第六批 task-8（缺陷/UI，2026-11-25 夜）**：35d fail-closed、35e follow/rebind、
  23j4 `E_TARGET_DETACHED`、29 popup 别名页 + BOM 根因修复、29d RTL；翻转 29/29d/30/35e/23j4。
- **M-C 第六批 task-10（35d 异步替换窗口，2026-11-25 夜）**：合成 focus + ≤20ms 有界复核、
  content bridge 异步回包 → 35d 稳定通过。
- **M-C 第六批 task-9（CDP 域，2026-11-25 夜）**：Fetch/规则、PDF、emulate、trace、可信输入、
  closed-shadow pierce、debug CDP 采集（9 新模块 + debug/service/recorder/rules/network/screenshot
  改造）；翻转 20b/20f/20u/20u2/20v2/20w/20x/20y/21 等。
- **M-C 第六批 task-12（回归收口，2026-11-25 夜）**：20b3/31g 两回归修复（debug 停止后只读面返回
  最近快照；emulate reset 只 clear + **仅视口**截图 ≤8px 对齐裁剪，整页/区域/元素仍严格）；
  最终 **179/212，0 回退**（对 135 基线新通过 44）。剩余 33 项按录制/视频、closed-shadow/trusted/refs、
  人工协作/UIA、annotate 四类移交下一轮。
- **M-C 第七批 R2a（动作/引用层，2026-11-26 00:20）**：`actions/backend-locator.ts` 574 行、
  `trusted-input.ts` 575、`file-input.ts` 314；`registry.ts` 893→**1,153**、`extended.ts`
  1,326→**1,476**、`params.ts` 417→**468**、`observation.ts` 173→**185**；测试 **1,274 行 / 34 例**。
  本轮翻转项中按交付面归属本路的是 18e / 7 / 7b / 20v / 20z（完整 14 项清单见
  `docs/BSK-PARITY-PROGRAM.md` 第七批）。
- **M-C 第七批 R2b（observe/VOM，2026-11-26 00:20）**：`content/vom-weights.ts` 733（新）、
  `rich.ts` 1,296、`session.ts` 1,032、`protocol.ts` 622、`refs/registry.ts` 585；测试
  **527 行 / 23 例**；按交付面归属本路的翻转是 5b / 5f / 35b（5b：`observe --vom` 结构化节点 /
  `refs.negotiate`；5f：`--ax` 未映射可交互元素；35b：refDetails `cdpSessionId` + hitTest）。
- **M-C 第七批 R3（人工协作/annotate，2026-11-26 00:20）**：`content/cooperation.ts` 663（新）、
  `runtime/cooperation.ts` 748（新）、`runtime/index.ts` 导出、`capture/screenshot.ts` annotate 修复
  （`capture_id` 与 `captureId` 分离）；测试 **35 例**；按交付面归属本路的翻转是 23q（annotate 坐标
  capture 与流式 id 分离）、23u（human-watch 检测人工操作）、23w（strict context 会话级固定）、
  23x（handback 后立刻 ready）、24b / 24b2（request-help 浮层 + 条件自动交还）。
- **M-C 第七批 lead 集成（2026-11-26 00:20）**：`background.ts`（共享 input/pierce/backend/fileInputs
  注入 actions/extended；observe 的 closed-shadow 枚举 + `DOM.getBoxModel`；`refs.negotiate` 注册；
  `CooperationRuntime` + `createCooperationCommands`；`bb.human.*` / `bb.help.resolved` 消息；
  click-backend/shadow.click 的 `markAgentInput`；`UploadService` 大文件 CDP 兜底）、
  `entrypoints/content.ts`（`installHumanWatch`）。最终 **193/212，0 回退**（+14）。剩余 **19 项**
  全部为 record/video 录制与页面，移交下一轮（计划拆「record 核心」+「video 核心/页面」两路）。
- **M-C 第八批 A（record 服务，2026-11-26 01:57）**：`src/record/**`（types/steps/sources/store/
  trace/service/capture/messages/chrome-deps/ops-selftest，约 3,100 行）+ `src/content/record-overlay.ts`
  + 重写 `src/ui/pages/ops.ts`；E2E 20d/20d2…20d10、24c、32 全通。
- **M-C 第八批 B（video 服务，2026-11-26 01:57）**：`src/video/**` 12 模块（service/offscreen/mp4/
  store/runtime/verify/selftest/state/manifest/hash/protocol/types，约 3,350 行）+ 重写
  `src/ui/pages/record.ts` + `entrypoints/offscreen.html`；20c/20c2/20g/35/35r 全通；headless 证据：
  tabCapture 被拒 → CDP screencast → 离屏编码器，`ftyp` / `faststart=true` / 分片 sha256 真实。
- **M-C 第八批 C（replay/takeover，2026-11-26 01:57）**：debug 页真实 replay 面板
  （`SELFTEST:ok:replay:200`）+ takeover 浮层（closed shadow `__bb_takeover_host`）与截图抑制 hook
  （hide→capture→restore）；翻转 33d/24d。
- **M-C 第八批修复批次（2026-11-26 01:57）**：video 字节传输从 JSON 化的 Uint8Array 改为
  `data_base64` 线格式 + 僵尸录制全路径清理；record 边界去重/往返；20d5 `tab.new --window` 走
  `windows.create`；20d7 E2E alias 选择修正（同一 frame + ref/localRef/`@f<id>eN` 四种等价写法，
  不弱化断言）。
- **M-C 第八批 lead 集成（2026-11-26 01:57）**：background 的 record/video RPC、`bb.record.*` 消息
  闸门（async handler 吞消息 bug 修复）、takeover 浮层在 `evaluate` 前强制装好 + 导航后重装、
  `overlay-suppress` op、`refs.negotiate`、observe closed-shadow；content 入口 human-watch；record+video
  新模块合计 **6,462 行**。**最终 TS 产物 212/212 = JS 基线 212/212（+19，0 回退），M-C 达成。**
  下一轮目标：体量 ≥200k（约 63%）+ 补 depth 缺口（长尾 record/video 能力、真实 UI 交互覆盖）。
- **M-C 第九批 A（JS video/record，2026-11-26 02:45）**：`lib/video-{seal,degrade,restore}.js`、
  `record-program.js`、`record-merge.js`；接入既有 `video.start/status/stop/verify/save/recover/list/prune`
  与 `record` 事件入口（`bridge.js:606 → record-events.js`）；manifest seal v2 / 不变量 / 摘要对账、
  预算降级计划与历史、partial 重组、多源事件去重合并、step 校验、行级 diff 三方归并、重放幂等预检。
  +5,367（源码 3,716 + 测试 1,651）。
- **M-C 第九批 B（daemon/CLI，2026-11-26 02:45）**：`daemon/{transfer-policy,command-queue,
  ledger-report,doctor,status-views}.js` + `cli/lib/daemon-views.mjs`；`ledger.status/resolve` 快照/
  对账、transfer 配额/断点续传/整文件 sha 校验、命令队列公平调度 + 诊断（`E_QUEUE_FULL` /
  `E_SESSION_BUSY` / `E_SESSION_STOPPED`）、`daemon ledger|transfer|queue|doctor` CLI；旧默认载荷不变
  （selftest 有键集断言）。+5,136（新增 4,285 + 修改 851）。
- **M-C 第九批 C（lib HAR/trace，2026-11-26 02:45）**：`lib/har-merge.mjs`（多 HAR 合并/去重/时间
  归一/冲突裁决）、`waterfall-attribution.mjs`（三段归因/慢请求/streaming 伪完成/跨帧）、
  `trace-budget.mjs`（确定性采样/span 选择/导出计划）；接入 `debug har|har-import`、
  MCP `browser_debug_har*`、`trace summary/diff/view`、`record export`；空 trace 摘要 deepEqual
  不变。+4,373（新增 4,117 + 修改 256）。
- **M-C 第九批 D（JS 观察/审计，2026-11-26 02:45）**：`lib/vom-{zorder,relations-chain,
  visual-identity,degrade,frames-depth}.js`、`src/audit-{journal,integrity}.js`；`--vom` 时追加
  `vomZOrder/vomRelationChains/vomVisualIdentity/vomEvidence/vomFrameDepth`（默认 observe 字段断言为
  空），`bb.audit.list` 新增 integrity/snapshot/diff/timeline/journal。+4,561（代码 3,060 + 测试
  1,501）。
- **体量里程碑（第九批，2026-11-26）**：规模 **1,088 文件 / 211,018 行 = BSK 66.7%**（本轮 +19,664）；
  **M3（≥200k / 约 63%）达成**；E2E 双 212 保持、无新增 RPC 方法名；下一目标 **M4（≥250k，约 79%）
  + 深度补齐**。
- **M-C 第十批 A（protocol/状态机，2026-11-26 03:40）**：`lib/protocol*.mjs`、`method-catalog`、新
  `method-state-machine.mjs`（165 方法六面可证明性、69 族规则/47 例外/107 恢复 playbook、floor 协商/
  降级/迁移）；经 daemon 派发闸门、health/status、SDK contract、MCP floor 审计消费。+6,537。
- **M-C 第十批 B（MCP/SDK，2026-11-26 03:40）**：JSON-RPC 信封/版本协商/启动硬审计、resources/prompts
  分页 + 新鲜度、completion、审批三级、错误恢复映射、Node McpClient、Python retry/paging/并发/取消；
  MCP 128→**166**、Python 93→**142**。+7,127。
- **M-C 第十批 C（协作/toolbar/borrow，2026-11-26 03:40）**：passthrough 引用计数租约、handback
  状态机、toolbar controller（焦点/键盘/ARIA）、borrow 哈希链证据闭环；接 `tab.borrow` /
  borrow-confirm / cooperation 既有路径。+7,184。
- **M-C 第十批 D（长截图/视频持久化，2026-11-26 03:40）**：bands/dpr/shard/resume/stale/degrade/stitch
  接入 `--full-page` 渲染链；video journal/frames/persist 接入 `video.*` 返回字段；`video.js` 压回
  **1,099 行**守预算。+7,970。
- **M-C 第十批 E（UI 深度，2026-11-26 03:40）**：debug/audit/ops/record/longshot 页面真实 RPC 深交互
  + 15 helper + 3 视图；`ui-*` 单测 117、相邻 UI 门禁 64；`SELFTEST:ok:*` 契约逐字保留。+7,486。
- **M-C 第十批 F（daemon 租约/恢复，2026-11-26 03:40）**：lease-registry/ops、命令边界矩阵、恢复报告、
  两段式 manual resolve；`status views=['leases'|'boundary']`、`ledger.status {recovery:true}`、
  `ledger.resolve {ids,dryRun}`；CLI selftest 346→**356**。+6,239。
- **体量里程碑（第十批，2026-11-26）**：规模 **1,205 文件 / 253,492 行 = BSK 80.1%**（本轮 +42,474）；
  **M4（≥250k / 约 79%）达成**；E2E 双 212 保持、无新增 RPC 方法名；下一目标 **M5（≥316k，100%）
  + 深度补齐**。
- **M-C 第十一批 A（eval oracle，2026-11-26 04:47）**：`tools/eval/**`：seed/收缩/最小反例、102
  property、确定性门禁。+9,464。
- **M-C 第十一批 B（protocol 二轮，2026-11-26 04:47）**：1,166 条可执行 proof obligations、825 格
  兼容矩阵 runner、六阶段 migration planner。+9,104。
- **M-C 第十一批 C（MCP/SDK 二轮，2026-11-26 04:47）**：resource graph/订阅 diff、prompts 版本硬
  门禁、审批链、恢复 playbook、Python 异步全 67 工具；MCP 166→**196**、Python 142→**181**。+8,900。
- **M-C 第十一批 D（回放引擎，2026-11-26 04:47）**：确定性计划/边界还原/目标还原/差异校验/错误码
  解释/自检 + 接线。+9,230。
- **M-C 第十一批 E（长截图/视频三轮，2026-11-26 04:47）**：帧级台账/对账/重绘、压缩与存储配额、
  转码/fMP4 分片预算、分片恢复。+8,227。
- **M-C 第十一批 F（UI 二轮，2026-11-26 04:47）**：数据工作台：导入导出/DSL 过滤/列配置/对比矩阵/
  逐行 diff；`SELFTEST` 契约零改动。+9,479。
- **M-C 第十一批 G（daemon/CLI 二轮，2026-11-26 04:47）**：quota/batch/lease arbitration + CLI 命令
  面；CLI 356→**387**。+9,184。
- **M-C 第十一批 H（record/协作三轮，2026-11-26 04:47）**：step 执行图、执行计划 dry-run、回放会话、
  human/borrow 证据链。+8,083。
- **体量里程碑（第十一批，2026-11-26）**：规模 **1,372 文件 / 321,977 行 = BSK 101.7%**（本轮
  +68,485；scale target 97.9%）；**M5（≥316k / 100%）达成——体量对标越过 100%**；E2E 双 212 保持；
  下一阶段 **M6：深度/质量对标（深度缺口清单，体量不再作为主目标）**。
  本轮集成修复（验收注意事项）：① scale 护栏有意上调（`maxFiles 1,400→1,650`、
  `maxLines 260,000→340,000`；理由 = BSK 对标 316,463 高于旧发布护栏；baseline ±0.5% 与
  minParity 25% 未放松）；② MV3 真实缺陷：回放包装层动态 `import()` 在 SW 抛
  `import() is disallowed on ServiceWorkerGlobalScope`（E2E 20b/33d 复现 210/212）→ 静态 import 修复，
  守卫测试改为禁止 `await import(`；③ 新错误码 `E_PROTOCOL_AUDIT` 登记（158→159）；④
  `record-exec-replay.js` 接进 record export，unused=0；⑤ 修复两个“超出 100%”误报的测试上界。
- **M-C 第十二批 A（E2E 扩围，2026-11-26 09:14）**：既有 212 条逐字不动，新增 10 条真实 CLI/daemon/Edge
  用例（replay 确定性、debug replay、status 兼容证据、batch plan/start、lease report/arbitrate、
  status --views queues、debug har `_validation`、video persistence、longshot shard/restore），套件 212→**222**。
- **M-C 第十二批 B（回放执行路径，2026-11-26 09:14）**：`replay-executor`/`replay-boundary-exec`/
  `replay-diff-exec`/`replay-failure-matrix`（确定性执行编排、真实轨迹边界还原 fail-closed、观测差异校验、
  17 格失败注入矩阵），接线 `replay.js` 只加字段。+6,911。
- **M-C 第十二批 C（质量门禁，2026-11-26 09:14）**：`tools/quality/**` 确定性/幂等/可解释性/反脆弱四类
  门禁，`--check` 5 gates / 56 checks、digest 稳定。+6,657。
- **M-C 第十二批 D（长尾预算，2026-11-26 09:14）**：`tools/longtail/**` 1,788 refs 页面 / 9.1MB HAR /
  240 步 record / 120 片 video manifest 的确定性生成器与实测阈值门禁，4/4 场景 102 checks。+7,425。
- **M-C 第十二批 E（BSK 0.5.0 差分矩阵，2026-11-26 09:14）**：`tools/bsk-diff/**` + `docs/BSK-DIFF-MATRIX.md`
  + 35 条单测；六轴 619 格（equal 26 / partial 220 / missing 62 / extra 255 / unknown 56，已取证 91%），
  unknown 不计等价；证据来自 `bsk.exe` 57 份 help 快照、BSK Rust 源码、`.ref/bsk-help`、`.ref/bsk-results`。
- **里程碑（第十二批，2026-11-26）**：规模 **1,447 文件 / 347,517 行 = BSK 109.8%**；双栈 E2E **222/222**；
  **M6（深度/质量对标）进行中**，以差分矩阵 619 格为深度基线，按 P0 清单推进。集成修复：回放文件预算拆分
  （全部 ≤1,100，补 9 处缺失 import，单测 13 红→5,004/5,004 全绿）；scale 护栏 `maxFiles 1,650→1,800`、
  `maxLines 340,000→380,000`（baseline ±0.5% 与 minParity 25% 未放松）；`E_INJECTED_UNKNOWN`→`E_INTERNAL`；
  E2E 陈旧 daemon 占端口导致 116/222 的复跑事故（清理后 222/222，收尾清理为 P1）。

### 复跑命令

```powershell
$env:PATH = 'D:\tools\node;' + $env:PATH
cd apps/extension
node node_modules\wxt\bin\wxt.mjs build
node node_modules\typescript\bin\tsc --noEmit
node --test tests/*.test.ts
```

（`.wxt/`、`.output/`、`node_modules/` 已进 `.gitignore`；架构工程不改根 `dist/` 与 `extension/`。）

- **M-C 第十三批 A（MCP 工具主链路，2026-11-26 10:30）**：MCP 工具 67→**85**（输入/导航/观测动作、
  console/reload/back/forward、tracked session request_*、tab borrow/return），走既有协议方法；
  Node/Python SDK 三方 85 条一致；MCP selftest 204。
- **M-C 第十三批 B（feature floor + daemon/CLI 参数，2026-11-26 10:30）**：6 个 feature floor（9→15，
  触发面与上游 `FeatureWhen` 同形）、daemon 通用 `cancel`/`ledger.request`（canonical 仍 165）、
  CLI 参数对齐（click/drag/evaluate/extract/read/open）；CLI selftest 404、协议四门禁 0。
- **M-C 第十三批 C（控制面语义，2026-11-26 10:30）**：cooperate/borrow `context_id + control_policy`
  与 passthrough token/租约 epoch 双向映射、handoff 窗口、确认超时；经 dispatch/control 错误证据真实消费，
  旧判定不变（159/159 单测）。
- **M-C 第十三批 E（差分矩阵刷新，2026-11-26 10:30）**：619→**639 格**（equal 27 / partial 262 /
  missing **38** / extra 257 / unknown 55），feature 轴 missing 6→0，P0 30。矩阵由 `tools/bsk-diff`
  代码生成，`--check` 0。
- **里程碑（第十三批，2026-11-26）**：体量 **1,458 文件 / 351,837 行 = 111.2%**；JS E2E **222/222**；
  TS E2E 环境不稳（220/222 最佳，含截图 readback 抖动；复跑出现 CDP 超时/会话丢失 → P1）；
  集成修复：错误码 161、plugin-parity/矩阵/quality/38c 计数同步、**vendor-leak 中性化**（gate clean）。
- **M-C 第十四批 A（MCP 收尾，2026-11-26 11:30）**：工具 85→**92**（inspect html、assist 4 动作、
  session browsers/list），走既有协议方法；三方 SDK 92 条一致；MCP selftest 216；③b missing 7→0。
- **M-C 第十四批 B（RPC unknown 取证，2026-11-26 11:30）**：schema 137→**155**（18 个 daemon/控制面方法
  补 optional 参数契约 + 23 条通用信封方法补真实业务字段，均有实现/CLI 证据）；daemon-typed 参数证据与
  `VideoParams` 枚举变体进入矩阵抽取器。
- **M-C 第十四批 E（矩阵刷新，2026-11-26 11:30）**：639→**646 格**（equal **33** / partial **301** /
  missing **31** / extra 257 / **unknown 24**），P0 32；由 `tools/bsk-diff` 代码生成，`--check` 0。
- **里程碑（第十四批，2026-11-26）**：体量 **1,459 文件 / 352,924 行 = 111.5%**；单测 5,051、CLI 404、
  MCP 216、Python 181；E2E 抖动为当前 P1（JS 最佳 221/222 + `E_SESSION_PAUSED`/20q9 长跑抖动；
  TS 220/222 两处 captureVisibleTab readback），下一轮先稳定 E2E 再继续 partial 长尾。
- **M-C 第十五批（E2E 抖动根因修复，2026-11-26 12:10）**：① JS `E_SESSION_PAUSED` 级联根因 =
  Agent 自产 trusted 输入被误判为人工接管（`dispatch.js#isAgentInputWindow` 500ms 宽限不足），
  修复为 **2000ms 有界宽限**；② TS `captureVisibleTab: image readback failed` 根因 = 窗口最小化/
  遮挡时合成器无可读帧且缺少窗口归一，修复 `ScreenshotService#normalizeWindowVisibility`
  （`windows.update({state:'normal',focused:true})` + 激活 tab 后重试，background 注入 `browser.windows`）
  并补单测。**验收：JS E2E 222/222 + TS 222/222（双栈 clean）**；门禁 5,051/404/216/181、TS tsc 0；
  矩阵保持 **646 格**（稳定性修复，不改对表面）。
- **M-C 第十六批（RPC 语义映射 + 收口，2026-11-26 12:45）**：新增 `FIELD_SEMANTIC_EQUIVALENTS`
  （operation_id↔id、wait_ms↔timeoutMs、dialog_id↔id、duration_ms↔ms），4 个 RPC unknown → partial；
  矩阵 partial 301→**305**、unknown 24→**20**。收口：双栈 E2E **222/222**、体量 **352,967 行 = 111.5%**。
