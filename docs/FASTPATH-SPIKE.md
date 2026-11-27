# FASTPATH-SPIKE：page-lib 快路径实测评估（I5）

状态：一次性内部评估（spike），不改产品代码、不跑阶段门。
评估对象：0.4 现有 `tool.observe` / `tool.snapshot` 的 CDP 提取路径 vs 0.3 `injected/page-lib.js` 的页内快路径。
测量日期：2026-11-24；浏览器 Edge 158.0.4370.33（headless=new）；Node v24.21.0；Windows。

---

## 0. 结论摘要

一句话：**0.4 的瓶颈不是页内 DOM 走查，而是"每个可寻址节点 2 条 DOM 命令"的 ref 解析 + 235 KB 的节点数组回传；页内快路径能拿到量级收益，但要移植渲染管线与 ref 模型。**

| 场景（页面） | 0.4 observe 现状 p50/p95 | 方案 A（懒解析 ref） | 0.4 无 refs 下限 | 0.3 页内 observe（全量） | 0.3 重复 observe（unchanged） |
| --- | --- | --- | --- | --- | --- |
| `tests/fixtures/test.html`（168 元素 / 151 节点 / 103 refs） | 26.5 / 44.8 ms | 20.3 / 57.2 ms | 6.8 / 8.0 ms | **2.7 / 3.6 ms** | **0.20 / 0.25 ms** |
| 1000 行合成页（3006 元素 / 500 节点 / 109 refs） | 75.6 / 89.4 ms | 42.0 / 64.4 ms | 17.4 / 23.8 ms | **9.7 / 11.4 ms** | **0.22 / 0.31 ms** |
| 5000 行合成页（15006 元素 / 500 节点 / 109 refs） | 118.1 / 167.6 ms | 67.1 / 74.1 ms | 17.5 / 20.7 ms | **29.0 / 30.9 ms** | **0.22 / 0.38 ms** |

同一次观察的 CDP 成本（每调用一次）：

| 场景 | 0.4 现状 | 方案 A | 0.4 无 refs | 0.3 页内 |
| --- | --- | --- | --- | --- |
| fixture | 298 命令 / 25.4 KB 请求 / 103.4 KB 回复 | 254 / 23.4 KB / 99.3 KB | 1 / 9.3 KB / 73.7 KB | **1 / 154 B / 4.5 KB** |
| 1000 行 | 1002 / 64.1 KB / 321.9 KB | 302 / 27.0 KB / 263.5 KB | 1 / 9.3 KB / 234.7 KB | **1 / 154 B / 8.0 KB** |
| 5000 行 | 1002 / 64.1 KB / 322.9 KB | 302 / 27.3 KB / 263.8 KB | 1 / 9.3 KB / 234.7 KB | **1 / 154 B / 8.0 KB** |

（0.3 侧回复字节是 CDP 转义后的字符串长度；去掉转义后原始 JSON 为 4.0 KB / 6.8 KB / 6.8 KB。）

**决策：A 立即落地（低成本、−43% 延迟、命令数 −3.3×、输出文本字节级一致）；B 另立原型 spike（−4.1×~−9.8× 延迟、−26×~−47× 字节、1 个往返 + unchanged 快路径），但不做"整套 page-lib 平移"。**

---

## 1. 测量方法

### 1.1 环境与隔离

- 真实 headless Edge：`msedge --headless=new --remote-debugging-port=0 --user-data-dir=<临时 profile> --disable-gpu --disable-extensions --window-size=1280,900`，每次全新 profile，跑完即删。
- 连接：复用 0.4 的 `connectCdp`（`0.4/packages/browser-adapter/src/cdp-ws.js` → `lib/ws.mjs` 的 RFC6455 客户端），`Target.createTarget` + `Target.attachToTarget{flatten:true}`。
- 隔离：开跑前确认没有其他 headless 浏览器测试在跑（当时只有 WorkBuddy 的 edge-sync node 进程与用户自己的 Edge，没有并发的 CDP 测试）。运行期间机器上仍有用户浏览器负载，因此同一条件跑两次独立运行，见 §5.1 波动说明。
- 每个条件：2 次预热 + 10 次正式计时（早期两次运行是 7 次，结论一致）。p50/p95 用最近秩法（`ceil(p/100*n)-1`）。
- 统计口径：在 page 级 CDP channel 外包一层 `send` 计数，记录**命令数**、请求 JSON 字节、回复 JSON 字节（`Buffer.byteLength(JSON.stringify(...))`，不含 WS 帧头，占比 <1%）。

### 1.2 页面

| 页面 | 构造 | 元素数 | 文本节点 |
| --- | --- | --- | --- |
| `tests/fixtures/test.html` | 仓库既有 E2E 夹具（表单/表格/拖拽/iframe/shadow） | 168 | 249 |
| 1000 行合成页 | 临时 `file://` 文件：每行 `<div class=r><span>Item N</span><button aria-label="btn N">Act N</button></div>` | 3006 | 2000 |
| 5000 行合成页 | 同上，5000 行 | 15006 | 10000 |

**为什么不用 `data:` URL 承载大页面**：data: URL 自身会被 CDP 回复里的 `documentURL` 复制，污染字节与耗时（§7 有实测：5000 行 data: 页单次 `DOM.getDocument` 回复 1.23–1.41 MB、耗时 ~28 ms；0.3 observe 的 `url` 字段 138 KB/707 KB）。正式数据改用 `file://`（URL ~60 B）。data: 的数字只作对照，不进入结论表。

### 1.3 被测路径

1. **0.4 现状**：`extractVomNodes({maxNodes:4000, withBackendIds:true})` + `renderVom(nodes,{withRefs:true,maxTokens:1200})`，与 `0.4/packages/browser-adapter/src/snapshot-handlers.js:146-167` 的 `capture` 等价（默认观察路径不加 viewport 测量）。
2. **方案 A 原型（懒解析 ref）**：同一次提取但 `withBackendIds:false` → `renderVom(withRefs:false)` → 取**真正落地行**的 nodeId → 只对这些节点 `resolveVomBackendIds` → 重渲染 `withRefs:true`；最多 4 轮，实测 2 轮收敛。
3. **0.4 无 refs 下限**：`withBackendIds:false` + 渲染（对应私有开关 `vom_refs:false`）。
4. **0.3 页内**：把 `extension/injected/page-lib.js`（4158 行，LIB_VERSION 53）一次性 `Runtime.evaluate` 注入主世界，然后按 0.3 的调用方式执行 `await __BB_PAGE__.handle('observe'| 'snapshot', args)` 并只回传 JSON 字符串——这就是 0.3 页面侧的真实工作量（页内 walk + 页内渲染 + 序列化），refs 留在页内 WeakMap。

### 1.4 复现

临时 harness：`%TEMP%\bb-fastpath-spike\{bench,probe,probe2,summarize,permethod}.mjs`，**跑完已清理**（脚本没有进仓库）。重跑要点已写在上面 §1.1–1.3；依赖只有 Node 内置模块 + 0.4 的 `cdp-ws.js` / `vom-extract.js` / `vom/src/render.js`，不装依赖。

---

## 2. 0.4 现状路径拆解（钱花在哪）

一次 `tool.observe`（`snapshot-handlers.js:183-215`）实际发生：

1. `Runtime.evaluate(EXTRACT_EXPRESSION, returnByValue)` —— 页内走查可见元素，**页内硬上限 500 个节点**（`vom-extract.js:39` 的 `if (id >= 500) return;`），带 rect/颜色/字号/语义名/domPath 等全字段，整包按值回传（`vom-extract.js:7-164`）。
2. `DOM.getDocument{depth:1}`（`vom-extract.js:210`）。
3. 对**每一个有 domPath 的节点**（不是"会落地的行"）做 `DOM.querySelector` + `DOM.describeNode`，每批 32 条并发、批间串行（`vom-extract.js:204-251`）→ 2N 条命令。
4. 节点侧 `renderVom`（`0.4/packages/vom/src/render.js`，纯函数，1.7–3.4 ms）。

实测拆解（5000 行页）：

- 提取（步骤 1）：**17.5 ms**，请求 9.3 KB（提取表达式本身）+ 回复 234.7 KB。
- ref 解析（步骤 2+3）：**88.3 ms**（105.8 − 17.5），1000 条命令；回复只有 24 KB（querySelector）+ 78 KB（describeNode）。
- 渲染：~2 ms。
- 模型最终看到的 observation：**2.9 KB / 109 行**，而这一步的 CDP 回复总量 **322.9 KB**（约 110×）。

关键数字：

- **节点数组回传占 73% 字节**：500 节点 234.7 KB ≈ 470 B/节点。构成（5000 行页实测）：domPath 31.8 KB（13.5%）、颜色/透明度/字号 19.7 KB（8.4%）、rect 18.7 KB（8.0%）、name/text/value 4.5 KB（1.9%），其余 160 KB（68%）是键名 + tag/role/attrs/flags/id/frameId 等结构开销（≈320 B/节点）。
- **ref 解析是延迟主项且随文档规模变差**：同样是 1000 条命令，fixture 13.5 ms、3006 元素页 55.6 ms、15006 元素页 88.3 ms（单命令有效成本 0.045→0.056→0.088 ms）。原因：32 并发把 loopback RTT（0.19–0.31 ms）摊掉之后，剩下的是浏览器侧在整棵 DOM 上做 `:nth-of-type` 选择器匹配的成本。
- **解析量与实际用量差 1.4×–4.6×**：fixture 解析 149 个、只落地 103 个 ref；1000/5000 行页解析 500 个、只落地 109 个。
- **500 节点页内上限**解释了为什么 1000 行与 5000 行页面的提取字节几乎相同（234.7 KB）：0.4 只看 DOM 顺序前 500 个可见节点，与页面规模无关。这既是 0.4 在超大页面上不爆炸的原因，也是"大页面靠后内容永远看不到"的语义限制。
- **没有 unchanged 快路径**：每次 observe 都是完整重来。0.3 重复 observe 0.20–0.22 ms。

---

## 3. 0.3 page-lib 路径拆解（钱花在哪）

0.3 是扩展 content script（`extension/manifest.json`：`injected/page-lib.js`，`world: ISOLATED`，`run_at: document_start`，`all_frames`），由 `extension/src/inject.js:15-28` 的 `pageCallFunc` 经 `chrome.scripting.executeScript`（`inject.js:96-117`）调用：

- 页内一次走查 + 一次渲染成文本行，refs 直接是页内元素句柄（`state.refs` Map + `state.elRefs` WeakMap，`page-lib.js:301-311`）。
- 返回 `{observation, refs, nodes:[], blocking, revision, mutations, stages}`（`page-lib.js:1901-1962`）。
- 三条现成快路径：`unchanged`（无 mutation 且参数与上次一致，`page-lib.js:1909-1921`）、`delta` 增量补丁（`1923-1942`）、`snapshot`（`1964-1967`）。
- 页内自带的 funnel 诊断（`stages`，`page-lib.js:655` 起）可直接看到 walk 分项。

实测（5000 行页，全量重建）：**29.0 ms 总计 = 页内 walk 27.8 ms + 传输/序列化 ~1 ms**；walk 内部：visibility 16.2 ms、stealth 11%（8.7 ms）、semantics 2.9 ms。可见 **0.3 的页内 walk 本身并不比 0.4 的页内提取快**（17.5 ms），0.3 快在"没有 ref 解析、回传只有 6.8 KB"。

0.3 的输出并不等价于 0.4：86/202/202 行、1032/2122/2122 tokens（0.3 无 token 预算），0.4 是 103/109/109 行、1200 token 预算（truncated=true）。**等预算下 0.3 的字节优势会更大。**

---

## 4. 方案 A：页内预提取 + 节点侧渲染的折中（不移植渲染器）

### 4.1 A1（推荐先落地）：只解析"会落地的行"的 ref

改动点：`snapshot-handlers.js` 的 `capture` —— 先 `renderVom(withRefs:false)` 拿到 rows，收集这些行的 nodeId，只对它们调用现成的 `resolveVomBackendIds`，再渲染一次带 refs。代码量 ~40–80 行 + 单测。

实测（`A2-lazy-refs` 行，2 轮收敛）：

| 场景 | 命令数 | p50 | p95 | 文本 | 一致性 |
| --- | --- | --- | --- | --- | --- |
| fixture | 298 → **254** | 26.5 → 20.3 ms | 44.8 → 57.2 ms | 3233 B，103 refs | `text` 与现状逐字节相同 |
| 1000 行 | 1002 → **302** | 75.6 → **42.0 ms**（−44%） | 89.4 → 64.4 ms | 2941 B，109 refs | 逐字节相同 |
| 5000 行 | 1002 → **302** | 118.1 → **67.1 ms**（−43%） | 167.6 → 74.1 ms | 2941 B，109 refs | 逐字节相同 |

- 收敛性：第 1 轮（无 refs）行数 128/150/150 ≥ 第 2 轮（有 refs）103/109/109 —— refs 让行变长、行数只减不增，所以是单调子集收敛；实测 2 轮，建议实现里加 3 轮上限 + 收敛断言。
- fixture 落在噪声区，**没有实际收益**：本批次 A1 20.3 < 现状 26.5，上一独立批次 A1 23.2 > 现状 19.6，两个方向都出现过，且 A1 的 p95 更差（57.2 vs 44.8）。小页面本来就只有 298 条命令，多出来的一次渲染（~1.7 ms）与省下的 22 条命令同量级。建议加阈值（如可寻址节点 < 64 时走原路）。

### 4.2 A2：压缩 payload（收益有限，单独做不值）

节点数组 470 B/节点里，颜色/字号/opacity/backgroundImage 是 0.4 渲染管线的**语义依赖**（`0.4/packages/vom/src/stealth.js:113-133` 用它们判 `opacity`/`font-size`/`transparent`/`zero-contrast` 并把子树重挂），不能直接删；删了就必须在页内算 stealth 标记，等于把渲染逻辑搬进页面。粗算：去掉 domPath + 颜色 + rect 之外的可选键最多省 40–50% 字节（235 KB → ~120 KB），对 p50 的影响 ~几 ms，**不如 A1 + A3 组合**。

### 4.3 A3（可选，与 A1 叠加）：objectId 替代 domPath

现状每个节点 2 条命令（select 器查询 + describeNode）。页内表达式可以直接把元素数组的 `objectId` 回传（`returnByValue:false` + 一个数组对象），再 `Runtime.getProperties` 一次拿到 N 个元素 objectId，然后 N 次 `DOM.describeNode{objectId}` → 命令数 2N+N→**N+2**（1002 → 502）。预计再省 20–35% 的 ref 解析时间。需验证 objectId 生命周期与失效处理（失败只少一个 ref，与现状 `safeSend` 语义一致）。

---

## 5. 方案 B：页内快路径（0.3 形态）—— 收益最大，但成本/冲突也最大

### 5.1 收益（实测）

- 延迟：2.7 / 9.7 / 29.0 ms（p50），相对现状 **−9.8× / −7.8× / −4.1×**。
- 字节：4.0 / 6.8 / 6.8 KB，相对现状 **−26× / −47× / −47×**。
- 往返：1 条 CDP 命令（现状 298/1002/1002）。
- 额外：0.3 结构里现成的 unchanged / delta 快路径，重复 observe **0.2 ms**，这是 0.4 目前完全没有的能力（agent 循环里 observe 往往重复调用）。
- 稳定性收益同样重要：延迟不再随 DOM 规模三分段恶化（1000 行与 5000 行都是 1 条命令、同一量级），因为选择器匹配不再发生。

### 5.2 冲突点（按阻塞程度排序）

1. **ref 模型不兼容（最硬）**：0.4 ref 是 `bn<backendNodeId>`（`vom/src/render.js:201-205`，`refOf` 只认 `backendNodeId`/`stableRef`），动作链靠它走 `DOM.scrollIntoViewIfNeeded` / `DOM.getBoxModel` / `Input.dispatchMouseEvent`（`pointer.js`、`resolve.js`）。0.3 ref 是页内 `@eN` 句柄，动作在页内派发（`page-lib.js:301-311` / `90-dispatch.part`）。页内渲染要保留 0.4 动作链，就必须在页内维护 `ref → 元素` 表并在动作时映射回 backendNodeId（每次动作 +1~2 条命令），或改成 CDP `objectId` 句柄（`DOM.describeNode{objectId}` 可取 backendNodeId，可行但需要句柄生命周期管理）。
2. **隔离世界**：0.3 依赖扩展 content script 的 ISOLATED world；0.4 的 CDP-only 模式下 `Runtime.evaluate` 在主世界执行，页面脚本可篡改全局/DOM API。原型必须用 `Page.createIsolatedWorld` + 在该 executionContextId 里注入 bundle，并验证 `document`/`getComputedStyle` 正常工作。
3. **渲染管线要移植**：0.4 的观察语义分散在 `vom/src/`：`render.js` 38.6 KB、`active-region.js` 21 KB、`tokens-o200k.js` 17 KB、`layers.js` 11 KB、`identity.js` 9.5 KB、`affordance.js` 9.3 KB、`table-fold.js` 8.7 KB、`recover.js` 9.6 KB、`stealth.js` 6.4 KB、`context.js` 5.3 KB、`budget.js`/`tokens.js`/`tree.js`/`visual.js`/`drag.js`/`funnel.js`/`semantic-graph.js`（合计 ~150 KB 源码）。移植后要保证 layers/遮挡、stealth、affordance、context 消歧、table fold、activeRegion、viewportPolicy、funnel、stableRef 协商全部语义不变。
4. **构建步骤**：0.4 目前是纯 ESM、无打包器（`extension-ingress` 是文件拷贝 + `scripts/build-extension-ingress.mjs`，不涉及打包）。页内 bundle 需要新增"多 ESM → 单 IIFE"的构建（0.3 有先例：`tools/build-page-lib.mjs` 拼接 `injected/parts/*.part`，但那是手写分块，不是 ESM 剥离）。
5. **cursor/分页语义**：0.4 的 `observe` cursor 是"行流偏移"（`vom/src/observe.js:126-171`、`render.js:221-235`），续页要重放完整行流。页内渲染要么每次都重走 DOM，要么在页内缓存行流并做失效判断；这与 0.4 `cursor` 不绑定 DOM 快照的约定（`observe.js:132-134`）需要重新对齐。
6. **跨源 iframe / OOPIF**：0.4 单次 evaluate 只能读同源 iframe（`vom-extract.js:141-158` 的 `contentDocument` 分支，跨源吞掉）；0.3 用 `all_frames` content script 天然覆盖跨源。CDP-only 下页内快路径要按帧建立 isolated world + 注入，覆盖面必须逐个 OOPIF 验证。
7. **注入暴露面**：页内跑 ~150 KB 渲染器会带来长任务与更多可被反爬探测的页内痕迹（现在只有一次 9.3 KB 的提取表达式）。对 0.4 的 stealth 定位是实打实的成本。

### 5.3 成本估算

- 最小可用原型（只求 3 个页面 `text` 等价 + ref 可动作）：**3–5 人日**（isolated world 0.5、bundle 构建 1、页内渲染接线 1、ref 映射 1、验证/对比 1）。
- 全量语义对齐（含 layers/activeRegion/stableRef/cursor/跨帧）：不是本周能完成的范围，建议在产品侧先确认"0.4 是否允许页内渲染器"这个架构问题。

---

## 6. 方案对比与结论

| 维度 | 0.4 现状 | A1 懒解析 ref | A3 objectId | 0.4 `vom_refs:false`（私有开关） | B 页内快路径 |
| --- | --- | --- | --- | --- | --- |
| p50（fixture/1000/5000） | 26.5 / 75.6 / 118.1 ms | 20.3 / 42.0 / 67.1 | 预计 18 / 35 / 55 | 6.8 / 17.4 / 17.5 | **2.7 / 9.7 / 29.0** |
| CDP 命令 | 298 / 1002 / 1002 | 254 / 302 / 302 | ~130 / ~510 / ~510 | 1 | **1** |
| 回复字节 | 103 / 322 / 323 KB | 99 / 264 / 264 KB | 预计 ~75 / 235 / 235 KB | 74 / 235 / 235 KB | **4.5 / 8.0 / 8.0 KB** |
| refs 可用 | 全量 | 全量（等价） | 全量 | **无**（动作退化到 rect 中心/DOM.getNodeForLocation） | 需重做映射 |
| unchanged 快路径 | 无 | 无 | 无 | 无 | **有（0.2 ms）** |
| 改动范围 | — | `snapshot-handlers.js` + 单测 | + `vom-extract.js` 新出口 | 无需改动（开关） | 页内 bundle + ref 模型 + 构建 |
| 风险 | — | 低（两轮渲染、收敛断言） | 低–中（objectId 生命周期） | 中（动作精度下降） | 高（§5.2 七点） |
| 估计成本 | — | 0.5–1 人日 | 0.5–1 人日 | 0 | 3–5 人日（原型） |

结论：

- **做 A1（+ 可选 A3），不做"整套 page-lib 平移"。**
  - 收益/成本比最好：A1 在 1000/5000 行页 −43% 延迟、命令 −3.3×、文本逐字节一致；只动一个函数 + 单测，不引入构建、不改协议。A3 可再砍一半 ref 命令。
  - A1 对 fixture 类小页面是噪声级负收益，实现时按可寻址节点数加阈值回退。
- **B 不是"移植 0.3 的 page-lib"，而是"在 0.4 里新建页内渲染器"**：0.3 的渲染语义与 0.4 VOM 不同（行格式、无 cursor/分页、无 stableRef、无 activeRegion/layers），直接平移会造成两套语义并存，协议与测试都会崩。若要做，按 §7 的 B 清单立独立 spike，且必须先过三个硬门槛：`Page.createIsolatedWorld` 注入可用、页内 `ref → backendNodeId` 按需映射可行、cursor 分页语义可对齐。
- **不做**："为了快路径改默认动作链为几何点击"（`vom_refs:false` 的下限虽快 4–7×，但丢掉 ref 后可寻址性/遮挡/滚动语义全退化，只能当诊断开关）。

---

## 7. 下一步最小原型清单

### A1（建议下个迭代就做，0.5–1 人日）

1. `snapshot-handlers.js` 的 `capture` 增加 `lazyRefs` 路径：`renderVom(withRefs:false)` → 取 `rows[].nodeId` → 仅对"有 domPath 且无 backendNodeId"的落地节点 `resolveVomBackendIds` → 重渲染 `withRefs:true`；最多 3 轮，未收敛时退回现状全量解析（安全阀）。
2. 阈值：可寻址节点 < 64 走原路（fixture 上 A1 无收益）。
3. 验收：三个 fixture 上 `text` 与现状逐字节相等（本次 spike 3/3 通过）；CDP 命令数 ≤ 现状 1/2；1000/5000 行页 p50 ≤ 现状 0.75×；`SnapshotResult`/`ObserveResult` 形状不变；`refs` 数一致。
4. 单测：只解析落地行、收敛轮数、未收敛回退、resolve 失败只少 ref 不报错。

### A3（可与 A1 同期，0.5–1 人日）

5. 提取表达式改成返回 `{nodes, handleObjectId}`（元素数组对象），`Runtime.getProperties` 取元素 objectId，`DOM.describeNode{objectId}` 取 backendNodeId；失败回退现行 domPath 路径。
6. 验收：命令数从 2N 降到 ~N+2；backendNodeId 与现行路径逐节点一致；objectId 失效（导航/重算）时不抛错。

### B（独立 spike，3–5 人日，先过门槛再接线）

7. `Page.createIsolatedWorld` 拿 `executionContextId`，注入一个 20 行探针（读 `document.title`、`getComputedStyle`、`document.body.children.length`），证明隔离世界里 DOM 读取正常、主世界不可见。
8. 写 `0.4/scripts/build-page-bundle.mjs`：把 `0.4/packages/vom/src/*`（含依赖顺序）剥掉 `import`/`export` 拼成单 IIFE（参考 `tools/build-page-lib.mjs` 的拼接思路，输出到 `0.4/dist-*`，不碰 0.3）。
9. 页内 `renderVom` 接线：页内返回 `{text, rows, refs:[{ref, handle}], tokens, truncated, nextCursor}`；daemon 侧用 `DOM.describeNode({objectId})` 按需回填 backendNodeId，保证 0.4 动作链零改动（ref 字符串仍是 `bn<id>`）。
10. 验收门槛（不过就停）：三个页面 `text` 等价或有明确语义解释；p50 ≤ 现状 0.35×；CDP 命令 = 1 + 落地 refs 数；OOPIF/跨源 iframe 与现状一致；isolated world 里渲染器无主世界可见副作用。
11. 风险登记：页内长任务（5000 行页 ~28 ms）、注入检测面、cursor 分页需要页内行流缓存与失效策略。

---

## 8. 测量限制（必读）

1. **链路与真实产品不同**：这里是 loopback CDP over WebSocket；真实 0.4 daemon → 扩展（`chrome.debugger`）/用户浏览器 每跳会多 0.5–2 ms。绝对数字偏高，但相对比例（2N 命令 vs 1 命令、235 KB vs 7 KB）不随链路改变。
2. **机器负载**：运行期间用户浏览器与其他进程在跑，两次独立运行在 fixture 与 5000 行页上有 ≤20% 波动（p95 更敏感）。第二次复测：0.4 现状 19.6 / 78.3 / 138.4 ms，A1 23.2 / 46.6 / 82.5 ms，0.3 3.3 / 10.9 / 30.2 ms。结论方向一致，绝对值请当作"同机同批次的相对量级"。
3. **合成页偏理想**：1000/5000 行页每行结构相同、全部可见、无伪元素/transform/虚拟滚动；真实站点 DOM 混合度更高，0.4 的 500 节点上限与 0.3 的 offscreen(5000px)/stealth 裁剪行为差异会更大。
4. **0.4 的 500 节点页内上限**：1000 行与 5000 行页面的提取结果都是 500 节点，两者提取字节相同；0.4 的耗时差来自 ref 解析时选择器匹配成本随 DOM 规模上升，不代表提取变慢。
5. **0.3 侧测量含"注入后 1 次 evaluate"**：page-lib 由 content script 在 document_start 注入是常态化的一次性成本；本测量不含扩展消息转发与 daemon 往返，也不含扩展安装/版本差异。
6. **输出不等价**：0.3 无 token 预算（2122 tokens/202 行），0.4 默认 1200 tokens/109 行。字节对比时 0.3 的输出更多，等预算下优势还会扩大，但不能直接当作"同内容成本"。
7. **未跑阶段门**（按任务约束），本文件是评估结论，不构成发布证据。
