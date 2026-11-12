# 计划、步骤与观察缓存

## cooperate sync

- `bridge cooperate sync --session <id>` 返回 `context_id`（有时还有 `observation_id`）。
- DOM 目标动作把 `context_id` 作为 `--context`；视觉/非目标动作（wheel、坐标点击、截图后点击）还要 `--observation`。
- 导航、人工接管、页面大改后重新 sync；旧 context 继续用会得到 `E_CONTEXT_STALE`。

## plan

一次 sync 后已决定的多步操作可以合并：

```sh
bridge plan --session SID --context ID --steps '[{"action":"fill","ref":"@e3","value":"x"},{"action":"click","ref":"@e5","expect":[{"target":"@e5","field":"text","equals":"保存"}]}]'
```

- 每步仍是普通动作，受同样校验；某步失败会停止并返回已完成步骤。
- 适合表单字段、筛选条件等相互独立的操作；依赖上一步结果、严格策略或不可逆操作分开调用。
- 不要跨导航把旧 ref 放进 plan。

## step

`bridge step --session <id> [--observe] ...` 用于“做一步 → 观察变化”的循环；返回 diff/新增行/可用 ref。
strict 策略下每步前必须 `--context`（必要时 `--observation`）；失败时按返回的 next 建议重试。
频繁 step 会累积观察缓存；页面结构大改时清缓存或重新 observe。

## 观察缓存

- `observe` 的全量结果按会话缓存，分页 cursor 只能在同一缓存内使用。
- 导航、reload、会话 rebind 会清空缓存；旧 cursor 返回 `E_STALE_CURSOR`。
- `--max-tokens` 太小会截断 refs，交互前确认目标 ref 在当前页。
- `snapshot` 是静态语义树，带 @eN；不替代 observe 的可见性/可交互判断。

## 重新规划时机

- 点击后页面跳转/弹层出现；
- 人工接管、暂停恢复、标签页借用归还；
- 出现 `E_CONTEXT_STALE`/`E_STALE_REF`/`E_OBSERVATION_STALE`；
- 反爬挑战、验证码、登录态变化。