# 事务与恢复：会话、账本、计划、配方的“做没做”边界

> 摘要：哪些操作是事务、崩溃/超时后如何判定 UNKNOWN、如何用 ledger/plan/recipe/journal 恢复，以及直连→CLI 回退边界。

浏览器自动化最难的不是“点一下”，而是**失败之后页面到底有没有被改**。本文件说明 BridgeDeck
在 DSH 插件侧的四个事务边界与恢复方式。工具名以 `browser_*` 为准。

## 1. 会话事务（session lifecycle）

| 阶段 | 工具/命令 | 语义 |
| --- | --- | --- |
| 预写 | `browser_session_start` 内部 `journal.add(token)` | spawn CLI **之前**先把 `request-id` 写进 `dsh-starts.json` |
| 启动 | RPC `session.start_tracked`（优先）/ CLI `session start --request-id` | 同一 token 重试会取回同一个会话，不会产生孤儿窗口 |
| 就绪 | `journal.ready(token, {sessionId,tabId,windowId})` | 返回 `sessionId/tabId/windowId` 后模型才可动作 |
| 结束 | `browser_session_stop` | 借用标签页归还（保持打开）；Agent 窗口关闭 |
| 崩溃回收 | 插件启动时 `recoverOrphanStarts` | 对过期 `starting` 用同一 token 询问 daemon：ready 则 stop，否则标 `stale` |

要点：

- **不要重复 `browser_session_start`**：超时时插件已经用同一 `request-id` 重试过一次；再开新会话会留下第二个 Agent 窗口。
- `browser_session_start` 不是幂等工具（新窗口），`browser_session_stop` 是破坏性工具（关窗口）。
- `journal` 文件在 `BB_HOME/dsh-starts.json`（默认 `~/.browser-bridge`），只存 token/状态，不存页面数据。
- 插件与 daemon 的启动所有权互补：daemon 管会话，插件管“我发起过哪些启动”。

## 2. 意图账本（intent ledger）

用于“动作可能已经发出去了，但结果未知”的场景：

```text
E_LEDGER_PENDING
  → browser_ledger action:status        # 看 pending 意图 id 与目标
  → 用 browser_observe/read 确认页面实际状态
  → browser_ledger action:resolve id:<lt_xxx> outcome:done|abandoned
```

规则：

- **不要为了解除阻挡盲目 `abandoned`**：先确认动作没生效；生效了就 `done`。
- 账本写入在动作派发之前；崩溃/重启后 pending 记录即“UNKNOWN”，必须人工（或模型）核对。
- 同一会话里出现 `E_LEDGER_PENDING` 时，后续写动作会被遮挡，直到 resolve。

## 3. 计划（plan）的“首错即停”

`browser_plan` 把已决定的多步动作一次提交：

- 每步保留自身校验；**第一个失败即停**，已完成步骤不会回滚。
- 返回里有 `completed/total` 与失败步信息；不要整单重放，从失败步之后重建 steps。
- 步骤里不要塞“先观察再决定”的步骤（plan 不做决策）；不确定的步骤先单独 `browser_act` 验证。
- 若 plan 中途超时/断连：先用 observe 核对页面，再构造剩余 steps；已完成部分不可重放。

## 4. 配方（recipe）的审批与锁

```text
browser_record start → 操作 → stop
browser_recipe save <name> --file draft.json     # 生成草稿
browser_recipe approve <name> --confirm-human    # 必须 confirmHuman=true
browser_recipe run <name> [--param k=v]
```

- 未审批运行返回 `E_RECIPE_NOT_APPROVED`；内容变了 `E_RECIPE_CHANGED`；过期 `E_RECIPE_EXPIRED`。
- 另一个进程正在回放时 `E_RECIPE_LOCKED`：等它结束，**不要删锁文件硬闯**。
- `rm` 不可恢复；`approve` 是破坏性动作，审批前必须把内容展示给用户。
- 分支（if/loop/human）内的风险步骤按整体配方风险对待。

## 5. UNKNOWN 态处理原则

任何“动作已发出但没拿到结果”的情况（超时、断连、插件崩溃、daemon 重启）：

1. 不要原样重放（可能重复提交）。
2. 先用只读工具核对页面：`browser_observe`（关键节点/文本）、`browser_read`（字段值）、
   `browser_screenshot`（视觉证据）。
3. 幂等动作（navigate、read、observe）可重试；非幂等（click/fill/press/plan/recipe run）只补
   未生效的部分。
4. 无法判断时报告 UNKNOWN 并请用户确认，而不是赌一次重放。
5. 有账本记录时按第 2 节 resolve。

## 6. 直连 RPC → CLI 回退边界（插件安全阀）

插件优先直连 daemon（`/rpc`），失败时**只在请求尚未到达 daemon** 时回退 CLI：

| 错误码 | 是否回退 CLI | 原因 |
| --- | --- | --- |
| `E_DAEMON` | 是 | daemon 未运行/连接失败，请求没到 |
| `E_DIRECT_RPC_DISABLED` | 是 | `BB_PLUGIN_DIRECT_RPC=0`，直连被显式关闭 |
| `E_TIMEOUT` | 否 | 请求可能已在执行；回退会重放动作 |
| `E_FORBIDDEN` / 其它业务码 | 否 | 业务错误要原样交给模型，不能被 CLI 结果静默替换 |

两个只读例外：`browser_status`（状态查询）即使直连报错也会兜底 CLI；`browser_session_start`
对 `E_TIMEOUT` 会用同一 `request-id` 重试一次（幂等启动），仍失败才上抛。

## 7. 调试/网络/视频的生命周期

这些能力都是“先开后关”的事务：

- `browser_debug action:start` 后必须 `stop`；`bodies:true` 会挂 `chrome.debugger`，与
  `browser_network bodies:true` 互斥（`E_DEBUGGER_BUSY`）。
- `browser_network action:start` 后 `list/detail`，结束 `stop`。
- `browser_video action:start` 返回 `recordingId`，必须 `stop`/`save` 才落盘；中断后
  `browser_video_status` 会显示 `interrupted`，用 `recover` 找回。
- 会话 `stop` 会统一释放调试器与浮层状态。

## 8. 收尾清单

- [ ] 所有 start 都有对应 stop（session/network/debug/video/record）。
- [ ] 借用的用户标签页已归还（session stop）。
- [ ] pending ledger 已 resolve 或明确报告未处理。
- [ ] 失败步骤有明确 UNKNOWN/失败结论与证据，而不是“重试成功所以没发生”。
