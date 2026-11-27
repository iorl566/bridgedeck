# BSK 0.5.0 ⇄ BridgeDeck 0.3.0 全方面对比

> 口径说明：本文所有结论都标注证据来源；**没有证据的维度写“未知”，不写成等价**。
> - BSK 侧证据：`ref/bsk-0.5.0-bin/bsk.exe`（`bsk 0.5.0`）、`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`（源码树）、`ref/bsk-0.5.0-ext`（扩展产物）、`.ref/bsk-help/`（历史帮助，仅旁证）。
> - BridgeDeck 侧证据：本仓库工作树 + `docs/BSK-DIFF-MATRIX.md`（646 格差分矩阵）+ `tools/scale-baseline.json` + 各门禁输出。
> - 两套代码量的**口径不同**：scale 门禁只统计 js/mjs；BSK 的行数基线包含 Rust/TS/TSX。见 §2 的双口径表，不要把 111.5% 误读成“全栈体量只多 11.5%”。

## 1. 一句话结论

| 判断 | 依据 |
| --- | --- |
| **产品定位相同**：都做“让 AI agent 驱动用户已登录浏览器”的本地工具（扩展 + 本地 daemon/CLI + MCP） | BSK README；我方 `README`/`docs/BSK-PARITY-PROGRAM.md` |
| **表面能力（wire 面）已接近甚至更多**：CLI 79 格 / RPC 172 格 / MCP 148 格 / feature 15 格 / 错误码 223 格 | `docs/BSK-DIFF-MATRIX.md`（646 格，equal 33 / partial 305 / missing 31 / extra 257 / unknown 20） |
| **实现路线不同**：BSK 是 Rust CLI + TS/React 扩展的单生态；我方是“零依赖 JS 运行时基线 + TS 架构轨道 + Rust CLI 辅助”的双栈 | §4 |
| **深度仍有差距**：行为级等价（而非线格式）未证明；RPC unknown 20 格、partial 305 格、P0 32 条 | 矩阵 + §13 |
| **质量工程我方更重**：单测 5,051 + CLI 404 + MCP 216 + Python 181 + TS 测试 + Rust 260 + E2E 222，门禁 15+ 类 | §9 |

## 2. 体量与代码组成（双口径）

### 2.1 scale 门禁口径（只计 js/mjs，历史里程碑使用的口径）

| 侧 | 文件 | 行 | 说明 |
| --- | --- | --- | --- |
| BSK 0.5.0 基线 | — | **316,463** | 文档基线（含 Rust/TS，非纯 js/mjs） |
| BridgeDeck 0.3.0 | 1,459 | **352,967** | `tools/scale-baseline.json`，**111.5%** |

**⚠️ 口径警告**：该百分比只说明“我方 js/mjs 行数 / BSK 全语言基线”，**不是同语言全栈对比**。

### 2.2 全栈口径（把各自的 Rust/TS/JS 都算上，实测原始文件）

| 侧 | Rust | TS/TSX | js/mjs | 合计（近似） |
| --- | --- | --- | --- | --- |
| BSK 0.5.0 | 90,559（216 文件） | 209,197（663 文件） | 12,083（74 文件） | **≈311,839**（另有 json/md/toml 未计） |
| BridgeDeck 0.3.0 | 13,141（26 文件） | 75,945（242 文件） | 352,967（scale 口径） | **≈442,053** |

- 全栈口径下我方约为 BSK 的 **≈1.42 倍**（352,967+75,945+13,141 vs 316,463 文档基线）。
- BSK 的 ts/tsx 主要集中在 `apps/extension`（179,739 行，556 个 .ts/.tsx 源文件）；其 `crates/` 为 92,491 行（`bsk-cli` 83,448 + `bsk-protocol` 9,043）。
- 我方 TS 架构轨道：`apps/extension/src+entrypoints` 42,258、`apps/extension/tests` 19,400、`packages/protocol` 7,359、`packages/vom` 7,267；Rust `crates/bridge-cli` 13,487。
- 我方 JS 运行时基线：`extension` 110,665（其中 `extension/src` 86,615、`src/lib` 53,096）、`lib` 23,176、`cli` 17,781、`daemon` 12,055、`mcp` 11,833、`sdk` 3,313、`tools` 31,275、`tests` 111,238。

## 3. 产品形态与分发

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 | 谁更成熟 |
| --- | --- | --- | --- |
| CLI 形态 | 单文件二进制 `bsk.exe`（**23.5 MB**，`bsk 0.5.0`） | Node 脚本 `cli/bridge.mjs`（要求 Node ≥20；无二进制） | BSK（零运行时依赖分发） |
| 本地 daemon | 内嵌在 bsk CLI（同进程/子进程） | 独立 `daemon/server.mjs` + WS + TLS/配对 | 相当（我方 daemon 可独立重启/多会话） |
| 浏览器扩展 | MV3，`background.js` **2.59 MB**（bundled） | MV3，TS 产物 **1.26 MB**（34 文件）/ JS 基线扩展目录 **9.36 MB**（426 文件） | 我方 TS 产物更小；JS 基线为未打包树 |
| 扩展入口 | background SW + 3 组 content scripts（cooperation/record-frame、long-screenshot、主 content） | background SW + 1 组 content script（全 frame、document_start）+ `scripting` 注入 page-lib | 路线不同：BSK 多脚本隔离，我方单脚本 + 注入 |
| 扩展页面 | 6 页（popup/audit/debug/long-screenshot/video/video-offscreen；`extPages=6`） | 11 页（popup/options/quick/debug/audit/ops/record/longshot/preview/workspace 等；`extUiPages=11`） | 我方页面更多 |
| 安装/升级 | `install.ps1` / `install.sh` + GitHub release（CLI/extension/dsh-plugin 三条发布流水线）+ 自动 `update` | **发布链路已本地验证通过（2026-11-26，见 `docs/RELEASE-PIPELINE-VERIFICATION.md`）**：扩展 / CLI bundle / 4 平台可移植包 / 安装器 / 插件包 + Ed25519 清单签名 + preflight/verify-release 全绿；生产私钥、真实证书、GitHub tag 发布待真环境 | BSK 已公网发布；我方本地链路已验证，公网发布待密钥/CI |
| 签名/公证 | macOS signing/notarize 文档 + `sign-release` 类流水线 | 有 `tools/sign-windows.ps1`、macOS 签名/公证脚本 | BSK 已实际发布，我方脚本未在真实发布链路验证 |
| MCP 形态 | `bsk.exe mcp`（stdio，7 工具 + recipe opt-in，56 action） | `mcp/server.mjs`（stdio，**92 工具**） | 我方工具面更大 |
| SDK | Rust 协议库 + dsh-plugin 包 | Node SDK + Python SDK（含 MCP client）+ 契约测试 | 我方语言覆盖更广 |

## 4. 技术栈与架构

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| 主语言 | Rust（CLI/daemon/协议）+ TypeScript/React（扩展） | JavaScript（运行时基线）+ TypeScript（架构轨道）+ Rust（CLI 辅助） |
| Workspace | pnpm workspace + Cargo workspace（2 crates） | 无 workspace 管理器（零依赖 JS 树 + pnpm 仅 TS 应用） |
| 扩展 UI | React 组件（`packages/ui`，`app/ui` 风格） | 原生 DOM 页面 + helper 模块（`extension/ui/**`）+ React TS 轨道 |
| VOM（视觉对象模型） | `packages/vom`（5,011 行） | `packages/vom`（7,267 行，TS）+ `lib/vom-*`（JS 运行时） |
| 协议 schema | `bsk-protocol` crate + dump-schema → TS 生成 | `lib/schemas.mjs`（155 schema）+ `packages/protocol` + 生成器门禁（single-source/protocol-check/gen-protocol/sections） |
| i18n | `packages/i18n`（**10** locale：de-DE/en-US/es-ES/fr-FR/it-IT/ja-JP/ko-KR/pt-BR/zh-CN/zh-TW） | `translation/`（10 个外挂 JSON + 基础） + 12 语言覆盖门禁（含 RTL ar/he，4,126 条） |
| Eval/回归 | `evals/`（133 文件，browser eval 框架） | `tools/eval`（102 property / 6,528 checks）+ `tests/eval` + `tools/longtail` + `tools/quality` |
| 插件/技能 | `packages/dsh-plugin-browserskill` + `AGENT_INSTALL.md` | `dsh-plugin/`（3,980 行）+ `skill/`（15 文件） |
| CI | **5** 个 GitHub workflow（ci/publish-cli/release-cli/release-dsh-plugin/release-extension） | **8** 个（ci/quality/real-browser-e2e/release-cli/release-extension/release-dsh-plugin/sign-release/publish-cli） |
| 依赖面 | `Cargo.lock` **317** 个 crate；npm devDeps 6（biome/ajv/esbuild/stylelint/…） | JS 基线**零运行时依赖**；TS 应用 4 个运行时依赖（React/ReactDOM/mediabunny/remixicon）+ 1 dev（vitest）；Rust CLI `Cargo.lock` 仅自身包（无外部 crate） |
| License | MIT | MIT |

## 5. 协议与 wire 层

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 | 矩阵判定（646 格） |
| --- | --- | --- | --- |
| CLI 命令面 | **56** 命令（`bsk.exe --help`） | 我方 **79** 个 CLI 动词（含子命令组） | cli 轴 79 格：equal 8 / partial 48 / extra 23 / missing 0 |
| RPC 方法 | **77**（`bsk-protocol/src/method.rs`） | **165** canonical + 7 daemon-only | rpc 轴 172 格：equal 10 / partial 60 / missing 4 / extra 78 / unknown 20 |
| MCP 工具 | **7** 工具 + recipe opt-in（8），**56** action | **92** 工具 | mcp 轴 148 格：equal 0 / partial 104 / extra 44 / missing 0 |
| Feature floor | **9**（`compatibility.rs`） | **15**（我方多 6 个 BSK 有/对齐门 + 自有门） | feature 轴 15 格：equal 1 / partial 8 / extra 6 / missing 0 |
| 错误码 | **15** ErrorCode + **102** RpcErrorReason | **161** 统一码 | error 轴 223 格：equal 13 / partial 77 / missing 27 / extra 106 |
| 版本/兼容 | 协议版本 + feature floor 协商 + 明确拒错 | 同形：协议四种门禁 + floor 矩阵 + migration planner | 口径一致，行为级未逐条对端验证 |
| 本地安全通道 | 本机配对（local pairing 文档） | WS + 本机配对 + TLS（pairing 46 / TLS 8 测试） | 我方门禁更细 |
| 通用 cancel / ledger | BSK 有 `cancel {rpc_id}` / `ledger.request` RPC | 我方为 daemon 本地方法（canonical 未收录） | 矩阵仍判 **missing 4**（真实缺口：未走协议 wire） |

**已知未对齐（P0 摘录）**：通用 `cancel`/`ledger.request` 未进入协议方法面；`tool.debug/tool.network` 是 BSK “单方法 action 分发”，我方拆成多方法（debug.*/network.*），字段级只判 partial；`system.status.wait_for_browser_ms` 无对应；emulate/network 的部分零交集字段保持 unknown（见 §13）。

## 6. 能力面覆盖

| 能力 | BSK 0.5.0 | BridgeDeck 0.3.0 | 备注 |
| --- | --- | --- | --- |
| 会话/窗口/标签 | session/tab/window/tabGroups | 同形 + 租约/共享会话/控制权移交 | 我方 daemon 层更细（lease/arbitration/batch） |
| 观察/VOM | observe/snapshot/VOM probes | observe/--vom/--frames/closed-shadow/relations/z-order | 我方形状对齐；semantics 未做像素级 oracle |
| 动作/输入 | click/fill/press/hover/drag/wheel/select/focus/blur/upload/download + trusted | 同 + trusted CDP / stableRef / click-backend / 拟人输入 | 矩阵多处 equal/partial |
| 网络 | network 缓冲 + debug/rule/Fetch/HAR | 同 + waterfall attribution/HAR merge/trace budget | 我方分析层更深 |
| 录制/回放 | record → trace.json textbook；recipe 回放 | record Trace v3 + replay 引擎（规划/边界/差异/失败矩阵） | 我方回放工程更深；BSK recipe 更产品化 |
| 长截图 | long-screenshot content script + page | CDP 分块/固定带/DPR/分片恢复/流式读 | 我方覆盖更全（矩阵 partial 差值） |
| 视频 | video + video-offscreen（tabCapture/offscreen） | video 服务 + offscreen + MP4/分片/恢复 | 我方 TS 产物已对齐；真实手势路径仍需有头环境验证 |
| 协作/人工 | cooperate（context_id + control_policy）、request-help、dialog/operation | borrow/passthrough/lease/toolbar/human-gate + 同形 context/policy 证据 | 矩阵 extension 轴 9 格 equal 1 / partial 8 |
| 浏览器 | browsers 列表/多浏览器 | browsers + 配对/实例管理；E2E 只覆盖 Edge | BSK 多浏览器支持待实测 |
| 调试 | debug 请求/上下文/导出 | debug 同 + Fetch/PDF/emulate/trace/rule replay | 我方 debug.* 拆分方式不同 |
| 审计 | operation audit 文档 + 实现 | audit/journal/证据完整性/时间线 | 各有实现 |

## 7. 扩展运行时细节（manifest / 权限 / 页面）

| 项 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| manifest_version | 3 | 3 |
| 最低 Chrome | **125** | **111** |
| permissions | alarms, activeTab, debugger, downloads, idle, notifications, offscreen, scripting, tabs, tabGroups, storage, webNavigation, windows（13） | tabs, scripting, storage, alarms, idle, notifications, windows, downloads, webNavigation, debugger, **tabCapture**, offscreen, tabGroups, **declarativeNetRequest**（14） |
| host_permissions | `<all_urls>` | `<all_urls>` |
| 独有权限差异 | **activeTab**（更窄的临时授权） | **tabCapture**（视频录制）、**declarativeNetRequest**（网络规则） |
| content scripts | 3 组：主（document_end，top frame）、cooperation+record-frame（document_start，all frames，match_about_blank）、long-screenshot（http/https） | 1 组内容脚本（document_start，all frames，match_about_blank）+ `scripting` 注入 page-lib |
| background | service worker | service worker |
| 扩展页面 | 6 | 11 |
| 构建产物 | 34 文件，总额 4.66 MB（background 2.59 MB 单包） | **发布包为源码树逐文件打包：426 文件 / zip ≈3.6 MB（自有方式，保留模块边界）**；TS/WXT 架构轨道另有 34 文件 / 1.26 MB 产物，仅用于架构验证与 E2E |

## 8. 安全与隐私

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| 本地通道 | 本机配对（local auth） | WS + 本机配对 + TLS；pairing 46 测试、TLS 8 测试、`daemon pair` 链接 5 分钟有效 |
| 扩展权限最小化 | 用 activeTab 减少常驻读权限 | 未申请 activeTab；但多 tabCapture/DNR 两项 |
| 高危能力 | debugger（CDP）、scripting、downloads | 同 + tabCapture + DNR 规则注入 |
| 人工开关保护 | 配对/模式类设置 | `settings.set` 对 daemonUrl/token 返回 E_FORBIDDEN（仅用户可改）；human input / 控制权门控 |
| 审计 | operation audit | audit/journal + 证据完整性 + 记账门禁 |
| 对抗场景 | 未验证（CSP/权限撤销/恶意页面） | 部分门禁（页面守卫/编码守卫），对抗场景同样未系统化 |

## 9. 质量与测试

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| Rust 单测 | **1,223** 个 `#[test]`/`#[tokio::test]`（源码内） | **260**（源码 `#[test]` 计数 = 260；最近一次 cargo 复跑为 W7，后续轮次未改 `crates/`，标注“未复跑”） |
| 前端/Node 测试文件 | **305** 个 `*.test.ts/tsx/mjs` + evals 133 文件 | **797** 个测试文件（mjs/ts/py）；5,051 单测 + 404 CLI + 216 MCP + 181 Python + **TS 649** + 222 E2E |
| 真实浏览器 E2E | `apps/extension/e2e`（1 个目录，具体规模未核对） | `tools/e2e.mjs` **222** 条，JS 与 TS 产物各跑一遍；本轮收口双栈 **222/222** |
| 门禁类别 | Rust clippy/rustfmt/biome/stylelint/CI 5 条 | 15+ 类：协议 4 门禁、schema/依赖/readme/scale/quality/longtail/bsk-diff/performance/encoding/vendor/架构守卫/unused/模块加载 等 |
| 差分矩阵 | 无（BSK 不需要对自己做差分） | **646 格**证据化矩阵（`tools/bsk-diff`，`--check` 可复现） |
| Eval | `evals/`（browser eval 133 文件） | `tools/eval`（102 property/6,528 checks）+ 长尾/质量门禁 |

## 10. 性能与可靠性

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| 启动 | 单二进制，冷启动未知（未实测对照） | Node 进程冷启动（`tools/startup.mjs` 有基线门禁，但未与 BSK 对照） |
| 长任务/录屏 | 原生 tabCapture 路径 | tabCapture + CDP screencast 兜底；有头/手势路径待真机验证 |
| 性能门禁 | CI 层（未知具体阈值） | `performance-budget`（4 热路径 p50/p95 + 内存）、`vom-bench`、`longtail`（1788 refs/9MB HAR/240 步/120 片） |
| 可靠性 | 发布版（0.5.0），用户真实负载未知 | E2E 双 222；修复过 `E_SESSION_PAUSED` 级联与截图 readback 抖动；长跑仍出现过单测/E2E 抖动（已记录） |
| 跨平台 | Windows + macOS（签名/公证文档、install.ps1/sh） | 以 Windows/Edge 实测为主；macOS 有脚本未在真实发布链验证 |

> 注：本会话没有做“同一机器、同一任务、BSK vs 我们”的端到端性能基准；性能对比只能停留在门禁与架构层，不能给数字结论。

> **行为级差分（2026-11-26，三阶段扩到 18 任务）**：`tools/bsk-differential` 在真实 Edge 上跑同一 fixture：**15/18 equal，2 diff，1 unsupported**（diff：`read_after_fill` 的输入框 value 暴露、以及整页截图对可见窗口的严格要求；unsupported：借用标签页需要交互式确认 UI）。详见 `docs/BEHAVIOR-DIFF-BSK.md`；逐项全功能状态见 `docs/FEATURE-COMPARISON.md`。

## 11. i18n / A11y / UX

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| 语言数 | **10** locale（`packages/i18n`） | **12 语言覆盖门禁**（4,126 条）+ RTL（ar/he）审计；`translation/` 10 个外挂 JSON + 基础 zh-CN/en |
| A11y | 未知（未核对） | a11y 静态/对比度/焦点陷阱/aria-live/aria-modal 门禁（历史轮次 10+7 断言） |
| UI 形态 | React 组件（packages/ui） | 原生 DOM 页面 + helper（extension/ui）+ React TS 轨道 |
| 视觉一致性 | 设计系统未知 | `ui/lib` 15 helper、主题/label 统一；逐页 UI 差距见 [`docs/UI-COMPARISON.md`](UI-COMPARISON.md) |

## 12. 扩展性 / 生态

| 维度 | BSK 0.5.0 | BridgeDeck 0.3.0 |
| --- | --- | --- |
| 插件 | `dsh-plugin-browserskill`（独立包 + AGENT_INSTALL） | `dsh-plugin/`（3,980 行，工具/技能/资源体系）+ `skill/` 15 文件 |
| SDK | Rust protocol crate + dump-schema | Node SDK（mcp-client/tool-catalog/contract）+ Python SDK（同步+异步，181 测试） |
| MCP | stdio server（7 工具+8 recipe） | stdio server（92 工具）+ Node/Python MCP client |
| 脚本化 | recipe（reviewed flow）+ plan/step | recipe + plan/step/record replay + crate/batch |
| 扩展点 | 未核对（插件/主题机制） | `dsh-plugin`、`skill`、`tools/*`、协议 catalog 单源 |

## 13. 差异矩阵摘要（646 格）

| 轴 | 格数 | equal | partial | missing | extra | unknown | 已取证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ① CLI 命令 | 79 | 8 | 48 | 0 | 23 | 0 | 100% |
| ② RPC 方法 | 172 | 10 | 60 | **4** | 78 | **20** | 88.4% |
| ③ MCP 工具 | 148 | 0 | 104 | 0 | 44 | 0 | 100% |
| ④ 扩展能力 | 9 | 1 | 8 | 0 | 0 | 0 | 100% |
| ⑤ Feature floor | 15 | 1 | 8 | 0 | 6 | 0 | 100% |
| ⑥ 错误码 | 223 | 13 | 77 | 27 | 106 | 0 | 100% |
| **合计** | **646** | **33** | **305** | **31** | **257** | **20** | **—** |

- `unknown 20` 全部集中在 RPC 轴，且都写清“缺什么证据”（BSK 侧 `serde_json::Value`/零交集字段等），**未计入等价**。
- `missing 31` 分布：RPC 4（通用 `cancel`、`ledger.request` 等未走 wire）+ 错误码 27（BSK 的 reason 码在我方统一码表里无同名/无对应语义）。
- `extra 257` 是我方独有能力/码，不代表 BSK 缺该能力（矩阵对 extra 有专门说明）。

## 14. 结论：谁领先 / 持平 / 落后

**我方明显领先的维度**
- 质量工程：单测/E2E/门禁类别与规模（5,051 + 222 双栈 + 15+ 门禁）。
- 本地编排深度：daemon 租约/批处理/恢复、record/replay 工程、长截图/视频持久化、审计/证据链。
- 语言与 SDK 覆盖：Node + Python SDK、双语言 MCP client。
- 可验证性：差分矩阵、protocol catalog 单源、eval/quality/longtail 门禁。

**基本持平/各有取舍**
- MV3 扩展通用能力、CLI 主命令面、协议协商、TLS/配对、VOM 形状、i18n（10 vs 12 门禁覆盖，但 BSK 语言包更产品化）。

**我方明确落后/未证明**
- **公网发布**：BSK 有单二进制、安装脚本、三条发布流水线、签名/公证且已实际发布；我方发布链路已本地全绿验证（2026-11-26，见 `docs/RELEASE-PIPELINE-VERIFICATION.md`），但生产签名私钥、CA 证书、macOS 公证与 GitHub tag/release 尚未在真实流水线执行。
- **行为级等价**：矩阵只能证明线格式/字段/码面；**没有 BSK vs 我们的行为级差分基准**（同一任务跑两边、比较输出/副作用）。
- **协议 wire 完整性**：通用 `cancel`/`ledger.request` 仍是 daemon 本地实现，不是协议方法（矩阵 missing）。
- **多浏览器/真实桌面**：BSK 宣称多浏览器与 macOS 发布；我方 E2E 仅 Edge（有头），macOS 未验证。
- **性能对照**：没有同机同任务的性能基准数字。
- **安全对抗**：CSP/权限撤销/恶意页面/GB 级数据等对抗场景两边都没有系统化证据（我方有长尾门禁但非对抗安全）。

## 15. 建议的下一步（若要“全方面”继续收敛）

1. **行为级差分基准**：用 `ref/bsk-0.5.0-bin/bsk.exe` 与我们 CLI 对同一夹具页跑同一任务集，比较 CLI JSON/副作用/截图，形成行为差分报告（比线格式矩阵更硬）。
2. **协议 wire 补齐**：把 `cancel`/`ledger.request` 提升为 canonical 协议方法（含 floor/错误码/兼容矩阵）。
3. **真实桌面矩阵**：在 macOS/Windows 有头环境跑双栈 E2E；补多浏览器（Chrome/Firefox）冒烟。
4. **性能基线**：同机同任务测启动、observe、click、长截图、视频、并发会话，输出 p50/p95/内存对照。
5. **发布链路**：按 BSK 的 install/release 形态验证我方打包/签名/升级（用户明确同意后再动 `dist/`）。

## 16. 复核命令

```powershell
cd D:\浏览器桥
$env:PATH='D:\tools\node;'+$env:PATH
node tools/bsk-diff/run.mjs --check            # 646 格矩阵（JSON+Markdown 与仓库一致）
node tools/scale-report.mjs --check            # 体量基线
node tools/source-guard.mjs                    # 编码/文档同步/守卫
node --test 'tests/unit/*.test.mjs'            # 5,051 单测
node tests/cli/selftest.mjs                    # CLI 404
node tests/mcp/selftest.mjs                    # MCP 216
python -m unittest discover tests/python       # Python 181
node tools/e2e.mjs --browser edge --port 54007 # JS E2E 222
node tools/e2e.mjs --browser edge --ext-dir apps/extension/.output/chrome-mv3 --port 54207 # TS E2E 222
```
