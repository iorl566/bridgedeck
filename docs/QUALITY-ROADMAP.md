# Quality Roadmap（版本保持 0.3.0）

目标：在不再快速升版本号的前提下，把可维护性、可测试性、故障恢复和性能余量做厚。

## 当前质量门禁（2026-11-19）

- 单测：**882/882**
- reference：**507/507**
- 真实 Edge E2E：**204/204，0 跳过**（Chrome 同批）
- eval corpus：**127/127 passed**
- `extension/src` 循环依赖：**0**
- 文件复杂度：除生成协议外，≤ 1100 行
- method catalog 与 receipt 契约：0 mismatch
- vendor leak：clean
- `source-guard`：clean（192 files）+ 编码守卫 clean（975 文本文件）
- release preflight：PASS（dist 已从 GitHub v0.3.0 恢复）

## 已完成的模块化

- `observation-cursor.js`：cursor 编解码独立；
- `visual-objects.js`：visual region/ref 融合；
- `lib/tab-control.mjs`：共享 tab 的控制权/租约/handoff 状态机（open/exclusive、epoch CAS、sync 自愈）；
- `lib/exec-page.mjs`：bridge exec 的 page/locator 唯一实现与 surface 清单（vm 与 QuickJS 共用，防漂移）；
- `cli/exec-quickjs.mjs`：prelude 由 surface 清单生成，同步契约 + 结构化错误跨边界；
- `extension/src/lib/node-signature.js`：节点级签名比较（identity/text/value/attributes/state/geometry/detached）；
- `page-lib` 的 `node-signature` / `ref-signatures`：节点级动态读取的页面能力；
- `extension/src/lib/vom-graph.js`：VOM 完整关系图规范化（id 规则、边去重、roots、ancestorIds、上限）；
- `extension/src/lib/extract-limits.js`：结构化提取的帧/target/预览列与预算归一化（纯函数）；
- `extension/src/lib/ax-graph.js`：AX 父子边并入 VOM 图（映射/上下文节点/去重/限流，纯函数）；
- `extension/src/lib/frame-vom.js`：跨源 iframe 子图（帧命名空间/根节点/frame 边/限流，纯函数）；
- `extension/src/lib/focus-policy.js`：焦点策略唯一判定点（默认后台、显式 `--focus` 才置前）；
- `extension/src/lib/extract-cursor.js`：提取多页游标（编解码/过期/跨 tab/frame/kind/revision 校验，纯函数）；
- `receipt-methods.js`：回执方法集合；
- `tools/observe-frames.js`：observe-frames 从 observation 拆出；
- `record-ports.js`：per-document record Port 从 bridge 拆出；
- `record-events.js`：record 事件归因/boundary 从 bridge 拆出；
- `tab-attribution.js`：self-created tab/window 归属从 tabs 拆出；
- `controlled-tabs.js`：受控标签页登记从 tabs 拆出；
- `human-decisions.js`：borrow/help 人为决定从 tabs 拆出；
- `borrow-ui.js`：Toast/UI 语言/确认条 + borrowUiRequests/rehome 从 tabs 拆出；
- `tabs-help.js`：request-help / control-hint 从 tabs 拆出；
- `tabs-borrow.js`：`tab.borrow` / `tab.return` 业务主体从 tabs 拆出，tabs 851 → 593 行；
- `borrow-ui.js`：借用 UI 唯一真源（删除 tabs 内重复 rehome/注入）；
- `ui/direction.js`：扩展页首帧方向（RTL 自动 / `?dir=` 覆盖）；
- `cooperation.js`：authority stale 自动对齐 + `E_COOPERATION_STALE` fail-closed；
- `tools/observation-ax.js`：AX 租约/采集/VOM backend 合并（observation 804 → 654）；
- `browser-driver/cdp-*.js`：frames/dialogs/console/network/emulation/sessions 拆为 mixin，chromium-cdp 1743 → 768；
- `lib/frame-matrix.js`：OOPIF owner 投影（仿射 + perspective homography、matrix3d）；
- VOM `visualObjects`：视觉 ref 融合 `stableRef/backendNodeId`，可直接驱动动作；
- `lib/blocking-layers.js`：paint-order 分层（L2 modal/mask、coverage、members）；
- cooperation：passthrough expectation kinds + ±2px/key 匹配 + agentAttributed/humanAttributed；
- `src/tools/webmcp.js`：页面 WebMCP list/call；`tests/fixtures/webmcp.html`；
- `ui/popup.js`：a11y selftest（lang/按钮名/switch/alt）；`docs/STORE-BOUNDARY.md`；
- `src/lib/tab-idle.js`：idle 清理计划；`tab.cleanup` dry-run/keepOpen；
- `src/lib/tab-restore.js`：alias id→URL 对账；`src/tab-alias.js` 持久化本地；
- `src/tab-alias.js`：命名 tab alias + `--tab-id` 解析；`src/tabs.js` 命名标签组；
- `src/tabs.js`：命名标签组（`tab new --group`）；tab.list group 信息；
- 视频：per-chunk `fragments` + sha256 + `video verify`；不做 fMP4 worker（边界见 [VIDEO.md](VIDEO.md)）；
- `src/lib/soft-detach-signature.js`：软分离页面签名 + 重挂判定；
- `src/lib/input-transaction.js`：每 tab 输入事务（pointer/key），过期回收；
- `src/debug.js`：`debug.coverage`（gaps/pinned/complete）；
- `src/tokens.js`：per-line token 预算 + omittedChars/omittedLines；observe `budget`；
- `lib/action-policy.js`：READ/MUTATING 护栏表（fail-closed）；
- `lib/ref-details.js`：identityKey + 跨 backend 稳定 stableRef；
- `src/tab-policy.js`：每 tab readOnly/allowedOrigins；`tab policy` + `tab new` 策略；
- `cli/mcp-config.mjs`：MCP 11 客户端配置合并 + `mcp-install`；
- `lib/human-input.js`：拟人鼠标轨迹；`lib/pixel-diff.js`：YIQ 截图差分；
- `screenshot.js`：`--diff` changed/ratio/bbox；
- 长截图：`fixedBottomHeight` + 页脚带重绘；视频：per-chunk `fragments` 日记；
- observe `issues[]`：facts/layers/observe 阶段失败显式化（并进 `vom.issues`）；
- `lib/longshot-final.js`：整页截图 final exposure；
- 视频记录：`completeness/stop_reason/chunk_count`；
- cooperation `frameState`：mutations/scroll/revision 计数器有 E2E 断言；
- `screenshot.js`：超长页面 CDP 分块拼接（>12000px 自动分块，tiled 返回块数）；
- `tools/observation-ax.js`：AX 采集 + AX 兜底；
- `tools/observation-visual.js`：分层 L2 + 视觉候选 VOM 融合（observation 563）；
- ar/he 全量翻译包：12 语言 ×（251 UI + 54 浮层键）；
- `capture-persist.js`：长截图分片 + manifest 落盘（24h/8 条，自动 prune）；
- `lib/schemas.mjs` + `cli/bridge.mjs`：`stableRef` 统一目标解析，驱动 fill/select/read/hover/actionable/wait-for-element；
- `vom-payload.js`：机器可读 VOM payload（layers/nodes/visual）；
- stableRef 已接入 click：`--stable-ref` → registry → CDP；
- `refs/ref-registry.js`、`refs/resolve-backend.js`、`cross-frame-geometry.js`；
- `architecture-guards.test.mjs`：循环依赖 + 文件预算。

- `page-lib` 内部整理：受单文件注入（`executeScript({files})`）限制，只加 §A–§J 结构索引与分区 banner（纯注释、0 行为变化）；

## 重构经验

见 [REFACTOR-PLAYBOOK.md](REFACTOR-PLAYBOOK.md)：小步、快照、source-guard、失败回滚。

## 架构扩展点

见 [ARCHITECTURE-EXTENSION.md](ARCHITECTURE-EXTENSION.md)：lib/tools/refs/geometry/record/UI 的依赖规则与扩展点。

第一梯队验收清单见 [FIRST-TIER-CRITERIA.md](FIRST-TIER-CRITERIA.md)。

## 下一批拆分

| 文件 | 当前行数 | 拆分方向 |
| --- | ---: | --- |
| `browser-driver/chromium-cdp.js` | 768 | attachment/发送/事件核心（frames/dialogs/console/network/emulation/sessions 已拆） |
| `tools/observation.js` | 563 | observe / layers / visual（AX 已拆到 `observation-ax.js`） |
| `tabs.js` | 593 | agent window registry / tab 操作 / 生命周期 |
| `bridge.js` | 850 | message router / record / control |
| `screenshot.js` | 805 | capture / region / visual hit |
| `overlay-ui.js` | 761 | takeover / borrow / help / toast（RTL 已逻辑化） |

## 新增门禁（已开始）

- performance budgets：RefRegistry/visual/refDetails/method catalog；
- frame identity 归一测试；
- 故障注入：无 backend / 旧 cursor / 旧 replay boundary / 非法 receipt 字段；
- 占位符守卫：任何源文件被写成 `utf8`/编码字符串立即失败；
- `source-guard`：全量 `node --check` + 占位符检查，已接入 release-preflight；
- 编码守卫：文档/源码必须是合法 UTF-8 且不含 U+FFFD（防止 ANSI/GBK 回写把中文写坏），随 `source-guard` 一起跑；
- QuickJS 同步契约回归：`exec-quickjs.test.mjs` 固定「25 次连续 host 调用 + 同进程多次运行 + locator 全量 + 错误码」，
  防止退回旧的 promise 轮询驱动（会触发 vendored asyncify 的 refcount abort）；
- cooperation stale generation：内容脚本真实浏览器断言（`COOP_DOM_OK:8`）、后台自动对齐 + `E_COOPERATION_STALE` fail-closed + E2E `23j2`；
- RTL：真实 Chromium 逻辑布局/图标镜像测试（`RTL_DOM_OK:6`），浮层 RTL 纳入 `OVERLAY_DOM_OK:13`；
- ar/he：全量 UI + 浮层语言包，E2E `29d` 真实渲染（12 语言）；
- OOPIF 矩阵：`lib/frame-matrix.js` 单测 + E2E `23p6/23p7/23p8/23p9`（rotate/skew/scale/matrix3d/perspective）；
- 超大 capture：`31c/31d/31e`（20000 高、16000 宽、35000 高）；
- 超长 capture：>12000px 自动 CDP 分块；E2E `31c`（1241x20000，tiles=3）；
- 视频完帧恢复：E2E `35r`（分片扫描 → 重建 → save → magic 校验）；
- eval corpus：30 → **50**，全量 `node tools/eval-from-e2e.mjs` status=passed；
- 长截图恢复：截图分片写入 IndexedDB + manifest，E2E `31b` 真实重拼（`tiles=1 1241x5739`）；
- 长截图分片 IndexedDB (`bb-longshots`) 已接入面板，并新增“本地分片扫描恢复最新”。

## 新增门禁（目标）

1. **性能预算**
   - observe 纯函数构建 ≤ 20ms（fixture）；
   - ref registry 10k 次操作 ≤ 50ms；
   - eval runner 单 case 超时明确。
2. **故障注入**
   - CDP detach、frame rebuild、port disconnect、storage quota、tab close；
   - 每个故障必须返回明确 effect_state / recovery。
3. **契约测试**
   - method catalog 与 receipt 集合一致；
   - cursor revision/document 不匹配必须 stale；
   - record event boundary 必须带 documentId。
4. **复杂度**
   - 新增源文件 > 800 行必须拆分或写 ADR；
   - 循环依赖为 0，不能新增。

## 版本策略

- 版本保持 **0.3.0**，直到：
  - 上述 4 组门禁全绿；
  - 至少完成 3 个核心文件拆分（tabs/borrow、record、ref、chromium-cdp 已完成）；
  - 下一批能力（VOM/cooperation/capture）有独立 case。
- 本轮不升号、不重新打包：已发布 0.3.0 资产保持不变，发布按“批次”而不是“每天”。

## 提升空间

- ~~VOM stable ref 真正驱动动作（不只元数据）~~（已完成：click/fill/select/read/hover/actionable 等）；
- ~~OOPIF scroll/zoom/transform 矩阵~~（已完成：仿射 + matrix3d + 祖先 perspective homography；多层 3D 仍可加深）；
- ~~cooperation authority 全链路 stale~~（已完成：内容拒绝 + 后台对齐 + E2E）；
- ~~长截图瓦片落盘 + 恢复~~（已完成：IndexedDB + manifest + E2E 31b）；
- ~~视频完帧恢复~~（已完成：E2E 35r 分片重建 + save 校验）；
- ~~eval 从 27 扩到 50+，含 adversarial~~（已完成：51，含 20 adversarial + 21 深度）；
- ~~RTL 翻译包（ar/he）~~（已完成：12 语言；fa/ur 与 bidi 混排仍可加深）；
- `observation.js`（563 行）继续拆 layers/visual；超长页面 capture 与 3D transform 深度；
- `chromium-cdp.js` / `observation.js` / `bridge.js` 继续小步拆分。
