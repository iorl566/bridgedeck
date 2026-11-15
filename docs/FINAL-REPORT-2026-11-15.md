# BridgeDeck 能力与性能报告（2026-11-15）

> 范围：BridgeDeck 0.1.2（协议 1.9）的能力清单、9 站实测、运行时优化与回归状态。
> 数据源：本仓库测试、`.tmp-bench/out-bridge050g/`、`.tmp-bench/out-compare050b/`；环境为 Windows、Edge 157、未登录、逐站独立会话。

## 0. 结论

- **能力面完整**：协议 1.9、观察事实、可恢复会话、证据模型、动作护栏、MCP/插件/SDK 工具面、调试与录制均已落地。
- **页面侧性能**：观察 186ms、验证型脚本 156ms、导航 1166ms（9 站中位）。
- **常驻路径更快**：MCP observe 12ms；插件直连 observe warm 9ms、session.start 144ms、read 5ms、截图 194ms。
- **仍是运行时下限**：CLI 冷启动 72–86ms（Node 运行时）、视口截图 358ms、CLI 会话启动 367ms。
- **质量**：单测 955、CLI 155、MCP 10、DSH 插件 26、插件直连冒烟 11/11、Node/Python SDK 8/8、真实 Edge E2E 141/143（2 项按借用确认策略跳过）、protocol-check 全绿。

## 1. 形态

| 层 | 实现 |
| --- | --- |
| CLI | `bridge`，Node 零依赖，热命令按需加载，daemon 快路径 |
| daemon | 单进程 HTTP `/rpc` + WS 扩展接入；意图账本、会话状态、审计、更新 |
| 扩展 | MV3，CDP 常驻驱动（attach-once + 75s 空闲软分离 + 焦点仿真） |
| 协议 | 1.9（minor 偏斜、`protocolSkew`、能力位 `unverified`/`dom-read`） |
| 接入 | MCP 51 工具、DSH 插件 35 工具、Node/Python SDK |
| 观察 | page-lib VOM + AX 合并 + DOMSnapshot 事实（几何/可见性/表单/表格/绘制/阻挡层）+ AX 兜底 |

## 2. 已实现能力

| 能力 | 说明 |
| --- | --- |
| 观察 | `observe` 语义树 + `@eN` ref；`--vom` 结构化节点；`--ax` AX 树；`--facts` DOMSnapshot 事实 |
| 事实层 | 几何/可见性/`domClickable`/`domPaintOrder`；表单值（密码遮蔽）与 `formStateStale`；表格 `row/col/header`；`blockingLayers`/`underBlockingLayer` |
| 无 ref 元素 | `unmappedAx` + `click-backend`（可见性/遮挡检查 + CDP 原生事件） |
| 观察降级 | page-lib 失败自动 AX 兜底；`--pipeline ax` 独立 AX 采集器；`--compare-ax` 双跑诊断 |
| 动作 | click/hover/focus/blur/fill/select/press/drag/wheel/scroll-to，trusted/force/expect/depends-on |
| 数据 | read/get-html/extract、snapshot、screenshot（视口/整页/元素/区域/标注/拼接） |
| 会话 | prepare/claim/cancel、`session.start_tracked` + token 幂等、read 文档身份护栏 |
| 证据 | `effect_state`（committed/none/unknown）、意图账本、操作审计、Trace |
| 协作 | pause/resume、cooperate sync/wait/handback、request-help 完成条件轮询 |
| 调试 | 网络/控制台/性能、规则与重放、重复请求、证据包、video、record |
| 接入 | MCP 51、DSH 插件 35、Node/Python SDK；插件高频工具直连 daemon |

## 3. 9 站性能（050g）

| 指标 | 数值 |
| --- | --- |
| 导航中位 | 1166 ms |
| 观察中位 | 186 ms |
| 验证型脚本中位 | 156 ms |
| `--unverified` | 156 ms |
| 视口截图中位 | 358 ms |
| 会话启动中位 | 367 ms |
| 任务级 Bing 搜索 | 2271/2382 ms |

常驻路径实测：

| 路径 | 数值 |
| --- | --- |
| MCP observe | 12 ms |
| 插件直连 observe | warm 9 ms |
| 插件直连 session.start | 144 ms |
| 插件直连 read | 5 ms |
| 插件直连 focus | 27 ms |
| 插件直连截图 | 194 ms |
| 插件直连 tab.list / window.list | 14 ms / 4 ms |

观察管线双跑（`--compare-ax`）：9 站视口内交互元素覆盖率中位 **0.970**，AX 管线中位 139ms vs page-lib 76ms，因此 page-lib 仍是默认采集器。原始数据 `.tmp-bench/out-compare050b/`。

## 4. 关键实现

1. **CDP 常驻驱动**：按 tab attach 一次、75s 空闲软分离、长任务租约；并发 attach 合并，避免竞态。
2. **焦点仿真**：`Emulation.setFocusEmulationEnabled`，可信输入在后台 Agent 窗口直接派发。
3. **DOMSnapshot 事实管线**：几何/可见性/表单/表格/绘制/阻挡层；`data-bb-vom` 直接映射，省掉一次 `DOM.getDocument`。
4. **证据与所有权**：`effect_state`、read 文档身份护栏、请求 token + prepare/claim/cancel + 插件 journal 孤儿回收。
5. **插件直连 daemon**：读 `daemon.json` + token POST `/rpc`；业务错误不重试，避免动作重复执行。

## 5. 质量与回归

| 套件 | 结果 |
| --- | --- |
| 单测 | 955/955 |
| CLI selftest | 155/155 |
| MCP selftest | 10/10 |
| DSH 插件 selftest | 26/26 |
| 插件直连冒烟（真实 Edge） | 11/11，0 次 CLI 回退 |
| Node SDK / Python SDK | 8/8 / 8/8 |
| 真实 Edge E2E | 141/143（2 项按借用确认安全策略跳过） |
| protocol-check | 全绿 |

E2E 覆盖：观察事实、表单、表格、阻挡层、AX 兜底、closed shadow + click-backend、对话框、上传/下载、网络/调试/规则/重放、视频/录制/长截图、iframe/shadow、plan/step/recipe、人工协作、可信输入反爬、daemon 重启恢复、扩展 UI 等。

## 6. 剩余方向

| 方向 | 现状 | 计划 |
| --- | --- | --- |
| CLI 冷启动 | 72–86ms（Node 运行时） | 以 MCP/插件常驻为主路径；原生 thin client 暂缓 |
| 视口截图 | 358ms（CDP 编码下限） | 保持现状，必要时评估截图契约 |
| CLI 会话启动 | 367ms | MCP/插件直连已到 144/163ms |
| `--unverified` | 156ms | 常驻路径可到 20ms |
| 观察主遍历 | page-lib 仍为主 | 用 `--compare-ax` 持续量化，再决定是否替换 |

## 7. 复现

```powershell
node --test tests/unit/*.test.mjs                 # 955
node tests/cli/selftest.mjs                       # 155
node tests/mcp/selftest.mjs                       # 10
node tests/plugin/selftest.mjs                    # 26
node tests/plugin/smoke.mjs                       # 11（需 BB_SMOKE_BROWSER=<instanceId>）
node tools/protocol-check.mjs                     # 全绿
$env:BB_E2E_SYNC_DOCS='0'; node tools/e2e.mjs     # 141/143
```

## 8. 相关文档

- [功能矩阵](FUNCTION-MATRIX.md)
- [协议](PROTOCOL.md)
- [运行时决策](RUNTIME-DECISION.md)
- [9 站实测](SITE-BENCH-BRIDGEDECK-1.9.md)
- [发布说明](releases/0.1.2.md)
