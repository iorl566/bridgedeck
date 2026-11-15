# 运行时决策：CLI / MCP / 插件直连 / 原生 thin client

> 日期：2026-11-15　　状态：MCP/常驻为主路径；插件直连已落地；原生 thin client 暂缓。
> 数据：050g 九站基准、MCP 常驻微基准、插件直连实测；环境 Windows + Node 22、Edge 157。

## 1. 要解决的问题

页面侧能力已完整，剩余差距集中在**进程启动**：

| 指标 | CLI | MCP 常驻 | 插件直连 |
| --- | --- | --- | --- |
| 冷启动 | 72–86 ms | — | — |
| observe | 186 ms | 12 ms | warm 9 ms |
| session start | 367 ms | 163 ms | 144 ms |
| 截图 | 358 ms | — | 194 ms |
| `--unverified` | 156 ms | 20 ms | — |

结论：差距不是 daemon/扩展/协议，而是 **Node 进程启动 + CLI 模块加载**。

## 2. 可选路线

### A. MCP / 常驻进程作为主路径（推荐）

- 已有：MCP server 常驻、DSH 插件常驻。
- 收益：observe 12ms、start 163ms；零新运行时。
- 代价：需要调用方支持 MCP/插件；脚本/CI 仍走 CLI。
- 落地：交互/Agent 优先 MCP 或插件；CLI 用于脚本与运维。

### B. 插件/DSH 直连 daemon（已实现）

- 实现：`dsh-plugin/lib/daemon-rpc.mjs` 读取 `daemon.json` + token，直接 POST `/rpc`；
  `browser_observe` / `browser_status` / `browser_session_start|stop` / `browser_navigate` / `browser_act` /
  `browser_read` / `browser_screenshot` / `browser_tab*` / `browser_window` 均走直连快路径；
  session 启动带 requestId 走 `session.start_tracked`，插件 journal 先 add 后 ready，超时用同一 token 重试；
  任何“请求未到 daemon”的失败自动回退 CLI；业务错误不重试，避免动作重复执行。
  `BB_PLUGIN_DIRECT_RPC=0` 可强制关闭直连。
- 实测：observe 首次 34ms、warm 9ms；read 5ms；focus 27ms；截图 194ms；session.start 144ms；
  tab.list 14ms；window.list 4ms；session.stop 78ms。
- 真实冒烟：`BB_SMOKE_BROWSER=<instanceId> node tests/plugin/smoke.mjs`，11/11，0 次 CLI 回退。

### C. 原生 thin client

- 可达 16–30ms，但本机无 rustc/gcc/clang；需引入工具链与二进制分发、签名、更新通道。
- 维护成本高，且只优化 CLI 路径；MCP/插件路径已无此问题。
- 建议：仅当 CLI 冷启动成为交付硬指标时再投入。

### D. 其他运行时

- Bun 脚本 52–55ms，仍慢于目标；`bun --compile` 在本机失败（ENOENT）。
- .NET 当前仅 runtime-only，无 AOT/单文件发布能力；Go 未安装。
- 均不能稳定达到 30ms 以内，收益有限。

## 3. 建议

1. **对外把 MCP / DSH 插件作为首选集成方式**，CLI 定位为脚本/运维/兜底。
2. 插件直连已覆盖高频工具，后续仅按需扩展低频工具。
3. 原生 thin client 暂缓，除非出现“CLI 必须在 30ms 内完成”的硬需求。

## 4. 衡量标准

- 插件 `browser_observe` P50 ≤ 40ms（实测 warm 9ms，已达标）。
- 真实直连冒烟 11/11 通过且 0 次 CLI 回退（已通过）。
- CLI 冷启动保持现状即可；页面侧 observe/evaluate 不回退。
- 回归门禁：单测 955、CLI 155、MCP 10、插件 26、E2E 141/143。

## 5. 影响

- 不改协议、不改扩展、不改 daemon；仅新增插件侧 HTTP 客户端与兜底逻辑。
- 与 SDK 共用 `daemon.json`/token/`/rpc` 约定，避免第二套协议。
