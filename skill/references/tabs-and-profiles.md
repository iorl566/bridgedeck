# 标签页与浏览器配置

## 选择浏览器

- `bridge browsers --json` 列出实例（instanceId、label、browser、版本、localAuth）。
- 多实例时 `session start --browser <id|label|edge|chrome>` 明确绑定；不要靠“最近连接”猜。
- 指定 profile 的任务必须在对应实例里开 session；换实例不能恢复原登录态。
- 实例 label 可在扩展弹窗改；会话进行中不能改。

## 标签页

- Agent 会话默认开独立 agent 窗口；用户窗口的标签页属于用户。
- 借用：`session start --tab <tabId>` 或在会话中 `tab borrow`；扩展会弹借用确认（可在设置关闭确认）。
- 归还在 `session stop`；借用的标签页保持打开，不会被关闭。
- `tab list --scope user|agent|all` 查看归属；`tab new/close/activate` 操作标签页。
- `--tab-id` 可在单条命令上临时指定目标标签页（仍受会话/借用约束）。

## 并行任务

- 每个任务独立 session；同一浏览器可并行多个 session，但不要并发操作同一标签页。
- 每个 session 显式 `--session`；不要共享 context/observation。
- 后台任务用 `session start --no-focus`（默认就不抢焦点）；用户明确要求时才聚焦。
- 并行抓取时注意站点限流；同一站点建议串行或降低频率。

## 窗口

`window list|new|close|activate|bounds` 管理窗口；agent 窗口不要随意改尺寸，除非任务需要。
截图/坐标点击前确认视口尺寸与缩放（`emulate` 或窗口 bounds 会改变坐标）。