# 动作可操作性（actionability）

对标 Playwright/Selenium 的动作前检查：在真正点击/填表前，先确认目标**可见、可用、可编辑、能接住指针事件**。
检查在页面内完成（`extension/injected/page-lib.js`），不额外增加 daemon/扩展 RPC。

## 什么动作会检查

| 方法 | 检查项 |
| --- | --- |
| `click` | 连接、可见、启用、命中测试（遮挡/pointer-events/视口） |
| `hover` | 同上；禁用元素仍可 hover（与 Playwright 一致） |
| `fill` | 上述 + 只读（`readOnly` / `aria-readonly`） |
| `press` | 显式给 `ref`/`selector` 时检查连接、可见、启用、命中测试 |
| `select` | 连接、可见、启用、命中测试 + 自动滚入视口 |
| `drag` | 拖拽起点检查 |
| `scroll-to` / `wheel` / `blur` / `upload` | 不检查（滚动/上传本身就需要隐藏或屏外目标） |

判定顺序：`detached → not_visible → disabled → readonly(fill) → no_area → pointer-events-none → outside_viewport → occluded`。

## 失败时的返回

错误码统一为 `E_NOT_ACTIONABLE`，`message` 带具体原因和目标：

```json
{"ok":false,"error":{"code":"E_NOT_ACTIONABLE","message":"selector #covered 不可操作：目标被遮挡（div#cover）；确认页面状态后重试，或用 --force 跳过遮挡检查"}}
```

原因文案：`目标已脱离文档` / `目标不可见` / `目标已禁用` / `目标为只读，无法填写` / `目标尺寸为 0` / `目标 pointer-events:none，收不到事件` / `目标不在视口内` / `目标被遮挡（tag#id）`。

`E_NOT_ACTIONABLE` 属于"派发前失败"：不会改页面，也不会把意图账本标成 unknown。

## --force 的边界

- `--force` 只跳过**遮挡类**检查：`occluded`、`pointer-events-none`、`outside_viewport`。
- 不可见、禁用、只读、已脱离文档仍然拒绝——避免“强制”把动作发到完全不可用的目标上。
- `click --trusted` 的 `--force` 仍沿用原语义：跳过 CDP 命中测试，直接按坐标派发。

## 扩展浮层不算遮挡

`__bb_*`（接管条、借用确认、帮助卡片等）属于扩展自己的 UI，命中测试会放行；需要隐藏浮层时由 `withOverlaysHidden` 单独处理，避免 Agent 被自己的浮层挡住。

## Agent 输入不会被误判为人工接管

CDP 派发的鼠标/键盘事件在页面里同样是 `isTrusted=true`。现在：

- 页面 human watcher 识别 `data-bb-agent-input` 抑制标记；
- 后台在 `click/fill/press/select/drag/wheel/upload/download/click-point` 等命令执行窗口内忽略 `human.input`。

因此文件选择器、可信点击不会再把会话自动切到 paused。

## 自动等待与稳定采样

- 默认最多等待 **5000ms**：目标暂时不可见、禁用、只读、被遮挡或在视口外时，每两帧重新采样一次，满足条件后再动作。
- 满足条件后还要求**连续两次采样 rect 一致**（stable），避免动画/懒加载导致点到旧坐标。
- `--wait-timeout 0` 关闭等待与稳定采样，退回单次判定；也可给任意毫秒数（如 `--wait-timeout 800`）。
- `--force` 跳过遮挡类检查并立即动作（不再等 stable），但不可见/禁用/只读仍会等待到超时后拒绝。
- 目标**不存在**时仍然立即返回 `E_NOT_FOUND`，不会等 5s；需要等元素出现用 `wait-for-element`。
- 超时错误会带 `（已等待 Nms）`，便于判断是状态问题还是超时问题。

## 目标短暂消失时的重试

- 显式 `--wait-timeout > 0` 且目标是 CSS selector 时，`E_NOT_FOUND` / `E_STALE_REF` 会在超时内重试（约 50ms 间隔），适配 SPA 重渲染、懒加载、列表替换。
- 未显式给 `--wait-timeout` 时保持快速失败：目标不存在立即返回 `E_NOT_FOUND`，避免拼错 selector 还等 5s。
- `ref` 目标不重试——ref 失效应重新 `observe`，盲目重试旧引用没有意义。
- **动作中被替换**：selector 目标在等待/聚焦期间 detach（例如 React 重新渲染替换节点），且同一 selector 已能解析到新节点时，自动重跑一次动作；如果 selector 已不存在则直接失败，不重复等待。
- 覆盖 `click / fill / press / select / hover`；`drag` 等复合动作仍单次执行。

## 点击后等待导航

`click --wait-navigation` 会在点击后轮询 `location.href` 与 `document.readyState`：

- URL 变化且 `readyState=complete` → 返回 `navigation: { navigated: true, url, waitedMs }`；
- 最多等 8s；没有导航则返回 `navigated: false`，不视为失败；
- 适用于“点击链接/提交按钮后紧接着读新页面”的场景，省去单独 `wait-for-navigation` 的竞态（导航可能在 click 返回前已开始）。

## 性能

稳定采样需要约两帧（前台标签约 32ms，后台节流时最多 60ms）。`fill --trusted` 的快路径（`fill-focus → Input.insertText → fill-verify`）不经过这层检查，仍保持 ~14ms；raw click/fill 增加约 20–50ms。

## 尚未实现

- **动作失败重试**：Playwright 在动作中途被拦截时会重试；目前只做动作前等待，不做动作后重试。
- 结构化错误 `data`（reason/target/rect）：目前原因在 message 里，便于模型阅读。
