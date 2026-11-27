# 参数兼容层（tool.* → 内部参数）

> 目标：兼容目标 0.5.0 的工具参数名/形状在我方 schema 中可被接受，并映射到既有实现真正消费的内部参数。
> 入口：`lib/schemas.mjs`（接受字段）+ `extension/src/lib/compat-params.js`（归一化）。
> 单测：`tests/unit/protocol-param-compat.test.mjs`。

## 已落地映射

| 方法 | 兼容字段 | 内部行为 |
| --- | --- | --- |
| `read` | `fields` | 转 `fieldsJson`；扩展 read 已支持声明式字段列表 |
| `read` | `timeout_ms` | daemon `sendCommand` 命令等待预算 |
| `extract` | `action`（table/list/discover） | 分发到 `extract.table` / `extract.list` / `extract.discover` |
| `extract` | `target_id` → `target`；`item_selector`；`fields`；`timeout_ms` | 复用既有 extract 定位/字段/分页实现 |
| `drag` | `source` → `from`；`target` → `to`；`delta` → `dx/dy` | 页面拖拽已有 from/to/dx/dy 实现；ref/selector/x-y 都接受 |
| `drag` | `mode`（press-move-release/click-move-click/hold）；`hold_ms`/`duration_ms`；`modifiers`；`timeout_ms` | mode 归一化为 hold/click-move-click；修饰键数组→位掩码；页面动作消费 holdMs/durationMs |
| `wheel` | `ref`/`selector` | 页面 wheel 已在目标元素中心派发 |
| `wheel` | `modifiers` | 数组→位掩码，页面 WheelEvent 设 ctrl/alt/meta/shift |
| `upload` | `mode=input|drop`；`timeout_ms` | input 走文件选择器；drop 走既有拖放上传实现（真实 DataTransfer/DragEvent） |
| `record.start` | `url`/`redact_values`/`trace_version`/`supports_tab_switch_steps` | 接受并校验 trace_version（2/3）；记录参数透传 |
| `longshot.recover` | `scope`（follow/current） | 恢复请求接受 scope，透传扩展 |

## 已接受但语义 partial

- `debug.start` / `debug.request`：BSK tool.debug 的 24 个复合字段（action/run_id/part/pointer/rule/replay/budget/...）已进入 schema；当前实现消费既有 debug.* 子集，复合 action 语义未等价（矩阵 partial P1）。

## 已知限制（未伪装成已实现）

- `record.start` 的 `url`/`redact_values`：当前记录实现未消费（接受但不改变行为）；
- `drag` 的 `duration_ms` 在 trusted 路径按既有 hold/步进实现近似，未做逐毫秒轨迹；
- `tool.debug` 的 24 个字段仍为最大缺口（debug run/part/pointer/replay 复合参数），见 `docs/BSK-REMAINING-GAPS.md`。

## 门禁

- schema 新增字段必须同时更新 MCP 契约（暴露或 `unexposed` 理由），否则 `mcp-schema-audit` 失败；
- 生成物：`node tools/gen-protocol.mjs`、`node sdk/python/gen-tool-catalog.mjs --write`；
- 矩阵：`node tools/bsk-diff/run.mjs --check`。
