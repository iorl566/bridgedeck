# FASTPATH-B-E2E-REPORT：快路径 B 黄金扩面 + iframe/OOPIF 评估

状态：**task-131 已执行**（2026-11-24，一次性内部证据）。只改测试与文档；0.3.0 冻结、未改产品代码、未改 `dist/` 与 `D:\CTRM自动录入`、未装依赖、未跑阶段门。
证据脚本：[0.4/tests/fastpath-b-e2e.mjs](../0.4/tests/fastpath-b-e2e.mjs)（task-127 golden 基线 + task-131 形态扩面；默认 `--runs 2`）。
上一篇方案评估：[FASTPATH-SPIKE-B.md](./FASTPATH-SPIKE-B.md)。

环境：Windows；Edge **158.0.4370.33**（真实 headed Edge + MV3 extension-ingress staging + 真实 daemon）；Node **v24.21.0**；真实本地 HTTP 夹具（主 origin `127.0.0.1:<随机端口>` + 跨源 origin `localhost:<随机端口>`）。
运行命令与结果：`node 0.4/tests/fastpath-b-e2e.mjs --runs 2` → **两次运行都 PASS（190/190 checks）**，`summary.ok=true / stable=true`，单次运行约 10.7–10.9 s。

---

## 0. 结论摘要

**一句话：B 在 task-127 golden 夹具上仍逐字节等价且页面侧零提取命令；扩到 9 个页面形态后发现 4 类必须登记的边界——①表单页 B 有可选字段语义增量（placeholder/href 徽标 + 敏感值掩码长度消失）②重复 id 页 B 的 ref 比 A 更正确（语义变更）③深层 shadow / 同源 iframe（带 refs）B 如实回退 A（安全但无收益）④collector 默认 `includeIframes=false` 时 B 会静默丢失 A 可见的同源 iframe 内容（内容缺口）。因此：GO（保留 opt-in），NO-GO（默认开启 / 逐字节 drop-in 宣传）。OOPIF 在 A/B 两侧都是 0 覆盖（实测子帧是独立 target 且没有 collector 注入），建议单列 v2。**

| 判定 | 内容 |
| --- | --- |
| **GO（opt-in 保留）** | 扩面没有发现“B 服务时输出错误文本”：不泄漏敏感值；B 服务的形态 ref 要么与 A 等价、要么更正确（重复 id）；B 回退时文本与 A 逐字节一致。 |
| **NO-GO（默认开启 / 逐字节 drop-in）** | 至少先处理 4 项：①`includeIframes` 默认值与 A 对齐（A 总是覆盖同源 iframe，B 默认 `false` 会静默丢内容）②`frameId`/`frame` 字段名不一致导致 cross-frame 安全阀永不触发 ③`>>frame>>` 不可寻址（同源 iframe 带 refs 恒回退）④B 的语义增量（placeholder/href 徽标、敏感值不输出 `[redacted](len=N)`、重复 id 的 ref 修正）需要产品登记。 |
| **OOPIF** | A/B 都 0 覆盖（与 FASTPATH-SPIKE-B §3.5 一致）；实测 Edge 站点隔离下真出现 `type:'iframe'` 独立 target，且子帧里没有 collector（`all_frames:false`）。覆盖成本 +2~4 人日，建议 v2。 |
| **性能** | B 收益与页面规模正相关：1000 节点页 observe p50 −16%、snapshot p50 −35%；小预算截断 observe p50 −27.6%。小页面 B 略慢（+0.2~1.6 ms，一次扩展往返的预期成本）。 |

---

## 1. 测量方法

- 一条**真实浏览器会话**：脚本自己构建 MV3 扩展 staging（真实 wsUrl/token/instanceId）→ headed Edge `--load-extension` → daemon（HTTP + WS ingress）→ `session.open` → `session_start` + `tabBorrow` 把该 tab 移入 Agent Window 并激活。
- 三条只读路径在同一 target 上对比：
  - **A**：纯 CDP（`createSnapshotHandlers({cdp})`，懒解析 ref）；
  - **off**：`fastpathB:false`（注入 treeProvider 但开关关闭，用于证明“默认关闭零变化”）；
  - **on**：`fastpathB:true` + session 绑定的 `ext.collect` treeProvider（与 daemon 生产接线同构）。
- 每个形态：导航同一标签页 → off/on 各 **5 次 observe + 5 次 snapshot**（共 10 样本/配置）→ A 各 1 次基线。比较 **text（逐字节）/ ref 多重集 / 敏感脱敏 / cursor（`next_cursor`）/ 命令数（`Runtime.evaluate`、`DOM.*`）/ p50 / p95**。
- B 是否真的服务：on 路径每样本的 `Runtime.evaluate` 计数（0 = B 服务；≥1 = 适配器回退 A）。B 未服务时脚本**额外重放一次** `renderCompactTree` 取回退 `reason`（只读重放，不改输出），报告里如实区分 `shadow-unsupported` / `ref-resolution-failed` 等。
- 夹具设计沿用 task-127 的约束：可见语义放 `aria-label`，让 CompactTree 与 CDP 提取的逐节点 token 成本一致；有意保留的少数“可选字段差异”显式断言（见 §6）。
- 夹具端口每轮随机（`:0`）；B 的 href 徽标会把绝对 URL 写进文本，因此**跨轮稳定性**比较用归一化 sha（`http://127.0.0.1:<port>` / `http://localhost:<port>` → `http://fixture.invalid`）；同一轮 on/off 比较仍用原文。
- 并发守卫：开跑前确认没有其他真实浏览器 E2E；本次两次运行均 `concurrent=0`（wait 443 / 450 ms）。

---

## 2. 基线 golden（task-127 夹具未改，回归确认）

同一页面（表单/checkbox/link/open shadow/140 行长列表）、同一标签页、`max_tokens=1200`、`page_size=100`：

| 指标 | 值 |
| --- | --- |
| text | **3684 B / 86 行 / 86 refs**，on/off/A 逐字节相同，sha256 `df30ff522eabd633a10eb877cac06ebc220628fe6534794902c1e50948a94080` |
| ref 集合 / `ref_count` / `truncated` | on === off === A（86 / 86 / true） |
| 脱敏 | 含 `[redacted]`；`sk-live-…` 明文绝不出现在文本；空 password 不产生伪造 `len=` 后缀 |
| 命令（10 次调用合计） | off：`Runtime.evaluate=10`，`DOM.querySelector=1045`，`DOM.describeNode=1045`，total **2110**；on：`Runtime.evaluate=0`，query/describe 相同，total **2100** |
| p50 / p95（run1） | observe off **32.21 / 39.54 ms** → on **32.21 / 64.47 ms**；snapshot off **27.34 / 38.30 ms** → on **26.14 / 26.99 ms** |
| daemon 真实 observe（session 绑定） | 5/5 文本与 off 基线逐字节相同；session CDP `Runtime.evaluate=0`；`ext.collect` 5 次全部带 `session_id`；p50 **16.23 / 28.90 ms**（p50/p95） |

→ task-127 的结论未被扩面改动（脚本保留原断言，190 项检查含原有 106 项 + 新增 84 项）。

---

## 3. 形态扩面结果（run1；run2 结论一致）

9 个形态，每配置 10 样本（5 observe + 5 snapshot）。`served` = B 是否真的服务；`fallback` = 回退 A。命令数为 10 次调用合计；p50/p95 单位 ms。

| # | 形态（页面特征） | B 服务 | 文本 on vs off | refs | cursor | off→on 命令（evaluate / query / total） | p50 observe off→on | p50 snapshot off→on | 结论 |
| - | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **表单**（input/textarea/checkbox/select/disabled/placeholder/href/password 值） | ✅ served | **不同**（412→473 B，10→10 行） | 10 = 10，唯一 10/10 | null = null | 10→**0** / 110→100 / 240→210 | 4.02 → 4.26 | 3.04 → 3.79 | 已知语义增量（§6.1），非泄漏 |
| 2 | **open shadow 深层**（两层 shadow，落地行） | ❌ fallback `shadow-unsupported` | 相同（187 B / 5 行） | 2 = 2 | null = null | 10→10 / 40→60 / 100→150 | 2.28 → **6.43** | 2.84 → 5.24 | 回退安全；B 每次多 1 次 A 提取（无收益） |
| 3 | **同源 iframe**（`includeIframes=true`，带 refs） | ❌ fallback `ref-resolution-failed` | 相同（183 B / 5 行） | 2 = 2 | null = null | 10→10 / 40→90 / 100→180 | 2.69 → **9.01** | 3.14 → 8.13 | `>>frame>>` 不可寻址 → 回退（§4） |
| 4 | **同源 iframe**（collector 默认 `includeIframes=false`） | ✅ served | **不同**（183→87 B，5→2 行） | 2 = 2 | null = null | 10→**0** / 40→20 / 100→50 | 2.67 → 3.19 | 2.77 → 3.35 | **静默丢子帧内容**（缺口，§4.3） |
| 5 | **同源 iframe**（`includeIframes=true`，`vom_refs:false`） | ✅ served | **相同**（167 B / 5 行） | 0 = 0 | null = null | 10→**0** / 0→0 / 10→0 | 10.29 → **2.03** | 1.41 → 3.28 | B 的 iframe 提取语义可用（§4.2） |
| 6 | **1000 节点长列表** | ✅ served | **相同**（3437 B / 80 行 / 80 refs） | 80 = 80 | `vom:80:1200` = 同 | 10→**0** / 1045→1045 / 2110→2100 | 59.63 → **50.07**（−16%） | 65.31 → **42.13**（−35%） | 等价 + 更快 |
| 7 | **小预算截断**（同页，`max_tokens=60`） | ✅ served | **相同**（169 B / 4 行；两边 `truncated=true`） | 4 = 4 | `vom:4:60` = 同 | 10→**0** / 55→55 / 130→120 | 41.04 → **29.73**（−28%） | 39.96 → **27.94**（−30%） | 等价 + 更快 |
| 8 | **重复 id**（3 个元素共用 `id="dup"`） | ✅ served | **不同**（仅 `bn<id>` 不同；归一化后逐字节相同） | **5 = 5，但唯一数 3 vs 5** | null = null | 10→**0** / 40→50 / 100→110 | 2.61 → 3.57 | 2.15 → 3.86 | B 的 ref 更正确（已知语义变更，§6.2） |
| 9 | **跨源 iframe（OOPIF）** | ✅ served | **相同**（89 B / 2 行；两边都看不到子帧内容） | 2 = 2 | null = null | 10→**0** / 40→20 / 100→50 | 2.32 → 2.91 | 2.20 → 3.14 | A/B 都是 0 覆盖（§5） |

p95 补充（run1，off→on，ms）：长列表 observe 96.54→79.45、snapshot 71.22→70.45；小预算 observe 41.42→31.95、snapshot 45.56→30.35；`iframe-no-refs` observe 25.93→11.62；深层 shadow observe 3.87→8.60。**p95 噪声区**：form snapshot off 的 93.33 是单样本离群（run2 同配置 3.38/3.99 正常），不作为性能结论。

样本与稳定：每形态每配置 10 样本齐全；两次运行 9 个形态的 on/off 文本归一化 sha 全部一致；形态页文本没有随机内容（除夹具端口）。

---

## 4. 同源 iframe：B 的实际差异

### 4.1 CompactTree 的 iframe 覆盖是真实的

`ext.collect({includeIframes:true})` 在同一页面上返回 **5 个 `>>frame>>` 子帧节点**（主文档 10 节点）：
- 子帧节点名：`子帧标题` / `子帧按钮` / `子帧输入`；
- path 形如 `html > body:nth-of-type(1) > iframe:nth-of-type(1) >>frame>> html > body:nth-of-type(1) > div:nth-of-type(1)`；
- 子帧坐标已合成外层 iframe 偏移（子节点 y ≥ iframe 自身 y；实测 iframe `{x:16,y:36,w:360,h:140}` → 子帧 `{x:16,y:36,w:752,h:105}`）。
- `includeIframes:false`（collector 默认）→ **0 个**子帧节点。

### 4.2 带 refs：B 回退 A（安全，无收益）

`on` 路径 10/10 样本都有 `Runtime.evaluate`，即 **B 全部回退 A**；重放 `renderCompactTree` 得到 `reason: ref-resolution-failed`，`unresolved=3`，样本：

```
html > body:nth-of-type(1) > iframe:nth-of-type(1) >>frame>> html > body:nth-of-type(1) > div:nth-of-type(1)
html > body:nth-of-type(1) > iframe:nth-of-type(1) >>frame>> html > body:nth-of-type(1) > button:nth-of-type(1)
html > body:nth-of-type(1) > iframe:nth-of-type(1) >>frame>> html > body:nth-of-type(1) > input:nth-of-type(1)
```

根因（代码级）：`compactTreeToVomNodes` 只把含 `>>>` 的 path 排除出 `domPath`（shadow 路径），`>>frame>>` 不匹配 → 被当成主文档 CSS 选择器 → `DOM.querySelector` 必然失败 → 落地行 ref 解析失败 → 整次回退。**代价**：每样本比 off 多 1 次 `Runtime.evaluate` + 约 5 条 DOM 命令（total 100→180），p50 observe 2.69→9.01 ms。文本与 A 逐字节一致（183 B / 5 行，refs 2=2）。

### 4.3 默认 `includeIframes=false`：B 静默丢内容（缺口）

同一页面、B 用 collector 默认值：B 真的服务（10/10 零 evaluate），但结果的文本 **183 B / 5 行 → 87 B / 2 行**，首个差异行 2：

```
off: - heading "子帧标题"
on : - heading "同源 iframe 页面尾部"
```

即 A/off 能看到同源子帧内容，B 默认配置直接没有——没有回退、没有标记，属于**静默内容丢失**。若 B 要默认开启或作为 drop-in，必须把 provider 的 `includeIframes` 与 A 的覆盖面（同源 iframe 总是可见）对齐；否则应在能力里明确声明不支持 iframe 并强制回退。

### 4.4 `vom_refs:false`：B 的提取语义与 A 逐字节一致

同一页面、`includeIframes=true`、`vom_refs:false`：B 服务 10/10，文本与 A **逐字节相同**（167 B / 5 行），且 p50 observe 10.29→2.03 ms（A 每次要跨文档访问子帧）。→ **差距只在 ref 寻址（adapter 仅主帧），不在提取语义。**

### 4.5 代码级安全阀问题

`tree-render.js` 的 cross-frame 检查读 `node.frameId`，而 `extension-ingress/content/collect.js` 只输出 `node.frame`（字符串，值为 iframe 元素 path），不输出 `frameId`。因此 **cross-frame 安全阀对 collector 输出永不触发**；当前唯一保护是 `>>frame>>` 被当作非法选择器导致 `ref-resolution-failed` 回退。修复建议：collector 增补 `frameId`（或 tree-render 改用 `frame` 字段判定），并把 `>>frame>>` path 排除出主文档 `domPath`。

---

## 5. OOPIF / 跨源 iframe

- 主页面同源（`127.0.0.1`），子帧来自 `http://localhost:<port>`（跨源）。Edge 158 默认站点隔离下，`Target.getTargets` 实际出现 **1 个 `type:'iframe'` target**：`http://localhost:<port>/shape/cross-child`。
- 主帧 collector（`includeIframes=true`）：**0 个** frame 节点；A 的提取同样 0；on/off 文本逐字节一致（89 B / 2 行），都不含子帧标记 `跨源子帧标题`。
- 附加到该 iframe target 后检查：`typeof globalThis.__bb04Collect` = **undefined** → 子帧没有 collector（MV3 内容脚本 `all_frames:false`，只注入主帧）。
- 结论：**A 与 B 对 OOPIF 都是 0 覆盖（不回归，但相对 0.3 的 `all_frames` 是能力缺口）**。B 若要覆盖需要：`Target.setAutoAttach` 生命周期 + 逐帧隔离世界注入 + 帧内坐标几何合成（FASTPATH-SPIKE-B §3.5 估 +2~4 人日）。建议 v2 单列，不塞进 B 的首个里程碑。

---

## 6. 已知差异登记（必读）

### 6.1 表单页：B 的可选字段语义增量（不是逐字节等价）

同一表单页（`text/textarea/checkbox/select/disabled/placeholder/href/password`），off（A）412 B / on（B）473 B，**ref 多重集 10=10 一致**，差异只有三类，全部在 B 的“可选语义字段”上：

1. B 输出 `[placeholder: "you@example.test"]` 徽标（A 不输出；A 的提取白名单没有 placeholder）；
2. B 输出 `[→ http://127.0.0.1:<port>/docs/help]` 链接箭头（A 不提取 href）；
3. A 对 password 值输出 `= "[redacted]" (len=31)`；B 的 collector 把敏感值置空并标 `sensitive:true`，渲染器没有值可输出 → **B 文本没有 `[redacted]`/`len=` 后缀**。两边都**不泄漏**明文（断言：`sk-live-…` 不出现在任一侧）。

判定：属于 B 的信息增量/呈现差异，不是安全缺陷；但**破坏“逐字节 drop-in”**，需要产品登记（或把这几项用开关隔离）。

### 6.2 重复 id：B 的 ref 更正确（已知语义变更）

三个元素共用 `id="dup"`（两个 `span[role=link]` + 一个 `button`）：
- off/A：`#dup` 选择器把落地的 5 行解析成**只有 3 个唯一 backendNodeId**（1 个 ref 重复出现在 3 行），复现了 FASTPATH-SPIKE-B §3.1 登记的既有 bug；
- on/B：path 用 `nth-of-type` 直接寻址真实元素 → **5 个唯一 ref**；
- 文本：仅 `bn<id>` 不同（把 `bn<id>` 归一化后逐字节一致），188→188 B、5→5 行、cursor 一致。
- 判定：B 更正确，但这是**输出语义变更**（FASTPATH-SPIKE-B G12 “待产品决策”），默认开启前必须拍板“接受差异/回退 domPath/登记”。

### 6.3 深层 shadow：落地即回退（无 pierce seam）

两层 open shadow 的 heading/button 落在渲染窗口内 → `renderCompactTree` 返回 `shadow-unsupported`（`unresolved=3`，样本 path 为 `… >>> div:nth-of-type(1) >>> button:nth-of-type(1)`），B 回退 A。文本一致（187 B / 5 行），但**每次 on 调用比 off 多约 5 条命令、p50 2.28→6.43 ms**——回退是安全的，只是白付一次 B 尝试成本。

### 6.4 其它

- 同源 iframe 见 §4；OOPIF 见 §5。
- B 回退是“静默”的：观测调用方只看到 A 的输出，无法从结果区分“B 生效”还是“B 回退”。若需要灰度可观测性，建议 daemon 暴露快路径命中/回退计数（本轮未改产品代码）。

---

## 7. 稳定性与清理

- **两次独立运行**：`status=pass/pass`，`checks=190/190`（两次）；`summary: mode=summary, ok=true, stable=true`；主 golden text sha256 两次一致；9 个形态的 on/off 文本归一化 sha 两次一致；每形态每配置 5 次样本齐全。
- 并发守卫：两次运行 `concurrent=0`（等待 443 / 450 ms）；脚本在检测到其他真实浏览器 E2E 时会等待（最多 60 s）后拒绝启动（BLOCKED），不抢占别人的浏览器。
- 脚本自身清理：`session_stop`/`session_close`、CDP 通道、daemon、浏览器进程树、staging 扩展副本、临时目录全部移除（`cleanup.*` 全为 true）。
- **仓库根日志清理**：删除仓库根 **21 个 `.tmp-b6-*.log`**（`.tmp-*` 已被 `.gitignore` 忽略；本次只删 `.log`）。按任务写域**保留**：`.tmp-b6-gate-summary.txt`、`.tmp-b6-retry-summary.txt`（非 `.log`）、11-16 旧 `.tmp-*` 用户文件、`.tmp-bench/`。
- 本轮证据日志写在 `%TEMP%`（未入仓，脚本不产生仓库内日志）。

---

## 8. go / no-go 与建议

**GO（opt-in 保留）**：
- 扩面未发现“B 服务时输出错误文本”：敏感值不泄漏；能服务的形态 ref 要么等价、要么更正确；回退形态文本与 A 逐字节一致。
- 规模收益真实：1000 节点页 observe p50 −16% / snapshot p50 −35%（80 行落地、80 refs）；小预算截断 observe p50 −27.6% / snapshot p50 −30.1%；同源 iframe + `vom_refs:false` 时 observe p50 10.29→2.03 ms。

**NO-GO（默认开启 / 逐字节 drop-in）**，开启前必做（按优先级）：
1. **iframe 覆盖面与默认值对齐**：B 默认 `includeIframes=false` 会静默丢 A 可见的同源 iframe 内容（§4.3）——要么默认 `true` 并接受“带 refs 时回退”，要么显式声明不支持 iframe 并强制回退。
2. **`>>frame>>` 可寻址或前置拒绝**：当前带 refs 的同源 iframe 恒回退，且回退前白跑一次 B（§4.2）；同时修 `frameId`/`frame` 字段名不一致导致的 cross-frame 安全阀失效（§4.5）。
3. **语义增量登记**：表单 placeholder/href 徽标与敏感值掩码长度差异（§6.1）、重复 id 的 ref 修正（§6.2）——需要产品决策/开关，不能作为“逐字节等价”宣传。
4. 若 v1 只承诺“主帧 + open shadow”：shadow 落地即回退是可接受的诚实降级，但要在能力里写明“shadow 页无加速，且每次多付一次 B 尝试成本”（§6.3）。

**OOPIF**：不进入 B v1；按 FASTPATH-SPIKE-B §3.5 单列 v2（+2~4 人日）。

---

## 9. 测量限制

1. 本机仍有用户 Edge 与其它 agent 进程负载；p95 噪声明显（form snapshot off p95 93.33 为单样本离群，run2 同配置 3.38/3.99）。p50 与命令数是本文主要结论依据。
2. 夹具是受控页面（`aria-label` 语义、无伪元素/动画/虚拟滚动/closed shadow）；真实站点混合度更高，差异面只会更大。
3. 形态页跨轮 sha 只消除了随机端口；其余文本确定。`form` 的 B 文本含 href 绝对 URL，因此报告给出的是归一化 sha 稳定、原文 sha 随端口变化的事实。
4. 只跑了该 E2E：真实 headed Edge、opt-in、不在默认门禁；未跑阶段门、未改产品代码、未改 0.3.0 / `dist/` / `D:\CTRM自动录入`、未装依赖。
5. 「B 是否服务」由命令计数与只读重放推断；脚本不修改产品代码，因此没有直接向 daemon 索取回退计数器。
6. **并发浏览器测试会污染证据**：首轮尝试曾检测到另一个真实浏览器 E2E（并发守卫等待 22 s）后继续跑，该次「重复 id」形态出现 10/10 样本全部回退（重放诊断当时尚未前移，未留下 reason）；清空并发后连续 4 次运行（3 次开发 + 最终 2 连跑）该形态都稳定由 B 服务并纳入证据。并发负载下 B 的行为没有做系统测量 —— 这是本报告所有性能/回退数字必须在“独占浏览器”前提下复现的原因。
7. **本轮 harness 自身修正**（fix 后才有最终证据）：① 早期导航探针用「双 rAF promise + awaitPromise」，后台/失焦标签页的 rAF 可能被暂停，导致 CDP 命令 30 s 超时（曾使单次运行从 ~11 s 膨胀到 ~97 s）；改为同步读 `document.readyState` + 120 ms 稳定等待。② 跨轮稳定性最初直接比文本 sha，把夹具随机端口写进 B 的 href 徽标误报成“不稳定”；改为端口归一化 sha（同轮 on/off 仍比原文）。③ 形态证据与回退 reason 在断言失败时也必须留存：证据先入列再断言，`reason` 无条件重放采集。

---

## 10. 复现

```
node 0.4/tests/fastpath-b-e2e.mjs --runs 2      # 两次完整运行（稳定性）；退出码 0=PASS/1=FAIL/2=BLOCKED
node 0.4/tests/fastpath-b-e2e.mjs --runs 1      # 单次；开发调试
node 0.4/tests/fastpath-b-e2e.mjs --keep        # 保留 staging/临时目录排障
```

- 报告 JSON：每轮 `report.shapes[*]`（各形态 text/refs/cursor/truncation/sensitive/commands/latency/B 服务与回退 reason）＋ `report.iframe`（同源 iframe 实态 + OOPIF target/注入实态）＋稳定汇总行（`mode:"summary"`，含每形态归一化 sha、p50）。
- 脚本位置：[0.4/tests/fastpath-b-e2e.mjs](../0.4/tests/fastpath-b-e2e.mjs)；夹具与形态页定义在同文件（`fixtureHtml` / `shape*Html` / `SHAPES`）。
- 相关实现：[content/collect.js](../0.4/extension-ingress/content/collect.js)（`includeIframes`/`>>frame>>`）、[tree-render.js](../0.4/packages/browser-adapter/src/tree-render.js)（`MAX_COMPACT_NODES=500`、`domPath` 只排除 `>>>`、`frameId` 阀）、[snapshot-handlers.js](../0.4/packages/browser-adapter/src/snapshot-handlers.js)（回退语义）。
