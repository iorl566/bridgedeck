# FASTPATH-SPIKE-B：方案 B（页内紧凑提取）原型实测

状态：一次性内部评估（spike）。**不改产品代码、不装依赖、不跑阶段门、不写 dist 与 `D:\CTRM自动录入`**；0.3.0 冻结；0.3 `injected/page-lib.js` 只作为设计参考，未复制代码或文案。
评估对象：方案 B = **页内 content script 预提取 + 单次消息**。本 spike 的 B 与 `FASTPATH-SPIKE.md` §5 的“整套 page-lib 平移”不同：**页内只做紧凑提取，渲染仍在 daemon 侧用 0.4 现有 `vom/src/render.js`**。原型代码写于 `%TEMP%`，跑完已清理（不入仓）。
测量日期：2026-11-24；浏览器 Edge 158.0.4370.33（headless=new）；Node v24.21.0；Windows。

---

## 0. 结论摘要

**一句话：B（页内紧凑提取 + daemon 侧 0.4 渲染器 + 懒 ref 映射）能拿到 0.3 级提取延迟（2.8 / 5.7 / 5.8 ms p50）与 −83% 的 CDP 字节，并且 text 与 0.4 现状逐字节相同、节点字段零差异；不需要移植 150 KB 渲染管线。剩下的唯一硬成本是 ref 语义：保留 `bn<backendNodeId>` 就要在 observe 时回填（+9~15 ms、+130~135 KB），或改成“页内句柄 ref + 动作时解析”（每次动作 2 条命令 / 0.54 ms）。**

| 场景（页面） | 现状（pre-A 全量预解析）p50/p95 | A（0.4 当前，懒解析 ref）p50/p95 | **B-提取（无 ref）p50/p95** | **B-整链（含 ref 映射）p50/p95** | 0.3 页内 observe（参考，来自 FASTPATH-SPIKE.md） |
| --- | --- | --- | --- | --- | --- |
| `tests/fixtures/test.html`（151 节点 / 103 refs） | 24.5 / 54.0 ms | 22.7 / 42.8 ms | **2.8 / 3.4 ms** | 12.2 / 50.3 ms | 2.7 / 3.6 ms |
| 1000 行合成页（3006 元素 / 500 节点 / 109 refs） | 74.1 / 100.7 ms | 51.0 / 85.1 ms | **5.7 / 6.9 ms** | 20.6 / 41.7 ms | 9.7 / 11.4 ms |
| 5000 行合成页（15006 元素 / 500 节点 / 109 refs） | 114.3 / 176.3 ms | 75.5 / 136.3 ms | **5.8 / 8.1 ms** | 20.9 / 29.0 ms | 29.0 / 30.9 ms |

同一次观察的 CDP 成本（每调用一次；B 的安装是每文档一次性成本，不计入）：

| 场景 | 现状 | A | **B-提取** | **B-整链** |
| --- | --- | --- | --- | --- |
| fixture | 298 命令 / 25.4 KB 请求 / 103.4 KB 回复 | 298 / 25.4 KB / 103.4 KB | **1 / 73 B / 14.9 KB** | 131 / 5.6 KB / 71.7 KB |
| 1000 行 | 1002 / 74.5 KB / 332.1 KB | 302 / 30.2 KB / 273.7 KB | **1 / 73 B / 41.9 KB** | 153 / 6.5 KB / 177.1 KB |
| 5000 行 | 1002 / 74.5 KB / 332.1 KB | 302 / 30.5 KB / 274.0 KB | **1 / 73 B / 41.9 KB** | 153 / 6.5 KB / 177.3 KB |

（回复字节 = `Buffer.byteLength(JSON.stringify(reply))`，不含 WS 帧头；0.3 参考值是同一篇 FASTPATH-SPIKE 里 CDP 转义后的长度，原始 JSON 为 4.0/6.8/6.8 KB。）

**等价性（本 spike 的硬结果）**：

- 三个页面 **B-整链 text 与 A、与 pre-A 现状逐字节相同**（3/3）；B-无 ref text 与 0.4 `vom_refs:false` 逐字节相同（3/3）。
- 节点字段投影（tag/role/name/text/value/attrs/rect/样式/flags/colSpan/frameId…）**逐节点差异 0**（3/3 页面，500 节点上限内）。
- ref 映射：合成页 0 处不一致；fixture 127 个可比 ref 中 **1 处** 不一致，根因是 fixture 里 **重复 id `#marker-drag`** —— 现状的 `domPath`（`#id`）解析把两个节点都指到第一个元素（bn136），B 的 `objectId` 映射指向真实元素（bn138）。该节点未落进 1200 token 预算，所以 text 仍然相同。**B 在重复 id 上比现状更正确，但这属于“语义变更”，见 §3.1。**

**决策：GO（有条件）——选“B-提取”，不做“页内渲染器”**。先落 B-整链（text/refs 与现状逐字节一致，可灰度和回退），再用惰性句柄 ref 把 observe 压到 1 条命令。OOPIF 不进入 v1（现状 0 覆盖，B 不回归，见 §3.5）。

---

## 1. 测量方法

### 1.1 环境与隔离

- 真实 headless Edge：`msedge --headless=new --remote-debugging-port=0 --user-data-dir=<临时 profile> --disable-gpu --disable-extensions --window-size=1280,900 --hide-scrollbars`，每次全新 profile，跑完即删。
- 连接：复用 0.4 的 `connectCdp`（`0.4/packages/browser-adapter/src/cdp-ws.js` → `lib/ws.mjs` 的 RFC6455 客户端），`Target.createTarget` + `Target.attachToTarget{flatten:true}`。
- 并发检查：开跑前确认没有其他 headless/CDP 浏览器测试（`Get-CimInstance Win32_Process` 过滤 `msedge.exe` 的 `headless|remote-debugging` 为空；`node.exe` 只有 WorkBuddy edge-sync server）。运行期间机器上仍有用户自己的 Edge 负载，因此每个条件 2 次预热 + 10 次正式计时，并对三个主条件各跑第二遍独立批次（§2.1）。
- 每个条件：2 次预热 + 10 次正式计时；p50/p95 用最近秩法（`ceil(p/100*n)-1`）。
- 统计口径：在 page 级 CDP channel 外层包一层 `send` 计数，记录**命令数**、请求 JSON 字节、回复 JSON 字节，并按 CDP 方法分桶（用于拆解字节）。
- 页面加载后等两个 `requestAnimationFrame` 再开测，保证布局/绘制稳定。

### 1.2 页面

| 页面 | 构造 | 元素数 | 0.4 提取节点数 |
| --- | --- | --- | --- |
| `tests/fixtures/test.html` | 仓库既有 E2E 夹具（表单/表格/拖拽/shadow/iframe/ARIA） | 168 | 151（含 shadow/同源 iframe） |
| 1000 行合成页 | 临时 `file://`：每行 `<div class=r><span>Item N</span><button aria-label="btn N">Act N</button></div>` | 3006 | 500（0.4 页内 500 上限） |
| 5000 行合成页 | 同上，5000 行 | 15006 | 500 |

### 1.3 被测路径

1. **现状（pre-A）**：`extractVomNodes({maxNodes:4000, withBackendIds:true})` + `renderVom(nodes,{withRefs:true,maxTokens:1200})`，与 A 落地前的 `capture` 等价（`snapshot-handlers.js` 的观察路径，不加 viewport 测量）。
2. **A（0.4 当前默认）**：直接调用产品路径 `createSnapshotHandlers({cdp})['tool.snapshot']({max_tokens:1200})`，即 0.4 已合并的懒解析 ref（`snapshot-handlers.js:222-251` 的 `renderWithLazyRefs`）。
3. **B-提取**：只在页内跑一次紧凑 collector（见 §1.4），`Runtime.evaluate` 一次拿回紧凑树，不做 ref。
4. **B-整链**：B-提取 → daemon 侧解码成 `VomNode[]` → `renderVom(withRefs:false)` 拿到“真正落地行” → 只对这些行做 `handle → objectId → DOM.describeNode → backendNodeId` 回填 → `renderVom(withRefs:true)`。
5. **0.3 页内 observe（参考）**：不重测，直接引用同一篇 `FASTPATH-SPIKE.md` 的实测（同机同日、不同批次）。

### 1.4 B 原型设计（临时代码，未入仓）

页内 collector：一次性 `Runtime.evaluate` 安装到 `Page.createIsolatedWorld` 的隔离世界（`grantUniveralAccess:false` 也验证过可用），随后每次观察只需一次 `Runtime.evaluate('__bbFastB.collect({})', {contextId})`。

- 走查语义与 0.4 现有提取**逐字段对齐**（`0.4/packages/browser-adapter/src/vom-extract.js:7-164`）：同样的可见性过滤（rect>0、display/visibility/opacity）、同样的 role 映射、同样的 name 推导链（aria-labelledby → labels → aria-label → alt/title/placeholder → 直系文本 → 叶子 textContent → 控件后代名）、controlText 的对比度过滤、attrs 六个键、clickable/disabled/modal/inert/draggable/cursor、colSpan/rowSpan、open shadow 递归、同源 iframe 递归（`baseX/baseY + scrollX/scrollY`）。
- **不计算 domPath**（B 不用 CSS 选择器寻址），改为给每个节点记一个候选解句柄：页内 `els[]` 数组与节点同序，`nodeId-1` 即数组下标。
- 紧凑编码：`rows` 为定长数组 + 字符串表 `s`（tag/role/opacity/fontSize/color/backgroundColor/backgroundImage/cursor 去重），flags 位掩码，rect 量化到 0.1px。
- 附带能力：MutationObserver 维护 `rev`（unchanged 快路径）；`els()` 暴露元素数组用于 ref 映射；安装幂等（重复安装返回 `{reused:true}`）。

### 1.5 复现

临时 harness：`%TEMP%\bb-fastpath-b\{collector.js,collector-dompath.js,bench.mjs,probe2.mjs,probe3.mjs,probe-oopif.mjs}`，**跑完已清理**（脚本没有进仓库）。依赖只有 Node 内置模块 + 0.4 的 `cdp-ws.js` / `vom-extract.js` / `render.js` / `snapshot-handlers.js`，不装依赖。

---

## 2. 数字

### 2.1 延迟（p50 / p95，ms）

第一遍（主批次）：

| 场景 | pre-A | A | B-提取 | B-无 ref（提取+渲染） | B-整链 |
| --- | --- | --- | --- | --- | --- |
| fixture | 24.5 / 54.0 | 22.7 / 42.8 | 2.8 / 3.4 | 3.9 / 6.1 | 12.2 / 50.3 |
| 1000 行 | 74.1 / 100.7 | 51.0 / 85.1 | 5.7 / 6.9 | 7.6 / 12.3 | 20.6 / 41.7 |
| 5000 行 | 114.3 / 176.3 | 75.5 / 136.3 | 5.8 / 8.1 | 8.0 / 9.2 | 20.9 / 29.0 |

第二遍（独立批次，只测三个主条件；用来量化波动）：

| 场景 | pre-A | A | B-整链 |
| --- | --- | --- | --- |
| fixture | 20.9 / 41.8 | 18.2 / 32.2 | 11.5 / 13.0 |
| 1000 行 | 70.8 / 85.7 | 41.0 / 68.4 | 21.0 / 32.7 |
| 5000 行 | 117.5 / 181.9 | 74.8 / 91.7 | 22.6 / 41.2 |

关键比值（第一遍）：

- **B-提取 / A**：0.12 / 0.11 / 0.08（p50）；**B-整链 / A**：0.54 / 0.40 / 0.28；**B-整链 / pre-A**：0.50 / 0.28 / 0.18。
- fixture 的 B-整链 p95（50.3）高于 A（42.8）：fixture 只有 103 个 ref，B 的 ref 映射（128×`describeNode`）与 A 的全量解析同量级，小页面上 B 的两轮渲染+映射会落在噪声区（第二遍 B 11.5/13.0 就明显更好）。**B 的收益门槛与 A 相同：可寻址节点越多、页越大收益越大。**
- B 的 p50 对 DOM 规模几乎不敏感（5.7 → 5.8 ms；1000 行与 5000 行同步），因为 0.4 的 500 节点上限与 B 的页内走查都没有选择器匹配成本。

### 2.2 CDP 成本

| 场景 | 指标 | pre-A | A | B-提取 | B-整链 |
| --- | --- | --- | --- | --- | --- |
| fixture | 命令 / 请求 / 回复 | 298 / 25.4 KB / 103.4 KB | 298 / 25.4 KB / 103.4 KB | **1 / 73 B / 14.9 KB** | 131 / 5.6 KB / 71.7 KB |
| 1000 行 | 命令 / 请求 / 回复 | 1002 / 74.5 KB / 332.1 KB | 302 / 30.2 KB / 273.7 KB | **1 / 73 B / 41.9 KB** | 153 / 6.5 KB / 177.1 KB |
| 5000 行 | 命令 / 请求 / 回复 | 1002 / 74.5 KB / 332.1 KB | 302 / 30.5 KB / 274.0 KB | **1 / 73 B / 41.9 KB** | 153 / 6.5 KB / 177.3 KB |

- B-整链命令数 = `3 + 落地未解析行数`（1 次 collect + 1 次 `els()` 取数组 objectId + 1 次 `Runtime.getProperties` + N 次 `DOM.describeNode{objectId}`）。1000/5000 行页 150 条解析（无 ref 渲染落地 150 行，带 ref 后收缩到 109 行），fixture 128 条。
- B-整链回复里 **`Runtime.getProperties` 占 109.4 KB（500 个元素 objectId）**，`describeNode` 只占 25.8 KB，collect 占 41.9 KB。这是 B-整链字节只有 −35% 的原因；可选优化：页内先按“落地行下标”过滤出子数组再 `getProperties`（预计 177 KB → ~101 KB，命令数 +1；**未实测**）。
- A 在 fixture 上退化成全量预解析：fixture 的 128 个可渲染节点在 1200 token 预算内**不截断**（实测 `planBudget(renderable,{maxTokens:1200}).truncated === false`），命中 `snapshot-handlers.js` 里 `tokenBudgetTruncates` 提前返回（`snapshot-handlers.js:231-233`），因此 A 解析了全部 148 个唯一选择器，命令数与 pre-A 相同（298），与 FASTPATH-SPIKE 的 A1（254）不同。**不是表格安全阀**：fixture 上 `refResolutionAffectsRows` 实测为 `false`。1000/5000 行页无表格、且 500 节点装不进 1200 token（无 ref 渲染只落地 150/500 行，说明 `planBudget` 截断），A 才走懒解析（302）。

### 2.3 B 内部拆解与成本归因

B-整链（p50）拆解（fixture / 1000 / 5000）：

- 页内 collect：1.7 / 3.2 / 3.3 ms（collector 自报 `performance.now()` 差值；外部 evaluate 2.8/5.7/5.8 的余下部分是 CDP 往返 + 14.9/41.9/41.9 KB JSON 序列化/传输）。
- daemon 侧解码 + 首次渲染：1.3 / 1.8 / 1.8 ms。
- ref 映射（fixture 128 / 1000 行 150 / 5000 行 150 次 `describeNode`，分 32 并发）：6.5 / 11.2 / 9.5 ms。
- 二次渲染（带 refs）：~1.5–2 ms；余下为往返/序列化。

提取成本归因（5000 行页，同一批次，500 节点；`probe3`）：

| 变体 | 页内 collect | 外部 evaluate p50 | 回复字节 | 说明 |
| --- | --- | --- | --- | --- |
| B collector（无 domPath） | 3.1 ms | 7.4 ms | 41.9 KB | 本 spike 的 B |
| B collector + 算 domPath | 10.8 ms | 14.3 ms | 88.2 KB | 只加回 `cssPath`（`#id` / `:nth-of-type` 链） |
| 0.4 现有提取表达式 | — | 21.2 ms | 254.9 KB | 对象键 + domPath + 全字段 |

→ **0.4 现有提取的 21.2 ms 里，domPath 约占 7.0 ms、对象键/结构编码约占 6.9 ms，两者合计就是 B 提取快 3.6× 的全部来源；不是“页内执行”本身更快。** 这也解释了为什么 B 的页内 walk（3.1–3.3 ms）反而比 0.3 的页内 walk（27.8 ms，含完整渲染语义）快：B 只搬了提取。

### 2.4 输出等价性

| 检查 | fixture | 1000 行 | 5000 行 |
| --- | --- | --- | --- |
| B-整链 text == pre-A text | ✅ | ✅ | ✅ |
| B-整链 text == A text | ✅ | ✅ | ✅ |
| B-无 ref text == 0.4 `vom_refs:false` text | ✅ | ✅ | ✅ |
| 节点字段投影差异（逐节点） | 0 | 0 | 0 |
| refs 数量 | 103 / 103 | 109 / 109 | 109 / 109 |
| ref 映射逐节点一致 | 127 可比、1 不一致 | 150 / 0 | 150 / 0 |

fixture 的那 1 处不一致（重复 id）：见 §3.1。

### 2.5 unchanged 快路径与 cursor 分页

| 能力 | A（现状） | B | 说明 |
| --- | --- | --- | --- |
| 重复 observe（无 mutation） | 无（每次都完整重来） | **0.21 / 0.22 / 0.18 ms；1 条命令；47 B** | 页内 MutationObserver `rev` + daemon 侧缓存上次渲染结果 |
| observe 第 1 页（page_size=100） | 202 命令 / 19.7–58.3 ms | 103 命令（=3+100）/ 与 B-整链同量级 | B 第 1 页 text 与 A 第 1 页 text 逐字节相同（3/3） |
| observe 第 2 页（cursor 续页） | 54–202 命令 / 12.4 / 35.4 / 64.7 ms | **0 命令 / 0.84 / 1.93 / 1.67 ms** | B 的节点数组已在 daemon 侧，续页只是再渲染一次 |

B 的 cursor 快路径有前提：**节点数组缓存的有效性必须校验**。原型里页内 `rev` 变化即失效；建议实现时第 2 页先做 1 次 `__bbFastB.rev()` 探测（1 条命令、~0.2 ms、47 B），`rev` 变化或导航则重新 collect（或按 0.4 cursor 约定返回“请重新 observe”）。

### 2.6 与 0.3 page-lib 的差距（相对 FASTPATH-SPIKE.md 参考值）

| 维度 | 0.3 页内 observe | B-提取 | B-整链 |
| --- | --- | --- | --- |
| p50（fixture/1000/5000） | 2.7 / 9.7 / 29.0 ms | **2.8 / 5.7 / 5.8** | 12.2 / 20.6 / 20.9 |
| 命令数 | 1 | **1** | 3+N |
| 回复字节 | 4.0 / 6.8 / 6.8 KB（原始 JSON） | 14.9 / 41.9 / 41.9 KB | 71.7 / 177.1 / 177.3 KB |
| unchanged | 0.20–0.22 ms | 0.18–0.22 ms | 同左 |
| 输出内容 | 202 行 / 2122 tokens（无预算） | 109 行 / 1200 预算 | 109 行 / 1200 预算 |

**结论：B-提取的延迟已经达到/超过 0.3 级（合成页甚至更快，因为 0.3 在页内做完整渲染）；B-整链因为 ref 语义比 0.3 多 3+N 条命令、15 ms 左右。字节上 B-提取仍比 0.3 高约 6×（41.9 KB vs 6.8 KB），B-整链高约 26×——这是“把 0.4 渲染器留在 daemon 侧”的固有代价：0.4 渲染语义需要每节点的 rect/颜色/字号/透明度/attrs，0.3 则只回传文本。如果产品要求 0.3 级字节（例如远程 daemon 模式），只有“页内渲染”一条路，那才是 `FASTPATH-SPIKE.md` §5 那个高成本、高风险的 B。**

---

## 3. 7 个冲突的实测结论

### 3.1 ref 句柄（最硬，但有解）

**结论：可行，两条路线。路线 1（B-整链）不改动作链；路线 2（惰性句柄 ref）能把 observe 压到 1 条命令，但要改动作解析。B 的句柄映射在重复 id 页面上比现状更正确，属于需要登记的语义变更。**

证据：

- 0.4 动作只接受 `bn<backendNodeId>`：`0.4/packages/browser-adapter/src/action-handlers.js:429-433`（`/^bn\d+$/`），`stableRef` 是文本身份、动作链不认。
- B-整链：`els()` 数组 objectId → `Runtime.getProperties`（500 个元素 objectId，109.4 KB）→ 只对落地行 `DOM.describeNode{objectId}`。实测 1000/5000 行页 **150/150 一致**；fixture **可比 127 处、1 处不一致**（原因是现状 domPath 的重复 id bug，见下）。
- 重复 id 细节：fixture 有 `id="marker-drag"` 两个元素；现状用 `#marker-drag` 选择器解析，两次都命中第一个元素（bn136），而目标节点“拖拽手柄”的真实 backendNodeId 是 138。B 的 objectId 直接指向元素本身。该节点没落进 1200 token 预算，所以 text 仍逐字节相同；**若它落地，B 与现状的 text 会不同（B 是对的）**。这是“B 更正确”与“输出逐字节一致”的冲突点，落地前必须决定：接受差异，或对重复 id 节点回退 domPath（会重新引入 §2.3 的 domPath 成本）。
- 路线 2（推荐目标形态）：observe 返回 `@bN` 页内句柄（或继续返回 `bn` 但延迟解析），动作时 2 条命令（`Runtime.evaluate('els()[N]')` → `DOM.describeNode`）。实测 40 次动作解析：**p50 0.54 ms / p95 1.09 ms / 2 条命令**。代价是动作解析依赖页内上下文生命周期（导航/重渲染后句柄失效 → `E_STALE_REF`，与 0.3 的 `@eN` 语义相同），以及 observe 与动作之间需要 daemon 侧的句柄表。

成本：路线 1 约 0.5–1 人日；路线 2 额外 1–2 人日（动作链 + 失效语义 + 协议文本约定）。

### 3.2 隔离世界

**结论：`Page.createIsolatedWorld` + 该 contextId 注入完全可用，隔离有效，且是必须项（主世界执行会被页面篡改）。**

实测（fixture，`grantUniveralAccess:false`）：

| 检查 | 结果 |
| --- | --- |
| 主世界看 collector | `typeof globalThis.__bbFastB` = `undefined` |
| 隔离世界看页面全局 | 页面在主世界设置的 `window.__pageSecret` 在隔离世界里读不到（`undefined`） |
| 隔离世界读 DOM | `document.title` / `body.children.length` / `getComputedStyle` 正常 |
| 主世界篡改 `Element.prototype.getAttribute` 后，隔离世界收集 | 节点数 151 不变、name 不变（未被污染） |
| 同一份 collector 在主世界执行（对照） | name 全部变成 `TAMPERED`（证明主世界方案不可接受） |
| 一次性安装成本（建世界 + 注入 12,049 B） | 3.1 / 3.5 / 3.6 / 4.2 ms（各页面测量值） |
| 重复安装 | 幂等，返回 `{reused:true}` |

**成本：** 隔离世界本身 0.5 人日（含导航/`executionContextDestroyed` 后的重建、每帧一世界）；主世界执行不进入方案。

### 3.3 打包

**结论：不需要新增打包器。** collector 是自包含 IIFE（原型 256 行 / 12,049 B），可以作为一个字符串常量随 `browser-adapter` 交付，`Runtime.evaluate` 直接注入；0.4 的 `build-extension-ingress.mjs` 保持“复制文件”不变，也不需要 `tools/build-page-lib.mjs` 那种分块拼接。

证据：B 安装请求 = 12,049 B（现有提取表达式 9,060 B，+33%），一次 `Runtime.evaluate` 注入；安装幂等。**唯一新增工程负担是“同一套提取语义出现两份实现”**（`vom-extract.js` 的表达式与页内 collector）。必须用黄金测试锁住：同一页面两个实现的节点投影 diff = 0（本 spike 已用 3 个页面验证，含 shadow + 同源 iframe）。

成本：0.5 人日（collector 从 `vom-extract.js` 语义改写 + 相等性测试）。

### 3.4 cursor / 分页语义

**结论：B 的 cursor 比 A 便宜一个数量级，但需要新的缓存失效契约。**

证据：B 第 2 页 0 条命令、0.84/1.93/1.67 ms（节点数组已在 daemon 侧，`renderVom` 带 `pageSize/cursor` 再渲染即可）；A 第 2 页仍要重新抓取（54/202/202 条命令、12.4/35.4/64.7 ms）。B 第 1 页 text 与 A 第 1 页 text 逐字节相同（3/3）。

需要设计：

- 0.4 现行约定“cursor 不绑定 DOM 快照，场景变化后应重新 observe”（`0.4/packages/vom/src/observe.js:132-134`）。B 的缓存必须显式化：缓存 key（target + documentId + frameId + 参数）、`rev` 校验（1 条命令）、TTL/上限、导航失效。
- 页内 `rev` 只覆盖 DOM mutation，不覆盖布局类变化（动画、CSS 变量、字体加载、viewport resize）。缓解：`rev` 之外再记录 `innerWidth/innerHeight + scrollX/scrollY`、监听 `resize`、必要时退回重新 collect。

成本：0.5 人日。

### 3.5 OOPIF / 跨源 iframe

**结论：0.4 现状对 OOPIF **完全不可见**；B 可以覆盖，但需要按 target 逐帧注入 + 几何合成，成本独立于主帧。建议 v1 明确“主帧 + 同源 iframe + open shadow”，OOPIF 单列。**

实测（本地 http + `--host-resolver-rules` 造 `a.example.com` / `b.example.org` cross-site + `--site-per-process`）：

| 检查 | 结果 |
| --- | --- |
| iframe target | 浏览器暴露独立 `type:'iframe'` target（`Target.getTargets`）；**父 target 的 `Page.getFrameTree` 只列主帧**（跨源子帧不在父帧树里） |
| 0.4 现状提取 | 主帧 4 节点、`frameId` 全为 0，**看不到子帧的 `child heading`** |
| B 逐 target 注入 | attach iframe target → `Page.createIsolatedWorld` + 注入 12,049 B：2.42 ms；collect：1.55 ms / 3 节点 / 430 B，能读到 `child heading` / `child action` |
| 几何 | 子帧 rect 是帧内坐标（x=8, y=19.9）；父帧 owner box 偏移（10, 114.875）；合成需 `DOM.getFrameOwner` + `DOM.getBoxModel` = 2 条命令 / 0.7 ms（嵌套需逐层合成） |
| 每次 observe 命令数 | 2 帧 = 2 条 evaluate（每 target 一条）；OOPIF 导航/创建后需重新注入（~2.4 ms/帧） |

**成本：** v1 不覆盖（明确记录：与现状覆盖面一致，0 回归；但相对 0.3 的 `all_frames` 是能力缺口）。若 v1 就要覆盖：+2–4 人日（`Target.setAutoAttach` 生命周期、逐帧世界、坐标合成、与 0.4 现有 `oopif.js` 动作路径对齐）。**不建议把 OOPIF 塞进 B 的首个里程碑。**

### 3.6 注入暴露面

**结论：B 的页内足迹与现状同量级，明显小于 0.3 page-lib；没有任何 DOM 写操作。**

| 维度 | 现状（0.4 每观察一次） | B（每文档一次安装 + 每观察一次调用） | 0.3 page-lib（参考） |
| --- | --- | --- | --- |
| 注入体积 | 每次 evaluate 9,060 B 表达式 | 一次性 12,049 B（+33%） | 180,712 B（`injected/page-lib.js`） |
| 页内长任务（collect 自报） | 提取 ~18 ms（5000 行页，外部 21.2 ms） | **1.7 / 3.2 / 3.3 ms**（fixture/1000/5000，均 < 50 ms long-task 阈值） | 页内 walk 27.8 ms（含渲染） |
| 页面可见性 | 主世界可观察到 evaluate 副作用 | 隔离世界，主世界 `typeof` 不可见；无 DOM 属性/节点写入（0.3 会写 `data-bb-vom` 标记） | 主世界 DOM 标记（设计参考） |
| 反检测面 | evaluate 表达式本身可被 Timer/长任务统计感知 | 残留：长任务/`performance` 采样、每文档一次的注入可被感知；隔离世界无法被页面枚举 | 更大注入 + DOM 标记 + 多个 MutationObserver |

**成本：** 无额外实现成本；但要把“不写 DOM”写成约束与测试（本原型 collector 只读：`querySelectorAll` / `getBoundingClientRect` / `getComputedStyle` / `getAttribute`）。

### 3.7 几何

**结论：几何不再是独立冲突，但必须显式承认两处差异：rect 量化 0.1px、跨帧坐标需要合成。**

- rect 量化：原型把 rect 量化到 0.1px（省字节）；因为 B 的默认渲染不读 rect（默认不带 layers/occlusion），三页 text 仍逐字节相同。开启 `includeLayers`/`withActiveRegion`/`viewportPolicy` 时 rect 参与遮挡/裁剪判断，量化可能让覆盖率跨阈值。**落地时要么保持原精度（+少量字节），要么给几何路径加容差测试。**
- 同源 iframe / open shadow：B 与现状一致（`frameId/framePath/shadowDepth/baseX/baseY` 同语义），三页逐字节相同可证。
- OOPIF：见 §3.5，帧内坐标 + 父帧偏移合成，2 条命令/帧。

成本：0–0.5 人日（取决于是否保留量化）。

---

## 4. 实现成本估算

前置结论：**B 不需要移植 `vom/src/`（~150 KB）**，这是与 `FASTPATH-SPIKE.md` §5.3 最大的差别；但需要“页内提取语义”的第二份实现 + 隔离世界生命周期 + ref 回填/句柄契约。

| 工作项 | 人日 | 备注 |
| --- | --- | --- |
| 页内 collector（自包含 IIFE，语义对齐 `vom-extract.js`） | 1–1.5 | 原型 256 行/12 KB 是下限；要补注释、错误处理、防御性代码 |
| 黄金等价测试（3 页面节点投影 diff=0 / text 逐字节 / shadow+同源 iframe） | 1–1.5 | 本 spike 已验证可行性；必须进 CI |
| 隔离世界生命周期（每帧建世界、导航/`executionContextDestroyed` 重建、幂等、清理） | 1 | 含多标签页/多 target 隔离 |
| daemon 接线：解码 → `VomNode[]` → 复用 `capture`/`renderWithLazyRefs`、开关与回退（B 失败回退现路径） | 1–1.5 | 特征开关 + 灰度 |
| ref 映射（B-整链：objectId→backendNodeId，只解析落地行） | 0.5–1 | 复用 0.4 `resolveVomBackendIds` 批处理思路 |
| 惰性句柄 ref（路线 2，可选目标） | +1–2 | 改 `action-handlers.js` 的 ref 解析 + 失效语义 + 单测 |
| cursor 缓存（key/`rev` 校验/TTL/导航失效） | 0.5 | §3.4 |
| unchanged 快路径接入 daemon 缓存 | 0.5 | 页内 `rev` + 上次结果 |
| 重复 id 语义决策（接受差异或 domPath 回退） | 0.5 | §3.1，需要产品拍板 |
| 合计（v1：主帧 + 同源 iframe + shadow，B-整链） | **6–8.5** | 含测试与回退；不含 OOPIF |
| 合计（若同时做惰性句柄 ref） | 7–10.5 | |
| OOPIF（单列） | +2–4 | §3.5；建议 v2 |

对照：`FASTPATH-SPIKE.md` §5.3 给“页内渲染器（移植 page-lib）”的最小原型 3–5 人日、全量语义对齐“不是本周能完成”。B-提取的 6–8.5 人日包含生产化与测试，**风险显著低于移植渲染器**（不需要对齐 layers/stealth/affordance/context/table-fold/activeRegion/stableRef 的页内实现）。

---

## 5. 建议与门槛

### 5.1 决策

- **GO：选 B-提取（页内紧凑提取 + 0.4 现有渲染器）作为下一个迭代的快路径实现目标。**
- **不做**：页内渲染器 / page-lib 平移（`FASTPATH-SPIKE.md` §5 的 B）——本 spike 证明不必移植渲染管线就能拿到 0.3 级提取延迟。
- **不做**：把 observe 的默认行为改成“无 ref”；refs 必须保留（0.4 动作链只认 `bn<backendNodeId>`）。
- v1 范围：主帧 + 同源 iframe + open shadow；OOPIF 单列 v2；B 失败/超时按特征开关回退现状 A。

### 5.2 验收门槛（不过就停）

| 编号 | 门槛 | 本 spike 实测 | 判定 |
| --- | --- | --- | --- |
| G1 | 三个页面 `text` 与现状逐字节相同（含 refs） | 3/3 ✅ | 通过 |
| G2 | 节点字段投影逐节点差异 = 0 | 3/3 = 0 ✅ | 通过 |
| G3 | 1000/5000 行页 p50 ≤ 现状 A 的 0.5× | 0.40 / 0.28 ✅ | 通过 |
| G4 | 1000/5000 行页 p95 ≤ A 的 0.6× | 0.49 / 0.21 ✅（fixture 噪声区不设 p95 门槛） | 通过 |
| G5 | 命令数 = 3 + 落地未解析行数（B-整链） | 131 / 153 / 153 ✅ | 通过 |
| G6 | 回复字节 ≤ A 的 0.7× | 0.69 / 0.65 / 0.65 ✅ | 通过 |
| G7 | unchanged observe：1 命令、≤1 KB、≤1 ms | 47 B / 0.18–0.22 ms ✅ | 通过 |
| G8 | cursor 第 2 页：≤3 ms；带 `rev` 校验时 ≤1 命令 | 0.84–1.93 ms / 0 命令 ✅ | 通过 |
| G9 | 隔离世界：主世界不可见 collector；篡改 DOM API 不影响结果 | ✅ | 通过 |
| G10 | collector 零 DOM 写；页内单次 collect < 10 ms（long task 50 ms） | 只读；1.7–3.3 ms ✅ | 通过 |
| G11 | OOPIF 覆盖面不回归（现状 0 覆盖） | 0 覆盖为基线；B v1 明确排除，需文档化 | 有条件通过 |
| G12 | 重复 id 的 ref 语义变更已登记并有测试 | fixture 1 处（B 更正确） | 待产品决策 |

**若目标是“observe 1 条命令 + 0.3 级字节”，追加门槛 G13：observe ≤1 命令且回复 ≤10 KB。此门槛只有“页内句柄 ref”（路线 2）能满足，B-整链不满足（153 命令/177 KB）。**

### 5.3 no-go / 停止条件

1. 产品要求 **ref 与现状逐字节一致（包括重复 id 的既有 bug 行为）**，且不接受回退 domPath 带来的 +7 ms：B 的价值下降到 ≈ A，建议停。
2. v1 必须覆盖 **OOPIF**：成本 +2–4 人日且要多 target 生命周期，建议先做产品范围决策，不在 B 的里程碑里硬塞。
3. 远程 daemon 模式要求 observe 回复 ≤10 KB：只有页内渲染能满足 → 回到 `FASTPATH-SPIKE.md` §5 的评估（高成本），B-提取 no-go。
4. 页内 `rev` 失效语义无法覆盖真实站点的布局型变化（动画/字体/resize），且不能接受“保守重抓”：unchanged 快路径退化为 1 条 evaluate 也无收益，属可接受降级（G7 失效但不阻塞 G1–G6）。

### 5.4 里程碑建议

1. **M1（1–2 人日）**：collector + 黄金等价测试 + 独立开关，跑通 fixture/1000/5000，text/节点 diff 门槛进 CI。
2. **M2（2–3 人日）**：隔离世界生命周期 + daemon 接线 + B-整链 ref 映射 + 回退；验收 G1–G6、G9–G11。
3. **M3（0.5–1 人日）**：unchanged + cursor 缓存 + `rev` 校验；验收 G7–G8。
4. **M4（可选，1–2 人日）**：惰性句柄 ref，验收 G13；否则维持 B-整链。
5. **M5（可选，2–4 人日）**：OOPIF 覆盖（v2）。

---

## 6. 测量限制（必读）

1. **链路与真实产品不同**：本 spike 是 loopback CDP over WebSocket；真实 0.4 daemon → 扩展（`chrome.debugger`）/用户浏览器每跳会多 0.5–2 ms。绝对数字偏乐观，但相对比例（302 命令 vs 1、274 KB vs 42 KB）不随链路改变。**远程 daemon 模式下字节差异会被放大**（41.9 KB vs 6.8 KB 可能变成 300 ms 级的差距），不要只看这里的本地延迟。
2. **机器负载**：运行期间用户自己的 Edge 与 WorkBuddy 进程在跑；三个主条件跑了两遍独立批次。p50 两批次差 ≤30%，p95 更敏感：B-整链 fixture 第一遍 50.3 ms 是单个离群样本（第二遍 13.0 ms），A 的 p95 也出现过 42.8–136.3 ms 的跨度。绝对值请当作“同机同批次的相对量级”，跨页比较请看比值。
3. **合成页偏理想**：1000/5000 行页每行结构相同、全部可见、无伪元素/transform/虚拟滚动；真实站点 DOM 混合度更高，0.4 的 500 节点上限与 B 的页内走查在真实站点上的差异会更大（但方向不变）。
4. **原型是临时代码**：collector 在 `%TEMP%` 里按 `vom-extract.js` 语义重写（未复制 0.3 代码），不等同于生产实现；字段等价只在这三个页面（含 fixture 的 shadow/同源 iframe）上验证过，未覆盖 closed shadow、跨源 iframe、pseudo-element、页面自定义元素。
5. **B 的“页内提取”语义是复刻，不是复用**：0.4 的提取表达式与 B collector 是两份实现，任何一侧改字段都会破坏等价性 → 必须靠 G2 黄金测试锁住。
6. **`Runtime.getProperties` 的 109 KB 是 B-整链的字节主项**：本 spike 未实测“先按落地行下标过滤子数组”的优化（预计 177 KB → ~101 KB），落地实现时优先做这个小优化。
7. **0.3 参考值来自 FASTPATH-SPIKE.md 的同一台机器/同一天、不同批次**，不是本次重测；只用于“是否逼近 0.3 级”的量级对照。
8. **未跑阶段门**（按任务约束），本文件是评估结论，不构成发布证据；0.3.0 冻结、未改产品代码、未改 `dist/` 与 `D:\CTRM自动录入`。

---

## 7. 参考源码与证据

- 0.4 提取表达式：[vom-extract.js](../0.4/packages/browser-adapter/src/vom-extract.js:7)
- 0.4 快路径 A（懒解析 ref）：[snapshot-handlers.js](../0.4/packages/browser-adapter/src/snapshot-handlers.js:222)
- 0.4 渲染管线 / ref 生成：[render.js](../0.4/packages/vom/src/render.js:244)、[render.js 分页](../0.4/packages/vom/src/render.js:731)
- 0.4 观察 cursor 约定：[observe.js](../0.4/packages/vom/src/observe.js:132)
- 0.4 动作 ref 只认 `bn<id>`：[action-handlers.js](../0.4/packages/browser-adapter/src/action-handlers.js:429)
- 0.4 稳定身份（stableRef）：[identity.js](../0.4/packages/vom/src/identity.js:47)
- 0.4 OOPIF 动作辅助（无 observe 覆盖）：[oopif.js](../0.4/packages/browser-adapter/src/oopif.js:2)
- 0.4 ingress 构建（复制式，无打包器）：[build-extension-ingress.mjs](../0.4/scripts/build-extension-ingress.mjs:1)
- 0.4 ingress content 消息模式（`chrome.tabs.sendMessage` + `{kind:...}` 信封）：[human-watch.js](../0.4/extension-ingress/content/human-watch.js:12)
- 0.3 page-lib（仅设计参考，未复制）：[page-lib.js](../extension/injected/page-lib.js:601)（observe/refs 设计）、[page-lib.js ref 表](../extension/injected/page-lib.js:301)
- 上一篇评估：[FASTPATH-SPIKE.md](./FASTPATH-SPIKE.md)
