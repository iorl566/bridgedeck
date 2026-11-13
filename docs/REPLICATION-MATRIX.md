# 对照实现全面复刻矩阵

> 目标：先按参考实现逐模块复刻，再做专项优化。
> 参考实现位于 `.ref/repo`；本文件是复刻范围、差距和阶段计划的唯一清单。
> 状态：✅ 已对齐　🟡 可用但有结构差距　❌ 未实现

## 0. 规模基线

| 部分 | 参考实现 | 当前实现 | 差距 |
| --- | --- | --- | --- |
| Rust（CLI + daemon + protocol） | 206 文件 / 82,707 行 | CLI 3,687 行 + daemon 1,911 行 + lib 602 行 | 约 1/12 |
| 扩展 TypeScript/TSX | 约 200+ 文件 | 60 文件 / 12,351 行 JS | 约 1/8 代码量，缺多个子系统 |
| packages（vom/ui/i18n/plugin） | 109 文件 / 29,362 行 | 扩展内简化实现 + dsh-plugin | 缺独立 vom 包与完整 UI 包 |
| 测试 | 285 个测试文件 | 51 单测 + 117 E2E + CLI 133 | 测试密度仍低 |

## 1. 领域矩阵

| 领域 | 参考实现核心模块 | 当前实现 | 状态 | 缺口 |
| --- | --- | --- | --- | --- |
| 协议方法/错误码 | 协议参考、`cli/protocol.rs` | `lib/protocol.mjs`、`docs/PROTOCOL.md` | 🟡 | 方法未全量枚举；JSON Schema 只覆盖部分方法 |
| 协议版本协商 | protocol 1.x/capabilities | `protocol-version.js` | ✅ | 已做版本/能力门禁 |
| daemon 生命周期 | `daemon/start.rs`、`lockfile.rs`、`probe.rs` | `daemon/server.mjs` | 🟡 | 无独立 lockfile/probe 模块，端口探测内联 |
| daemon 队列/并发 | `daemon/queue.rs`、`inflight.rs`、`cancel_forward.rs` | `lib/session-queue.mjs` + inflight 表 + cancel | ✅ | — |
| daemon 会话恢复 | `sessions.rs`、`recoverable-session-starts.md` | `sessions.json` 恢复 | 🟡 | 未覆盖启动中断/停止准入 |
| daemon 本地认证 | `local_auth/{handshake,lifecycle,store,read_limit}` | keyId + HMAC nonce challenge-response + 配对 token + 限流 | 🟡 | 读限额/维护任务仍简化 |
| 远程连接 | `remote/{authorization,rate_limit,server}` | WSS + pair token + TLS | 🟡 | 无远程速率限制/授权分级 |
| 文件传输 | `file_transfer.rs` | transfer.* staging | 🟡 | 无 4MiB 分片上限校验、无传输配额 |
| 对话框 | `dialog_control`、`daemon/dialog_operations` | dialog pending/operation | ✅ | 已覆盖主流程 |
| CLI 输出/原子写 | `atomic_output.rs`、`render_error.rs` | `writeFileAtomic`、统一错误渲染 | 🟡 | 仅 save-full 使用原子写 |
| 观察/VOM | `packages/vom`、`observe.rs`、`observation_view.rs` | page-lib + observe --vom | 🟡 | 无独立 VOM 包、感知探针/证据模型不完整 |
| AX 树 | protocol AX join | `--ax` + backendNodeId join | ✅ | 已对齐主要能力 |
| 结构化读取 | `dynamic-reading`、`read.rs` | read/observe 稳定 refs | 🟡 | 无动态读取验证基线 |
| 表格/列表提取 | `extract.rs`、`structured-extraction.md` | extract + complete/totalRows/columnCount | ✅ | 合并单元格已展开 |
| 浏览器驱动 | `browser-driver/{chromium-cdp,command-deadline,frame-graph,background-execution}` | `debugger.js` + deadline + frame-graph + background-execution | ✅ | — |
| 录屏协调 | `screencast-coordinator.ts` | `video.js` | 🟡 | 多标签/多录制协调未独立 |
| 内容层输入 | `actions.js` | CDP trusted + input leases | ✅ | click/hover/fill/press/drag/wheel 已覆盖 |
| 内容层拖拽修饰键 | `drag.rs` | `drag --modifiers` | ✅ | 本轮补齐（page + CDP） |
| 人机协作 | `cooperation/*`（controller/action-guard/control-authority/live-text/media-progress/observation-evidence/hidden-frames） | `control.js`、`takeover.js`、`cooperate.*`、`overlay-state.js` | ✅ | 动作守卫/控制权/隐藏 frame/媒体/证据已覆盖 |
| 协作 UI | `content/*Overlay.tsx`、`overlay-controller` | 注入式浮层 + `overlay-state.js` 注册表/捕获抑制 | ✅ | takeover/record/help/borrow 统一状态机 |
| 操作录制 | `record.rs`、`record_state.rs`、`record_recovery.rs`、`record/export.rs` | `ops.js` + Trace v3 + states + 导航恢复 + tab/window switch | ✅ | — |
| Recipe | `recipe/{draft,model,runner,store,vom}` | `lib/recipe-store.mjs` + CLI draft/save/approve/run/rm；runner 由 plan 驱动 | 🟡 | runner 未独立模块 |
| 网站调试 | `debug/{analysis,archive,evidence,journal,query,recording,performance,network-store}` | `debug.js` + export/query/evidence/journal + 页面 | 🟡 | 缺 analysis 规则引擎 |
| 网络调试 | `network.rs`、`network-store` | `network.js` + rules（500 条/1MiB body 保留） | 🟡 | 无完整重放模型 |
| 规则 | `debug/network-control`、DNR/Fetch | `rules.js` + 持久化 + rule_export/rule_import + UI | ✅ | — |
| 长截图 | `long-screenshot` | 手动/自动拼接 | ✅ | 已有 |
| 视频 | `video.rs` | MediaRecorder + 容量上限 + interrupted 恢复 | 🟡 | 无容量水位自动清理 |
| 更新 | `update/{sources,state,windows}` | release.json + check/stage/apply/rollback + HMAC 签名 + 远程 fetch/state + 安装脚本 | 🟡 | 无自动更新/受信任签名 |
| 分发 | 单文件 + SHA256 | zip + SHA256 + SHA256SUMS + 便携包 + Setup.exe + signtool/Set-Authenticode 脚本 | 🟡 | 已签名安装器依赖证书 |
| MCP | `mcp/{server,tools}` | 17 tools | 🟡 | 未覆盖 update/recipe 全部子命令 |
| 宿主插件 | 参考插件结构 | `dsh-plugin/` | 🟡 | 工具面/恢复逻辑需对齐 |
| 测试 | 285 测试文件 | 93 单测 + 125 E2E | 🟡 | 模块级单测仍少于参考实现 |

## 2. 复刻阶段

### 阶段 A：协议与 daemon 基础（P0）
1. 全量方法/错误码枚举，补 JSON Schema。
2. daemon inflight 表 + `status.inflight` + `inflight.list`（已完成）；`operation.await` 4MiB 上限（已完成）；每 session 串行队列（容量 64，已完成）；`command.cancel` 取消转发（wait-ms 可中断，已完成）。
3. 本地认证 challenge-response 已完成；读限额/维护任务仍简化。
4. 会话启动/停止准入与恢复状态机（starting/active/stopping/recovering 已完成）。

### 阶段 B：浏览器驱动与内容层（P0）
1. 抽出 `browser-driver`：CDP 命令 deadline（已完成）、frame graph（已完成）、后台执行（已完成）。
2. 协作动作守卫（已完成 takeover.paused → E_SESSION_PAUSED）、控制权模型（部分）、隐藏 frame（同源 frame-meta 标记 hidden/offscreen，跨源 unknown）、媒体进度（已完成）、观察证据（已完成）。
3. 内容浮层状态机（`overlay-state.js` token/priority/exclusive + 捕获计数）已接入 takeover/record/help/borrow。
4. 录制 trace v3（traceVersion 1 + 每步 states + tab-switch/window-switch + 导航后 reattach；trace v3 结构仍待对齐）。

### 阶段 C：CLI 子系统（P1）
1. `record` 完整 start/stop/await/state/recovery/export。
2. `recipe` store/runner/draft 拆分与审批持久化。
3. `update` sources/state/windows + 签名。
4. `browser_wait`、`interaction_policy`、`atomic_output` 全量使用。

### 阶段 D：调试与 UI（P1）
1. debug analysis/archive/journal/query/evidence。
2. 调试页 rePLAY/规则/性能/操作已补齐，补归档与分析面板。
3. 网络保留策略、请求体上限。

### 阶段 E：测试与分发（P2）
1. 模块级单测覆盖 driver/cooperation/record/debug。
2. 故障注入（超时、断连、重复连接、取消）。
3. 单文件分发/签名更新（Setup.exe + SHA256SUMS + 签名脚本已就绪，证书待提供）。

## 3. 当前轮次

- 已完成本轮收尾：`drag --modifiers`（page-lib 9、CDP modifiers、E2E 16b）。
- 已冻结全量领域矩阵；后续不再按零散 UI 优化推进。
- 下一轮从阶段 A 开始：daemon `queue/inflight/cancel_forward` 与 `operation` 4MiB 上限。

