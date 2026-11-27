# HANDOFF — BridgeDeck 0.3.0 质量批次

日期：2026-11-18
当前工作目录：`D:\浏览器桥`
版本：**0.3.0**（未升号）
约束：不修改 `D:\CTRM自动录入`；发布包不得包含参考实现/研究材料标识。

## 1. 当前状态

- 版本仍为 **0.3.0**。
- 已发布资产是较早的 0.3.0：
  - 扩展 443,292 B
  - sha256 `97a600ddd689502d6e975a6933e508068b48680c07a3a6f3660437701e9f47dd`
- **当前源码比已发布包更新**；本轮质量批次已完成四项优先（tabs borrow/help、RTL、cooperation stale、eval 50），但未重新打包/发版。
- Edge 0.3.0 正在审阅；GitHub 0.3.0 已签名公开。
- 没有升 0.3.1/0.4.0。

## 2. 测试基线（2026-11-18 质量批次，全部实跑）

```text
单测 596/596
reference 507/507
真实 Edge E2E 190/190，0 跳过
eval corpus 103/103 passed
source guard clean (166 files)
vendor leak clean
release preflight PASS
```

关键命令：

```powershell
node tools/source-guard.mjs
node --test "tests/unit/*.test.mjs"
node --test "tests/reference/*.test.mjs"
$env:BB_E2E_SYNC_DOCS='0'; node tools/e2e.mjs
node tools/eval-from-e2e.mjs
node tools/check-vendor-leak.mjs
node tools/release-preflight.mjs
```

## 3. 当前架构

```text
extension/src/
  bridge.js            消息路由（已拆 record-ports/record-events）
  dispatch.js          分发 + receipt + ref 路由
  tools/
    observation.js     observe / layers / visual（804 → 563）
    observation-ax.js  AX 采集/租约/VOM backend 合并 + AX 兜底（254）
    observation-visual.js 分层 L2 + 视觉候选/VOM 融合（57）
    observe-frames.js  all-frame 观察
    interaction.js     点击/输入/投影
    ops.js             record/network/video/debug
  tabs.js              tab/window 主体（851 → 593 行）
  tabs-borrow.js       tab.borrow / tab.return 业务主体（本轮拆出）
  tabs-help.js         request-help / control-hint
  refs/
    ref-registry.js    RefKey/stableRef
    resolve-backend.js selector -> backendNodeId
  cross-frame-geometry.js OOPIF owner 链
  borrow-ui.js         borrow Toast/确认条/rehome（唯一定义）
  controlled-tabs.js   受控标签页
  human-decisions.js   borrow/help 人为决定
  tab-attribution.js   self-created tab/window
  control-generation.js authority generation（含 raise 对齐）
  cooperation.js       block/passthrough + authority stale 对齐
  record-ports.js      per-document Port
  record-events.js     record 事件 boundary
  capture-persist.js   长截图分片 + manifest 落盘
  browser-driver/
    chromium-cdp.js        CDP 核心（1743 → 768，attachment/发送/事件/清理）
    cdp-frames.js          扁平 frame 发现 + FrameGraph（mixin）
    cdp-dialogs.js         原生对话框生命周期（mixin）
    cdp-console.js         console/异常缓冲（mixin）
    cdp-network.js         network 缓冲/元数据（mixin）
    cdp-emulation.js       Emulation 覆盖（mixin）
    cdp-sessions.js        会话占用/后台执行（mixin）
    cdp-buffer-utils.js    console/network 缓冲与截断（纯函数）
    cdp-timing.js          attach/detach 等待预算（纯函数）
  lib/
    frame-matrix.js        owner 仿射投影（rotate/skew/scale）
    action-receipt.js
    observation-cursor.js
    visual-objects.js
    vom-payload.js
    ref-details.js
    receipt-methods.js
    longshot-store.js     IndexedDB 分片（含 drawY/prune）
    capture-manifest.js   manifest 索引 + upsert

extension/ui/
  direction.js         首帧方向（RTL 自动 / ?dir= 覆盖）
  locales.js           12 语言（含 ar/he 全量包）
  popup.css/ui.css     逻辑属性 + [dir="rtl"] 覆盖
```

## 4. 质量门禁

- 循环依赖 0；
- `lib/*` 不得反向依赖 `tools/bridge/dispatch`；
- 非生成文件 ≤1100 行；
- method catalog/receipt 0 mismatch；
- 性能预算；
- 故障注入；
- `source-guard` 全量语法/占位符；
- `release-preflight` 已硬跑质量门禁 + vendor leak。

## 5. 本轮已完成（2026-11-18 质量批次）

- **tabs borrow/help 主体**：新增 `tabs-borrow.js`，`tab.borrow`/`tab.return` 整体迁出；
  `tabs.js` 851 → 593 行，删除与 `borrow-ui.js` 重复的 rehome/注入实现；
  `borrow-ui.js` 成为借用 UI 唯一真源；`dispatch.js` 改从 `tabs-borrow.js` 取方法。
- **RTL 完整布局**：`ui/direction.js` 首帧设置方向（RTL 语言自动、`?dir=rtl|ltr` 覆盖）；
  `popup.css`/`ui.css` 改逻辑属性（`inset-inline-*`、`text-align:start`、`margin-inline-end`）
  并补 `[dir="rtl"]` 图标镜像/开关位移；浮层（借用/Toast/Help/Takeover/录制/手动长截图）
  按 RTL 语言或页面 `dir` 锚定到内联侧，Help 卡片位置镜像、录制胶囊可拖动。
- **cooperation stale 全链路**：内容脚本 generation 拒绝有了真实浏览器断言
  （`COOP_DOM_OK:8`）；后台 generation 落后时自动抬到内容权威代 +1 重试，
  无法对齐时抛 `E_COOPERATION_STALE`（新增错误码，docs/SDK 已同步），动作 fail-closed；
  E2E `23j2` 断言 generation 单调、旧 context/observation 拒绝。
- **eval corpus 30 → 71**：20 个 adversarial（安全策略、recipe 篡改、取消、截断、
  closed shadow、daemon 重启恢复、stale authority 等）+ 深度 case。
- **长截图恢复全链路**：`capture-persist.js` 把整页截图分片写入 IndexedDB、manifest
  写入 `bb.capture.manifests`（24h / 8 条，自动 prune 旧分片）；`ui/longshot.js`
  按 drawY 重拼（`planStitch`），E2E `31b` 真实恢复。
- **VOM stableRef 全动作**：`--stable-ref` 从 click 扩到 fill/select/read/hover/
  actionable/wait-for-element（`lib/schemas.mjs` + CLI `resolveTarget` 统一解析），
  E2E `8b` 验证 fill/select/read/actionable 都走跨观察身份。
- **OOPIF 变换矩阵**：owner 投影改为仿射矩阵（`lib/frame-matrix.js`），
  `cross-frame-geometry` 的 CDP 路径支持 rotate/skew/scale/translate；
  `page-lib` 检测到 transform 时交给 CDP 路径。E2E `23p6`（同源 rotate+skew）与
  `23p7`（跨源嵌套 rotate+scale）真实验证点击落点。
- **视频完帧恢复**：E2E `35r` 用真实 MediaRecorder 生成两段分片写入 IndexedDB，
  `video recover` 扫描 → 按序拼回 → `video save` 落盘，校验 MP4/WebM magic。
- **ar/he 全量 RTL 翻译包**：`translation/ar|he.json`、`missing-*.json`、`overlay-*.json`
  全量生成；`SUPPORTED_LANGS` 10 → 12；`i18n.js` 识别 ar/he 并设置 RTL；
  options 语言选择器新增 العربية / עברית；E2E `29d` 真实渲染 ar/he 标题。
- **chromium-cdp 拆分**：1743 → 768 行，拆出 `cdp-frames` / `cdp-dialogs` /
  `cdp-console` / `cdp-network` / `cdp-emulation` / `cdp-sessions`（class mixin），
  attachment/发送/事件/清理留在核心；新增 mixin 描述符复制（类方法不可枚举）。
- **3D / matrix3d 投影**：`23p8` 用 `rotateY(18deg) rotateX(12deg) scale(0.9)` 真实点击验证；
  DOMMatrixReadOnly 的 2D 分量足以覆盖无 perspective 的 3D 旋转。
- **超长/超宽页面 capture**：`screenshot --full-page` 宽度或高度 > 12000 时按 8000px
  2D 网格分块 CDP 截图并拼接（`tiled` 返回块数）；E2E `31c`（1241x20000, tiles=3）与
  `31d`（16000x1000, tiles=2）。
- **AX / visual 拆分**：`observeAxFallback` 移入 `observation-ax.js`；分层 L2 与视觉候选/VOM 融合移入 `observation-visual.js`，observation 654 → 563。
- **capture suppression ack**：浮层隐藏改为页面内真实 **2 rAF** 确认后再截图，
  去掉固定 80ms sleep；仍保持 ref-counted。
- **cooperation frameState 计数器**：E2E `23h2` 真实推进 `mutations/scroll/revision`
  （revision 12→18），验证协作状态不只是快照。
- **VOM visualObjects 稳定身份**：视觉 ref 融合 `stableRef/backendNodeId`，E2E `35f`
  用 visualObject 的 stableRef 完成真实点击（objects=3, via=cdp-backend）。
- **perspective 3D 投影**：homography（`frame-matrix.js`）+ 祖先 perspective 透视除法；
  E2E `23p9` 真实点击命中。
- **超大高度 capture**：上限 40000px；E2E `31e` 真实截取 1241x35000（tiles=5）。
- eval corpus 50 → **80**：含 20 adversarial + 深度 case（3D/长宽截图/恢复/RTL/视觉/协作计数）。
- **VOM paint-order 分层 + issue 模型**：`computeLayerBands` 用 DOMSnapshot 的
  position/pointer-events/paintOrder + AX 角色产出 L2 带（modal/mask、coverage、members）；
  observe 返回 `issues[]` 并进 `vom.issues`；E2E `35g`。
- **协作归因时钟（粗粒度）**：passthrough 时按动作类型下发 expectation kinds；
  内容脚本在 5s 窗口内匹配即计入 `agentAttributed`，不匹配的 trusted 输入按人工处理；
  E2E `23h3`（agent=2 human=0）。
- **长截图 final exposure**：`lib/longshot-final.js` 判定底部未覆盖时补拍最后一帧并贴底绘制；
  单元测试覆盖「已覆盖/未覆盖/缺失输入」。
- **视频分片日记语义**：录制记录新增 `completeness`（complete/partial）、
  `stop_reason`（user/duration/recovered）、`chunk_count`；E2E `35/35r` 断言。
- eval corpus 80 → **81**：新增 paint-order/issue case。
- **固定页脚重绘**：`page-metrics` 识别 `fixedBottomHeight`；分块截图滚到底抓页脚带，
  贴回最终画布底部；E2E `31f`（1241x15000, footer=80）。
- **按键归因**：press 前下发 key 期待，内容脚本按 key 精确匹配；E2E `23h4`（agent=2 human=0）。
- **分片日记**：每次 MediaRecorder chunk 记录 `{index,at,bytes}`，录制/恢复都返回
  `fragments` + `fragment_count`；E2E `35/35r` 校验字节一致。
- eval corpus 82 → **84**：新增固定页脚、按键归因 case。
- **浏览器矩阵探测（Phase C）**：`lib/browser-detect.js` 识别 edge/chrome/brave/opera/
  vivaldi/arc/helium/chromium；`docs/BROWSER-MATRIX.md` 明确“已测/仅识别”边界。
- **VOM 阶段证据（吸收 BSK 6-stage）**：`vom.stages` 输出 facts/identity/relations/
  layout/paint/interact 的 ok/count；aria-controls/labelledby/describedby、
  label/for、form 作为关系；节点带 rect/inViewport/pointerEvents/cursor/occludedBy
  作为 layout/interact 证据，并带 ancestors 祖先链与 `vom.edges` 关系边；stableRef 注入 VOM 节点；E2E `20s6`。**不是** BSK 的完整 6 阶段引擎。
- **共享控制对账（吸收 BSK）**：`cooperate wait` 检测到人工操作后记录 pendingHumanAt；
  下一次 `cooperate sync` 返回 `human_edits_since_sync` 与
  `reconciliation {humanEdits,totalHumanAttributed,lastHumanAt,inputClock,revision}`；E2E `23u`。
- **动态读取校验（吸收 BSK）**：`cooperate sync` 记录 DOM revision；
  带 `--observation` 或 strict `--context` 的动作会核对当前 revision，
  变化则 `E_OBSERVATION_STALE` 并返回 `observed_changes`；E2E `23j3`。
- **协作 hold 强制（吸收 BSK）**：`cooperate hold` 显式人工接管，held 时
  `E_SESSION_PAUSED` 拒绝 Agent 动作；`--release` 恢复；E2E `23h6`。
- **协作 control authority（吸收 BSK）**：`cooperate sync` 新增
  `control {inputLocked, agentActive, shared, humanActive, agentGraceMs}` 与顶层
  `held`（人工接管暂停）；E2E `23h3`。
- **协作输入时钟（吸收 BSK）**：`frameState.inputClock` 在人工/Agent 输入时单调递增，
  与 authority/generation/attribution 一起返回；E2E `23h3/23h4` 断言推进。
- **WebMCP（Phase C 追平 Browse）**：`webmcp list` / `webmcp call <tool> --input`；
  读取 `document.modelContext || navigator.modelContext` 的 `getTools/executeTool`；
  工具名/描述/结果标记为不可信页面内容；E2E `20s5`。
- **bridge exec（Phase C 追平 Browse execute）**：`cli/exec.mjs` Node vm 受限脚本，
  `page` 暴露 goto/observe/click/fill/press/read/evaluate/wait/screenshot；E2E `20t`；
  明确“vm 不是安全边界”，见 [EXEC.md](docs/EXEC.md)。
- **多 Agent 共享同一 tab（Phase D）**：`session start --tab <id> --share` 绑定已有会话的 tab；
  共享会话独立 context/observation，命令按 tab 队列串行；停止共享会话不关闭 tab；
  见 [SHARED-TAB.md](docs/SHARED-TAB.md)，E2E `20q10`。
- **fMP4（Phase D 验证）**：MediaRecorder MP4 实测带 `moof`，`video verify` 返回
  `container.fragmented=true`；不做二次 remux/worker，E2E `35`。
- **QuickJS 沙箱（Phase D）**：vendored `quickjs-emscripten-core` 0.32.0 + asyncify；
  `bridge exec --sandbox quickjs` 通过 asyncify host 调用 page API；E2E `20s7`；
  默认仍 Node vm（兼容 locator），QuickJS 下 locator 暂不支持；见 [DEPENDENCIES.md](docs/DEPENDENCIES.md)。
  > 2026-11-19 更新：QuickJS 已支持全量 `page.locator`（同步契约，脚本不写 `await`），
  > 见 [EXEC.md](docs/EXEC.md) 与 [DEPENDENCIES.md](docs/DEPENDENCIES.md)；E2E `20s8`。
- **Phase D 阻塞项**：多浏览器矩阵、多控制者共享控制的证据与解锁条件见
  [PHASE-D-BLOCKERS.md](docs/PHASE-D-BLOCKERS.md)；不把边界写成已对齐。
- **自动更新/分发（Phase D 已存在并验证）**：`update check/stage/apply/rollback/fetch/auto`
  校验 SHA256/签名、staging、失败回滚；`tests/cli/selftest.mjs` 155 项通过
  （含 update check/stage/fetch/apply/rollback/auto）。发布资产仍保持 0.3.0 未重打包。
- **四类权威快照（吸收 BSK）**：`cooperate sync` 的 `authority.four` 输出
  tab/control/observation/action 四类；action.allowed 由 held/readOnly 推导，
  readOnly 直接读取当前 tab policy；真实拦截仍由既有 checkControl/tab policy/会话归属执行；E2E `23h/20q6`。
- **沙箱宿主 daemon（Phase D）**：`daemon start --foreground` 前台运行、继承 stdio；
  `BB_AUTO_START=0` 禁止隐式拉起；Windows Job breakaway 无 Node API，明确不声称支持；
  见 [SANDBOX-HOST.md](docs/SANDBOX-HOST.md)。
- **结构化提取跨 frame（吸收 BSK）**：`extract discover` 扫描所有可注入 frame，
  target 带 `frameId`；`extract table/list --frame <id> --target <id>` 导出；
  `extract target` 句柄 5 分钟过期；E2E `15b`。
- **MCP 30 客户端（Phase C）**：补 trae/vscode-insiders/cline/roo-cline/augment；
  JSONC/TOML/YAML/DSH 全覆盖；YAML 已有顶层 key 时插入 browser-bridge 子项，
  DSH 已有行时更新 command/args（不再只 conflict/追加）。
- **a11y/store 边界（Phase C）**：popup `?selftest=a11y` 检查 lang/按钮名/switch/alt；
  E2E `29e`；新增 `docs/STORE-BOUNDARY.md`（权限/数据/a11y/上架检查）。
- **seeded/stress eval（Phase C）**：`seeded.html` 同 seed 可复现、异 seed 不同；
  `20s3` 连续 5 轮 observe/read stress smoke；E2E `20s1/20s3`。
- **tab keepOpen/idle 清理（吸收 Browse）**：`tab new --keep-open`、`tab policy --keep-open`；
  keepOpen/readOnly 策略存 `storage.local`，浏览器重启后按 URL 唯一对账；
  `tab cleanup --idle-ms` 默认 dry-run，只有 `--yes` 才真关闭；E2E `20q9`。
- **MCP 25 客户端（Phase C）**：补 DSH `cordis.patch.yml` patch 行；已有 browser-bridge
  行不同命令时 conflict，不覆盖。
- **MCP 24 客户端（Phase C）**：在 22 个基础上补 Goose/Hermes YAML；已有顶层 key
  时不猜结构，返回 conflict；JSONC/TOML/YAML 均有 dry-run 与测试。
- **MCP 22 客户端（Phase C）**：在 11 个 JSON 客户端上新增 codebuddy/cortex/pi/qoder/
  warp/junie/kimi/lm-studio/trae-cn，并补 Codex/Grok TOML；冲突不覆盖、dry-run。
- **命名 tab alias（吸收 Browse）**：`tab alias <id> <name>`、`tab new --alias`、
  `tab aliases`；`--tab-id <alias>` 先解析再动作；alias 存 `storage.local`，
  浏览器重启后按 id→URL 唯一对账恢复，不唯一不猜；E2E `20q8`。
- **命名标签组（吸收 Browse）**：`tab new --group <name>` 创建/复用标签组，
  `tab.list` 返回 groupId/group；E2E `20q7`。
- **视频分片完整性（Phase B 边界）**：每个 MediaRecorder chunk 记录 `sha256`；
  `video verify` 逐片核对；恢复分片也带 SHA；明确不做 fMP4 重封装/worker，见 [VIDEO.md](docs/VIDEO.md)。
- **soft-detach signature（吸收 BSK/Browse）**：分离时记录 URL/title/status 签名，
  重挂时页面已变则丢弃旧持有者/焦点仿真，不再盲目恢复；`lib/soft-detach-signature.js` + 单测。
- **输入事务（吸收 BSK/Browse）**：`InputTransactions` 每 tab 单事务 + 15s 过期回收；
  click/drag 走 pointer，key 走 key，冲突返回 `E_INPUT_BUSY`；单测覆盖。
- **debug coverage（吸收 BSK/Browse）**：`debug.coverage` 返回请求/console 统计、
  pinned、bufferTruncated、`gaps[]`（network-buffer/url-truncated/response-body）与
  `complete`；E2E `20e2`；`debug.pin` 已有。
- **VOM token 预算/omitted（吸收 Browse/BSK）**：`takeTokenChunk` 返回 used/lines/
  omittedChars/omittedLines；observe 结果新增 `budget`，E2E `23l` 断言首块 omitted>0。
- **配对证明（吸收 Browse）**：`pair.create` 生成 serverNonce；`pair.redeem` 要求
  endpoint 匹配并用 `HMAC(token, endpoint|scope|clientNonce|serverNonce)` 返回 proof，
  CLI 校验后才输出 token；5 次失败清空 pending 码。`tests/pairing/selftest` 10/10。
- **Ref 身份契约（吸收 Browse）**：`stableRef` 改用 `documentId+frameId+tag+id+role+name`
  的 `identityKey`，同身份跨 backendNodeId 复用；单测覆盖 backend 变化仍稳定。
- **动作护栏表（吸收 Browse guardrails）**：`lib/action-policy.js` 统一 READ/MUTATING
  表，未知动作 fail-closed；`tab-policy` 只读/来源检查复用同一张表；单测
  `action-policy.test.mjs`。
- **每 tab 策略（吸收 Browse allowedOrigins/readOnly）**：`tab policy <id> --read-only
  --allow-origins ...` 与 `tab new --read-only/--allow-origins`；dispatch 在动作前统一
  拒绝（`E_READ_ONLY`/`E_FORBIDDEN`）；E2E `20q6`。
- **只读会话 scope（吸收 Browse readOnly）**：`session start --scope read` 在 daemon
  `enforceSessionPolicy` 拒绝所有变更方法（`E_READ_ONLY`）；E2E `20q5`。
  `--allow-domains/--deny-domains` 已有会话级域名策略。
- **MCP 一键写入（吸收 OpenCode Browse）**：`bridge mcp-install` 支持 11 个客户端
  （Claude/Claude Desktop/Cursor/OpenCode/VS Code/Windsurf/Kilo/Amp/Copilot/Kiro/Qwen），
  JSONC 注释保留、冲突不覆盖、`--dry-run`；单测 `mcp-config`/`mcp-install`。
- **拟人输入（吸收 OpenCode Browse）**：`lib/human-input.js`（Fitts/贝塞尔/minimum-jerk/
  抖动/过冲/按住 60–140ms）；`click --human --trusted` 接入；E2E `23h5`（moves=3）。
- **截图差分（吸收 OpenCode Browse）**：`lib/pixel-diff.js`（YIQ pixelmatch 同量纲）、
  `screenshot --diff`、changed/ratio/bbox；E2E `31g`（changed=923424）。
- 新增 `docs/COMPARISON-THREE-WAY.md`：BridgeDeck/BSK/OpenCode Browse 三方对照与吸收清单。
- 新增 `docs/FIRST-TIER-CRITERIA.md`：第一梯队验收清单（深度/门禁/运维/边界）。
- 新增测试：
  - `tests/unit/rtl-layout.test.mjs`（真实 Chromium `RTL_DOM_OK:6`）
  - `tests/unit/cooperation-authority.test.mjs`
  - `tests/browser/rtl-dom.*`
  - `tests/unit/cdp-buffer-utils.test.mjs`、`tests/unit/cdp-timing.test.mjs`
  - `tests/unit/capture-manifest.test.mjs`（upsert/镜像一致）、`planStitch` 单测
- 质量批次文档：`QUALITY-ROADMAP.md`、`ARCHITECTURE-EXTENSION.md`、`REFACTOR-PLAYBOOK.md`、
  `TEST-STATUS.md` 已同步。

## 6. 还没完成

- 协作归因已到类型 + ±2px 坐标 + key 匹配；时间戳级（±1.5ms）仍为边界；
- 长截图已补 final exposure 与固定页脚整块重绘；分数 DPR/多页脚仍可加深；
- 视频有 per-chunk 分片日记 + 完整性语义，但未做 fragmented MP4 重封装/worker 编码；
- 多层 3D 嵌套、>40000px 页面、复杂 VOM/cooperation 状态机仍可继续；
- 已发布 0.3.0 资产未替换，发布包与当前源码不同步（仍未升号/未发版）。

## 7. 新会话建议开场

```text
继续 BridgeDeck 0.3.0 深度批次（质量批次已收口）。
先读 docs/HANDOFF-0.3.0.md、docs/QUALITY-ROADMAP.md、docs/REFACTOR-PLAYBOOK.md、docs/SKILLS-ASSESSMENT.md、docs/COMPARISON-BSK-0.5.0.md、docs/COMPARISON-THREE-WAY.md。
保持 0.3.0 不升号、不发版；先跑测试基线，再按小步+source-guard 重构。
优先：多层 3D 嵌套、复杂 VOM/cooperation 深度、超大高度 capture。
不修改 D:\CTRM自动录入；发布包不得含参考实现标识。
```

当前基线（新会话先复跑确认）：

```powershell
node tools/source-guard.mjs
node --test "tests/unit/*.test.mjs"
node --test "tests/reference/*.test.mjs"
$env:BB_E2E_SYNC_DOCS='0'; node tools/e2e.mjs
node tools/eval-from-e2e.mjs
node tools/check-vendor-leak.mjs
node tools/release-preflight.mjs
```

## 8. 发布提醒

如果决定替换同一 0.3.0 资产：

1. `node tools/build-extension.mjs`
2. 重新构建 CLI/Setup/plugin
3. `node tools/release.mjs`
4. GitHub draft + Actions 签名（Secret `RELEASE_SIGNING_PRIVATE_KEY`）
5. Edge 取消旧 0.3.0 审核，重新提交新包
6. 重新下载 `release.json`，跑 preflight

不要用旧的 `dist/release.json`；签名 manifest 必须由 CI 生成。
