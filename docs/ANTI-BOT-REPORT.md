# 反爬测试总报告（BridgeDeck 0.1.3 / Edge 157 / 2026-11-16）

> 本报告汇总四轮实测，把「浏览器自动化到底在哪一层被认出来」拆开看。分报告：
> [第一层 静态指纹](ANTI-BOT-LAYER1-BENCH.md) · [第二层 动态挑战](ANTI-BOT-LAYER2-BENCH.md) · [国内平台](ANTI-BOT-LAYER3-DOMESTIC.md) · [第三层 靶场](ANTI-BOT-LAYER3-BENCH.md)
>
> 环境：Windows + Edge 157（真实用户 profile、未登录）、BridgeDeck 0.1.3、出口 IP `110.80.15.22`（China Telecom，厦门）。全部测试只读，不求解任何验证码。

## 1. 一句话结论

**第一层修完之后，浏览器环境不再是瓶颈；第二层开始，决定成败的是出口 IP 和"是否愿意让真人点一下"，而不是指纹伪装。**

## 2. 分层结果

| 层 | 目标 | 结果 |
| --- | --- | --- |
| 静态指纹 | rebrowser / sannysoft / creepjs / pixelscan / browserscan / fingerprint-scan | 修完只剩 rebrowser 的 `useragent` 一项红（Edge 无 Chrome brand，环境固有问题） |
| 动态挑战 | Turnstile 测试 key × 4、2captcha 真实 key、Cloudflare 真站 | 测试 key 行为全部正确；真实 key 停在交互式勾选；crunchbase 直接放行，cars.com 403 硬拦截 |
| 国内平台 | 淘宝 / 京东 / 大众点评 / 小红书（首页 + 搜索） | 首页全放行；搜索全部导登录，未出现滑块 |
| 登录后深层路径 | 淘宝（搜索 4 页 + 2 个商品详情） | 全部正常，0 次滑块 —— 未登录时看到的"反爬"其实是未授权 |
| 行为验证 | Spiderbuf C14 / C02 / C04 | C14 通过、C02 通过（80ms 直线拖拽）、C04 行为门未通过 |

## 3. 五个关键发现

**① 真实浏览器最大的优势是"天生干净"**
修补前唯一的暴露面，是扩展在 MAIN world 常驻注入了 `console`/`fetch`/`XHR` 补丁（被 pixelscan 判 `tamperedFunctions`、BrowserScan 判 `CDP Robot`、fingerprint-scan 给 60/100）。改成按需注入后三家全绿，fingerprint-scan 降到 0/100。

**② CDP 附着本身没被识别**
`isDevtoolOpen`、`cdpBindingGlobals`、sannysoft 的 `CHR_DEBUG_TOOLS` 一直是通过状态。被认出来的是"原生函数被改写"，不是"调试器挂着"——这决定了优化方向：不要改页面原生对象，而不是"藏 CDP"。

**③ 出口 IP 是第二层的主导变量**
同一台机器、同一个浏览器：crunchbase 200 直接放行（只有被动 `jsd` 遥测），cars.com / capterra / imf.org / g2.com 全是 403 硬拦截。用 curl + 同样 UA 复现京东的 `risk_handler/03101900`，证明这类判定来自 IP / 无 cookie 会话，与自动化指纹无关。

**④ 滑块不一定看轨迹**
Spiderbuf C02 用 8 个点、80ms 的直线拖拽一次通过，说明它只比对最终位移。要不要做贝塞尔曲线 + 微抖动，取决于目标站校验了什么——先测校验项，再决定成本，别默认上轨迹建模。

**⑤ 行为门是真正的硬边界**
C04 的"我不是爬虫"复选框，JS 点击、CDP 原生点击、hover+原生点击三种打法全部被拒，且 `elementFromPoint` 证实点击正中目标。它要的是一段像人的交互历史，不是单个动作。到这里应转人工（`request-help`），而不是继续调参数。

## 4. 本次修复的代码

| 改动 | 文件 |
| --- | --- |
| 移除 manifest 里 MAIN world 的静态注入 | `extension/manifest.json` |
| 注入时保存原函数、提供完整还原入口 | `extension/injected/main-console.js`、`main-console-restore.js` |
| 按需注入 / 释放，导航与关页自动失效 | `extension/src/page-hooks.js` |
| 只有钩子生效时才写 `data-bb-command-id` | `extension/src/bridge.js` |
| `console` 首次读取时才注入；`debug start/stop` 注入与还原 | `extension/src/inject.js`、`src/debug.js` |
| 陈旧 CDP 会话自愈（丢状态→重挂→补焦点仿真→重试） | `extension/src/debugger.js` |
| 防回归单测（manifest 不许有 MAIN world 脚本） | `tests/unit/anti-bot-injection.test.mjs` |

代价：`console` 只能拿到钩子安装之后的条目（早期日志用 `debug` 采集，CDP 会回放缓存）；`x-bridge-command` 精确归因退化为 `currentCommand` 时间窗口。

**升级注意**：旧版本（0.1.2 商店版）若仍启用，会继续静态注入，新版本改了也白改——本次复核就踩过这个坑。升级后必须确认旧版本已停用。

## 5. 回归怎么跑

```powershell
# 第一层：6 个检测站，落盘全文 + 截图 + 原生函数基线
powershell -NoProfile -ExecutionPolicy Bypass -File tools/anti-bot-bench.ps1 -Browser <instanceId>

# 第三层：Spiderbuf 三条用例，含一条"预期失败"
powershell -NoProfile -ExecutionPolicy Bypass -File tools/anti-bot-regression.ps1 -Browser <instanceId>
```

`anti-bot-regression.ps1` 的判定：

| 用例 | 期望 | 说明 |
| --- | --- | --- |
| C14 模拟浏览器检测 | 通过 | 抽 12 条 CPC → 均值 34.14 → 提交 → "恭喜你答对啦" |
| C02 拖拽滑块 | 通过 | 位移 250px、80ms 直线拖拽后表格出现 21 行 |
| C04 行为门 | **不通过** | 若哪天意外通过，脚本会以 `pass(意外通过)` 报偏差并退出码 1 |

退出码 0 = 全部符合预期。

## 6. 判据速查（贴给以后看日志的人）

| 现象 | 含义 | 该修什么 |
| --- | --- | --- |
| 200 + 真实正文；只有 `jsd` 上报 | 环境被接受 | 不用修 |
| 200 + `chl_page` / interstitial 轮询 | 挑战下发，正在评定 | 环境一致性（TLS/UA/JS 特征） |
| 403 + `precursor` / "you have been blocked" | WAF 拒绝 | 出口 IP、ASN |
| 302 到 `risk_handler` / `verify` / `punish` | 风控导流 | 换 IP、养会话 |
| 200 + "登录后查看" | 登录墙 | 先解决登录态 |
| Turnstile `error-callback(600010)` | 被判定为 bot（拦截 key） | 环境或 IP |
| Turnstile `before-interactive` 后无 token | 等待真人 | 人工协作 |

## 7. 局限

- 没有代理，无法做「住宅 IP ↔ 机房 IP」对照；第二层的 IP 归因靠非浏览器客户端侧证，不是直接对照实验。
- 国内平台全部在未登录态测试，登录后的深层路径（动态签名、会话维持）未覆盖。
- C04 之后没有尝试伪造交互历史——那是绕过人机验证，不是环境测试，刻意停在边界上。
- 测试期间浏览器里还有第三方扩展在注入（4.2MB content script + 字节跳动埋点），做严格基线前应清空 profile。
