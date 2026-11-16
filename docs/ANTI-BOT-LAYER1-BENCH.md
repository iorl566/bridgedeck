# 反爬第一层实测：静态指纹与自动化检测

> 实测时间：2026-11-16 14:28–14:52（改造前）、15:05–15:15（改造后）。环境：Edge 157.0.0.0（扩展 BridgeDeck 0.1.3）+ 本机 daemon 协议 1.9，出口 IP `110.80.15.22`（China Telecom，厦门）。
> 原始数据：`.tmp-bench/layer1/`、`.tmp-bench/anti-bot/after2/`（截图与页面文本导出）。结论先行：**基础自动化特征干净；唯一真实的暴露面是扩展在 MAIN world 的常驻注入把原生 `fetch`/`XHR`/`console` 打成了 JS 函数——已在第 9 节修掉，第 10 节是修后的复核。**

## 1. 为什么先测这一层

这一层站点不拦截请求，只检测并展示结果；用它可以在不冒封禁风险的前提下，判断"自动化身份"是否已经暴露。只有在第一层全绿之后，第二层（Cloudflare / DataDome / Akamai / Kasada）的结果才有解释力，否则分不清是"环境不一致"还是"本来就是 bot"。

## 2. 汇总（改造前）

| 检测站 | 结论 | 关键项 |
| --- | --- | --- |
| bot-detector.rebrowser.net | 2 红 / 15 绿 / 3 未触发 | 🔴 `runtimeEnableLeak`（有东西序列化 console 参数）、🔴 `useragent`（Edge 无 Google Chrome brand） |
| bot.sannysoft.com | 全绿 | WebDriver 缺失、`window.chrome` 存在、Selenium/Phantom 属性全无、WebGL 为 Intel UHD 770、canvas hash 在 5 种 iframe 变体中一致 |
| creepjs.org/checker | Trust 88/100，Lies 2 | 覆盖率 100%（54 成功 / 0 失败 / 4 跳过）；**Automation exposure: none observed**；两项 lie 均为环境级 |
| pixelscan.net/bot-check | Bot Behavior Detected | 37 个 webdriver 项里**只有 `tamperedFunctions` 命中**；`webdriver`/`CDP`/`isDevtoolOpen` 全 Clear |
| browserscan.net/bot-detection | 单项命中 | WebDriver 全 Normal，**CDP 判定 Robot**，Dev Tool Normal |
| fingerprint-scan.com | Bot score **60/100** | Browser: HIGH (+60)；`CDP Stack Check: true`；`webdriver:false`、`CDP Check:false`、`Eval Length: 33` |

## 3. 命中的暴露面：MAIN world 常驻注入

三个互不相关的检测器（pixelscan 的 `tamperedFunctions`、browserscan 的 `CDP Robot`、fingerprint-scan 的 `CDP Stack Check`）指向同一件事。在本机实测页面里直接读到的状态：

```
console.log / console.warn  非 native code   ← 被 patch
window.fetch                非 native code   ← taggedFetch
XMLHttpRequest.prototype.open/send  非 native ← taggedOpen / taggedSend
canvas.toDataURL / WebGL.getParameter  native  ← 未动
window.__BB_MAIN_LOG__ (26 条) / __BB_COMMAND_TAG__  存在
<html data-bb-command-id="d90c62bb-…">               命令期间存在
```

代码位置：

- `extension/manifest.json:42-52` —— `injected/main-console.js` 以 `world: "MAIN"`、`run_at: "document_start"`、`matches: <all_urls>` 静态注册。**只要扩展启用，用户每一个页面都会被注入，与是否开着 session 无关。**
- `extension/injected/main-console.js:55-65` —— patch `console.log/info/warn/error/debug`，并在 `:24` 用 `JSON.stringify` 序列化参数。这正是 rebrowser 的 `runtimeEnableLeak`（"Something serializes console arguments"）的触发条件：页面故意 log 一个带 getter 的对象，谁序列化谁暴露，CDP 只是其中一种可能。
- `extension/injected/main-console.js:94-123` —— patch `fetch` 与 `XMLHttpRequest.prototype.open/send` 用于 `x-bridge-command` 归因。
- `extension/src/bridge.js:71-86` —— 每条命令给 `<html>` 打 `data-bb-command-id`，命令结束移除；MutationObserver 可观测到。

风险等级：这一项不只影响"被检测"，还会连带影响第二层。Kasada 以 `Function.prototype.toString()` 校验原生函数、Akamai 做"身份声明 vs 环境"一致性校验，`taggedFetch` 这类改写在真实站点上是直接被拒的理由。

## 4. 未命中的部分（同样重要）

- `navigator.webdriver` false，Pixelscan 的 `webdriver`/`seleniumArtifacts`/`headlessChrome` 全 Clear。
- **CDP attach 本身不可见**：`isDevtoolOpen` Clear、`CDP Check: false`、rebrowser `cdpBindingGlobals` 🟢、sannysoft `CHR_DEBUG_TOOLS` ok。也就是说被认出的是"console 被序列化 / 原生被改写"，不是"调试器挂着"。
- canvas / WebGL / Audio / 字体 / Worker 一致性：creepjs 覆盖率 100% 且无 worker 相关 lie；sannysoft 5 种 iframe 变体 canvas hash 完全一致（`1009448737`）。
- 行为与首屏：`popupBlocking`、`ipcFloodingProtection`、`viewport`（921×872，与自动化库默认值不同）、`platformMismatch` 均通过——驱动真实浏览器带来的天然红利在这里体现得很清楚。

## 5. 环境级问题（与本项目无关，但会污染分数）

- **rebrowser `useragent` 必红**：该项要求 `navigator.userAgentData` 里出现 Google Chrome brand，Edge 永远没有。做前后对比时要么用 Chrome，要么把这一项标记为"环境性失败"，不要计入回归。
- **creepjs 两项 lie**：`WebGL vendor mismatch between masked and unmasked`（masked/unmasked renderer 不一致，典型于虚拟 GPU/远程桌面）与 `Desktop browser with no media devices detected`（本机无摄像头/麦克风）。两者都不是 BridgeDeck 造成，但在 Cloudflare Managed Challenge 那种"多项交叉校验"下会累加风险。
- creepjs 给的 IP 风险是 perfect（IP 风险值 0），说明当前网络层不是瓶颈。

## 6. 修法建议

**P0 —— 取消 MAIN world 的常驻注入**
1. 从 `manifest.json` 的 `content_scripts` 里移除 `main-console.js`，改为会话级动态注入：`chrome.debugger` + `Page.addScriptToEvaluateOnNewDocument`，只对当前 session 的 tab 生效，`session stop` 时 `removeScriptToEvaluateOnNewDocument`。
2. console 读取优先走已有 debugger 权限的 `Runtime.consoleAPICalled` / `Log.entryAdded`，根本不需要 patch；`extension/src/inject.js:60-82` 的 `consoleMainFunc` 改为回退路径。
3. `fetch`/`XHR` 的 `x-bridge-command` 归因同上处理：只在 rule/replay/网络抓取场景短时开启，退出即还原；或改用 `Network.requestWillBeSent` 的 initiator 关联。

**P1 —— 降低残余可观测性**
- 全局名 `__BB_MAIN_LOG__` / `__BB_COMMAND_TAG__` 改名或改用闭包 + Symbol，不要留可枚举的明显标记。
- `data-bb-command-id` 不要落在 `<html>` 上：MutationObserver 与 CSS 属性选择器都能读到。改为 `chrome.storage.session` + 命令 ID 由 daemon 侧关联。
- 若短期仍需 patch，至少在命令结束的 `finally` 里恢复原生函数，并保持 `Function.prototype.toString` 输出与原生一致（`native code`）——这只是补救，Kasada 一类会做多层校验，不建议依赖。

**P2 —— 测试口径**
- 回归基线固定用 Chrome（Edge 会让 rebrowser 的 `useragent` 项常红）。
- 建议加一条"零会话基线"：不开 session 只浏览，确认所有检测器无红（改造后已可满足）。

> 以上是改造前的计划稿，实际落地的清单与取舍见第 9 节。

## 7. 方法学坑（本次踩到的）

- **creepjs 旧域名不可达**：`abrahamjuliot.github.io/creepjs/` 返回错误页（`Frame ... is showing error page`），`creepjs.org/checker` 可用；新版 UI 把结果拆到 "Trust report" 锚点，`Lies Count` / 不一致项要读该 section，不能只看首屏卡片。
- **`evaluate` 间歇失败**：creepjs 页面上连续报 `E_INTERNAL: Debugger is not attached to the tab`，重试后恢复。根因是扩展侧 `states` 仍记着"已挂载"而浏览器侧已分离（SW 休眠丢状态 / 渲染进程重建 / 错误页接管），已在 `debugger.js` 的 `send` 里加了"丢状态 → 重挂 → 补焦点仿真 → 重试一次"的自愈路径；同一根因也解释了每次建会话时被静默吞掉的 `对话框拦截挂载失败`。
- **session 中途全部消失**：14:34 三个标签页在 5 秒内被关闭（含用户既有的 2 个），daemon 未重启 —— 是另一个连过 BridgeDeck 的会话关掉了窗口，不是 daemon 崩溃。教训：多会话共用一台浏览器时，关窗口会连带带走别人的 session。
- **pixelscan 读法**：页面里 "You're Definitely a Human" 与 "Bot Behavior Detected" 两段文案同时存在于 DOM，必须按当前激活状态的 tab 面板判断，按文本出现顺序读会得到相反结论。
- **rebrowser 的 ⚪ 不是通过**：`dummyFn` / `mainWorldExecution` / `exposeFunctionLeak` 需要 Playwright/Puppeteer 侧 API 触发，扩展驱动架构下它们恒为"未触发"，回归时应记为 N/A 而不是绿。

## 8. 复现

```powershell
node cli/bridge.mjs session start --browser <instanceId> --no-focus --json
node cli/bridge.mjs navigate "https://bot-detector.rebrowser.net/" --session <sid>
Start-Sleep 9
node cli/bridge.mjs evaluate "document.getElementById('detections-json')" --session <sid>
node cli/bridge.mjs screenshot --out .tmp-bench/layer1/rebrowser.png --session <sid>

# 判 native 是否被改写
node cli/bridge.mjs evaluate "(() => { const n=f=>/native code/.test(Function.prototype.toString.call(f)); return {fetch:n(window.fetch),xhr:n(XMLHttpRequest.prototype.send),console:n(console.log)}; })()" --session <sid>
node cli/bridge.mjs session stop <sid>
```

逐站：rebrowser → sannysoft → creepjs.org/checker → pixelscan → browserscan → fingerprint-scan（后者需等 ~40s 出分）。全部只读访问，不提交表单、不触发挑战。

## 9. 修复记录（2026-11-16 第二轮）

针对上面"MAIN world 常驻注入"的暴露面做了改造，已落地、待实测复核：

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 撤掉静态注入 | `extension/manifest.json` | 删除 `world: "MAIN"` 的 content script；页面默认不再被 patch |
| 加还原入口 | `extension/injected/main-console.js`、`injected/main-console-restore.js` | patch 时保存原函数，`__BB_RESTORE_HOOKS__()` 可完全还原并清掉 `__BB_MAIN_LOG__` / `__BB_COMMAND_TAG__` / `data-bb-command-id` |
| 按需注入模块 | `extension/src/page-hooks.js`（新） | `ensureHooks` / `releaseHooks` / `hasHooks`，按标签页记账，导航与关页自动失效 |
| 命令标记收敛 | `extension/src/bridge.js` | 只有钩子生效时才写 `data-bb-command-id`，平时不在 `<html>` 上留标记 |
| console 按需 | `extension/src/inject.js` | `console` 命令第一次读取时才注入钩子（详见 `PROTOCOL.md` 的行为变更说明） |
| 调试模式显式注入 | `extension/src/debug.js` | `debug start` 时注入、`debug stop` 时还原；调试采集场景保留原有的完整能力 |
| 陈旧调试会话自愈 | `extension/src/debugger.js` | `send` 遇到 "Debugger is not attached" 时丢弃陈旧状态、重新 attach 并补回焦点仿真，重试一次 |
| 回归护栏 | `tests/unit/anti-bot-injection.test.mjs`（新） | 断言 manifest 不含 MAIN world 脚本、钩子具备还原能力 |

代价与取舍：

- `console` 命令只能拿到钩子安装之后的条目（此前是 document_start 起全量）。页面加载早期的日志用 `debug` 采集（CDP `Runtime.consoleAPICalled` 会回放缓存），功能不丢。
- `x-bridge-command` 请求头的精确归因只在钩子生效期间有效；其余情况回落到 `network.js` 已有的 `currentCommand` 时间窗口归因。
- 需要重载扩展后生效，且**已加载的旧页面不会自动还原**（补丁随文档卸载消失，属于可接受行为）。

## 10. 复核结果（改造后）

同一台机器、同一出口 IP，用 [tools/anti-bot-bench.ps1](../tools/anti-bot-bench.ps1) 重新采集（`-Browser f745d380 -Out .tmp-bench/anti-bot/after2`）：

| 检测站 | 改造前 | 改造后 |
| --- | --- | --- |
| bot-detector.rebrowser.net | 2 红：`runtimeEnableLeak`、`useragent` | 1 红：仅 `useragent`（Edge 无 Chrome brand，环境性）。`runtimeEnableLeak` → **No leak detected**，`nativeTampering` → **Native functions look untouched** |
| bot.sannysoft.com | 全绿 | 全绿（无变化） |
| creepjs.org/checker | Lies 2 / Trust 88 / Automation exposure: none | Lies 2 / Trust 88 / none（两项 lie 仍是 WebGL masked↔unmasked 不一致 + 无媒体设备，与扩展无关） |
| pixelscan.net/bot-check | `Webdriver Detected`（唯一命中项 `tamperedFunctions`） | 全部 **Clear**：`Webdriver Clear 37 parameters`、`CDP Clear`、96 项 Clear、0 项 Detected |
| browserscan.net | `CDP = Robot` | `CDP = Normal`（WebDriver 系列本就 Normal） |
| fingerprint-scan.com | Bot score **60/100**（Browser: HIGH） | Bot score **0/100**（硬件/OS 低、浏览器低、网络低；`CDP Stack Check: false`） |

原生基线（`example.com`，每次采集先跑）：

```json
// 改造前
{ "bbLog": "object", "bbRestore": "undefined", "consoleLogNative": false, "fetchNative": false, "xhrOpenNative": false, "xhrSendNative": false }
// 改造后
{ "bbLog": "undefined", "bbRestore": "undefined", "consoleLogNative": true,  "fetchNative": true,  "xhrOpenNative": true,  "xhrSendNative": true }
```

### 复核时踩到的两件事

1. **旧版本会继续污染结果。** 第一次复核仍然全红，原因是同一浏览器里 0.1.2（商店版）与 0.1.3（仓库解压版）**同时启用**：旧版仍静态注入 `main-console.js`，谁在都算。停用 0.1.2 后立刻变干净。对真实用户同样成立：升级后要确认旧版本已停用/移除，否则注入永远存在。
2. **人碰一下标签页，会话会自动暂停**（`E_SESSION_PAUSED`），批量采集里表现为"静默拿到空结果"。`tools/anti-bot-bench.ps1` 现在会检查每条回执的 `ok`、遇到暂停自动 `session resume` 重试一次，并把错误写进 `*.error.json`，不再静默通过。

## 11. 复现（改造后）

```powershell
# 一条命令采集 6 个站：原生基线 + 页面全文 + 截图
powershell -NoProfile -ExecutionPolicy Bypass -File tools/anti-bot-bench.ps1 -Browser <instanceId> -Out .tmp-bench/anti-bot/after
```

判定仍按第 2 节的读法：rebrowser 看红点、sannysoft 看首表 `passed/failed`、creepjs 点 `Trust report` 看 Lies Count、pixelscan 看 37 项里是否出现 `tamperedFunctions`、browserscan 看 `CDP` 行、fingerprint-scan 等 ~40s 看评分。


