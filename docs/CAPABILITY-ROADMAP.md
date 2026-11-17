# BridgeDeck 能力路线图（对标参考引擎 + 自有创新）

日期：2026-11-17。内部规划文档，不打进发布包。
0.1.9 已完成 148/148 真实 E2E、GitHub 签名发布、Edge 0.1.9 提交审核。

## 1. 定位

不做“参考引擎的轻量复制”。BridgeDeck 的定位是：

> 本地优先、可远程、可审计、fail-closed 的浏览器自动化与协作层。

对标能力用于补齐“复杂页面可控性”，自有创新用于回答“为什么用 BridgeDeck 而不是别的”。

## 2. 自有创新（不跟随）

### 2.1 可验证动作回执（Verifiable Action Receipt）

每次动作返回一个可核验的回执，而不只是 `ok`：

```json
{
  "ref": "@e12",
  "frame": { "frameId": 57, "documentId": "..." },
  "revisionBefore": 41,
  "revisionAfter": 42,
  "effect_state": "committed",
  "evidence": { "screenshot": "...", "hit-test": "...", "observed": "..." },
  "recovery": "observe --force"
}
```

价值：
- 人类/Agent 都能判断“动作到底有没有发生”；
- 失败时不是一句 `not found`，而是带证据与恢复路径；
- 与 fail-closed 结合，杜绝“静默无效果但返回成功”。

0.1.9 已有 `effect_state`/revision/evidence 的一部分；下一步把它统一成所有写动作的契约。

### 2.2 回放安全时间线

录制不是“事件数组”，而是：

- 每个事件绑定 document/revision；
- 导航、frame 重建、ref 失效都有显式边界；
- 回放时遇到边界 **拒绝重放**，而不是猜测。

这比“录下来再点一遍”更适合真实后台。

### 2.3 本地优先的证据包

截图、DOM、网络、时间线可以打成一个本地证据包，不默认上云；
远程 viewer 只拿“当前页 + 只读/点击权限”，不拿完整历史。

### 2.4 零构建、10 语言、单文件 UI

保持零构建 UI 和 10 语言，不引入 React/WXT 工具链；
复杂组件用原生模块化实现，减少发布面。

## 3. 对标路线（P0 → P2）

### P0：观察与引用（0.1.10）

目标：复杂页面的 ref 不 stale，跨帧动作不靠猜。

- [ ] VOM 分层文档：页面层/遮挡层、L1/L2、遮挡原因；
- [ ] 视觉 facts/region：截图区域与 DOM 节点映射；
- [ ] Ref 复合身份：backendNodeId + frameId + cdpSessionId + documentRevision；
- [ ] OOPIF owner-quad 投影；
- [ ] stable refs 协商；
- [ ] observation cursor 与 revision 绑定；
- [ ] token 预算估算可插拔。

验收：
- 新增 30+ 单测；
- 跨源 iframe click/hover/observe 在真实 E2E 全绿；
- 旧 ref 失效返回 `E_STALE_REF` 而不是误点。

### P1：协作与记录（0.1.11）

- [ ] FrameState 计数器（文档/结构/文本/人类/忙碌/滚动/编辑）；
- [ ] authority revision 与 takeover 边界；
- [ ] capture suppression ref-count + 2 rAF ack；
- [ ] per-document Port 的 RecordFrameCoordinator；
- [ ] 导航后重新 arm；
- [ ] 人类输入时钟校准。

验收：
- 录制期间 Agent/人类动作归因可重复；
- iframe 菜单/弹窗/导航事件不丢；
- 失败注入测试通过。

### P2：证据与评测（0.1.12）

- [ ] 长截图磁盘分片 + index；
- [ ] 视频 fragmented MP4 + 完帧重封装 + 恢复；
- [ ] debug journal/IndexedDB/coverage；
- [ ] 25+ browser eval case，tri-state oracle；
- [ ] 浏览器 CI lane（至少 Edge/Chrome 各一条）。

验收：
- 崩溃后可恢复录制/截图证据；
- `eval` 的 passed/failed/unverified 三态可解释；
- CI 上真实浏览器全绿。

## 4. 封装红线

发布包（extension、CLI、Setup、DSH plugin、skill）不得包含：

- 参考实现源码、镜像、研究笔记；
- `bsk` / `BrowserSkill` 等标识；
- 内部 gap/study 文档；
- 任何第三方源码片段。

已加：

- `tools/check-vendor-leak.mjs`：扫描发布目录与扩展 zip；
- `release-preflight` 把它作为 blocker；
- `.gitattributes` 的 `export-ignore` 排除 `ref/`、`reference/`、研究文档。

每次发布前必须：

```powershell
node tools/check-vendor-leak.mjs
node tools/release-preflight.mjs
```

## 5. 不做什么

- 不复制 React/WXT 工具链；
- 不复制单体 2,600 行 CDP 类；
- 不引入站点/地域特判；
- 不为“能力”牺牲 fail-closed 与有界内存；
- 不用 skip 换取绿色。

## 6. 成功标准

不是“代码像参考引擎”，而是：

1. 复杂页面动作成功率和可解释性达到同一量级；
2. 失败有证据、有恢复路径；
3. 远程/协作/审计比参考引擎更本地优先；
4. 发布包干净、可复现、可签名。
