# 全生命周期逐步差异：BridgeDeck 0.3.1 vs BSK 0.5.0

> 口径：从“重装/重启 → 启动 → 连接 → 会话 → 观察 → 动作 → 等待/对话框 → 网络/调试 →
> 录制/回放/视频/长截图 → 协作/接管 → 审计 → 关闭清理 → 升级更新 → 错误恢复”逐步对比。
> 证据：`ref/bsk-0.5.0-bin/bsk.exe --help`、`ref/bsk-0.5.0-src`、`ref/bsk-0.5.0-ext`、
> 本仓 CLI/daemon/扩展源码、`docs/BSK-DIFF-MATRIX.md`（646 格）、`docs/BEHAVIOR-DIFF-BSK.md`（19 任务）、
> `docs/UI-RUNTIME-COMPARISON.md`。状态：equal / partial / missing / extra（我方独有）/ unknown。

## 0. 总览（按阶段）

| # | 阶段 | 参考实现 | 我们 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 安装与版本 | 单二进制 + 扩展 zip + install.ps1/sh + 发布流水线 | Node CLI + daemon + 扩展 zip + 本地流水线（CI 待生产私钥） | partial（分发形态不同） |
| 2 | 守护进程 | bsk daemon start/stop/restart/pair/devices/revoke/rotate/trust-local | daemon start/stop/restart/status/log/pair/devices/revoke/rotate/trust-local + server 模式 | ours extra（我们更细） |
| 3 | 扩展连接 | 未配对本地连接；配对可选；10 locale；MV3 | WS+TLS+配对（strict/trust-local）、12+ 语言、版本/协议握手、多浏览器 | ours extra（门禁更细） |
| 4 | 会话 | session start/stop/list/request、scope、Agent Window | 同 + prepare/claim/rebind/pause/resume/lease/batch/handoff | ours extra |
| 5 | 导航与观察 | navigate/reload/back/forward、observe/snapshot/read/get-html/extract | 同 + VOM probe/ARIA 语义/iframe/OOPIF/closed shadow/revision/stale | partial→ours extra |
| 6 | 动作 | click/fill/press/hover/drag/wheel/scroll-to/focus/blur/upload/download/emulate | 同 + trusted/stableRef/expect/settle/human 轨迹/收据/journal | ours extra |
| 7 | 等待/对话框/操作 | wait-ms/element/navigation、dialog status/accept/dismiss、operation await/cancel | 同 + cancel 协作式 + dialog/operation 收据 | partial（兼容细节） |
| 8 | 网络/调试 | network/debug 单方法 action 分发 + rules/HAR/性能 | network.*/debug.* 拆分 + rules/HAR merge/回放/证据/性能 | ours extra（粒度不同） |
| 9 | 录制/回放/视频/长截图 | record（阻塞式）+ trace.json；video；long-screenshot；无 replay | record（非阻塞）+ Trace v3；video 恢复/分片；长截图分片/DPR/流式；replay 引擎（CLI 未暴露） | partial（record 交互/replay CLI 缺口） |
| 10 | 协作/接管 | cooperate context_id+control_policy、borrow confirm（UIA 可点）、help、control overlay | 同 + passthrough token/lease/epoch/handoff/hold；borrow closed-shadow human-only | partial（安全设计差异） |
| 11 | 审计/证据 | operation audit、隐私、30 天 | audit list/export/prune/clear + ledger/journal/证据链 | ours extra |
| 12 | 关闭清理 | close 归还借用、session stop --all、tab 清理 | 同 + --keep/cleanup/keepOpen、transfer release、队列排空 | equal/partial |
| 13 | 升级更新 | update check/install + daemon upgrade notice | update check/verify/stage/fetch/state/auto/install + 升级提示 UI | ours extra（CI 发布待私钥） |
| 14 | 错误恢复 | 错误码/reason、UNKNOWN 动作、崩溃恢复 | 161 码 + E_UNKNOWN reconcile + journal/ledger 恢复 + 会话 resume | ours extra |

## 1. 安装与版本（Restart 起点）

| 步骤 | 参考实现 | 我们 | 状态/证据 |
| --- | --- | --- | --- |
| 获取 CLI | 单二进制 `bsk.exe`（23.5MB） | `node cli/bridge.mjs`（Node ≥20） | partial |
| 扩展安装 | unzip 后加载 unpacked / 商店 | 同（`tools/build-extension.mjs` 426 文件包） | equal |
| 版本一致性 | `bsk --version`；升级提示 | `bridge --version`；`status` 带 version/protocol；发布 preflight 校验版本一致性 | ours extra |
| 首次启动 | daemon 自动拉起（detach） | `bridge` 自动拉起 daemon（detach/foreground/server 三种） | equal（我们多 foreground 沙箱模式） |
| 发布/签名 | 单二进制 + 发布流水线 + 签名/公证（已发布） | 本地流水线 16/16 绿；CI 待生产私钥 | partial（分发） |

## 2. 守护进程（daemon 生命周期）

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| start | `bsk daemon start [--foreground]` | `bridge daemon start [--foreground] [--mode server --listen --port]` | equal+extra |
| stop | 读 daemon.json + stop | 同（pid/port 校验、stale 清理） | equal |
| restart | stop→start | 同 | equal |
| 端口选择 | 默认 52800；占用时报错 | 52900..52909 候选；显式 --port 只试一次；占用给 E_ADDR_IN_USE | ours extra |
| 首页/健康 | daemon.json/status | daemon.json + `/health` 心跳 + `status` 字段（browsers/sessions/queues/views） | ours extra |
| 日志 | `bsk logs` | `bridge daemon log/logs --tail/--follow`（本轮补 `--lines` 别名） | equal |
| 配对 | `daemon pair [--replace]` | `daemon pair [--replace]` + 5 分钟过期 + strict/trust-local | equal |
| 设备 | `daemon devices/revoke/rotate` | `daemon devices/revoke <code>|--all/rotate` | equal |
| trust | `daemon trust-local on|off` | 同 | equal |
| 自检 | `bsk doctor` | `bridge doctor` + `daemon doctor`（ledger/transfer/queue/recovery/storage） | ours extra |
| 崩溃恢复 | journal/lock | daemon.json/lock + session-start journal + 恢复日志 | equal/partial |

## 3. 扩展加载与连接

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| MV3 加载 | background.js 单包 2.59MB | background.js ESM 模块树（426 文件包） | partial（打包形态） |
| SW 启动 | install/startup | install/startup + 自动重连退避 | equal |
| 握手 | protocol/feature floor | hello 带 protocol/extVersion/capabilities；floor 矩阵 | ours extra |
| 未配对连接 | 默认允许；可选配对 | 默认允许 + strict 模式拒绝未验证 | ours extra |
| 配对流程 | 链接/端口/验证/过期/撤销/rotate | 同 + TLS（pairing 46/TLS 8 测试） | ours extra |
| 多浏览器 | browsers 列表/标签 | 同 + 实例 label/instanceId/多实例路由 | ours extra |
| 版本偏差 | version skew 警告 + 升级提示 | `status` protocolSkew + popup 版本偏差/升级提示 | equal |
| 断线 | 自动重连 | ws-client 端口探测/退避/重连 | equal |
| 扩展页面/UI | 6 页 + 浮层 | 11 页 + 浮层（见 UI 对比） | ours extra（页面广度） |

## 4. 会话生命周期

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 新建会话 | `bsk open <url>`（scope/session） | `bridge open <url> [--observe/--focus/--incognito/--scope]` | equal |
| Agent Window | 自动开独立窗口 | 同（window ensure/list/focus） | equal |
| session start | `session start`（自动协作） | `session start [--browser/--tab/--share/--control]` | equal |
| 可恢复启动请求 | session request/claim | prepare/claim/cancel/request | ours extra |
| 重启/绑定 | —（未显式） | `session rebind <id> --tab` + release-old | ours extra |
| 暂停/恢复 | session pause?（未暴露 CLI） | `session pause/resume` | ours extra |
| 停止 | `session stop [--all]` | `session stop <id> [--keep] | --all` | equal |
| 列表 | `session list` | `session list` + run-log + control/lease 字段 | ours extra |
| 多会话/租约 | scope 隔离 | 共享会话/控制权/租约/仲裁/batch | ours extra |
| 批量 | 无 | daemon batch plan/start/status/cancel/retry | extra |

## 5. 导航与观察

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 导航 | open/navigate/back/forward/reload | 同（+wait-for 导航） | equal |
| 观察 | observe/snapshot（VOM + probe） | observe/snapshot + `--vom` 全系（rank/weights/tokens/groups） | ours extra |
| 读取 | read/get-html/extract | 同 + fields-json/closed-shadow/max bytes | equal |
| 帧 | iframe/OOPIF VOM 投影 | frameId/owner 链/matrix 投影/closed shadow | equal（行为差分验证） |
| 输入值读取 | read 不返回输入框 value（脱敏） | read 返回 value | **diff（行为）**：接入需注意 |
| 观察代际 | observation/context 失效语义 | revision/observationId/alias/stale 拒绝 | ours extra |
| 可访问性树 | aria-snapshot | snapshot + ARIA grid/table/role 投影 | equal |

## 6. 动作执行

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 基础动作 | click/hover/fill/press/select/drag/wheel/scroll-to/focus/blur | 同 | equal |
| 可信输入 | 默认可信（CDP） | trusted/--trusted + 拟人轨迹（--human） | ours extra |
| 目标解析 | ref/@eN/CSS | 同 + stableRef/alias/closed shadow/iframe ref | ours extra |
| 前置事实 | --expect | 同 + 不匹配带 data.mismatch | equal |
| 收据/回执 | operation receipt/审计 | tx_id/journal_id/receipt/replayable/reconcile | ours extra |
| 失败恢复 | UNKNOWN 动作 ledger | UNKNOWN + ledger resolve + 组织性恢复提示 | ours extra |
| 上传/下载 | upload/download | 同 + 覆盖策略/结果态 | equal |
| 模拟设备 | emulate（device/width/height/ua/touch） | 同 + dpr/timezone/locale/geolocation/reset | ours extra |
| 输入事件归属 | agentAttributed 归因 | 同 + human 归因窗口 | equal |

## 7. 等待 / 对话框 / 操作

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 等待 | wait-ms/wait-for-element/navigation | 同 + operation cancel 中止 | equal |
| 对话框 | dialog status/accept/dismiss | 同（+recovery/证据） | equal |
| 挂起操作 | operation await/cancel | 同 + operation.cancel/ledger | equal（RPC cancel 仍 missing） |
| 人工协助 | request-help（prompt） | request-help（reason/timeout） | equal |
| 长等待预算 | timeout-ms | 同 + 预算/超时状态 | equal |

## 8. 网络 / 调试

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 网络缓冲 | network（请求/响应/failures） | network.list/detail/start/stop/clear + waterfall | ours extra |
| 请求规则 | rule fulfill/modify/block | 同 + rule replay/derivedNetwork | equal |
| HAR | debug HAR 导出/自检 | 同 + HAR merge/normalize/validation | ours extra |
| 调试采集 | debug（单方法 action） | debug start/stop/requests/console/performance/aggregate/duplicates/operations/evidence | ours extra（粒度拆分） |
| 性能 | 页面指标 + 状态矩阵 | performance 采集 + 预算门禁 + 指标状态 | equal |
| 证据导出 | debug 导出 | 同 + 归档/校验 | ours extra |

## 9. 录制 / 回放 / 视频 / 长截图

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 录制开始 | `record start`（阻塞、录真人） | `record start`（非阻塞；可录 Agent/真人） | **partial（交互模式）** |
| 录制产物 | trace.json + states/ | Trace v3（更细证据） | partial |
| 回放 | 仅 recipe run | replay 引擎（规划/边界/差异/失败矩阵）；**CLI 未暴露 `replay <trace>`** | **missing（共同缺口）** |
| 视频 | video start/status/stop/save/list/discard | 同 + recover/trim/merge/segments/cleanup + 分片日记 | ours extra |
| 长截图 | long-screenshot 页面脚本（自动/手动/可见） | CDP 分块/固定带/DPR/分片恢复/流式读 | ours extra |
| 录制期 UI | recordOverlay（页面浮层） | record-overlay + status-chip（视频已接入；长截图待接） | partial |

## 10. 协作 / 接管

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 协作同步 | cooperate enable/sync/status/wait | 同 + context_id/control_policy | equal |
| 控制策略 | policy auto/strict/target | 同 + passthrough token/lease/epoch | ours extra |
| 借用确认 | borrow confirm（UIA 可点）+ 系统通知 | borrow confirm（closed shadow + human-only）+ 系统通知（action-notifications） | **行为差异（安全设计）** |
| 协助卡片 | help card（留言/完成交还/收起） | 同 + handoff 语义 | equal |
| 接管控制条 | control overlay | takeover overlay（品牌蓝） | equal |
| 并发仲裁 | 无显式 lease | lease report/conflicts/arbitrate | extra |

## 11. 审计与证据

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 审计列表 | operation audit | `audit list/export/prune/clear` + 30 天保留 | ours extra |
| 审计 UI | audit 页 | audit 页（4500+ 行数据面） | ours extra |
| 账本 | UNKNOWN 动作 ledger | `ledger status/resolve` + WAL v2 | ours extra |
| 证据链 | receipt/证据 | receipt/journal/reconcile/证据完整性门禁 | ours extra |
| 脱敏 | 输入/正文脱敏 | 同 + 隐私页 + 脱敏门禁 | equal |

## 12. 关闭与清理

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 关闭会话 | close（归还借用 tab、detach） | `close`/`session stop --keep` + 归还/清理 | equal |
| 全部停止 | session stop --all | 同 | equal |
| 队列/租约 | 无队列 | queue drain/lease release/batch cancel | extra |
| 传输资源 | — | transfer release + staging 清理 | extra |
| 视频/长截图 | 落盘/丢弃 | 落盘/恢复/丢弃 + 保留策略 | ours extra |

## 13. 升级与更新

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 检查更新 | `bsk update check` | `update check/verify/stage/fetch/state/auto` | ours extra |
| 安装更新 | `bsk update`（下载/替换） | `update install --from` + stage 校验 + 回滚 | ours extra |
| daemon 升级提示 | 通知/复制命令/详情 | popup 版本偏差/升级文案；CI 发布待生产私钥 | partial |
| 协议兼容 | feature floor/拒绝 | 4 门禁 + floor 矩阵 + migration planner | ours extra |

## 14. 错误与恢复

| 步骤 | 参考实现 | 我们 | 状态 |
| --- | --- | --- | --- |
| 错误码 | 15 ErrorCode + 102 reason | 161 统一码 + 恢复提示 12 语言 | ours extra |
| UNKNOWN 动作 | ledger/人工裁定 | reconcile + ledger resolve + 不自动重放 | equal |
| 崩溃恢复 | journal | session-start journal/session resume/recovery log | equal |
| 浏览器重启 | 重连 + 恢复 | ws 重连 + video/longshot 恢复 | ours extra |
| 端口/锁冲突 | 报错 | 候选端口/显式端口报错/锁清理 | ours extra |

## 15. 本轮“补齐”记录

1. **`daemon log` 增加 `--lines` 别名**（BSK logs --lines 对齐）；`logs` 作为 `daemon logs` 顶层快捷命令已有。
2. （前几轮已补齐）MCP 92 工具、feature floor 15、schema 155、错误码 161、borrow/help 系统通知、
   status-chip（视频已接入）、popup 组件化、debug 折叠、日志/配对/设备管理、replay 规划引擎等。
3. **仍未补齐（明确）**：
   - `replay <trace>` CLI（共同缺口，需两侧都加才能行为对比）；
   - 长截图 full-page 的 status-chip 运行时接线；
   - record 阻塞式交互（我们保持非阻塞，属产品差异，不强行改）；
   - RPC 通用 `cancel`/`ledger.request` 仍未 canonical（矩阵 missing 4）；
   - audit 数据态截图、BSK UIA 借用窗口定位重试。

## 16. 参考命令

```powershell
# 参考实现
ref\bsk-0.5.0-bin\bsk.exe --help
ref\bsk-0.5.0-bin\bsk.exe status --json
# 我们
node cli/bridge.mjs -h
node cli/bridge.mjs status --json
node tools/bsk-diff/run.mjs --check
```

### 补齐：console 参数面（2026-11-26 晚）

- 参考实现 `console --max-text-chars --include-stack`：我们已补齐：
  - 注入侧 `consoleMainFunc(since, limit, maxTextChars)` 支持长文本截断（附 `truncated/textLength` 证据）；
  - `readConsole`/`tools/read.js` 透传 `maxTextChars`、`includeStack`（stack 缺省为 null，不失败）；
  - schema `console` 增加 `maxTextChars/includeStack`；CLI 增加 `--max-text-chars/--include-stack`。
- 矩阵变化：**646 格：equal 33→34 / partial 305→304**（console 行由 partial 转 equal）。
- 门禁：CLI 404、MCP 216、Python 181、matrix `--check` 0、scale PASS、协议产物已重新生成。

## 17. 收尾补齐（2026-11-26 晚，第二批）

| 差异 | 处理 | 验证 |
| --- | --- | --- |
| 双方都缺 `replay <trace>` | **已补齐我们侧**：`bridge replay <trace.json> [--dry-run]`，把 record export 的 Trace v3 映射为 plan 步骤执行；human-gate/branch 跳过并说明；dry-run 输出方法序列与 stale @ref 提示 | 新增 `cli/lib/trace-replay.mjs` + 3 条单测；CLI 404、README 命令索引 16 条；矩阵 CLI 轴 **extra +1（647 格）** |
| 长截图 full-page 无执行期 chip | **曾接入、本轮回退**：capture chip 注入会干扰 31f 固定页脚 stable 页的 stale 判定（E2E 31f 失败）；已撤销 screenshot.js 接线，保留 status-chip 模块与视频接入。下一步需让 stale 采集忽略 overlay 注入 | E2E 恢复 **222/222** |
| `console --max-text-chars/--include-stack` | 已补（注入截断 + stack 透传 + schema + CLI） | E2E 222/222、CLI/MCP/Python 全绿 |
| `logs --lines` | 已补 + 修复 `bridge logs` 分发 bug | 实测 JSON 输出正常 |
| RPC 通用 `cancel`/`ledger.request` | **不补齐（架构差异）**：我们有意将它们作为 daemon-only 本地方法，测试 `protocol-runtime-derivation` 明确禁止其进入 canonical；矩阵 missing 4 为此设计差异，不是缺陷 | 文档标注 |
| audit 数据态截图 / BSK 借用 UIA 定位 | 仍受环境阻塞（data 运行挂起、UIA 窗口标题不匹配），保留为后续 | — |
