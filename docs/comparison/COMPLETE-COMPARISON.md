# BSK 0.5.0 vs BridgeDeck 0.3.1 — 完整比对结果（2026-11-27）

> 三轮实测：确定性 E2E（8 项）→ 真实公开网站（6 项）→ DemoQA 进阶功能（5 项）。
> 两个工具各自独立 Edge profile + 扩展 + daemon，顺序执行同一组动作，断言看页面结果。
> 原始数据：`docs/comparison/runs/2026-11-27-full`、`2026-11-27-web`、`2026-11-27-web2`；复跑：`2026-11-27-rerun`。

## 总览

| 轮次 | 内容 | BSK 0.5.0 | BridgeDeck 0.3.1 |
| --- | --- | --- | --- |
| 1. E2E | 夹具页 8 项（打开/填表/提取/截图/closed shadow/对话框/上传/多行表头） | **7/8** | **8/8** |
| 2. Web | 真实网站 6 项（example/httpbin/Learn/MDN/商店页） | **3/6** | **6/6** |
| 3. Web2 | DemoQA 5 项（确认框/上传/表单/动态等待/移动仿真） | **1/5** | **5/5** |
| **合计** | 19 项 | **11/19（58%）** | **19/19（100%）** |

## 轮次 1：E2E（确定性夹具页）

| 任务 | BSK | BridgeDeck |
| --- | --- | --- |
| T1 打开 + 读结构 | ✅ 1034ms | ✅ 937ms |
| T2 填表 + 提交 + 回读（5 步） | ✅ 1059ms | ✅ 1461ms |
| T3 基础表格提取 | ✅ 119ms | ✅ 186ms |
| T4 视口截图落盘 | ❌ 写盘被拒（os error 5） | ✅ 295ms |
| T5 多行表头提取 | ✅ 93ms | ✅ 184ms |
| T6 closed shadow 点击 | ✅ 462ms | ✅ 502ms |
| T7 原生 confirm | ✅ 481ms | ✅ 754ms |
| T8 文件上传 | ✅ 314ms | ✅ 407ms |

结论：静态页 BSK 在速度上占优（`extract` 快约 1.5–2 倍，来自原生二进制启动 + VOM 更紧凑）；BridgeDeck 功能面 8/8，截图在受限环境可用。

## 轮次 2：真实公开网站

HN/Wikipedia 在本机不可达（curl 000），实际使用：example.com、httpbin.org、learn.microsoft.com、MDN、Edge 加载项详情页。

| 任务 | BSK | BridgeDeck |
| --- | --- | --- |
| W1 读取标题（example.com） | ✅ 864ms | ✅ 1423ms |
| W2 点击跳转（example → iana.org） | ✅ 1130ms | ✅ 1627ms |
| W3 填表并 POST（httpbin） | ✅ 1372ms | ✅ 2416ms |
| W4 整页截图（Learn） | ❌ strict observation 失效 | ✅ 4.1s / 1.21MB |
| W5 滚动 + 键盘（MDN） | ❌ strict observation 失效 | ✅ 3718ms |
| W6 读商店页（Edge 详情） | ❌ `cdp_failed: Not allowed` | ✅ 3554ms |

## 轮次 3：DemoQA 进阶功能

| 任务 | BSK | BridgeDeck |
| --- | --- | --- |
| X1 原生 confirm（`#confirmButton`） | ❌ dialog_pending 后 strict 观察失效 | ✅ 32.3s |
| X2 文件上传（`#uploadFile`） | ❌ 上传成功后读取被权限拦 | ✅ 31.6s |
| X3 表单填写并提交 | ❌ 填完后读取被拦 | ✅ 24.9s |
| X4 动态元素等待（5s） | ✅ 1.4s | ✅ 30.9s |
| X5 移动仿真 + 截图 | ❌ 截图写盘失败 | ✅ 25.6s |

> DemoQA 打开本身很慢（每页 25–33s，广告/分析脚本多），两边的 X 项耗时都被它拉长；通过与否看的是动作与断言，不是绝对秒数。

## BSK 的失败模式（实测归纳）

1. **strict observation 模型**：每个动作前要求一次未使用过的 `cooperate sync` 观察；页面一渲染变化就报 `The strict observation changed` / `A page frame changed`，动态页（MDN、Learn、DemoQA、商店页）几乎无法连续操作。
2. **`evaluate` 被严格限制**：同样的页面状态查询 BSK 返回 `permission_denied` 或 `cdp_failed`，只能用 `read/extract` 这类被动查询替代。
3. **操作串行化等待**：连续动作过快会回 `Previous operation is still settling`，需要额外 sleep 重试。
4. **截图/落盘**：daemon 侧写盘在本机沙箱被拒（`os error 5`），截图类能力在受限环境不可用。
5. **选择器时序**：页面刚加载时 CSS 选择器可能匹配不到（需先 observe/sleep）。

## BridgeDeck 的优势与代价

- 优势：target 策略 + 默认 `domcontentloaded` + ref 失效自动重观察，连续动作在动态页上 19/19 全过；截图走扩展下载落盘可用；`click --accept-dialog` 一步处理确认框。
- 代价：Node CLI 冷启动 ~123ms（BSK 原生 ~20ms），静态小任务上慢 0.3–1.2s；本轮已把冷启动从 156.5ms 降到 123ms、`extract` 从 211–289ms 降到 174–186ms。

## 本轮已实现的提升（对应上一轮对比结论）

1. `navigate`/`open` 默认 `domcontentloaded`（重页面不再 60s 卡死，Learn 实测 5.0s→2.8s）；
2. `extract` 提速：懒加载 7 个模块，冷启动 156.5→123ms，extract 211–289→174–186ms；
3. ref 失效默认自动重观察一次（`--heal=false` 关闭）；
4. `click --accept-dialog` 一步式确认框；
5. 截图失败带 `data.reason=capture|write`。

回归：CLI selftest 404/404 PASS；E2E 8/8；三轮 web/web2 数据见上方。

## 复现

```powershell
node tools/compare/run.mjs --tool bsk|bridge --run docs/comparison/runs/<id> --phase e2e|real|web|web2
node tools/compare/report.mjs --run docs/comparison/runs/<id>
```
