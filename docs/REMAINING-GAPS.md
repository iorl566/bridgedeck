# 剩余真实差异

最后核对：v0.1，E2E **131/131**、CLI **139/139**、单测 **804/804**、内容采集浏览器自测 **1/1**、浮层浏览器自测 **1/1**、DSH 插件 **21/21**、MCP **9/9**、配对 **10/10**、TLS **8/8**。

源码级覆盖审计见 [SOURCE-PARITY.md](SOURCE-PARITY.md)：152/149 文件（含辅助）、**28958/28826 行（约 100.5%，差额为两个辅助模块）**；逐文件差异见 [PARITY-MANIFEST.md](PARITY-MANIFEST.md)。

## 已对齐并有验证

| 领域 | 结论 |
| --- | --- |
| 传输协议 | 帧类型、错误码、握手、对话框/控制台/网络/标签页/截图载荷契约 |
| 本地认证 | HMAC challenge-response、TLS、一次性 challenge、16MiB 帧 |
| Trace v3 | version/entry/recorder/states/steps + 状态文件 |
| 录制 | allFrames recorder + frameId + Trace v3 |
| 视频 | 分片持久化、恢复、导出、下载结算、RPC、导航暂停/恢复；真实 E2E 录制 MP4 并落库 |
| 调试构造 | 严格 `(sessions, cdp, tabs, now, archive)`，sessions 必需，无浅捕获/无主回退 |
| 调试持久化 | journal retain 支持首次 checkpoint 前占位；Local 归档把 requests 写入独立 store；persist 有 journal 时写空 requests |
| CDP 事件结构 | 分域监听：auto-detach、dialog、console、network、frame target；公共 onEvent 每事件一次；dispose 清理 5 个监听器 |
| 内容层 | overlay-controller、录制/协作采集核心、隐藏帧、媒体进度、时钟归因；`cooperation-capture` 与 `record-capture` 的 attach/click/fill/dispose 已有真实 Edge 自测 |
| 窗口/标签页 | window list/focus/ensure/resize、tab move、借用/归还 |
| 长截图 | tile 调度、renderer、overlap、freshness |
| 工具 | MCP 49、DSH 34 |
| 分发 | 内嵌 Node 的 Setup.exe、自签、DigiCert 时间戳 |

## 仍然存在的真实差异

| 项 | 现状 |
| --- | --- |
| 视频权限 | 已补 session 存在性、tab 归属与 agentWindow 校验；lookupSession 的 remote/窗口策略仍在调用方 |
| 内容采集验证 | closed shadow root 的 click 在 `composedPath()` 中会被重定向到 host，`record-capture` 因此只能看到 host；媒体元素身份、`media_progress`、CDP 可信 key/click、坐标不匹配 attribution、匹配窗口的 agent click 均已真实浏览器验证 |
| 内容采集其余模块 | `record-hover-surface` 的悬停归属只在真实浏览器通过点击路径间接覆盖；四浮层渲染、Help 折叠/拖拽/rect 刷新、Borrow allow/deny/自动拒绝、Control minimize、Record finish/拖拽均已验证 |
| UI 子页 | 审计、长截图、视频、调试、操作录制均已改为弹窗内嵌面板 |
| CDP dispose | 额外清理 console/network buffer 与外部 handler，现有测试依赖 |
| 行数分布 | 目录合计约 101%，但逐文件仍有差异；lib/content/browser 的契约注释多于对照，debug 略少 |

## 结论

当前是“149 个文件边界全覆盖 + 主要行为补齐 + 803 单测/131 E2E 全绿”，**不是逐文件逐行源码完全等价**。剩余工作集中在内容采集真实浏览器覆盖、UI 子页结构，以及逐文件注释/类型体量，而不是核心运行路径。
