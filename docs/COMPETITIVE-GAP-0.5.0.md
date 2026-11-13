# 0.5.0 代码优化点与成熟工具对照（差距清单）

## A. BrowserSkill 0.5.0 的代码级优化点

| 领域 | 做法（源码位置） | 我们的状态 |
|---|---|---|
| 动作决策栅栏 | `cooperation/controller.ts` 的 `verifyDecision()` 一次校验 + 内部 CDP 步进零 RPC；push-interruption fence | 已做：daemon `verifyDecision` 单点（远程文件传输 + 暂停闸门），路由只解析一次；短窗缓存未做 |
| 观察语义树 | `packages/vom/src/render.ts`：select 选项内联、label 绑定、行折叠、颜色空间解析的提示注入剥离 | 已吸收 select 选项、grid 行折叠、基础隐藏子树剥离；已补 oklch/lab/color-mix 对比度解析（VOM `contrast/lowContrast`） |
| 观察增量 | `content` 侧文本 mutation 分类 + `observation_patch.lines` + baseline 严格匹配 | 已吸收（主文档，行级补丁） |
| 意图 WAL | `effect_state` 贯穿派发前后，pre-dispatch 失败结算为 none | 已吸收（错误码 + effectState/dispatched 语义） |
| 输入路径 | fill 3–4 步、废除 fill_value_mismatch、返回 actual_value/formatted | 已吸收 3 步路径 |
| 协议单一来源 | `crates/bsk-protocol` 统一方法元数据、JSON Schema、TS 编解码、1.2–1.9 兼容矩阵 | 部分：方法分类/变异判定已收敛；全部扩展方法有显式 schema；MCP 50 个工具全部声明协议方法并通过门禁（`mcpMethodsNotInProtocol=[]`），核心 7 个 schema 由规范生成；其余 MCP schema 与 CLI 帮助仍手写 |
| 调试器生命周期 | 75s 空闲软分离、保留 refs/游标/dialog/下载租约 | 已做：feature 引用计数；活动标签页即时 detach，非活动标签页 75s 空闲软分离（alarms sweeper），长生命周期 feature 持有不分离；refs/游标/dialog/下载租约均保留 |
| 会话作用域 | ImplicitScopeRegistry：`--session` > `--scope` > 进程 > host 子代理 > "default" | 已做：`--session` > `--session-scope`（controller name/project/sessionId）> `BB_SESSION` > 单会话；MCP 支持 `BB_SESSION`/`BB_SESSION_SCOPE`；DSH 插件支持 `sessionScope` 配置注入；子代理身份自动推导未做 |
| recipe | 独占锁、未完成运行保留 receipt、hold | 部分（approve/TTL，缺锁与 hold） |
| 录制清理 | 停止协调清理、重试保留步骤 | 已吸收 |
| 导航等待 | 1s grace、后继文档才满足 | 已吸收（300ms，可配） |
| 配对 | 双向证明、轮换、撤销、设备注册串行 | 已吸收大部分 |

## B. 成熟工具的强项（对照维度）

| 维度 | Playwright / Puppeteer | Selenium | Browser Use / Stagehand / Skyvern | 我们的现状 |
|---|---|---|---|---|
| 可观测 | ARIA snapshot、role 选择器、trace viewer、codegen | WebDriver 元素查询 | DOM+截图混合、视觉定位 | VOM/AX 树 + 截图 + Trace Viewer + WCAG 对比度（oklch/color-mix）+ 网络时间线 |
| 确定性 | auto-wait（actionability）、重试策略、strict mode | 显式等待 | LLM 决策 + 校验 | actionability + stable 两帧 + 默认 5s 等待 + `--force` + selector 目标消失/替换重试 + `click --wait-navigation`；脚本式动作不阻塞导航，无独立“导航打断重试” |
| 回放/记录 | `record`/trace、codegen 生成脚本 | Selenium IDE | 录制 + 重放 | recipe/操作录制 + 离线 trace viewer（时间戳/网络/导出时截图）；缺按步骤截图与 codegen |
| 并发 | 多 browser context 隔离 | grid | 云端会话隔离 | 每会话窗口；缺 context 级隔离 |
| 安全 | 无凭据托管/注入防护 | — | 部分有 secrets 管理 | 敏感字段遮蔽 + 提示注入剥离（基础） |
| 性能 | CDP 批量、连接复用 | — | — | trusted fill ~14ms（无浮层）；actionability 等待另计 ~2 帧 |
| 协议/版本 | 稳定 API + 版本策略 | W3C 标准 | — | 1.8 手写协议，方法分类/扩展 schema/MCP 方法映射已单一来源；页面/控制/debug/rule/network/video schema 与 CLI 参数帮助由 schema 生成；CLI 命令语法与组合工具（window/dialog/settings）保留手写 |
| 生态 | 语言绑定、测试框架集成 | 多语言 | LLM 框架集成 | CLI/MCP/DSH + Node SDK + Python SDK；其他语言可基于 `bridge schema` 生成，本版本不内置 |

## C. 我们最该补的差距（按收益排序）

1. **统一动作决策栅栏**：把 ledger/control/session/authorization 检查合并成一次决策并短窗缓存，所有变异动作共享。已完成单点 `verifyDecision`；短窗缓存属性能优化，未做，不影响能力。
2. **协议单一来源**：从 `lib/schemas.mjs` 生成 CLI 帮助、扩展校验与 MCP 工具 schema。方法分类/扩展 schema/MCP 方法映射已收敛；页面/控制/debug/rule/network/video schema 与 `bridge schema`/`bridge help <method>` 均由规范生成；window/dialog/settings 是 action 组合工具、CLI 总览是命令语法，保留手写（无单一协议方法可生成）。
3. **调试器软分离**：空闲 75s 自动 detach，保留 ref/游标/对话框/下载租约，减少常驻开销与页面"被调试"提示。已落地：活动标签页即时 detach，非活动标签页 75s 软分离，长生命周期 feature 持有不分离。
4. **actionability 检查**：统一 visible/enabled/stable/receives-events 判定 + 自动重试。已落地 stable 两帧采样 + 默认 5s 等待 + `--wait-timeout` + selector 目标消失/替换重试 + `click --wait-navigation`；脚本式动作点击后立即返回，不存在 Playwright 式“动作中途导航重试”。
5. **trace 可视化**：把已有 trace v3 + 截图 + 网络证据做成可回放页面。已完成：离线 HTML（步骤/目标/值/状态/搜索/时间戳）+ `--debug` 网络时间线/步骤时间窗对齐 + `record start --screenshots` 按步骤缩略图 + `record export --screenshot` 导出时截图。
6. **颜色空间解析**：oklch/lab/color-mix 对比度与 alpha 计算。已完成：VOM 节点 `contrast/lowContrast`，浏览器 canvas 归一化任意 CSS 颜色 + alpha 合成。
7. **作用域继承**：`--session` 缺省时的确定性解析（scope 环境变量、MCP 连接作用域、子代理）。已完成 `--session-scope` / `BB_SESSION` / `BB_SESSION_SCOPE`；DSH 插件支持 `sessionScope` 配置与 `exec.sessionId/agentId` 自动映射（取决于运行时是否提供）。
8. **SDK**：Node SDK（`sdk/index.mjs` + `sdk/index.d.ts`）与 Python SDK（`sdk/python/browser_bridge.py`）均已落地，零依赖直连 daemon `/rpc`；其他语言可基于 `bridge schema` 生成，本版本不内置。

## D. 已落地（2026-11-13，第 1–28 轮）

- **单点动作决策**：daemon `prepareRoute → verifyDecision → ledgerTargetFromRoute → sendCommand`，账本目标直接来自 route，不再二次 `resolveSession`。
- **统一 actionability**：`click / hover / fill / press / select / drag` 在页面内先做 `visible / enabled / readonly / receives-events` 检查，不满足返回 `E_NOT_ACTIONABLE` 并带原因（不可见/禁用/只读/遮挡/pointer-events/视口外）；`--force` 只跳过遮挡类检查。
- **动作等待与稳定采样**：默认最多等 5000ms，每两帧重采样；连续两次 rect 一致才动作；`--wait-timeout 0` 关闭，`--force` 立即动作；目标不存在仍立即 `E_NOT_FOUND`；超时信息带 `已等待 Nms`。
- **Agent 可信输入不再误自动暂停**：CDP 派发的 `isTrusted` 输入会命中页面 human watcher；命令执行窗口内产生的 `human.input` 由后台忽略，页面 watcher 也识别 `data-bb-agent-input` 抑制标记。
- **方法分类单一来源**：新增 `lib/methods.mjs`，LOCAL/SESSION/INSTANCE/EXT、队列旁路、变异判定集中一处；daemon 与意图账本不再各存清单，`session.resume` 补齐路由。
- **协议门禁修复**：`tools/protocol-check.mjs` 原先的正则漏掉下划线、大写与部分简写 handler（`debug.rule_*`、`window.*Agent`、`reload` 等），修正后补齐 11 个缺失方法，`handlersNotInProtocol=[]`、`registryErrors=[]`。
- **Node SDK**：`sdk/index.mjs` 零依赖直连 daemon `/rpc`，提供 `connect()` / `newPage()` / `Page.goto/click/fill/observe/screenshot/close` 与 `BridgeRpcError`；`sdk/index.d.ts` 类型声明，`package.json` 暴露 `browser-bridge/sdk`。
- **MCP schema 单一来源**：新增 `lib/mcp-schemas.mjs`，从 `lib/schemas.mjs` 的规范参数生成 MCP inputSchema（camelCase→snake_case）；`browser_click/fill/navigate/observe/read/extract/evaluate` 已改用它，并补齐 `trusted/force/wait_timeout/max_depth/ax/cursor` 等此前 MCP 缺失的选项。
- **扩展方法 schema 全覆盖**：补齐 79 个方法（tab/window/dialog/network/debug/video/emulate/step 等），`protocol-check` 新增 `schemaMissing` 门禁并保持为空；daemon 在派发前统一校验，CLI/MCP 共享同一份 `lib/schemas.mjs`。
- **Trace Viewer**：新增 `lib/trace-viewer.mjs` 与 `bridge trace view <trace.json> [--out viewer.html]`，把 Trace v3 渲染成离线单文件 HTML（步骤/目标/值/redacted/前后状态/搜索），所有文本转义、敏感值不进入 HTML；真实 Edge 打开渲染通过。
- **目标短暂消失重试**：`click/fill/press/select/hover` 在显式 `--wait-timeout` + selector 时，对 `E_NOT_FOUND` / `E_STALE_REF` 在超时内重试；默认仍快速失败，ref 目标不重试。真实 Edge 上 800ms 后出现的按钮/输入框均成功等到并操作。
- **会话作用域**：新增 `lib/session-scope.mjs` 与 `--session-scope <名字>`，按 `sessionId` / `controller.name` / `controller.project` 解析唯一会话；解析顺序 `--session` > `--session-scope` > `BB_SESSION` > 单会话默认。MCP 支持 `BB_SESSION` / `BB_SESSION_SCOPE` 与 `session_scope` 参数；真实 Edge 双会话验证通过。
- **调试器空闲软分离**：新增 `extension/src/debugger-idle.js` 与 `chrome.alarms` sweeper；活动标签页仍即时 detach，非活动标签页 75s 空闲后分离，`dialog/network/record/rules-fetch/emulate/fetch-probe` 持有调试器时永不分离。可信输入、网络、截图、对话框、debug 录制均在真实 Edge 上回归通过。
- **E2E 测试债修复**：E2E 不再调用 CLI 已禁止的 `--borrow-confirm`（改为断言 `E_FORBIDDEN`）；rebind/借用两项按安全策略显式 SKIP；`window ensure` 不再误关会话 tab。真实 Edge 从 67/131 恢复到 **129/131 通过 + 2 跳过**。
- **Python SDK**：新增 `sdk/python/browser_bridge.py`（零第三方依赖，Python 3.9+）与 `pyproject.toml`，API 与 Node 版对齐；7 项 unittest + 真实 Edge 的 new_page/evaluate/fill/observe/screenshot/close 冒烟通过。
- **VOM 颜色对比度**：新增 `lib/color-contrast.mjs` 与 page-lib 的颜色归一化（canvas 解析任意 CSS 颜色，含 oklch/lab/color-mix）；VOM 节点输出 `contrast/lowContrast`，真实 Edge 验证 21 / 2.85 / 8.6 三组颜色。
- **MCP 工具协议映射门禁**：50 个 MCP 工具全部声明 `methods`（本地工具显式空映射），`protocol-check` 新增 `mcpMethodsNotInProtocol` / `mcpToolsMissingMapping` 门禁；`mcp/server.mjs` 加主入口保护，单测可直接 import `TOOLS` 校验 schema 与命名。
- **Trace 网络时间线**：Trace v3 步骤/状态带 `at` 时间戳；`bridge trace view --debug <archive.json>` 把 debug requests 并入查看器（时间/方法/状态/URL/类型），全部转义。
- **DSH sessionScope 配置**：插件新增 `sessionScope`，注入 `BB_SESSION_SCOPE`；工具未传 `sessionId` 时按 controller 选会话。运行器环境注入有单测（插件自测 22/22）。
- **动作中被替换重试**：selector 目标在等待/聚焦时 detach 且 selector 已能解析到新节点时，自动重跑一次动作；selector 不存在则直接失败，避免双倍超时。真实 Edge E2E 新增 `35d` 验证（focus 时替换按钮，重试后只点击新节点一次）。
- **Trace 导出截图**：`record export --screenshot` 在导出时抓当前页面写入 `trace.screenshots`；查看器只接受 `data:image/*;base64,` 并渲染。真实 Edge E2E 的 `20d2` 验证 steps/states/shots=1。
- **MCP 控制类 schema**：`browser_tabs/tab_close/tab_select/tab_move/wait_for/record_start/record_stop/record_list/video_status/video_list` 改用 `mcpInputSchema` 从规范生成，新增 `scope/state/operation_id/purpose/max_page_tokens/recording` 等参数并透传。
- **MCP debug/rule schema**：`browser_debug_start/stop`、`browser_rule_list/add/clear` 改用规范 schema；补齐 `debug.rule_enable/disable/remove` 的 `id` 字段。
- **MCP video/network schema**：`browser_video_start/stop`、`browser_network_list` 改用规范 schema；`video.stop` 修正为传 `recording`（此前误传 `recordingId`，扩展收不到 id），并支持 `duration_ms`/`duration`、`filter`/`filter_text`。
- **MCP window/dialog 能力**：`browser_window` 支持 `resize`（width/height）；`browser_dialog` 支持 `arm`（alert/confirm/prompt/prompt_text/queue）与 `list`，与 CLI 能力对齐。
- **协议 schema 自查命令**：新增 `bridge schema [method] [--json]`，从 `METHOD_EFFECT`/`methodScope`/`isMutating`/`METHOD_SCHEMAS` 输出方法、scope、effect、是否变异与参数 schema；3 项单测覆盖。
- **Trace 步骤网络对齐**：查看器按 `[step.at, next.at)` 时间窗把 `--debug` 请求挂到对应步骤（`N 个请求 · GET 200 …`），并有单测覆盖。
- **schema flag 生成**：`bridge schema <method>` 的 `flags` 由 schema 属性自动生成（camelCase→kebab，`waitTimeoutMs → --wait-timeout`），并有单测。
- **CLI 单方法帮助生成**：`bridge help <method>` 由 schema 生成参数帮助（必填/可选、类型、flag 别名），`bridge help` 仍为总览。
- **动作帮助 flag 生成**：总览帮助中的 `click`/`fill` 参数片段由 `renderFlagUsage` 从 schema 生成（`[--trusted] [--force] [--wait-timeout <n>]` 等），减少手写漂移。
- **CLI schema/help 自测**：selftest 新增 3 项（`schema click` 的 flags/schema、`help click` 生成内容、未知方法退出 2），CLI 自测从 140 → 143。
- **click --wait-navigation**：点击后轮询 URL + `readyState`，最多 8s，返回 `navigation.navigated/url/waitedMs`；真实 Edge 从 `?nav=0` 点击链接后 334ms 返回 `?nav=1`。
- **DSH 自动 scope**：插件运行器在 DSH `exec` 提供 `sessionScope/sessionId/agentId` 时自动注入 `BB_SESSION_SCOPE`；显式 `sessionScope` 配置优先；新增 2 项运行器测试（插件 24/24）。
- **按步骤截图**：`record start --screenshots` 在录制时抓缩略图（≤30 张、320px JPEG），写入事件 `screenshot`；Trace v3 步骤带 `screenshot`，查看器内嵌 `<img class="step-shot">`。真实 Edge 两步点击均带 dataUrl，导出 `stepScreenshots=2`。
- 回归：CLI selftest 143/143、单测 896/896、MCP 10/10、protocol-check 全绿、Python SDK 7/7、插件 24/24；真实 Edge E2E **131/133 通过、2 项按借用确认安全策略跳过**。

## E. 设计边界（非能力差距）

| 项 | 说明 |
| --- | --- |
| CLI 命令语法 | 总览帮助保留手写命令语法；参数 flag、单方法帮助、MCP schema 已由规范生成。CLI 的位置参数/组合命令不是协议方法，无法从 RPC schema 推导 |
| 组合工具 | `browser_window/dialog/settings` 是 action 路由，一个工具覆盖多个协议方法，参数 schema 手写；每个被路由的方法本身都有规范 schema |
| 导航打断 | 脚本式动作在 `click()` 后立即返回，不会像 Playwright 的 CDP 鼠标那样被导航打断；后续等待用 `--wait-navigation`，因此没有独立的“动作中途导航重试” |
| 其他语言 SDK | `bridge schema` 提供机器可读契约；本版本内置 Node/Python，Go/Java 等按 schema 生成即可，不阻塞能力对标 |

## F. 后续可选增强

1. C1 决策短窗缓存（性能优化，非能力）。
2. 更多语言 SDK/测试框架适配（基于 `bridge schema`）。
3. 按步骤截图的更高清/可配置采样（当前 320px、≤30 张以控制存储）。

## G. 验证记录（2026-11-13）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node --test tests/unit/*.test.mjs` | 896/896 |
| CLI 自测 | `node tests/cli/selftest.mjs` | 143/143 |
| MCP 自测 | `node tests/mcp/selftest.mjs` | 10/10 |
| 协议门禁 | `node tools/protocol-check.mjs` | exit 0；`handlersNotInProtocol=[]`、`schemaMissing=[]`、`mcpMethodsNotInProtocol=[]`、`registryErrors=[]` |
| Python SDK | `python -m unittest discover -s tests/python` | 7/7 |
| DSH 插件 | `node tests/plugin/selftest.mjs` | 24/24 |
| 真实 Edge E2E | `node tools/e2e.mjs` | 131/133 通过，2 跳过（借用确认策略），exit 0 |

E2E 的 2 项跳过均因“借用确认只能由扩展设置页关闭”的产品策略，不是功能失败；其余 131 项全部通过。
