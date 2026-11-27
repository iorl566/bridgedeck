# 上游 0.5.0 差分矩阵（可复现）

本文件由 `node tools/bsk-diff/run.mjs` 生成，**不要手改**。机器可复核版本：`tools/bsk-diff/matrix.json`。

## 口径（先读这一节）

状态取值只有五种：`equal` / `partial` / `missing` / `extra` / `unknown`。含义如下（这是判定准则，不是修辞）：

| 状态 | 含义 |
| --- | --- |
| `equal` | 两侧在同一「可核对面」上一致（名称/参数集合/字段集合/权限集合），且双方证据均已定位。不等于行为逐字节等价。 |
| `partial` | 两侧都有该能力，但可核对面存在缺口（选项缺、字段缺、粒度不同、floor 不同），缺口逐条列在「差距」列。 |
| `missing` | BSK 0.5.0 有、我方没有对应实现（本轴内）。 |
| `extra` | 我方有、BSK 0.5.0 在本轴内没有对应物（不代表 BSK 别的轴没有该能力）。 |
| `unknown` | 取证不足：至少一侧缺少可用于比对的机械证据，因此不判等价，只记录缺什么证据。 |

**unknown 不计入等价**。总览里的「已取证比例」只统计 equal/partial/missing/extra 四类；unknown 单独一列并显式扣除。任何一方只有口号没有 file:line / help 行 / 源码符号的格子，一律 unknown。

**equal 的边界**：本报告里的 equal 只证明「可核对面一致」（命令名/参数名集合/字段集合/权限集合/floor 触发条件），不证明行为逐字节等价 —— 行为等价需要 E2E 或双向 golden 结果，不在本任务证据范围内。

**extra 的边界**：extra 只表示在该轴（例如 MCP 工具面）上游 0.5.0 没有对应物，不代表 上游 在别的轴没有该能力（如 video/record/debug 在 上游 是 CLI + 协议方法，但不暴露为 MCP 工具）。

## 总览

| 轴 | 格数 | equal | partial | missing | extra | unknown | 已取证比例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ① CLI 命令 | 80 | 8 (10%) | 48 (60%) | 0 (0%) | 24 (30%) | 0 (0%) | 100% |
| ② RPC 方法 | 172 | 13 (7.6%) | 61 (35.5%) | 0 (0%) | 78 (45.3%) | 20 (11.6%) | 88.4% |
| ③ MCP 工具 | 148 | 0 (0%) | 104 (70.3%) | 0 (0%) | 44 (29.7%) | 0 (0%) | 100% |
| ④ 扩展能力 | 9 | 1 (11.1%) | 8 (88.9%) | 0 (0%) | 0 (0%) | 0 (0%) | 100% |
| ⑤ 协议 feature floor | 15 | 1 (6.7%) | 8 (53.3%) | 0 (0%) | 6 (40%) | 0 (0%) | 100% |
| ⑥ 错误码 | 217 | 13 (6%) | 104 (47.9%) | 0 (0%) | 100 (46.1%) | 0 (0%) | 100% |
| **合计** | **641** | **36** | **333** | **0** | **252** | **20** | **96.9%** |

> 行数口径：① CLI = 上游 56 命令 + 我方独有动词；② RPC = 两侧方法表并集；③ MCP = 我方 85 工具 + 上游 MCP 动作覆盖缺口；④ 扩展 = 8 个能力面 + manifest 权限面；⑤ floor = 我方 9 个 + 上游 独有 6 个；⑥ 错误码 = 上游 15 ErrorCode + 102 RpcErrorReason + 我方独有码。

### 证据来源与采集方式

| 来源 | 用途 | 具体文件 / 方式 |
| --- | --- | --- |
| BSK 实机帮助快照 | CLI 轴权威证据（56 命令 + 根帮助） | `tools/bsk-diff/data/bsk-exe-help/`（`run.mjs --snapshot-help` 从 `ref/bsk-0.5.0-bin/bsk.exe` 采集） |
| BSK 历史帮助旁证 | 交叉校验（**不是**权威） | `.ref/bsk-help/` 49 个文件：与实机快照字节一致 0（`.ref` 为 CRLF、快照统一 LF，故字节一致天然偏低）、参数面一致 18、已过期 31 |
| BSK Rust 源码 | RPC/feature/错误码/MCP 面 | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`（`method.rs`/`tools/*.rs`/`error.rs`/`compatibility.rs`/`cli/mcp/tools.rs`） |
| 上游 扩展产物 | 扩展能力轴 | `ref/bsk-0.5.0-ext`（manifest.json + pages + content-scripts + chunks） |
| 上游 历史结果 | 行为旁证 | `.ref/bsk-results/`（22 个文件） |
| 我方源码 | 全部轴 | `lib/method-catalog.mjs`、`lib/schemas.mjs`、`cli/**`、`mcp/tools-*.mjs`、`extension/**`、`lib/error-codes.mjs` |

**关于我方扩展分发表**：任务简介里写的 `extension/src/dispatch.js（COMMANDS）` 在 0.3.0 冻结树里的实际符号是 `HANDLERS`（`extension/src/dispatch.js` 的 `export const HANDLERS`，103 个方法 → 行号逐条作为证据）。矩阵按 `HANDLERS` 取证，没有另造一份 `COMMANDS` 清单。

**关于 `.ref/bsk-help` 旁证**：该目录是历史采集产物，其中 `help.txt` 是 PowerShell 采集失败的报错文本，`_root.txt` 仍是 49 命令的旧根帮助（比 0.5.0 实机少 open/sync/close/ledger/plan/recipe/read 七个命令）。因此 CLI 轴以 `data/bsk-exe-help/` 实机快照为准；`run.mjs --probe-exe` 会重新执行 exe 逐命令校验快照未过期。

**关于 ref/参考实现 CLI 目录/参考实现 CLI**：参照二进制存在且可运行（`bsk 0.5.0`），但它是 windows-x64 构建；生成器默认**不执行**它（否则产物会随宿主平台漂移），只读已提交快照 + 源码。这样本报告在 Linux/macOS/Windows 上都能逐字节复现。

**关于证据缺失**：真实（上游 侧或我方侧）文件/行号解析不到的格子不会写成 equal，只会写成 `unknown` 并在「差距」列说明缺哪一侧的什么证据；生成期锚点未命中会直接报错退出。

### 最关键的 P0 差距（前 10 条）

排序口径：P0 行按轴轮转（cli → rpc → mcp → feature → extension → error，每轴取当前最严重的一条），轴内按「状态严重度（missing > partial > unknown）、缺口规模、行 id 字典序」排序。这样前 10 条不会被行数最多的轴独占，也不会引入隐藏的人工排序。完整 P0 清单见 `matrix.json` 根对象的 `p0` 数组。

| # | 轴 | 名称 | 状态 | 差距 |
| --- | --- | --- | --- | --- |

## 优先级规则

- P0：BSK 有能力而我方 missing；或 partial 且关键输入字段/参数/选项缺失（动作主链路不能用）。
- P1：两侧都有但缺口明确（floor 不同、粒度不同、原因维度丢失、unknown 的关键轴）。
- P2：equal / extra / 仅文档或表现层差异。

## ① CLI 命令（上游 56 子命令 ↔ 我方 CLI 动词）

比对口径：命令存在性 + 命令级 flag 契约（`cli/lib/command-specs.mjs`，缺声明时退回 CLI 全局 flag 全集）+ 位置参数契约 + 子命令面。参数名覆盖率在每行「差距」里给出具体未覆盖项。

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| open ↔ open | partial | `cli/bridge.mjs:1987`<br>`cli/lib/command-specs.mjs:884` | `tools/bsk-diff/data/bsk-exe-help/open.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/open.txt:9` | 位置参数不一致：BSK 1 必选 / 0 可选，我方 0 必选 / 1 可选 | P1 |
| sync ↔ sync | partial | `cli/bridge.mjs:1992` | `tools/bsk-diff/data/bsk-exe-help/sync.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/sync.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（14/14 命中） | P1 |
| close ↔ close | partial | `cli/bridge.mjs:1993` | `tools/bsk-diff/data/bsk-exe-help/close.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/close.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（7/7 命中） | P1 |
| ledger ↔ ledger | partial | `cli/bridge.mjs:1994` | `tools/bsk-diff/data/bsk-exe-help/ledger.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/ledger.txt:11`<br>`tools/bsk-diff/data/bsk-exe-help/ledger.txt:6` | BSK 子命令（status resolve）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| dialog ↔ dialog | partial | `cli/bridge.mjs:1888` | `tools/bsk-diff/data/bsk-exe-help/dialog.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/dialog.txt:12`<br>`tools/bsk-diff/data/bsk-exe-help/dialog.txt:6` | BSK 子命令（status accept dismiss）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| operation ↔ operation | partial | `cli/bridge.mjs:1894` | `tools/bsk-diff/data/bsk-exe-help/operation.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/operation.txt:11`<br>`tools/bsk-diff/data/bsk-exe-help/operation.txt:6` | BSK 子命令（await cancel）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| cooperate ↔ cooperate | partial | `cli/bridge.mjs:1896` | `tools/bsk-diff/data/bsk-exe-help/cooperate.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/cooperate.txt:12` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（15/15 命中） | P1 |
| step ↔ step | partial | `cli/bridge.mjs:1924`<br>`cli/lib/command-specs.mjs:750` | `tools/bsk-diff/data/bsk-exe-help/step.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/step.txt:6` | 位置参数不一致：BSK 0 必选 / 0 可选，我方 0 必选 / 2 可选 | P1 |
| plan ↔ plan | equal | `cli/bridge.mjs:1920`<br>`cli/lib/command-specs.mjs:629` | `tools/bsk-diff/data/bsk-exe-help/plan.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/plan.txt:6` | 可核对面一致（参数 14/14 覆盖、无子命令面、位置参数一致）；行为等价未做 E2E 验证。补充：两侧都有 plan，但 BSK plan 接收已决动作列表并在首个失败处停止；我方 plan 为 steps JSON + 依赖/重试语义，参数面不同。 | P2 |
| recipe ↔ recipe | equal | `cli/bridge.mjs:1932`<br>`cli/lib/command-specs.mjs:768` | `tools/bsk-diff/data/bsk-exe-help/recipe.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/recipe.txt:16`<br>`tools/bsk-diff/data/bsk-exe-help/recipe.txt:6` | 可核对面一致（参数 4/4 覆盖、子命令 7/7 覆盖、位置参数不适用）；行为等价未做 E2E 验证。补充：两侧都有 recipe；BSK 子命令 list/show/run/draft/save/rm + 审批门，我方另有 approve 子命令。 | P2 |
| view ↔ view | partial | `cli/bridge.mjs:1926`<br>`cli/lib/command-specs.mjs:759` | `tools/bsk-diff/data/bsk-exe-help/view.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/view.txt:9` | 位置参数不一致：BSK 1 必选 / 0 可选，我方 0 必选 / 1 可选 | P1 |
| daemon ↔ daemon | partial | `cli/bridge.mjs:1844` | `tools/bsk-diff/data/bsk-exe-help/daemon.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/daemon.txt:17`<br>`tools/bsk-diff/data/bsk-exe-help/daemon.txt:6` | BSK 子命令（start stop restart pair devices revoke rotate trust-local）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| status ↔ status | partial | `cli/bridge.mjs:1824` | `tools/bsk-diff/data/bsk-exe-help/status.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/status.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| doctor ↔ doctor | partial | `cli/bridge.mjs:1834` | `tools/bsk-diff/data/bsk-exe-help/doctor.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/doctor.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| install-skill ↔ install-skill | partial | `cli/bridge.mjs:1936` | `tools/bsk-diff/data/bsk-exe-help/install-skill.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/install-skill.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（11/11 命中） | P1 |
| update ↔ update | partial | `cli/bridge.mjs:1854` | `tools/bsk-diff/data/bsk-exe-help/update.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/update.txt:6` | BSK 参数未覆盖：--no-restart-daemon；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（6/7 命中） | P1 |
| logs ↔ logs | partial | `cli/bridge.mjs:1850` | `tools/bsk-diff/data/bsk-exe-help/logs.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/logs.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（6/6 命中） | P1 |
| mcp ↔ mcp | partial | `cli/bridge.mjs:1862` | `tools/bsk-diff/data/bsk-exe-help/mcp.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/mcp.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| session ↔ session | equal | `cli/bridge.mjs:1864`<br>`cli/lib/command-specs.mjs:153` | `tools/bsk-diff/data/bsk-exe-help/session.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/session.txt:13`<br>`tools/bsk-diff/data/bsk-exe-help/session.txt:6` | 可核对面一致（参数 4/4 覆盖、子命令 4/4 覆盖、位置参数不适用）；行为等价未做 E2E 验证。 | P2 |
| browsers ↔ browsers | partial | `cli/bridge.mjs:1832` | `tools/bsk-diff/data/bsk-exe-help/browsers.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/browsers.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| tab ↔ tab | equal | `cli/bridge.mjs:1866`<br>`cli/lib/command-specs.mjs:425` | `tools/bsk-diff/data/bsk-exe-help/tab.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/tab.txt:15`<br>`tools/bsk-diff/data/bsk-exe-help/tab.txt:6` | 可核对面一致（参数 4/4 覆盖、子命令 6/6 覆盖、位置参数不适用）；行为等价未做 E2E 验证。 | P2 |
| window ↔ window | partial | `cli/bridge.mjs:1868` | `tools/bsk-diff/data/bsk-exe-help/window.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/window.txt:10`<br>`tools/bsk-diff/data/bsk-exe-help/window.txt:6` | BSK 子命令（resize）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| emulate ↔ emulate | partial | `cli/bridge.mjs:1918` | `tools/bsk-diff/data/bsk-exe-help/emulate.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/emulate.txt:6` | BSK 参数未覆盖：--no-mobile --max-touch-points --off；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（16/19 命中） | P1 |
| screenshot ↔ screenshot | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/screenshot.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/screenshot.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（11/11 命中） | P1 |
| snapshot ↔ snapshot | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/snapshot.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/snapshot.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/9 命中） | P1 |
| observe ↔ observe | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/observe.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/observe.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| console ↔ console | partial | `cli/commands/page.mjs:21` | `tools/bsk-diff/data/bsk-exe-help/console.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/console.txt:6` | BSK 参数未覆盖：--max-text-chars；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（10/11 命中） | P1 |
| network ↔ network | partial | `cli/bridge.mjs:1890` | `tools/bsk-diff/data/bsk-exe-help/network.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/network.txt:6` | BSK 参数未覆盖：--max-text-chars；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/10 命中） | P1 |
| debug ↔ debug | partial | `cli/bridge.mjs:1892`<br>`cli/lib/command-specs.mjs:1653` | `tools/bsk-diff/data/bsk-exe-help/debug.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/debug.txt:10` | BSK 参数未覆盖：--run-id --replay --replay-file | P1 |
| get-html ↔ get-html | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/get-html.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/get-html.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（10/10 命中） | P1 |
| read ↔ read | partial | `cli/bridge.mjs:1870` | `tools/bsk-diff/data/bsk-exe-help/read.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/read.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（13/13 命中） | P1 |
| extract ↔ extract | equal | `cli/bridge.mjs:1872`<br>`cli/lib/command-specs.mjs:986` | `tools/bsk-diff/data/bsk-exe-help/extract.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/extract.txt:9` | 可核对面一致（参数 21/21 覆盖、无子命令面、位置参数不适用）；行为等价未做 E2E 验证。 | P2 |
| navigate ↔ navigate | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/navigate.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/navigate.txt:15`<br>`tools/bsk-diff/data/bsk-exe-help/navigate.txt:7` | 我方把 BSK 的子命令实现为顶层命令（back forward），命令级子命令契约缺失；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/9 命中） | P1 |
| navigate-back ↔ navigate-back | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/navigate-back.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/navigate-back.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/9 命中） | P1 |
| navigate-forward ↔ navigate-forward | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/navigate-forward.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/navigate-forward.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/9 命中） | P1 |
| reload ↔ reload | partial | `cli/commands/page.mjs:18` | `tools/bsk-diff/data/bsk-exe-help/reload.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/reload.txt:6` | BSK 参数未覆盖：--hard；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（9/10 命中） | P1 |
| click ↔ click | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/click.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/click.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（16/16 命中） | P1 |
| hover ↔ hover | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/hover.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/hover.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| wheel ↔ wheel | partial | `cli/bridge.mjs:1876` | `tools/bsk-diff/data/bsk-exe-help/wheel.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/wheel.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（13/13 命中） | P1 |
| drag ↔ drag | partial | `cli/bridge.mjs:1874` | `tools/bsk-diff/data/bsk-exe-help/drag.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/drag.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（21/21 命中） | P1 |
| scroll-to ↔ scroll-to | partial | `cli/commands/page.mjs:20` | `tools/bsk-diff/data/bsk-exe-help/scroll-to.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/scroll-to.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（10/10 命中） | P1 |
| focus ↔ focus | partial | `cli/commands/page.mjs:20` | `tools/bsk-diff/data/bsk-exe-help/focus.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/focus.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（10/10 命中） | P1 |
| blur ↔ blur | partial | `cli/bridge.mjs:1878` | `tools/bsk-diff/data/bsk-exe-help/blur.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/blur.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（10/10 命中） | P1 |
| fill ↔ fill | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/fill.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/fill.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| press ↔ press | partial | `cli/commands/page.mjs:19` | `tools/bsk-diff/data/bsk-exe-help/press.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/press.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| select ↔ select | partial | `cli/commands/page.mjs:20` | `tools/bsk-diff/data/bsk-exe-help/select.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/select.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（11/11 命中） | P1 |
| upload ↔ upload | partial | `cli/bridge.mjs:1880` | `tools/bsk-diff/data/bsk-exe-help/upload.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/upload.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| download ↔ download | partial | `cli/bridge.mjs:1884` | `tools/bsk-diff/data/bsk-exe-help/download.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/download.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（12/12 命中） | P1 |
| evaluate ↔ evaluate | partial | `cli/commands/page.mjs:20` | `tools/bsk-diff/data/bsk-exe-help/evaluate.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/evaluate.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（11/11 命中） | P1 |
| wait-for-navigation ↔ wait-for-navigation | equal | `cli/commands/page.mjs:21`<br>`cli/lib/command-specs.mjs:1153` | `tools/bsk-diff/data/bsk-exe-help/wait-for-navigation.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/wait-for-navigation.txt:6` | 可核对面一致（参数 9/9 覆盖、无子命令面、位置参数一致）；行为等价未做 E2E 验证。 | P2 |
| wait-for-element ↔ wait-for-element | partial | `cli/commands/page.mjs:21`<br>`cli/lib/command-specs.mjs:1114` | `tools/bsk-diff/data/bsk-exe-help/wait-for-element.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/wait-for-element.txt:9` | BSK 参数未覆盖：--poll-ms | P1 |
| wait-ms ↔ wait-ms | partial | `cli/commands/page.mjs:21` | `tools/bsk-diff/data/bsk-exe-help/wait-ms.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/wait-ms.txt:9` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（4/4 命中） | P1 |
| request-help ↔ request-help | partial | `cli/bridge.mjs:1928` | `tools/bsk-diff/data/bsk-exe-help/request-help.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/request-help.txt:6` | BSK 参数未覆盖：--completion-criteria；命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（11/12 命中） | P1 |
| record ↔ record | equal | `cli/bridge.mjs:1902`<br>`cli/lib/command-specs.mjs:1466` | `tools/bsk-diff/data/bsk-exe-help/record.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/record.txt:11`<br>`tools/bsk-diff/data/bsk-exe-help/record.txt:6` | 可核对面一致（参数 4/4 覆盖、子命令 2/2 覆盖、位置参数不适用）；行为等价未做 E2E 验证。补充：两侧都是 record 子命令组：BSK 只有 start/stop，我方 start/stop/status/list/export。BSK 的 record start 会阻塞到浏览器侧结束（配合 tool.record_await），我方是 overlay 录制 + 状态轮询；导出语义（trace.json 教材）也未逐字段比对。 | P2 |
| video ↔ video | equal | `cli/bridge.mjs:1900`<br>`cli/lib/command-specs.mjs:1227` | `tools/bsk-diff/data/bsk-exe-help/video.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/video.txt:15`<br>`tools/bsk-diff/data/bsk-exe-help/video.txt:6` | 可核对面一致（参数 4/4 覆盖、子命令 6/6 覆盖、位置参数不适用）；行为等价未做 E2E 验证。补充：两侧都是 video 子命令组：BSK start/status/stop/save/list/discard，我方在同一组之外多出 verify/durability/prune/recover/info/merge/split/trim 八个子命令（BSK 0.5.0 无对应，属于我方 extra 能力）。 | P2 |
| help ↔ help | partial | `cli/bridge.mjs:1846` | `tools/bsk-diff/data/bsk-exe-help/help.txt:3`<br>`tools/bsk-diff/data/bsk-exe-help/help.txt:64`<br>`tools/bsk-diff/data/bsk-exe-help/help.txt:6` | 命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（6/6 命中） | P1 |
| actionable | extra | `cli/commands/page.mjs:21` | —（无） | 动作可用性探测（actionable RPC），BSK 无独立命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| agent | extra | `cli/bridge.mjs:1828` | —（无） | agent brief：面向 agent 的页面简报；BSK 用 cooperate sync / observe 直接给 VOM。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| audit | extra | `cli/bridge.mjs:1934` | —（无） | 本地审计日志 list/export/prune/clear；BSK 只有 audit.request RPC + --json。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| back | extra | `cli/commands/page.mjs:18` | —（无） | navigate-back 的别名（能力已被 navigate-back 覆盖）。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| cancel | extra | `cli/bridge.mjs:1830` | —（无） | 按 commandId 取消进行中的命令；BSK 用通用 cancel RPC（rpc_id）。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| click-backend | extra | `cli/commands/page.mjs:19` | —（无） | 按 backendNodeId 点击（closed shadow 场景），BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| diagnose | extra | `cli/bridge.mjs:1826` | —（无） | 只报告页面自动化痕迹（webdriver/扩展 DOM/CDP），BSK 无对应命令（doctor 是环境自检）。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| exec | extra | `cli/bridge.mjs:1858` | —（无） | 在页面里执行 QuickJS/exec 编排，BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| forward | extra | `cli/commands/page.mjs:18` | —（无） | navigate-forward 的别名（能力已被 navigate-forward 覆盖）。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| longshot | extra | `cli/bridge.mjs:1912` | —（无） | 长截图恢复（longshot recover）；BSK 由 screenshot_full_page 方法覆盖，无独立命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| mcp-install | extra | `cli/bridge.mjs:1860` | —（无） | 把 MCP server 写进各客户端配置；BSK 由 install-skill --mcp / bsk mcp 覆盖部分。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| pair | extra | `cli/bridge.mjs:1898` | —（无） | 配对凭证管理（pair.create/list/redeem...）；BSK 用 daemon pair / local_auth.* 混合实现。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| pdf | extra | `cli/commands/page.mjs:18` | —（无） | PDP 导出（printPdf），BSK 0.5.0 无 PDF 能力。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| refs | extra | `cli/bridge.mjs:1908` | —（无） | refs negotiate：跨帧 ref 协商；BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| replay | extra | `cli/bridge.mjs:1922` | —（无） | 我方 CLI 独有动词。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| schema | extra | `cli/bridge.mjs:1916` | —（无） | schema 列表/校验（本地 JSON schema 工具），BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| settings | extra | `cli/bridge.mjs:1836` | —（无） | 扩展设置读写；BSK 用 popup/options 页面，CLI 无 settings 命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| trace | extra | `cli/bridge.mjs:1904` | —（无） | trace start/stop/summary/diff/view；BSK 未暴露 trace 命令（record 面向教学文本）。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| ui | extra | `cli/bridge.mjs:1840` | —（无） | 在浏览器里打开扩展页面（popup/options/debug/...）；BSK 用浏览器工具栏点击。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| visual-click | extra | `cli/commands/page.mjs:22` | —（无） | 视觉坐标点击（截图→派发→命中校验）；BSK 用 click --capture/--image-x。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| visual-drag | extra | `cli/commands/page.mjs:22` | —（无） | 视觉坐标拖拽；BSK drag 只有元素/相对偏移。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| visual-gesture | extra | `cli/commands/page.mjs:22` | —（无） | 多段手势（点选序列/多把手）；BSK 无手势命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| visuals | extra | `cli/commands/page.mjs:22` | —（无） | 列出视觉候选（canvas/图片/自绘区域）；BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |
| webmcp | extra | `cli/bridge.mjs:1856` | —（无） | WebMCP list/call（页面内 MCP）；BSK 无对应命令。（本轴 extra：BSK 0.5.0 没有同名命令） | P2 |

## ② RPC 方法（上游 77 方法 ↔ 我方 165 方法）

比对口径：方法名归一化配对（含显式映射）+ **参数结构体字段集合**（上游 `pub struct *Params` 的 serde 字段 vs 我方 `lib/schemas.mjs` 的 properties）。字段集合完全一致才判 equal；任一侧没有可机械比对的字段就判 unknown。

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| tool.cooperate ↔ cooperate.sync | partial | `lib/method-catalog.mjs:125` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:104`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/cooperate.rs:15` | 我方缺 3 个 BSK 字段：control_policy action max_tokens；我方多 4 个字段：context_lines match_text policy probe_hover；BSK 一个 tool.cooperate 承载 sync/wait/handback；我方拆成 cooperate.sync/wait/handback/hold。 | P1 |
| local_auth.pair ↔ local.pair | equal | `lib/method-catalog.mjs:88` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:105`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:12` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；配对入口命名不同；BSK 提供 devices/revoke/rotate/set_mode 四个方法，我方分别对应 pair.list/pair.revoke/pair.renew/local.trust。 | P2 |
| local_auth.devices ↔ pair.list | unknown | `lib/method-catalog.mjs:84` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:106` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。；语义近似（设备/配对清单）。 | P1 |
| local_auth.revoke ↔ pair.revoke | partial | `lib/method-catalog.mjs:86` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:107`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:17` | 我方缺 1 个 BSK 字段：all；我方多 1 个字段：code；语义近似。 | P1 |
| local_auth.rotate ↔ pair.renew | equal | `lib/method-catalog.mjs:87` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:108`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:24` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；语义近似（rotate ↔ renew）。 | P2 |
| local_auth.set_mode ↔ local.trust | unknown | `lib/method-catalog.mjs:89` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:109`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:29` | 两侧参数字段零交集（BSK: mode；我方: strict），无法确认是同一能力，映射本身需要人工复核。；语义近似（本机信任模式）。 | P1 |
| audit.request ↔ audit.list | partial | `lib/method-catalog.mjs:90` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:110`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ws.rs:610` | 我方缺 4 个 BSK 字段：action id offset enabled；我方多 1 个字段：since；BSK 单一 audit.request 带 action；我方只有 audit.list（其余审计操作在 CLI 本地）。 | P1 |
| ledger.request ↔ ledger.resolve | partial | `lib/compat-rpc.mjs:17` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:111` | 账本通用入口 { action: status\|resolve }：复用 IntentLedger 与 ledger-report。 | P1 |
| system.handshake ↔ daemon-local | partial | `lib/compat-rpc.mjs:29` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:112` | 握手兼容：daemon 本地返回 { protocol, version }，用于旧客户端探测。 | P1 |
| system.ping ↔ daemon-local | partial | `lib/compat-rpc.mjs:23` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:113` | 连接健康检查：daemon 本地应答 { pong, protocol, ts }，不触达扩展。 | P1 |
| system.status ↔ status | unknown | `lib/method-catalog.mjs:80` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:114`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/system.rs:565` | 两侧参数字段零交集（BSK: wait_for_browser_ms；我方: doctor/limit/limit_sessions/strategy/view/views），无法确认是同一能力，映射本身需要人工复核。；BSK system.status ↔ 我方 status。 | P1 |
| session.start ↔ session.start | partial | `lib/method-catalog.mjs:61` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:115`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1395` | 我方缺 4 个 BSK 字段：browser_instance_id width height focused；我方多 11 个字段：allow_domains browser control_mode deny_domains focus min_interval_ms no_focus request_id scope share tab | P1 |
| session.start_tracked ↔ session.start_tracked | partial | `lib/method-catalog.mjs:62` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:116`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:136` | 我方缺 4 个 BSK 字段：browser_instance_id width height focused；我方多 10 个字段：allow_domains browser control_mode deny_domains focus min_interval_ms no_focus scope share tab | P1 |
| session.request ↔ session.request_prepare | partial | `lib/method-catalog.mjs:63` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:117`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:245` | 我方缺 1 个 BSK 字段：action；我方多 5 个字段：browser focus incognito no_focus tab；BSK 单一 session.request 带 action；我方拆成 4 个方法（粒度更细）。 | P1 |
| session.request ↔ session.request_claim | partial | `lib/method-catalog.mjs:64` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:117`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:245` | 我方缺 1 个 BSK 字段：action；BSK 单一 session.request 带 action；我方拆成 4 个方法（粒度更细）。 | P1 |
| session.request ↔ session.request_cancel | partial | `lib/method-catalog.mjs:65` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:117`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:245` | 我方缺 1 个 BSK 字段：action；BSK 单一 session.request 带 action；我方拆成 4 个方法（粒度更细）。 | P1 |
| session.request ↔ session.request_status | partial | `lib/method-catalog.mjs:66` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:117`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:245` | 我方缺 1 个 BSK 字段：action；BSK 单一 session.request 带 action；我方拆成 4 个方法（粒度更细）。 | P1 |
| session.stop ↔ session.stop | unknown | `lib/method-catalog.mjs:67` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:118`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1421` | 两侧参数字段零交集（BSK: session_id/all/recording；我方: keep），无法确认是同一能力，映射本身需要人工复核。 | P1 |
| session.stop_all ↔ session.stop_all | partial | `lib/method-catalog.mjs:68` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:119`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:346` | 我方多 1 个字段：keep | P1 |
| session.list ↔ session.list | unknown | `lib/method-catalog.mjs:70` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:120`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:350` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。 | P1 |
| session.run_log ↔ session.run_log | unknown | `lib/method-catalog.mjs:69` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:121`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:285` | 两侧参数字段零交集（BSK: session_id；我方: limit），无法确认是同一能力，映射本身需要人工复核。 | P1 |
| browser.list ↔ browsers | unknown | `lib/method-catalog.mjs:79` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:122`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/system.rs:575` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。；BSK browser.list ↔ 我方 browsers（名称不同，参数都是空的）。 | P1 |
| tool.session_start ↔ session.start | partial | `lib/method-catalog.mjs:61` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:123`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/session.rs:47` | 我方缺 5 个 BSK 字段：browser_instance_id width height focused unattended；我方多 11 个字段：allow_domains browser control_mode deny_domains focus min_interval_ms no_focus request_id scope share tab；BSK 走扩展方法 tool.session_start，我方 session.start 由 daemon 处理（owner 不同）。 | P1 |
| tool.session_stop ↔ session.stop | partial | `lib/method-catalog.mjs:67` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:124`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/session.rs:126` | 我方多 1 个字段：keep；BSK 是扩展方法 tool.session_stop；我方 session.stop 由 daemon 处理（owner 不同）。 | P1 |
| tool.window_resize ↔ window.resize | equal | `lib/method-catalog.mjs:182` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:125`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/window.rs:9` | 参数集合完全一致（2 个字段）。语义等价未做行为级验证。；命名空间命名差异。 | P2 |
| tool.emulate ↔ emulate | unknown | `lib/method-catalog.mjs:146` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:126`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/emulate.rs:84` | 两侧参数字段零交集（BSK: off/overrides；我方: accept_language/device/dpr/geolocation/height/locale/mobile/platform/reset/timezone/touch/ua/user_agent/viewport/width），无法确认是同一能力，映射本身需要人工复核。 | P1 |
| tool.tab_list ↔ tab.list | equal | `lib/method-catalog.mjs:169` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:127`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:46` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；命名空间命名差异（tool.tab_* ↔ tab.*）。 | P2 |
| tool.tab_create ↔ tab.new | partial | `lib/method-catalog.mjs:170` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:128`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:65` | 我方缺 2 个 BSK 字段：active index；我方多 7 个字段：allowed_origins focus incognito new_window no_focus read_only window_id；create ↔ new。 | P1 |
| tool.tab_close ↔ tab.close | partial | `lib/method-catalog.mjs:174` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:129`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:94` | 我方多 1 个字段：timeout_ms；命名空间命名差异。 | P1 |
| tool.tab_borrow ↔ tab.borrow | partial | `lib/method-catalog.mjs:177` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:130`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:139` | 我方缺 1 个 BSK 字段：confirm；命名空间命名差异。 | P1 |
| tool.tab_return ↔ tab.return | partial | `lib/method-catalog.mjs:178` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:131`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:163` | 我方多 1 个字段：timeout_ms；命名空间命名差异。 | P1 |
| tool.tab_select ↔ tab.select | partial | `lib/method-catalog.mjs:175` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:132`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs:109` | 我方多 1 个字段：timeout_ms；命名空间命名差异。 | P1 |
| tool.navigate ↔ navigate | partial | `lib/method-catalog.mjs:127`<br>`lib/schemas.mjs:100` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:133`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/navigation.rs:38` | 我方缺 2 个 BSK 字段：wait_until timeout_ms | P1 |
| tool.navigate_back ↔ navigate-back | partial | `lib/method-catalog.mjs:129` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:134`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/navigation.rs:80` | 我方缺 1 个 BSK 字段：wait_until | P1 |
| tool.navigate_forward ↔ navigate-forward | partial | `lib/method-catalog.mjs:130` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:135`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/navigation.rs:106` | 我方缺 1 个 BSK 字段：wait_until | P1 |
| tool.reload ↔ reload | partial | `lib/method-catalog.mjs:128` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:136`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/navigation.rs:136` | 我方缺 2 个 BSK 字段：wait_until hard | P1 |
| tool.click ↔ click | partial | `lib/method-catalog.mjs:131`<br>`lib/schemas.mjs:146` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:137`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:42` | 我方缺 5 个 BSK 字段：capture_id image_x image_y modifiers timeout_ms；我方多 5 个字段：force stable_ref text trusted wait_timeout_ms | P1 |
| tool.hover ↔ hover | partial | `lib/method-catalog.mjs:126`<br>`lib/schemas.mjs:170` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:138`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:100` | 我方缺 3 个 BSK 字段：modifiers settle_ms timeout_ms；我方多 4 个字段：force stable_ref trusted wait_timeout_ms | P1 |
| tool.drag ↔ drag | partial | `lib/method-catalog.mjs:140`<br>`lib/schemas.mjs:282` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:139`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/drag.rs:38` | 我方多 7 个字段：capture image_dx image_dy image_x image_y steps wait_timeout_ms | P1 |
| tool.wheel ↔ wheel | equal | `lib/method-catalog.mjs:139`<br>`lib/schemas.mjs:252` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:140`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/wheel.rs:9` | 参数集合完全一致（6 个字段）。语义等价未做行为级验证。 | P2 |
| tool.scroll_to ↔ scroll-to | partial | `lib/method-catalog.mjs:138` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:141`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/scroll.rs:9` | 我方缺 1 个 BSK 字段：timeout_ms；我方多 2 个字段：expect_revision stable_ref；下划线→连字符。 | P1 |
| tool.focus ↔ focus | partial | `lib/method-catalog.mjs:136` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:142`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:146` | 我方缺 1 个 BSK 字段：timeout_ms；我方多 2 个字段：expect_revision stable_ref | P1 |
| tool.blur ↔ blur | partial | `lib/method-catalog.mjs:137` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:143`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:181` | 我方缺 1 个 BSK 字段：timeout_ms；我方多 2 个字段：expect_revision stable_ref | P1 |
| tool.fill ↔ fill | partial | `lib/method-catalog.mjs:133`<br>`lib/schemas.mjs:181` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:144`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:222` | 我方缺 2 个 BSK 字段：clear_before timeout_ms；我方多 5 个字段：force no_clear stable_ref trusted wait_timeout_ms | P1 |
| tool.press ↔ press | partial | `lib/method-catalog.mjs:134`<br>`lib/schemas.mjs:195` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:145`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:273` | 我方缺 3 个 BSK 字段：modifiers hold_ms timeout_ms；我方多 4 个字段：force stable_ref trusted wait_timeout_ms | P1 |
| tool.select ↔ select | partial | `lib/method-catalog.mjs:135`<br>`lib/schemas.mjs:208` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:146`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/interaction.rs:319` | 我方缺 2 个 BSK 字段：values timeout_ms；我方多 3 个字段：stable_ref value wait_timeout_ms | P1 |
| tool.upload ↔ upload | partial | `lib/method-catalog.mjs:141`<br>`lib/schemas.mjs:498` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:147`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/file_transfer.rs:33` | 我方多 3 个字段：expect_revision paths stable_ref | P1 |
| tool.download ↔ download | partial | `lib/method-catalog.mjs:142` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:148`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/file_transfer.rs:64` | 我方缺 3 个 BSK 字段：timeout_ms browser_relative_dir max_byte_size；我方多 4 个字段：expect_revision out stable_ref url | P1 |
| tool.snapshot ↔ snapshot | unknown | `lib/method-catalog.mjs:107` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:149`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:16` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。 | P1 |
| tool.observe ↔ observe | partial | `lib/method-catalog.mjs:105`<br>`lib/schemas.mjs:46` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:150`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:68` | 我方多 29 个字段：ax baseline closed_shadow compare_ax deep_max_tokens delta facts fallback_ax force pipeline vom vom_billing_model vom_deep vom_exclude_hidden vom_explain vom_group_context vom_group_tokens vom_max_nodes vom_max_tokens vom_min_score vom_per_group vom_profile vom_rank vom_semantic_max_groups vom_semantic_max_tokens vom_semantic_min_score vom_top vom_tree vom_weights；同名语义；我方 observe 参数超集。 | P1 |
| tool.get_html ↔ get-html | partial | `lib/method-catalog.mjs:108` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:151`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:174` | 我方缺 1 个 BSK 字段：max_bytes；我方多 3 个字段：expect_revision selector stable_ref；下划线→连字符。 | P1 |
| tool.read ↔ read | partial | `lib/method-catalog.mjs:109`<br>`lib/schemas.mjs:219` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:152`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/read.rs:37` | 我方多 3 个字段：all fields_json stable_ref | P1 |
| tool.extract ↔ extract | partial | `lib/method-catalog.mjs:111`<br>`lib/schemas.mjs:411` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:153`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/extract.rs:35` | 我方多 2 个字段：cursor max_cells | P1 |
| tool.screenshot ↔ screenshot | partial | `lib/method-catalog.mjs:118`<br>`lib/schemas.mjs:529` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:154`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:218` | 我方多 15 个字段：annotate format full_page grid grid_step profile region scale scope segmented selector stale_attempts stream tile_size visual_index | P1 |
| tool.screenshot_full_page ↔ screenshot | partial | `lib/method-catalog.mjs:118`<br>`lib/schemas.mjs:529` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:155`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:268` | 我方缺 1 个 BSK 字段：timeout_ms；我方多 15 个字段：annotate format full_page grid grid_step profile ref region scale segmented selector stale_attempts stream tile_size visual_index；BSK 整页截图是独立方法（TransientInput + ActionConditions）；我方用 screenshot(scope=document/stream) + longshot.recover 恢复语义覆盖，无独立方法。 | P1 |
| tool.screenshot_full_page ↔ longshot.recover | partial | `lib/method-catalog.mjs:156` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:155`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:268` | 我方多 2 个字段：capture_id longshot_id；BSK 整页截图是独立方法（TransientInput + ActionConditions）；我方用 screenshot(scope=document/stream) + longshot.recover 恢复语义覆盖，无独立方法。 | P1 |
| tool.screenshot_read ↔ screenshot.read | partial | `lib/method-catalog.mjs:119` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:156`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:296` | 我方多 1 个字段：length；同名语义。 | P1 |
| tool.screenshot_release ↔ screenshot.release | equal | `lib/method-catalog.mjs:120` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:157`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/observation.rs:312` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；同名语义。 | P2 |
| tool.console ↔ console | equal | `lib/method-catalog.mjs:115`<br>`lib/schemas.mjs:88` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:158`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/console.rs:7` | 参数集合完全一致（4 个字段）。语义等价未做行为级验证。 | P2 |
| tool.debug ↔ debug.start | partial | `lib/method-catalog.mjs:149` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:159`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/debug.rs:59` | 我方多 1 个字段：bodies；BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。 | P1 |
| tool.debug ↔ debug.stop | unknown | `lib/method-catalog.mjs:150` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:159`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/debug.rs:59` | 两侧参数字段零交集（BSK: action/run_id/id/name/since/limit/part/offset/max_chars/pointer/rule/replay/budget/slow_ms/window_ms/include_controlled/url/method/resource_type/status/state/kind/fields/wait_ms/command_id；我方: trace/trace_origin），无法确认是同一能力，映射本身需要人工复核。；BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。 | P1 |
| tool.debug ↔ debug.current | unknown | `lib/method-catalog.mjs:121` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:159`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/debug.rs:59` | 两侧参数字段零交集（BSK: action/run_id/id/name/since/limit/part/offset/max_chars/pointer/rule/replay/budget/slow_ms/window_ms/include_controlled/url/method/resource_type/status/state/kind/fields/wait_ms/command_id；我方: trace），无法确认是同一能力，映射本身需要人工复核。；BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。 | P1 |
| tool.debug ↔ debug.request | equal | `lib/method-catalog.mjs:122` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:159`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/debug.rs:59` | 参数集合完全一致（25 个字段）。语义等价未做行为级验证。；BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。 | P2 |
| tool.debug ↔ debug.history | unknown | `lib/method-catalog.mjs:97` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:159`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/debug.rs:59` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。；BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。 | P1 |
| tool.network ↔ network.list | partial | `lib/method-catalog.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 我方缺 1 个 BSK 字段：max_text_chars；我方多 1 个字段：filter；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.network ↔ network.detail | unknown | `lib/method-catalog.mjs:117` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 两侧参数字段零交集（BSK: since/limit/max_text_chars；我方: id），无法确认是同一能力，映射本身需要人工复核。；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.network ↔ network.waterfall | partial | `lib/method-catalog.mjs:193` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 我方缺 2 个 BSK 字段：since max_text_chars；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.network ↔ network.start | unknown | `lib/method-catalog.mjs:147` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 两侧参数字段零交集（BSK: since/limit/max_text_chars；我方: bodies/ws_payload_limit），无法确认是同一能力，映射本身需要人工复核。；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.network ↔ network.stop | unknown | `lib/method-catalog.mjs:148` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.network ↔ network.replay | unknown | `lib/method-catalog.mjs:192` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:160`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/network.rs:7` | 两侧参数字段零交集（BSK: since/limit/max_text_chars；我方: id/overrides/request），无法确认是同一能力，映射本身需要人工复核。；BSK tool.network 带 action；我方拆成 network.* 六个方法。 | P1 |
| tool.evaluate ↔ evaluate | partial | `lib/method-catalog.mjs:143`<br>`lib/schemas.mjs:238` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:161`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/script.rs:31` | 我方缺 1 个 BSK 字段：timeout_ms | P1 |
| tool.dialog_status ↔ dialog.status | partial | `lib/method-catalog.mjs:184` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:162`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:25` | 我方多 1 个字段：clear | P1 |
| tool.dialog_accept ↔ dialog.accept | partial | `lib/method-catalog.mjs:167` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:163`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:38` | 我方缺 1 个 BSK 字段：dialog_id | P1 |
| tool.dialog_dismiss ↔ dialog.dismiss | partial | `lib/method-catalog.mjs:168` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:164`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:38` | 字段命名不同但语义等价（dialog_id↔id）：dialog_id↔id；BSK 另带 text（仅 accept 路径语义）。 | P1 |
| tool.operation_await ↔ operation.await | partial | `lib/method-catalog.mjs:207` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:165`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:52` | 字段命名不同但语义等价（operation_id↔id、wait_ms↔timeoutMs）：operation_id↔id、wait_ms↔timeoutMs：同一“等待被挂起操作完成”的语义，仅线字段命名/单位不同。 | P1 |
| tool.operation_cancel ↔ operation.cancel | partial | `lib/method-catalog.mjs:208` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:166`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:52` | 字段命名不同但语义等价（operation_id↔id）：operation_id↔id：取消目标为同一挂起操作。 | P1 |
| tool.wait_for_navigation ↔ wait-for-navigation | equal | `lib/method-catalog.mjs:211` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:167`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/waits.rs:31` | 参数集合完全一致（2 个字段）。语义等价未做行为级验证。 | P2 |
| tool.wait_for_element ↔ wait-for-element | partial | `lib/method-catalog.mjs:210` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:168`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/waits.rs:132` | 我方缺 1 个 BSK 字段：poll_ms；我方多 2 个字段：operation_id stable_ref | P1 |
| tool.wait_ms ↔ wait-ms | partial | `lib/method-catalog.mjs:209` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:169`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/waits.rs:189` | 字段命名不同但语义等价（duration_ms↔ms）：duration_ms↔ms；我方多 command_id 归因字段。 | P1 |
| tool.request_help ↔ request-help | partial | `lib/method-catalog.mjs:161` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:170`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/human_loop.rs:31` | 我方缺 4 个 BSK 字段：prompt title targets completion_criteria；我方多 1 个字段：reason | P1 |
| tool.record_start ↔ record.start | partial | `lib/method-catalog.mjs:157` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:171`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/record.rs:27` | 我方多 2 个字段：include_agent screenshots；同名语义（下划线/点号差异）。 | P1 |
| tool.record_stop ↔ record.stop | partial | `lib/method-catalog.mjs:158` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:172`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/record.rs:54` | 我方多 1 个字段：timeout_ms；同名语义。 | P1 |
| tool.record_await ↔ record.status | equal | `lib/method-catalog.mjs:191` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:173`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/record.rs:203` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；BSK record_await 等待录制收敛；我方用 record.status 轮询，无阻塞等待方法。 | P2 |
| tool.video ↔ video.start | partial | `lib/method-catalog.mjs:159` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:174`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:13` | 我方缺 3 个 BSK 字段：session_id tab_id request_id；我方多 6 个字段：duration_ms encoder force_frames max_concurrent max_segment_bytes max_total_bytes；BSK tool.video 带 action；我方拆成 9 个 video.* 方法。 | P1 |
| tool.video ↔ video.stop | unknown | `lib/method-catalog.mjs:160` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:174`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41` | 两侧参数字段零交集（BSK: browser/recording_id/capability；我方: recording），无法确认是同一能力，映射本身需要人工复核。；BSK tool.video 带 action；我方拆成 9 个 video.* 方法。 | P1 |
| tool.video ↔ video.status | unknown | `lib/method-catalog.mjs:186` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:174`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41` | 两侧参数字段零交集（BSK: browser/recording_id/capability；我方: recording），无法确认是同一能力，映射本身需要人工复核。；BSK tool.video 带 action；我方拆成 9 个 video.* 方法。 | P1 |
| tool.video ↔ video.list | unknown | `lib/method-catalog.mjs:94` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:174`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41` | 我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。；BSK tool.video 带 action；我方拆成 9 个 video.* 方法。 | P1 |
| tool.video ↔ video.discard | unknown | `lib/method-catalog.mjs:190` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:174`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41` | 两侧参数字段零交集（BSK: browser/recording_id/capability；我方: recording），无法确认是同一能力，映射本身需要人工复核。；BSK tool.video 带 action；我方拆成 9 个 video.* 方法。 | P1 |
| transfer.begin ↔ transfer.begin | partial | `lib/method-catalog.mjs:100` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:175`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1104` | 我方缺 1 个 BSK 字段：session_id；同名。 | P1 |
| transfer.chunk ↔ transfer.chunk | equal | `lib/method-catalog.mjs:101` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:176`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1126` | 参数集合完全一致（3 个字段）。语义等价未做行为级验证。；同名。 | P2 |
| transfer.finish ↔ transfer.finish | equal | `lib/method-catalog.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:177`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1137` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；同名。 | P2 |
| transfer.read ↔ transfer.read | partial | `lib/method-catalog.mjs:103` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:178`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1148` | 我方缺 1 个 BSK 字段：data_base64；我方多 1 个字段：max_bytes；同名。 | P1 |
| transfer.release ↔ transfer.release | equal | `lib/method-catalog.mjs:104` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:179`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1159` | 参数集合完全一致（1 个字段）。语义等价未做行为级验证。；同名。 | P2 |
| cancel ↔ command.cancel | partial | `lib/compat-rpc.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/method.rs:180` | 通用取消 { rpc_id }：复用 daemon in-flight 表 + 扩展 WS cancel，非 canonical 别名。 | P1 |
| session.rebind | extra | `lib/method-catalog.mjs:71` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.pause | extra | `lib/method-catalog.mjs:72` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.resume | extra | `lib/method-catalog.mjs:73` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.control_status | extra | `lib/method-catalog.mjs:74` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.claim_control | extra | `lib/method-catalog.mjs:75` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.release_control | extra | `lib/method-catalog.mjs:76` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.handoff | extra | `lib/method-catalog.mjs:77` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| session.control_mode | extra | `lib/method-catalog.mjs:78` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| settings.get | extra | `lib/method-catalog.mjs:81` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| settings.set | extra | `lib/method-catalog.mjs:82` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| pair.create | extra | `lib/method-catalog.mjs:83` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| pair.redeem | extra | `lib/method-catalog.mjs:85` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| operations.list | extra | `lib/method-catalog.mjs:91` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| operations.get | extra | `lib/method-catalog.mjs:92` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| daemon.stop | extra | `lib/method-catalog.mjs:93` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/control_plane）。 | P2 |
| video.prune | extra | `lib/method-catalog.mjs:95` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| record.list | extra | `lib/method-catalog.mjs:96` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| debug.delete | extra | `lib/method-catalog.mjs:98` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| diagnostics.ui | extra | `lib/method-catalog.mjs:99` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/control_plane）。 | P2 |
| observe-frames | extra | `lib/method-catalog.mjs:106` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| view | extra | `lib/method-catalog.mjs:110` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（local/passive_read）。 | P2 |
| extract.discover | extra | `lib/method-catalog.mjs:112` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| extract.table | extra | `lib/method-catalog.mjs:113` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| extract.list | extra | `lib/method-catalog.mjs:114` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| debug.performance | extra | `lib/method-catalog.mjs:123` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| debug.coverage | extra | `lib/method-catalog.mjs:124` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| click-backend | extra | `lib/method-catalog.mjs:132` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| webmcp.list | extra | `lib/method-catalog.mjs:144` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/read）。 | P2 |
| webmcp.call | extra | `lib/method-catalog.mjs:145` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| trace.start | extra | `lib/method-catalog.mjs:151` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| trace.stop | extra | `lib/method-catalog.mjs:152` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| trace.status | extra | `lib/method-catalog.mjs:153` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| pdf | extra | `lib/method-catalog.mjs:154`<br>`lib/schemas.mjs:509` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| refs.negotiate | extra | `lib/method-catalog.mjs:155` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| cooperate.wait | extra | `lib/method-catalog.mjs:162` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| cooperate.handback | extra | `lib/method-catalog.mjs:163` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| cooperate.hold | extra | `lib/method-catalog.mjs:164` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| dialog.arm | extra | `lib/method-catalog.mjs:165` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| dialog.disarm | extra | `lib/method-catalog.mjs:166` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| tab.policy | extra | `lib/method-catalog.mjs:171` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| tab.alias | extra | `lib/method-catalog.mjs:172` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/control_plane）。 | P2 |
| tab.cleanup | extra | `lib/method-catalog.mjs:173` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| tab.move | extra | `lib/method-catalog.mjs:176` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| window.list | extra | `lib/method-catalog.mjs:179` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/control_plane）。 | P2 |
| window.close | extra | `lib/method-catalog.mjs:180` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| window.focus | extra | `lib/method-catalog.mjs:181` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| dialog.list | extra | `lib/method-catalog.mjs:183` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| dialog.handle | extra | `lib/method-catalog.mjs:185` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| video.fetch | extra | `lib/method-catalog.mjs:187` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| video.recover | extra | `lib/method-catalog.mjs:188` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| video.verify | extra | `lib/method-catalog.mjs:189` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/read）。 | P2 |
| debug.capabilities | extra | `lib/method-catalog.mjs:194` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| debug.pin | extra | `lib/method-catalog.mjs:195` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.pinned | extra | `lib/method-catalog.mjs:196` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| debugger.detach | extra | `lib/method-catalog.mjs:197` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| debugger.simulate-detach | extra | `lib/method-catalog.mjs:198` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| screenshot.manual.start | extra | `lib/method-catalog.mjs:199` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| screenshot.manual.frame | extra | `lib/method-catalog.mjs:200` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| screenshot.manual.save | extra | `lib/method-catalog.mjs:201` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| shadow.click | extra | `lib/method-catalog.mjs:202` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| shadow.read | extra | `lib/method-catalog.mjs:203` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| click-point | extra | `lib/method-catalog.mjs:204` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| control-hint | extra | `lib/method-catalog.mjs:205` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| ui.open | extra | `lib/method-catalog.mjs:206` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/control_plane）。 | P2 |
| actionable | extra | `lib/method-catalog.mjs:212` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| plan | extra | `lib/method-catalog.mjs:213`<br>`lib/schemas.mjs:389` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/control_plane）。 | P2 |
| step | extra | `lib/method-catalog.mjs:214` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_add | extra | `lib/method-catalog.mjs:215` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_clear | extra | `lib/method-catalog.mjs:216` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_enable | extra | `lib/method-catalog.mjs:217` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_disable | extra | `lib/method-catalog.mjs:218` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_remove | extra | `lib/method-catalog.mjs:219` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_import | extra | `lib/method-catalog.mjs:220` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| debug.rule_list | extra | `lib/method-catalog.mjs:221` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| debug.rule_export | extra | `lib/method-catalog.mjs:222` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/passive_read）。 | P2 |
| debug.fetch_probe | extra | `lib/method-catalog.mjs:223` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（session/browser_mutation）。 | P2 |
| window.ensureAgent | extra | `lib/method-catalog.mjs:224` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |
| window.newAgent | extra | `lib/method-catalog.mjs:225` | —（无） | 我方协议方法，BSK 0.5.0 的方法表里没有对应项（instance/browser_mutation）。 | P2 |

## ③ MCP 工具（我方 85 工具 + 上游 MCP 动作覆盖）

§3a 是我方 85 个工具逐个对照 上游 的 7+1 个粗粒度 MCP 工具；§3b 反向检查 上游 MCP 的 55 个动作在我方工具面上有没有直接入口（`ours: []` 表示只能经 `browser_plan` 间接触达）。

### ③a 我方 85 个 MCP 工具

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| bsk_assist:emulate ↔ browser_assist_emulate | partial | `mcp/tools-m6b.mjs:229` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1855` | 粒度不同（bsk_assist action=emulate；我方按设备/视口扁平参数换算）。 | P1 |
| bsk_assist:operation_await ↔ browser_assist_operation_await | partial | `mcp/tools-m6b.mjs:261` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1860` | 粒度不同；上游 operation_id ↔ 我方协议 id。 | P1 |
| bsk_assist:operation_cancel ↔ browser_assist_operation_cancel | partial | `mcp/tools-m6b.mjs:265` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1861` | 粒度不同；上游 operation_id ↔ 我方协议 id。 | P1 |
| bsk_assist:request_help ↔ browser_assist_request_help | partial | `mcp/tools-m6b.mjs:242` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1856` | 粒度不同；上游 prompt 必填 ↔ 我方 reason + criteria。 | P1 |
| browser_audit | extra | `mcp/tools-core-a.mjs:85` | —（无） | BSK MCP 无审计工具（审计在 CLI/协议层）。 | P2 |
| bsk_page:back ↔ browser_back | partial | `mcp/tools-input.mjs:153` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:992` | 粒度不同（bsk_page action=back）。 | P1 |
| bsk_interact:blur ↔ browser_blur | partial | `mcp/tools-input.mjs:145` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1313` | 粒度不同（bsk_interact action=blur）。 | P1 |
| bsk_session:sync ↔ browser_brief | partial | `mcp/tools-core-a.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:719` | BSK 用会话 sync 返回 VOM 文本；我方 brief 额外聚合引用/截断/对话框/下一步。 | P1 |
| bsk_interact:click ↔ browser_click | partial | `mcp/tools-core-a.mjs:290` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1304` | 粒度不同：BSK 是粗粒度 bsk_interact 的 action=click。 | P1 |
| browser_click_backend | extra | `mcp/tools-core-a.mjs:303` | —（无） | BSK MCP 无 backendNodeId 点击入口。 | P2 |
| bsk_inspect:console ↔ browser_console | partial | `mcp/tools-input.mjs:161` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1129` | 粒度不同（bsk_inspect action=console）。 | P1 |
| bsk_session:sync ↔ browser_cooperate_sync | partial | `mcp/tools-debug-b.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:719` | BSK 的协作同步与会话同步合并为一个 sync action。 | P1 |
| browser_debug_analyze | extra | `mcp/tools-debug-a.mjs:33` | —（无） | BSK MCP 未暴露 debug（其 debug 仅在 CLI/协议）。 | P2 |
| browser_debug_archive | extra | `mcp/tools-debug-a.mjs:87` | —（无） | BSK MCP 无 debug 工具：调试归档只能走 CLI（bsk debug archive）。 | P2 |
| browser_debug_archives | extra | `mcp/tools-debug-a.mjs:101` | —（无） | BSK MCP 无 debug 工具：归档清单只能走 CLI（bsk debug archives）。 | P2 |
| browser_debug_evidence | extra | `mcp/tools-debug-a.mjs:45` | —（无） | BSK MCP 无 debug 工具：证据包只能走 CLI（bsk debug evidence）。 | P2 |
| browser_debug_har | extra | `mcp/tools-debug-a.mjs:139` | —（无） | BSK MCP 无 debug 工具：HAR 导出只能走 CLI（bsk debug har）。 | P2 |
| browser_debug_har_import | extra | `mcp/tools-debug-a.mjs:148` | —（无） | BSK MCP 无 debug 工具：HAR 导入只能走 CLI（bsk debug har-import）。 | P2 |
| browser_debug_journal | extra | `mcp/tools-debug-a.mjs:61` | —（无） | BSK MCP 无 debug 工具：调试日志只能走 CLI（bsk debug journal）。 | P2 |
| browser_debug_query | extra | `mcp/tools-debug-a.mjs:72` | —（无） | BSK MCP 无 debug 工具：请求过滤查询只能走 CLI（bsk debug query）。 | P2 |
| browser_debug_start | extra | `mcp/tools-debug-a.mjs:12` | —（无） | BSK MCP 无 debug 工具：采集开关只能走 CLI（bsk debug start）。 | P2 |
| browser_debug_stop | extra | `mcp/tools-debug-a.mjs:24` | —（无） | BSK MCP 无 debug 工具：采集关停只能走 CLI（bsk debug stop）。 | P2 |
| bsk_assist:dialog_status ↔ browser_dialog | partial | `mcp/tools-debug-b.mjs:212` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1857` | BSK 把 dialog_status/accept/dismiss 与 operation_await/cancel 拆成 bsk_assist 的 5 个 action；我方合并为 browser_dialog。 | P1 |
| browser_download | extra | `mcp/tools-core-b.mjs:97` | —（无） | BSK MCP 无 download 工具（协议有 tool.download）。 | P2 |
| bsk_interact:drag ↔ browser_drag | partial | `mcp/tools-input.mjs:95` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1309` | 粒度不同（bsk_interact action=drag）。 | P1 |
| bsk_interact:evaluate ↔ browser_evaluate | partial | `mcp/tools-core-b.mjs:24` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1314` | 粒度不同（bsk_interact action=evaluate）。 | P1 |
| bsk_inspect:extract ↔ browser_extract | partial | `mcp/tools-core-b.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1131` | 粒度不同（bsk_inspect action=extract）。 | P1 |
| bsk_interact:fill ↔ browser_fill | partial | `mcp/tools-core-a.mjs:313` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1306` | 粒度不同。 | P1 |
| bsk_interact:focus ↔ browser_focus | partial | `mcp/tools-input.mjs:141` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1312` | 粒度不同（bsk_interact action=focus）。 | P1 |
| bsk_page:forward ↔ browser_forward | partial | `mcp/tools-input.mjs:157` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:993` | 粒度不同（bsk_page action=forward）。 | P1 |
| bsk_interact:hover ↔ browser_hover | partial | `mcp/tools-input.mjs:87` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1307` | 粒度不同（bsk_interact action=hover）。 | P1 |
| bsk_inspect:html ↔ browser_inspect_html | partial | `mcp/tools-m6b.mjs:225` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1127` | 粒度不同（bsk_inspect action=html）。 | P1 |
| browser_install_skill | extra | `mcp/tools-core-a.mjs:136` | —（无） | BSK MCP 无 install-skill 工具（CLI 有）。 | P2 |
| browser_longshot_recover | extra | `mcp/tools-core-b.mjs:76` | —（无） | BSK 有 screenshot_full_page，但无"分段截图恢复"工具。 | P2 |
| bsk_page:navigate ↔ browser_navigate | partial | `mcp/tools-core-a.mjs:281` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:991` | 粒度不同（bsk_page action=navigate）。 | P1 |
| bsk_inspect:network ↔ browser_network_list | partial | `mcp/tools-debug-b.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1130` | 粒度不同（bsk_inspect action=network）。 | P1 |
| browser_network_replay_har | extra | `mcp/tools-debug-a.mjs:116` | —（无） | BSK MCP 未暴露重放（协议 tool.debug 的 replay action）。 | P2 |
| browser_network_waterfall | extra | `mcp/tools-debug-a.mjs:163` | —（无） | BSK network 返回缓冲，无水瀑布图视图。 | P2 |
| bsk_inspect:observe ↔ browser_observe | partial | `mcp/tools-core-a.mjs:261` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1125` | 粒度不同（bsk_inspect action=observe）。 | P1 |
| browser_pair | extra | `mcp/tools-core-a.mjs:111` | —（无） | BSK MCP 无配对工具（CLI daemon pair / local_auth.*）。 | P2 |
| browser_pdf | extra | `mcp/tools-core-b.mjs:137` | —（无） | BSK 0.5.0 无 PDF 能力。 | P2 |
| bsk_plan ↔ browser_plan | partial | `mcp/tools-core-a.mjs:243` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:50` | BSK bsk_plan 是一次调用跑多个输入动作；我方 browser_plan 走 plan RPC（steps 数组）。 | P1 |
| bsk_interact:press ↔ browser_press | partial | `mcp/tools-input.mjs:83` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1305` | 粒度不同（bsk_interact action=press）。 | P1 |
| bsk_inspect:read ↔ browser_read | partial | `mcp/tools-core-a.mjs:327` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1124` | 粒度不同（bsk_inspect action=read）。 | P1 |
| bsk_recipe ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56` | 两侧都有 recipe 工具；BSK 需 BSK_RECIPES=1 才出现，我方常驻。 | P1 |
| browser_record_list | extra | `mcp/tools-core-a.mjs:228` | —（无） | BSK MCP 无 record 工具：录制清单只能走 CLI（bsk record / tool.record_*）。 | P2 |
| browser_record_start | extra | `mcp/tools-core-a.mjs:207` | —（无） | BSK MCP 无 record 工具：开始录制只能走 CLI（bsk record start）。 | P2 |
| browser_record_stop | extra | `mcp/tools-core-a.mjs:219` | —（无） | BSK MCP 无 record 工具：停止录制只能走 CLI（bsk record stop）。 | P2 |
| browser_refs_negotiate | extra | `mcp/tools-core-b.mjs:216` | —（无） | BSK 无 ref 协商工具。 | P2 |
| bsk_page:reload ↔ browser_reload | partial | `mcp/tools-input.mjs:149` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:994` | 粒度不同（bsk_page action=reload）。 | P1 |
| browser_rule_add | extra | `mcp/tools-debug-b.mjs:33` | —（无） | BSK 网络规则在协议 tool.debug 的 rule_* action，未暴露为 MCP 工具。 | P2 |
| browser_rule_clear | extra | `mcp/tools-debug-b.mjs:41` | —（无） | BSK MCP 无网络规则工具：清空规则只能走 CLI（bsk debug rule_clear）。 | P2 |
| browser_rule_list | extra | `mcp/tools-debug-b.mjs:27` | —（无） | BSK MCP 无网络规则工具：列规则只能走 CLI（bsk debug rule_list）。 | P2 |
| browser_rule_set | extra | `mcp/tools-debug-b.mjs:47` | —（无） | BSK MCP 无网络规则工具：规则启停只能走 CLI（bsk debug rule_enable/disable）。 | P2 |
| bsk_inspect:screenshot ↔ browser_screenshot | partial | `mcp/tools-core-b.mjs:35` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1128` | 粒度不同；我方另有 longshot/stream 参数。 | P1 |
| bsk_interact:scroll_to ↔ browser_scroll_to | partial | `mcp/tools-input.mjs:124` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1310` | 粒度不同（bsk_interact action=scroll_to）。 | P1 |
| bsk_interact:select ↔ browser_select | partial | `mcp/tools-input.mjs:91` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1308` | 粒度不同（bsk_interact action=select）。 | P1 |
| bsk_session:browsers ↔ browser_session_browsers | partial | `mcp/tools-m6b.mjs:269` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:711` | 粒度不同（bsk_session action=browsers）。 | P1 |
| bsk_session:list ↔ browser_session_list | partial | `mcp/tools-m6b.mjs:273` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:714` | 粒度不同（bsk_session action=list）。 | P1 |
| bsk_session:request_cancel ↔ browser_session_request_cancel | partial | `mcp/tools-session-tab.mjs:83` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:718` | 粒度不同（bsk_session action=request_cancel）。 | P1 |
| bsk_session:request_claim ↔ browser_session_request_claim | partial | `mcp/tools-session-tab.mjs:75` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:717` | 粒度不同（bsk_session action=request_claim）。 | P1 |
| bsk_session:request_prepare ↔ browser_session_request_prepare | partial | `mcp/tools-session-tab.mjs:41` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:715` | 粒度不同（bsk_session action=request_prepare）。 | P1 |
| bsk_session:request_status ↔ browser_session_request_status | partial | `mcp/tools-session-tab.mjs:67` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:716` | 粒度不同（bsk_session action=request_status）。 | P1 |
| bsk_session:start ↔ browser_session_start | partial | `mcp/tools-core-a.mjs:55` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:712` | 粒度不同（bsk_session action=start）。 | P1 |
| bsk_session:stop ↔ browser_session_stop | partial | `mcp/tools-core-a.mjs:74` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:713` | 粒度不同。 | P1 |
| browser_settings | extra | `mcp/tools-core-a.mjs:96` | —（无） | BSK MCP 无设置工具。 | P2 |
| bsk_session:status ↔ browser_status | partial | `mcp/tools-core-a.mjs:237` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:721` | 粒度不同（bsk_session action=status）。 | P1 |
| bsk_tabs:borrow ↔ browser_tab_borrow | partial | `mcp/tools-session-tab.mjs:91` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1756` | 粒度不同（bsk_tabs action=borrow）。 | P1 |
| bsk_tabs:close ↔ browser_tab_close | partial | `mcp/tools-core-b.mjs:194` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1755` | 粒度不同（bsk_tabs action=close）。 | P1 |
| browser_tab_move | extra | `mcp/tools-core-b.mjs:206` | —（无） | BSK tabs 无 move action。 | P2 |
| bsk_tabs:create ↔ browser_tab_new | partial | `mcp/tools-core-b.mjs:178` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1753` | create ↔ new。 | P1 |
| bsk_tabs:return ↔ browser_tab_return | partial | `mcp/tools-session-tab.mjs:103` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1757` | 粒度不同（bsk_tabs action=return）。 | P1 |
| bsk_tabs:select ↔ browser_tab_select | partial | `mcp/tools-core-b.mjs:200` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1754` | 粒度不同。 | P1 |
| bsk_tabs:list ↔ browser_tabs | partial | `mcp/tools-core-b.mjs:172` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1752` | 粒度不同（bsk_tabs action=list）。 | P1 |
| browser_trace_start | extra | `mcp/tools-core-b.mjs:230` | —（无） | BSK MCP 无 trace 工具。 | P2 |
| browser_trace_stop | extra | `mcp/tools-core-b.mjs:241` | —（无） | BSK MCP 无 trace 工具：trace 只有我方 CLI 有（BSK 没有 trace 命令）。 | P2 |
| browser_trace_summary | extra | `mcp/tools-core-b.mjs:257` | —（无） | BSK MCP 无 trace 工具：trace 摘要只有我方 CLI 有。 | P2 |
| browser_update | extra | `mcp/tools-core-a.mjs:181` | —（无） | BSK MCP 无 update 工具（CLI 有）。 | P2 |
| browser_update_state | extra | `mcp/tools-core-a.mjs:47` | —（无） | BSK MCP 无 update 工具：版本状态只能走 CLI（bsk update）。 | P2 |
| browser_upload | extra | `mcp/tools-core-b.mjs:116` | —（无） | BSK MCP 无 upload 工具（协议有 tool.upload）。 | P2 |
| browser_video_info | extra | `mcp/tools-debug-b.mjs:128` | —（无） | BSK MCP 无视频工具（协议 tool.video + CLI video）。 | P2 |
| browser_video_list | extra | `mcp/tools-debug-b.mjs:103` | —（无） | BSK MCP 无 video 工具：录制清单只能走 CLI（bsk video list）。 | P2 |
| browser_video_merge | extra | `mcp/tools-debug-b.mjs:149` | —（无） | BSK 无视频合并能力。 | P2 |
| browser_video_recover | extra | `mcp/tools-debug-b.mjs:86` | —（无） | BSK 无视频恢复能力。 | P2 |
| browser_video_split | extra | `mcp/tools-debug-b.mjs:134` | —（无） | BSK 无视频切分能力。 | P2 |
| browser_video_start | extra | `mcp/tools-debug-b.mjs:62` | —（无） | BSK MCP 无 video 工具：开录只能走 CLI（bsk video start）。 | P2 |
| browser_video_status | extra | `mcp/tools-debug-b.mjs:92` | —（无） | BSK MCP 无 video 工具：状态只能走 CLI（bsk video status）。 | P2 |
| browser_video_stop | extra | `mcp/tools-debug-b.mjs:75` | —（无） | BSK MCP 无 video 工具：停止只能走 CLI（bsk video stop）。 | P2 |
| browser_video_trim | extra | `mcp/tools-debug-b.mjs:112` | —（无） | BSK 无视频裁剪能力。 | P2 |
| bsk_page:wait_for_element ↔ browser_wait_for | partial | `mcp/tools-debug-b.mjs:190` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:995` | BSK 拆成 wait_for_element / wait_for_navigation 两个 action；我方合并为 browser_wait_for。 | P1 |
| bsk_interact:wheel ↔ browser_wheel | partial | `mcp/tools-input.mjs:128` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1311` | 粒度不同（bsk_interact action=wheel）。 | P1 |
| bsk_assist:resize ↔ browser_window | partial | `mcp/tools-debug-b.mjs:164` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1854` | 粒度不同（bsk_assist action=resize）。 | P1 |

### ③b 上游 MCP 动作在我方工具面的覆盖

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| bsk_session:browsers ↔ browser_session_browsers | partial | `mcp/tools-m6b.mjs:269` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:711` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:start ↔ browser_session_start | partial | `mcp/tools-core-a.mjs:55` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:712` | 粒度不同：BSK 是 bsk_session 的 action=start。 | P1 |
| bsk_session:stop ↔ browser_session_stop | partial | `mcp/tools-core-a.mjs:74` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:713` | 粒度不同。 | P1 |
| bsk_session:list ↔ browser_session_list | partial | `mcp/tools-m6b.mjs:273` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:714` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:request_prepare ↔ browser_session_request_prepare | partial | `mcp/tools-session-tab.mjs:41` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:715` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:request_status ↔ browser_session_request_status | partial | `mcp/tools-session-tab.mjs:67` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:716` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:request_claim ↔ browser_session_request_claim | partial | `mcp/tools-session-tab.mjs:75` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:717` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:request_cancel ↔ browser_session_request_cancel | partial | `mcp/tools-session-tab.mjs:83` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:718` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_session:sync ↔ browser_brief,browser_cooperate_sync | partial | `mcp/tools-core-a.mjs:12`<br>`mcp/tools-debug-b.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:719` | 我方分散在 brief（页面简报）与 cooperate_sync（协作同步）。 | P1 |
| bsk_session:wait ↔ browser_cooperate_sync | partial | `mcp/tools-debug-b.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:720` | BSK wait 等人工交还控制；我方 browser_cooperate_sync 可带 wait 语义。 | P1 |
| bsk_session:status ↔ browser_status | partial | `mcp/tools-core-a.mjs:237` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:46`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:721` | 粒度不同。 | P1 |
| bsk_page:navigate ↔ browser_navigate | partial | `mcp/tools-core-a.mjs:281` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:991` | 粒度不同。 | P1 |
| bsk_page:back ↔ browser_back | partial | `mcp/tools-input.mjs:153` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:992` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_page:forward ↔ browser_forward | partial | `mcp/tools-input.mjs:157` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:993` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_page:reload ↔ browser_reload | partial | `mcp/tools-input.mjs:149` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:994` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_page:wait_for_element ↔ browser_wait_for | partial | `mcp/tools-debug-b.mjs:190` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:995` | 粒度不同。 | P1 |
| bsk_page:wait_for_navigation ↔ browser_wait_for | partial | `mcp/tools-debug-b.mjs:190` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:47`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:996` | 粒度不同。 | P1 |
| bsk_inspect:read ↔ browser_read | partial | `mcp/tools-core-a.mjs:327` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1124` | 粒度不同。 | P1 |
| bsk_inspect:observe ↔ browser_observe | partial | `mcp/tools-core-a.mjs:261` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1125` | 粒度不同。 | P1 |
| bsk_inspect:snapshot ↔ browser_observe | partial | `mcp/tools-core-a.mjs:261` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1126` | 我方用 browser_observe 的 VOM 输出覆盖 aria snapshot，无独立工具。 | P1 |
| bsk_inspect:html ↔ browser_inspect_html | partial | `mcp/tools-m6b.mjs:225` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1127` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_inspect:screenshot ↔ browser_screenshot | partial | `mcp/tools-core-b.mjs:35` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1128` | 粒度不同。 | P1 |
| bsk_inspect:console ↔ browser_console | partial | `mcp/tools-input.mjs:161` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1129` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_inspect:network ↔ browser_network_list | partial | `mcp/tools-debug-b.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1130` | 粒度不同。 | P1 |
| bsk_inspect:extract ↔ browser_extract | partial | `mcp/tools-core-b.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:48`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1131` | 粒度不同。 | P1 |
| bsk_interact:click ↔ browser_click | partial | `mcp/tools-core-a.mjs:290` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1304` | 粒度不同。 | P1 |
| bsk_interact:press ↔ browser_press | partial | `mcp/tools-input.mjs:83` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1305` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:fill ↔ browser_fill | partial | `mcp/tools-core-a.mjs:313` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1306` | 粒度不同。 | P1 |
| bsk_interact:hover ↔ browser_hover | partial | `mcp/tools-input.mjs:87` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1307` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:select ↔ browser_select | partial | `mcp/tools-input.mjs:91` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1308` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:drag ↔ browser_drag | partial | `mcp/tools-input.mjs:95` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1309` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:scroll_to ↔ browser_scroll_to | partial | `mcp/tools-input.mjs:124` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1310` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:wheel ↔ browser_wheel | partial | `mcp/tools-input.mjs:128` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1311` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:focus ↔ browser_focus | partial | `mcp/tools-input.mjs:141` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1312` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:blur ↔ browser_blur | partial | `mcp/tools-input.mjs:145` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1313` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_interact:evaluate ↔ browser_evaluate | partial | `mcp/tools-core-b.mjs:24` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:49`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1314` | 粒度不同。 | P1 |
| bsk_recipe:list ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1537` | 我方 browser_recipe 是单工具带 action，覆盖 list/show/run/draft/save/rm。 | P1 |
| bsk_recipe:show ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1538` | browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。 | P1 |
| bsk_recipe:run ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1539` | browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。 | P1 |
| bsk_recipe:draft ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1540` | browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。 | P1 |
| bsk_recipe:save ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1541` | browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。 | P1 |
| bsk_recipe:rm ↔ browser_recipe | partial | `mcp/tools-core-a.mjs:152` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:56`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1542` | browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。 | P1 |
| bsk_tabs:list ↔ browser_tabs | partial | `mcp/tools-core-b.mjs:172` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1752` | 粒度不同。 | P1 |
| bsk_tabs:create ↔ browser_tab_new | partial | `mcp/tools-core-b.mjs:178` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1753` | create ↔ new。 | P1 |
| bsk_tabs:select ↔ browser_tab_select | partial | `mcp/tools-core-b.mjs:200` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1754` | 粒度不同。 | P1 |
| bsk_tabs:close ↔ browser_tab_close | partial | `mcp/tools-core-b.mjs:194` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1755` | 粒度不同。 | P1 |
| bsk_tabs:borrow ↔ browser_tab_borrow | partial | `mcp/tools-session-tab.mjs:91` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1756` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_tabs:return ↔ browser_tab_return | partial | `mcp/tools-session-tab.mjs:103` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:51`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1757` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_assist:resize ↔ browser_window | partial | `mcp/tools-debug-b.mjs:164` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1854` | 粒度不同。 | P1 |
| bsk_assist:emulate ↔ browser_assist_emulate | partial | `mcp/tools-m6b.mjs:229` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1855` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_assist:request_help ↔ browser_assist_request_help | partial | `mcp/tools-m6b.mjs:242` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1856` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_assist:dialog_status ↔ browser_dialog | partial | `mcp/tools-debug-b.mjs:212` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1857` | 我方 browser_dialog 合并 status/accept/dismiss/operation。 | P1 |
| bsk_assist:dialog_accept ↔ browser_dialog | partial | `mcp/tools-debug-b.mjs:212` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1858` | browser_dialog 单工具合并 status/accept/dismiss（粒度：1 工具 ↔ 3 动作）。 | P1 |
| bsk_assist:dialog_dismiss ↔ browser_dialog | partial | `mcp/tools-debug-b.mjs:212` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1859` | browser_dialog 单工具合并 status/accept/dismiss（粒度：1 工具 ↔ 3 动作）。 | P1 |
| bsk_assist:operation_await ↔ browser_assist_operation_await | partial | `mcp/tools-m6b.mjs:261` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1860` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |
| bsk_assist:operation_cancel ↔ browser_assist_operation_cancel | partial | `mcp/tools-m6b.mjs:265` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:52`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/mcp/tools.rs:1861` | 专用工具已覆盖（仅契约形状差异，P1） | P1 |

## ④ 扩展能力（8 个能力面 + manifest 权限面）

比对口径：两侧是否存在该能力的专用产物（页面 / content script / 模块 / 协议方法）+ manifest 权限是否齐备。上游 侧优先引源码（apps/extension/src），构建产物（chunks/pages）作旁证。

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| record | partial | `extension/src/record-overlay.js:10`<br>`extension/src/record-events.js:29`<br>`extension/ui/record.html:2` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/record-capture.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/RecordOverlay.tsx`<br>`ref/bsk-0.5.0-ext/content-scripts/record-frame.js`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/record.rs` | 两侧都是"内容脚本抓事件 + CLI 导出"；差异在 UI：我方有独立 record 面板（overlay 录制态/暂停/导出），BSK 录制浮层由 record-frame content script 注入、无独立扩展页；BSK 导出面向 trace.json 教材（record export），我方另有 record-program/replay 语义。 | P1 |
| video | partial | `extension/src/video.js:55`<br>`extension/offscreen.html:2`<br>`extension/ui/panels/video-panel.js:41` | `ref/bsk-0.5.0-ext/video.html`<br>`ref/bsk-0.5.0-ext/video-offscreen.html`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/video/encoder.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/video/offscreen.ts` | 两侧都有 offscreen 录制 + 专用页面；BSK 固定 video.html/video-offscreen.html 两页，我方是 offscreen.html + video-panel 面板。编码参数（码率/容器/关键帧）是否逐项一致未验证（需要 E2E，不在本任务范围）。 | P1 |
| longshot | partial | `extension/src/longshot.js:2`<br>`extension/src/tiled-capture.js:646`<br>`extension/ui/longshot.html:2` | `ref/bsk-0.5.0-ext/long-screenshot.html`<br>`ref/bsk-0.5.0-ext/content-scripts/long-screenshot-page.js`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/long-screenshot/capture.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/long-screenshot/tiles.ts` | 两侧都分片抓取再拼接；BSK 在页面侧 content script 内拼接，我方由扩展 tiled-capture + longshot.recover 恢复。分片重叠/上限（我方 maxTiles=8）与 BSK 的服务端拼接策略未逐项对齐。 | P2 |
| overlay | partial | `extension/src/overlay-ui.js:10`<br>`extension/src/manual-overlay.js:2`<br>`extension/src/target-marker.js:6` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/ControlOverlay.tsx`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/overlay-controller.ts`<br>`ref/bsk-0.5.0-ext/content-scripts/cooperation.js` | BSK 的输入拦截/提示浮层集中在 cooperation content script；我方拆成 overlay-ui（band/banner）+ manual-overlay（手动模式）+ target-marker（目标标记）+ 抑制层，组件更多、可组合，但对照 BSK 的 overlay 文案/可访问性面无逐项比对。 | P2 |
| cooperate | partial | `extension/src/cooperation.js:32`<br>`extension/content/cooperation.js:12`<br>`extension/src/control.js:118` | `ref/bsk-0.5.0-ext/content-scripts/cooperation.js`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/controller.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/control-authority.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/cooperate.rs` | 两侧都有 content-script 协作层 + sync/wait/handback。我方 control.js 已支持 target/strict/auto（另有 passthrough token、租约 epoch、hold 状态），是 BSK 单控制面的超集；契约形状不同、能力已具备，按 partial（P1）记账。 | P1 |
| toolbar | equal | `extension/ui/popup.html:2`<br>`extension/ui/popup.js:12` | `ref/bsk-0.5.0-ext/popup.html`<br>`ref/bsk-0.5.0-ext/chunks/popup-BRMQtodn.js` | 入口面一致：两侧 manifest 都声明 action.default_popup 指向各自的 popup 页面，且都提供 options 页。只判"工具栏入口"这一可核对面一致，不涉及面板内功能。 | P2 |
| human | partial | `extension/src/human-state.js:2`<br>`extension/src/human-decisions.js:7`<br>`extension/content/human-watch.js:6` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/human_loop.rs`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/human_loop.rs`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/help-request.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/HelpRequestOverlay.tsx` | 两侧都有人工介入检测（输入事件 → 暂停 agent）；BSK 在工具层 HumanLoop 结构（request_help + InteractionPolicy feature），我方用 human-watch content script + human-state/decisions 状态机。判定阈值与暂停粒度未对齐。 | P1 |
| borrow | partial | `extension/src/tabs-borrow.js:15`<br>`extension/src/borrow-ui.js:10`<br>`extension/src/lib/borrow-confirm.js:33` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/BorrowConfirmationOverlay.tsx`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/action-guard.ts`<br>`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs` | 两侧都有借用确认。我方 daemon 已用 FEATURE_PARAM_RULES（confirmationTimeoutMs → borrow_confirmation_timeout, floor 1.9）在 extension-dispatch 的 requireFeatures 做参数级特性门，默认 60s；BSK floor 1.2。门控位置/floor 不同、能力已具备，按 contract partial（P1）记账。 | P1 |
| manifest-permissions | partial | `extension/manifest.json:7` | `ref/bsk-0.5.0-ext/manifest.json` | BSK 声明 activeTab，我方未声明（用 tabs + scripting 覆盖，最小权限面更窄但语义不同）；我方额外要 tabCapture（视频录制）与 declarativeNetRequest（网络规则），BSK 两者都不声明。最低 Chrome 版本也不同：BSK 125 / 我方 111。（权限交集 12、BSK 独有 activeTab、我方独有 declarativeNetRequest,tabCapture） | P2 |

## ⑤ 协议 / feature floor（我方 9 个 + 上游 独有 6 个）

比对口径：floor 值 + 触发条件（`FeatureWhen` vs 我方 `FEATURE_META.kind/params/methods`）。floor 与触发面都一致才判 equal。

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| unverified_script ↔ unverified | equal | `lib/method-catalog.mjs:286` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:160` | 两侧都是"参数 unverified=true 才要求 1.9"；触发字段与 floor 完全一致。 | P2 |
| action_conditions ↔ expect | partial | `lib/method-catalog.mjs:287` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:146` | floor 不同：BSK 1.8 / 我方 1.9；触发条件一致（expect 非空数组/存在），但 floor 不同：BSK 1.8，我方 1.9（我方把整个 1.9 特性批次抬高）。 | P1 |
| dom_read ↔ read | partial | `lib/method-catalog.mjs:288` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:153` | 触发面不同：BSK always / 我方 method(方法级)；floor 都是 1.9；但 BSK 是"操作恒要求"（FeatureWhen::Always），我方是方法级门（read 方法），触发面不同。 | P1 |
| observe-delta | extra | `lib/method-catalog.mjs:289` | —（无） | 我方独有的 observe 增量补丁门（delta=true 要求 1.9）；BSK 0.5.0 无对应 Feature。 | P2 |
| plan | extra | `lib/method-catalog.mjs:290` | —（无） | 我方独有：plan 方法要求 1.9；BSK 的 plan 是 CLI 编排，不在协议里，也没有 Feature。 | P2 |
| video | extra | `lib/method-catalog.mjs:291` | —（无） | 我方独有：video.* 九个方法统一门 1.9；BSK 的 tool.video 没有 Feature 门（只在 start action 上做 interrupt gate）。 | P2 |
| capture.stream | extra | `lib/method-catalog.mjs:292` | —（无） | 我方独有：screenshot 的 stream/segmented/staleAttempts 与 screenshot.read/release/longshot.recover 门 1.9；BSK 整页截图用 tool.screenshot_full_page + ActionConditions 表达，无独立 stream 门。 | P2 |
| debug.journal | extra | `lib/method-catalog.mjs:293` | —（无） | 我方独有：debug.history/delete/pin/pinned 门 1.9；BSK 调试日志在 tool.debug 的 action 里，无 Feature 门。 | P2 |
| har | extra | `lib/method-catalog.mjs:294` | —（无） | 我方独有：network.replay 门 1.9；BSK 的 HAR 重放在 tool.debug action 里，无 Feature 门。 | P2 |
| borrow_confirmation_timeout ↔ borrow_confirmation_timeout | partial | `lib/method-catalog.mjs:296` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:96` | floor 不同：BSK 1.2 / 我方 1.9；触发面不同：BSK present(confirmation_timeout_ms) / 我方 param(confirmationTimeoutMs)；同名 Feature；BSK 门保证旧扩展转发 confirmation_timeout_ms，我方 M6-P0② 已补协议门（1.9），语义对齐。 | P1 |
| interaction_policy ↔ interaction_policy | partial | `lib/method-catalog.mjs:297` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:105` | floor 不同：BSK 1.0 / 我方 1.9；触发面不同：BSK always / 我方 method(方法级)；同名 Feature；我方 M6-P0② 已补 request-help 转发门（1.9）。 | P1 |
| incognito_sessions ↔ incognito_sessions | partial | `lib/method-catalog.mjs:298` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:115` | floor 不同：BSK 1.4 / 我方 1.9；同名 Feature；我方 session.start incognito 门（1.9）已补。 | P1 |
| dialog_control ↔ dialog_control | partial | `lib/method-catalog.mjs:299` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:122` | floor 不同：BSK 1.5 / 我方 1.9；触发面不同：BSK always / 我方 method(方法级)；同名 Feature；我方 dialog.*/operation.* 门（1.9）已补。 | P1 |
| click_move_click ↔ click_move_click | partial | `lib/method-catalog.mjs:300` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:129` | floor 不同：BSK 1.7 / 我方 1.9；触发面不同：BSK equals(mode) / 我方 param(mode)；同名 Feature；我方 drag mode=click-move-click 门（1.9）已补。 | P1 |
| target_control ↔ target_control | partial | `lib/method-catalog.mjs:301` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/compatibility.rs:139` | floor 不同：BSK 1.8 / 我方 1.9；触发面不同：BSK control_policy / 我方 param(control_policy,policy)；同名 Feature；我方 control_mode/claim_control 门（1.9）已补。 | P1 |

## ⑥ 错误码（我方 159 ↔ 上游 15 ErrorCode + 102 RpcErrorReason）

比对口径：归一化 wire 名一致判 equal；语义近似（名称不同但同义）判 partial；上游 有而我方没有判 missing；我方多出的码判 extra。

| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| code:unknown_method ↔ E_UNKNOWN_METHOD | equal | `lib/error-codes.mjs:14` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:41` | 归一化名称一致。 | P2 |
| code:unsupported ↔ E_UNSUPPORTED | equal | `lib/error-codes.mjs:71` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:42` | 归一化名称一致。 | P2 |
| code:invalid_params ↔ E_INVALID_PARAMS | equal | `lib/error-codes.mjs:151` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:43` | 归一化名称一致。 | P2 |
| code:not_found ↔ E_NOT_FOUND | equal | `lib/error-codes.mjs:9` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:44` | 归一化名称一致。 | P2 |
| code:permission_denied ↔ E_FORBIDDEN | partial | `lib/error-codes.mjs:201` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:45` | 名称不同（BSK `permission_denied` → 我方 `E_FORBIDDEN`），属于语义近似映射。；BSK 的 permission_denied / restricted_tab_url / cdp_extension_access_denied 都落到我方一个码。 | P2 |
| code:timeout ↔ E_TIMEOUT | equal | `lib/error-codes.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:46` | 归一化名称一致。 | P2 |
| code:dialog_pending ↔ E_DIALOG_PENDING | equal | `lib/error-codes.mjs:105` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:47` | 归一化名称一致。 | P2 |
| code:cdp_failed ↔ E_PAGE_ERROR | partial | `lib/error-codes.mjs:165` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:48` | 名称不同（BSK `cdp_failed` → 我方 `E_PAGE_ERROR`），属于语义近似映射。 | P2 |
| code:protocol_error ↔ E_RPC | partial | `lib/error-codes.mjs:153` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:49` | 名称不同（BSK `protocol_error` → 我方 `E_RPC`），属于语义近似映射。 | P2 |
| code:cancelled ↔ E_CANCELLED | equal | `lib/error-codes.mjs:23` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:50` | 归一化名称一致。 | P2 |
| code:user_aborted ↔ E_CANCELLED | partial | `lib/error-codes.mjs:23` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:51` | 名称不同（BSK `user_aborted` → 我方 `E_CANCELLED`），属于语义近似映射。 | P2 |
| code:version_too_old ↔ E_PROTOCOL_UNSUPPORTED | partial | `lib/error-codes.mjs:122` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:52` | 名称不同（BSK `version_too_old` → 我方 `E_PROTOCOL_UNSUPPORTED`），属于语义近似映射。 | P2 |
| code:multiple_browsers_online ↔ E_BROWSER_AMBIGUOUS | partial | `lib/error-codes.mjs:28` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:53` | 名称不同（BSK `multiple_browsers_online` → 我方 `E_BROWSER_AMBIGUOUS`），属于语义近似映射。 | P2 |
| code:no_browser_connected ↔ E_NO_BROWSER | partial | `lib/error-codes.mjs:27` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:54` | 名称不同（BSK `no_browser_connected` → 我方 `E_NO_BROWSER`），属于语义近似映射。 | P2 |
| code:pairing_required ↔ E_PAIR_REQUIRED | partial | `lib/error-codes.mjs:134` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:55` | 名称不同（BSK `pairing_required` → 我方 `E_PAIR_REQUIRED`），属于语义近似映射。 | P2 |
| reason:user_moved_tab ↔ E_TARGET_DETACHED | partial | `lib/error-codes.mjs:43` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:87` | 名称不同（BSK `user_moved_tab` → 我方 `E_TARGET_DETACHED`），属于语义近似映射。 | P2 |
| reason:cooperation_sync_required ↔ E_COOPERATION_STALE | partial | `lib/error-codes.mjs:37` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:88` | 名称不同（BSK `cooperation_sync_required` → 我方 `E_COOPERATION_STALE`），属于语义近似映射。 | P2 |
| reason:frame_unobservable ↔ E_OBSERVE_FAILED | partial | `lib/error-codes.mjs:166` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:89` | 名称不同（BSK `frame_unobservable` → 我方 `E_OBSERVE_FAILED`），属于语义近似映射。 | P2 |
| reason:page_load_failed ↔ E_NAV_FAIL | partial | `lib/error-codes.mjs:115` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:90` | 名称不同（BSK `page_load_failed` → 我方 `E_NAV_FAIL`），属于语义近似映射。 | P2 |
| reason:control_authority_required ↔ E_CONTROL_NOT_HELD | partial | `lib/error-codes.mjs:180` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:91` | 名称不同（BSK `control_authority_required` → 我方 `E_CONTROL_NOT_HELD`），属于语义近似映射。 | P2 |
| reason:control_context_invalid ↔ E_CONTEXT_STALE | partial | `lib/error-codes.mjs:36` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:92` | 名称不同（BSK `control_context_invalid` → 我方 `E_CONTEXT_STALE`），属于语义近似映射。 | P2 |
| reason:human_intervention ↔ E_HUMAN_GATE | partial | `lib/error-codes.mjs:84` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:93` | 名称不同（BSK `human_intervention` → 我方 `E_HUMAN_GATE`），属于语义近似映射。 | P2 |
| reason:control_held ↔ E_CONTROL_BUSY | partial | `lib/error-codes.mjs:181` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:94` | 名称不同（BSK `control_held` → 我方 `E_CONTROL_BUSY`），属于语义近似映射。 | P2 |
| reason:document_changed ↔ E_OBSERVATION_STALE | partial | `lib/error-codes.mjs:33` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:95` | 名称不同（BSK `document_changed` → 我方 `E_OBSERVATION_STALE`），属于语义近似映射。 | P2 |
| reason:observation_required ↔ E_CONTEXT_REQUIRED | partial | `lib/error-codes.mjs:35` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:96` | 名称不同（BSK `observation_required` → 我方 `E_CONTEXT_REQUIRED`），属于语义近似映射。 | P2 |
| reason:observation_changed ↔ E_OBSERVATION_CHANGED | equal | `lib/error-codes.mjs:42` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:97` | 归一化名称一致。 | P2 |
| reason:precondition_invalid ↔ E_ARG_CONFLICT | partial | `lib/error-codes.mjs:77` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:98` | 名称不同（BSK `precondition_invalid` → 我方 `E_ARG_CONFLICT`），属于语义近似映射。 | P2 |
| reason:precondition_failed ↔ E_EXPECT_FAILED | partial | `lib/error-codes.mjs:41` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:99` | 名称不同（BSK `precondition_failed` → 我方 `E_EXPECT_FAILED`），属于语义近似映射。 | P2 |
| reason:target_detached ↔ E_TARGET_DETACHED | equal | `lib/error-codes.mjs:43` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:100` | 归一化名称一致。 | P2 |
| reason:target_hidden ↔ E_NOT_ACTIONABLE | partial | `lib/error-codes.mjs:10` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:101` | 名称不同（BSK `target_hidden` → 我方 `E_NOT_ACTIONABLE`），属于语义近似映射。；BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。 | P2 |
| reason:target_disabled ↔ E_NOT_ACTIONABLE | partial | `lib/error-codes.mjs:10` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:102` | 名称不同（BSK `target_disabled` → 我方 `E_NOT_ACTIONABLE`），属于语义近似映射。；BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。 | P2 |
| reason:target_readonly ↔ E_NOT_ACTIONABLE | partial | `lib/error-codes.mjs:10` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:103` | 名称不同（BSK `target_readonly` → 我方 `E_NOT_ACTIONABLE`），属于语义近似映射。；BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。 | P2 |
| reason:target_focus_lost ↔ E_FOCUS | partial | `lib/error-codes.mjs:164` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:104` | 名称不同（BSK `target_focus_lost` → 我方 `E_FOCUS`），属于语义近似映射。 | P2 |
| reason:target_moved ↔ E_TARGET_MISMATCH | partial | `lib/error-codes.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:105` | 名称不同（BSK `target_moved` → 我方 `E_TARGET_MISMATCH`），属于语义近似映射。 | P2 |
| reason:target_covered ↔ E_OCCLUDED | partial | `lib/error-codes.mjs:100` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:106` | 名称不同（BSK `target_covered` → 我方 `E_OCCLUDED`），属于语义近似映射。 | P2 |
| reason:virtual_row_recycled ↔ E_STALE_REF | partial | `lib/error-codes.mjs:11` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:107` | 名称不同（BSK `virtual_row_recycled` → 我方 `E_STALE_REF`），属于语义近似映射。 | P2 |
| reason:read_params_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:108` | 名称不同（BSK `read_params_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:read_target_stale ↔ E_STALE_REF | partial | `lib/error-codes.mjs:11` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:109` | 名称不同（BSK `read_target_stale` → 我方 `E_STALE_REF`），属于语义近似映射。 | P2 |
| reason:read_selector_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:110` | 名称不同（BSK `read_selector_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:read_field_ambiguous ↔ E_OPTION_AMBIGUOUS | partial | `lib/error-codes.mjs:13` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:111` | 名称不同（BSK `read_field_ambiguous` → 我方 `E_OPTION_AMBIGUOUS`），属于语义近似映射。 | P2 |
| reason:read_limit ↔ E_RESULT_TOO_LARGE | partial | `lib/error-codes.mjs:111` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:112` | 名称不同（BSK `read_limit` → 我方 `E_RESULT_TOO_LARGE`），属于语义近似映射。 | P2 |
| reason:extract_params_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:113` | 名称不同（BSK `extract_params_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:extract_target_stale ↔ E_STALE_REF | partial | `lib/error-codes.mjs:11` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:114` | 名称不同（BSK `extract_target_stale` → 我方 `E_STALE_REF`），属于语义近似映射。 | P2 |
| reason:extract_target_ambiguous ↔ E_OPTION_AMBIGUOUS | partial | `lib/error-codes.mjs:13` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:115` | 名称不同（BSK `extract_target_ambiguous` → 我方 `E_OPTION_AMBIGUOUS`），属于语义近似映射。 | P2 |
| reason:extract_target_hidden ↔ E_NOT_ACTIONABLE | partial | `lib/error-codes.mjs:10` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:116` | 名称不同（BSK `extract_target_hidden` → 我方 `E_NOT_ACTIONABLE`），属于语义近似映射。；BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。 | P2 |
| reason:extract_selector_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:117` | 名称不同（BSK `extract_selector_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:extract_structure_invalid ↔ E_PAGE_ERROR | partial | `lib/error-codes.mjs:165` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:118` | 名称不同（BSK `extract_structure_invalid` → 我方 `E_PAGE_ERROR`），属于语义近似映射。 | P2 |
| reason:extract_field_ambiguous ↔ E_OPTION_AMBIGUOUS | partial | `lib/error-codes.mjs:13` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:119` | 名称不同（BSK `extract_field_ambiguous` → 我方 `E_OPTION_AMBIGUOUS`），属于语义近似映射。 | P2 |
| reason:extract_limit ↔ E_RESULT_TOO_LARGE | partial | `lib/error-codes.mjs:111` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:120` | 名称不同（BSK `extract_limit` → 我方 `E_RESULT_TOO_LARGE`），属于语义近似映射。 | P2 |
| reason:ui_lookup_failed ↔ E_OBSERVE_FAILED | partial | `lib/error-codes.mjs:166` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:121` | 名称不同（BSK `ui_lookup_failed` → 我方 `E_OBSERVE_FAILED`），属于语义近似映射。 | P2 |
| reason:task_unavailable ↔ E_NO_SESSION | partial | `lib/error-codes.mjs:17` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:122` | 名称不同（BSK `task_unavailable` → 我方 `E_NO_SESSION`），属于语义近似映射。 | P2 |
| reason:target_unavailable ↔ E_NOT_FOUND | partial | `lib/error-codes.mjs:9` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:123` | 名称不同（BSK `target_unavailable` → 我方 `E_NOT_FOUND`），属于语义近似映射。 | P2 |
| reason:task_stopping ↔ E_SESSION_STOPPED | partial | `lib/error-codes.mjs:20` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:124` | 名称不同（BSK `task_stopping` → 我方 `E_SESSION_STOPPED`），属于语义近似映射。 | P2 |
| reason:ui_deadline ↔ E_TIMEOUT | partial | `lib/error-codes.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:125` | 名称不同（BSK `ui_deadline` → 我方 `E_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:preview_busy ↔ E_PREVIEW_META | partial | `lib/error-codes.mjs:161` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:126` | 名称不同（BSK `preview_busy` → 我方 `E_PREVIEW_META`），属于语义近似映射。 | P2 |
| reason:agent_window_scope ↔ E_UNSUPPORTED_FEATURE | partial | `lib/error-codes.mjs:39` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:127` | 名称不同（BSK `agent_window_scope` → 我方 `E_UNSUPPORTED_FEATURE`），属于语义近似映射。 | P2 |
| reason:element_not_visible ↔ E_NOT_ACTIONABLE | partial | `lib/error-codes.mjs:10` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:128` | 名称不同（BSK `element_not_visible` → 我方 `E_NOT_ACTIONABLE`），属于语义近似映射。；BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。 | P2 |
| reason:input_not_ready ↔ E_INPUT_BUSY | partial | `lib/error-codes.mjs:25` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:129` | 名称不同（BSK `input_not_ready` → 我方 `E_INPUT_BUSY`），属于语义近似映射。 | P2 |
| reason:input_clock_unavailable ↔ E_INTERNAL | partial | `lib/error-codes.mjs:204` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:130` | 名称不同（BSK `input_clock_unavailable` → 我方 `E_INTERNAL`），属于语义近似映射。 | P2 |
| reason:input_outcome_unknown ↔ E_INTERNAL | partial | `lib/error-codes.mjs:204` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:131` | 名称不同（BSK `input_outcome_unknown` → 我方 `E_INTERNAL`），属于语义近似映射。 | P2 |
| reason:uncertain_prior_effect ↔ E_LEDGER_PENDING | partial | `lib/error-codes.mjs:137` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:132` | 名称不同（BSK `uncertain_prior_effect` → 我方 `E_LEDGER_PENDING`），属于语义近似映射。 | P2 |
| reason:input_paint_unconfirmed ↔ E_EXEC_FAILED | partial | `lib/error-codes.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:133` | 名称不同（BSK `input_paint_unconfirmed` → 我方 `E_EXEC_FAILED`），属于语义近似映射。 | P2 |
| reason:input_cleanup_failed ↔ E_INTERNAL | partial | `lib/error-codes.mjs:204` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:134` | 名称不同（BSK `input_cleanup_failed` → 我方 `E_INTERNAL`），属于语义近似映射。 | P2 |
| reason:ref_not_found ↔ E_NOT_FOUND | partial | `lib/error-codes.mjs:9` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:135` | 名称不同（BSK `ref_not_found` → 我方 `E_NOT_FOUND`），属于语义近似映射。 | P2 |
| reason:ref_kind_unsupported ↔ E_UNSUPPORTED_FEATURE | partial | `lib/error-codes.mjs:39` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:136` | 名称不同（BSK `ref_kind_unsupported` → 我方 `E_UNSUPPORTED_FEATURE`），属于语义近似映射。 | P2 |
| reason:visual_capture_stale ↔ E_CAPTURE_STALE | partial | `lib/error-codes.mjs:103` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:137` | 名称不同（BSK `visual_capture_stale` → 我方 `E_CAPTURE_STALE`），属于语义近似映射。 | P2 |
| reason:visual_capture_invalid ↔ E_CAPTURE_STALE | partial | `lib/error-codes.mjs:103` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:138` | 名称不同（BSK `visual_capture_invalid` → 我方 `E_CAPTURE_STALE`），属于语义近似映射。 | P2 |
| reason:visual_coordinate_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:139` | 名称不同（BSK `visual_coordinate_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:visual_target_changed ↔ E_TARGET_MISMATCH | partial | `lib/error-codes.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:140` | 名称不同（BSK `visual_target_changed` → 我方 `E_TARGET_MISMATCH`），属于语义近似映射。 | P2 |
| reason:visual_pixel_budget_exceeded ↔ E_TOO_LARGE | partial | `lib/error-codes.mjs:110` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:141` | 名称不同（BSK `visual_pixel_budget_exceeded` → 我方 `E_TOO_LARGE`），属于语义近似映射。 | P2 |
| reason:selector_not_found ↔ E_NOT_FOUND | partial | `lib/error-codes.mjs:9` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:142` | 名称不同（BSK `selector_not_found` → 我方 `E_NOT_FOUND`），属于语义近似映射。 | P2 |
| reason:target_not_fillable ↔ E_TARGET_NOT_FILLABLE | equal | `lib/error-codes.mjs:157` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:143` | 归一化名称一致。 | P2 |
| reason:fill_value_invalid ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:144` | 名称不同（BSK `fill_value_invalid` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:fill_target_changed ↔ E_TARGET_MISMATCH | partial | `lib/error-codes.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:145` | 名称不同（BSK `fill_target_changed` → 我方 `E_TARGET_MISMATCH`），属于语义近似映射。 | P2 |
| reason:fill_focus_lost ↔ E_FOCUS | partial | `lib/error-codes.mjs:164` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:146` | 名称不同（BSK `fill_focus_lost` → 我方 `E_FOCUS`），属于语义近似映射。 | P2 |
| reason:fill_value_mismatch ↔ E_TARGET_MISMATCH | partial | `lib/error-codes.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:147` | 名称不同（BSK `fill_value_mismatch` → 我方 `E_TARGET_MISMATCH`），属于语义近似映射。 | P2 |
| reason:fill_failed ↔ E_TARGET_MISMATCH | partial | `lib/error-codes.mjs:102` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:148` | 名称不同（BSK `fill_failed` → 我方 `E_TARGET_MISMATCH`），属于语义近似映射。 | P2 |
| reason:target_not_select ↔ E_NOT_SELECT | partial | `lib/error-codes.mjs:158` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:149` | 名称不同（BSK `target_not_select` → 我方 `E_NOT_SELECT`），属于语义近似映射。 | P2 |
| reason:option_not_found ↔ E_OPTION_NOT_FOUND | equal | `lib/error-codes.mjs:12` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:150` | 归一化名称一致。 | P2 |
| reason:option_ambiguous ↔ E_OPTION_AMBIGUOUS | equal | `lib/error-codes.mjs:13` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:151` | 归一化名称一致。 | P2 |
| reason:single_select_value_count ↔ E_BAD_ARG | partial | `lib/error-codes.mjs:8` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:152` | 名称不同（BSK `single_select_value_count` → 我方 `E_BAD_ARG`），属于语义近似映射。；BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。 | P2 |
| reason:tab_not_active ↔ E_NO_TAB | partial | `lib/error-codes.mjs:26` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:153` | 名称不同（BSK `tab_not_active` → 我方 `E_NO_TAB`），属于语义近似映射。 | P2 |
| reason:window_resize_inactive_tab ↔ E_NO_TAB | partial | `lib/error-codes.mjs:26` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:154` | 名称不同（BSK `window_resize_inactive_tab` → 我方 `E_NO_TAB`），属于语义近似映射。 | P2 |
| reason:window_resize_constrained ↔ E_ARG_RANGE | partial | `lib/error-codes.mjs:79` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:155` | 名称不同（BSK `window_resize_constrained` → 我方 `E_ARG_RANGE`），属于语义近似映射。 | P2 |
| reason:window_resize_unconfirmed ↔ E_EXEC_FAILED | partial | `lib/error-codes.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:156` | 名称不同（BSK `window_resize_unconfirmed` → 我方 `E_EXEC_FAILED`），属于语义近似映射。 | P2 |
| reason:window_resize_viewport_unchanged ↔ E_EXEC_FAILED | partial | `lib/error-codes.mjs:203` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:157` | 名称不同（BSK `window_resize_viewport_unchanged` → 我方 `E_EXEC_FAILED`），属于语义近似映射。 | P2 |
| reason:restricted_tab_url ↔ E_FORBIDDEN | partial | `lib/error-codes.mjs:201` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:158` | 名称不同（BSK `restricted_tab_url` → 我方 `E_FORBIDDEN`），属于语义近似映射。；BSK 的 permission_denied / restricted_tab_url / cdp_extension_access_denied 都落到我方一个码。 | P2 |
| reason:cdp_extension_access_denied ↔ E_FORBIDDEN | partial | `lib/error-codes.mjs:201` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:159` | 名称不同（BSK `cdp_extension_access_denied` → 我方 `E_FORBIDDEN`），属于语义近似映射。；BSK 的 permission_denied / restricted_tab_url / cdp_extension_access_denied 都落到我方一个码。 | P2 |
| reason:observe_identity_reload_loop ↔ E_OBSERVE_FAILED | partial | `lib/error-codes.mjs:166` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:160` | 名称不同（BSK `observe_identity_reload_loop` → 我方 `E_OBSERVE_FAILED`），属于语义近似映射。 | P2 |
| reason:borrow_agent_window_tab ↔ E_BORROW_DENIED | partial | `lib/error-codes.mjs:176` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:161` | 名称不同（BSK `borrow_agent_window_tab` → 我方 `E_BORROW_DENIED`），属于语义近似映射。 | P2 |
| reason:borrow_conflict ↔ E_BORROW_CONFLICT | equal | `lib/error-codes.mjs:177` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:162` | 归一化名称一致。 | P2 |
| reason:incognito_borrow_disabled ↔ E_INCOGNITO_UNAVAILABLE | partial | `lib/error-codes.mjs:191` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:163` | 名称不同（BSK `incognito_borrow_disabled` → 我方 `E_INCOGNITO_UNAVAILABLE`），属于语义近似映射。 | P2 |
| reason:borrow_in_progress ↔ E_BORROW_CONFLICT | partial | `lib/error-codes.mjs:177` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:164` | 名称不同（BSK `borrow_in_progress` → 我方 `E_BORROW_CONFLICT`），属于语义近似映射。 | P2 |
| reason:user_denied ↔ E_BORROW_DENIED | partial | `lib/error-codes.mjs:176` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:165` | 名称不同（BSK `user_denied` → 我方 `E_BORROW_DENIED`），属于语义近似映射。 | P2 |
| reason:confirmation_timeout ↔ E_BORROW_TIMEOUT | partial | `lib/error-codes.mjs:178` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:166` | 名称不同（BSK `confirmation_timeout` → 我方 `E_BORROW_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:confirmation_ui_unavailable ↔ E_HELP_DISABLED | partial | `lib/error-codes.mjs:179` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:167` | 名称不同（BSK `confirmation_ui_unavailable` → 我方 `E_HELP_DISABLED`），属于语义近似映射。 | P2 |
| reason:borrow_outcome_unknown ↔ E_INTERNAL | partial | `lib/error-codes.mjs:204` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:168` | 名称不同（BSK `borrow_outcome_unknown` → 我方 `E_INTERNAL`），属于语义近似映射。 | P2 |
| reason:screenshot_capture_failed ↔ E_SCREENSHOT | partial | `lib/error-codes.mjs:160` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:169` | 名称不同（BSK `screenshot_capture_failed` → 我方 `E_SCREENSHOT`），属于语义近似映射。 | P2 |
| reason:renderer_read_timeout ↔ E_TIMEOUT | partial | `lib/error-codes.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:170` | 名称不同（BSK `renderer_read_timeout` → 我方 `E_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:operation_settling ↔ E_INPUT_BUSY | partial | `lib/error-codes.mjs:25` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:171` | 名称不同（BSK `operation_settling` → 我方 `E_INPUT_BUSY`），属于语义近似映射。 | P2 |
| reason:user_cancelled ↔ E_CANCELLED | partial | `lib/error-codes.mjs:23` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:172` | 名称不同（BSK `user_cancelled` → 我方 `E_CANCELLED`），属于语义近似映射。 | P2 |
| reason:page_hidden ↔ E_PAGE_ERROR | partial | `lib/error-codes.mjs:165` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:173` | 名称不同（BSK `page_hidden` → 我方 `E_PAGE_ERROR`），属于语义近似映射。 | P2 |
| reason:navigation ↔ E_NAV_FAIL | partial | `lib/error-codes.mjs:115` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:174` | 名称不同（BSK `navigation` → 我方 `E_NAV_FAIL`），属于语义近似映射。 | P2 |
| reason:watchdog_timeout ↔ E_TIMEOUT | partial | `lib/error-codes.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:175` | 名称不同（BSK `watchdog_timeout` → 我方 `E_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:stale_frame ↔ E_STALE_REF | partial | `lib/error-codes.mjs:11` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:176` | 名称不同（BSK `stale_frame` → 我方 `E_STALE_REF`），属于语义近似映射。 | P2 |
| reason:loading_stalled ↔ E_TIMEOUT | partial | `lib/error-codes.mjs:116` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:177` | 名称不同（BSK `loading_stalled` → 我方 `E_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:file_input_probe_failed ↔ E_NO_FILE_CHOOSER | partial | `lib/error-codes.mjs:187` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:178` | 名称不同（BSK `file_input_probe_failed` → 我方 `E_NO_FILE_CHOOSER`），属于语义近似映射。 | P2 |
| reason:file_input_not_activated ↔ E_NO_FILE_CHOOSER | partial | `lib/error-codes.mjs:187` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:179` | 名称不同（BSK `file_input_not_activated` → 我方 `E_NO_FILE_CHOOSER`），属于语义近似映射。 | P2 |
| reason:set_file_input_failed ↔ E_NO_FILE_CHOOSER | partial | `lib/error-codes.mjs:187` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:180` | 名称不同（BSK `set_file_input_failed` → 我方 `E_NO_FILE_CHOOSER`），属于语义近似映射。 | P2 |
| reason:upload_mechanism_unsupported ↔ E_UNSUPPORTED_CAPABILITY | partial | `lib/error-codes.mjs:120` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:181` | 名称不同（BSK `upload_mechanism_unsupported` → 我方 `E_UNSUPPORTED_CAPABILITY`），属于语义近似映射。 | P2 |
| reason:file_drop_target_unavailable ↔ E_TARGET_NOT_FILLABLE | partial | `lib/error-codes.mjs:157` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:182` | 名称不同（BSK `file_drop_target_unavailable` → 我方 `E_TARGET_NOT_FILLABLE`），属于语义近似映射。 | P2 |
| reason:file_drop_failed ↔ E_TRANSFER_STATE | partial | `lib/error-codes.mjs:173` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:183` | 名称不同（BSK `file_drop_failed` → 我方 `E_TRANSFER_STATE`），属于语义近似映射。 | P2 |
| reason:download_capture_failed ↔ E_DOWNLOAD_FAILED | partial | `lib/error-codes.mjs:186` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:184` | 名称不同（BSK `download_capture_failed` → 我方 `E_DOWNLOAD_FAILED`），属于语义近似映射。 | P2 |
| reason:download_path_mismatch ↔ E_DOWNLOAD_FAILED | partial | `lib/error-codes.mjs:186` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:185` | 名称不同（BSK `download_path_mismatch` → 我方 `E_DOWNLOAD_FAILED`），属于语义近似映射。 | P2 |
| reason:transfer_outcome_unknown ↔ E_TRANSFER_STATE | partial | `lib/error-codes.mjs:173` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:186` | 名称不同（BSK `transfer_outcome_unknown` → 我方 `E_TRANSFER_STATE`），属于语义近似映射。 | P2 |
| reason:transfer_timeout ↔ E_DAEMON_TIMEOUT | partial | `lib/error-codes.mjs:142` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:187` | 名称不同（BSK `transfer_timeout` → 我方 `E_DAEMON_TIMEOUT`），属于语义近似映射。 | P2 |
| reason:cleanup_failed ↔ E_INTERNAL | partial | `lib/error-codes.mjs:204` | `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/error.rs:188` | 名称不同（BSK `cleanup_failed` → 我方 `E_INTERNAL`），属于语义近似映射。 | P2 |
| E_APP_SSO_FAILED | extra | `lib/error-codes.mjs:171` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：应用单点登录失败）。 | P2 |
| E_ARG_ENUM | extra | `lib/error-codes.mjs:76` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 参数取值不在枚举内）。 | P2 |
| E_ARG_MISSING | extra | `lib/error-codes.mjs:74` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 参数缺失（必填项未提供））。 | P2 |
| E_ARG_REQUIRES | extra | `lib/error-codes.mjs:78` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 参数依赖缺失（如 --share 需要 --tab））。 | P2 |
| E_ARG_TYPE | extra | `lib/error-codes.mjs:75` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 参数类型非法）。 | P2 |
| E_ARG_UNEXPECTED | extra | `lib/error-codes.mjs:80` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 参数不被该子命令接受）。 | P2 |
| E_ARG_USAGE | extra | `lib/error-codes.mjs:81` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：CLI 用法错误）。 | P2 |
| E_AUTH | extra | `lib/error-codes.mjs:126` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：本机鉴权失败）。 | P2 |
| E_AUTH_BUSY | extra | `lib/error-codes.mjs:127` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权通道正被另一请求占用）。 | P2 |
| E_AUTH_CHALLENGE | extra | `lib/error-codes.mjs:128` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权挑战无效）。 | P2 |
| E_AUTH_EXPIRED | extra | `lib/error-codes.mjs:129` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权挑战已过期）。 | P2 |
| E_AUTH_FAILED | extra | `lib/error-codes.mjs:130` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权证明不匹配）。 | P2 |
| E_AUTH_PROOF | extra | `lib/error-codes.mjs:131` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权证明格式或签名字段无效）。 | P2 |
| E_AUTH_STATE | extra | `lib/error-codes.mjs:132` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：鉴权状态机不允许该操作）。 | P2 |
| E_BAD_JSON | extra | `lib/error-codes.mjs:149` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：请求或文件不是合法 JSON）。 | P2 |
| E_BAD_MODE | extra | `lib/error-codes.mjs:104` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：动作模式取值不支持）。 | P2 |
| E_BAD_REQUEST | extra | `lib/error-codes.mjs:150` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：请求格式不合法）。 | P2 |
| E_BAD_SUBCOMMAND | extra | `lib/error-codes.mjs:83` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：未知子命令）。 | P2 |
| E_BROWSER | extra | `lib/error-codes.mjs:159` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：浏览器侧操作失败）。 | P2 |
| E_CACHE_EMPTY | extra | `lib/error-codes.mjs:109` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：缓存为空）。 | P2 |
| E_CAPTURE_BAD_TAB | extra | `lib/error-codes.mjs:52` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：capture 抑制引用的 tabId 非法）。 | P2 |
| E_CAPTURE_LIMIT | extra | `lib/error-codes.mjs:53` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：同一 tab 的 capture 抑制引用超过上限）。 | P2 |
| E_CLICK | extra | `lib/error-codes.mjs:162` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：远程预览点击失败）。 | P2 |
| E_CONFIG_INVALID | extra | `lib/error-codes.mjs:148` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配置项取值无效）。 | P2 |
| E_CONTROL_CONTEXT_INVALID | extra | `lib/error-codes.mjs:38` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：控制面 context_id 缺失/过期/与当前文档或帧不匹配）。 | P2 |
| E_CONTROL_STALE | extra | `lib/error-codes.mjs:182` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：共享标签页的控制权已换代（epoch 不符，需重新读取））。 | P2 |
| E_CURSOR_STALE | extra | `lib/error-codes.mjs:34` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：分页游标已过期）。 | P2 |
| E_DAEMON | extra | `lib/error-codes.mjs:140` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：daemon 不可用（未启动或连接失败，客户端侧码））。 | P2 |
| E_DEBUGGER_BUSY | extra | `lib/error-codes.mjs:119` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：调试器被其它会话占用）。 | P2 |
| E_DEPENDS_FAILED | extra | `lib/error-codes.mjs:40` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：前置依赖步骤未成功）。 | P2 |
| E_DIRECT_RPC_DISABLED | extra | `lib/error-codes.mjs:152` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：直连 RPC 已被关闭）。 | P2 |
| E_DISCONNECTED | extra | `lib/error-codes.mjs:143` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：连接已断开）。 | P2 |
| E_ENV | extra | `lib/error-codes.mjs:147` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：运行环境不满足要求）。 | P2 |
| E_EVAL_CORPUS | extra | `lib/error-codes.mjs:87` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval 语料格式/元数据非法）。 | P2 |
| E_EVAL_DOM | extra | `lib/error-codes.mjs:89` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 层失败）。 | P2 |
| E_EVAL_DOM_ARGS | extra | `lib/error-codes.mjs:90` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 运行参数非法）。 | P2 |
| E_EVAL_DOM_BAD_FACTS | extra | `lib/error-codes.mjs:91` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 事实读取结果非法）。 | P2 |
| E_EVAL_DOM_BAD_JSON | extra | `lib/error-codes.mjs:92` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 事实 JSON 解析失败）。 | P2 |
| E_EVAL_DOM_FIXTURE | extra | `lib/error-codes.mjs:93` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 夹具缺失或不可读）。 | P2 |
| E_EVAL_DOM_NO_BROWSER | extra | `lib/error-codes.mjs:94` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 需要真实浏览器但未找到）。 | P2 |
| E_EVAL_DOM_NO_FACTS | extra | `lib/error-codes.mjs:95` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 未产出事实）。 | P2 |
| E_EVAL_DOM_NO_MARKER | extra | `lib/error-codes.mjs:96` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 页面缺少完成标记）。 | P2 |
| E_EVAL_DOM_SPAWN | extra | `lib/error-codes.mjs:97` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval DOM 浏览器进程启动失败）。 | P2 |
| E_EVAL_RUNNER | extra | `lib/error-codes.mjs:88` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：eval 离线运行器执行失败）。 | P2 |
| E_EXISTS | extra | `lib/error-codes.mjs:106` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：同名资源已存在）。 | P2 |
| E_EXTENSION_GONE | extra | `lib/error-codes.mjs:144` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：浏览器扩展已断开）。 | P2 |
| E_FOLLOW_FAILED | extra | `lib/error-codes.mjs:167` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：跟随新标签页失败）。 | P2 |
| E_JS_ERROR | extra | `lib/error-codes.mjs:112` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：页面内 JS 抛异常）。 | P2 |
| E_KEY | extra | `lib/error-codes.mjs:163` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：远程预览按键失败）。 | P2 |
| E_LEDGER_CONFLICT | extra | `lib/error-codes.mjs:62` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：账本结论冲突（重复 resolve 且结论不一致））。 | P2 |
| E_LEDGER_FSYNC | extra | `lib/error-codes.mjs:60` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：意图账本持久化（fsync）失败）。 | P2 |
| E_LEDGER_IO | extra | `lib/error-codes.mjs:58` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：意图账本读写失败）。 | P2 |
| E_LEDGER_RECOVER | extra | `lib/error-codes.mjs:61` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：意图账本崩溃恢复失败）。 | P2 |
| E_LEDGER_RESOLVE_REQUIRED | extra | `lib/error-codes.mjs:63` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：非幂等动作的 UNKNOWN 必须显式 resolve(confirmed\|not-applied)）。 | P2 |
| E_LEDGER_WAL_IO | extra | `lib/error-codes.mjs:59` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：意图账本 WAL 写入失败）。 | P2 |
| E_LISTEN | extra | `lib/error-codes.mjs:145` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：daemon 端口监听失败）。 | P2 |
| E_MCP_CONFLICT | extra | `lib/error-codes.mjs:170` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：MCP 服务端口/进程冲突）。 | P2 |
| E_NO_DAEMON | extra | `lib/error-codes.mjs:141` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：连不上 daemon）。 | P2 |
| E_NO_DOWNLOAD | extra | `lib/error-codes.mjs:185` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：没有可用的下载）。 | P2 |
| E_OBSCURED | extra | `lib/error-codes.mjs:101` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：视觉坐标落点被铺满视口的元素遮住）。 | P2 |
| E_OUTPUT | extra | `lib/error-codes.mjs:154` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：输出写入失败）。 | P2 |
| E_PAIR_INVALID | extra | `lib/error-codes.mjs:133` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配对码无效或已使用）。 | P2 |
| E_PAIR_REJECTED | extra | `lib/error-codes.mjs:135` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配对 token 已绑定到其它浏览器，请重新配对）。 | P2 |
| E_PAUSED_MANUAL | extra | `lib/error-codes.mjs:136` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话因人工接管而暂停）。 | P2 |
| E_PROTOCOL_AUDIT | extra | `lib/error-codes.mjs:123` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：协议审计失败（proof obligations / 兼容矩阵 / 迁移计划自检不通过））。 | P2 |
| E_QUEUE_FULL | extra | `lib/error-codes.mjs:21` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：daemon 队列已满）。 | P2 |
| E_RATE_LIMITED | extra | `lib/error-codes.mjs:22` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：请求过于频繁）。 | P2 |
| E_READ_ONLY | extra | `lib/error-codes.mjs:202` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话是只读 scope，不能执行变更动作）。 | P2 |
| E_RECIPE_CHANGED | extra | `lib/error-codes.mjs:195` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配方内容已变更）。 | P2 |
| E_RECIPE_DRAFT_EMPTY | extra | `lib/error-codes.mjs:197` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：运行日志里没有可回放的步骤（recipe 草稿为空））。 | P2 |
| E_RECIPE_EXPIRED | extra | `lib/error-codes.mjs:196` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配方已过期）。 | P2 |
| E_RECIPE_LOCKED | extra | `lib/error-codes.mjs:198` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配方正在被另一个进程回放）。 | P2 |
| E_RECIPE_NOT_APPROVED | extra | `lib/error-codes.mjs:194` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：配方未获批）。 | P2 |
| E_RELEASE_INVALID | extra | `lib/error-codes.mjs:168` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：发布信息校验失败）。 | P2 |
| E_REQUEST_CANCELLED | extra | `lib/error-codes.mjs:24` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：请求在排队阶段被取消）。 | P2 |
| E_SESSION_BUSY | extra | `lib/error-codes.mjs:18` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：同一会话已有进行中的操作）。 | P2 |
| E_SESSION_PAUSED | extra | `lib/error-codes.mjs:19` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话已被人工接管（暂停））。 | P2 |
| E_SESSION_STATE | extra | `lib/error-codes.mjs:56` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话状态不允许该操作（状态机拒绝））。 | P2 |
| E_SESSION_TRANSITION | extra | `lib/error-codes.mjs:57` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话状态迁移非法）。 | P2 |
| E_SNAPSHOT_CORRUPT | extra | `lib/error-codes.mjs:70` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：MCP 快照文件损坏或格式不符）。 | P2 |
| E_SNAPSHOT_DISABLED | extra | `lib/error-codes.mjs:68` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：MCP 快照持久化被关闭（BB_MCP_SNAPSHOT=off））。 | P2 |
| E_SNAPSHOT_WRITE | extra | `lib/error-codes.mjs:69` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：MCP 快照写盘失败）。 | P2 |
| E_SPAWN | extra | `lib/error-codes.mjs:146` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：子进程启动失败）。 | P2 |
| E_START_NOT_READY | extra | `lib/error-codes.mjs:30` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话尚未就绪，稍后重试）。 | P2 |
| E_START_PENDING | extra | `lib/error-codes.mjs:29` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：会话启动中，操作尚未就绪）。 | P2 |
| E_TAB_LEASE_HELD | extra | `lib/error-codes.mjs:64` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：tab 已被其它会话租用）。 | P2 |
| E_TAB_LEASE_NOT_HELD | extra | `lib/error-codes.mjs:65` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：tab 租约不存在或已被释放）。 | P2 |
| E_TOKEN_BAD_ARG | extra | `lib/error-codes.mjs:46` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌参数非法（缺 token 或 grantee））。 | P2 |
| E_TOKEN_CAPACITY | extra | `lib/error-codes.mjs:51` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌存储已满且无法驱逐）。 | P2 |
| E_TOKEN_EXPIRED | extra | `lib/error-codes.mjs:48` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌已过期）。 | P2 |
| E_TOKEN_GRANTEE | extra | `lib/error-codes.mjs:50` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌与调用方 grantee 不匹配）。 | P2 |
| E_TOKEN_UNKNOWN | extra | `lib/error-codes.mjs:47` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌不存在或已被清理）。 | P2 |
| E_TOKEN_USED | extra | `lib/error-codes.mjs:49` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：passthrough 令牌已被消费（一次性））。 | P2 |
| E_TRANSFER_INCOMPLETE | extra | `lib/error-codes.mjs:190` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：传输未完成）。 | P2 |
| E_TRANSFER_LIMIT | extra | `lib/error-codes.mjs:189` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：传输超过大小限制）。 | P2 |
| E_TRANSFER_NOT_FOUND | extra | `lib/error-codes.mjs:172` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：传输任务不存在）。 | P2 |
| E_TRANSFER_OFFSET | extra | `lib/error-codes.mjs:188` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：传输偏移不匹配）。 | P2 |
| E_UNKNOWN_FLAG | extra | `lib/error-codes.mjs:82` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：未知命令行选项）。 | P2 |
| E_UNSUPPORTED_REMOTE | extra | `lib/error-codes.mjs:121` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：远程连接不支持该能力）。 | P2 |
| E_UPDATE | extra | `lib/error-codes.mjs:169` | —（无） | 我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：更新流程失败）。 | P2 |

## 复现

```bash
# 1) 生成 matrix.json + 本文件（确定性，二次运行逐字节一致）
node tools/bsk-diff/run.mjs

# 2) 校验仓库内产物是否与生成结果一致（CI 用；不一致退出 1）
node tools/bsk-diff/run.mjs --check

# 3) 打印 JSON 到 stdout（不写文件）
node tools/bsk-diff/run.mjs --json

# 4) 用参照二进制重新执行 56 个 --help，校验快照没过期（需要 windows-x64 环境）
node tools/bsk-diff/run.mjs --probe-exe

# 5) 重新采集 help 快照（仅当参照二进制更新时）
node tools/bsk-diff/run.mjs --snapshot-help
```

单测：`node --test tests/unit/bsk-diff-*.test.mjs`。
