# 0.3.0 深度补强记录（2026-11-25 会话）

> 本文件是工作记录，不是发布物。0.3.0 仍是冻结版本：未升号、未重新打包、`dist/` 未改、
> 未动 `D:\CTRM自动录入`。基线 = `D:\浏览器桥-0.3.0-backup-20261125-110641`。
> 本轮按 `docs/COMPARISON-BSK-0.5.0.md` 的 P0/P1/P2 缺口做 5 条并行工作流，
> 共同约束：只加源码/测试/夹具，不新增依赖，每项必须有真实浏览器或可复现 DOM 证据。

## 1. 结论

- 工作树：**782 文件 / 96,307 行**（基线 753 / 90,694）；对 BSK 0.5.0 代码体量比
  **27.4% → 29.3%**（`node tools/scale-report.mjs`）。
- 门禁：单测 **1113 项（1111 过 / 2 挂）**、CLI **159/159**、MCP **21/21**、
  插件 **26/26**、配对 **46/46**、TLS **8/8**、真实 Edge E2E **212/212**（0 跳过）。
  2 个挂起项是本机 `%TEMP%` 清理的 `ENOTEMPTY`，在冻结备份上同样复现，非本轮回归。

## 2. 落地内容（按缺口）

### 2.1 动作事务深度（P0-2）—— 输入时钟 / 3 步 fill / 虚拟行守卫

- `extension/src/lib/input-clock.js`（新）：单调输入时钟（`performance.now` 优先、可注入），
  每事务 epoch + 单调序号；时间回退/乱序/事务结束返回 `{ok:false, cause, evidence}`。
- `lib/input-transaction.js`：租约接入时钟，新增 `stamp(tabId)`；`ttlMs/begin/end/get/clear` 兼容。
- `tools/pointer-primitives.js` / `tools/pointer-actions.js`：CDP 鼠标事件带单调 `timestamp`，
  按下后 UNKNOWN 或时钟回退不再补发第二次动作。
- `tools/fill-verify.js`：`planFillSteps` 快路径规划——空简单 input **1 步** insertText；
  有值/富文本 **≤3 步**（focus→clear→insert，富文本 clear 走 Keyboard Ctrl+A，普通控件走页面 select）；
  select/date 等 programmatic 控件 ≤3 步。返回 `fill_strategy/fill_steps/fill_step_count/fill_clear_via`。
- `lib/virtual-row-guard.js`（新）：纯函数分类器（aria-rowindex/data-index/transform/previousRowIndex/
  rowKey/recycled/detached/容器 scrollTop），`checkRowAnchor` 产出 `E_TARGET_MISMATCH` + 证据；
  `tools/fill-actions.js` 增加 opt-in `params.rowAnchor` 守卫。
- 证据：`tests/unit/input-clock.test.mjs`（9）、`virtual-row-guard.test.mjs`（7）、
  `fill-fastpath.test.mjs`（6 单测 + 1 真实浏览器），`tests/browser/fill-transaction.*` 真实 headless
  Chromium 5 场景（`FILL_TX_OK:5`）。

### 2.2 协作抑制（P0-3）—— 引用计数 + passthrough token

- `lib/capture-suppression.js`（新）：引用计数抑制、嵌套 acquire、幂等 release、2 rAF ack（raf 可注入）、
  计数归零才真正解除；`E_CAPTURE_BAD_TAB` / `E_CAPTURE_LIMIT` 结构化失败。
- `lib/passthrough-token.js`（新）：一次性令牌（TTL 30s、cap=64 FIFO 驱逐 fail-closed、grantee 绑定），
  `E_TOKEN_EXPIRED/USED/GRANTEE/UNKNOWN/CAPACITY/BAD_ARG`。
- 接入：`overlay-suppress.js` 改为引用计数（旧“计数减一”在重复 release 时会误减他人引用，已消除）；
  `cooperation.js` 改为签发/消费令牌，新增 `verifyCooperationPassthrough` 与 `cooperationRuntimeState`。
- 证据：`tests/unit/cooperation-suppression.test.mjs` + `passthrough-token.test.mjs`（22 项，含真实
  headless DOM），`tests/browser/cooperation-suppression.*` 真实内容脚本 5 场景（`COOP_SUP_OK:5`）。

### 2.3 VOM 内部模型（P0-1）—— affordance / layers / stable refs

- `lib/vom-affordance.js`（新）：10 类 affordance（activate/type/toggle/select/drag/scroll/dismiss/
  hover/focus/upload）+ confidence + evidence（规则名+字段），接入 payload `nodes[].affordance` 与图节点。
- `lib/vom-layers.js`（新）：base→fixed-sticky→floating(z-index)→blocking→top-layer 有序模型，
  `blocking-layers.js` 回填 `layerKind/index/zIndex/topLayer`，payload `layers` 输出非 base 层。
- `refs/ref-registry.js`：新增稳定性签名（backendNodeId+frameId+cdpSessionId+documentId）+ generation，
  文档变更失效旧 stable ref 并触发重协商；`tools/refs-negotiate.js` 返回
  `stale_document/stale_generation/stale_revision` 且 `renegotiate:true`。
- page-lib：`20/26/27/30` 分块补 top-layer/层栈/affordance 事实，重建 `injected/page-lib.js`
  （4,158 → 4,343 行）；`LIB_VERSION` 未升，已注入旧页面的 tab 需刷新。
- 证据：`tests/unit/vom-affordance.test.mjs` + `vom-layers.test.mjs`（16），
  `tests/browser/vom-affordance.*` 真实 Chromium 35 断言（`VOM_AFF_OK:35`）；
  `vom-bench --check` 无分数漂移、计费仍只按 name+role。

### 2.4 DSH 插件 + eval 回归（P1-4/P1-6）

- `dsh-plugin/lib/fake-adapter.mjs`（新）：与 `daemonRpc` 同形的可脚本化假 daemon（handler/result/error/
  delay/超时/调用序列），插件工具可离线完整单测。
- `lib/eval-oracle.mjs`：三态判定（pass/fail/unverified）+ evidence 必填规则，unverified 永不算 pass。
- `tools/eval-fake.mjs`（新）+ `tests/eval/cases/fake-core.json`（15 case，含 4 个负向自检）：
  离线运行器输出三态计数，未期望失败 exit≠0。
- `tests/unit/plugin-parity.test.mjs`（新）：MCP 67 工具 ↔ 插件 37 工具 ↔ canonical 165 方法三方对照，
  差异（109 项）全部落显式豁免表，无静默放过。
- 修真实缺口：`browser_observe` 不再吞掉 daemon 业务错误（仅 `E_DAEMON` /
  `E_DIRECT_RPC_DISABLED` 回退 CLI）；`TOOL_METHODS` 随 spec 暴露。

### 2.5 协议单一 catalog（P2-9）

- `lib/method-catalog.mjs`：165 行权威目录（method/owner/effect）+ 5 feature floor（全 1.9）+
  daemon-only 5 方法；`tools/gen-protocol.mjs` 由它生成 `extension/src/generated/protocol.js`
  对应表；新增 `tools/protocol-single-source.mjs` 硬审计（8 段，`--json`），并接入 `protocol-check.mjs`。
- 生成物既有块与备份逐字节相同，仅追加新表；165 方法 / 5 floor / 67 MCP 工具计数不变。
- 证据：`tests/unit/protocol-single-source.test.mjs`（11 例，含 7 个负例：改 effect/owner/floor/文档/
  MCP 引用即 fail）。

## 3. 门禁（本轮实跑）

| 门禁 | 结果 |
| --- | --- |
| 单测 `--test tests/unit/*.test.mjs` | 1113 项，1111 过，2 挂（TransferStore `%TEMP%` ENOTEMPTY，基线同样复现） |
| CLI selftest | 159/159 |
| MCP selftest | 21/21 |
| 插件 selftest | 26/26 |
| 配对 / TLS / ws | 46/46 / 8/8 / 7/7 |
| 真实 Edge E2E（`BB_E2E_SYNC_DOCS=0`） | **212/212，0 跳过** |
| source / encoding guard | clean（259 / 1176 文件） |
| page-lib / protocol / schema / vendor / path | 全部 exit 0 |

## 4. 基线既存缺陷（本轮修正，非新功能）

1. `tests/plugin/selftest.mjs` 期望 35 个工具，实际 37（`dsh-plugin/README.md` 与
   `tests/unit/dsh-tools.test.mjs` 均为 37）→ 已改 37 并补 `browser_plan`/`browser_ledger`。
2. `tools/protocol-check.mjs` 只扫 `daemon/server.mjs`，未扫已拆出的 `daemon/local-dispatch.js`，
   冻结树上误报 41 项无路由（备份同样 exit 1）→ 已补扫描范围。
3. 新增协作错误码 8 个 → 已登记 `lib/error-codes.mjs` 并 `tools/gen-error-codes.mjs` 同步
   `docs/PROTOCOL.md`、`sdk/index.mjs`、`sdk/index.d.ts`、`sdk/python/browser_bridge.py`（共 122 码）。

## 5. 明确未接线 / 未做

- **虚拟行守卫端到端未接**：fill 侧是 opt-in `params.rowAnchor`，observe/VOM 尚未产出该行事实；
  page-lib 现役守卫只比行文本（`51-key-fill.part` 的 `assertRowAnchor`），比本分类器弱。
- **capture suppression 未接 `dispatch.js` / `ops.js`**：这两个中心枢纽本轮禁改，截图/输入事务外层
  尚未 acquire/release；`overlay-suppress` 已完整引用计数化。
- 5 个 daemon-only 方法（`command.cancel`/`inflight.list`/`ledger.status`/`ledger.resolve`/
  `pair.rotate`）仍缺 `METHOD_EFFECT` 条目，已在 `plugin-parity` 显式登记。
- TS/React/WXT 扩展构建、Rust/原生二进制/多平台发布、原生 fsync **未做**（本轮只做协议单一 catalog）。
- `docs/extension-and-skill-guide.md`、`docs/FUNCTION-MATRIX.md` 里“35 个工具”为过期表述，未改。

## 6. 复跑方式（本机无独立 Node）

本机 PATH 无 `node`/`npm`/`pnpm`，唯一运行时是 Electron-as-node（v24.21.0）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Programs\DeepSeek Harness\DeepSeek Harness.exe' --test tests/unit/input-clock.test.mjs
& 'D:\Programs\DeepSeek Harness\DeepSeek Harness.exe' tools/e2e.mjs --browser edge
```

E2E 建议设 `BB_E2E_SYNC_DOCS=0`，避免改写 README 截图（注意 UI 自检仍会重写
`docs/assets/ui/breathing-glow-*.png`，跑完需从备份还原该文件）。
