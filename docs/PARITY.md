# 对照矩阵

最后更新：v0.1（E2E **131/131**、CLI **139/139**、单测 **804/804**、配对 **10/10**、TLS **8/8**、MCP **9/9**、MCP tools **49**、DSH 插件 **21/21**、插件 tools **34**）。

## 能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 标签页/窗口 | ✅ | list/open/close/move/focus/ensure/resize |
| VOM/AX ref | ✅ | `@eN`、ARIA grid、跨 iframe 统一编号 |
| 可信输入 | ✅ | CDP 输入、焦点/遮挡/可操作性校验 |
| 截图 | ✅ | 可视区/整页/元素/区域/标注/overlap |
| 长截图 | ✅ | tile + renderer + overlap + freshness 重试 |
| 操作录制 | ✅ | allFrames recorder、frameId、Trace v3 |
| 视频 | ✅ | MediaRecorder + 分片持久化 + recover + 导出 |
| 网络调试 | ✅ | 请求/响应/规则/replay/性能/归档/证据 |
| 本地认证 | ✅ | keyId + HMAC challenge-response、TTL、16MiB 帧 |
| 远程配对 | ✅ | token、撤销、WSS、自签 TLS |
| 审计 | ✅ | 操作审计、分页、doctor |
| MCP | ✅ | 49 tools |
| DSH 插件 | ✅ | 34 tools |

## 对照实现镜像（零依赖 JS）

| 目录 | 已移植 |
| --- | --- |
| `extension/src/debug/` | json-source、redact、journal、network-store、control-model、network-control、evidence-model、archive、query、capabilities、performance、performance-observer、recording、analysis、observer、manager、client、bridge、types（纯类型）、use-tasks |
| `extension/src/transport/` | local-auth-crypto、local-auth-protocol、local-auth、local-credentials（含默认 store API）、credential-db、daemon-endpoint、pairing-verifier、handshake、remote-endpoint、remote-storage、remote-authorization、ws-transport、transport（纯类型）、types（纯类型）、build-info（纯声明） |
| `extension/src/session-manager/` | ref-store、manager、agent-window（含 API）、tab-moves、event-handler、tab-creation、disconnect-cleanup、popup-focus、ui-activity、task-popups、window-routing |
| `extension/src/browser-driver/` | frame-graph、command-deadline、screencast-coordinator、background-execution、console-parsers、chromium-cdp（lifecycle+console+network+dialog+emulation+frame graph）、dialog-parser |
| `extension/src/content/` | record-step-delivery、recording/frame-agent、capture-suppress、input-passthrough、record-hover-surface、help-request、overlay-controller、record-capture（核心子集）、ControlGlow、ControlInputBlocker、ControlOverlay、RecordOverlay、BorrowConfirmationOverlay、HelpRequestOverlay、cooperation-capture |
| `extension/src/shared/` | recording-document-identity |
| `extension/src/lib/recording/` | document-marker、frame-bridge、frame-coordinator、navigation-policy、draft-policy、state-registry、trace-state-body、target-matcher、step-buffer、tab-coordinator、trace-reducer-v3、trace-builder-v3、document-settle、observation-capture、observation-session、settle-controller、recording-runtime、trace-reducer-v2、types（纯类型） |
| `extension/src/lib/` | record-bridge、input-passthrough-bridge、capture-suppress-bridge、sensitive-autocomplete、random-uuid、overlay-version、controller-info、audit-timeline、semver、popup-bridge、overlay-bridge、overlay-interrupt-client、sessions-live-flag、audit、daemon-port-preference、heartbeat、keepalive、interaction-preferences、instance-id、daemon-connection-preference、ui-channel、audit-bridge、help-bridge、local-pairing-bridge、daemon-upgrade-notice、hover-trigger-policy、task-preview、describe-target、connection-controller |
| `extension/src/long-screenshot/` | types、wait、frame-freshness、png、source、tiles、retention、manual、storage、exports、page-client、page（createPageCapture）、capture、background（controller）、test-fixture |
| `extension/src/video/` | types、timeline、encoder-config、errors、capture-deadline、store、overlay、client、encoder（完整管线）、encoder.worker、manager、downloads、host、host-protocol、offscreen、bridge、encoder-worker（测试核心）、playback-fixture、browser-fixture、dsh-fixture |

## 自测

- E2E **131/131**
- CLI **139/139**
- 单测 **804/804**（含模块组合链路、152 模块导入与运行路径接入检查）
- DSH 插件 **21/21**
- MCP **9/9**
- 配对 **10/10**
- TLS **8/8**
- profile 检查 **7/7**

## 差异

- 上述镜像模块仍是旁路实现，尚未替换现有运行路径。
- 完整 WebCodecs 编码管线依赖外部封装库，当前只移植了可独立验证的 fragment 解析。
- LocalDebugArchive 真实 IndexedDB 路径未在 Node 单测覆盖，fallback 已覆盖。
- 页面浮层仍为自包含 DOM；视频仍以 MediaRecorder 为主。
