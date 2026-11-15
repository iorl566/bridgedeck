# 已知边界与后续计划

最后更新：2026-11-15。当前结果见 [STATUS.md](STATUS.md) 与 [收官报告](FINAL-REPORT-2026-11-15.md)。

## 已验证

| 领域 | 结论 |
| --- | --- |
| 传输协议 | 帧类型、错误码、握手、对话框/控制台/网络/标签页/截图载荷契约 |
| 本地认证 | HMAC challenge-response、TLS、一次性 challenge、16MiB 帧 |
| Trace v3 | version/entry/recorder/states/steps + 状态文件 |
| 录制 | allFrames recorder + frameId + Trace v3 |
| 视频 | 分片持久化、恢复、导出、下载结算、RPC、导航暂停/恢复 |
| 调试 | requests/console/pages/perf/aggregate/duplicates/operations/export/replay |
| 内容层 | overlay-controller、录制/协作采集、隐藏帧、媒体进度、时钟归因 |
| 窗口/标签页 | window list/focus/ensure/resize、tab move、借用/归还 |
| 长截图 | tile 调度、renderer、overlap、freshness |
| 工具 | MCP 51、DSH 插件 35、插件直连冒烟 11/11 |
| 分发 | 内嵌 Node 的 Setup.exe、自签、DigiCert 时间戳 |

## 已知边界

| 项 | 现状 |
| --- | --- |
| 视频权限 | 已补 session 存在性、tab 归属与 agentWindow 校验；lookupSession 的 remote/窗口策略仍在调用方 |
| closed shadow | `composedPath()` 会把 click 重定向到 host，`record-capture` 因此只能看到 host；`observe --ax` + `click-backend` 可覆盖观察与点击 |
| 内容采集 | `record-hover-surface` 的悬停归属只通过真实浏览器点击路径间接覆盖；浮层渲染与拖拽已在 E2E 验证 |
| UI 子页 | 审计、长截图、视频、调试、操作录制均为弹窗内嵌面板 |
| CDP dispose | 额外清理 console/network buffer 与外部 handler |
| CLI 冷启动 | 72–86ms，受 Node 运行时限制；MCP/插件直连已绕开 |
| 观察主遍历 | page-lib 仍为默认；`--compare-ax` 提供 0.97 覆盖率基线与降级路径 |

## 后续计划

1. 低频工具（网络/调试/录制/视频/规则）按需直连 daemon。
2. 视口截图编码优化（当前 358ms，受 CDP PNG 编码限制）。
3. 观察主遍历替换：先用 `--compare-ax` 持续量化，再决定是否切换。
4. 原生 thin client：仅在 CLI 冷启动成为硬指标时评估。
