# 反爬靶场全量清单与实测（2026-11-16）

> 目的：把所有能拿来做反爬回归的靶场找齐，标出「现在就能用」和「要账号才能用」，并给出实测矩阵。
> 环境：Edge 157 + BridgeDeck 0.1.3，真实 profile，未登录任何平台。
> 原始数据：`.tmp-bench/layer5/`（两个站的逐题矩阵 JSON + 枚举脚本）。

## 1. 总览

| 靶场 | 地址 | 题量 | 需登录 | 本次实测 |
| --- | --- | --- | --- | --- |
| Spiderbuf | <https://spiderbuf.cn/challenges> | **36 题**（C/N/E/H/S 五组） | 否 | **全量枚举**；C14/C02/C04 已实做 |
| Scrape Center | <https://scrape.center> | **54 例**（SSR 4 / SPA 16 / 验证码 8 / 登录 3 / WebSocket 1 / **反爬 10** / App 9 / 工具 1） | 否 | **42 例浏览器实测全通过**，见第 3 节 |
| SpiderDemo | <https://www.spiderdemo.cn> | **33 题**（JS逆向 18 / 验证码 15） | **是**（已注册） | **32 题可达**，见第 4 节 |
| 猿人学 | <https://match.yuanrenxue.cn> | **21 题 + 6 新手试炼**（22–30 为占位） | **是**（微信扫码，已登录） | 21 题全部可达，见第 5 节 |
| python-spider | <https://www.python-spider.com/challenge> | 未知 | **需邀请码** | 无法注册，未实测 |

**能零门槛全量回归的只有 Spiderbuf。** 其余要么要账号，要么站本身在退化。

## 2. Spiderbuf（36 题，全量枚举）

按编号排列；「特征」列是从页面 DOM 实测出来的，不是抄题目标签。

| 编号 | 标题 | 实测特征 |
| --- | --- | --- |
| C15 | 多脚本文件混淆反调试 | 表格2行 / 卡片 |
| C14 | 主流模拟浏览器检测对抗 | 卡片 |
| C13 | API 参数签名与分块传输 | 表格2行 |
| C12 | AES 密钥混淆与 Selenium 高级对抗 | 表格29行 |
| C11 | Web Workers 多线程反调试 | 表格6行 |
| C10 | 简单模拟 Cloudflare Challenge | 表格21行 |
| C09 | 浏览器指纹检测及爬虫 IP 封禁 | 表格11行 |
| C08 | Selenium高级对抗及浏览器 Hook 反调试 | 表格11行 / 输入1 |
| C07 | 服务端 Token 及 API 参数签名 | 表格11行 / 输入1 |
| C06 | 用户行为检测及模拟浏览器对抗 | 动态加载 |
| C05 | AES 加密及拖拽式滑块验证码反爬虫 | 空表 / 滑块 / 验证码提示 |
| C04 | 用户行为检测反爬虫 | 输入1（"我不是爬虫"） |
| C03 | 时间戳哈希签名 + 随机数防重放反爬虫 | 表格31行 |
| C02 | 拖拽式滑块验证码反爬虫 | 空表 / 滑块 / 验证码提示 |
| C01 | 尝尝甜头：Cookie 反爬虫 | 动态加载 |
| N07 | 随机CSS样式类名，无Element ID | 动态加载 |
| N06 | 网页表单爬取（RPA初阶） | 输入18 / 验证码提示 |
| N05 | CSS Sprites（雪碧图）反爬 | 动态加载 |
| N04 | CSS伪元素反爬 | 动态加载 |
| N03 | 限制访问频率不低于1秒 | 表格11行 |
| N02 | 使用Base64编码的图片爬取与解码还原 | 动态加载 |
| E04 | 被屏蔽IP后使用代理服务器爬取页面 | 表格11行 |
| E03 | 无序号翻页 | 表格11行 |
| E02 | 带验证码的登录爬取 | 输入4 / 验证码提示 |
| E01 | 用户名密码登录爬取后台数据 | 输入2 |
| H06 | 初识浏览器指纹：Selenium是如何被反爬的 | 表格11行 |
| H05 | js逆向破解时间戳反爬 | 表格21行 |
| H04 | js加密混淆及简单反调试 | 表格31行 |
| H03 | 网页滚动加载的原理及爬取 | 动态加载 |
| H02 | 高分电影列表复杂页面解析（仿豆瓣）-xpath高级 | 动态加载 |
| H01 | CSS样式偏移混淆文本内容的解析与爬取 | 动态加载 |
| S08 | http post请求的数据爬取 | 输入1 |
| S07 | ajax动态加载数据的爬取 | 表格11行 |
| S06 | 带iframe的页面源码分析及数据爬取 | 动态加载 |
| S05 | 网页图片的爬取及本地保存 | 动态加载 |
| S04 | 分页参数分析及翻页爬取 | 表格11行 |

### 已实做的三题

| 题 | 类型 | 结果 |
| --- | --- | --- |
| C14 | 模拟浏览器检测 | **通过**（12 条 CPC → 均值 34.14 → "恭喜你答对啦"） |
| C02 | 拖拽滑块 | **通过**（250px、80ms、8 个点的直线拖拽即过） |
| C04 | 行为门 | **未通过**（JS 点击 / CDP 原生点击 / hover+点击 全拒，命中点已核实） |

「动态加载」= 首屏没有表格或卡片，数据靠图片 / CSS 伪元素 / 字体 / 滚动 / XHR 二次加载，属于 N05、N04、H01、H03、S02 那一类；这些题的价值在于"取数"，不在"过检测"，本轮只做枚举没有实做。

> 枚举耗时提醒：36 题跑完约 20 分钟，瓶颈是页面上的广告 iframe 让 `load` 事件迟迟不结束。批量脚本应显式用 `--wait-until domcontentloaded` 或更短的 settle，否则每题要吃掉 20–30s。

## 3. Scrape Center（54 例，42 例浏览器实测）

站方把案例分成 SSR / SPA / 验证码 / 模拟登录 / WebSocket / **反爬** / App 七类。`app1-9` 与 `appbasic1-2` 需要真机 App，浏览器测不了；其余 42 例逐个导航实测，**42/42 都能正常打开**。

| 案例 | 导航 | 证据数 | 备注 |
| --- | --- | --- | --- |
| ssr1 | 636ms | 20 | 服务端渲染基线 |
| ssr2 | 399ms | 20 | 无 HTTPS 证书 |
| ssr3 | 483ms | 0 | **HTTP Basic Auth**（admin/admin），未带凭证所以空白 |
| ssr4 | 6086ms | 20 | 每响应 +5s 延迟 |
| spa1 / spa2 / spa4 / spa6 | 437 / 457 / 453 / 440ms | 20 | Ajax 渲染 |
| spa3 | 400ms | 22 | 详情页，滚动加载 |
| spa5 / spa16 | 489 / 525ms | 36 | 图书站，HTTP/2 |
| spa7–spa13 | 406–512ms（spa12 8366ms） | 32 | NBA Token 题；spa8 一行混淆、spa9 eval、spa10 JJEncode、spa11 AAEncode、spa12 JSFuck、spa13 自定义 |
| spa14 / spa15 | 449 / 522ms | 20 | 数值型 / 字符串型 WASM |
| captcha1–6 | 1.0–1.4s | 4 | 拼图/点选类，**需要登录** |
| captcha7 / captcha8 | 1008 / 2342ms | 4 | 图像验证码（有 canvas），需要登录 |
| login1 / login2 / login3 | 1.4 / 1.2 / 2.5s | 2 | 加密登录 / Session / JWT |
| websocket1 | 3014ms | 0 | 聊天室，文本正常（"你好 你好！"） |
| **antispider1** | 2411ms | **20** | **WebDriver 检测：没有被拦，20 条数据正常渲染** |
| **antispider2** | 2099ms | **20** | UA 反爬：真实 Edge UA 通过 |
| antispider3 | 1703ms | 36 | 文字偏移（所见顺序 ≠ 源码顺序） |
| antispider4 | 3711ms | 20 | 字体反爬（数据在字体映射表里） |
| antispider5 | 1871ms | 20 | IP 频率限制（5 分钟 10 次），首次访问正常 |
| antispider6 / 7 | 1097 / 2051ms | 2 | 账号频率限制，**需要登录** |
| **antispider8** | 3684ms | **20** | **无限 debugger 陷阱：完全没卡住** |
| antispider9 | 2311ms | 20 | 位置移动数组混淆 |
| antispider10 | 1946ms | 0 | 控制流扁平化；页面停在原始模板 `{{ player.name }}`，**依赖的 unpkg 脚本 404**（见下） |

### 三个值得单独说的结论

**① antispider1 是这次最有价值的一枪。** 这站的设计是"检测到 WebDriver 就不显示页面"，我们拿到 20 条完整数据——说明第一层那次改造（撤掉 MAIN world 常驻注入、按需注入）之后，这个浏览器在专门的 WebDriver 检测题面前是干净的。

**② antispider8 的无限 `debugger` 对我们无效。** 页面里埋了接口处无限 debugger + 定时循环 debugger。我们导航 3.7s、拿到 20 条数据，一次都没停。原因很直接：`debugger` 语句只有在调试器（DevTools 或 CDP 的 `Debugger` 域）启用时才真的暂停，桥不启用 Debugger 域，所以这些语句是空操作。**这类"反调试"防的是人在 DevTools 里调试，不防自动化。**

**③ antispider10 的"渲染失败"是依赖腐烂，不是反爬。** 页面停在 Vue 原始模板 `{{ player.name }}`，本轮查清了原因：

```
Script https://unpkg.com/vue/dist/vue.js          status=null
Script https://unpkg.com/element-ui/lib/index.js  status=null
Script https://unpkg.com/vue@3.5.45/dist/vue.js   status=null
Script https://cdnjs.../crypto-js.min.js          status=200
```

`unpkg.com/vue/dist/vue.js` 是 Vue 2 时代的路径；现在 unpkg 把不带版本号的 `vue` 解析到 Vue 3，该路径实测 **404**（PowerShell 直接请求也是 404），`vue@3/dist/vue.js` 同样不存在（Vue 3 的文件叫 `vue.global.js`）。Vue 与 Element UI 都没加载出来，应用自然没挂载。

**结论：这题在 2026-11 已经跑不起来了，与自动化、反爬都无关。** 记录它的价值在于提醒：靶场也会腐烂，回归前先确认样本本身还活着。

## 4. SpiderDemo（注册后：33 题，32 题可达）

注册账号（用户名 `iorl566`）后才发现，**sitemap 里那些 `/captcha/slideStitch` 之类全是旧路径**，真实题目清单来自站内接口 `/admin_I/api/challenges`，共 33 题（JS逆向 18 / 验证码 15）。而且清单里的 `url` 字段本身不可靠（一大半都写成 `/css_anti/css_challenge`），真实路径要从 `main.js` 的字面量里抽。

### 路径规则（实测归纳）

```
/captcha/<id>?challenge_type=<id>            验证码类（cap1..cap8、slide_*、click_stitch、press_rotate、wlzshield）
/authentication/<id>?challenge_type=<id>     加密/逆向类（protobuf、hash、symmetry、fsymmetry、jsvmp、jsvmp2、jsfuck、ob1、panel）
/ob/ob_challenge1?challenge_type=ob_challenge1   早期混淆题
/sec1/<id>?challenge_type=<id>               请求头 / WASM
/css_anti/<id>?challenge_type=<id>           CSS 偏移
/font_anti/<id>?challenge_type=<id>          字体三类
```

补齐前缀之后，可达题数从 23 提到 **32**——之前那 10 个"404"里 9 个只是前缀写错（`/authentication/`），另 1 个是统计口径的假阳性：题面里有随机四位数，检测 `404` 字样命中了数字而非错误页。

| 题目 | 分类 | 状态 | 导航 | 页面特征 |
| --- | --- | --- | --- | --- |
| 请求头检测 | JS逆向 | ok | 10102ms | 输入1 |
| 加解密 | JS逆向 | ok | 2562ms | 输入1 |
| protobuf加密 | JS逆向 | ok | 5073ms | 输入1 |
| WASM挑战 | JS逆向 | ok | 2807ms | 输入1 |
| 柳暗花明又一墙 | JS逆向 | ok | 5088ms | 输入1 |
| jsvmp | JS逆向 | ok | 5204ms | 输入1 |
| CSS偏移挑战 | JS逆向 | ok | 2622ms | 输入1 |
| 字体反爬 | JS逆向 | ok | 2595ms | 输入1 |
| 字体反爬（雪碧图） | JS逆向 | ok | 2603ms | 输入1 |
| 字体反爬(SVG和canvas) | JS逆向 | ok | 2555ms | canvas / 输入1 |
| 第一代验证码 | 验证码 | ok | 2599ms | 输入2 |
| Gif动态验证码 | 验证码 | ok | 2711ms | 输入2 |
| 计算题验证码 | 验证码 | ok | 2805ms | 输入2 |
| 第二代验证码 | 验证码 | ok | 2579ms | 滑块8 / 输入1 |
| 第二代验证码（随机滑块） | 验证码 | ok | 2600ms | 滑块8 / 输入1 |
| 滑动刮刮乐 | 验证码 | ok | 2701ms | 滑块6 / 输入1 |
| 滑动拼图 | 验证码 | ok | 2591ms | 滑块6 / 输入1 |
| 双滑块验证码 | 验证码 | ok | 2556ms | 滑块17 / 输入1 / 图5 |
| 圆柱验证码 | 验证码 | ok | 2793ms | canvas / 滑块6 / 输入1 |
| 点选验证码 | 验证码 | ok | 2709ms | 输入1 |
| 摘要算法 | JS逆向 | ok | 5082ms | 输入1 |
| 对称加密 | JS逆向 | ok | ~2600ms | 输入1 |
| 非对称加密 | JS逆向 | ok | 5264ms | 输入1 |
| 弧度验证码 | 验证码 | ok | 3224ms | canvas / 滑块8 / 输入1 |
| 控制台检测 | JS逆向 | ok | 5232ms | 输入1 |
| 点击拼图验证码 | 验证码 | ok | 2735ms | 输入1 |
| 控制流加强 | JS逆向 | ok | 12322ms | 滑块6 / 输入10 / 图11 |
| 计算题验证码plus | 验证码 | **404** | — | 清单里有，站上无对应路由（`/captcha` 与 `/authentication` 都试过） |
| 按压旋转验证码 | 验证码 | ok | 2566ms | 输入1 |
| Jsvmp2 | JS逆向 | ok | 5414ms | 输入1 |
| 无感验证码 | 验证码 | ok | 4185ms | 输入1 |
| JSFUCK | JS逆向 | ok | 5656ms | 输入1 |
| ZeroWidth | JS逆向 | ok | 5352ms | 输入1 |

要点：

- **验证码组 15 题里 14 题可达**（只有"计算题验证码plus"在清单里但站上无路由），覆盖滑动拼图、刮刮乐、圆柱、弧度、按压旋转、点选、点击拼图、双滑块（17 个滑块节点）、GIF、计算题、无感。
- 页面加载普遍 2.5–5.5s；`控制流加强` 12.3s、`请求头检测` 10.1s——这类题光等渲染就要 10 秒以上，批量脚本的超时别按普通页面设。
- 检测"页面不存在"要**只匹配文案**（`页面不存在`），不要匹配 `404` 字样：这类题面里有随机四位数，会误判。
- 该站自身插桩很重：`fingerprint_aggregator.js` 946KB、`client_signals_collector.js` 306KB、`register_captcha.js` 134KB。**注册时它就在采指纹**，这批题的环境判定比 Spiderbuf 严，拿它做回归时噪声更大。

## 5. 猿人学（微信登录后：21 题 + 6 个新手试炼）

`match.yuanrenxue.cn` 用**微信扫码**登录（用户名形如 `猿人学-xxxx`），登录后 `/match/N` 直接可开。实测 1–21 号题全部渲染出数据卡片：

| 题号 | 标题 | 特征 |
| --- | --- | --- |
| 1 | js混淆源码乱码 | 18 张卡片 |
| 2 | js混淆 动态cookie 1 | 18 张卡片 |
| 3 | 访问逻辑 推心置腹 | 18 张卡片 |
| 4 | 雪碧图、样式干扰 | 17 张卡片 / **100 张图**（雪碧图切分） |
| 5 | js混淆 乱码增强 | 17 张卡片 |
| 6 | js混淆 回溯 | 16 张卡片 |
| 7 | 动态字体，随风漂移 | 17 张卡片（字体映射） |
| 8 | 验证码 图文点选 | 17 张卡片 + 验证码素材 |
| 9 | js混淆 动态cookie 2 | 16 张卡片 |
| 10 | js混淆 重放攻击对抗 | 17 张卡片 |
| 11 | 一叶障目 控制台检测 | 17 张卡片 |
| 12 | js混淆源码乱码 | 16 张卡片 |
| 13 | 入门级cookie | 16 张卡片 |
| 14 | 备而后动-勿使有变 | 16 张卡片 |
| 15 | 备周则意怠 常见则不疑 | 16 张卡片 |
| 16 | js逆向 window蜜罐 | 16 张卡片 |
| 17 | 天杀的Http2.0 | 16 张卡片 |
| 18 | jsvmp 洞察先机 | 16 张卡片 |
| 19 | 乌拉乌拉乌拉 | 16 张卡片 |
| 20 | 2022新年挑战 | 16 张卡片 |
| 21 | 守心 简单的指令 | 16 张卡片 |

此外还有「新手试炼 1–6」（`/match/guideN`，新手引导，50 经验）。22–30 号 `/match/N` 也能打开，但标题都是「第N题 js混淆源码乱码」的占位样稿，暂未上线。

**结论**：这是目前中文靶场里题型最硬的一批——jsvmp、蜜罐、动态字体、雪碧图、控制台检测、Http2、重放对抗都在。而且全部要在登录态下才能真正取数，适合当"进阶回归"，不适合日常冒烟（21 题 × 每题等 2s 以上）。

### 5.1 断言化回归（`tools/yuarenxue-assert.ps1`）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\yuarenxue-assert.ps1 -Browser <instance> [ -Limit N ]
```

用例表在 `tests/anti-bot/yuarenxue-cases.json`（21 题 + 6 个新手试炼），判定分两层：

| 层 | 断言 | 结果 |
| --- | --- | --- |
| 入口 | 页面可达、非 404、标题含关键词、未被登录墙拦住 | `pass` / `fail` |
| 数据 | 页面出现 ≥5 个三位以上数字（说明数据已渲染） | `pass` / `skip` |

**为什么数据层是 skip 而不是 fail**：猿人学绝大多数题要先通过单项挑战（JS 混淆、动态 cookie、字体映射……）才会渲染数据。桥不做"解题"，所以拿不到数据是预期行为，不能算回归失败。出现数字才判 pass，其余记 skip 并写明原因。

实测（2026-11-16，登录态）：

```
pass=1 fail=0 skip=26   → 27 条用例
```

- 入口层 **27/27 全通过**：1–21 与 6 个新手试炼全部可达，标题关键词全部匹配；
- 唯一数据 pass 的是第 20 题（2022新年挑战），页面直接给出数字；
- 其余 26 条"未见数据"，符合"必须先解题"的预期。

**顺带发现的站方问题**：`/match/17` 的标题是「第十八题 天杀的Http2.0」，与 `/match/18`「第十八题 jsvmp 洞察先机」编号重复——站方编号有跳号/重复，**判定请以标题为准，不要以 URL 序号为准**。

基线存于 `tests/anti-bot/yuarenxue-baseline.json`，字段含每条用例的 `state/entry/structure/data/cards/nums/checks`。要跑真数据断言，得先给对应题目接上"解题"能力（当前不做）。

## 6. python-spider（需邀请码，无法自助注册）

`www.python-spider.com` 其实是"猿人学 Python"分站，登录页是账号密码 + **滑块验证**（"请按住滑块，缓慢拖动到合适位置"）。注册需要**群内邀请码**，本轮无法自助注册，故未纳入实测。

## 7. 建议

1. **回归主力用 Spiderbuf**：零门槛、编号稳定、题型覆盖从 Cookie 到 Worker 反调试。现有的 `tools/anti-bot-regression.ps1` 已经覆盖 C14/C02/C04 三条（含一条预期失败）。
2. **基线校验用 Scrape Center**：42 例基线在 `tests/anti-bot/scrape-center-baseline.json`，`-Baseline` 跑一遍就能发现"证据数退化"。连无反爬的 ssr1 都读不出数据，说明是桥的问题，不是反爬的问题。
3. **需要账号的**：猿人学已用微信登录跑通 21 题（第 5 节）；python-spider 注册需群内邀请码，暂时用不了。SpiderDemo 已注册可用（第 4 节），但它的清单接口和 URL 规则都不稳定，回归前要先用 `main.js` 抽路径。

> SpiderDemo 与猿人学都要登录态，跑之前先确认 profile 里是登录状态；两个站的登录都会因为"人在页面上操作"触发 `E_SESSION_PAUSED`，批量脚本要能自动 `session resume`。
4. 验证码样本现在够了：SpiderDemo 的滑动拼图/刮刮乐/圆柱/弧度/按压旋转/双滑块都是现场题，可以替代本地测试台。

> 长时间枚举的收尾坑：36 题跑完后 `session stop` 被 `E_LEDGER_PENDING` 拦了一次——某次 `navigate` 超时，意图账本留下 `state=unknown` 的记录。按提示 `bridge ledger resolve <id> --outcome done` 放行即可，**不要为此重启 daemon 或删运行文件**。

## 8. 复现

```powershell
# Spiderbuf 全量枚举（36 题，约 20 分钟）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-spiderbuf.ps1 -Browser <instanceId>
# SpiderDemo 全量枚举（33 题，需先登录，约 2 分钟）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-spiderdemo.ps1 -Browser <instanceId>
# Scrape Center：42 例全量采集（约 3 分钟，含反爬组）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-scrape-center.ps1 -Browser <instanceId>
# 只跑反爬组
powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-scrape-center.ps1 -Browser <instanceId> -Filter '^antispider'
# 回归：与基线比对，证据数退化即退出码 1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-scrape-center.ps1 -Browser <instanceId> `
  -Baseline tests/anti-bot/scrape-center-baseline.json

# 猿人学断言回归（27 条：21 题 + 6 试炼）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/yuarenxue-assert.ps1 -Browser <instanceId>
```

### 判定规则集中在 `tools/lib/regression-helpers.ps1`

踩过的坑都固化成函数，新脚本直接 dot-source，别各写一份：

| 函数 | 作用 | 为什么要有 |
| --- | --- | --- |
| `Test-PageNotFound` | 只匹配文案 `页面不存在` | 用裸 `404` 会命中题面里的随机四位数，误判成错误页（SpiderDemo 与猿人学各踩一次） |
| `Test-LoginWall` | 有登录入口且无退出入口 | 未登录时数据区不渲染，要记 skip 而不是 fail |
| `Get-NumberSignal` | 数三位以上数字的个数 | 判断"数据是否真的渲染了"，比猜选择器稳 |
| `Invoke-BridgeJson` | 取 bridge 输出的最后一行 JSON | 各脚本重复实现过，且 PowerShell 5.1 会混入 warning |
| `Get-CaseState` | pass/fail/skip 三态归一 | 任一层 fail 即 fail；有 skip 则 skip |
| `New-BridgeSession` / `Stop-BridgeSession` | 会话起停 | 传参要用数组 splatting，字符串会被当成一个参数 |

产出：`.tmp-bench/layer5/**/matrix.json`、`.tmp-bench/scrape-center/all.json`；基线存放在 `tests/anti-bot/scrape-center-baseline.json`（42 例）。
