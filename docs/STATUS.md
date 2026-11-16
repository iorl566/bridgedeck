# 当前状态

> 换会话接手请先读 [HANDOFF](HANDOFF.md)（状态、验证命令、已知坑、下一步）。

最后更新：2026-11-16（BridgeDeck 0.1.4，协议 1.9）

## 已验证

| 项 | 结果 |
| --- | --- |
| 真实 Edge E2E | 145/147（2 项按借用确认安全策略跳过） |
| 纯函数单测 | 1004/1004 |
| CLI selftest | 155/155 |
| 宿主插件 | 26/26 |
| 插件直连冒烟（真实 Edge） | 11/11，0 次 CLI 回退 |
| MCP selftest | 10/10 |
| Node / Python SDK | 8/8 / 8/8 |
| protocol-check | 全绿 |
| 发布清单 | 4 artifacts（含 Ed25519 签名） |

## 性能（050g，9 站中位）

| 指标 | 数值 |
| --- | --- |
| 导航 | 1166 ms |
| 观察 | 186 ms |
| 脚本验证型 | 156 ms |
| 截图 | 358 ms |
| 会话启动 | 367 ms |
| MCP observe | 12 ms |
| 插件直连 observe（warm） | 9 ms |

## 环境

- Windows + Node 22，Edge 157（未登录测试配置）。
- 扩展 0.1.3，daemon 本机单实例，协议 `1.9`。
- 运行时零依赖；MCP 51 工具、DSH 插件 35 工具、Node/Python SDK。

## 已知边界

- 命名规范化：代码、注释、文档统一使用本项目自己的术语，不引用外部产品或版本名，也不再出现"来源致敬"式的表述。原先遗留的两处兼容标识符已一并改造——本地配对协议域收敛为单一域名 `bridgedeck-local-auth-v1`（**升级后需要重新配对一次**，旧域名签发的凭证不再被接受）；DSH 视频夹具改为复用本仓库插件入口（`createRunner` + `apply`）。
- 呼吸边框修复：接管浮层与协作光晕的呼吸动画原来是 `animation: bbp 3s ease-in-out 2`（只跑 2 次，6 秒后停在 `opacity:0` 的末帧，看起来"不再呼吸、一直很淡"）。改为 `infinite`，关键帧末帧从 `0` 提到 `.15`（保留边缘可见度），并在暂停态加 `.glow.paused::after{animation:none;opacity:0}`——人接管时不该继续"呼吸"。实测接管浮层：`animation-name=bbp, duration=3s, iteration-count=infinite, opacity≈0.83`。单测新增两条断言禁止退回有限次数。
- 回归公共判定固化到 `tools/lib/regression-helpers.ps1`：`Test-PageNotFound`（只匹配文案 `页面不存在`）、`Test-LoginWall`、`Get-NumberSignal`、`Invoke-BridgeJson`、`Get-CaseState`、会话起停封装。SpiderDemo 枚举与猿人学断言脚本已改为 dot-source 复用，不再各写一份。
- 错误码带恢复建议：`lib/error-codes.mjs` 新增 `ERROR_RECOVERY`（`retry: no|transient|after-action` + 一句话下一步），CLI 失败时在 stderr 追加「下一步（after-action）：…」，MCP 工具错误文本同样带一行。**JSON 输出保持不变**（客户端已有结构化 `error.code`，不塞冗余字段）。高频码（观测/截图/会话/遮挡/超时）全部覆盖，未登记的码按 `no` 兜底且不编建议。
- 错误码收敛为单一真源 `lib/error-codes.mjs`（**98 个**，daemon + 扩展 + 客户端侧 `E_DAEMON`），由 `tools/gen-error-codes.mjs` 生成到 `docs/PROTOCOL.md`、`sdk/index.mjs`（`ERROR_CODES` + `normalizeErrorCode`）、`sdk/index.d.ts`（`BridgeErrorCode` 联合类型）、`sdk/python/browser_bridge.py`（`ERROR_CODES`）。单测覆盖四层：清单格式、扩展白名单子集、**daemon/CLI/MCP/扩展源码里抛出的每个码都必须登记**（扫描 300+ 源文件）、文档与两个 SDK 覆盖率（缺则提示跑生成器）。**SDK 之前会把未知码降级成 `E_INTERNAL`，导致 `E_NO_SESSION` 这类码丢失**——现已按全量清单归一。
- 视觉候选加"可点性"校验（page-lib v42）：`visualScan` 收录前对候选中心做 `elementFromPoint`，落点不是自身/子树/祖先链就丢弃，并过滤 `opacity:0`。起因是拼图页同时存在隐藏/模板副本，按它的坐标派发会"打到空气"——拖拽返回成功、页面毫无反应。现在**扫描时保证候选可点，派发时保证落点归属**，两端都堵住。
- 多段手势 `visual-gesture`：`--visual N --points "x,y;x,y"` 依次点击，或 `--plan <file|json>` 混合「点击 / 拖拽（支持 `hold` 长按、`duration` 时长、`steps` 插值）/ 等待」，每步各自重新截候选区域（单次消费不变），最多 12 步。实测点击拼图 4 个 `.piece` 候选：两步点选与「点击→等待→长按拖拽→反向拖拽」混合计划全部返回 `ok` 并带回 `hit`。这补齐了单次拖拽覆盖不到的两类控件（点选、多把手）。
- `tools/captcha-drive-matrix.ps1` 驱动通道矩阵按题型换手势（`drag` 滑块 / `hold` 长按 / `points` 点选 / `dual` 双把手），带 `-Only` 单题型重跑与窗口化反馈采样（动作后 300ms 粒度，最多 2.4s：失败/成功文案、题图换图、页码推进、`正在加载验证码`）。**2026-11-16 重跑 3 轮 × 6 题型**，`tools/merge-captcha-drive.mjs` 按"至少一次 rejected"合并：滑拼、刮刮乐、圆柱、**按压旋转**、**点击拼图** 共 5 题 `channel-verified`，双滑块 `never-reacted`；圆柱某轮 dx=60 恰好拼合（`验证成功` + 页码推进，记为 `advanced`）。基线 `tests/anti-bot/captcha-drive-baseline.json`。两处机制修正：按压旋转的控件是 `.press-btn` 按钮（按题图零反应），点击拼图 `visuals` 给的是 4 块 `.piece` 且要再点 `.submit` 才判定（文案延迟约 1.2s、只活 ~0.5s）。双滑块两个手柄都可驱动、但错位不判定。关键教训：**单次瞬时采样会漏掉判定文案**，"无反馈"不等于通道不通。同时修掉一个长按时序缺陷（page-lib v43）：`drag --hold` 的非可信路径原来把 hold 的 sleep 放在 `pointerdown` 之前，长按不会发生；现在改为按下后再保持按住（非可信路径实测 `pointerdown → pointerup` 由 3ms 变为 ≈800ms），扩展包已重新打包。
- 能力增强（page-lib v49，2026-11-16）：契约层修账本结算字段（`error.data.dispatched/effect_state`）、`plan` 返回同步观察并兼容三种步骤写法、技能文档 plan 示例、`fill` 回 `actual_value/formatted`、`press` 标点物理 code；观测层加 `[field:]`/`[custom-dropdown]`/连续只读行折叠、stealth 零对比度与 text-indent、`unchanged` 观察复用、CLI 行级 `--delta`、虚拟行 `rowAnchor`；输入/会话层加 select 前置校验与 label 变体、`--scope` caller scope + `BB_SESSION_SCOPE`、`wait-for-navigation` 在途/bfcache；可靠安全层加 feature 兼容 preflight、recipe 独占锁、账本目标摘要与 0600、配对服务端证明 + `daemon rotate`、输入标记单调时钟、AX 10s 租约、浮层最小化按会话存、popup 连接设置常显、`logs --follow`/`--quiet`/`--verbose`/`--steps-file`。随后把 plan 改为 daemon 逐步骤执行（每步独立账本与结算），并给观察/截图加 `oN`/`cN` 短别名（`--observation o2`、`--baseline o1`、`--capture c1`）；行级补丁再支持新增/删除行（`structural-text`）；接管浮层最小化跨导航保留；page-lib 加 mutation log（观察 attributes/childList/characterData + scroll/resize；无变更跳过 VOM 重建；纯文本变化才走增量补丁，属性变化/结构变化回退整页）；`bridge ui --diagnostics` 暴露页面自检与 AX 租约；同源 iframe 也纳入 mutation 观察；多 frame delta 用合并基线避免删掉其它 frame；导航清空扩展观察基线；`debugger.simulate-detach` 实测重挂后焦点仿真恢复；observations 缓存 7 天/300 文件清理；删除未使用的 action-guard；注入失败的 frame 用 CDP OOPIF + AX 兜底采集（只读文本，`--cdp-frames` 诊断）；`install-skill --commands` 生成 Claude/Codex/Cursor 斜杠命令；DSH 插件内嵌并注册技能。单测 1004/1004。
- 观测代数守卫补全（page-lib v41）：`read`/`extract` 结果也带 `revision`，`bridge read`/`extract` 支持 `--expect-revision`，于是"读到的值到现在没变过"可以表达——先 `read` 拿代数，再用同一代数去 `click`/`fill`，中间重渲染会被 `E_OBSERVATION_CHANGED` 挡下。
- 新增观测代数守卫（page-lib v40）：`observe` 结果带 `revision`，动作可带 `--expect-revision N` 要求与观测同一代 DOM，不符则 `E_OBSERVATION_CHANGED` 且**不派发输入**。默认不开启（不带参数不校验），避免误伤无关 DOM 变化。实测：`revision=16` 时 `--expect-revision 3` 被拒、`--expect-revision 16` 正常执行。
- `extract` 增加覆盖度说明（page-lib v39）：结果带 `coverage: { scope, returned, declared, stopReason, datasetComplete }`。`declared` 取自 `aria-rowcount`/`aria-setsize`，无声明为 `null`；`stopReason` 区分 `end`/`max-rows`/`max-bytes`；`datasetComplete` 只有"声明数读满"才 `complete`——**不代表页面内容真的全**。`declared` 取自 `aria-rowcount`/`aria-setsize`，没有声明就是 `null`（不猜）；`stopReason` 区分 `end`/`max-rows`/`max-bytes`；`datasetComplete` 只有"声明数读满"才给 `complete`，被截断给 `incomplete`，无声明给 `unknown`——**`complete` 不代表页面内容真的全**（分页、无限滚动、canvas 不在覆盖范围）。实测 SpiderBuf C03：`declared=null, returned=5, stopReason=max-rows, datasetComplete=incomplete`。CSV 模式也会打印一行覆盖度。

- CLI 冷启动 72–86ms，受 Node 运行时限制；推荐 MCP/插件常驻路径。
- 视口截图 358ms，主要受 CDP PNG 编码限制。
- 观察主遍历仍为 page-lib；`--compare-ax` 提供 AX 覆盖率基线与降级路径。
- 反爬第一层（静态检测站）已实测并修复：MAIN world 常驻注入改为按需注入 + 可还原，pixelscan / browserscan / fingerprint-scan 复测转绿（rebrowser 只剩 Edge 固有的 `useragent` 红）；详见 [ANTI-BOT-LAYER1-BENCH](ANTI-BOT-LAYER1-BENCH.md)。
- 反爬第二层（动态挑战）已实测（见 [ANTI-BOT-LAYER2-BENCH](ANTI-BOT-LAYER2-BENCH.md)）：Turnstile 官方测试 key 链路正确、真实 key 停在交互式人工环节；Cloudflare 出现"直接放行（crunchbase 200）"与"WAF 硬拦截（cars/imf/g2 403）"两种结局，瓶颈是出口 IP 声誉而非浏览器环境。
- 国内平台（无代理条件下的真实站点平替）已实测（见 [ANTI-BOT-LAYER3-DOMESTIC](ANTI-BOT-LAYER3-DOMESTIC.md)）：淘宝/京东/点评/小红书首页未登录均放行，搜索全部导向登录；京东 `risk_handler` 用非浏览器客户端同样触发，证明该判定来自 IP/会话而非自动化指纹。未出现任何滑块验证。
- 登录后深层路径已补测（同上文档第 4 节）：淘宝扫码登录后搜索 4 页 + 2 个商品详情页全部正常、0 次滑块，说明未登录时看到的"反爬"主要是未授权；京东因无登录态仍停在 `risk_handler`，登录请求本轮超时未完成。
- 靶场行为验证已实测（见 [ANTI-BOT-LAYER3-BENCH](ANTI-BOT-LAYER3-BENCH.md)）：C14 模拟浏览器检测通过、C02 滑块 80ms 直线拖拽即过（只校验位移）；C04 行为门三种点法均被拒（命中点已用 `elementFromPoint` 核实），属当前能力边界。
- SpiderDemo 验证码交互实测（见 [ANTI-BOT-LAYER3-BENCH](ANTI-BOT-LAYER3-BENCH.md) 第 5–6 节）：`tools/captcha-probe.ps1` 覆盖 15 种题型；`tools/captcha-gesture-matrix.ps1` 用 teleport/fast/slow 证明 **JS 合成事件一律不被受理**（位移 200px 但页面零反馈），CDP 真实指针流会被受理并返回"验证失败"；速度差异因位置错误无法分离，属测量局限。
- 新增视觉定位接口（见 [VISION-DRAG](VISION-DRAG.md)）：`drag --capture <id> --image-x/--image-y --image-dx/--image-dy` 按截图像素坐标拖拽，换算与 `click --capture` 共用 `resolveCapturePoint`，强制走 CDP 原生输入。实测：`image(318,157)` + `scrollY 374` → `page(318,531)`，拖拽后页面返回"验证失败，请重试"（手势被受理）。
- 截图新增 `--grid [--grid-step]`（坐标网格）、`--profile x|y`（差分剖面）、`--region-scale 1-8`（区域放大）；grid/profile 都会注册 capture 供 `drag/click --capture` 使用。实测拼图页 4x 放大后 40px 拼图块清晰可辨。单测 964，`gen-protocol --check` 通过。
- 新增离线看图工作台 `tools/image-inspect.mjs`（零依赖，PNG 解码/编码 + crop/zoom/grid/profile/match），见 [IMAGE-INSPECT](IMAGE-INSPECT.md)。实测拼图截图：剖面边缘 303/603、327/501 与图片实际边界一致。负结论：该题没有高对比缺口标记，纯测量无法定出缺口列，"这是缺口"仍属语义判断。
- 视觉动作的可验证性已补齐：把"区域"做成一等公民（visual ref + region + mapping），靠**单次消费、截图后几何复测、派发前命中校验**把"看图点哪"变成可验证动作。四条已全部落地：
  - `consumeCapture`：同一张 capture 只能派生一次动作（实测第二次用同一 id 被拒）。
  - `capture_skipped: geometry-changed`：截图后几何变了不给坐标。
  - `verifyVisualHit` + page-lib `hit-at`（LIB_VERSION 36）：派发前拦"无元素 / html、body / pointer-events:none / inert / 铺满视口遮挡"；命中简报带进结果。实测滑块坐标返回 `hit: {tag:div, id:sliderMoveBtn}`，超界坐标返回 `E_NOT_ACTIONABLE`；**校验不可用时拒绝盲发**（不再静默降级）。
  - 视觉候选发现：`visuals`（page-lib `visualScan`，LIB_VERSION 37）+ `screenshot --visual <index>`（只截候选区域、自动放大、坐标改为区域相对、归一化换算）+ `hitAt` 的 `matches` 判定（不匹配报 `E_TARGET_MISMATCH`）。实测拼图页：v2 `#captchaImage` 300x184 → 600x368 区域图，`image(300,100)` → `page(453,377)`，落点 `#slider` 判为候选子元素命中。
  - 一步式组合命令：`visual-drag` / `visual-click`（截区域→派发→命中校验→capture 即弃，`--out` 可存预览）。实测输出"区域拖拽完成：候选 v2 从 453,377 到 513,377，命中 <div#slider>"。四个机制至此全部落地，并压成了一条命令。单测 968。
- 视觉模块取舍已成文（见 [VISION-MODULE](VISION-MODULE.md)）：业界分纯视觉定位（Midscene 一类）、DOM + 标注截图、本地 CV/OCR（ddddocr 一类）三条路线。**决定：桥不接模型、不做 OCR/打码**，只做"测量 + 换算 + 校验"，看图交给 agent。技能文档已加"Canvas 与看图取坐标"一节（`visuals → screenshot --visual → visual-drag`）；将来若需无人值守，再按适配器契约（`{PNG,hint} → {x,y}|{dx}`）外挂，不进桥本体。
- 四轮结果已汇总为 [ANTI-BOT-REPORT](ANTI-BOT-REPORT.md)，回归入口：`tools/anti-bot-bench.ps1`（第一层）、`tools/anti-bot-regression.ps1`（靶场三条用例，含一条预期失败）。
- 靶场全量盘点见 [ANTI-BOT-RANGES](ANTI-BOT-RANGES.md)：Spiderbuf 36 题零门槛可全量枚举（主力回归）、Scrape Center 42 例可全量实测（基线在 `tests/anti-bot/scrape-center-baseline.json`）。
- SpiderDemo 已注册并枚举：真实清单走 `/admin_I/api/challenges`，33 题中 **32 题可用**（清单 `url` 字段不可靠，真实前缀是 `/captcha`、`/authentication`、`/ob`、`/sec1`、`/css_anti`、`/font_anti`，从 `main.js` 字面量抽取）。验证码区 15 题里 14 题可用，加载普遍 2.5–5.5s（个别题 10s+）；"页面不存在"判定只匹配文案，不能匹配 `404`（题面含随机四位数会误判）。
- 猿人学已断言化：`tools/yuarenxue-assert.ps1` + `tests/anti-bot/yuarenxue-cases.json`（21 题 + 6 试炼），入口层断言"可达 + 标题关键词 + 非 404"，数据层以"出现 ≥5 个三位以上数字"为信号。实测 **27/27 入口通过、1 条数据 pass、26 条 skip**（数据需先通过单项挑战，桥不解题）。基线 `tests/anti-bot/yuarenxue-baseline.json`。发现站方编号重复：`/match/17` 和 `/match/18` 都叫「第十八题」，判定应以标题为准。
- Scrape Center 反爬组结论：`antispider1`（WebDriver 检测）正常返回 20 条、`antispider8`（无限 debugger）不卡（桥不启用 Debugger 域，`debugger` 语句是空操作）；`antispider10` 渲染失败已定位——依赖的 unpkg Vue/Element UI 路径 404（Vue 3 没有 `dist/vue.js`），属靶场依赖腐烂，与反爬无关。
- 猿人学已用微信扫码登录实测（见 [ANTI-BOT-RANGES](ANTI-BOT-RANGES.md) 第 5 节）：`/match/1..21` 全部可达，题型含 jsvmp、window 蜜罐、动态字体、雪碧图（100 张图）、控制台检测、Http2、重放对抗；22–30 为占位页。python-spider（猿人学 Python 分站）注册需群内邀请码，暂不可用。
