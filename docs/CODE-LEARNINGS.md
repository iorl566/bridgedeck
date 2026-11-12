# 代码学习记录

最后核对：单测 **804/804**、E2E **131/131**、CLI **139/139**、插件 **21/21**、MCP **9/9**。

## 规模

- 项目：约 12,600 行扩展 + 3,600 行 CLI + 1,850 行 daemon。
- 对照实现：约 546 个扩展 TS/TSX 文件、15 万行以上。
- 策略：不整仓复制，按目录/文件边界逐模块移植为零依赖 JS，先纯逻辑后浏览器胶水。

## 关键学习

- **注入范围**：`executeScript` 序列化的函数不能引用模块导入；页面内函数必须自包含。
- **帧边界**：`frameId` 必须与请求/响应/录制/截图关联；OOPIF 需要 target 继承。
- **可信输入**：坐标点击前检查遮挡、pointer-events、视口；输入前聚焦并校验 ref。
- **证据**：JSON 数字不能经过 Number，必须保留原始 token 范围；redaction 必须在截断之前。
- **视频**：分片写入 + manifest 持久化；恢复只接受完整 `moof+mdat`。
- **长截图**：先测量再选后端；Windows Agent 使用 freshness 校验；tile 写入必须可恢复。
- **认证**：proof 绑定 transcript；challenge 一次性；credential pending 同时保留旧 key 和新 key。
- **存储**：IndexedDB 事务内不能 `await`；manifest 先提交再宣告 checkpoint。

## 模块

### debug

- `json-source.js`：token 级 JSON source、jsonPointer。
- `redact.js`：vendor header、HTML/form/JSON 脱敏、64KiB 策略。
- `journal.js`：requestMetadata/mergeRequest/retentionPriority/DebugJournal。
- `network-store.js`：请求/响应/redirect/ExtraInfo/body job/eviction/annotation。
- `control-model.js`：rule/edit/replay 校验、urlMatcher、editRequest。
- `network-control.js`：Fetch 拦截、block/modify/mock、replay。
- `evidence-model.js`：operationContext/Evidence、payload/field traces。
- `query.js`：匹配/字段投影/输出预算。
- `capabilities.js`：actions/limits/storage/performance。
- `performance.js`：performanceSnapshot/interruptPerformance。
- `performance-observer.js`：performance 面板（FCP/LCP/CLS/longtask、可见性、bfcache、覆盖率）。
- `recording.js`：readRecording。
- `analysis.js`：aggregate/duplicates。
- `archive.js`：expiredHistory/interrupted、Memory/Local DebugArchive。
- `observer.js`：sanitizeFields。
- `client.js`：调试/录制/历史/删除 RPC 与打开调试页。
- `bridge.js`：受信调试页消息、delete/start/stop 串行化。
- `manager.js`：start/onEvent/stop/status/before/after、history/readHistory。
- `types.js`：纯类型模块，无运行时导出。

### transport

- `local-auth-crypto.js`：base64url、uint32、fields、transcript、HMAC。
- `local-auth-protocol.js`：消息 schema。
- `local-auth.js`：AuthChannel + authenticateLocal。
- `local-credentials.js`：配对链接、staged TTL、candidate/promotion。
- `daemon-endpoint.js`：默认端口、resolveDaemonWsUrl、normalize/parse port。
- `pairing-verifier.js`：verifyLocalPairing（单实例 busy、10s abort、open 等待、advanced credential 重试一次、失败 discard）。
- `credential-db.js`：openCredentialDatabase（bb-remote-authorization v2、connection/local/migration store）。
- `handshake.js`：performHandshake（protocol 1.9/floor 1.6、10s timeout、onRejected）、detectBrowserMeta。
- `remote-endpoint.js`：parse/read/status/remoteSocket、WSS/loopback、device/pending token 校验。
- `remote-storage.js`：createRemoteStorage（local/remote 模式、endpoint 私存、迁移 legacy key、saved read）。
- `remote-authorization.js`：createRemoteAuthorization（pair/renew、pending token、stillSelected 校验、失败持久化）。
- `ws-transport.js`：WSTransport（连接/断开/重连退避、认证 prelude、帧分发、发送前 connected 校验）。
- `transport.js`、`types.js`、`build-info.js`：纯类型/声明模块，无运行时导出。

### session-manager

- `ref-store.js`：stable refs、allocate/replace/invalidate。
- `manager.js`：Agent Window、ref-store、borrow reservation。
- `tab-moves.js`：ExpectedTabMoves（detach/attach 归属、同窗重排旁路、forget/clear）。
- `event-handler.js`：窗口关闭/标签 detach 事件、expected close、session.ended/window_closed、CDP 清理。
- `tab-creation.js`：beginTabCreation/waitForTabCreation（先于 id 返回的标签事件）。
- `agent-window.js`：createAgentWindowApi/chromeAgentWindowApi（窗口创建、incognito 校验、ensureActiveTab）。
- `disconnect-cleanup.js`：createDisconnectCleanup（并发合并、逐会话 stop、return_failures、失败报告）。
- `popup-focus.js`：watchPopupFocus（仅恢复任务弹窗、用户切换不打扰、minimized 处理）。
- `ui-activity.js`：runTaskUi/withUiTeardown/checkedUiTab（3s UI 预算、mutation grace、所有权校验）。
- `task-popups.js`：withTaskPopups（输入后 100ms 观察、同窗 popup 归入 observedTabs、跨窗忽略、focus 恢复）。
- `window-routing.js`：AgentWindowRouting（候选延迟/重试、页面 provenance、用户窗口选择、move/create/focus）。
- `tabs.js` 已接入 `ExpectedTabMoves`：`tab.move` 经 `run()` 包裹，detach/attach 仅用于归属；E2E 131/131 验证通过。
- `debugger.js` 已接入 `runCdpCommand`：读取类 CDP 命令获得 10s/20s 截止与慢命令日志；E2E 131/131 验证通过。
- UI：弹窗收敛为单主视图 + 可折叠设置；快捷功能页面独立；新增 `ui/privacy.html` 并修复失效链接；删除重复 `ui/video.html`。
- `agent-window.js`：home 常量。

### browser-driver

- `frame-graph.js`：buildFrameGraph/omitFrameSubtrees。
- `command-deadline.js`：CdpReadGate/runCdpCommand。
- `screencast-coordinator.js`：单流/最大配置/ACK。
- `background-execution.js`：BackgroundExecution（owner 集合、attachment、串行 toggle、reapply）。
- `console-parsers.js`：parseConsoleApiCalled/parseExceptionThrown/parseLogEntry（字段截断、1-based stack）。
- `chromium-cdp.js`：ChromiumCdp 生命周期（attach 合并、attachmentId、send read gate、detach、事件、background execution）、console/network 捕获、dialog 状态、emulation 与 frame graph。
- `dialog-parser.js`：dialog 类型归一化、字段投影与截断。

### content / recording

- `record-step-delivery.js`：顺序发送/ack/flush。
- `capture-suppress.js`：createCaptureSuppressController（隐藏 overlay、双 rAF、引用计数、host 重挂载）。
- `input-passthrough.js`：createInputPassthroughController（点击命中穿透、5s TTL、host 重挂载）。
- `record-hover-surface.js`：悬浮层识别、触发点几何归属、floating 候选。
- `help-request.js`：帮助请求数据、rects 刷新、继续/取消回调。
- `overlay-controller.js`：OverlayController 纯状态机、控制遮罩可见性判定。
- `record-capture.js`：录制核心（click/fill/press/select/导航、密码脱敏、组合输入、history patch；悬停 ownership 为简化子集）。
- `ControlGlow.js`：控制光晕。
- `ControlInputBlocker.js`：输入阻断。
- `ControlOverlay.js`：协作/控制浮层（状态、目标、暂停/继续、停止、最小化）。
- `lib/input-passthrough-bridge.js`：消息校验与发送。
- `lib/capture-suppress-bridge.js`：withExtensionOverlayHidden（begin/end、finally 恢复、无 content script 时跳过）。
- `lib/sensitive-autocomplete.js`：敏感 autocomplete token 判断与 CSS 选择器。
- `lib/random-uuid.js`：randomUUID / getRandomValues 回退。
- `lib/overlay-version.js`：epoch + generation 单调版本。
- `lib/controller-info.js`：控制者标签校验与颜色分配。
- `lib/audit-timeline.js`：只增事件折叠为步骤、状态判定。
- `lib/semver.js`：协议 MAJOR.MINOR 解析与比较。
- `lib/popup-bridge.js`：popup port 名称。
- `lib/overlay-bridge.js`：overlay 消息常量、host 判定、OverlayVersionGate。
- `lib/overlay-interrupt-client.js`：中断请求 2s 软超时。
- `lib/sessions-live-flag.js`：session 活跃布尔标记、去重写入。
- `lib/audit.js`：审计开关读取、审计 RPC、打开审计页。
- `lib/daemon-port-preference.js`：先监听后读取，避免晚到初读覆盖。
- `lib/heartbeat.js`：连接活跃时 20s 心跳，断开暂停。
- `lib/keepalive.js`：30s alarm 唤醒 SW，空闲时触发重连。
- `lib/interaction-preferences.js`：交互偏好存储、订阅与 revision 防旧读覆盖。
- `lib/instance-id.js`：实例 ID 生成/持久化、标签与布尔偏好、端口读写。
- `lib/daemon-connection-preference.js`：端口/远程快照、revision 防旧读、30s 重试。
- `lib/ui-channel.js`：远程 UI focus/preview 通道，避开工具队列。
- `lib/audit-bridge.js`：审计 RPC 请求/响应、审计页来源校验。
- `lib/help-bridge.js`：人工协助请求/响应/取消/结束消息校验。
- `lib/local-pairing-bridge.js`：受信 popup 校验、本机配对 info/pair/skip/retry。
- `lib/daemon-upgrade-notice.js`：升级提示徽标、每 session 一次通知、清除与按钮。
- `lib/hover-trigger-policy.js`：悬浮触发评分、unsafe/图形/顶栏/compact 判定。
- `lib/describe-target.js`：可交互选择器、可访问名称、role 推断、点击/悬浮目标解析、描述符。
- `lib/connection-controller.js`：连接状态机、握手重试、配置切换、兼容性判定。
- `lib/task-preview.js`：任务目标 tab 选择、focus 操作。
- `recording/frame-agent.js`：registerPort/start/stop/cancel。
- `lib/record-bridge.js`：RECORD_* 消息校验。
- `lib/recording/frame-bridge.js`：frame 消息校验。
- `lib/recording/frame-coordinator.js`：RecordFrameCoordinator（begin/armTab/agent/sourceFor/stop/cancel/query 消息/导航帧）。
- `lib/recording/navigation-policy.js`：重定向 qualifier 判定。
- `lib/recording/draft-policy.js`：按键记录策略、草稿起点 URL。
- `lib/recording/state-registry.js`：状态去重注册与步骤标记。
- `lib/recording/trace-state-body.js`：VOM 文本行内步骤标注。
- `lib/recording/target-matcher.js`：几何/语义目标匹配与 unmatched fallback。
- `lib/recording/step-buffer.js`：录制 payload 转草稿、导航标注/重定向合并、pending navigation。
- `lib/recording/tab-coordinator.js`：tab 激活 revision 与每 tab 导航游标。
- `lib/recording/trace-reducer-v3.js`：草稿折叠/重定向、cause、redact、步骤 id 映射。
- `lib/recording/trace-builder-v3.js`：发布状态、注解、trace v3 组装。
- `lib/recording/document-settle.js`：CDP 静默探测、隔离 world、150/250/2000ms 窗口。
- `lib/recording/observation-capture.js`：ObservationNodeIndex、tab 元数据、VOM 观察捕获。
- `lib/recording/observation-session.js`：观察节流、状态注册、草稿绑定与注解。
- `lib/recording/settle-controller.js`：调度/取消/重试、redirect 导航草稿、收尾观察。
- `lib/recording/recording-runtime.js`：多 tab 观察上下文、初始/切换/重试捕获、trace 组装。
- `lib/recording/trace-reducer-v2.js`：页面注册、导航折叠、v2 步骤编译与 effect。
- `lib/recording/types.js`：纯类型模块，运行时无导出。
- `lib/recording/document-marker.js`：document marker set/restore。
- `shared/recording-document-identity.js`：UUID marker。

### long-screenshot

- `types.js`：常量/phase/ScreenshotError。
- `wait.js`：8s timeout/abort。
- `frame-freshness.js`：stale frame 判定。
- `manual.js`：alignFrames（纹理带投票、stationary band 排除、seam/footer）与 captureManual 循环。
- `page-client.js`：createPageClient（documentId 绑定、probe、8s/2s 超时、content script 重注入）。
- `page.js`：createPageCapture（布局归一化、fixed/sticky、懒加载、watchdog、取消、测量）+ pageError。
- `capture.js`：sliceForFrame/sameLayout/capturePage（视口推进、底部 footer、懒加载增高、stale frame、finish 清理）。
- `background.js`：控制器核心（start/cancel/finish/pause/resume/preview、状态发布、busy/权限）。
- `test-fixture.js`：长截图测试页（固定栏、懒加载、延迟批次）。
- `storage.js`：screenshotFilename、createScreenshotStorage（IndexedDB/内存 fallback）。
- `exports.js`：ScreenshotExports（私有导出、256KiB 分片、session/offset/过期、discard）。
- `png.js`：CRC32/streamPng。
- `source.js`：visible-tab/debugger 后端。
- `tiles.js` / `retention.js`：tile 目录/TTL/清理。

### video

- `types.js`：常量/presets/校验。
- `timeline.js`：VideoTimeline/videoDimensions/FrameClock。
- `encoder-config.js`：AVC level 选择。
- `errors.js` / `capture-deadline.js`：错误与 10s 等待。
- `store.js`：VideoArtifactStore。
- `overlay.js`：VideoOverlayGate。
- `bridge.js`：isVideoPage、attachVideoBridge（UI 消息、offscreen finished、overlay 握手、save）。
- `encoder-worker.js`：createVideoWorkerHandler（idle/start/frame/stop/recover、并发恢复去重）。
- `client.js`：videoRequest/videoTime。
- `encoder.js`：completeFragmentLength（完整管线未移植）。
- `manager.js`：录制生命周期。
- `downloads.js`：下载与 exported。
- `host.js` / `offscreen.js`：offscreen worker 桥。
- `host-protocol.js`：hostRequest/parseHostReply/isIdempotentHostAction。

## 测试

- `tests/unit/*.test.mjs`：804 项。
- `tests/unit/source-modules-integration.test.mjs`：SessionManager + DebugManager + Archive + VideoManager 组合链路。
- `tests/unit/source-module-coverage.test.mjs`：152 个源码镜像模块导入检查。
- `tests/unit/runtime-integration.test.mjs`：检查 `tabs.js` 使用 `ExpectedTabMoves`、`debugger.js` 使用 `runCdpCommand`。
- 真实 Edge E2E：`node tools/e2e.mjs`，131 项。

## 发布

- `node tools/build-setup-exe.mjs`
- `node tools/release.mjs --check`
- 自签 PFX + DigiCert 时间戳；证书链不受信任。
