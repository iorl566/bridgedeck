# 真实浏览器 E2E Flake 台账（Windows headed）

记录已知环境型 flake、症状与处理策略；用于区分“产品回归”和“环境抖动”。
原则：**先看同一用例是否可复现**；不可复现且无代码变更时，重跑一次 E2E，并把首轮失败写入 eval 的
`firstRunFailures`。CI 不允许静默跳过。

| 用例 | 症状 | 根因/环境 | 处理 |
| --- | --- | --- | --- |
| 20z `--trusted` | `E_SESSION_PAUSED`（antibot focus） | headed 窗口被其它窗口遮挡/焦点丢失 | 用例内先 `window focus`+`tab select`；仍失败则重跑整套 |
| 23u / 23x 人工接管 | UIA 点不到“提交查询”/等待超时 | Windows UI Automation 焦点/时序 | 重跑；保持用例前 `session resume` |
| 20q7 tab group | `tab new` 没返回 `groupId` | 浏览器 tab-group 状态未就绪 | 重跑；CI 不视为代码回归 |
| 20q9 keepOpen | keepOpen 未出现在 keep | idle/cleanup 竞态 | 重跑；本地连续失败再查 |
| 31d 超宽 capture | stdout 空、无 JSON | 浏览器进程偶发 OOM/卡顿 | 重跑；持续复现再查分段拼接 |
| 35 视频录制 | 偶发 `E_SESSION_PAUSED` | 前序人工接管用例残留暂停态 | 35 前自动 `session resume`（已修） |
| 20g video prune | `过期录制仍然在列表里` | 清理计时/TTL 边界，偶发 | 重跑；连续失败再查 prune 时钟 |
| 31f2 分数 DPR | stdout 空（重负载截图） | 浏览器重负载/内存压力 | 重跑；连续失败再查分段拼接 |
| 20d9 record hover | 偶发 hover 未命中 | headed 窗口坐标/滚动 | 重跑 |

## 判定规则

1. 同一用例**连续两次**失败 → 视为回归，必须修代码或测试假设。
2. 单次失败且重跑通过 → 记录到 eval `firstRunFailures`，不阻断发布。
3. 修复优先改**测试隔离/前置状态**（focus、resume、等待），不要用无限重试掩盖。
4. 任何 flake 修复后，至少跑一次 Edge + Chrome 全量 E2E。
