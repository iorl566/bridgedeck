# 标签页与浏览器配置

## 选择浏览器

- `bridge browsers --json` 列出实例（instanceId、label、browser、版本、localAuth）。
- 多实例时 `session start --browser <id|label|edge|chrome>` 明确绑定；不要靠“最近连接”猜。
- 指定 profile 的任务必须在对应实例里开 session；换实例不能恢复原登录态。
- 实例 label 可在扩展弹窗改；会话进行中不能改。

## 标签页

- Agent 会话默认开独立 agent 窗口，**每个 session 一个自己的窗口**（结束会话时窗口一起关闭）；用户窗口的标签页属于用户。
- 借用：`session start --tab <tabId>` 或在会话中 `tab borrow`；扩展会弹借用确认。该开关只能由用户在扩展设置页修改，Agent/CLI 一侧不可改、也不可用参数绕过。
- 归还在 `session stop`；借用的标签页保持打开，不会被关闭。
- `tab list --scope user|agent|all` 查看归属；`tab new/close/activate` 操作标签页。
- `--tab-id` 可在单条命令上临时指定目标标签页（仍受会话/借用约束）。

## 并行任务

- 每个任务独立 session；同一浏览器可并行多个 session。
- 每个 session 显式 `--session`；不要共享 context/observation。
- 后台任务用 `session start --no-focus`；默认会新建并聚焦独立 Agent 窗口，让用户看得见 Agent 在哪个窗口里操作。
- 并行抓取时注意站点限流；同一站点建议串行或降低频率。

## 共享同一标签页（多 Agent）

- 需要两个 Agent 看/动同一个页面时：主会话 `session start --json` 拿 `tabId`，另一方
  `session start --tab <tabId> --share --json`。两者共用 tab/window，各自独立 context/observation。
- 默认 `open` 模式：双方都能写（命令在 daemon 侧按 tab 队列串行）。只读动作不受限制。
- 需要单写者仲裁时用 `--control exclusive`（或 `session control <id> --mode exclusive`）：
  - 只有控制权持有者能写，其他人的动作返回 `E_CONTROL_NOT_HELD`；
  - 控制权有租约（写动作续租，默认 60s），租约到期后 holder 变空、先到先得；
  - `session control <id>` 看 `holder/epoch/租约`；`claim-control` 认领、`release-control` 放弃、
    `session handoff <持有者> --to <目标>` 显式转交；`--expect-epoch` 防丢失更新（不符 `E_CONTROL_STALE`）。
- 主会话停止时若有共享会话存活：标签页不关，控制权与主会话身份自动转交给最老的共享会话
  （`session stop` 返回 `handedOff`）。
- 两个 Agent 协作写同一页面时，先 `handoff`/`claim-control` 明确谁在写，不要“抢着点”。

## 窗口

`window list|new|close|activate|bounds` 管理窗口；agent 窗口不要随意改尺寸，除非任务需要。
截图/坐标点击前确认视口尺寸与缩放（`emulate` 或窗口 bounds 会改变坐标）。