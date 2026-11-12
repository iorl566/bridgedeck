# 人工协助与错误恢复

## 借用标签页

```sh
bridge tab borrow <tabId> --session <id>
bridge tab return <tabId> --session <id>
```

设置里开启“借用前确认”时，目标标签页顶部会出现确认条；30s 无响应视为拒绝。拒绝返回 `E_BORROW_DENIED`，超时返回 `E_BORROW_TIMEOUT`。不要绕过、不要反复重试，先和用户确认再借。

## 协助请求

登录/验证码/OTP/支付确认等本人步骤用 [cooperation](cooperation.md) 的 `request-help`：

```sh
bridge request-help --reason '请在页面上完成登录，然后继续' --target '#login' --session <id>
```

- 等待默认 180s；用户在协助条点“处理好了”返回 `done`，点“跳过”返回 `skip`，超时返回 `timeout`（CLI 退出码 1）。
- 设置关闭人工协助时直接 `E_HELP_DISABLED`：不要重开设置，用现有登录态继续，或报告具体阻塞。
- 同一操作两次没有进展就请求人工，不要空转；`skip`/`timeout` 后不要立刻重复同一个请求。

## 常见错误

| 错误 | 处理 |
| --- | --- |
| `E_NO_BROWSER` | 让用户确认扩展已加载并连上 daemon（`bridge doctor`） |
| `E_AUTH` / `E_DAEMON` | token 失效或 daemon 连不上：先看 status/日志，别删运行文件 |
| `E_NO_SESSION` / `E_NO_TAB` | 重新 `session start`，或 `tab list` 后 `session rebind` |
| `E_STALE_REF` | 页面已变或 ref 过期，重新 `observe` 取新 ref |
| `E_DIALOG_PENDING` | 先处理对话框，再用 `operation await` 取结果（见 [native dialogs](native-dialogs.md)） |
| `E_SESSION_PAUSED` | 浮层点“交给 Agent”或 `session resume` |
| `E_CONTEXT_REQUIRED` | 目标动作少了 `--context`，先 `cooperate sync` |
| `E_CONTEXT_STALE` / `E_OBSERVATION_STALE` | 导航/人操作后收据失效，重新 sync |
| `E_EXPECT_FAILED` / `E_DEPENDS_FAILED` | 读 `data.mismatch` 的 target/field/expected/actual，改决策而不是重放 |
| `E_PAGE_ERROR` / `E_JS_ERROR` / `E_NAV_FAIL` | 页面是错误页/脚本抛错/导航失败，换目标或让用户处理 |
| `E_CAPTURE_STALE` / `E_CURSOR_STALE` | 截图坐标或观察游标过期，重新截图/重新 observe |
| `E_PROTOCOL_UNSUPPORTED` | 组件版本不兼容，升级 CLI+daemon+扩展后重连 |
| `E_UNSUPPORTED_CAPABILITY` | 当前扩展不支持该能力，换可用命令或升级扩展 |
| `E_DEBUGGER_BUSY` | 目标 tab 被其它 debugger 占用（DevTools/别的扩展），先关掉 |
| `E_INCOGNITO_UNAVAILABLE` | 在扩展详情里允许 InPrivate/无痕模式 |
| `E_NO_FILE_CHOOSER` / `E_NO_DOWNLOAD` / `E_DOWNLOAD_FAILED` | 上传/下载未按预期发生，见 [files](files.md) |
| `E_EXISTS` | 目标文件已存在，确认后加 `--overwrite` |
| `E_RECIPE_NOT_APPROVED` / `E_RECIPE_CHANGED` / `E_RECIPE_EXPIRED` | 配方未审批、步骤被改或审批过期，重新审批 |

## 恢复顺序

1. 先看错误码与 `error.data`，判断是“没执行”还是“可能已生效”。
2. `effect_state` 未知时先观察页面/业务状态，再决定是否重试；绝不为了“刷新状态”重放提交或支付。
3. 两三次同样的失败就停下，报告实际错误与缺失能力，不要换后端、改设置或删文件绕过。
4. 结束时对自己拥有的 session 执行 `session stop`；借用的标签页归还并保持打开。
