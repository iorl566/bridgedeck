# 浏览器扩展与 BrowserSkill 0.5 / 同类项目差距分析

日期：2026-11-17。范围：`extension/`、`manifest.json`、`package.json`、`docs/`，
参考 `.ref/repo`（BrowserSkill 0.5.0 源码）与 `ref/bsk-0.5.0-ext`（0.5.0 构建产物）。
只分析，不改 CTRM 目录。

## 1. 结论

1. **0.1.8 的 UI 收尾已经完成并验证，但“产品收尾”没完成**：构建未上架、
   `release.json` 签名待重签；Debug/Audit/长截图证据视图仍是独立工作量。
2. **和 BrowserSkill 最大的差距不是工具数量，而是三块生产能力**：
   - 协作输入层（input blocker / passthrough / cooperation capture）：第一版已补
     （可选点击/滚动锁 + passthrough + read），完整 cooperation state 仍未做；
   - 远程 server mode + 设备配对/续期/撤销/网关协议；
   - 工程形态与发布（TS/组件化/评测/上架）。
3. **扩展里有大量“参考镜像”没有接进运行时**。按静态入口图，132/243 个扩展 JS
   文件不可达，占迁移前扩展源码约 42.5%。本轮已把它们物理迁到
   `reference/extension-mirror/`，对应测试移到 `tests/reference/`；`extension/`
   现在只剩运行时模块。
4. **和 Browser Use / Playwright MCP / Chrome DevTools MCP 等比，缺的是
   LLM/视觉规划、跨浏览器、代码生成/trace/Lighthouse、云/代理**；
   我们的优势仍是本地已登录浏览器、观察事实层、借用/协作、CLI/MCP/DSH 和
   真实反爬实测。不要为了“像 bsk”恢复已删除的 React 副本。

## 2. 运行时 vs 参考镜像（硬数据）

统计方法：从 `background.js`、UI 页面、`offscreen.js`、manifest content scripts、
`page-lib.js` 和动态 `files:` 注入入口出发，解析静态 import / 动态 import /
`new URL()`，得到运行时可执行模块集合。

| 指标 | 数值 |
| --- | --- |
| 迁移前扩展 JS 文件 | 243 |
| `extension/` 运行时 JS | 120 |
| `reference/extension-mirror/` 参考 JS | 132 |
| `extension/` 当前源码字节 | 1,283,948 B |
| 已迁出的参考镜像字节 | 949,875 B |
| 参考镜像占迁移前源码 | **约 42.5%** |

本轮已落地（2026-11-17）：

- 132 个参考镜像物理迁移到 `reference/extension-mirror/`；`extension/` 只剩运行时；
- `tools/lib/extension-runtime.mjs` 计算运行时入口，并把 daemon/CLI 直接引用的共享模块算回运行时；
- `tools/build-extension.mjs` 只把 120 个运行时 JS + 非 JS 资源打进 zip；
- 发布包：**668,681 B → 429,542 B（-35.7%）**，entries **263 → 141**；
- `tools/verify-extension-package.mjs` 解压 zip 后验证 service worker 可加载、
  所有静态 import/HTML script 都存在；
- 依赖参考模块的 507 个测试移到 `tests/reference/`，运行时单测 **469**；
- `tests/unit/extension-runtime-reachability.test.mjs` 防止新增未分类 JS。

已迁出的参考镜像分组：

| 目录 | 不可达文件数 | 说明 |
| --- | --- | --- |
| `src/lib/recording` | 19 | 参考版录制运行时/状态机 |
| `src/lib` 其他 | 21 | 连接控制、配对、审计、hover 策略等参考实现 |
| `src/debug` | 20 | 参考版 DebugManager/archive/network-store/evidence 等；运行时用 `src/debug.js` |
| `src/long-screenshot` | 15 | 参考版 tile/capture/render；运行时用 `src/screenshot.js` + `longshot*.js` |
| `src/transport` | 13 | 参考版 remote authorization/device endpoint；运行时用 `ws-client.js` 简化实现 |
| `src/video` | 20 | 参考版 encoder/store/manager；运行时用 `src/video.js` + `video-encoder.js` |
| `src/session-manager` | 10 | 参考版 session registry/window routing；运行时未注册 |
| `src/cooperation` | 7 | 参考版 cooperation capture/control authority |
| `src/content` | 4 | 参考版 record capture/frame agent；运行时用 `content/record-capture.js` |
| 其他 | 3 | screencast-coordinator、shared identity、i18n-lite |

具体证据：

- `attachSessionEventHandler` 只有测试引用，`bridge.js` 没有调用它；用户把标签移出
  Agent Window 的 `session.ended` 路径没有走这份参考实现。运行时只处理
  `chrome.tabs.onRemoved`（清租约/缓存/浮层状态并上报 `tab-removed`）。
- `src/debug.js`、`src/video.js`、`src/screenshot.js` 是运行时实现；
  `src/debug/*`、`src/video/*`、`src/long-screenshot/*` 是参考镜像。
  两套同名概念并存，但只有前者随运行时生效。
- `package.json` 的 `react`、`react-dom`、`@remixicon/react`、`mediabunny` 只被
  不可达镜像（`src/video/*`、`src/debug/use-tasks.js`）引用；`vitest` 也没有
  对应测试文件。运行时实际零前端依赖。
- `tests/reference/source-module-coverage.test.mjs` 只证明参考文件能 import，
  不再属于运行时单测；运行时单测由 `tests/unit/extension-runtime-reachability.test.mjs`
  守住入口分类。

## 3. 与 BrowserSkill 0.5 的对比

| 能力 | BridgeDeck 0.1.8 | BrowserSkill 0.5.0 | 差距判断 |
| --- | --- | --- | --- |
| 运行时 content scripts | `page-lib`、`human-watch`、`record-capture` | `content`、`cooperation`、`record-frame`、`long-screenshot-page` | 缺协作 content script；长截图注入方式不同 |
| 输入协作 | 可选 `cooperationGuard`：接管时阻止点击/滚动，暂停/收起放开；passthrough 包住 Agent 输入；`cooperation.read` 脱敏字段/媒体 | `ControlInputBlocker`、`input-passthrough`、`cooperation-capture`、`capture-suppress` | 已补第一版；仍缺 bsk 的完整 cooperation state/toolbar 与事件归因 |
| 借用/接管/帮助 | 有，0.1.8 刚补齐 token/深色/DOM 测试 | 有 React 浮层 + 组件测试 | UI 细节接近；我们组件测试刚起步 |
| 远程连接 | `daemon start --mode server` + TLS PFX + `/health` bind/publicUrl；配对 TTL；设备凭据持久化/撤销/续期（`devices.json`）、`--scope read|control`；本地 preview/focus 页 + 远程 viewer（截图/meta/click/key/focus） | 第三方网关协议、拖拽/滚动/剪贴板远程控制 | 第一版已落地（[remote-server](remote-server.md)）；仍不是完整设备生命周期 |
| 浏览器 Profile | instanceId / label / `--browser`；同名 label 现在返回 `E_BROWSER_AMBIGUOUS`；补了 [browser-profiles](browser-profiles.md) | 完整 profile 选择、复制指令、incognito 说明 | 部分补齐；仍无 profile 路径确认 |
| 观察/事实层 | `observe/snapshot`、AX、closed shadow、facts、delta | 同类能力 + VOM 包 | 功能接近；工程封装不同 |
| 调试/证据 | `debug.js` + popup 内嵌面板 | 独立 debug 页：analysis/evidence/network-controls/operation-evidence + 测试 | **证据视图差距**（用户已列为独立产品工作） |
| 长截图 | `screenshot.js` 自动/手动拼接 + 页面 | tile preview/export worker + 页面 | UI/导出体验差距 |
| 视频 | `video.js`（MediaRecorder/offscreen） | React video 页 + offscreen | 功能接近；UI 差距 |
| 审计 | CLI + audit 页 | CLI + React audit 页 | 功能接近；UI 差距 |
| i18n | 10 种语言；251 条 UI 词条 + 54 条浮层语义键 × 8 语言；所有 ui/*.html 缺口 0，浮层已本地化 | 持续翻译维护 | 全扩展 i18n 已落地 |
| 测试 | Node 单测 + 真实 DOM 浮层测试；无组件测试框架 | Vitest + happy-dom + testing-library + 组件测试 | 工程差距 |
| 评测 | e2e 单体 + 反爬脚本 | `evals/browser` case/oracle/coverage/seeded generator | 质量体系差距 |
| 工程形态 | 原生 JS，无构建/类型检查/lint | WXT + TS + React + Tailwind + biome/stylelint | 可维护性差距 |
| 构建体积 | 429,542 B（裁剪后，141 entries） | 1,280,007 B（功能/组件更多） | 我们不是“更小更强”，而是“少代码也少能力” |
| 最低版本/权限 | Chrome 111；`tabCapture`/`declarativeNetRequest` | Chrome 125；`activeTab` | 兼容/审核策略不同 |
| 发布 | 0.1.8 九制品统一，preflight 只剩 unsigned | Chrome/Edge 商店 0.5.0 | 签名/商店权限外部阻塞 |

## 4. 同类项目对照

| 项目类型 | 它们强在哪 | 我们缺什么 / 是否该补 |
| --- | --- | --- |
| Playwright MCP | 跨 Chromium/Firefox/WebKit、codegen、trace、成熟测试运行器、网络 mock | 跨浏览器、codegen/trace 导出；若只做“用户已登录 Chromium”可暂不补 |
| Chrome DevTools MCP | Lighthouse/performance trace、console/network、Chrome 生态 | Lighthouse/性能报告、证据视图；我们有 debug/perf 但没有 Lighthouse |
| Browser Use / Stagehand / Nanobrowser | LLM 规划、自然语言选择器、动作缓存/自愈、可视化任务 | 任务级 agent/视觉语义层；建议做成可选 skill/插件，不进确定性核心 |
| Browserbase / Steel / Skyvern | 云端浏览器、代理、stealth、session replay | 云/代理/多租户；本地优先产品可暂不补，但要明确边界 |
| BrowserSkill | 本地已登录浏览器 + Agent Window + 借用 + 协作 + 远程 + 评测 + 商店 | 见第 3 节；最值得对标的是协作输入层、远程 server mode、评测/工程 |

## 5. 还没整完的清单

### P0：正确性与发布（1–2 天）

1. ~~**运行时/镜像分层**~~（本轮已完成）：132 个参考镜像物理迁到
   `reference/extension-mirror/`，对应测试移到 `tests/reference/`；新增运行时
   可达性门禁。后续只剩把 React/mediabunny 仅保留给参考测试这一项清理，
   不影响运行时和发布包。
2. **重新签名并发布 0.1.8**：`node tools/release.mjs --sign-ed25519 <key>`；
   上架/更新；用测试 daemon 真实复现一次协议偏斜，验证 Popup 的
   `daemon_newer` / `daemon_older` 两条路径，而不是只靠 `preview` 合成状态。
3. **UI 小缺口**：
   - ~~Toast 与 Edge 系统通知重叠~~（已修：借用 Toast 不再额外发系统通知；真机 UIA
     复核只剩页面 Toast，无系统通知遮挡）；
   - `record-overlay`、`manual` 浮层还没接统一 token；
   - `ui/i18n.js` 只有 zh/en，和配对指引的 10 语言不一致。

### P1：对齐 bsk 的生产能力（1–2 周）

4. **协作输入层**（第一版已落地）：manifest content script `content/cooperation.js` +
   `src/cooperation.js`，实现可选点击/滚动锁、passthrough（5s TTL）与
   `bb.cooperation.read`。默认关闭，popup/options 中有开关。与 bsk 对齐时明确：
   bsk 的 blocker 只拦指针/滚动/touch，不拦键盘；我们的第一版按此实现。
   仍缺 bsk 的 cooperation state/toolbar 和事件归因（human/agent 模式切换）。
5. **远程 server mode / 设备授权**（第一版已落地）：`daemon start --mode server`、
   `--public-url`、TLS PFX、配对 TTL/撤销、[remote-server](remote-server.md)。
   仍缺设备凭据续期/细粒度权限、反代/网关协议与 UI preview/focus。
6. **Profile 绑定**（部分落地）：同名 selector 已拒绝（`E_BROWSER_AMBIGUOUS`），
   新增 [browser-profiles](browser-profiles.md)；仍缺 profile 路径确认与更细的复制指令。
7. **证据视图**：Debug/Audit/长截图拆成独立页面/组件，先做证据时间线、
   请求详情、截图对比；按用户要求单独立项，不和借用 UI 混做。

### P2：形成差异化（按目标市场选择）

8. **评测体系**：移植 bsk 的 `evals/browser` 结构（case/oracle/coverage/
   seeded generator），CI 增加真实浏览器 job；否则“能跑”只靠 e2e 单体。
9. **跨浏览器/云/代理**：若企业目标需要，Playwright/CDP 双栈；否则明确只支持
   Chromium 本地。
10. **语义层**：自然语言选择器、动作缓存、视觉模型作为可选插件；
    核心 bridge 保持确定性、可审计、零模型依赖。

## 6. 推荐顺序

1. 先做 P0-1（分层/删镜像/门禁）——立刻减少 45% 源码和“假能力”，风险最低。
2. 再做 P0-2（签名/上架/真实 skew）——否则 0.1.8 只是本地包。
3. 然后二选一：
   - 要“共享控制体验” → P1-4 协作输入层；
   - 要“服务器端 Agent 控制本机浏览器” → P1-5 远程 server mode。
4. 最后做 P1-6/7 和 P2。

## 7. 不必做的事

- 不恢复已删除的 React 副本，也不为了“像 bsk”引入 React/WXT；原生 JS +
  真实 DOM 测试已经能覆盖当前浮层。
- 不把参考镜像直接当运行时能力宣传；能力必须以 manifest 注册 + 运行时入口 +
  真实浏览器验证为准。
- 不在借用 UI 这批里混做 Debug/Audit/长截图证据视图。


> 与 BSK 0.5.0 的量化能力差异见 [CAPABILITY-DELTA-BSK-0.5.0](CAPABILITY-DELTA-BSK-0.5.0.md)。


> 完整版（0.1.9 对照，含观察/输入/协作/frame/捕获/协议/测试矩阵）：[GAP-ANALYSIS-BSK-0.5.0-FULL](GAP-ANALYSIS-BSK-0.5.0-FULL.md)。
