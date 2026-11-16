# 第三层实测：行为与验证码（Spiderbuf 靶场）

> 实测时间：2026-11-16 15:28–15:45。环境同前：Edge 157 + BridgeDeck 0.1.3（按需注入改造后）、未登录、出口 IP `110.80.15.22`。
> 用靶场而不是真实站点：真实平台在未登录态直接给登录墙（见 [国内平台实测](ANTI-BOT-LAYER3-DOMESTIC.md)），拿不到行为验证的样本。
> 原始数据：`.tmp-bench/layer3/`（截图、DOM 快照）。

## 1. 结果

| 挑战 | 类型 | 结果 | 说明 |
| --- | --- | --- | --- |
| C14 主流模拟浏览器检测对抗 | 静态环境检测 | **通过** | 抓到 12 条 CPC 数据，算得均值 34.14，提交后返回"恭喜你答对啦！" |
| C02 拖拽式滑块验证码 | 滑块（位移校验） | **通过** | 300px 轨道，`drag --dx 250` 一次过 |
| C04 用户行为检测反爬虫 | 行为门（"我不是爬虫"） | **未通过** | 三种点法全部无效，命中点经 `elementFromPoint` 验证无误 |

## 2. C14：真实浏览器天然通过

靶场给的是 12 张卡片（`.data-cpc`），要求算 CPC 列平均值的两位小数。

```
cps: 47.8 41.35 36.5 34.2 27.95 23.7 30.1 44.9 38.65 22.45 35.8 26.3
sum: 409.7   avg: 34.1417 → 34.14
```

提交（`input[name=answer]` + `提交验证`）后页面返回 **"恭喜你答对啦！"**。

意义有限但值得记：C14 是专门检测 selenium/playwright/puppeteer/phantomjs 痕迹的题，我们用真实 Edge + 桥驱动，它没有把我们判成模拟浏览器。这和第一层 rebrowser/pixelscan 全绿的结论一致——**这类检测对付的是"用自动化框架启动的浏览器"，不是"用工具操作的真实浏览器"**。

## 3. C02：滑块只校验位移，不校验轨迹

轨道 300×50，滑块 50×50，所以终点位移是 250px。两次实验：

| 手法 | 拖拽时长 | 轨迹点数 | 结果 |
| --- | --- | --- | --- |
| 默认 hold 模式 | 900ms | 8 | 数据加载成功（21 行机票价格） |
| 重新加载后再拖 | **80ms** | 8 | 数据同样加载成功 |

**80ms 内 8 个点的直线拖拽照样过。** 也就是说 C02 的服务端只比对最终位移（可能附带最小耗时），没有校验速度曲线、微停顿、过冲修正。

这与"滑块一定要贝塞尔轨迹"的常见说法不符：**要不要做轨迹建模，取决于目标站点校验了什么，不是所有滑块都看轨迹。** 先测出校验项，再决定要不要写轨迹生成器，否则是在给不需要的地方加成本。

## 4. C04：行为门是目前真实过不去的地方

页面上只有一个"我不是爬虫"复选框。三种打法：

| 尝试 | 方式 | 结果 |
| --- | --- | --- |
| 1 | `click @e13`（页面内 JS 点击） | 未勾选 |
| 2 | `click @e13 --trusted`（CDP 原生鼠标事件，含 mouseMoved→Pressed→Released） | 未勾选 |
| 3 | `hover @e13 --trusted` 后停 400ms，再 `--trusted` 点击 | 未勾选 |

排除了"点歪了"这种解释：

```js
elementFromPoint(389, 428) === document.querySelector('#captcha')   // true
// 命中元素 rect = {x:369, y:408, w:40, h:40}，点击坐标正中间
```

点击确实落在了控件上，页面仍然不认。剩下的解释只有一个：它在等一段**看起来像人的输入历史**——移动轨迹、时间间隔、悬停顺序之类，而单次点击（哪怕带一个 hover）不构成这段历史。

我在这里停手：再往下就是"伪造一条足够像人的轨迹去过行为门"，那已经属于绕过人机验证，不是"测试环境是否被识别"。把它记为能力边界更诚实。

## 5. SpiderDemo 验证码实测（注册账号后）

Spiderbuf 只有滑块，SpiderDemo 才是真·验证码题库（注册后才能进）。`tools/captcha-probe.ps1` 会自动点「下一页」触发验证码，再读题型与指令，**不解题**：

| 题 | 触发后指令 | 形态 | 自动化需要 |
| --- | --- | --- | --- |
| 滑动拼图 | 请拖动滑块完成拼图 | 轨道 302px / 滑块 30px + base64 背景图 | 缺口在背景图的哪一列 |
| 滑动刮刮乐 | 使至少 1 个**火箭**完整出现后松开 | 轨道 350px / 滑块 36px + 涂抹层 | 认出目标物体并刮到露出 |
| 第二代（含随机滑块） | 拖动滑块完成验证 | 自绘滑块 | 位置 |
| 双滑块 | 拖动滑块 1 到正确位置 → 滑块 2 到正确位置 | 两个滑块 | 两个位置 |
| 圆柱 / 弧度 | 拖动滑块完成验证 / 沿弧形轨道拖动滑块 | canvas | 沿弧线的轨迹 + 角度 |
| 按压旋转 | 按住使图片回正 | 图片 + 按住拖拽 | 角度 |
| 点选 | 请依次点击：…（重置 / 换一张 / 验证） | 图片 | 若干坐标 + 顺序 |
| 点击拼图 | 提交 | 图片 | 坐标 |
| 第一代 / Gif / 计算题 | 🔄 验证并获取数据 | 输入框 + 图片验证码 | 看图识字符/算术 |
| 无感验证码 | （无文案） | 静默 | 环境评分，无手势 |

几个实测细节：

- **目标物体每次随机**：同一题连续三次刷新，刮刮乐的要求分别是「飞机」「轮船」「火箭」。想靠固定答案过的思路直接作废。
- **输入通道自检**（`-ChannelCheck`，拖 100px 后量滑块残留位移）：刮刮乐 `moved 62px`、滑动拼图 `moved 8px`。两次都动过，说明**事件确实到达了控件**；松开后被页面复位，说明位置不对被拒。所以瓶颈不是"发不出鼠标事件"，而是"不知道该发到哪"。
- **验证码是翻页闸门，不是入口闸门**：首屏直接渲染 10 个数字（第 1 页免验证），点「下一页」才弹验证码。只抓首页的话根本不会触发它。

## 6. 手势可行性矩阵（三种手势 × 六种题型）

既然"不知道该往哪拖"是瓶颈，那就换个问法：**页面到底受理哪种手势？** `tools/captcha-gesture-matrix.ps1` 对每题依次试三种手势，只记录页面自己的反馈（失败文案 / 滑块是否复位 / 第 2 页数字是否出现）。

| 题型 | teleport（JS 改值 + 合成事件） | fast（CDP 80ms） | slow（CDP 2000ms） |
| --- | --- | --- | --- |
| 滑动拼图 | 位移 200px，**无任何反馈** | `验证失败，请重试` | `验证失败，请重试` |
| 滑动刮刮乐 | 位移 198px，**无任何反馈** | `验证失败，请重试` | `验证失败，请重试` |
| 圆柱验证码 | 位移 200px，**无任何反馈** | `验证失败` | `验证失败` |
| 第二代验证码 | 位移 200px，**无任何反馈** | 无反馈、位移 0 | 无反馈、位移 0 |
| 第二代（随机滑块） | 位移 200px，**无任何反馈** | 无反馈、位移 0 | 无反馈、位移 0 |
| 双滑块验证码 | 位移 200px，**无任何反馈** | 无反馈、位移 0 | 无反馈、位移 0 |

三条结论：

1. **合成事件一律不被受理。** `teleport` 把滑块真的移到了 200px、也派发了 mousedown/mousemove/mouseup，但页面**一个字都不回**——既不通过也不报错。说明这些控件只认真实指针流（trusted events / pointerId 序列），纯 JS 改 DOM 值等于没发生。**"用 JS 直接设滑块位置"这条捷径在 SpiderDemo 上完全不通。**
2. **真实指针流会被受理并校验。** `fast` / `slow` 都拿到了明确的 `验证失败` 文案，滑块随后复位。这正是我们要的证据：通道有效、校验在跑。
3. **速度差异无法从错误位置里分离。** 80ms 和 2000ms 得到同一个结果，因为位置本来就是错的；要回答"轨迹形状是否被校验"，必须先有正确目标位置。这是本矩阵的**测量局限**，不是"证明不校验轨迹"。

> 顺带解决了一个实现细节：各题滑块类名不统一（`#sliderMoveBtn`、`.slider-btn`、…），探针改成"按宽度 10–90px 猜把手并临时打 id"，六种题型一次跑通。

## 6.1 驱动矩阵工具与"候选必须可点"的修复

本轮新增 `tools/captcha-drive-matrix.ps1`：每题只发一次刻意无解的拖拽/点击，记录通道是否被受理（`rejected` / `no-feedback` / `advanced`）。跑的过程中暴露了一个**真实缺陷**，比矩阵本身更有价值：

**视觉候选会指向"点不到的副本"。** 拼图页的 `visuals` 同时返回了 `#captchaImage`、`.slider` 等多个候选，其中有的矩形看起来正常（300×92），但按它的中心派发时，`elementFromPoint` 返回的是**另一个元素**——页面里存在同名的隐藏/模板副本。按这种候选算出来的坐标会"打到空气"，表现为：拖拽成功返回、页面毫无反应、把手一动不动（复位后看不出痕迹）。

修复（page-lib v42）：`visualScan` 在收录候选前先做**中心点命中测试**——`document.elementFromPoint(cx, cy)` 必须落在候选自身、其子树或祖先链上，否则丢弃；同时补上 `opacity: 0` 过滤。

```js
const hitSelf = top === el || el.contains(top) || top.contains(el);
if (!hitSelf) return;   // 点不到的候选（模板/隐藏副本）不列出来
```

这条与派发前的 `verifyVisualHit` 是一对：**扫描时保证候选可点，派发时保证落点归属**。缺任一条，坐标都会静默打偏。

矩阵工具本轮只做通烟测试（2 例），未产出完整数据——因为上述缺陷导致前几次的"无反馈"是假象，需重载扩展后重跑。工具本身已可作为回归入口。

### 6.1.1 2026-11-16 重跑：3 轮 × 6 题型（按题型换手势）

上一轮的结论是"另三个题型只是当前手势没覆盖到"。这一轮把矩阵按题型拆开：按压旋转换成长按按钮（`drag .press-btn --hold 800ms --trusted`），点击拼图换成分块点选 + 点「提交」，双滑块两个手柄依次拖。判定仍是"至少一次被受理"，每次都保留：

| 题型 | 三次判定 | 结论 |
| --- | --- | --- |
| 滑动拼图 | `rejected / rejected / rejected` | 通道已验证（每次 `验证失败 / 请重试`） |
| 滑动刮刮乐 | `rejected / rejected / rejected` | 通道已验证（每次 `验证失败 / 请重试`） |
| 圆柱验证码 | `rejected / advanced / rejected` | 通道已验证；某轮 dx=60 恰好拼合，`验证成功` 且页码推进 |
| 按压旋转 | `rejected / rejected / rejected` | **首次通道已验证**（`验证失败，请重试`） |
| 点击拼图 | `rejected / rejected / rejected` | **首次通道已验证**（点提交后 `验证失败，请重试`） |
| 双滑块 | `no-feedback / no-feedback / no-feedback` | 手柄可驱动、错位不判定（见下） |

```
channel-verified=5  never-reacted=1  mixed=0   → tests/anti-bot/captcha-drive-baseline.json
```

**为什么前两题这轮才有反馈（机制，不是运气）：**

- 按压旋转的控件是 **`.press-btn` 按钮**，不是题图。在 `#captchaImage` 上按下/长按，页面一个事件都不处理；按住按钮才会出现 `#fill` 进度与图片旋转，松开后判定。
- 点击拼图 `visuals` 返回的是 **4 块 140×140 的 `.piece`**（每块点一次转 90°），不是整张 280×280 图。要不同候选各点一次，再点 **`.submit`**；判定文案在点提交后约 1.2s 才出现、只活约 0.5s。
- 双滑块两个手柄都能被拖（位移可见、对应拼图块跟着走），但错位时页面**不判定**；只有拼合正确才推进。所以它的 `no-feedback` 表示"手势被受理、但没有可观测判定"，不等于通道不通。

**这一轮修正的两个测量错误：**

1. **单点采样会漏判定。** 原来的矩阵在动作后 900ms 查一次页面，点击拼图的文案 1.2s 才出、0.5s 就换掉，必然漏。现在动作后按 300ms 粒度采一个窗口（最多 2.4s），命中失败/成功文案、题图换图、页码推进、`正在加载验证码` 任一即停。
2. **页码正则取错数。** 旧的 `当前页\s*(\d+)` 实际匹配到"总页数 30"，永远读成第 30 页，`advanced` 判不出来；改用 `第 N 页，共 M 页` 与"已采集页数"前面的数字。

另外记录一个待修缺陷：`drag --hold` 的**非可信路径**（`extension/injected/page-lib.js` 的 `actionDrag`）把 `sleepMs(holdMs)` 放在 `pointerdown` 之前，等于"先等 800ms 再按下"，长按根本不发生；可信路径（`trustedDrag`）是先按下再等，顺序正确。矩阵的长按走 `--trusted`，所以本轮数据不受影响；根治要改 page-lib、同步 bump 版本并重载扩展。

> 关于第 6 节表里"合成事件一律不被受理"：那一条的 teleport 是"直接改 `transform` + 对元素派发鼠标事件"。本轮滑块/双滑块走的是 page-lib 的**带坐标指针序列**（仍是非可信事件），页面照样受理并判定。受理与否取决于控件与事件形态，不能概括成"非 CDP 一律无效"。

## 7. 对项目的结论

1. **静态、滑块两类，桥现在就能过**（C14、C02）。C02 说明滑块的成本可能远低于预期——先测校验项。
2. **行为门（C04）过不去**，且不是"再加点抖动"能解决的：它要的是一段交互历史，而不是一个动作。可行的正路是 `request-help` 让人点一下，或者接受"这条链路必须有人"。
3. **图像型验证码的瓶颈不在通道**：SpiderDemo 实测证明原生拖拽能驱动滑块，卡住的是"缺口/角度/目标物体在哪"。要往前走就得引入视觉识别，那是另一个课题，也越过了当前边界。
4. **验证码是闸门位置问题**：这类站的验证码挂在翻页/详情上，首页往往不触发。做"能不能过"的评估前，先确认你有没有真的踩到闸门。
5. **靶场适合当回归集**：C01→C15 有编号、有判定、无封号风险。建议把 C14/C02/C04 这三条固化成回归用例（一个通过、一个通过、一个预期失败），比拿真实平台做回归可靠得多。

## 8. 复现

```powershell
node cli/bridge.mjs session start --browser <instanceId> --no-focus --json
node cli/bridge.mjs navigate "https://spiderbuf.cn/challenge/anti-simulate-web-browser" --session <sid>
# 读 .data-cpc 求均值 → 34.14
node cli/bridge.mjs navigate "https://spiderbuf.cn/challenge/verify/anti-simulate-web-browser" --session <sid>
node cli/bridge.mjs fill '@e10' --value 34.14 --session <sid>
node cli/bridge.mjs click '@e11' --session <sid>          # → 恭喜你答对啦！

# 滑块（C02）：轨道 300 / 滑块 50 → dx=250
node cli/bridge.mjs navigate "https://spiderbuf.cn/challenge/scraper-practice-c02" --session <sid>
node cli/bridge.mjs drag '#slider' --dx 250 --duration 80ms --session <sid>

# 行为门（C04）：预期失败，别反复刷
node cli/bridge.mjs navigate "https://spiderbuf.cn/challenge/scraper-practice-c04" --session <sid>
node cli/bridge.mjs click '@e13' --trusted --session <sid>

# SpiderDemo 验证码题型识别（需先登录）+ 输入通道自检
powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-probe.ps1 -Browser <instanceId>
powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-probe.ps1 -Browser <instanceId> -Filter 'slide|puzzle' -ChannelCheck

# 手势可行性矩阵（teleport / fast / slow × 各题型）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-gesture-matrix.ps1 -Browser <instanceId>
powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-gesture-matrix.ps1 -Browser <instanceId> -Filter 'cap4|cap5|cap6|cylinder'
```

产出：`.tmp-bench/captcha/captcha-types.json`（题型 / 指令 / 几何 / 通道自检）、`.tmp-bench/captcha-gesture/gesture-matrix.json`（三手势 × 各题型的受理结果）。
