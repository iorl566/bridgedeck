# 调试器生命周期与空闲软分离

BridgeDeck 的 `chrome.debugger` 按 **feature 引用计数**管理：对话框、网络、视频、规则、仿真、可信输入等各自 `acquire/release`，最后一个用户释放后决定是否 detach。这样不会出现“会话一开就常驻调试器”的问题。

## 行为

| 场景 | 行为 |
| --- | --- |
| 活动标签页，最后一个 feature 释放 | **立即 detach**，提示条马上消失 |
| 非活动标签页，最后一个 feature 释放 | 保留 75s 空闲宽限；期间同一标签页的新动作直接复用，不再重新 attach |
| 非活动标签页空闲 ≥75s，且无长生命周期 feature | 由 `chrome.alarms` sweeper 分离 |
| 长生命周期 feature 仍持有 | 永不分离，避免丢事件/丢状态 |
| 无法注册 alarms（权限/环境异常） | 退化为“释放即 detach”，不影响正确性 |

长生命周期 feature：`dialog`、`network`、`record`（视频）、`rules-fetch`、`emulate`、`fetch-probe`。被这些 feature 持有时，空闲 sweeper 不会分离。

## 保留什么

- **refs / 观察游标**：页面侧 `__BB_PAGE__` 状态，不随 debugger 分离丢失。
- **对话框策略**：由 `dialog` feature 持有，分离前不会释放。
- **网络/视频/规则/仿真**：同样由 feature 持有，sweeper 不会碰。
- **下载租约**：走 `chrome.downloads`，与 debugger 无关。

## 为什么只对非活动标签页延迟

活动标签页上的调试提示条用户可见；延迟分离只会让提示条更久。非活动标签页的提示条不可见，保留 75s 可以避免 Agent 连续动作时反复 attach/detach 的抖动；用户切回该标签页时，下一条命令会按需重新 attach。

## 实现位置

- 纯判定：[extension/src/debugger-idle.js](../extension/src/debugger-idle.js)（`shouldIdleDetach`）。
- 引用计数与 alarm：[extension/src/debugger.js](../extension/src/debugger.js)。
- 单元测试：`tests/unit/debugger-idle.test.mjs`。
