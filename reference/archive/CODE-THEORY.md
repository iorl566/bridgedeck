# BridgeDeck 代码理论 v1

> 来源：对 BSK 0.5.0 扩展、CLI、协议、VOM、协作、捕获、测试/评测与打包代码的分子系统研读。
> 研究笔记索引：[BSK-0.5.0-STUDY.md](BSK-0.5.0-STUDY.md)。11 份子系统笔记在
> [`docs/bsk-study/`](bsk-study/)，覆盖 transport/session、CDP/焦点/帧、observation/VOM、
> 输入与文件事务、共享控制、捕获/视频/调试、overlay/i18n、daemon/IPC、协议、测试/评测、
> DSH 插件、文档/规范。
>
> 这不是“照抄 BSK”。BSK 约 9 万行扩展代码里，很大一部分是浏览器异步边界、焦点/可见性、
> 文档身份、跨帧几何和失败补偿的守卫；我们的目标是**吸收这些不变量**，而不是复制它的框架、
> 依赖和体量。

## 一句话结论

BSK 的核心不是“工具多”，而是**把浏览器自动化当成一个有明确状态、身份、效果和清理语义的
分布式系统**。BridgeDeck 要变强，优先补的不是工具数量，而是：

1. **身份**（attachment / session / tab / document 的 generation）；
2. **效果**（none / committed / unknown，禁止在 unknown 后自动重放）；
3. **所有权**（单写者、预留、清理、写前日志）；
4. **边界**（能力/版本在产生浏览器副作用之前失败关闭）；
5. **证据**（可执行的测试和明确的 coverage/gap）。

## 十二条定律

### 1. 契约先于实现

协议不是“调用格式”，而是产品。方法名、owner、effect、参数、结果和特性下限应当来自同一份
目录；CLI、daemon、扩展、SDK 从它派生，而不是各自手写白名单。

- BSK：`method.rs` 的 `methods!` 宏 + 生成 schema + `protocol:check`。
- BridgeDeck：`lib/methods.mjs` / `lib/protocol.mjs` / `lib/schemas.mjs` 已是雏形，但特性表
  只覆盖 `read/plan/unverified/expect/delta`，且没有把“方法需要哪些特性”集中成目录。
- 规则：新增可选参数必须同时声明协议下限、旧端行为和产生副作用前的拒绝路径。

### 2. 效果必须可判定

任何可能已经触达页面的调用，结果必须带 `effect_state`：

```text
none       确定没有产生浏览器副作用
committed  已产生并已确认
unknown    可能已产生，禁止自动重放
```

BSK 在 `window_resize`、输入就绪、借用回滚中反复使用这个三态（`window.ts:295-308`、
`input-readiness.ts:282-338`、`tabs.ts:1032-1043`）。BridgeDeck 的错误多数只有 code/message，
没有统一 effect。规则：

- 超时/取消发生在“已派发”之后 ⇒ `unknown`；
- 清理失败不得把 `unknown` 改写成 `none`；
- `unknown` 后不自动重试，先读应用记录。

### 3. 一个资源，一个写者

同一 tab 的输入、导航、截图、录制、调试和焦点必须串行化，且所有权必须能在异步边界后
重新确认。

- BSK：per-session command queue、borrow reservation、`tabOwners`、focus lease、cleanup
  owner。
- BridgeDeck：`lib/session-queue.mjs`、`extension/src/input-lease.js` 已有基础，但
  borrow 的“先预留再 await”和跨 session 所有权仍不完整。
- 规则：任何 `await` 之前先拿 reservation/lease；await 之后重新验证 owner 和 generation。

### 4. 身份要能 fence 异步续体

“这个 tabId 还是同一个页面/同一个调试连接吗？”不能靠时间猜。BSK 用：

- `attachmentId` + 单调 `attachmentVersions`；
- root/child document signature（frameId/loaderId/url/backendNodeId）；
- session `generation`、request token、tab claim token。

BridgeDeck 的 `debugger.js` 有 attachment 概念，但缺少统一的 version fence；idle soft-detach
后 ref 可能在文档替换后继续存活。规则：每个异步回调进入时先 `checkActive(identity)`；
stale 就返回 `stale_*`，不执行清理之外的动作。

### 5. 先观察/守卫，再行动，再验证

动作不是“发一个 CDP 命令”，而是：

```text
observe → resolve exact node → policy/readiness guard → dispatch → verify postcondition
```

- ref 是节点身份，不是记录；文档 revision 变化让 ref 失效；
- `expect`/precondition 是业务事实守卫，不是可选装饰；
- 目标被遮挡、不可见、未聚焦、跨帧坐标错误，都应在派发前失败；
- 派发后验证值/焦点/导航，而不是把“命令返回 ok”当成功。

### 6. 能力边界失败关闭

新参数在旧扩展上被静默忽略，比报错更危险。BSK 在派发前检查每个特性的 daemon/extension
协议下限，返回 `unsupported`，并说明 component/required/actual/feature/effect_state。

BridgeDeck 的 `featureShortfall` 已做了一半；缺的是**完整目录**和**可观测状态**。原则：

- 省略参数保持旧语义；显式请求新特性必须检查；
- 不支持就拒绝，不降级成语义不同的操作；
- `status`/`doctor` 显示兼容性，不靠猜。

### 7. 所有权写前日志，清理可重试

会话启动、借用、下载、录制、安装都可能在中途崩溃。BSK 的模式是：

- caller 生成 request token；
- 先持久化 intent/journal，再产生浏览器副作用；
- 失败保留原身份，允许重试清理；
- cleanup 只释放本请求获取的东西，不恢复页面/用户状态。

BridgeDeck 已有 `session.start_tracked`/`prepare/claim/cancel`，应继续把“写前日志 +
可重试 cleanup”作为所有资源型操作的标准。

### 8. 有界工作与准入控制

浏览器可能永远不回复。每个等待都要有预算，并且预算结束后**调用方的等待结束，不等于
Chrome 的工作结束**。BSK 的 read gate 在超时后拒绝后续读，直到 Chrome settle 或 session
detach；分页/观察有 token/byte/node budget；视频/截图有硬上限。

规则：

- 超时后不重入同一资源，返回 `blocked`/`unknown`；
- 所有观察结果带 `truncated`/`coverage`/`unavailableFrames`；
- 队列有容量和公平性，不能无限堆积。

### 9. 纯函数做决策，状态机做执行，适配器做 I/O

BSK 最好的部分不是“一个大类”，而是可测试的层次：

```text
pure:     frame graph、lifecycle predicate、layer detection、token estimate
stateful: attachment、session、cooperation、capture state machine
adapter:  chrome.debugger / tabs / windows / storage / WS
```

BridgeDeck 应保持零依赖，但把 `daemon/server.mjs`、`cli/bridge.mjs` 中可纯化的部分提取为
小模块；不要把“轻”理解成“全塞进一个文件”。

### 10. 测试是契约，不是覆盖率

BSK 的测试分层值得吸收：

- pure unit：frame graph 的畸形树/环/5000 深度；
- fake adapter：`CdpDebuggerApi` 注入，85 个 attach/detach/dialog/deadline 用例；
- browser test：焦点/点击/拖拽/遮挡，真实 Chromium；
- eval corpus：case JSON + site/response/adapter 三类断言，缺 adapter 证据记为
  `unverified`，不是 pass。

BridgeDeck 当前 `tools/e2e.mjs` 把 skip 记成 `ok:true`，是“未测试=通过”的风险；应引入
case/oracle 层，并让 CI 至少跑一条真实浏览器 lane。

### 11. 缺口是数据，不是沉默

“没看到”和“看到了但没有”必须区分。BSK 的 `unavailableFrames`、`coverage[]`、
`completeness/stop_reason`、`redacted` 字段都是给调用方的证据。

规则：观察/捕获/调试结果必须显式列出缺的 frame、被裁剪的节点、被脱敏的字段、失败阶段；
调用方据此决定是否重试，而不是从“结果少了一点”猜测。

### 12. 轻量不等于少守卫

“变轻”应该来自：

- 删不可达代码；
- 用表/生成替代重复；
- 用小模块替代大杂烩；
- 用状态机替代散落 flag。

不能来自：

- 删掉身份/fence/清理；
- 把错误变成 `.catch(() => {})`；
- 把 unknown 当 none；
- 把测试 skip 当 pass。

## BSK 的能力地图（我们应该学什么）

| 层 | BSK 的关键能力 | 我们的现状 | 结论 |
| --- | --- | --- | --- |
| transport | 纯字节管道、generation、指数退避、握手先于业务 | `ws-client.js` 有连接状态和重试，但无 per-socket generation | 补 generation + settled |
| driver | attach identity、read gate、soft-detach signature、frame graph | 有 CDP/driver/frame graph，缺 fence/投影 | P0 |
| observation | VOM 6 阶段漏斗、ref identity + revision、token budget、layers | 有 observe/scan/token/delta，ref 身份弱 | P1 |
| input | 单一 ref|selector、hit-test、press/release finally、input readiness | 有输入事务和 hit-test，focus/ready 不统一 | P0 |
| cooperation | 双权威、epoch/generation、capture suppress、passthrough | 有锁/read/mode/target，状态粒度不足 | P1 |
| capture | 磁盘分片、页脚重绘、fragmented MP4、journal/IndexedDB | 内存 canvas/Blob、无恢复 | P1 |
| daemon | lock、probe/verify、per-session queue、cancel 顺序 | 有队列/健康检查，无 lock/pid 校验 | P0 |
| protocol | method 目录、两轴版本、错误 taxonomy、生成物 | 有 schema/feature 雏形，目录不完整 | P1 |
| tests | fake adapter、browser lane、case oracle | 单测多、真实浏览器 CI 缺 | P1 |
| UI/i18n | 完整 locale 包、a11y、theme token | 10 语言已做，a11y/RTL 未做 | P2 |

## 应该拒绝的 BSK 做法

1. **一个 2614 行的 ChromiumCdp 类 + 35 个 Map**：不复制；拆成 attachment / signatures /
   frame discovery / dialog 四个协作对象。
2. **React/WXT/命名空间 i18n 依赖面**：我们的运行时保持原生 ES modules；概念可借用，框架不搬。
3. **无界字符串/无界 stdout**：`session_id`、`selector`、`ref` 必须有长度/字符约束。
4. **把 skip 当 pass、把测试计时器改快**：测试必须能 gate。
5. **用 `.catch(() => {})` 吞掉焦点/清理失败**：必须带 effect_state/cleanup_error。
6. **两套同名常量/两套真相**：协议常量和 feature floor 只能有一个来源。

## 我们的目标架构

```text
cli/                 verb-noun commands, JSON/human rendering, no business state
daemon/              lifecycle, lock/probe, queues, routing, auth, journal
lib/                 pure protocol, policy, errors, schemas, feature catalog
extension/src/
  transport/         pure frame pipe + generation + handshake
  browser-driver/    attachment identity, read gate, frame graph, geometry
  tools/             action handlers: observe → guard → dispatch → verify
  observation/       ref store + revision + layered scene + token budget
  cooperation/       authority state machine, capture suppression
  capture/           disk-backed screenshot/video/debug evidence
  ui/                zero-build pages, i18n, a11y
tests/
  unit/              pure contracts
  driver/            fake chrome.debugger matrix
  browser/           real Chromium lane
  eval/              case JSON + tri-state oracle
```

## 优先优化路线

### Sprint A — 安全脊柱（P0）

1. **Attachment identity/fence**：`attachmentId` + `attachmentVersions`；所有异步续体检查；
   idle soft-detach 前捕获 document/child signature，重连时决定复用/失效。
2. **Input readiness**：一个 `withInputReady` 入口：可见性采样 → 恢复/安装焦点 override →
   再采样 → 双 rAF → 文档 revision 检查 → 派发 → 有界清理；失败返回 effect_state。
3. **Read gate**：超时的 renderer read 关闭该 (tab, session) 的后续读，直到 settle/detach；
   区分 `deadline` 和 `blocked`。
4. **Borrow reservation**：先 reserve，再 await 用户确认/移动；所有失败分支回滚。
5. **Navigation loader fence**：loaderId + pending/committed 状态机；不重放已派发导航。

### Sprint B — 协议与生命周期（P1）

1. 统一 method/feature catalog（owner/effect/params/features），生成 status compatibility。
2. 错误统一 `(code, reason, effect_state, recovery, component)`；退出码稳定。
3. Daemon 单实例 lock + pid/protocol 校验 + stop 升级；session start journal。
4. cancel/dispatch 顺序：cancel 不能插到已派发之前/之后语义不清；terminal receipt。

### Sprint C — 观察与证据（P1/P2）

1. Ref identity：documentRevision + generation + frame/session；ref 不跨文档复用。
2. VOM 两层文档（page + occluder）+ `unavailableFrames` 暴露。
3. 长截图磁盘分片/页脚重绘；视频 fragmented + 完帧重封装；debug journal/IndexedDB。
4. case JSON + `withChrome` + tri-state oracle；真实浏览器 CI lane。

## 本轮已落地的优化（0.1.9-dev）

在 `lib/protocol-features.mjs` 增加 `featureMatrix(peer, compare)`，并在 daemon `status`
返回：

```json
{
  "compatibility": {
    "daemon": { "protocol": "1.9", "features": { "read": { "required": "1.9", "actual": "1.9", "available": true } } },
    "browsers": [ { "instanceId": "…", "protocol": "1.9", "features": { } } ]
  }
}
```

目的：在派发前就能看到“哪个 peer 缺哪个特性”，而不是等 `E_UNSUPPORTED_CAPABILITY`。
测试：`tests/unit/protocol-features.test.mjs`（3 个断言组）；当前运行时单测 **474/474**。

补充优化：daemon 增加 per-tab reservation（`lib/tab-reservations.mjs`）：`session.start --tab` / `session.rebind` 在 await 浏览器操作前先占用 tab，冲突返回 `E_BORROW_CONFLICT`，会话停止释放。测试：`tests/unit/tab-reservations.test.mjs`。

补充优化：`fillFastTarget` 现在用 shadow-root-aware 的焦点判定返回 `focused`；`trustedFillFast` 在焦点没有真正落到目标（closed shadow / 页面抢焦点）时返回 `null`，回退 trusted 点选路径，避免 `Input.insertText` 写进错误元素。测试：`tests/unit/focus-state.test.mjs`。

再补充：`ensureInputFocus` 在读到 visible 后等两帧 `waitForPaint`，再复采样一次，避免合成器尚未提交就派发输入。测试：`tests/unit/input-readiness.test.mjs`。开发构建：430,089 B / 120 runtime JS，已保存为 `dist/BridgeDeck-extension-0.1.9-dev.zip`；0.1.8 发布包已恢复并 preflight PASS。

> 注意：0.1.8 已发布并签名；以上优化进入下一版本，不修改已发布制品。构建门禁已验证（120 runtime JS），随后恢复了 0.1.8 的已发布扩展包。

## 验收标准

- 新增/修改的每个 P0 不变量都有单测（纯函数或 fake adapter）；
- 真实浏览器 lane 至少覆盖 attach/detach、focus、click/fill、OOPIF 一次；
- 任何 post-dispatch 失败都带 effect_state；
- 任何“未测试”不得记为 pass；
- 0.1.8 的 469 单测不回归；当前 474/474，新增测试独立计数。
