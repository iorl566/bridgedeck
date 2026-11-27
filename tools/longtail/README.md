# tools/longtail —— 长尾 / 规模预算门禁

本目录提供**确定性大夹具生成器 + 真实模块预算门禁**，用来回答一个具体问题：

> 当页面有 ≥1000 个可引用元素、HAR ≥5MB、录制程序 ≥200 步、视频 ≥100 个分片时，
> 现有的观测 / HAR 合并 / 回放预检 / 视频恢复模块**还能不能在时间与内存预算内正确工作**？

门禁入口只有一条：`node tools/longtail/run.mjs --check`。它不是"打个日志"的脚本：
生成器负责造出可复现的大规模输入，场景用**真实模块**（只读 import，不改扩展/lib 源码）
消费这些输入，逐项断言规模/正确性/时间/内存，任何一项失败都会给出稳定原因码并以 exit 1 结束。

## 快速开始

```bash
# 严格门禁：4 个场景全跑，预算/不变量/指纹任一失败 → exit 1
node tools/longtail/run.mjs --check

# 机器可读（CI / 测试直接解析）
node tools/longtail/run.mjs --check --json

# 缩小夹具（单测/快速回归，约 0.8s）
node tools/longtail/run.mjs --check --scale=smoke

# 只跑某个场景 / 换 seed / 保留 tmp 目录排查
node tools/longtail/run.mjs --scenario=har-merge
node tools/longtail/run.mjs --seed=12345
node tools/longtail/run.mjs --keep-tmp

# 全绿后更新基线（阈值 + 参考实测 + 夹具指纹）
node tools/longtail/run.mjs --update-baseline
```

退出码：`0` 通过；`1` 预算/不变量/场景错误；`2` 用法错误。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `run.mjs` | CLI 入口：参数解析 / 场景选择 / 基线加载 / 报告输出 / 退出码 |
| `lib/prng.mjs` | mulberry32 PRNG、FNV-1a 哈希、`stableStringify`、SHA-256、seed 派生 |
| `lib/measure.mjs` | `performance.now()` 测量、内存快照/峰值、分位数、格式化 |
| `lib/tmpdir.mjs` | 大夹具临时工作区：只写 `os.tmpdir()`、路径逃逸护栏、字节上限、清理 |
| `lib/budget.mjs` | 规模预设、预算规格校验、check 判定、失败原因码、阈值覆盖 |
| `lib/model.mjs` | 夹具 → 真实模块入参的适配（页面图/observed/frame/HAR→network entry） |
| `lib/report.mjs` | 场景判定、报告组装、基线读写、漂移对比、人类可读输出 |
| `gen/page.mjs` | 大页面夹具（≥1000 refs / 深嵌套 / 多 iframe） |
| `gen/har.mjs` | 大 HAR 夹具（多来源 ≥5MB / 冲突/去重 / 故障探针） |
| `gen/record.mjs` | 长 record 夹具（≥200 步 / 分支 / 循环 / human-gate / 故障探针） |
| `gen/video.mjs` | 大视频 manifest/分片夹具（≥100 片 / 6 种恢复现场） |
| `scenarios/*.mjs` | 4 个预算场景：真实模块调用 + 指标采集 + 失败探针 + 预算规格 |
| `baseline.json` | 阈值 + 参考实测 + 夹具指纹（KB 级；大夹具永不入库） |

## 规模预设

| 预设 | 页面 | HAR | record | 视频 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `default` | 1200 refs / 深度 16 / 12 iframe | 4 来源 × 320 条 / ≥5MB | 240 步 / 6 分支 / 5 循环 / 4 人工门 | 120 片 / ~5.8MB | 验收门禁 |
| `smoke` | 320 refs / 深度 10 / 6 iframe | 2 来源 × 80 条 / ≥0.9MB | 72 步 / 2 分支 / 2 循环 / 1 人工门 | 36 片 / ~1.7MB | 单测快速回归 |

`smoke` 的计数下限按自身规模生成（例如 `refs≥320`），因此**不能**直接套用 default 基线；
`run.mjs` 只在 `baseline.createdWith.scale === 本次 scale` 时复用基线阈值，避免假失败。

## 场景与真实模块消费

### ① `page-vom` —— 大页面：元素 / 边 / 时间

生成 `{ main:{nodes,edges}, entries:[frame...] }` 页面图 → 写 tmp → 读回 → 依次消费：

- `extension/src/lib/vom-graph.js#buildVomGraph`（默认上限 600 节点截断 + 提高上限全量图）
- `extension/src/lib/vom-weights.js#attachVomScores/rankVomNodes`
- `extension/src/lib/vom-budget.js#evaluateVomBudget`（元素/token 预算裁剪）
- `extension/src/lib/vom-affordance.js#summarizeAffordances`
- `extension/src/lib/vom-semantic.js#buildVomSemanticGraph`
- `extension/src/lib/vom-groups.js#buildVomGroups`
- `extension/src/lib/frame-vom.js#buildFrameVomGraphs`（13 帧子图 + frame 边）
- `extension/src/lib/vom-frames-depth.js#buildFrameDepthReport`（帧树/归属链/缺口）
- `extension/src/lib/vom-frame-relations.js#buildCrossFrameRelations`
- `extension/src/lib/vom-relations.js#buildVomRelationGraph`

断言示例：`refs ≥ 1200`、`maxDepth ≥ 16`、`frames = 12`、无截断时默认图节点数受 600 保护、
关系边 ≥ 600、`invalidates` 边存在、跨帧归属边 = 12、帧缺口 = 0、元素预算发生裁剪、
同 seed 两次运行指纹一致、夹具仅写 tmpdir。

### ② `har-merge` —— 大 HAR：合并 / 校验 / 归因

4 个来源（约 55% 跨来源共享，带状态码/正文/时长冲突）→ 写 tmp → 按索引读回字符串 →
`parseHarSource` → `mergeHarSources` → `validateHarDeep`/`explainHarIssues` → 往返 →
`attributeWaterfall`/`selectWaterfallRows`/`correlateFrames`/`auditCompletion`/`summarizeWaterfallAttribution`。

断言示例：来源总字节 ≥5MB、去重 > 0、冲突 > 0、深校验 error = 0、往返 entry 字段 0 差异、
慢请求可识别、`degraded.limited` 生效、`selectWaterfallRows` 丢行、流式请求保持 `finished=false`、
跨 frame 归因 ≥2 帧、完成度审计 0 违规。

### ③ `record-program` —— 长 record：构建 / 校验 / 回放预检

240 步（6 个 navigate 边界 → 7 段、5 组连续重复 → 循环组、4 个带值 human-gate、重试预算 8）→
`extension/src/record-program.js` 的
`buildRecordProgram` / `validateRecordProgram` / `preflightReplay` / `summarizeRecordProgram` /
`programFingerprint` / `programDiff` / `mergeRecordPrograms`。

断言示例：校验 error = 0；严格预检逐条拦截全部非幂等副作用（blocker 数 = 非幂等步数，
原因为 `REPLAY_SIDE_EFFECT`）；`allowNonIdempotent` 后 0 blocker、只留循环/重试 warning；
程序指纹稳定；`programDiff` 检出变体差异；合并产物非空。

### ④ `video-manifest` —— 大视频：追加 / seal / 恢复

120 个分片（每个 ~48KB 真实内容写入 tmp）→ 从磁盘读回重算 SHA-256 → `createSegmentManifest` →
`appendSegment` ×120 → `validateManifest` → `sealManifest`（真实 SHA-256 摘要 + 分片链摘要）→
`manifestRecordFields` → `planSegmentRecovery` ×6 种恢复现场。

断言示例：逐片校验和与 manifest 记录一致（120/120）；seal digest 合法且 durability=verified；
完整/缺片/截断/损坏/未登记/空 OPFS 六种场景的 `recovered/completeness/keptSegments/错误码`
逐一匹配；sealed 后追加必须 `E_VIDEO_MANIFEST_SEALED`；缺校验和 seal 必须 `SEAL_INVALID`；
空 OPFS 必须 `E_VIDEO_SEGMENT_UNAVAILABLE`；同 manifest 二次 seal 摘要一致。

## 预算语义

每个场景声明 `budgetFor(scale)`：`timeMs` / `timeWarnMs` / `memoryMb` + 一组 check。

- 时间：`actual > timeWarnMs` → warning；`actual > timeMs` → fail（`time-budget-exceeded`）。
- 内存：默认用**轮内堆峰值增量** `peakHeapUsedMb`；绝对 `peakRssMb` 另有一条宽松的 max 兜底。
- check：`min` / `max` / `equal` / `truthy` / `range` / `exists`；`severity=warning` 只降为 warn。
- 原因码（稳定字符串，报告/基线都按它聚合）：
  `time-budget-exceeded`、`time-warning`、`memory-budget-exceeded`、`metric-below-minimum`、
  `metric-above-maximum`、`metric-mismatch`、`metric-out-of-range`、`invariant-failed`、
  `metric-missing`、`fingerprint-drift`、`evidence-missing`、`scenario-error`。
- 每个场景还带"失败注入探针"：超时/超内存必须给出 time/memory 原因码；坏 HAR、非法 record
  程序、sealed 追加、缺校验和 seal、空 OPFS 都必须给出具名的模块错误码。探针失败算场景失败。

## 基线（baseline.json）

- `--update-baseline` 只在该次运行**全绿**时写入，且只允许 `--scale=default`（smoke 阈值仅供单测）。
- `--check` 时：规模匹配才复用基线阈值；`seed`/生成器漂移导致夹具指纹变化 → `fingerprint-drift` 失败。
- 时间/计数相对基线的漂移只记 warning（噪音），内存峰值与 <5ms 的极小时耗不参与漂移对比。
- 基线是 KB 级 JSON，可以进仓库；**大夹具永远不写仓库**。

## 确定性与 tmpdir 契约

- 所有随机来自 `seed` 派生的 mulberry32；不用 `Math.random`/`Date.now` 进夹具内容。
- 固定基准时间（HAR 2026-03-01 / record / video 各自常量），跨进程逐字节可复现。
- 大夹具只写 `os.tmpdir()/bridge-longtail-*`：`lib/tmpdir.mjs` 拒绝绝对路径、`..` 逃逸、仓库路径，
  默认 256MB/4096 文件护栏；默认跑完即删（`--keep-tmp` 保留并打印目录）。
- `--out` 拒绝写仓库内的非 `tools/longtail/` 路径；基线写入同样限制在 `tools/longtail/`。

## 本机实测（2026-11，default scale，seed=1592598101）

| 场景 | 场景耗时 | 堆峰值增量 | RSS 峰值 | 关键规模 | checks |
| --- | --- | --- | --- | --- | --- |
| page-vom | ~200ms | ~28MB | ~108MB | refs=1788 / edges=2860 / relations=1056 / frameLinks=12 | 25 |
| har-merge | ~750ms | ~56MB | ~269MB | 来源 9.1MB / 合并保留 752 条 / 去重 528 / 冲突 702 | 31 |
| record-program | ~43ms | ~7MB | ~270MB | steps=240 / 7 段 / 循环 5 / 人工门 4 | 22 |
| video-manifest | ~306ms | ~7MB | ~292MB | 分片 120 / ~5.8MB / 校验和 120/120 | 24 |

整轮 `--check` 约 1.4~1.8s（含生成/落盘/读回），`baseline` 漂移 0。

## 测试

```bash
node --test tests/unit/longtail-*.test.mjs
```

- `longtail-prng`：PRNG/哈希/稳定文本化/确定性。
- `longtail-measure`：计时/内存/分位数/错误捕获。
- `longtail-tmpdir`：路径逃逸、字节/文件上限、清理、只写 tmpdir。
- `longtail-budget`：预设规模、check 判定、原因码、阈值覆盖/退出码。
- `longtail-generators`：四类夹具的规模契约与确定性（含失败探针）。
- `longtail-report`：报告/基线读写/漂移/退出码。
- `longtail-scenarios`：4 个场景在 smoke 规模真实跑通、二次运行指纹一致、tmp 清理。
- `longtail-run`：CLI 参数/过滤/真实子进程 `--check`/基线模式/seed 漂移。

## 已知边界（如实记录）

- HAR `importHar → buildHar` 往返在 **page 数量** 上会从多来源 page 合并为 1 个 page（导出侧只建
  单页）；entry 字段级往返为 0 差异，门禁只卡 entry 字段。page 差异作为 evidence 保留。
- `auditCompletion` 把"显式 `streaming=true` 但 `finished=false`"视为违规（模块当前语义），
  因此转换层**不**显式声明 streaming，由 `buildWaterfall` 按 `finished/status` 推导；
  attribution 仍会统计 streaming 行。
- VOM 关系图有内置 cap（relations/groups/contains）；default 规模下 relations=1056 已是 cap
  内的结果，报告里带 `relationTruncated` 便于区分"规模不够"与"被上限裁剪"。
- 时间/内存阈值按本机实测 ×2~3 倍留余量；换机器/CI 若超预算，用 `--time-scale`/`--memory-mb`
  临时放宽（计数下限不放宽），并在 `--update-baseline` 后记录新基线。
