# 接手说明（新会话从这里开始）

> 本文件给"换一个会话继续做"用。读完这一页 + 跑一遍下面的验证命令，就能接手。
> 最后更新：2026-11-16。

## 1. 这是什么项目

BridgeDeck（浏览器桥）：本机 Chromium（Edge/Chrome）自动化。
- **扩展**（MV3，`extension/`，版本 0.1.6）+ **本机 daemon**（`daemon/`）+ **CLI**（`cli/bridge.mjs`）+ MCP 服务（`mcp/`）+ DSH 插件（`dsh-plugin/`）+ Node/Python SDK（`sdk/`）。
- 协议 1.9；**运行时零依赖**（只用 Node 内置模块）。
- 设计边界：桥负责"看得清、点得准、错得明白"；**不做识别、不内置任何站点的验证码解法**。

## 2. 一分钟验证当前状态

```powershell
Set-Location "D:\浏览器桥"
node --test "tests/unit/*.test.mjs"      # 期望 1027 pass / 0 fail
node tests/extension/module-load.mjs     # 期望 PASS
node tests/plugin/selftest.mjs           # 期望 26 通过
node tools/gen-protocol.mjs --check      # 期望 up to date
node cli/bridge.mjs status               # 需要 daemon 在跑；扩展在浏览器里已启用
```

## 3. 改扩展后必须做的事

`extension/` 下任何改动，**用户要在 `edge://extensions` 点一次「重新加载」**，否则跑的还是旧代码。这是本项目最常见的"改了没生效"来源。

改 `extension/injected/page-lib.js` 时**必须同步 bump 版本号**（当前 `LIB_VERSION = 53`，`extension/src/inject.js` 的 `PAGE_LIB_VERSION` 要一致），单测会检查两者相等。

改了扩展后重新打包：

```powershell
node tools/build-extension.mjs   # 产物 dist/BridgeDeck-extension-0.1.6.zip（版本号保持 0.1.6）
```

打包后同步 `dist/SHA256SUMS`、`dist/SHA256SUMS-0.1.6` 与 `docs/releases/0.1.6.md` 里的哈希。

## 4. 当前完成度（按层）

| 层 | 状态 |
| --- | --- |
| 协议 / 会话 / 观察 / 动作 / 提取 | 完成，单测覆盖 |
| 错误契约 | 98 个码，单一真源 `lib/error-codes.mjs`，含 `retry` 语义与"下一步"提示；文档与两个 SDK 由 `tools/gen-error-codes.mjs` 生成 |
| 观测代数（`revision` / `expectRevision`） | 完成：`observe`/`read`/`extract` 都带代数，动作可要求同一代，不符报 `E_OBSERVATION_CHANGED` 且不派发 |
| 视觉定位 | 完成：`visuals` → `screenshot --visual N`（区域相对坐标）→ `visual-drag` / `visual-click` / `visual-gesture`（多点、多把手、长按） |
| 视觉安全 | 单次消费、截图后几何复测、派发前命中校验、**候选可点性校验**（v42） |
| 提取覆盖度 | `coverage: { scope, returned, declared, stopReason, datasetComplete }` |
| 反爬实测 | 四层报告 + 三个靶场基线（Spiderbuf / Scrape Center / SpiderDemo）+ 猿人学断言回归 |

## 5. 正在进行中的事（下一步）

**验证码"驱动通道矩阵"**：确认指针流能不能被控件接收并判定（不涉及解题）。

工具：`tools/captcha-drive-matrix.ps1`（6 题型，判定 `rejected` / `no-feedback` / `no-widget` / `advanced` / `dispatch-error`；支持 `-Only <id正则>` 单题型重跑）。结果合并：`tools/merge-captcha-drive.mjs`（按"至少一次 rejected"判 channel-verified，保留每次判定）。

**本轮（2026-11-16）已跑完 3 轮 × 6 题型，基线已写回 `tests/anti-bot/captcha-drive-baseline.json`**：

| 题型 | 三轮判定 | 结论 |
| --- | --- | --- |
| 滑动拼图 | `rejected / rejected / rejected` | 通道已验证 |
| 滑动刮刮乐 | `rejected / rejected / rejected` | 通道已验证 |
| 圆柱验证码 | `rejected / advanced / rejected` | 通道已验证（某轮 dx=60 恰好拼合，`验证成功` 且页码推进） |
| 按压旋转 | `rejected / rejected / rejected` | **首次**通道已验证（`验证失败，请重试`） |
| 点击拼图 | `rejected / rejected / rejected` | **首次**通道已验证（`验证失败，请重试`） |
| 双滑块 | `no-feedback / no-feedback / no-feedback` | 未拿到页面级判定（手柄能被拖动，见下） |

合并口径：`channel-verified=5  never-reacted=1  mixed=0`（runs=3，minAttempts=3）。

page-lib v43 重载后又跑了一轮回归（`.tmp-bench/captcha-drive/run-v43/`）：`rejected=4 / advanced=1（圆柱）/ no-feedback=1（双滑块）`，与三轮基线同型；非可信路径同手势实测 `pointerdown → pointerup` 间隔 ≈804ms（修复前 3ms），长按期间 `#fill` 到 160、题图旋转，松手后页面推进到第 2 页——长按确实被控件收到并判定。

**这轮确认的机制（照着手势模型调，不是加次数）：**
- 按压旋转的控件是 **`.press-btn` 按钮**，不是题图。按题图（`#captchaImage`）一次事件都不触发；按住按钮才出现 `#fill` 进度和图片旋转。手势：`drag .press-btn --dx 20 --hold 800ms --trusted` → 松手后 `验证失败，请重试`。
- 点击拼图 `visuals` 返回的是 **4 块 140×140 的 `.piece`**，不是整张图；点一块转 90°。必须"不同候选各点一次"（`--plan` 每步带自己的 `visual`），再点 **`.submit`** 才判定；判定文案在点提交后约 1.2s 才出现、只活 ~0.5s。
- 双滑块两个手柄都能被拖（位移可见、拼图块跟着走），但错位时页面**不判定**——只有拼合正确才推进。所以"no-feedback"在这里的含义是"手势被受理、但没有可观测判定"，不等于通道不通。
- 反馈必须**窗口化采样**：动作后按 300ms 粒度最多采 2.4s，命中失败/成功文案、题图换图、页码推进、`正在加载验证码` 任一即停。只查动作后 900ms 那一下会漏掉点击拼图（1.2s 后才出文案）。

**下一步建议**（按优先级）：
1. ~~修 `drag --hold` 非可信路径的时序缺陷~~ **已修（page-lib v43）**：`actionDrag` 改为按下之后再 `sleepMs(holdMs)` 再移动；已验证同一手势下非可信路径 `pointerdown → pointerup` 间隔从 3ms 变为 ≈800ms。改动在 `extension/injected/page-lib.js` + `extension/src/inject.js`（版本 42 → 43），扩展包已重新打包（哈希见 `docs/releases/0.1.3.md`）。
2. 双滑块若要拿到 `rejected`，必须给出一个接近正确的位置再错开——这会跨进解题范围，暂不做；当前记录"可驱动、不判定"即可。
3. 圆柱那轮的 `advanced` 值得复核：dx=60 是固定值，恰好拼合说明该题目标位置可能只有少数离散取值；若后续要谈"能不能过"，这是唯一一条自然过关的样本，先别当规律。

### 5.1 能力增强（page-lib v49）

已实现并跑过单测/真实浏览器验证：

- **契约**：账本结算读 `error.data.dispatched/effect_state`（确定未派发不再记 unknown 冻结）；`plan` 返回同步观察，并兼容 `{method,params}` / `{action,...}` / `{action:{method,params}}` 三种步骤；技能文档的 plan 示例改正；`fill` 回 `actual_value`（非敏感、截断 200）+ `formatted`（敏感字段只回 formatted）；`press` 支持 US 标点物理 code（Ctrl+/ 等）。
- **观测**：VOM 增加 `[field: "..."]` 前置标题绑定、`[custom-dropdown: expanded|click to open]`、连续 ≥3 条只读行折叠；stealth 增加零对比度、text-indent、bg-clip 渐变保留、sr-only 保留；`unchanged` 观察复用（页面没变时扩展不回全文，daemon 用缓存补）；CLI 侧 `--delta` 真正计算行级 patch；虚拟滚动行 `rowAnchor` 校验（`E_TARGET_MISMATCH` + `reason=virtual_row_recycled`）。
- **输入/会话**：`select` 先校验后滚动、按 label/大小写/`label` 属性匹配、歧义候选带 `available`；`session start|open --scope` 绑定 caller scope，`BB_SESSION_SCOPE` 兜底；`wait-for-navigation` 读 `pendingUrl`，`back/forward` 以"complete 且 URL 已变"为准（bfcache 不再白等 15s）。
- **可靠/安全**：feature 兼容表 + 派发前 preflight（旧扩展缺 `unverified`/`expect`/`plan`/`read` 直接报 `E_UNSUPPORTED_CAPABILITY`）；recipe 独占锁 + run marker（新码 `E_RECIPE_LOCKED`）；账本增加目标/步骤摘要与 0600；配对服务端证明（daemon 用同 token 签 challenge，扩展在 hello-ack 校验）+ `bridge daemon rotate`；输入标记改 `performance.now()` 单调时钟（兼容旧 epoch）；AX 域 10s 租约；接管浮层最小化按会话存 background；popup 连接设置常显 + 未配对警告；`logs --follow`、`--quiet`、`--verbose`、`get-html --out` 帮助、`--steps-file`。
- **本轮新增**：`plan` 改为 daemon 逐步骤执行（每步独立账本记录/结算，首步失败即停；E_NOT_FOUND 等 precondition 失败记 `effect_state:none` 不冻结标签页）；观察/截图结果带短别名 `oN`/`cN`，可写 `--observation o2`、`--baseline o1`、`--capture c1`；`observeSmart` 与 `observe` 共用 observationId 缓存，默认 observe 的 delta/unchanged 也能对上；行级补丁支持新增/删除行（`structural-text`，CLI 输出 `+/-` 并本地合并）；接管浮层最小化经 `showTakeover` 传入页面脚本，跨导航保留（真实页面验证）；page-lib 增加 mutation log——观察 childList/characterData/attributes 与同源 iframe 文档，并把 scroll/resize 记为 layout 变化；无 DOM/属性/布局/交互变化时跳过 VOM 重建，只有纯文本节点变化时用 `lineMap` 只重渲染最近祖先子树（`incremental:true`），属性变化或新增/删除节点回退整页（新增 `tests/unit/mutation-summary.test.mjs`）；多 frame 页面的 `--delta` 用合并基线计算 patch，避免删掉其它 frame；导航/刷新清空扩展观察基线；`bridge ui --diagnostics` 输出页面自检与 AX 域租约；`debugger.simulate-detach` 走真实 `chrome.debugger.detach` 路径模拟浏览器侧分离，实测重挂后焦点仿真恢复；本地 `observations/` 按 7 天 TTL + 300 文件上限清理；删除未使用的 `action-guard`；`bridge install-skill --commands` 为 Claude Code/Codex/Cursor 生成 `/browser-bridge` 命令包装；DSH 插件通过 `ctx.skills.register` 注册内嵌技能（agent 作用域），安装插件后无需再装 DSH 文件技能。注入失败的 frame 用 CDP `Target.setAutoAttach` + per-target AX 采集兜底（只读文本，`--cdp-frames` 可强制诊断，新增 `tests/unit/frame-cdp.test.mjs`）。
- **明确未做**：跨源 iframe 的帧内增量重渲染（CDP 兜底只提供只读文本，不生成可动作 ref；多 frame delta 的 patch 正确但帧内仍整帧重建）；macOS x64 便携包需在 macOS 上构建。

## 6. 已知坑（都踩过，别再踩）

| 坑 | 表现 | 正确做法 |
| --- | --- | --- |
| PowerShell 5.1 吞引号 | 传给 node 的 JS/JSON 里 `"` 消失，报语法错或 `{steps:[...]` | JS 里只用单引号；JSON 用 `--plan` **文件**；探针先落盘再 `--` 传 |
| `.ps1` 编码 | 中文乱码 + 莫名其妙的 parse error | 存成 **UTF-8 with BOM**（`[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($true)))`） |
| `404` 当错误页标记 | 题面含随机四位数，正常页被判 404 | 只匹配文案 `页面不存在`（已封装为 `tools/lib/regression-helpers.ps1`） |
| `Number(null) === 0` | "没有声明"被当成"声明 0" | 判空后再转数字（`declaredRowCount` 已修） |
| daemon 跑的是安装副本 | 新加的 RPC 方法报 `E_UNKNOWN_METHOD` | daemon 运行在 `%LOCALAPPDATA%\BridgeDeck\daemon\server.mjs`，**新增方法要同步安装副本并重启 daemon**；或复用已有方法 |
| 视觉候选指向隐藏副本 | 拖拽返回成功、页面毫无反应 | 已修：`visualScan` 收录前做中心命中测试（v42） |
| 有限次动画 | "呼吸一会儿就不动了" | 呼吸类动画一律 `infinite`，末帧不要回到 `opacity:0` |
| 单次采样 | 同一题型得出相反结论 | 多次采样 + 保留每次判定 |
| `drag --hold` 非可信路径 | 长按没发生：`actionDrag` 在 `pointerdown` 前 sleep，等于"先等再按" | 已修（page-lib v43）：按下之后再保持按住；老页面要重载扩展/重导航才会换新库 |
| 验证码失败文案是瞬时的 | 点击拼图点提交后约 1.2s 才出 `验证失败，请重试`，只活 ~0.5s；动作后查一下就漏 | 动作后按 300ms 粒度采样一个窗口（2.4s），命中任一信号再停 |
| 用 `当前页\s*(\d+)` 取页码 | 匹配到"总页数 30"，永远读成第 30 页 | 用 `第 N 页，共 M 页` 或"已采集页数"前面的数字 |
| 把整张题图当成点选区域 | 点击拼图页 `visuals` 给的是 4 块 `.piece`；对同候选点两次只动一块 | `--plan` 每步写自己的 `visual`，不同块各点一次 |

## 7. 代码地图（改哪里）

| 想改什么 | 去哪 |
| --- | --- |
| 页面侧能力（观察/动作/提取/视觉） | `extension/injected/page-lib.js`（改完 bump 版本） |
| 扩展工具层（截图、命中校验、拖拽） | `extension/src/screenshot.js`、`extension/src/tools/interaction.js` |
| 协议方法 / schema | `lib/protocol.mjs`、`lib/methods.mjs`、`lib/schemas.mjs` → `node tools/gen-protocol.mjs` |
| 错误码 | `lib/error-codes.mjs` → `node tools/gen-error-codes.mjs` |
| CLI 命令 | `cli/bridge.mjs`（记得同时注册进 `PAGE_COMMANDS` 与 `VALUE_FLAGS`） |
| 技能文档（agent 读的） | `skill/**` → `node tools/build-embed-skill.mjs`，并复制到 `~/.dsh/skills/browser-bridge/` |
| 靶场回归 | `tools/enumerate-*.ps1`、`tools/yuarenxue-assert.ps1`、`tools/captcha-drive-matrix.ps1`（合并用 `tools/merge-captcha-drive.mjs`） |

## 8. 规范约定（已确立，别破坏）

- 代码、注释、文档里**不出现外部产品或版本名**，也不写"来源致敬/对齐某某"这类表述；直接描述机制本身。
- 文案与注释用中文；标识符用英文。
- 新增错误码 → 必须同时更新 `lib/error-codes.mjs` 并跑生成器（单测会拦）。
- 新增协议方法 → 必须跑 `tools/gen-protocol.mjs`（`--check` 会拦）。
- 生成的产物（`cli/embedded-skill.mjs`、`extension/src/generated/protocol.js`）**不要手改**。

## 9. 交接时的现场状态

- 浏览器实例：`f745d380`（Edge 157，扩展 0.1.6，`LIB_VERSION 53`）
- 无活动会话（`bridge status` 应为 `sessions (0)`）
- 单测 1027 pass / 0 fail
- 扩展包：`dist/BridgeDeck-extension-0.1.6.zip`
- 驱动通道基线：3 轮 × 6 题型，`channel-verified=5 / never-reacted=1 (双滑块)`，见 `tests/anti-bot/captcha-drive-baseline.json`；原始每轮结果在 `.tmp-bench/captcha-drive/run-{1,2,3}/matrix.json`

---

**接手第一步建议**：跑第 2 节的五条验证命令确认基线，然后从第 5 节开始。
