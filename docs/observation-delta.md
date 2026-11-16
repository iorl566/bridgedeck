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

新增/删除行时 `patch` 是顺序 ops，可本地合并：

```json
{ "delta": true,
  "patch": [{ "op": "insert", "line": 3, "lines": ["  - paragraph: 新行"] }], "changes": 1 }
```

人类可读输出对应 `+`（插入）和 `-`（删除）行。

## mutation log 快路径

page-lib 在首次 `observe` 后挂 MutationObserver（`childList` / `characterData` / `attributes`），并监听 `input/change/focusin/paste/drop` 与 `scroll/resize`。之后每次 `observe`：

- 没有任何 DOM/属性变更、没有输入交互、也没有滚动/缩放 → 直接返回 `unchanged`，**不重建 VOM**；
- 只有文本节点变化（`characterData`）且能定位到上次的 `lineMap` 节点时 → 只重渲染最近祖先子树，返回完整文本并带 `incremental:true`；
- 属性变化（如 `aria-expanded`）、新增/删除节点或找不到映射 → 正常整页重建；
- 结果里带 `mutations: { text, added, removed, attributes, total, structural, layout, interaction }`，方便判断“为什么变了”。

`mutations` 同时用于快路径、增量补丁与诊断；最终补丁仍由行级 diff 生成，所以新增/删除行会走 `structural-text`。

多 frame 页面：默认逐帧观察后合并成带 `frame <id> <url>` 的文本；`--delta` 会改用这份合并文本做基线，只输出帧内变化行。帧内不做单子树增量重渲染（避免帧间序号/顺序变化），但补丁不会误删其它 frame。跨源 iframe 无法从主文档挂 MutationObserver，其变化只能通过逐帧重建进入合并文本。

注入失败的 frame（跨源/沙箱/受限）会用 CDP `Target.setAutoAttach` + per-target AX 兜底，结果里多出 `cdp:true` 的 frame 段（只读文本，不生成 `@eN` ref）；`observe --cdp-frames` 可强制触发，用于诊断。

## 什么时候会回退整页

- 中间段改了 `@eN` ref 序列（可能换了一批节点）；
- 基线 id 不匹配（扩展侧缓存已过期或不是同一次观察）；
- 本地没有该基线的缓存文件（CLI 会重新整页观察）。

新增/删除行本身不再强制回退：用公共前缀/后缀切出中间段，生成 `remove` + `insert` 两个 op 本地合并。回退时结果里带 `baselineReason`（如 `refs`），并返回完整 `observation` 与新的 `observationId`。

## 边界

- 只覆盖主文档；`--frames` 仍走整页多 frame 观察。
- 补丁只包含行号与新内容，不包含旧内容（旧内容在本地基线里）。
- 基线缓存位于 `~/.browser-bridge/observations/<id>.json`（0600），不会上传。
- 文本变化来自页面自身渲染；对被隐藏或敏感字段的遮蔽规则不受影响。
