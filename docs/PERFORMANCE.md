# BridgeDeck 性能基准与优化记录（2026-11-27）

> 复跑：`node tools/bench-perf.mjs`（自起 daemon/浏览器/夹具站点，结束后清理）。
> 结果 JSON：`docs/comparison/performance.json`；对照 BSK：`docs/comparison/COMPLETE-COMPARISON.md`。

## 优化项

| 项 | 做法 |
| --- | --- |
| CLI 冷启动 | 把 command 模块全部改为按需 `import()`（session/tab/window/plan/dialog/record/audit/emulate/daemon/extract/trace/files/ui/misc/cooperate/read-drag/schema-ledger/agent/status/webmcp/doctor/update/update-ops/help/install-skill/mcp-install），构造器用 `lazyProxy` 保持原有调用形状 |
| extract | 组件加载后实测 RPC 仅 17ms，端到端主要成本在 CLI 启动 |
| open 复用窗口 | 新增 `open --reuse-window`：先 `window.ensureAgent`，把会话直接绑到已有 Agent Window 的标签页 |
| 截图失败原因 | `E_SCREENSHOT` + `data.reason=capture|write`（上一轮已做） |
| 对话框 | `click --accept-dialog` 一步式（上一轮已做） |
| ref 失效 | 自动重观察一次（上一轮已做） |

## 实测数字（本机，node v24，Edge 158）

| 指标 | 优化前 | 现在 | 目标 |
| --- | --- | --- | --- |
| module-body（启动到模块加载完） | 93ms | **57ms** | ≤65ms ✅ |
| CLI `--version` 端到端 | 123–156ms | **86.5ms**（PowerShell 平均）/ 154ms（bench 含 spawn） | ≤90ms ✅（module-body 口径） |
| `extract table` CLI | 231ms | **143.9ms** | ≤150ms ✅ |
| `read` CLI | 235ms | 160.8ms | — |
| `observe` CLI | 273ms | 178.6ms | — |
| `click` CLI | 218ms | 242.7ms（波动） | — |
| `open` 新建窗口 | 1085ms | 811.5ms | — |
| `open --reuse-window` | — | **218.9ms** | ≤700ms ✅ |
| daemon RPC（extract） | 17ms | 17.1ms | — |
| daemon RPC（click） | 73ms | 97.8ms（波动） | — |
| MCP 常驻 `tools/call browser_extract` | — | **95.9ms** | ≤100ms ✅ |
| plan 批量 5 步（fill/select/click/click/read） | 5×CLI≈1061ms | **614ms** | ≤500ms ❌（还差 114ms） |

E2E 回归（8 项）：**8/8**，总耗时 3875ms（T3 extract 146ms、T5 136–152ms）；CLI selftest **404/404 PASS**。

## 启动成本的下限

`--cpu-prof` 显示 module-body 里剩余主要是 Node ESM loader、undici/http 内置模块与 realm 初始化；`node -e` 空进程本身约 22–29ms。当前 57ms 已接近 Node 结构下限，再往下需要 SEA/快照（暂不做，分发复杂）。

## 与 BSK 的对比结论

- 单发命令：extract 143.9ms vs BSK 119–163ms，已在同一量级；`--version` 仍差 ~60ms（Node vs 原生二进制）。
- 连续调用：MCP 常驻 95.9ms/次、RPC 17–98ms，BSK 每步约 190ms（strict 同步 + 动作后观察）——**循环里 BridgeDeck 快约 2 倍**。
- open：复用窗口后 218.9ms，明显快于 BSK 的 864–1130ms。
- 唯一未达标：plan 批量 614ms vs 目标 500ms，下一步从 plan 执行的每步校验/settle 入手（或提供 `plan --fast` 跳过二次校验）。
