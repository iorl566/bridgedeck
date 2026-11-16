# 反爬第二层实测：动态挑战与商业反爬

> 实测时间：2026-11-16 15:00–15:25。环境同第一层：Edge 157 + BridgeDeck 0.1.3（含按需注入改造）、出口 IP `110.80.15.22`（China Telecom，厦门）。
> 原则：全部只读访问。**不模拟点击"请验证您是真人"、不求解任何验证码、不提交表单**——遇到交互式挑战就停在那里并记录。
> 原始数据：`.tmp-bench/layer2/`（试验台源码、截图、网络采集 JSON）。

## 1. 结论摘要

| 目标 | 结果 | 含义 |
| --- | --- | --- |
| Turnstile 测试 key（4 个官方 key，本地试验台） | 通过/拦截/强制交互三种行为都符合官方定义 | 集成链路正确；**但这只证明代码没错，不代表能过反爬** |
| Turnstile 真实 key（2captcha demo） | 直接给交互式"请验证您是真人"，token 为空 | 自动化在真实 key 下停在人工环节（按规矩不点） |
| Cloudflare Managed Challenge：crunchbase.com | **200，无 interstitial**，3 秒内就是正文；只有被动 JSD 遥测 | 真实浏览器环境被判为正常，挑战没有下发 |
| Cloudflare WAF：cars.com | **403 + 拦截页**，随后 `precursor` 上报 | 不是挑战，是硬拦截；IP/ASN 声誉问题 |
| Akamai（imf.org）/ DataDome（g2.com） | 403 | 同上 |
| Kasada（canadagoose.com） | 首页 200，未见 `kpsdk` 脚本 | 首页未武装；深层路径未测（避免产生购物车副作用） |
| Beast 聚合模拟器 | 打不开 | `anti-bot-test-lab` 已 301 到 `/free-tools/`，且该页 `readyState` 永远停在 `loading`，截图也超时 |

一句话：**第一层修完之后，浏览器侧已经不再是瓶颈；这一层卡住的地方是出口 IP 的声誉，以及"必须有真人点一下"的交互式挑战。**

## 2. Turnstile 测试 key（本地试验台）

`.tmp-bench/layer2/turnstile-harness.mjs` 起在 `127.0.0.1:7311`，用 `render=explicit` 挂官方测试 key，把 `callback` / `error-callback` / `before-interactive-callback` 全部记进 `window.__tt`。这样判"通过"不靠肉眼看截图，而是看 token 与事件序列。

| key | 用途 | 渲染 | 结果 | 判定信号 |
| --- | --- | --- | --- | --- |
| `1x00000000000000000000AA` | 总是通过（可见） | 1683ms | 4496ms 拿到 token（21 字符） | `success` 回调 + 隐藏域 `cf-turnstile-response` 有值 |
| `1x00000000000000000000BB` | 总是通过（不可见） | 293ms | 2494ms 拿到 token（21 字符） | 同上，全程无 UI |
| `2x00000000000000000000AB` | 总是拦截 | 207ms | 3794ms `error` **600010**，token 为空 | 失败判定必须靠 `error-callback`；只看 DOM 会误判成"还在加载" |
| `3x00000000000000000000FF` | 强制交互 | 191ms | 907ms `before-interactive`，之后一直等 | 出现"请验证您是真人"勾选框；不点就永远没有 token |

工程要点：

- **失败和"还在算"必须分开**：拦截 key 给的是 `error-callback(600010)`，不是超时。采集脚本应该同时记录 `error`、`tokenLen`、`before-interactive` 三个信号。
- 不可见 key 平均 ~2.5s 出 token，可见 key ~4.5s；给自动化留 8–10s 等待窗口就够。
- 这些 key 是 Cloudflare 的"永远这样"测试 key，通过它们只说明**集成正确**，与反爬判定无关——这点和第一层的检测站正好相反，别混用。

## 3. Turnstile 真实 key（2captcha demo）

`https://2captcha.com/demo/cloudflare-turnstile`：页面正常，`cf-turnstile-response` 存在但值为空，控件直接呈现"请验证您是真人"。

对自动化的意义：**真实 key 下这条路径需要一个真人动作**。要么走人工协作（`request-help` 那一套），要么承认这条链路自动过不去。我没有模拟点击——那已经属于"绕过人机验证"，不是"测试环境是否被识别"。

顺便说，这个 demo 的 key 是刻意配成交互式的（否则没法演示打码），所以它也不能用来判断"Turnstile 会怎么评价我们的环境"。

## 4. Cloudflare Managed Challenge：两种完全不同的结局

用 `bridge debug start` 抓网络，看的是真实请求状态码，而不是页面长得像不像挑战页。

### crunchbase.com —— 直接通过

```
200 GET  https://www.crunchbase.com/                                    (Document，只有这一次)
200 GET  .../cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=...      (被动检测脚本)
200 GET  .../challenge-platform/h/b/scripts/jsd/f8df4d4a0cd6/main.js
200 POST .../challenge-platform/h/b/jsd/oneshot/f8df4d4a0cd6/0.909…      (环境上报，成功)
```

- 首屏 3 秒内已经是正文（`Crunchbase | Private Company Data…`），**没有出现 "Just a moment…"**。
- 32 条请求里**没有任何 `chl_page` / `orchestrate` / `turnstile` 请求**，说明中间页根本没下发；只有 `jsd`（JavaScript Detection）这一路被动遥测。
- 关键区别：`jsd` 是**每页都跑的被动遥测**，上报 200 不等于"过了挑战"；`chl_page` + 轮询才是要你算 token 的挑战。这次连挑战都没下发。

### cars.com —— 硬拦截

```
403 GET  https://www.cars.com/                                            (Document)
     GET  .../challenge-platform/scripts/precursor/main.js
200 GET  .../challenge-platform/h/b/scripts/precursor/f8df4d4a0cd6/main.js
200 POST .../challenge-platform/h/b/precursor/…                          (拦截页的上报)
```

页面标题是 `Attention Required! | Cloudflare`，正文 `Sorry, you have been blocked`，32 秒内毫无变化。这**不是**"挑战没通过"，而是 WAF 直接拒绝——通常由 IP/ASN 声誉、地区策略或指纹黑名单触发。

### 怎么区分这两件事

| 现象 | 含义 | 该修什么 |
| --- | --- | --- |
| 200 + `jsd` 上报 200，正文是真实页面 | 环境被接受 | 不用修 |
| 200 + `cf-chl` / interstitial + 轮询 `/cdn-cgi/challenge-platform/…/jsd/…` | 挑战下发，正在评定 | 环境一致性（TLS/UA/JS 特征） |
| 403 + `precursor` + "you have been blocked" | WAF 拒绝 | 出口 IP / ASN；换环境再好也没用 |

## 5. 其它厂商可达性

| 厂商 | 目标 | 结果 |
| --- | --- | --- |
| Akamai | imf.org | HTTP 403（连页面都没给） |
| DataDome | g2.com | HTTP 403 |
| Kasada | canadagoose.com | 200，跳到 `/zh-cn`，首页未加载 `kpsdk`（`performance` 里 0 条） |
| Kasada | twitch.tv | 连接超时 |
| Cloudflare | capterra.com / studylib.net | HTTP 403 |

Akamai/DataDome 这两家在第一层已经全绿的前提下仍是 403，基本可以排除"浏览器环境不一致"这个解释，指向出口 IP。

## 6. 这一层真正卡住的地方

1. **出口 IP 声誉是当前主要瓶颈。** 同一个浏览器，crunchbase 直接放行、cars.com/capterra/imf.org/g2.com 直接 403。要验证这个判断，得用同一台机器换一个住宅出口再跑同一批 URL，对比 403 是否消失——这正是原始测试计划里"住宅 IP vs 机房 IP"的对照实验，本轮没有条件做。
2. **交互式挑战是自动化的硬边界。** Turnstile 真实 key、Managed Challenge 的 interstitial，都需要真人动作。可接受的做法是接到 `request-help` 让人点一下，而不是伪造轨迹——这条边界建议写进项目文档，别让后续 agent 误以为"再多调几次参数就能过"。
3. **测试目标的可达性本身在退化。** Beast 的 anti-bot-test-lab 已经不存在（301 到 `/free-tools/` 且页面挂起），`react-turnstile.vercel.app` 与 `demo.turnstile.workers.dev` 在本网络不可达。以后回归测试优先用本地试验台 + 官方测试 key，真实站点只用来观察。

## 7. 额外发现：别的扩展也在往页面里注入

`crunchbase` 的网络采集里出现了两个第三方扩展的资源：

```
chrome-extension://amkbmndfnliijdhojkpoglbnaaahippg/content_main.js     4,277,469 B
chrome-extension://capohkkfagimodmlpnahjoijgoocdjhd/static/css/content.css   179,973 B
POST https://mcs.zijieapi.com/list                                      （字节跳动的埋点上报）
```

4.2MB 的 content script 会注入每个页面，同时把 `mcs.zijieapi.com` 的请求带进页面的网络指纹里。对反爬来说，这些扩展的存在本身就是可被观测的信号（而且会拖慢首屏）。**做反爬测试的浏览器 profile 应该只留 BridgeDeck**，否则测出来的结果永远混着别人的变量。

## 8. 复现

```powershell
# 1) 起本地 Turnstile 试验台（测试 key，永远通过/永远拦截/强制交互）
node .tmp-bench/layer2/turnstile-harness.mjs          # http://127.0.0.1:7311/?k=pass|block|force|invisiblePass

# 2) 开一个不抢焦点的会话
node cli/bridge.mjs session start --browser <instanceId> --no-focus --json

# 3) 看 Turnstile 事件（判通过看 token + success，判失败看 error-callback）
node cli/bridge.mjs navigate "http://127.0.0.1:7311/?k=pass" --session <sid>
node cli/bridge.mjs evaluate "window.__tt" --session <sid>

# 4) 真实站点：先抓网络再下结论，别靠截图
node cli/bridge.mjs debug start --session <sid>
node cli/bridge.mjs navigate "https://www.crunchbase.com/" --session <sid>
node cli/bridge.mjs debug requests --session <sid> --json
node cli/bridge.mjs debug stop --session <sid>
```
