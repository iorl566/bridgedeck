# BridgeDeck 0.2.0 深度能力战略：追平四块，并在四个维度做得更强

状态：内部规划，0.1.11 之后启动。
目标不是“变成另一个参考引擎”，而是：

> 在复杂页面控制上达到同一量级，在可验证性、失败安全、本地证据、远程协作上明显更强。

## 1. “更强”的定义

不能只说“代码更多”。0.2.0 用可验收指标定义强：

| 维度 | 参考引擎常见表现 | BridgeDeck 0.2.0 目标 |
| --- | --- | --- |
| 复杂页面动作 | 成功/失败 | 每个写动作返回 **Action Receipt**：ref、revision、effect_state、evidence、recovery |
| 失败 | 返回错误 | **fail-closed**：不确定就 `unknown`，绝不静默 committed |
| 回放 | 重放事件 | **回放安全时间线**：文档/frame 边界显式，跨边界拒绝重放 |
| 证据 | 截图/日志分散 | **本地证据包**：截图 + DOM + 网络 + 时间线，默认不上云 |
| 跨帧 | frame 内操作 | **复合 ref + owner 链投影**，嵌套/OOPIF/滚动/zoom |
| 协作 | 人机状态 | **authority revision + FrameState + capture suppression ack** |
| 远程 | 只读/控制 | 本地优先，远程只拿当前页与 scope 内动作 |
| 评测 | case 通过率 | **tri-state oracle**：passed/failed/unverified，不允许 skip 当 pass |

## 2. 四个深度块

### T1 Identity & Geometry（最高优先）

内容：

- `RefKey = backendNodeId + frameId + cdpSessionId + documentId + revision`；
- 动作通过 CDP `DOM.resolveNode` / `Runtime.callFunctionOn` 定位；
- page-lib 只做页面内回退，不作为主路径；
- OOPIF owner 链：嵌套 iframe、滚动容器、transform、zoom、deviceScaleFactor；
- stable refs 协商；
- revision-bound cursor。

验收：

- 同一 ref 在重渲染/导航/文档重建后返回 `E_STALE_REF`；
- 嵌套 iframe + 滚动 + zoom 下点击命中正确节点；
- 不再出现“返回 ok 但页面没变”。

### T2 Cooperation State

- authority generation / revision；
- FrameState：文档、结构、文本、人类输入、忙碌、滚动、编辑；
- capture suppression：ref-count + 2 rAF ack；
- passthrough token 与 input outcome 配对；
- 人机输入时钟校准。

验收：

- 录制期间 Agent/人类动作归因可重复；
- 暂停/接管/恢复无竞态；
- suppression 结束后页面恢复逐帧一致。

### T3 Record / Evidence

- 每个 document 一个 Port；
- 导航/重建后重新 arm；
- 长截图磁盘分片 + index；
- 视频 fragmented MP4 + 完帧重封装 + 崩溃恢复；
- debug journal/IndexedDB/coverage；
- 本地证据包格式。

验收：

- iframe 菜单/弹窗/导航事件零丢失；
- 崩溃后能恢复截图/视频证据；
- 证据包可离线打开。

### T4 Evaluation

- 25+ browser eval case；
- tri-state oracle：passed / failed / unverified；
- seeded generator + adversarial cases；
- 真实 Edge/Chrome CI lane；
- 每个 case 有 ref/revision/effect 断言。

验收：

- 新能力有 case，不是只靠手测；
- 失败有证据，不是“再跑一次”。

## 3. 比参考引擎更强的四个差异化

### 3.1 Action Receipt

所有写动作统一返回：

```json
{
  "ref": "@e12",
  "frame": { "frameId": 57, "documentId": "..." },
  "revisionBefore": 41,
  "revisionAfter": 42,
  "effect_state": "committed",
  "evidence": { "screenshot": "...", "hit": "...", "observed": "..." },
  "recovery": "observe --force"
}
```

这比“返回 ok”更适合 Agent 自愈和审计。

### 3.2 Replay-Safe Timeline

录制不是事件数组，而是带边界的证据时间线：

- 文档变更、frame 重建、ref 失效都有显式边界；
- 回放遇到边界拒绝；
- 不确定性标 `unknown`。

### 3.3 Local-First Evidence

截图、DOM、网络、时间线打成本地证据包；远程只传当前页与 scope，不传历史。

### 3.4 Zero-Build, 10-Language

保持零构建 UI、10 语言、单文件闭包；不引入 React/WXT 工具链。

## 4. 阶段与发布

### 0.2.0-alpha

- RefKey 注册表 + CDP 路由 + revision fence；
- 单测 + 跨帧 case。

### 0.2.0-beta

- OOPIF owner 链/滚动/zoom 投影；
- VOM layers/visual region；
- cooperation FrameState + suppression。

### 0.2.0-rc

- Record per-document Port；
- 长截图/视频/调试归档；
- eval corpus + CI。

### 0.2.0

- 所有 lane 全绿；
- vendor-clean；
- GitHub 签名 + Edge 提交。

任何阶段不满足：

- 148/148 E2E；
- 新增 case 全绿；
- 无 skip；
- vendor leak clean；
- preflight PASS；

就不发布。

## 5. 不做什么

- 不复制参考引擎的 React/WXT 工具链；
- 不复制 2,600 行 CDP 单体；
- 不引入站点/地域特判；
- 不为“更强”牺牲 fail-closed 与有界内存；
- 不用 skip 或“看起来通过”换绿色。

## 6. 风险

1. CDP backendNodeId 路由会动 observe/action 主路径，需 feature flag 与回退；
2. OOPIF owner 链在跨源/缩放/滚动下容易错，需要几何 case；
3. cooperation 状态机容易竞态，需要注入式测试；
4. eval corpus 需要维护成本，必须有 CI 预算。

## 7. 第一个可交付

`RefKey` 注册表 + revision fence：

- 新增 `extension/src/refs/ref-registry.js`；
- observe 返回 `refKey`；
- dispatch 在 `expectRevision` 不匹配时直接 `E_STALE_REF`；
- 单测 + 真实 iframe case。

这一步完成，才谈“比参考引擎更强”。
