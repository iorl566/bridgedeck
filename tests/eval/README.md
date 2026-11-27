# BridgeDeck eval 语料（W6）

本目录是 Agent 可执行评测语料与三态 oracle 的入口。目标：每条 case 都可离线复现，且
`failed` / `unverified` 永远不会被算成 `pass`。

## 1. 分层（layer）与 oracle level

| layer | 文件 | oracleLevel | 执行方式 |
| --- | --- | --- | --- |
| offline | `cases/fake-core.json`（遗留 15 条）、`cases/offline-extended.json`（43 条） | `offline-fake` | `dsh-plugin/lib/fake-adapter.mjs` 驱动 37 个插件工具，不连 daemon、不开浏览器 |
| dom | `cases/dom-cases.json`（12 条 + `dom/` 夹具） | `dom-real` | 真实 headless Chromium（`tools/lib/overlay-dom-harness.mjs`）计算 DOM 事实 |
| e2e | `cases/core.json`（127 条）+ `cases/e2e-metadata.json` | `e2e-real` | 真实 Edge E2E 的 `PASS/FAIL <id>.` 行（`tools/eval-from-e2e.mjs`） |

默认报告器实际执行 offline + dom：**70 条可复现 case**
（期望 passed=58 / failed=7 / unverified=5）。E2E 层由 lead 统一跑真实浏览器，
其中 127 条 case 的 capability/oracle level/证据规则由 `e2e-metadata.json` 单源声明。

## 2. 每条 case 的必需元数据

```json
{
  "id": "offline-rpc-act-fill",
  "title": "直连：browser_act fill 走协议 fill 并按 ref/value 传参",
  "capability": "plugin.rpc-routing",
  "oracleLevel": "offline-fake",
  "expectedStatus": "passed",
  "evidence": ["value"],
  "evidenceRule": "fill 证据必须包含真实写入值；rpc 参数必须命中 fill 方法"
}
```

- `id`：全局唯一（跨文件重复会被 `loadCorpusLayers` 拒绝）；
- `capability`：必须登记在 `lib/eval-e2e-corpus.mjs` 的 `CAPABILITIES` 目录；
- `oracleLevel`：`offline-fake` / `dom-real` / `e2e-real`；
- `expectedStatus`：三态之一；`failed` 只允许“负向自检”（显式 `negative: true`）；
- `evidence`：离线/DOM 层要求输出里非空的点号路径；缺失任一 → 降级 `unverified`；
- `evidenceRule`：人类可读的证据规则，报告里逐条展示。

离线层额外字段：`mode`（`tool`/`rpc`）、`script`（fake adapter 脚本）、`assert`/`contains`、
`expectError`、`expectRpc`/`expectCli`/`expectCallCount`/`expectCliCount`（参数与 argv 断言）。
DOM 层额外字段：`assert`/`contains`，其中 key 是 `dom/eval-dom-cases.js` 产出的事实路径。

## 3. 指标与门禁

`lib/eval-e2e-metrics.mjs` 提供纯函数：

- `classifyOutcome`：3×3 三态矩阵 → `tp/tn/tu/fp/fn/skip/missed-negative/overclaim/unexpected-failure`；
- `computeMetrics`：`precision = tp/(tp+fp)`、`recall = tp/(tp+fn+skip)`、`skipRate = skip/expectedPassed`，
  并按 `layer/capability/oracleLevel` 分组；
- `classifyFailure`：fp/fn/skip 的根因分类（错误码 / rpc 参数 / CLI argv / DOM 事实 / 缺值 / contains /
  证据缺失 / runner 错误……）；
- `evaluateGate`：阈值从 `thresholds.json` 读取，任一不满足 → `ok=false`，CLI 退出码 1。

`unverified` 记为 skip（不算 pass），并计入 recall 的漏判分母。

## 4. 常用命令

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\Programs\DeepSeek Harness\DeepSeek Harness.exe" tools/eval-report.mjs
& "D:\Programs\DeepSeek Harness\DeepSeek Harness.exe" tools/eval-report.mjs --offline-only --no-write
& "D:\Programs\DeepSeek Harness\DeepSeek Harness.exe" tools/eval-from-e2e.mjs --print-metadata
& "D:\Programs\DeepSeek Harness\DeepSeek Harness.exe" --test tests/unit/eval-*.test.mjs
```

- 报告默认写 `.tmp/eval-report/eval-report.{json,md}`；`--out/--json/--md/--no-write` 可覆盖；
- 退出码：`0` 门禁 PASS、`1` 门禁 FAIL、`2` 用法/语料/基础设施错误（如缺浏览器、缺 dsh-plugin）；
- `--offline-only` 明确放弃 DOM 证据，会把 `requiredOracleLevels` 清空（报告里标注 offlineOnly）。

## 5. 新增 case 的规矩

1. 先跑一次能真实复现的行为，再把它写成 case；不允许为凑数复制 case；
2. 必需元数据齐全，`evidence` 路径必须在真实输出里存在；
3. 负向自检必须显式 `negative: true`，且失败证据（expected/actual）可复现；
4. 改动后跑 `tools/eval-report.mjs` + `--test tests/unit/eval-*.test.mjs` + `tools/source-guard.mjs`；
5. DOM 夹具只负责产出浏览器事实，断言留在 `dom-cases.json`（oracle 与夹具分离，负向 case 才能真失败）。

## 6. 确定性属性测试（第十一批 A）

除了上面的 Agent 能力语料，本目录还有一层**确定性属性测试**基础设施：
`tools/eval/**` + `tests/eval/fixtures/**` + `tests/unit/eval-pbt-*.test.mjs`。
它把 VOM 几何、观察 diff、每 session 队列、意图账本、协议状态机的不变量做成
seed 固定的属性 corpus，可用 `node tools/eval/run.mjs --check` 作为门禁，
报告里逐条给出运行时消费点 `file:line`。详见 `tests/eval/PROPERTY-TESTING.md`。
