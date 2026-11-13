# 协作控制与人工协助

共享标签页时，人和 Agent 可能同时操作。先同步再动手。

```sh
bridge cooperate sync --session <id> [--policy auto|strict] [--match-text 提交 --context-lines 1]
bridge cooperate wait --session <id> [--timeout 5s]
bridge cooperate handback --session <id>
```

- 首次 `sync` 选定策略（默认 target，`--policy strict` 才换），之后该会话固定；旧扩展不认识 `--policy` 时先升 CLI 并重启 daemon。
- 返回 `context_id`、`observation_id`、`control_policy` 和观察文本。
- 目标动作带 `--context`；strict 下必须带且单次有效，target 下同一 context 可复用，导航或文档替换才吊销。
- 视觉/非目标动作（无目标 `press`、`wheel`、`evaluate`）还要 `--observation`，而且要用最新一次 sync 的收据；补充 observe 不能顶替。
- 过期回 `E_CONTEXT_STALE` / `E_OBSERVATION_STALE`，重新 sync 后再动。
- `wait` 在 1.5s 内检测到可信键鼠输入返回 `human`，停手后 `ready`；`ready:false` 期间不要发页面动作，也不要抢人正在操作的控件。
- 人完成后用 `handback` 交回控制权。

## 决策前校验事实

```sh
bridge click @e3 --context <ctx> --session <id> \
  --expect '[{"target":"#price","field":"text","equals":"$100"}]'
```

- 字段：`text`（精确 textContent，含空白）、`value`、`checked`、`attribute`（配 `attribute` 名，`equals:null` 表示不存在）、`exists`。
- 条件按字面比较，没有正则、求值或空白归一；selector 只查主文档，iframe/shadow 内用 ref。
- 失败回 `E_EXPECT_FAILED`，`data.mismatch` 带 target/field/expected/actual；`--depends-on` 校验同样格式的条件，失败回 `E_DEPENDS_FAILED`。
- ref 只保证是同一个 DOM 节点，不保证业务含义：虚拟列表会复用行，按钮会从“保存”变“删除”。决策依赖记录身份时，用 `{"field":"attribute","attribute":"data-record-id","equals":"42"}` 之类的校验。
- `--settle 300ms` 在动作成功后等余波（上限 5s），不做“网络空闲”判定；校验与输入不是和服务端的原子事务。

## 交接与失败

- 人操作、导航、文档替换都会吊销旧 context；人在编辑时等其结束，不要在输入框里抢字。
- 交接后先 sync，跳过用户已完成的步骤；缺活动历史但页面状态能证明结果时，按结果继续。
- `effect_state: unknown` 说明动作可能已生效：先看页面/业务记录再决定是否重试，绝不重放。
- 失败先读 `error.data`（目标、字段、期望/实际），改决策而不是空等交接。

## 暂停与停止

```sh
bridge session pause <id>     # 除只读方法外动作返回 E_SESSION_PAUSED
bridge session resume <id>
```

只读命令（observe/snapshot/get-html/read/extract/console/network/screenshot/view 等）在暂停时仍可用。
接管浮层上的“暂停 Agent / 交给 Agent”“停止任务”等价于这些操作；`session stop <id>` 结束会话并归还借用标签页。

## 人工协助

登录、验证码、OTP、支付确认等必须本人参与时：

```sh
bridge request-help --reason '请在页面上完成登录，然后继续' --target '#login' --session <id>
```

- 页面出现协助条（说明 + “我先处理好了 / 跳过”），窗口置前；等待默认 180s，可用 `--timeout` 调整（最小 5s）。
- 完成后返回 `{action:done, note}`；用户跳过返回 `skip`；超时返回 `timeout`，CLI 退出码 1，要如实报告而不是重试。
- `allowHelp: false` 时直接 `E_HELP_DISABLED`：不要重开设置或换后端绕过，按现有登录态继续或报告阻塞。
- 不要把验证码/密码写进 reason、备注或日志。
