# tools/quality —— BridgeDeck 质量门禁（第十二批 C）

可执行的质量门禁：确定性、幂等、可解释性、反脆弱。零依赖、纯 Node（>=20），
不读写网络、不需要浏览器/daemon。

```sh
node tools/quality/run.mjs --check            # 全量门禁；PASS=0 / 阻断=1 / 用法错=2 / 框架异常=3
node tools/quality/run.mjs --check --json     # 确定性 JSON 报告（stdout 只有这一份文档）
node tools/quality/run.mjs --check --quiet    # CI 单行结论（含 digest/seed/repeats）
node tools/quality/run.mjs --list             # 列出 gate 与它们消费的产品模块
node tools/quality/run.mjs --print-consumption
```

## 四个 gate

| gate | 检查内容 | 真实消费的模块（节选） |
| --- | --- | --- |
| `determinism` | 关键纯函数/规划器同输入 N 次 → 规范化指纹一致；跨进程同 seed 逐字节稳定；重放标识语义；探测器负控制 | `lib/har-plan.mjs`、`lib/har-replay.mjs`、`lib/trace-budget.mjs`、`lib/plan-steps.mjs`、`lib/run-log.mjs`、`lib/error-codes.mjs` |
| `idempotency` | replay 幂等去重与重复执行等价；账本 begin/finish/resolve/WAL 重读语义；recipe 文件 DAO 与锁；幂等 token 跨进程一致 | `lib/intent-ledger.mjs`、`lib/har-plan.mjs`、`lib/recipe-store.mjs`、`lib/methods.mjs` |
| `explainability` | 每个错误码都有 category/retry/nextAction；CLI 失败信封合法且带可机读 retry/hint；finding 必须可渲染 分类/重试/下一步；审计负控制 | `lib/error-codes.mjs`、`cli/lib/json-contract.mjs` |
| `antifragility` | 门禁框架/执行器/账本/临时目录在超时、取消、预算耗尽、存储失败时的清理与结构化失败；无僵尸 timer/句柄 | `lib/har-plan.mjs`、`lib/trace-budget.mjs`、`lib/intent-ledger.mjs`、`lib/limits.mjs`、`tools/quality/lib/registry.mjs` |

`consumption` 不是独立执行的 gate，而是 `run.mjs` 在每轮结束时对
`tools/quality/lib/consumers.mjs` 的核验结果：每个声明的符号都必须在
模块源码里有 `export` 定义行、并在 gate 源码里有引用行；报告里的
`runtime[]` 就是这些真实 `file:line`。

## 确定性策略

- 报告不含时间戳/耗时/绝对路径；`--seed` 默认固定，`--repeats` 默认 5。
- 夹具由 `tools/quality/lib/prng.mjs`（mulberry32/xorshift32 + 固定 golden 向量）生成，
  不使用 `Math.random()`/`Date.now()`。
- 规范化 JSON（键排序、特殊数值标记、数组保序）后再做 sha256 截断指纹。
- 证据对象统一 `stripVolatile`（去掉 `at/durationMs/totalMs/pid/...`），
  所以两次 `--check --json` 可以逐字节比对（集成测试有断言）。
- 跨进程检查真的 spawn 独立 node 进程：同 seed 的 `--fingerprint-suite`
  必须逐字节一致，alt seed 的夹具必须不同但每个 target 仍稳定。

## 可解释性策略

- 运行时错误码真源是 `lib/error-codes.mjs`；分类表在
  `tools/quality/lib/taxonomy.mjs`（`ERROR_TAXONOMY`）。两边双向一致才通过：
  新增错误码不分类 = blocking；分类表里残留已删除码 = blocking。
- `lib/error-codes.mjs` 的 `ERROR_RECOVERY.retry` 是单一真源；分类表不得漂移。
- 每个错误码都能生成 `cli/lib/json-contract.mjs` 的失败信封并通过 `validateEnvelope`；
  有恢复建议时 `hint` 必须出现，没有时不得臆造。
- 每个 quality 门禁码（`QUALITY_*`）都在分类表登记；gate 源码里出现的 code
  必须已登记。finding 构造期（`makeFinding`）拒绝缺 explanation 的失败项；
  `auditFindings` 在报告定稿前再审计一次（含负控制，证明审计非空转）。
- 真实 CLI 也会被检查：`cli/bridge.mjs --json <坏命令>` 必须退出码 2、
  stdout 单行 JSON、`error.code=E_ARG_USAGE` 且带可机读 retry。

## 反脆弱策略

- 门禁框架：每 gate 硬超时、外部 AbortSignal 取消、预算耗尽都产生结构化 finding；
  registry 统计 `timersPending/abortListenersPending`，测试断言归零。
- 执行器：`executeHarReplayPlan` 中途取消 → `stoppedEarly`、未执行项带
  `not-executed:stopped`，重跑新计划必须完全成功（无僵尸状态）；
  超时注入只对幂等请求重试一次，非幂等请求只派发一次。
- trace 预算耗尽：`compactTrace` 有界终止、level 合法、输入对象不被修改、
  B/E、S/F、b/e 事件单元配对完整。
- 账本降级写：WAL/fsync 失败不阻断主流程，但 `durability.degraded` +
  `lastError{code,message}` 必须可查；健康存储不得被误标。
- 临时目录（`withTempDir`）在正常/抛错路径都删除；大小上限超限抛
  `E_RESULT_TOO_LARGE`（含 bytes/limit 证据）。

## 报告

`schema = bb.quality/1`，主要字段：

```
gate{ mode, seed, repeats, timeoutMs, requested, gates, allGates }
gates[]       每个 gate 的 ok/checks/blocking/warnings/blockingIds
findings[]    id/gate/title/ok/severity；失败项另含 code/category/retry/nextAction/detail/evidence
runtime[]     消费点 {gate,module,symbol,location,consumedAt}（全部为真实 file:line）
explainability{ errorCodes, explicitHints, hintCoverage, taxonomyProblems, qualityCodes, ... }
summary{ checks, passed, failed, blocking, warnings, verdict, blockingIds, digest }
selftest{ command, suggestion, consumedBy }
```

`summary.digest` 是报告去掉自身后的规范化 sha256 截断；`verifyDigest(report)`
可自校验。`--out report.md` 写 markdown，`--out report.json` 写 JSON。

## 建议纳入 selftest

```sh
node tools/quality/run.mjs --check
```

建议与既有 selftest 并列加入 `package.json` 的 `test` 链/CI（阻断时 exit 1）。
本批未修改 `package.json`（不在写域内），因此只作为建议与文档记录；
`report.selftest.suggestion` 字段会随每次 `--check` 输出。

## 测试

```sh
node --test tests/unit/quality-*.test.mjs
```

- `quality-canonical.test.mjs`：规范化/指纹/PRNG golden/幂等 token。
- `quality-explainability.test.mjs`：错误码分类、finding 契约、CLI 信封与真实 CLI 失败。
- `quality-consumers.test.mjs`：消费点 file:line 真实性 + 扫描负控制。
- `quality-registry.test.mjs`：超时/取消/预算/异常收敛、定时器与监听器清理。
- `quality-gates.test.mjs`：四个 gate 直接在真实模块上跑，关键检查项齐全。
- `quality-antifragility.test.mjs`：取消/失败注入/账本降级/trace 预算/大小上限/临时目录的语义直测。
- `quality-run.test.mjs`：真实子进程 CLI（退出码、逐字节确定性、--gate、--out、fingerprint suite）。

## 边界

- 只读取产品模块（`lib/**`、`cli/lib/**`），不修改它们；门禁自身只写
  `tools/quality/**` 与 `tests/unit/quality-*.test.mjs`。
- 不跑 E2E、不启动浏览器/daemon、不新增依赖。
- 门禁不是"替代测试"：它证明的是门禁自身的确定性/幂等/可解释/反脆弱，
  行为覆盖仍由既有单测/E2E 提供。
