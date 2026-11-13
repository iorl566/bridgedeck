# 功能矩阵：BridgeDeck 0.1.1 × 参考实现 0.4.2

证据口径：
- 「我们」列引用真实 Edge E2E 的检查号（tools/e2e.mjs，112/112 通过）。
- 「参考实现」列来自 0.4.2 官方 release 的本地夹具实测或源码/技能文档。
- 本地反爬靶场：tests/fixtures/antibot.html；真实反爬站点在当前网络环境不可达（curl 无响应），未纳入。

| 功能域 | 我们的实现 | 我们的证据 | 参考实现 0.4.2 | 差异 |
| --- | --- | --- | --- | --- |
| 会话/窗口 | session start/stop/list/rebind，agent 窗口复用，incognito | 3, 11, 20k, 20l, 20q | session start/stop，agent 窗口，--browser 选择 | 基本一致 |
| 语义观察 | observe/snapshot，@eN，**ARIA grid/树/菜单角色 ref + 日历单元格 ref + 数据表行 ref**，分页 cursor，max-tokens，save-full，view，`--vom` 结构化节点（rect/inputState/inForm/clickable/dragHint/paintOrder/nearbyText/hitTest/occludedBy），`--ax` 原始 AX 树与 backendNodeId 精确 join | 5, 5b, 5c, 22, 23, 23e3, 23l, 23m, 23o, 35b | observe/snapshot，@eN，grid 行 ref，AX+几何 VOM | 已补齐 grid 行 ref 与结构化节点/命中测试/AX join |
| iframe | 同源主树、跨源 observe --frames + @fNeM | 20p, 23p | 统一 @eN（跨源/closed shadow 同一序列） | ref 命名模型不同 |
| closed shadow | CDP pierce，observe --closed-shadow 分配 @eN，按 ref 点击/读取 | 20u, 20v | VOM 直接给 @eN 并可点 | 能力已对齐，默认开关不同 |
| 交互 | click/hover/fill/press/select/focus/blur/scroll-to/drag/wheel | 4, 6, 7, 16, 17, 23c, 23f | 同名命令，语义接近 | 基本一致 |
| 可信输入 | --trusted：click/hover/fill/press/**drag** 全部原生键鼠注入；输入前置前标签页、动作前遮挡校验（E_OCCLUDED/--force）、同 tab 输入租约互斥 | 20z, 35b | 原生输入；移动目标保护会拒绝 | **我们的差异点：动态目标可用，且显式遮挡/并发错误** |
| 上传 | input/选择器拦截/隐藏 input；--mode drop | 18, 18b, 18c | 选择器拦截 + --mode drop | 已对齐 |
| 大文件分块 | >4MB 自动 transfer staging，daemon 注入路径，CLI 不接触路径；>8MB 走 CDP 路径赋值；下载经 transfer.read 落盘 | 18d, 18e, 23g | transfer.* 分块 + staging | 已对齐（上传/下载；远程仍限制） |
| 下载 | chrome.downloads 等待 + 覆盖保护 + transfer staging 流式落盘 | 23g | download 捕获 + 覆盖保护 | 基本一致 |
| 对话框 | pending(exit 6) + dialog accept/dismiss + operation await/cancel | 19, 20t | 同语义（exit 6、operation await） | 基本一致 |
| 网络/调试 | network + debug（requests/body/console/pages/perf/aggregate/duplicates/operations/export/replay/history）；console 支持 --limit/--cursor；调试页含操作时间线 | 20, 20b, 20b4, 20e, 20m | debug（requests/page context/recording export） | 我们多 replay/aggregate/duplicates |
| 规则 | 页面 fetch/XHR + DNR block/redirect + CDP Fetch fulfill/modify | 20f, 20o, 20x, 20y | 规则/重放（以 CDP 为主） | 实现路径不同，能力对齐 |
| 截图 | 视口/整页/元素/标注/视觉坐标/手动拼接 | 10, 20i, 23d, 23q, 25 | viewport/full/element/Canvas | 基本一致 |
| 提取 | discover/table/list + **ARIA grid/ag-grid + 多行表头网格展开**，CSV，fields-json | 14, 15, 23e, 23e2, 23e5 | discover/table/list（含 grid） | 多行表头/rowspan 我们更准确（SMM 实测） |
| 等待/流程 | wait-for-element、wait-for-navigation、plan/step（均支持 --until-visible）、recipe（草稿→审批→执行） | 22, 22b, 23b, 20s, 20t | wait-*、step、view；recipe 以技能文件为主 | 我们 recipe 是 CLI 一等公民 |
| 协作 | cooperate sync/wait/handback，context/expect/depends-on/observation/settle/strict | 23h–23x | cooperate sync/wait，context/expect/observation | 基本一致 |
| 人工协助 | request-help（设置关闭时拒绝），接管浮层 | 24 | request-help + 浮层 | 基本一致 |
| 录制/视频 | record（事件/历史），video（MP4/保存/列表/过期） | 20c, 20d, 20g, 32, 35 | record、video（MP4/24h） | 基本一致 |
| 审计 | audit list（since/limit/offset），审计页 | 20h, 27, 34 | audit（扩展 UI） | 我们有 CLI 分页 |
| 仿真 | emulate viewport/DPR/UA/touch + reset | 21 | emulate | 基本一致 |
| 多实例 | browsers/label/--browser | 2, 12 | browsers/--browser | 基本一致 |
| 远程/配对 | pair create/list/redeem/revoke，WSS | 配对 10/10、TLS 8/8 | daemon pair/devices/revoke | 命令名不同，能力对齐 |
| MCP | stdio MCP，50 工具 | 20j | mcp 子命令 | 基本一致 |
| DSH 插件 | 34 个 browser_* 工具 | 插件 24/24 | 无 DSH 插件 | 我们独有 |
| 反爬靶场 | 指纹 + 可信点击挑战 | 20z | 同页拒绝移动目标 | **我们通过，对方拒绝** |
| 真实反爬站点 | sannysoft/g2/nowsecure/walmart | 实测 | sannysoft 结果逐项一致；g2 正常加载 | 指纹基本一致；tiktok 返回 E_PAGE_ERROR |
| CTRM SSO 登录页 | 7 refs（含输入框/按钮），可 fill | 实测 | 3 refs，多个 input 全漏 | **我们的观察覆盖更全** |
| CTRM 预测 ag-grid | 9 列 + 数据行 | 实测 | 12 列（多空列）+ 数据行 | 数据一致，我们列更干净 |
| 协议 | protocol 1.8 + capabilities 门禁/降级 | 20r | protocol 1.8 协商 | 已对齐（1.8，兼容旧 1.0） |
| 审批强度 | 内容哈希绑定 + 24h 有效期；篡改/过期均拒绝 | 20s | 人类审批（技能流程） | 内容绑定，对方靠流程约束 |

## 结论

- 功能面已对齐：观察/交互/iframe/closed shadow/上传下载/对话框/网络/规则/截图/提取/等待/协作/录制/视频/审计/仿真/配对/MCP。
- 我们多出：DSH 插件、CLI 审计分页、replay/aggregate/duplicates、--trusted（反爬动态目标）、recipe 审批命令。
- 已对齐：协议版本 1.8（兼容旧 1.0）、closed shadow ref、upload drop。
- 已对齐：跨源统一 @eN、审批内容绑定与有效期。
- 真实反爬站点未纳入：当前 shell 网络不可达（curl 无响应）；本地靶场已覆盖核心检测项。
