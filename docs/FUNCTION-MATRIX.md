# 功能矩阵

BridgeDeck 0.1.3 的功能域、实现与验证证据。证据编号对应 `tools/e2e.mjs` 的检查项；插件与 SDK 另有独立自测。

| 功能域 | 已实现 | 验证证据 |
| --- | --- | --- |
| 会话/窗口 | `session start/stop/list/rebind`，Agent 窗口复用，incognito，可恢复启动 | 3、11、20k、20l、20q |
| 语义观察 | `observe/snapshot`、`@eN` ref、ARIA grid/树/菜单/日历/数据表行 ref、分页、`--vom`、`--ax`、`--facts` | 5、5b、5c、22、23、23e3、23l、23m、23o、35b |
| 观察事实 | 几何/可见性/`domClickable`/`domPaintOrder`；表单值（密码遮蔽）；表格 `row/col/header`；`blockingLayers`/`underBlockingLayer` | 5d、5d2、6b、6c、6d |
| 无 ref 元素 | `unmappedAx` + `click-backend`；AX 兜底观察；`--pipeline ax` 备用采集器 | 5e、5f、5h |
| iframe | 同源主树；跨源 `observe --frames` + `@fNeM` | 20p、23p |
| closed shadow | CDP pierce；`observe --closed-shadow` 分配 ref；按 ref 点击/读取 | 20u、20v |
| 交互 | click/hover/fill/press/select/focus/blur/scroll-to/drag/wheel；拖拽支持视觉坐标（`--capture` + `--image-dx/dy`） | 4、6、7、16、17、23c、23f、[VISION-DRAG](VISION-DRAG.md) |
| 可信输入 | `--trusted` 原生键鼠注入；遮挡校验（`E_OCCLUDED`/`--force`）；输入租约 | 20z、35b |
| 上传 | input/选择器拦截/隐藏 input；`--mode drop` | 18、18b、18c |
| 大文件 | >4MB transfer staging；>8MB CDP 赋值；下载 transfer 落盘 | 18d、18e、23g |
| 下载 | `chrome.downloads` 等待 + 覆盖保护 + 流式落盘 | 23g |
| 对话框 | pending(exit 6) + accept/dismiss + operation await/cancel | 19、20t |
| 网络/调试 | network + debug（requests/body/console/pages/perf/aggregate/duplicates/operations/export/replay）；console 分页 | 20、20b、20b4、20e、20m |
| 规则 | 页面 fetch/XHR + DNR block/redirect + CDP Fetch fulfill/modify | 20f、20o、20x、20y |
| 截图 | 视口/整页/元素/区域/标注/视觉坐标/手动拼接 | 10、20i、23d、23q、25 |
| 提取 | discover/table/list；ARIA grid/ag-grid；多行表头；CSV；fields-json | 14、15、23e、23e2、23e5 |
| 等待/流程 | wait-for-element、wait-for-navigation、plan/step、recipe（草稿→审批→执行） | 22、22b、23b、20s、20t |
| 协作 | cooperate sync/wait/handback；context/expect/depends-on/observation/settle/strict | 23h–23x |
| 人工协助 | request-help（可带完成条件）；接管浮层 | 24、24b2 |
| 录制/视频 | record（事件/历史）；video（MP4/保存/列表/过期） | 20c、20d、20g、32、35 |
| 审计 | `audit list`（since/limit/offset）；审计页 | 20h、27、34 |
| 仿真 | emulate viewport/DPR/UA/touch + reset | 21 |
| 多实例 | browsers/label/`--browser` | 2、12 |
| 远程/配对 | pair create/list/redeem/revoke；WSS | 配对 10/10、TLS 8/8 |
| MCP | stdio MCP，51 个工具 | 20j |
| DSH 插件 | 35 个 `browser_*` 工具，高频工具直连 daemon | 插件 26/26、冒烟 11/11 |
| SDK | Node/Python，`/rpc` 直连 | SDK 8/8 + 8/8 |
| 协议 | `protocol 1.9` + capabilities 门禁/降级/偏斜标注 | 20r |
| 审批 | 内容哈希绑定 + 24h 有效期；篡改/过期拒绝 | 20s |
| 反爬 | 指纹 + 可信点击挑战（本地靶场）；四层实测见 [总报告](ANTI-BOT-REPORT.md)，靶场全量盘点见 [RANGES](ANTI-BOT-RANGES.md) | 20z、[layer1](ANTI-BOT-LAYER1-BENCH.md)、[layer2](ANTI-BOT-LAYER2-BENCH.md)、[国内](ANTI-BOT-LAYER3-DOMESTIC.md)、[靶场](ANTI-BOT-LAYER3-BENCH.md) |

## 结论

- 观察、事实层、交互、上传下载、对话框、网络/规则、截图、提取、等待、协作、录制、审计、仿真、配对、MCP/插件/SDK 均已实现并有真实 Edge 验证。
- 独有能力：观察事实层、`unmappedAx` + `click-backend`、AX 兜底、可恢复会话、`effect_state`、DSH 插件直连、插件/SDK。
- 第一层静态检测站已实测并修复（见 [ANTI-BOT-LAYER1-BENCH](ANTI-BOT-LAYER1-BENCH.md)）：webdriver / canvas / WebGL / CDP attach 本就干净；原本 MAIN world 常驻注入导致的 `fetch`/`XHR`/`console` 非原生问题已改为按需注入 + 可还原，pixelscan / browserscan / fingerprint-scan 三项复测转绿。
- 第二层动态挑战已实测（见 [ANTI-BOT-LAYER2-BENCH](ANTI-BOT-LAYER2-BENCH.md)）：Turnstile 测试 key 链路正确；真实 key 与 CF interstitial 需真人动作。当前 403 类拦截主要来自出口 IP 声誉，需住宅 IP 对照才能归因。
- 国内平台已实测（见 [ANTI-BOT-LAYER3-DOMESTIC](ANTI-BOT-LAYER3-DOMESTIC.md)）：首页未登录放行、搜索全部走登录/风控导流、未出现滑块；京东风控经非浏览器对照证实与自动化指纹无关。
- 靶场已全量盘点（见 [ANTI-BOT-RANGES](ANTI-BOT-RANGES.md)）：Spiderbuf 36 题全部枚举（C14/C02 通过、C04 行为门未通过）；Scrape Center 42 例全通过，其中 `antispider1`（WebDriver 检测）正常出数据、`antispider8`（无限 debugger）不触发——桥不启用 Debugger 域，这类反调试防的是人不是自动化。
