# 预写意图账本（Intent Ledger）

变异操作（点击、填表、导航、开窗、计划执行……）在真正下发到浏览器之前，先在 daemon 本地写一条**脱敏**的意图记录。目的是：当操作超时、被取消或连接断开时，页面状态变成"未知"，此时**不允许在同一个标签页上盲目重放**，直到人（或 Agent 在明确检查页面后）确认这条意图。

只读与诊断命令（`observe`、`screenshot`、`get-html`、`status`、`debug.requests`、`ledger.status` 等）不落账，也不受拦截。

## 记录什么

```json
{
  "id": "lt_7e481347",
  "at": "2026-11-13T02:37:20.610Z",
  "method": "navigate",
  "tabId": 1500948262,
  "sessionId": "jjqc",
  "keys": ["session", "url"],
  "state": "done"
}
```

- 只保存方法名、参数**键名**、session/tab id 与时间；
- 不保存参数值（填表内容、密码、token、剪贴板文本都不落盘）。

账本文件：`~/.browser-bridge/ledger.json`（`BB_HOME` 可覆盖），保留最近 300 条。

## 状态

| 状态 | 含义 | 是否拦截同 tab 新操作 |
| --- | --- | --- |
| `active` | 正在执行 | 超过 `staleMs`（默认 15s）后转为 `stale` 并拦截 |
| `done` | 正常完成 | 否 |
| `failed` | 业务失败（如找不到元素） | 否 |
| `unknown` | 超时 / 断连 / 取消，页面状态未知 | **是** |
| `stale` | 进程重启或长时间未完成 | **是** |
| `resolved` | 已由人确认 | 否 |

daemon 启动时会把上一次进程遗留的 `active` 记录标成 `stale`，避免"重启后状态不明却继续操作"。

## 命令

```powershell
bridge ledger status            # 看待确认记录与最近记录
bridge ledger resolve <id>      # 确认该记录（默认 outcome=abandoned），解除拦截
bridge ledger resolve <id> --outcome done
```

被拦截时错误码为 `E_LEDGER_PENDING`，错误信息里带记录 id 与提示。

## 配置

- `BB_LEDGER_STALE_MS`：active 记录的判定超时，默认 `15000`。

## 与 plan / recipe 的关系

- `plan` 整体作为一条意图记录：只要 plan 没正常返回，同 tab 的后续变异操作都会被拦截。
- `recipe` 回放的每个步骤仍走普通 RPC，逐步落账；`recipe approve` 是"流程级"的人工批准，账本是"单步级"的状态保护，两者互补。
