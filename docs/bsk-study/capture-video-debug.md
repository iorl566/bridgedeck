# BSK 0.5.0 研究笔记：长截图 / 视频 / 调试证据

取材：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/`（下称 `<src>`）。
覆盖 `long-screenshot/**`、`video/**`、`debug/**`。目标：给 BridgeDeck 的可迁移结论。

## 1. 核心模型 / 状态机

三套子系统都遵循同一骨架：**纯状态机 + 可注入 deps + 显式 AbortSignal + 磁盘/DB 提交点**。

- 长截图：`background.ts:20-399` 是唯一控制器。`CaptureState.phase` = preparing→capturing/paused→saving→complete/cancelled/error（`types.ts:13-49`）；`mode` = auto/manual/visible（`types.ts:88`）。页侧 `createPageCapture` 持有单个 task（`page.ts:15,417-442`），命令集 `probe/begin/move/inspect/pause/finish`（`types.ts:75-81`）。产物是磁盘分片 `TiledScreenshot{kind:"tiles",tileHeight:512}` + 每片 PNG + `index.json` 清单（`tiles.ts:6-16,61-160`）。
- 视频：`VideoManager` 只管采集与授权（`manager.ts:77-674`），编码/落盘全在 offscreen worker（`encoder.ts:157-418`、`encoder.worker.ts:51-92`）。记录状态 `starting→recording→finalizing→ready|failed`（`types.ts:17`），`completeness: complete|partial` 与 `stop_reason`（13 种，`types.ts:18-29`）共同表达"为什么/是否完整"。落盘两阶段：`fragments.mp4`（fragmented 日记，同步句柄逐包写）→ `finishVideo` 重封装成可 seek 的 `video.mp4`（`encoder.ts:93-155`）。
- 调试：`DebugManager.RunState`（`manager.ts:71-97`）是热缓存；`DebugJournal` 把请求证据批量写入 `LocalDebugArchive`（IndexedDB 4 个 store，`archive.ts:14,121-141`）；`DebugNetworkStore` 维护 redirect chain、in-flight、body 队列（`network-store.ts:101-132`）；`DebugObserver` 在专用 isolated world 装页面侧探针（`observer.ts:10-242,347-376`）。`DebugRun.coverage[]` 是"我明确知道没采到什么"的一等公民（`manager.ts:238-246`）。

## 2. 五条不变量

1. **一份任务只属于一个 document，且所有等待都可中断**：`waitForReply(promise, signal, timeout)` 同时装 abort 与超时并吞掉迟到拒绝（`long-screenshot/wait.ts:1-36`）；`captureReply` 同理给 CDP 截图 10s 上限（`video/capture-deadline.ts:1-31`）。跨文档则 `documentId` 绑定 + 失效即重注入，重注入只对 `unavailable` 生效（`page-client.ts:41-70`）。
2. **每个曝光必须几何自洽**：截图前后各测一次，`sameLayout` 比较 width/height/viewport/inner/dpr/位置，连续 3 次不一致才判 `changed`（`capture.ts:33-44,143-148`）。
3. **先提交，再宣告**：分片写完 PNG 才更新 `index.json`（`tiles.ts:141-149`）；编码元数据先 `store.put` 再删恢复日记（`encoder.ts:147-149`）；journal flush 后才允许 stop 返回（`manager.ts:1112-1138,1351-1358`）。
4. **缺失必须显式命名，不能表现为 0 或 pending**：body 状态 `available/empty/truncated/omitted/evicted/unavailable + reason`（`network-store.ts:443-483`）；tracking 溢出写成 `state:"interrupted", error:"tracking_limit"`（`network-store.ts:249-268`）；重启恢复把 pending 全部改成 interrupted/unavailable（`archive.ts:74-103`）。
5. **任何输出都有硬上界**：chunk 256KB（`video/types.ts:2`）、单片 256MB、总量 1GB（`video/types.ts:3-4,97-101`）、日志 2000 条/8MB/20 pin（`debug/journal.ts:4-7`）、历史 50 条/50MB/30 天（`debug/archive.ts:21-23`）、记忆 200+200 请求（`network-store.ts:16-17`）、查询预算二分裁切（`debug/query.ts:34-202`）。

## 3. 三个关键算法

- **分片拼接 `sliceForFrame`**（`capture.ts:12-31`）：用 `Math.round(docY*scale)` 一次性取整边界，避免分数缩放累积接缝；最后一帧若 `bottomPx` 已到达文档底，则把起点回退到 `max(y, footerStart)`，把固定页脚整块重绘而不是只补最后几行。滚动步长 `covered - 0.15*viewportHeight`（`capture.ts:203`），末尾强制二次"final 曝光"（`capture.ts:195-200`）以吞掉追加内容。
- **时钟与时间轴解耦**（`video/timeline.ts:11-58`）：`FrameClock` 以 CDP epoch 时间戳为基准，与单调时钟差值 >1s 即视为跳变并回退单调值，`last` 只增不减；`VideoTimeline.advance` 把真实经过时间切成任意时长的帧（静态页面得到长 duration，而不是补帧），每分钟一个关键帧。`finishVideo` 用 `completeFragmentLength` 扫 box 找出最后一个 `moof+mdat` 完整边界（`encoder.ts:61-90`），只重封装不重编码。
- **源保留式脱敏**（`debug/redact.ts`）：`parseJsonSource` 只记 offset、数值不过 `Number`（`json-source.ts:1-46`），于是密钥字段被替换而相邻大整数/转义串逐字节保留（`redact.ts:130-155`）；超长或不可解析的 JSON 直接丢弃为空并标 `replay_safe:false`（`redact.ts:167-188`），因为"截断的 JSON 可能切掉秘密的中段"。淘汰优先级 `pinned 9 > failed/4xx/intervention 4 > XHR/JSON 2 > 其他 0`（`journal.ts:44-56`）。

## 4. 五个坑（都已修复，值得照抄结论）

1. **分数缩放/DPR 取整**：`clientWidth` 是整数，必须用未 pinched 的 `visualViewport` 保留小数（`page.ts:392-415`）；DPR 先验"native 匹配"再退回 `bitmap.width/innerWidth`（`capture.ts:149-159`）。
2. **固定页脚与"最后一跳很小"**：仅按 uncovered 行裁剪会把页脚切掉；`bottomOverlayHeight` 让末帧整体重绘（`page.ts:349-362`、`capture.ts:16-23`）。
3. **停止赶在启动之间**：`lease` 可能晚于 stop 返回，必须 `lease.release()` 后抛错（`manager.ts:325-330`）；`store.put` 失败也要释放 overlay（`manager.ts:335-356`）。
4. **导航 vs 用户确认浮层**：导航期间保留最后一张干净帧（`mode:"navigation"`，`manager.ts:498-515`）；`epoch` 单调计数使延迟回来的 `suspend/settle` 失效（`manager.ts:528-540,555-607`）；未解决的导航不允许以 `user_stopped/duration_limit` 收尾，一律降级 `capture_failed`（`manager.ts:392-395`、`encoder.ts:365`）。
5. **HTML 编码的密码输入框**：`type="pass&#x77;ord"` 之类必须先把命名实体还原成 ASCII 再匹配，且单次替换、不可递归解码（`redact.ts:25-51`；反例集见 `debug/__tests__/redact.test.ts:78-108`）。同理 `pageToken` 这类分页游标不能被 `*token` 误杀（`redact.ts:6-9`）。

## 5. 测试 / 评估策略

- **单测靠依赖注入，几乎不 mock 浏览器**：长截图把 `page/screenshot/write/signal/progress/checkpoint` 全做成 deps（`capture.ts:46-66`），测试用 389 行覆盖"取消后 bitmap 必须 close""3 次 stale 才失败""loading 超时只从加载指示出现后计时"（`capture.test.ts:108-389`）。视频注入 `VideoHost`/`CdpRunner`（`manager.test.ts:60-113`），断言"只发一次 stop""backpressure 只保留最新帧 `image:"99"`"（`manager.test.ts:212-233`）。
- **像素可判定的 fixture**：整页测试页每 1px 行一个唯一颜色 `rgb(y%256, y/256, 127)`（`long-screenshot/test-fixture.ts:1-13`），于是拼接结果能逐行断言"第 i 行就是文档第 i 行"（`capture.test.ts:165-177`）。
- **浏览器 e2e 用环境变量开关**：`describe.skipIf(!process.env.BSK_LONG_SCREENSHOT_CHROME)`（`long-screenshot.browser.test.ts:228`）、`BSK_VIDEO_CHROME/BSK_VIDEO_BSK`（`video/capture.browser.test.ts:44`）；视频 e2e 真起 daemon + 扩展 + 本地 HTTP fixture，覆盖 blue/late-overlay/204/download/cancel/error/pdf/hang 八条路由，再**用 mediabunny 解析导出 MP4 并 seek 取像素**验证时间轴（`capture.browser.test.ts:450-580`、`playback-fixture.ts:40-141`）。
- **证据文件可选落盘**：`BSK_VIDEO_ARTIFACTS` 目录保存 mp4+json，且"取证失败不得替换回归结论"（`browser-fixture.ts:54-73`）。

## 6. BridgeDeck 应当采纳（5）

1. 长截图改用 BSK 的**磁盘分片 + 二次 final 曝光 + 页脚重绘**模型，替换 `extension/src/longshot*.js` 的"内存 canvas + 最多 8 帧 + 16000px 上限"（`longshot.js:2-11`、`longshot-render.js:2-18`）；那条路在 >8 屏页面直接截断且无法增量校验。
2. 视频落盘改成**fragmented 日记 + 完帧边界重封装**（`encoder.ts:41-155`），BridgeDeck 目前 `video.js:299` 用 `blob.arrayBuffer()` + base64 全量进内存，256MB 上限形同虚设。
3. 引入 **`captureReply`/`waitForReply` 这类"超时 + 迟到结果吞噬"** 原语，替换 `withTimeout(..., 10000)` 单点超时（`screenshot.js:314`）：Chrome 的 `captureVisibleTab` 在最小化时不回包，重试逻辑必须与 abort 正交。
4. 调试证据采用**热缓存 + journal + IndexedDB 归档**三层（`manager.ts:1112-1138`、`journal.ts:59-108`、`archive.ts:387-469`），并把 `coverage[]/gaps[]` 暴露给调用方（`evidence-model.ts:161-196`）；`debug.js:169-172` 现在把整个 record 塞进 `chrome.storage.local`，50 条 × 200 请求必然爆配额。
5. 脱敏换成**源保留式**（`redact.ts:130-155` + `json-source.ts`），至少补上 HTML 属性实体解码与"超长 JSON 整段丢弃"（`redact.ts:167-214`）；`extension/src/redact.js:35-58` 的 `JSON.parse→遍历→retry` 会重排/丢精度，并保留未解析的超长 body。

## 7. 应当拒绝（3）

1. **不要照抄 `debug` 的 React/UI 与 i18n 依赖面**（`video/client.ts`、`debug/use-tasks.ts`、`i18n` 调用散落在 `manager.ts:585`）：BridgeDeck 运行时是原生 JS 单文件模块，引入 hooks/命名空间会拖垮 manifest 体积与加载顺序。
2. **不要照抄 `debug` 的 fetcher 重放/规则引擎**（`network-control.ts` 620 行 + `control-model.ts` 360 行）：收益集中、风险最高（同源强制、占位符拒绝、二进制拒绝都是补丁堆出来的）。BridgeDeck 若要，先只做"只读归因"，把 `Fetch.enable` 留到有明确需求再说。
3. **不要照抄"单实例全局 `active`"**：`VideoManager` 用 `this.active` 单例 + `starting` 布尔（`manager.ts:79-83`），多任务并发必须靠 `reserveActionRecording` 互斥（`manager.ts:121-127`）。BridgeDeck 已有多会话/远程设备（`tests/integration/remote-device.test.mjs`），应直接做成 keyed map。

## 8. 与 BridgeDeck 现状的差距（5，可立即动手）

1. **镜像未接线**：`reference/extension-mirror/src/{long-screenshot,video,debug}` 已有 BSK 移植版（共 55 文件），但运行时仍是 `extension/src/*.js`；`tests/reference/*` 只验证镜像本身（`tests/reference/README.md:3-20`）。缺一条"镜像→运行时"的迁移清单与验收门。
2. **长截图无页脚/无 stale 帧判定**：缺 `bottomOverlayHeight`、`tailStart`、`frame-freshness` 三件套（`capture.ts:16-31`、`frame-freshness.ts:24-51`），BridgeDeck 的 `sameFrame` 只看 `scrollHeight:innerHeight:bodyLength`（`longshot.js:13-25`），动画/懒加载页会拼出撕裂图。
3. **视频无 worker 隔离与恢复**：`extension/src/video.js` 依赖 `offscreen.html` + MediaRecorder，无 `encoder.worker.ts`、无 `recoverOnce`（`encoder.worker.ts:11-49`），SW 重启后录制直接丢；且无 `completeness/stop_reason` 语义（`video/types.ts:18-29`）。
4. **调试无归档与预算**：`debug.js` 无 `DebugJournal`、无 `budgetResult`、无 `pin` 语义（只有 session 里的 id 数组，`debug.js:93-115`）。任何"导出证据"都会一次性返回全量。
5. **缺可判定的像素/媒体 fixture**：`tests/fixtures/*.html` 无 BSK 那种逐行唯一色页面与"MP4 seek 取像素"校验（`long-screenshot/test-fixture.ts`、`video/playback-fixture.ts`），所以拼接/编码回归只能靠肉眼。
