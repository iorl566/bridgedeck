# 观察文本增量（Observation Delta）

大页面反复 `observe` 时，如果页面只是**可见文本在原地替换**（时钟、计数器、状态行），没必要每次重传整页语义树。BridgeDeck 支持行级增量补丁。

## 用法

```powershell
# 第一次：整页观察，记下 observation id
bridge observe --delta
# observation: ob_1500_063559892dc9（用于 --delta --baseline）

# 之后：只取变化行
bridge observe --delta --baseline ob_1500_063559892dc9
# delta: 1 行变化（基线 ob_1500_063559892dc9）
#   L3:   - paragraph: 计数器：54

# 需要合并后的完整文本时写到文件
bridge observe --delta --baseline ob_1500_063559892dc9 --out merged.txt
```

`--json` 下返回：

```json
{ "delta": true, "baseline": "ob_...", "observationId": "ob_...",
  "patch": [{ "line": 2, "value": "  - paragraph: 计数器：54" }], "changes": 1 }
```

## 什么时候会回退整页

- 行数变化（新增/删除节点）；
- 任何一行的 `@eN` ref 序列变化；
- 基线 id 不匹配（扩展侧缓存已过期或不是同一次观察）；
- 本地没有该基线的缓存文件（CLI 会重新整页观察）。

回退时结果里带 `baselineReason`（如 `line-count` / `refs`），并且仍然返回完整 `observation` 与新的 `observationId`。

## 边界

- 只覆盖主文档；`--frames` 仍走整页多 frame 观察。
- 补丁只包含行号与新内容，不包含旧内容（旧内容在本地基线里）。
- 基线缓存位于 `~/.browser-bridge/observations/<id>.json`（0600），不会上传。
- 文本变化来自页面自身渲染；对被隐藏或敏感字段的遮蔽规则不受影响。
