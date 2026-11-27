# 多 Agent session 共享同一 tab

## 用法

```powershell
# 主会话
bridge session start --json          # -> sessionId=A, tabId=123
# 第二个 Agent 共享同一 tab（默认 open 模式：共享写）
bridge session start --tab 123 --share --json   # -> sessionId=B, shared=true, ownerSession=A
# 需要单写者仲裁时显式切 exclusive
bridge session start --tab 123 --share --control exclusive --json
```

## 语义

- `--share` 必须配合 `--tab <tabId>`，且该 tab 必须已有一个会话。
- 共享会话与主会话：
  - **同一个 tabId/windowId**；
  - 各自独立的 `context_id` / `observation_id` / DOM revision 校验；
  - 命令在 daemon 侧按 **tab 级队列**串行，避免两个 Agent 的原生输入并发；
  - 上下文被另一个会话的动作改变时，旧 observation 按 `E_OBSERVATION_STALE` 拒绝。
- 共享会话停止：
  - 不关闭 tab、不关闭 window、不移除对话框拦截/控制提示；
  - 主会话继续可用。
- 主会话停止（有共享会话存活时）：
  - **不再关闭 tab**：控制权与“主会话”身份转交给最老的共享会话（`handedOff`）；
  - 被提升的会话 `shared=false`、`ownerSession=null`，之后的 stop 按主会话语义关 tab；
  - 没有共享会话时保持原语义（关 Agent tab）。

## 控制权 / 租约 / handoff

控制记录按 **tab** 维护，字段：

| 字段 | 含义 |
| --- | --- |
| `primary` | 该 tab 的主会话（发起者；主会话停止时按最老存活会话重选） |
| `holder` | 当前写控制权持有者；为空表示控制权空闲 |
| `epoch` | 控制代，每次 holder/primary 变化 +1；用于 CAS（`--expect-epoch`） |
| `mode` | `open`（默认，共享写）或 `exclusive`（单写者仲裁） |
| `leaseExpiresAt` / `leaseMs` | 租约到期时刻与时长（默认 60s，可 `--lease` 覆盖，夹在 1s–600s） |
| `lastTransition` / `history` | 最近一次/最近 5 次转移（reason: create/attach/claim/renew/handoff/release/expire/preempt/promote/rebind/mode） |

### 两种模式

- **open（默认）**：任何共享会话都能写，与 0.3.0 的“共享写”行为一致。租约只记录
  “当前写者”（写动作会认领/续租），不拦动作，便于 `session control` 观察谁在写。
- **exclusive**：同一时刻只有一个会话能写。
  - holder 是自己 → 续租并放行；
  - holder 为空（没人写/租约到期）→ 第一个写动作认领租约并放行（先到先得）；
  - holder 是别人 → 变更动作返回 `E_CONTROL_NOT_HELD`（带 `holder`/`epoch`/`leaseRemainingMs`/提示）。
  - 只读动作（observe/read/screenshot/extract…）永远放行，且不续租。

### 命令

```powershell
bridge session control <id>                     # 查看 tab 控制权/租约/是否本会话持有
bridge session control <id> --mode exclusive    # 切换仲裁模式（open|exclusive，按 tab 持久化）
bridge session claim-control <id> [--lease 60s] [--expect-epoch N]
bridge session release-control <id> [--expect-epoch N]
bridge session handoff <id> --to <targetSessionId> [--lease 60s] [--expect-epoch N]
```

- `claim-control`：holder 为空 → 认领；已是自己 → 续租；被别人持有 → `E_CONTROL_BUSY`；
  **主会话**可以无条件收回被借出的控制权（`preempted` 返回原持有者）。
- `release-control`：只有持有者能放弃；释放后 holder 为空，任意共享会话可再认领。
- `handoff`：只有持有者能发起，目标必须已在该 tab 上；成功即转移 holder 并重置租约。
- `--expect-epoch`：CAS。期望 epoch 与当前不符 → `E_CONTROL_STALE`，避免基于过期控制权
  做转移/释放（丢失更新）。

### 租约到期

租约到期后 holder 变空、`epoch + 1`、`lastTransition.reason=expire`。此后：

- open 模式：任何写动作照常（顺带认领）；
- exclusive 模式：下一个写者认领，其他人继续被拒。

### 与暂停（pause）的关系

`session pause` 仍然是最强的“人工接管”闸门（`E_SESSION_PAUSED`）。控制权是 **Agent 之间**
的写仲裁，二者正交：先过 pause 闸门，再过控制权闸门。

## 安全边界

- 共享会话沿用同一个 tab policy（readOnly/allowedOrigins/keepOpen）。
- 不会自动获得另一个会话的 context/observation；必须自己 sync。
- 控制权判定在 daemon 的 **tab 队列内**执行，判定与派发串行，避免两个会话同时写时都通过检查。
- 这不是“多用户远程共享”；仍是同一 daemon/本机会话。

## 验证

- E2E `20q10`：主会话 A → 共享 B → B observe/click → A 看到变化 → 停止 B → A 继续可用。
- E2E `20q11`：`--control exclusive` 下 B 写被拒（`E_CONTROL_NOT_HELD`）→ 只读仍允许 →
  B 认领 `E_CONTROL_BUSY` → `handoff` 给 B → B 写生效、A 被拒 → 过期 epoch `E_CONTROL_STALE` →
  租约 2s 到期 holder 变空 → B 自动认领 → `release-control` → A 可再写。
- E2E `20q12`：主会话停止 → `handedOff` 给共享会话，tab 存活、被提升会话可继续写 →
  收尾后重建主会话。
- 单测 `tests/unit/tab-control.test.mjs`（24 条）：租约到期、open/exclusive、claim/release/handoff、
  epoch CAS、主会话收回、unregister 晋升、sync 自愈、租约归一、history 上限。
