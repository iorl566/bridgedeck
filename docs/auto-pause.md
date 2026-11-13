# 自动暂停语义（auto-pause）

阈值与行为对齐上游共享控制实现（`QUIET_MS = 2_000`、`IDLE_RESUME_MS = 3_000`）。

## 两种暂停来源

| 来源 | 触发 | `pausedBy` | 能否自动恢复 |
| --- | --- | --- | --- |
| 人工暂停 | 浮层「暂停 Agent」按钮、`bridge session pause <id>` | `manual` | **否** |
| 自动暂停 | 受控标签页检测到用户真实输入（可信事件） | `auto` | **是** |

所有既有入口默认 `manual`；只有显式 `--reason auto`（内部调用）才标记为自动。自动触发默认开启（与上游一致）。

## 常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `QUIET_MS` | 2,000 ms | 距最近人类输入 < 2s 视为"人还在操作" |
| `IDLE_RESUME_MS` | 3,000 ms | 距最近 Agent 活动 ≥ 3s 才允许空闲自动恢复 |

## 自动恢复规则

`bridge sync`（`cooperate.sync`）时同时满足：

- `pausedBy === 'auto'`；
- `now - pausedAt ≥ QUIET_MS`（人类至少安静 2s）；
- `now - lastAgentActivity ≥ IDLE_RESUME_MS`（Agent 至少空闲 3s）。

则自动恢复（`paused=false`，`pausedBy=null`），并推送 `takeover.state`。

人工暂停永不自动恢复：`resume --auto` 遇到 `manual` 返回 `E_PAUSED_MANUAL`。

## 窗口 blur

页面侧 `window.blur` **立即释放编辑/交互占用**（指针、输入法组合、拖拽、按键、编辑状态清零，`editing=false`），但**不结束也不恢复整个会话**；会话恢复仍走上面的 sync 空闲条件。

## 不变量

- 自动恢复不重置 ledger；恢复后第一个变异操作仍要过账本检查。
- 自动恢复不发 `takeover.hide`，只更新 `takeover.state.paused=false`，浮层保持可见。
- 自动暂停期间所有变异命令仍返回 `E_SESSION_PAUSED`；只读命令不受影响。
- 人类输入时间戳只保存在扩展内存，不落盘、不上传。

## 命令与字段

```powershell
bridge session pause <id> --reason auto    # 内部/测试用
bridge session resume <id> --auto          # 仅对 auto 暂停生效
bridge session resume <id>                 # 人工恢复，任何来源都可
```

`session.pause` 返回 `{ paused, pausedBy }`；`takeover.state` 同样带 `pausedBy`。

## 仍未实现

- 受控页可信输入 → 自动 `session.pause reason=auto`（页面监听 + 扩展消息）；
- 页面 blur 后把 `editing` 状态回报给扩展（当前仅文档化语义）。
