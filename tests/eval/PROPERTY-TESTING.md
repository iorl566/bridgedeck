# BridgeDeck eval：确定性属性测试与不变量门禁（第十一批 A）

门禁与属性 corpus 完全位于 `tools/eval/`（纯 Node、无第三方依赖）。本目录只放：

| 路径 | 用途 |
| --- | --- |
| `helpers.mjs` | 单测共享工具：仓库根定位、夹具读取、CLI 子进程调用、`file:line` 校验 |
| `fixtures/prng-vectors.json` | PRNG 黄金向量（seed → uint32 流 / int / bool / shuffle / caseSeed / hash） |
| `fixtures/shrink-cases.json` | 收缩器黄金候选（数字 / 字符串 / 数组 / 记录） |

单测位于 `tests/unit/eval-pbt-*.test.mjs`（10 个文件）。

## 1. 分层

```
tools/eval/
  run.mjs                 # CLI：--check 门禁、--json/--md 报告、--list、--out
  lib/prng.mjs            # mulberry32 确定性 PRNG + seed 派生（无挂钟/环境随机）
  lib/shrink.mjs          # 收缩原语 + greedy 1-minimal 驱动
  lib/gen.mjs             # 生成器组合子（array/record/oneOf/map/suchThat/...）
  lib/property.mjs        # 属性引擎：种子化用例、失败收缩、反例重放
  lib/assert.mjs          # 确定性失败消息 + expected/actual/evidence
  lib/source.mjs          # 运行时消费点解析成真实 file:line
  lib/report.mjs          # 稳定 JSON/Markdown 报告 + digest + 结构校验
  lib/corpus.mjs          # corpus 严格加载 / 覆盖面策略 / 运行
  lib/harness.mjs         # 手动时钟、Deferred、队列/账本夹具
  corpus/*.mjs            # 6 个不变量域，共 102 个 property
```

五个**必需**不变量域（`lib/report.mjs` 的 `REQUIRED_AREAS`）：

1. `vom-geometry`：VOM 几何/可见性门/遮挡/绘制栈/命中测试/权重/跨帧归属（21 property）；
2. `observe-diff`：观察文本 diff 分类、patch 回放、最小改动（12 property）；
3. `session-queue`：每 session 串行队列（FIFO/容量/关闭/故障隔离，15 property）；
4. `intent-ledger`：预写意图账本（WAL/UNKNOWN 阻塞/恢复/脱敏/降级，22 property）；
5. `protocol-state`：协议版本协商 + 特征闸门 + 方法证明三态状态机（19 property）。

`eval-kernel`（13 property）是测试器自身的校准域（PRNG/生成器/收缩/报告/源码定位），
参与运行与报告，但不属于必需域。

## 2. 门禁用法

```powershell
$env:PATH='D:\tools\node;'+$env:PATH
node tools/eval/run.mjs --check                 # 固定 seed + 64 cases/property
node tools/eval/run.mjs --check --json          # 机器可读报告（stdout）
node tools/eval/run.mjs --check --md            # Markdown 报告
node tools/eval/run.mjs --list                  # 列出 property 与运行时消费点
node tools/eval/run.mjs --area intent-ledger --cases 200
node tools/eval/run.mjs --property observe-diff/apply-roundtrip --cases 500
node tools/eval/run.mjs --check --out .tmp/eval-property/report.md
```

退出码：`0` PASS；`1` 门禁失败（property 失败 / 非 1-minimal 反例 / 确定性审计失败）；
`2` 基础设施错误（corpus 非法、`file:line` 解析不到、过滤后为空、用法错误）。

`--check` 会做以下事，任一不满足即退出 1：

- corpus 覆盖检查：5 个必需域齐全，每域 ≥3 property，总数 ≥40；
- 源码确定性审计：扫描 `tools/eval/lib/**` 与 `tools/eval/corpus/**`，
  出现 `Math.random` / `Date.now` / `performance.now` / 定时器 / 环境 crypto 即失败；
- 生成器纯度：每个 property 的用例值必须是 `(seed, id, index)` 的纯函数；
- 反例重放：每条失败记录都必须能从记录的 caseSeed 重新生成并再次失败；
- 1-minimal 校验：收缩结果不允许还存在更小的失败候选；
- 报告自校验：schema、digest、runtime `file:line`、必需域字段。

## 3. 确定性保证

- 无挂钟、无 `Math.random`、无环境熵；所有随机来自 `mulberry32` + 显式 seed；
- 用例种子 = `mix32(corpusSeed, fnv1a32(propertyId), caseIndex)`；
- 失败收缩完全确定（候选按「总大小 → 稳定序列化」排序）；
- 报告 JSON 不含耗时/时间戳，`digest = fnv1a32(stableStringify(body))`，
  同 seed 同 corpus 两次运行逐字节一致（`eval-pbt-gate.test.mjs` 断言）；
- 账本/队列等异步对象用手动时钟与手动 Deferred，不依赖真实定时器。

## 4. 运行时消费点（file:line）

每个 property 声明 `consumes`：

```js
consumes: [
  { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' },
  { file: 'lib/intent-ledger.mjs', symbol: 'recover' },
]
```

`lib/corpus.mjs` 在运行前调用 `lib/source.mjs` 扫描真实源码，把符号解析成
`file:line`；解析失败 → 退出码 2。报告里的 `runtime` 段按
`file:line → {symbol, properties, checks}` 聚合，是「这个不变量真的消费了哪个运行时函数」
的可核对证据。`eval-pbt-gate.test.mjs` 会在真实子进程里逐条回读该行并断言含符号名。

## 5. 新增 property 的规矩

1. 先确认不变量来自运行时代码的**文档语义**（注释/契约），不是照抄实现；
2. 每个 property 必须有唯一 `area/name`、非空 `consumes`、确定性生成器；
3. 断言失败时抛 `lib/assert.mjs` 的断言，消息里带 expected/actual 证据；
4. 需要时间/并发时用 `lib/harness.mjs` 的注入时钟与 Deferred，禁止真实 timer；
5. 本地跑 `node tools/eval/run.mjs --check` + `node --test tests/unit/eval-pbt-*.test.mjs`；
6. 若新增必需不变量域，同时更新 `REQUIRED_AREAS`、`corpus/index.mjs` 与本文件。

## 6. 单测

```powershell
node --test tests/unit/eval-pbt-prng.test.mjs
node --test tests/unit/eval-pbt-gen.test.mjs
node --test tests/unit/eval-pbt-shrink.test.mjs
node --test tests/unit/eval-pbt-engine.test.mjs
node --test tests/unit/eval-pbt-report.test.mjs
node --test tests/unit/eval-pbt-source.test.mjs
node --test tests/unit/eval-pbt-corpus.test.mjs
node --test tests/unit/eval-pbt-gate.test.mjs
node --test tests/unit/eval-pbt-harness.test.mjs
node --test tests/unit/eval-pbt-invariants.test.mjs
```

`eval-pbt-gate.test.mjs` 会真实子进程调用 `node tools/eval/run.mjs --check --json`，
校验退出码、报告 digest、runtime `file:line` 的可解析性；这是门禁的端到端消费测试。
