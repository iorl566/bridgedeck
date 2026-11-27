# Phase D 状态与剩余阻塞（2026-11-19）

## 已完成

- **提取多页游标**（`extract --cursor`：`offset/hasMore/cursor`，10 分钟 TTL、跨 tab/frame/kind/revision
  校验 → `E_CURSOR_STALE`；E2E `15f`；单测 6 条）
- **焦点策略：默认不抢用户焦点**（后台执行靠 `Emulation.setFocusEmulationEnabled`；移除动作/截图路径的
  `Page.bringToFront`/`windows.update({focused:true})`；`--focus` 显式置前；E2E `3`/`20d3`/`20d11`；单测 7 条）
- **嵌套 iframe 链 owner 连接**（按父图 iframe `srcUrl` 匹配子帧，嵌套帧递归接根；E2E `15e`；
  `frame-vom.test.mjs` 9 条）
- **iframe 元素→跨源子图根连接**（`vomFrames.links`/`unlinked`；父图补 `frame:<childId>` 节点 +
  `type:"frame"` 边；E2E `15d`；单测 7 条）
- **跨源 iframe 子图并入 VOM**（`observe --frames --vom`：`f<frameId>:` 命名空间、`frame:<id>` 根、
  `type:"frame"` 边、16 帧/400 节点/800 边上限；E2E `15d`；单测 5 条）
- **AX 父子边并入 VOM 图**（`observe --vom --ax`：`type:"ax"` 边、`ax:<nodeId>` 上下文节点、
  300 边/200 节点上限；E2E `35h`；单测 5 条）
- **结构化提取上限/预算**（16 帧 / 32 target / 8 预览列；`maxRows/maxBytes/maxCells` 预算证据；
  E2E `15b`/`15c`；单测 7 条）
- **VOM 完整关系图**（`observe --vom` 返回 `vom.graph`：完整 containment 到 `documentElement`、
  `label`/`form`/`controls`/`labelledby`/`describedby`/`owns` 边、`nodes[].id/parentId/ancestorIds`；
  E2E `35h`；单测 9 条）
- **节点级动态读取校验**（`--node-scope`：目标节点签名比对、`E_TARGET_DETACHED`、节点级
  `observed_changes`；几何变化只记 advisory；selector/无签名回退整页 revision；E2E `23j4`；单测 10 条）
- 动态读取校验（DOM revision / `E_OBSERVATION_STALE`）
- 共享控制/人工编辑对账（`human_edits_since_sync`）
- 结构化提取跨 frame + 5 分钟句柄
- tab alias/keepOpen 重启恢复（id→URL）
- 沙箱宿主 daemon（`--foreground`）
- 4 authority 快照（readOnly/held 对齐）
- fMP4 验证（MediaRecorder MP4 含 `moof`）
- QuickJS opt-in 沙箱（locator 已支持：同步 page API + 全量 locator；见 `docs/EXEC.md`）
- **QuickJS locator**（`lib/exec-page.mjs` 统一 surface；`cli/exec-quickjs.mjs` 同步契约 + 结构化错误；
  根因是旧 promise 轮询驱动触发 vendored asyncify refcount abort；E2E `20s8`；单测 20 条）
- 自动更新（已有并验证）
- MCP YAML/DSH 深度合并
- 多 Agent session 共享同一 tab（`session start --tab <id> --share`；tab 级队列；E2E `20q10`）
- **共享 tab 的控制权/租约/handoff**（`lib/tab-control.mjs`；`open`/`exclusive` 两种模式、
  租约 TTL 与续租、`claim/release/handoff`、`--expect-epoch` CAS、主会话停止自动转交；
  E2E `20q11/20q12`；单测 `tab-control` 24 条）

## 浏览器矩阵（已按范围收口）

**现状**：Edge **190/190**、Chrome **190/190**（2026-11-19 重跑通过）；官方支持范围限定 Edge/Chrome，其他 Chromium 暂缓。

**尝试**：

- `tools/browser-matrix.mjs`：只有 edge/chrome。
- 国内站点：腾讯/天极管家 stub 或无可解析直链；Brave 网盘；52pojie 需登录。
- `ghfast.top` 下载 Helium 便携版后带扩展启动即退。
- Opera 官方 CDN 安装包签名有效，`/silent` 安装退出 116。

**结论**：按当前决定，官方支持范围限定 **Edge/Chrome**；其他浏览器暂缓，不再作为 Phase D 阻塞。
