# BridgeDeck · 协议与命令面（v0.1，单一事实来源）

本文件是扩展、daemon、CLI 三方共同遵守的契约。**改协议先改本文件，再改两侧代码。**
目标：不依赖任何第三方包（Node 内置模块 + 浏览器原生 API），在 Windows 上跑通
「AI agent 用命令行驱动用户已登录的 Chromium 浏览器」的最小闭环。

完全自研、零依赖、可读可改。

---

## 0. 组件与进程模型

```
  AI / 用户
     │  命令行
     ▼
  bin\bridge.cmd ──> cli\bridge.mjs  ── HTTP POST /rpc ──>  daemon\server.mjs
                        (一次一进程，退出即止)                    │
                                                                  │ WebSocket (127.0.0.1)
                                                                  ▼
                                                       浏览器扩展（MV3 service worker）
                                                                  │ chrome.scripting / chrome.tabs
                                                                  ▼
                                                       用户的 Edge / Chrome（真实登录态）
```

* **扩展**：MV3，无构建步骤（纯 JS 文件直接加载）。service worker 常驻重连，每个浏览器实例一条 WS。
* **daemon**：Node 进程，单 HTTP 服务同时提供 `/rpc`（CLI 用）与 `/ws`（扩展用）。持有
  session 表、浏览器实例表、命令路由。CLI 首次调用时自动后台拉起（detached）。
* **CLI**：Node 进程，解析参数 → 组 JSON → 一次 `/rpc` → 打印人类可读文本或 `--json`。

不实现：多用户、远程访问、OAuth。daemon 只监听 `127.0.0.1`。

---

## 1. 路径与端口

| 项 | 值 |
| --- | --- |
| 状态目录 | `%USERPROFILE%\.browser-bridge`（可用 `BB_HOME` 覆盖） |
| `daemon.json` | `{ "pid": 1234, "port": 52900, "token": "<32 hex>", "version": "0.3.1", "startedAt": 1700000000000 }` |
| 日志 | `%USERPROFILE%\.browser-bridge\daemon.log`（追加写，超过 5MB 轮转为 `daemon.log.1`） |
| 默认端口 | `52900`（可用 `BB_PORT` 或 `--port` 覆盖） |
| 端口探测 | CLI 依次尝试 `BB_PORT` → 52900 → 52901 … 52909，读 `daemon.json` 里的 `port` 为准 |

`daemon.json` 的 `token` 是 CLI 调 `/rpc` 的凭证；扩展的 WS 握手不需要 token
（只监听回环地址，扩展无法读文件，拿不到 token）。token 每次 daemon 启动随机重新生成。

扩展侧按候选端口 `52900 → 52909` 依次尝试连接（每端口一次，失败换下一个）；全部失败则 3s 后
从 52900 重来。扩展不需要任何配置，daemon 用哪个端口都能被扫到（E2E 会用非默认端口验证）。

---

## 2. daemon HTTP 接口

### `GET /health`（无鉴权）
```json
{ "ok": true, "service": "browser-bridge", "version": "0.3.1", "pid": 1234, "uptimeMs": 12345,
  "port": 52900, "browsers": 1, "sessions": 0 }
```

### `POST /rpc`
请求头：`content-type: application/json`、`x-bridge-token: <daemon.json.token>`
请求体：`{ "method": "<name>", "params": { ... }, "timeoutMs": 60000 }`（`timeoutMs` 可选，默认 60000）
响应体：
```json
{ "ok": true,  "result": { ... } }
{ "ok": false, "error": { "code": "E_NO_SESSION", "message": "human readable" } }
```
HTTP 状态码恒为 200（只有 token 错误返回 401、方法不存在返回 404），业务成败看 `ok`。
`status` 结果包含 `inflight: [{id, instanceId, method, tabId, startedAt, elapsedMs}]`；对应每次
已发出、尚未回包的 `cmd`。`inflight.list` 返回 `{ commands: [...] }`，用于诊断挂起命令。
`status.queues` 返回每个 session 的排队深度；同一 session 的动作按提交顺序串行执行，容量 64，
满时 `E_QUEUE_FULL`。`operation.await`/`dialog.*`/`cooperate.wait`/`debug.fetch_probe`/`request-help` 等会等待
其他命令或需要与动作并发的诊断/人工方法绕过该队列，避免死锁/误判。
`command.cancel { id }`（CLI `cancel <commandId>`）把取消翻译成扩展的 `cancel { rpc_id }`；
当前可中断 `wait-ms`（返回 `E_CANCELLED`），其他命令会返回 `accepted:false` 表示已结束或不支持。

### 鉴权错误
`401 { "ok": false, "error": { "code": "E_AUTH", "message": "invalid token" } }`

---

## 3. 扩展 ↔ daemon WebSocket

地址：`ws://127.0.0.1:<port>/ws?role=extension&v=<extVersion>`
所有消息为一个 JSON 文本帧。daemon 收到 upgrade 后若路径不是 `/ws` 直接 404 关闭。

### 3.1 握手

扩展连上后立刻发送：
```json
{ "type": "hello", "extVersion": "0.3.1", "browser": "edge", "browserVersion": "156.0.4314.58", "userAgent": "..." }
```
daemon 回：
```json
{ "type": "hello-ack", "instanceId": "a1b2c3d4", "daemonVersion": "0.3.1" }
```
`instanceId` 由 daemon 生成（8 位 hex），同一浏览器实例在本次 daemon 生命周期内保持不变
（重连时扩展可在 hello 里带上次的 `instanceId` 作为提示，但 daemon 以自己生成的为准）。

本机新配对（`local.pair` 生成的链接）同时有一个 6 位配对码。扩展的 hello 带
`authChallenge: true`、`authKeyId`、`pairToken`、`browserId`，并在首次配对时带 `pairCode`；daemon 在发放
`auth-challenge` 前校验配对码，缺失或不匹配返回 `E_PAIR_REQUIRED`。首次激活成功后 daemon
**立即作废旧链接 token**，通过 `hello-ack.deviceToken` 下发新的设备 token；扩展持久化后
后续重连带新 token 即可。旧 token 再连接不再视为已配对（可选模式下为 `unpaired`，必需模式下被拒）。
远程配对码（`pair.create`）走同一套“激活即换发设备 token”的流程，但使用独立配对码表。
**browser_id 绑定**：激活时把设备 token 绑定到 hello 的 `browserId`（扩展首次生成后存
`storage.local`）；之后用同一 token 但不同 `browserId` 连接会返回 `E_PAIR_REJECTED` 并关闭，
防止 token 被复制到其它浏览器复用。

**分阶段 commit（pending → active）**：首次激活时设备先进入 `pending`（`hello-ack.deviceStatus =
"pending"`），同时下发 `commitTxn` + `commitProof`；扩展用（新）设备 token 计算
`HMAC(token, "bridgedeck-commit-v1\n" + txn)` 并以 `{ type: "auth-commit", txn, proof }` 确认，
daemon 验证后把设备置为 `active` 并回 `{ type: "commit-ack", txn }`。若扩展在 commit 前断开，
带 pending token 重连会**重新拿到同一 commitTxn**（断点恢复）；pending 超过 10 分钟未 commit
则 token 作废（远程设备被清理、本机 token 失效），必须重新配对。手动 `pair rotate`/`renew` 仍是
立即生效（不进入 pending）。

握手保护：daemon 要求 hello 在 **5s** 内到达，首帧不超过 **64KiB**；远程 IP 连续失败
**10 次/60s** 后封禁 **60s**，期间返回 `hello-error { code: "E_RATE_LIMITED" }` 并关闭连接。
超时返回 `E_TIMEOUT`，首帧过大返回 `E_TOO_LARGE`。

### 3.2 心跳

daemon 每 15s 发 `{ "type": "ping" }`，扩展必须回 `{ "type": "pong" }`；
连续 3 次无 pong（45s）daemon 判定实例掉线，关闭 socket、清理该实例的 session。
扩展在 SW 里也设 30s `chrome.alarms` 兜底：连接断开时立刻重连，SW 被回收后由 alarm 唤醒重连。

### 3.3 命令与响应

daemon → 扩展：
```json
{ "type": "cmd", "id": "<uuid>", "method": "navigate", "params": { "tabId": 123, "url": "https://example.com" } }
```
扩展 → daemon（成功 / 失败）：
```json
{ "type": "res", "id": "<uuid>", "ok": true,  "result": { ... } }
{ "type": "res", "id": "<uuid>", "ok": false, "error": { "code": "E_STALE_REF", "message": "..." } }
```
* 扩展必须在 `timeoutMs`（默认 60s，daemon 透传）内回包；超时 daemon 返回 `E_TIMEOUT`，迟到的回包丢弃。
* 扩展收到未知 method：回 `E_UNKNOWN_METHOD`。
* 单实例并发命令不设上限，但扩展应按 tabId 串行执行同一 tab 的命令（实现里用 `Map<tabId, Promise>` 链）。

### 3.4 扩展 → daemon 事件（可选用，MVP 只有一条）
```json
{ "type": "event", "event": "tab-removed", "params": { "tabId": 123 } }
```

---

## 4. daemon 本地 RPC 方法

这些方法 daemon 直接处理，不发给扩展。

### `status`
```json
{ "service": "browser-bridge", "version": "0.3.1", "pid": 1234, "port": 52900, "uptimeMs": 12345,
  "browsers": [ { "instanceId": "a1b2c3d4", "browser": "edge", "browserVersion": "...", "extVersion": "0.3.1", "connectedAt": 1700000000000 } ],
  "sessions": [ { "sessionId": "abcd", "instanceId": "a1b2c3d4", "tabId": 12, "windowId": 3, "url": "about:blank", "startedAt": 1700000000000 } ] }
```

### `browsers`
→ `{ "browsers": [ <同上> ] }`

### `session.start` / `session.start_tracked`
params: `{ "browser": "<instanceId 或 edge/chrome 前缀，可选>", "noFocus": false }`
行为：选一个实例 → 发扩展命令 `window.ensureAgent`（见 5.1）→ 记录 session → 置为 `active`。
→ `{ "sessionId": "abcd", "tabId": 12, "windowId": 3, "instanceId": "a1b2c3d4" }`
若没有浏览器连上：`E_NO_BROWSER`（message 里提示"请在浏览器里加载/启用扩展"）。
同一 session 重复 start 返回 `E_SESSION_BUSY`。

**共享同一标签页**（`params.tab` + `params.share`）：`session start --tab <tabId> --share` 让新会话加入
已有会话的 tab（同一 tabId/windowId），各自独立 context/observation；daemon 按 **tab 级队列**串行派发命令，
避免两个 Agent 的原生输入并发。返回体额外带 `"shared": true`、`"ownerSession": "<主会话>"` 与
`"control": { mode, epoch, holder, primary, shared, sessionCount }`。可选 `params.controlMode`
（`open`｜`exclusive`）同时设定该 tab 的控制权仲裁模式（见下节 `session.control_*`）。
共享 tab 上主会话停止时若还有共享会话存活，daemon **不关标签页**，把控制权与主会话身份转交最老的共享会话
（见 `session.stop` 的 `handedOff`）。

**可恢复启动**（`session.start_tracked`）：可选 `params.requestId`，形如
`<expiry-unix-ms>:<8-80 位 id>`（最长 10 分钟内有效）。daemon 在创建窗口前把 token 写入
`$BB_HOME/session-starts.json`（`starting`），成功写 `ready`（含 sessionId/tabId/windowId），失败写 `failed`。
同一个 requestId 重试：`ready` 且会话仍存在 → 返回同一会话并附 `"reused": true`；`starting` 未超过
120 秒 → `E_START_PENDING`（附 requestId/startedAt）；token 过期或格式错误 → `E_BAD_ARG`。
CLI：`bridge session start --request-id <token>` 自动走该方法；DSH 插件新建窗口时自动生成 token 并在
超时后重试一次，避免回复丢失留下孤儿窗口。

**请求生命周期**（prepare/claim/cancel 生命周期）：

| 方法 | 行为 |
| --- | --- |
| `session.request_prepare` | 校验 token 并写 `prepared`（不创建窗口）；已存在则返回既有状态；`cancelled` → `E_REQUEST_CANCELLED` |
| `session.start_tracked` | `prepared`/新 token → `starting` → `ready`（`ready`/`claimed` 且会话存活 → 同会话 + `reused:true`） |
| `session.request_claim` | `ready`/`claimed` → `claimed`（调用方已持久化会话）；未 ready → `E_START_NOT_READY` |
| `session.request_cancel` | `prepared`/`ready`/`claimed` → `cancelled` 墓碑，返回原 `sessionId`；`starting` 中 → `E_START_PENDING` |
| `session.request_status` | 返回 `{requestId, entry}`（不存在时为 null） |

状态机：`prepared → starting → ready → claimed`，任意可取消阶段可进 `cancelled`；墓碑 token 不能再启动。
CLI：`bridge session prepare|claim|cancel|request --request-id <token>`。

### `session.stop` / `session.stop_all`

`session.stop`：`{ "session": "abcd", "keep"?: false }` → 发扩展命令 `tab.close` 关闭 agent 窗口（除非 `keep=true`），删掉 session。
重复 stop 返回 `{ ok: true, alreadyStopping: true }`。
若该 tab 上还有共享会话（`--share`），**不关标签页**：控制权与主会话身份转交给最老的共享会话。
→ `{ "ok": true, "borrowed": false, "handedOff": { "sessionId": "efgh", "tabId": 12 } | null }`

`session.stop_all`：`{ "keep"?: false }` → 停止所有会话，单个失败不影响其它：
→ `{ "ok": true, "stopped": ["abcd", ...], "failed": [{ "sessionId", "code" }], "count": N }`

```powershell
bridge session stop <id> [--keep]
bridge session stop --all
```

### `session.run_log`

会话级步骤日志（daemon 内存，≤200 步 / 8000 refs；会话停止即释放）：
`{ "session": "abcd", "limit"?: 50 }` →
`{ "sessionId", "steps": [...], "count", "total", "refs", "truncated", "dropped", "limits" }`

- `kind:"navigate"`：只保存 `origin` + `path`（query/hash 丢弃，`dropped_query` 标记）。
- `kind:"action"`：`method` + `target {ref?, stableRef?, role?, name?, selector?, text?}` + `frameId` + `revision` + `effectState`。
- **绝不保存输入值**（fill 的 value、evaluate 的脚本、上传文件内容都不进日志）。
- 用途：`bridge recipe draft` 把一次成功操作沉淀成 recipe 草稿。

```powershell
bridge session run-log <id> [--limit N]
bridge recipe draft --name <name> --session <id> [--limit N] [--max-steps N]
```

`recipe draft` 只映射可回放步骤（navigate/reload/click/hover/focus），`fill/press/select/drag/wheel`
因为需要输入值/坐标而**跳过**（结果里 `skipped` 给出原因），草稿仍是 `approved:false`，需要
`recipe approve <name> --confirm-human` 后才能 `recipe run`。


### `session.pause` / `session.resume`

```
bridge session pause|resume <id>
```

- 暂停后除只读方法（observe/snapshot/get-html/read/extract/console/network/screenshot）外，动作返回 `E_SESSION_PAUSED`。
- 接管浮层的“暂停 Agent / 交给 Agent”通过 `takeover.pause` 事件实现，与该 RPC 等价。

### `session.list`
→ `{ "sessions": [ { "sessionId", "instanceId", "tabId", "windowId", "url", "title",
     "phase": "starting|active|stopping|recovering|disconnected", "startedAt",
     "control": { "mode", "epoch", "holder", "primary", "shared", "sessionCount", "leaseRemainingMs" } } ] }`

`control` 只在同一标签页有多个会话（`--share`）时有内容；单会话标签页为 `null`。

### `session.control_status` / `session.claim_control` / `session.release_control` / `session.handoff` / `session.control_mode`

共享 tab 的控制权/租约/handoff（详见 [SHARED-TAB.md](SHARED-TAB.md)）。全部是 daemon 本地方法。

| 方法 | params | 行为 |
| --- | --- | --- |
| `session.control_status` | `{ session }` | 返回该 tab 的 `{tabId, mode, epoch, primary, holder, shared, sessions, leaseRemainingMs, holdsControl, control}` |
| `session.claim_control` | `{ session, leaseMs?, expectEpoch? }` | holder 为空 → 认领；已是自己 → 续租；被他人持有 → `E_CONTROL_BUSY`；主会话可无条件收回（`preempted`） |
| `session.release_control` | `{ session, expectEpoch? }` | 只有持有者能放弃；释放后 `holder=null`、`epoch+1` |
| `session.handoff` | `{ session, to, leaseMs?, expectEpoch? }` | 只有持有者能发起；目标必须已在该 tab（`--share`）；成功即转移 holder |
| `session.control_mode` | `{ session, mode: open\|exclusive }` | 切换该 tab 的仲裁模式并持久化到会话记录 |

语义要点：

- 记录按 tab 维护：`primary`（主会话）、`holder`（写控制权）、`epoch`（每次变化 +1）、`leaseMs`（默认 60s，1s–600s）、`history`（最近 5 次转移）。
- `open`（默认）：任何共享会话都能写；租约只记录“当前写者”（写动作认领/续租），不拦动作。
- `exclusive`：同一时刻只有一个会话能写；holder 为空时第一个写动作认领；非持有者的变更动作返回 `E_CONTROL_NOT_HELD`。
  只读动作永远放行且不续租。
- 租约到期 → `holder=null`、`epoch+1`、`lastTransition.reason=expire`。
- `--expect-epoch` 是 CAS：不符 → `E_CONTROL_STALE`。
- 判定在 daemon 的 **tab 队列内**执行（判定与派发串行），因此两个会话同时写时只有先到者通过。
- 主会话停止时若有共享会话存活：不关标签页，控制权/主会话身份转交给最老的共享会话（`session.stop` 返回 `handedOff`）。

```powershell
bridge session control <id> [--mode open|exclusive]
bridge session claim-control <id> [--lease 60s] [--expect-epoch N]
bridge session release-control <id> [--expect-epoch N]
bridge session handoff <id> --to <targetSessionId> [--lease 60s] [--expect-epoch N]
```

### 需要 session 的方法（路由到扩展）
CLI 传 `--session`，daemon 校验存在后把 `tabId` 注入 params 后转发给该会话所属实例。

---

## 5. 扩展方法

参数里的 `tabId` 全部由 daemon 注入（CLI 不传）。除 `window.ensureAgent` / `tab.list` / `tab.new` 外，都要求 `tabId`。

### 5.1 会话/window/tab
| method | params | result |
| --- | --- | --- |
| `window.ensureAgent` | `{ noFocus: bool }` | `{ tabId, windowId }` |
| `tab.list` | `{ scope: "agent"|"user" }` | `{ tabs: [ { tabId, windowId, url, title, active } ] }` |
| `tab.new` | `{ url?: string, noFocus?: bool }` | `{ tabId, windowId }` |
| `tab.close` | `{ tabId }` | `{ ok: true }` |
| `tab.select` | `{ tabId }` | `{ ok: true }` |
| `window.resize` | `{ tabId, width, height }` | `{ ok: true }` |

`window.ensureAgent`：优先复用扩展记录的「agent 窗口」（该窗口被用户关掉或 tab 没了就新建）。
新建时 `chrome.windows.create({ url: "about:blank", type: "normal" })`；`noFocus: true` 时不激活窗口
（`focused:false` 传给 windows.create 不一定生效，实现里创建后再把原来 focused 的窗口 focus 回去）。

### 5.2 页面动作
| method | params | result |
| --- | --- | --- |
| `navigate` | `{ tabId, url }` | `{ url, title }` |
| `reload` | `{ tabId }` | `{ ok: true }` |
| `navigate-back` | `{ tabId }` | `{ ok: true }` |
| `navigate-forward` | `{ tabId }` | `{ ok: true }` |
| `wait-ms` | `{ tabId, ms }` | `{ ok: true }` |
| `wait-for-navigation` | `{ tabId, timeoutMs? }` | `{ url }` |
| `wait-for-element` | `{ tabId, selector, state?: "visible"|"hidden"|"attached"|"detached", timeoutMs? }` | `{ ok: true }` |
| `observe` | `{ tabId, probeHover?: bool }` | `{ url, title, observation: "<multiline text>", refs: <int> }` |
| `snapshot` | `{ tabId }` | `{ text, refs }`（带 @eN） |
| `get-html` | `{ tabId, ref?: string, selector?: string }` | `{ html, url }` |
| `screenshot` | `{ tabId, fullPage?: bool, stream?: bool }` | `{ dataUrl, width, height }`（PNG base64，daemon/CLI 负责落盘）；`stream:true` 或 dataUrl > ~1.5MB 时改为 `{ captureId, streamed:true, bytes, width, height }` |
| `screenshot.read` | `{ tabId, captureId, offset?: int, length?: int }` | `{ dataBase64, offset, nextOffset, total, bytes, eof, width, height }`（按 base64 字符分块） |
| `screenshot.release` | `{ tabId, captureId }` | `{ ok, released }` |
| `click` | `{ tabId, ref?: string, selector?: string }` | `{ ok: true }` |
| `hover` | `{ tabId, ref?, selector? }` | `{ ok: true }` |
| `fill` | `{ tabId, ref?, selector?, value }` | `{ ok: true }` |
| `press` | `{ tabId, key, ref?, selector? }` | `{ ok: true }` |
| `select` | `{ tabId, ref?, selector?, value }` | `{ ok: true }` |
| `focus` | `{ tabId, ref?, selector? }` | `{ ok: true }` |
| `scroll-to` | `{ tabId, ref?, selector? }` | `{ ok: true }` |
| `evaluate` | `{ tabId, expression, unverified? }` | `{ value }`（JSON 可序列化；不可序列化则 `null` + `note`）；`unverified:true` 时带 `verified:false` |
| `console` | `{ tabId, since?: int }` | `{ entries: [ { level, text, ts } ] }` |

> `console` 的主世界缓冲改为**按需注入**（协议 1.9 之后的行为变更）：第一次读取时才在页面上安装 console 钩子，因此只能拿到安装之后的条目；页面加载早期的日志请用 `debug` 采集（CDP `Runtime.consoleAPICalled` 会回放已缓存消息）。这样扩展默认不再改写页面的 `console`/`fetch`/`XHR`，避免被反爬检测器识别为自动化。

`ref` 形如 `"@e3"`；`selector` 是 CSS 选择器。**两者必须恰好给一个**，都给或都不给 → `E_BAD_ARG`。

`evaluate --unverified`（协议 1.9）：跳过观察/上下文一致性校验后执行表达式，控制权、暂停状态、
会话与标签页归属仍然生效；不能与 `--expect`/`--depends-on`/`--observation` 同时使用，结果带
`verified:false`。daemon 会对未声明 `unverified` 能力的扩展返回 `E_UNSUPPORTED_CAPABILITY`。

### 5.3 错误码（扩展侧）
| code | 含义 |
| --- | --- |
| `E_BAD_ARG` | 参数缺失/冲突（如 ref 与 selector 同时给） |
| `E_NOT_FOUND` | ref/selector 找不到元素 |
| `E_STALE_REF` | ref 指向的元素已不在文档里（导航或 DOM 重建），需重新 observe |
| `E_TIMEOUT` | 等待类命令超时 |
| `E_NAV_FAIL` | 导航失败（chrome.tabs.update 报错） |
| `E_JS_ERROR` | evaluate 内 JS 抛异常（message 带堆栈首行） |
| `E_NO_TAB` | tabId 不存在（tab 被用户关了） |
| `E_UNKNOWN_METHOD` | 未知 method |
| `E_INTERNAL` | 其它异常 |

完整错误码清单（由 `tools/gen-error-codes.mjs` 从 `lib/error-codes.mjs` 生成，勿手改）：

<!-- error-codes:begin -->
| code | 含义 |
| --- | --- |
| `E_BAD_ARG` | 参数缺失/冲突（如 ref 与 selector 同时给） |
| `E_NOT_FOUND` | ref/selector 找不到元素 |
| `E_NOT_ACTIONABLE` | 目标存在但不可操作（不可见 / 禁用 / 尺寸为 0） |
| `E_STALE_REF` | ref 指向的元素已不在文档里，需重新 observe |
| `E_OPTION_NOT_FOUND` | select 的目标选项不存在 |
| `E_OPTION_AMBIGUOUS` | select 的选项文本匹配到多个 |
| `E_UNKNOWN_METHOD` | 未知 method |
| `E_NO_SESSION` | 没有活动会话 |
| `E_SESSION_BUSY` | 同一会话已有进行中的操作 |
| `E_SESSION_PAUSED` | 会话已被人工接管（暂停） |
| `E_SESSION_STOPPED` | 会话已结束 |
| `E_QUEUE_FULL` | daemon 队列已满 |
| `E_RATE_LIMITED` | 请求过于频繁 |
| `E_CANCELLED` | 操作被取消 |
| `E_REQUEST_CANCELLED` | 请求在排队阶段被取消 |
| `E_INPUT_BUSY` | 输入通道被占用 |
| `E_NO_TAB` | tabId 不存在（tab 被关闭） |
| `E_NO_BROWSER` | 没有可用的浏览器实例 |
| `E_BROWSER_AMBIGUOUS` | 浏览器选择器匹配到多个实例或同名名称 |
| `E_START_PENDING` | 会话启动中，操作尚未就绪 |
| `E_START_NOT_READY` | 会话尚未就绪，稍后重试 |
| `E_OBSERVATION_STALE` | 观测结果已过期，需重新 observe |
| `E_CURSOR_STALE` | 分页游标已过期 |
| `E_CONTEXT_REQUIRED` | 该动作要求先提供上下文 |
| `E_CONTEXT_STALE` | 上下文与当前页面不一致（或已被重新 sync 吊销） |
| `E_COOPERATION_STALE` | 协作输入层 authority 已失效且无法重新对齐 |
| `E_CONTROL_CONTEXT_INVALID` | 控制面 context_id 缺失/过期/与当前文档或帧不匹配 |
| `E_UNSUPPORTED_FEATURE` | 对端扩展不支持所要求的 feature（协商未回执或版本过旧） |
| `E_DEPENDS_FAILED` | 前置依赖步骤未成功 |
| `E_EXPECT_FAILED` | expect 断言不匹配 |
| `E_OBSERVATION_CHANGED` | 页面在观测后已变化（观测代数不符） |
| `E_TARGET_DETACHED` | 观测时的目标节点已从文档中移除（节点级校验） |
| `E_TOKEN_BAD_ARG` | passthrough 令牌参数非法（缺 token 或 grantee） |
| `E_TOKEN_UNKNOWN` | passthrough 令牌不存在或已被清理 |
| `E_TOKEN_EXPIRED` | passthrough 令牌已过期 |
| `E_TOKEN_USED` | passthrough 令牌已被消费（一次性） |
| `E_TOKEN_GRANTEE` | passthrough 令牌与调用方 grantee 不匹配 |
| `E_TOKEN_CAPACITY` | passthrough 令牌存储已满且无法驱逐 |
| `E_CAPTURE_BAD_TAB` | capture 抑制引用的 tabId 非法 |
| `E_CAPTURE_LIMIT` | 同一 tab 的 capture 抑制引用超过上限 |
| `E_SESSION_STATE` | 会话状态不允许该操作（状态机拒绝） |
| `E_SESSION_TRANSITION` | 会话状态迁移非法 |
| `E_LEDGER_IO` | 意图账本读写失败 |
| `E_LEDGER_WAL_IO` | 意图账本 WAL 写入失败 |
| `E_LEDGER_FSYNC` | 意图账本持久化（fsync）失败 |
| `E_LEDGER_RECOVER` | 意图账本崩溃恢复失败 |
| `E_LEDGER_CONFLICT` | 账本结论冲突（重复 resolve 且结论不一致） |
| `E_LEDGER_RESOLVE_REQUIRED` | 非幂等动作的 UNKNOWN 必须显式 resolve(confirmed|not-applied) |
| `E_TAB_LEASE_HELD` | tab 已被其它会话租用 |
| `E_TAB_LEASE_NOT_HELD` | tab 租约不存在或已被释放 |
| `E_SNAPSHOT_DISABLED` | MCP 快照持久化被关闭（BB_MCP_SNAPSHOT=off） |
| `E_SNAPSHOT_WRITE` | MCP 快照写盘失败 |
| `E_SNAPSHOT_CORRUPT` | MCP 快照文件损坏或格式不符 |
| `E_UNSUPPORTED` | 不支持的请求（兼容别名；优先使用 E_UNSUPPORTED_CAPABILITY） |
| `E_ARG_MISSING` | CLI 参数缺失（必填项未提供） |
| `E_ARG_TYPE` | CLI 参数类型非法 |
| `E_ARG_ENUM` | CLI 参数取值不在枚举内 |
| `E_ARG_CONFLICT` | CLI 参数互斥组合冲突 |
| `E_ARG_REQUIRES` | CLI 参数依赖缺失（如 --share 需要 --tab） |
| `E_ARG_RANGE` | CLI 参数数值超出范围 |
| `E_ARG_UNEXPECTED` | CLI 参数不被该子命令接受 |
| `E_ARG_USAGE` | CLI 用法错误 |
| `E_UNKNOWN_FLAG` | 未知命令行选项 |
| `E_BAD_SUBCOMMAND` | 未知子命令 |
| `E_HUMAN_GATE` | 需要人工确认后才能继续（human gate） |
| `E_EVAL_CORPUS` | eval 语料格式/元数据非法 |
| `E_EVAL_RUNNER` | eval 离线运行器执行失败 |
| `E_EVAL_DOM` | eval DOM 层失败 |
| `E_EVAL_DOM_ARGS` | eval DOM 运行参数非法 |
| `E_EVAL_DOM_BAD_FACTS` | eval DOM 事实读取结果非法 |
| `E_EVAL_DOM_BAD_JSON` | eval DOM 事实 JSON 解析失败 |
| `E_EVAL_DOM_FIXTURE` | eval DOM 夹具缺失或不可读 |
| `E_EVAL_DOM_NO_BROWSER` | eval DOM 需要真实浏览器但未找到 |
| `E_EVAL_DOM_NO_FACTS` | eval DOM 未产出事实 |
| `E_EVAL_DOM_NO_MARKER` | eval DOM 页面缺少完成标记 |
| `E_EVAL_DOM_SPAWN` | eval DOM 浏览器进程启动失败 |
| `E_OCCLUDED` | 目标被遮挡（浮层/弹窗） |
| `E_OBSCURED` | 视觉坐标落点被铺满视口的元素遮住 |
| `E_TARGET_MISMATCH` | 视觉坐标落点不属于预期的候选目标 |
| `E_CAPTURE_STALE` | 截图 capture 不存在或已过期 |
| `E_BAD_MODE` | 动作模式取值不支持 |
| `E_DIALOG_PENDING` | 有未处理的页面原生弹窗 |
| `E_EXISTS` | 同名资源已存在 |
| `E_CACHE_EMPTY` | 缓存为空 |
| `E_TOO_LARGE` | 结果超过大小上限 |
| `E_RESULT_TOO_LARGE` | 结果超过协议允许的大小 |
| `E_JS_ERROR` | 页面内 JS 抛异常 |
| `E_NAV_FAIL` | 导航失败 |
| `E_TIMEOUT` | 等待类命令超时 |
| `E_DEBUGGER_BUSY` | 调试器被其它会话占用 |
| `E_UNSUPPORTED_CAPABILITY` | 当前版本不支持该能力 |
| `E_UNSUPPORTED_REMOTE` | 远程连接不支持该能力 |
| `E_PROTOCOL_UNSUPPORTED` | 协议版本不兼容 |
| `E_PROTOCOL_AUDIT` | 协议审计失败（proof obligations / 兼容矩阵 / 迁移计划自检不通过） |
| `E_AUTH` | 本机鉴权失败 |
| `E_AUTH_BUSY` | 鉴权通道正被另一请求占用 |
| `E_AUTH_CHALLENGE` | 鉴权挑战无效 |
| `E_AUTH_EXPIRED` | 鉴权挑战已过期 |
| `E_AUTH_FAILED` | 鉴权证明不匹配 |
| `E_AUTH_PROOF` | 鉴权证明格式或签名字段无效 |
| `E_AUTH_STATE` | 鉴权状态机不允许该操作 |
| `E_PAIR_INVALID` | 配对码无效或已使用 |
| `E_PAIR_REQUIRED` | 需要先完成本机配对 |
| `E_PAIR_REJECTED` | 配对 token 已绑定到其它浏览器，请重新配对 |
| `E_PAUSED_MANUAL` | 会话因人工接管而暂停 |
| `E_LEDGER_PENDING` | 有未确认的意图账本记录 |
| `E_DAEMON` | daemon 不可用（未启动或连接失败，客户端侧码） |
| `E_NO_DAEMON` | 连不上 daemon |
| `E_DAEMON_TIMEOUT` | daemon 在限定时间内没有响应 |
| `E_DISCONNECTED` | 连接已断开 |
| `E_EXTENSION_GONE` | 浏览器扩展已断开 |
| `E_LISTEN` | daemon 端口监听失败 |
| `E_SPAWN` | 子进程启动失败 |
| `E_ENV` | 运行环境不满足要求 |
| `E_CONFIG_INVALID` | 配置项取值无效 |
| `E_BAD_JSON` | 请求或文件不是合法 JSON |
| `E_BAD_REQUEST` | 请求格式不合法 |
| `E_INVALID_PARAMS` | 参数无效 |
| `E_DIRECT_RPC_DISABLED` | 直连 RPC 已被关闭 |
| `E_RPC` | RPC 调用失败 |
| `E_OUTPUT` | 输出写入失败 |
| `E_TARGET_NOT_FILLABLE` | 目标不可填写（不是输入框/可编辑区） |
| `E_NOT_SELECT` | 目标不是 select 元素 |
| `E_BROWSER` | 浏览器侧操作失败 |
| `E_SCREENSHOT` | 远程预览截图失败 |
| `E_PREVIEW_META` | 远程预览读取页面尺寸失败 |
| `E_CLICK` | 远程预览点击失败 |
| `E_KEY` | 远程预览按键失败 |
| `E_FOCUS` | 远程预览聚焦标签页失败 |
| `E_PAGE_ERROR` | 页面内执行出错 |
| `E_OBSERVE_FAILED` | 观察采集失败 |
| `E_FOLLOW_FAILED` | 跟随新标签页失败 |
| `E_RELEASE_INVALID` | 发布信息校验失败 |
| `E_UPDATE` | 更新流程失败 |
| `E_MCP_CONFLICT` | MCP 服务端口/进程冲突 |
| `E_APP_SSO_FAILED` | 应用单点登录失败 |
| `E_TRANSFER_NOT_FOUND` | 传输任务不存在 |
| `E_TRANSFER_STATE` | 传输任务状态不允许该操作 |
| `E_BORROW_DENIED` | 借用标签页被拒绝 |
| `E_BORROW_CONFLICT` | 同一标签页已被其他会话借用或正在确认中 |
| `E_BORROW_TIMEOUT` | 借用标签页超时 |
| `E_HELP_DISABLED` | 人工协助不可用 |
| `E_CONTROL_NOT_HELD` | 共享标签页的控制权不在本会话（exclusive 模式下写动作被拒绝） |
| `E_CONTROL_BUSY` | 共享标签页的控制权被其他会话持有，无法认领 |
| `E_CONTROL_STALE` | 共享标签页的控制权已换代（epoch 不符，需重新读取） |
| `E_NO_DOWNLOAD` | 没有可用的下载 |
| `E_DOWNLOAD_FAILED` | 下载失败 |
| `E_NO_FILE_CHOOSER` | 没有可用的文件选择器 |
| `E_TRANSFER_OFFSET` | 传输偏移不匹配 |
| `E_TRANSFER_LIMIT` | 传输超过大小限制 |
| `E_TRANSFER_INCOMPLETE` | 传输未完成 |
| `E_INCOGNITO_UNAVAILABLE` | 无痕窗口不可用 |
| `E_RECIPE_NOT_APPROVED` | 配方未获批 |
| `E_RECIPE_CHANGED` | 配方内容已变更 |
| `E_RECIPE_EXPIRED` | 配方已过期 |
| `E_RECIPE_DRAFT_EMPTY` | 运行日志里没有可回放的步骤（recipe 草稿为空） |
| `E_RECIPE_LOCKED` | 配方正在被另一个进程回放 |
| `E_FORBIDDEN` | 当前策略禁止该操作 |
| `E_READ_ONLY` | 会话是只读 scope，不能执行变更动作 |
| `E_EXEC_FAILED` | exec 脚本执行失败或超时 |
| `E_INTERNAL` | 其它异常 |
<!-- error-codes:end -->

### 5.4 `effect_state`

变异方法（click/fill/press/navigate/evaluate/session.start 等）的响应带效果状态：

| 位置 | 值 | 含义 |
| --- | --- | --- |
| 成功 `result.effectState` | `committed` | 扩展已回包成功，动作已派发 |
| 失败 `error.data.effect_state` | `none` | 未派发（参数/`--expect`/`--depends-on`/遮挡等前置校验失败，同时带 `dispatched:false`） |
| 失败 `error.data.effect_state` | `unknown` | 已派发或无法证明是否生效（超时/断连/页面异常） |

只读方法不带该字段。`effect_state=unknown` 时不要自动重放，先重新 observe、`cooperate sync` 或查
`ledger status`。

---

## 6. observe 文本格式与 ref 规则

`observe` 默认用语义化 VOM（aria 角色 + 可见文本），不是原始 HTML。
多行文本，每行一个节点，缩进 2 空格表示层级：

```
- document "Example Domain"
  - navigation
    - link "More information..." [@e1]
  - heading "Example Domain" [level=1]
  - paragraph: This domain is for use in illustrative examples.
  - textbox "Search" [@e2]
  - button "Submit" [@e3] [disabled]
```

规则（扩展实现必须遵守）：
1. 只输出**可交互或有语义**的节点：role 来自 aria role 或标签映射（`a→link`、`button`、`input[type=text]→textbox`、
   `select→combobox`、`textarea→textbox`、`input[type=checkbox]→checkbox`、`h1-h6→heading`、`nav`、`main`、`form`、
   `img→img`、`table`、`li`、`p→paragraph`）。
2. 每个可交互节点（link/button/textbox/checkbox/combobox/radio/switch/menuitem/tab/option/…）分配 `[@eN]`，
   N 从 1 递增；不可交互节点不带 ref。
3. 名称取 aria-label → aria-labelledby → 元素可见文本 → placeholder → title → name，截断到 80 字符，
   用双引号包裹，内部双引号转成 `'`。文本节点（paragraph/heading 纯文本）用 `: ` 后接文本，同样截断 120 字符。
4. 状态标记：`[level=N]`、`[disabled]`、`[checked]`、`[expanded]`、`[selected]`、`[required]`。
5. `probeHover: true` 时，对「有子菜单但内容默认隐藏」的触发器额外输出 `[hover first: A | B]` 标记，
   列出最多 5 个可悬停条目；普通元素不探测。
6. 跳过 `display:none` / `visibility:hidden` / `opacity:0` / 尺寸为 0 的元素；跳过 `script/style/noscript/template`。
7. 只遍历主文档（MVP 不深入 iframe；页面若有 iframe，在文本里输出 `- iframe "src"` 占位）。

**ref 生命周期**：`observe` 每次重建 ref 表（`@e1` 从 1 重新编号）。导航、`reload`、`tab.close` 清空该 tab 的 ref 表。
元素被移出文档后，动作命令检查 `element.isConnected === false` → `E_STALE_REF`。

`snapshot` 是静态 a11y 树（role + name + level），带 `@eN` ref，可直接用于 read/click。

---

## 7. CLI 命令面（`bridge`）

全局参数：`--session <id>`（页面命令必需）、`--json`、`--port <n>`、`--timeout <ms>`、`-h/--help`。

```
bridge status                        # daemon + 浏览器 + session 总览
bridge browsers                      # 已连接浏览器实例
bridge doctor                        # 环境自检（node/端口/扩展/daemon）
bridge daemon start|stop|restart|status|log [--tail]

bridge session start [--browser <id|名字|edge|chrome>] [--tab <tabId>] [--share] [--control open|exclusive] [--no-focus] [--request-id <token>]
                     # 每个 session 新建并聚焦一个独立 Agent Window；--no-focus 才后台开窗
bridge open [url] [--observe]   # 一步式：session + navigate（可同时返回 observation）
bridge session stop <id> [--keep]
bridge session list
bridge session control <id> [--mode open|exclusive]
bridge session claim-control <id> [--lease 60s] [--expect-epoch N]
bridge session release-control <id> [--expect-epoch N]
bridge session handoff <id> --to <targetSessionId> [--lease 60s] [--expect-epoch N]

bridge navigate <url> [--no-focus]
bridge reload | back | forward
bridge observe [--probe-hover] [--json]      # --json 时 result 原样输出
bridge snapshot
bridge get-html [--ref @eN | --selector css]
bridge screenshot --out <path> [--full] [--stream]
bridge screenshot --out <path> --stitch
bridge click <ref|selector>
bridge hover <ref|selector>
bridge fill <ref|selector> --value <text>
bridge press <key> [--ref <ref>]
bridge select <ref|selector> --value <value>
bridge focus <ref|selector>
bridge scroll-to <ref|selector>
bridge evaluate <expression> [--unverified] [--json]
bridge wait-for-element <selector> [--state visible] [--timeout 10000]
bridge wait-ms <ms>
bridge console [--since N]

bridge tab list [--scope agent|user]
bridge tab new [url] [--focus] [--window]
bridge tab close <tabId>
bridge tab select <tabId>
bridge window resize --width <n> --height <n>
```

* 页面命令找不到 `--session` 时：如果 daemon 里**恰好只有一个** session，自动用它；否则报
  `E_NO_SESSION` 并列出可用 session。
* 退出码：成功 0；业务失败 1；参数错误 2。
* `--json` 输出 `{"ok":true,"result":...}` / `{"ok":false,"error":{...}}` 原样；人类可读输出由 CLI 决定。
* `screenshot --out` 由 CLI 写文件（daemon 不落盘；dataUrl 里的 `data:image/png;base64,` 前缀去掉后写字节）。
  超大截图用 `--stream`：扩展把 base64 暂存（5 分钟 TTL，最多 4 份），CLI 按 `screenshot.read`
  分块（512KB base64/块）取回拼文件，完成后 `screenshot.release`；单次 RPC 不再携带数 MB dataUrl。
  dataUrl 超过约 1.5MB 时即使不带 `--stream` 也自动走流式（结果里 `streamed:true`）。
* `screenshot` 默认后台抓取；只有在显式 `--focus` 时才临时把窗口/标签置前（见 §12.2.3）。
* `observe` 人类可读输出：先打印 `url`/`title` 一行，再打印 observation 原文。

`bin\bridge.cmd` 是 Windows 入口，内容：
```bat
@echo off
"C:\Users\CFT\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "%~dp0..\cli\bridge.mjs" %*
```
（`bridge.cmd` 里 node 路径要改成运行时探测：先 `node`，再 DSH 内置路径；见 README。）

---

## 8. 安全与边界

* 只监听回环；token 保护 `/rpc`；WS 只认 `/ws` 且忽略来源（扩展不会带 Origin）。
* 不读取/不导出 cookie、localStorage、密码管理器内容；`evaluate` 只做用户要求的页面操作。
* 所有写操作默认只作用于 agent 窗口的 tab；`tab.list --scope user` 只列不借。
* `screenshot` 默认后台抓取，不置前窗口；显式 `--focus` 才临时置前（§12.2.3）。

---

## 9. 验收（E2E）

`node tools/e2e.mjs` 必须做到（不需要用户手点）：
1. 启动 daemon（临时 `BB_HOME`）。
2. 用独立 user-data-dir 启动 Edge：`--load-extension=<repo>\extension --no-first-run --no-default-browser-check`。
3. `session start` → `navigate` 到本地 `http://127.0.0.1:<port>/test.html`（e2e 顺带起一个静态页服务器，
   页面含标题、输入框、按钮、a11y 语义，按钮点击后 `#out` 文本变为 `clicked`）。
4. `observe` 输出里能看到 `textbox`、`button` 和 `@eN` ref。
5. `fill @eN --value hello` → `click @eN` → `get-html` 断言 `#out` 文本为 `clicked`。
6. `screenshot --out tmp/shot.png` 断言 PNG 魔数 + 尺寸 > 100x100。
7. `session stop` 后 daemon 里无残留 session。
8. 多 Agent 共享 tab：`20q10`（共享写 + tab 队列）、`20q11`（exclusive 闸门 / 租约到期 / handoff / epoch CAS）、`20q12`（主会话停止 → 控制权与主会话身份转交，tab 存活）。
9. 全程无沙箱/权限报错，退出码 0。

> 实现注意：`tools/e2e.mjs` 的夹具页 HTTP 服务与 CLI 调用在同一个 Node 进程里。
> CLI 必须用**异步** spawn（await 子进程结束），不能用 `spawnSync`：同步调用会堵死事件循环，
> 浏览器请求夹具页时服务端无法响应，`navigate` 等不到 `complete` 只能吃满 30s 超时（v0.1 曾因此整条 E2E 红）。
> 收尾时先等浏览器进程真正退出、再带重试删临时目录，否则 Windows 上 profile 被占用会留下 `%TEMP%\bb-e2e-*`。
>
> 浏览器选择：默认 `--browser edge`。Chrome 137+ 稳定版已忽略 `--load-extension`（扩展根本不会加载，
> 表现为 20s 内无实例连上），要跑 Chrome 需改用 Chrome for Testing/开发版，或先手动在
> `chrome://extensions` 加载 `extension/`。E2E 在前三步任一失败时会直接中止并给出原因，不再连锁报 `E_NO_SESSION`。

---

## 10. 实现补充（当前实现）

以上正文是第一版契约；实现期间确定的细节统一记在这里，避免两侧再次跑偏。

1. **daemon 生命周期是内部方法**：`daemon.stop`（需要 token，`params: { }`）与
   `node daemon/server.mjs --stop` 不在公开命令面里，仅 CLI 的 `bridge daemon stop` 使用。
2. **`screenshot --json` 收窄**：`dataUrl`（数 MB）不打印；`--json` 输出
   `{ "ok": true, "result": { "path": "<落盘路径>", "width": N, "height": N, "bytes": N } }`。
   人类可读模式同样打印落盘路径与尺寸。`dataUrl` 只存在于扩展 → daemon 的内部响应里。
3. **`navigate` 不带 `--no-focus`**：聚焦只由 `session start --no-focus` 决定；CLI 接受该参数但忽略。
4. **`hello.instanceId` 语义**：扩展可在重连时带上一次的 `instanceId`（8 位 hex）；
   daemon 若认出该实例则复用 id、替换连接并保留 session，否则以 daemon 生成的为准。
5. **`tab.*` 多实例**：`tab.list|new|close|select` 接受可选 `browser`（instanceId 或 edge/chrome 前缀），
   缺省按「edge → chrome → 最近连接」选实例；歧义时给 `E_BAD_ARG`。
6. **错误码补充**：§5.3 之外还有 `E_NO_BROWSER`（没有浏览器连上）、`E_AUTH`（token 错）、
   `E_NO_SESSION`（无/多 session 歧义，message 里列出候选）。
7. **`/rpc` 的 404**：方法不存在时返回 `{ "ok": false, "error": { "code": "E_UNKNOWN_METHOD", ... } }`。
8. **`session.stop` 支持 `params.keep`**：`keep: true` 时只删 session 记录、不关 agent 窗口。
9. **超时宽限**：daemon 对扩展命令的计时是 `timeoutMs + 500ms`，让扩展有机会先回自己的 `E_TIMEOUT`。
10. **`--json` 单行**：CLI 的 `--json` 模式 stdout 只有一行 JSON，日志一律走 stderr（或文件）。


---

# 第二部分 · v0.2（能力面扩展）

v0.1 只覆盖「开窗口 → 读页面 → 点填选 → 截图」的最小闭环。v0.2 在**不引入任何第三方依赖**的前提下
补齐核心能力面：读取字段、表格导出、拖拽/滚轮/失焦、文件上传下载、原生对话框、
网络采集、仿真、标签页借用与归还、人工协助、长截图与扩展弹窗/设置 UI、观察结果缓存、plan/recipe、
profile 命名、操作审计、install-skill。

**约定**：未特别说明的参数/返回值/错误码沿用第 1 部分；新增方法名不得与 v0.1 冲突；错误码优先复用 §5.3。

## 11. 扩展 UI 与设置

扩展新增三个界面，全部纯 HTML/CSS/JS（无构建步骤）：

| 入口 | 文件 | 作用 |
| --- | --- | --- |
| 工具栏弹窗 | `extension/ui/popup.html` | 连接状态、实例名、活动会话、快捷功能（可见截图 / 整页长截图 / 手动拼接）、设置入口 |
| 设置页 | `extension/ui/options.html` | 借用前确认、允许人工协助、默认长截图模式、实例名、daemon 端口提示 |
| 图标 | `extension/icons/*.png` | 16/32/48/128 四档；无图标文件时 manifest 不得引用 |

设置存 `chrome.storage.local` 的 `bb.settings`：

```json
{ "instanceLabel": "", "borrowConfirm": true, "allowHelp": true, "longShotMode": "auto", "pageGuard": true }
```

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `instanceLabel` | string | `""` | 浏览器实例名（≤40 字符），随 `hello.label` 上报，可被 `--browser <名字>` 选中 |
| `borrowConfirm` | bool | `true` | 为 true 时 `tab.borrow` 要先在目标标签页里弹出确认条，用户同意才接管 |
| `allowHelp` | bool | `true` | 为 false 时 `request-help` 直接返回 `E_HELP_DISABLED` |
| `longShotMode` | `"auto"`\|`"manual"` | `"auto"` | 弹窗里长截图的默认模式 |
| `pageGuard` | bool | `true` | 为 true 时，落进 agent 窗口的「外部/用户」标签页自动移回用户窗口 |

* 设置改动立即生效（`chrome.storage.onChanged`），不需要重载扩展。
* 弹窗每 2s 通过 `chrome.runtime.sendMessage({type:'bb.popup.state'})` 拉一次状态；SW 回
  `{ connected, instanceId, daemonVersion, port, label, sessions: [...], agentWindowId }`。
* **界面不得读取页面内容**；只展示扩展自身状态（连接、窗口、会话、截图）。

### `settings.get` / `settings.set`（扩展方法，供 daemon/CLI 读写）

| method | params | result |
| --- | --- | --- |
| `settings.get` | `{}` | `{ settings, label }` |
| `settings.set` | `{ patch: {...} }` | `{ settings }` |

CLI 对应 `bridge ui [--page popup|options]
bridge settings [--json]` 与 `bridge settings set --label <名字> --borrow-confirm on|off --allow-help on|off`。

## 12. 新页面方法（page-lib）

### 12.1 `read` — 读字段值/属性

`{ tabId, ref?, selector?, all?: bool }` → 
`{ fields: [ { ref?, tag, type, name, value, checked?, selectedOptions?, disabled, readonly, required, contentEditable, placeholder? } ] }`

* `all: true` 时忽略 ref/selector，返回主文档里所有 `input/textarea/select/[contenteditable]`（最多 500 个）。
* `ref`/`selector` 语义同 §5.2（恰好给一个）。
* `value`：input/textarea 取 `value`，select 取 `value` 且另给 `selectedOptions`（`[{value,label}]`），
  contenteditable 取 `innerText`。密码框仍然返回 `value`（用户已授权在真实登录态里操作），
  但 CLI 人类可读输出默认打码，`--json` 原样。

### 12.2 `extract` — 表格/列表结构化导出

`{ tabId, selector?, ref?, format?: "json"|"csv", maxRows?: 500, maxBytes?: 262144, maxCells?: 20000 }` →
`{ kind: "table"|"list", columns: [{ key, label }], rows: [ {...} ], rowCount, cells, truncated, coverage, budget, warnings: [...] }`

`coverage` 说明本次抽取到底覆盖了多少（`datasetComplete` 只表示"页面自己声明了总数且确实读满"，不代表页面内容真的完整）：

```json
{ "scope": "loaded-dom", "returned": 20, "declared": 42,
  "stopReason": "max-rows", "datasetComplete": "incomplete" }
```

- `declared`：取自 `aria-rowcount` / `aria-setsize`；页面没声明就是 `null`（不猜）。
- `omitted`：`declared - returned`（无声明为 `null`）。
- `stopReason`：`end`（读到末尾）/ `max-rows`（行数上限）/ `max-cells`（单元格上限）/ `max-bytes`（字节上限）。
- `datasetComplete`：`complete`（声明数已读满）｜`incomplete`（被截断）｜`unknown`（无声明）。
- 只覆盖已加载的 DOM：分页、无限滚动、canvas 渲染、closed shadow 里的内容都不在范围内。

结果里同时带 `budget`（本次预算证据）与 `cells`：

```json
{ "cells": 20,
  "budget": { "maxRows": 500, "maxBytes": 262144, "maxCells": 20000,
              "rows": 20, "cells": 20, "bytes": 1832, "stopReason": "end" } }
```

预算归一化（与页面侧一致）：`maxRows` 默认 500 / 上限 5000；`maxBytes` 默认 256 KiB / 范围 1 KiB–4 MiB；
`maxCells` 默认 20000 / 范围 1–200000。`maxCells` 按“行 × 列”折算可返回行数（不足一行时返回 0 行并
`stopReason:"max-cells"`），`maxBytes` 超限时从尾部丢行直到装下或没有行可丢。

**多页游标（`--cursor`）**：分块提取返回 `hasMore:true` 时附带无状态游标 `cursor`（`x1.<base64url>`）：

```powershell
bridge extract --max-rows 100 --session <id> --json      # → { rows: [...], offset: 0, hasMore: true, cursor: "x1..." }
bridge extract --cursor x1... --session <id> --json      # → { rows: [...], offset: 100, hasMore: true, cursor: "x1..." }
```

- 游标只记录 `(tabId, frameId, kind, offset, revision, target)`；续取时自动带上原 target/selector，
  也按原 `maxRows` 分块（可显式覆盖）。
- 以下情况返回 **`E_CURSOR_STALE`**：游标非法/版本不符、超过 10 分钟、跨 tab/frame、
  kind 与本次子命令不符（table/list）、游标对应的 DOM `revision` 已变化。
- 游标不持有页面对象；目标被删除/重渲染后请重新 `extract discover` 或重新提取。

### 12.2.0 `extract discover` — 候选表格/列表

```powershell
bridge extract discover [--max-targets 32] [--preview-columns 8] --session <id> --json
```

返回 `{ targets, frameCount, framesScanned, framesSeen, truncated, limits }`：

- 上限对齐：**16 帧**（主文档优先，其余按 frameId）、**32 个 target**（跨帧全局）、**8 列预览**；
  超限时 `truncated:true`，`limits` 回显本次上限（`{maxFrames,maxTargets,previewColumns}`）。
- 每个 target：`{ id, kind, label, rows, columns, preview: { columns: [...], sample: [...] }, frameId, frameUrl? }`；
  `preview.columns` 是表头（≤8，每个 ≤60 字符），`preview.sample` 是首行样例（≤8，每个 ≤80 字符）。
- `framesSeen` 是页面总帧数，`framesScanned` 是实际扫描的帧数（≤16）。
- 取用仍按 `--target <id> --frame <frameId>`（target 句柄 5 分钟过期）；没有多帧信息时（单帧降级）
  返回同样的结构，`frameId` 为 0。

规则：
1. 目标是 `table` 时按 thead 取列名；没有 thead 用首行 `th` 或首行 `td` 文本；列 key 为 `c1..cN`。
2. 单元格带 `rowspan/colspan` 时在 `rows[i].__spans` 记录 `{ col: {rowspan, colspan} }`，不展开占位。
3. 目标是 `ul/ol` 或带 `role=list` 时 `kind:"list"`，每项一行 `{ index, text }`；项内有 `a` 时附 `href`。
4. 目标是其它元素且含 `table` 子节点时，取第一个 `table`。
5. `maxRows` 默认 500、上限 5000；`maxCells` 默认 20000、`maxBytes` 默认 256 KiB。任一超限都 `truncated: true`，`coverage.stopReason` 与 `budget.stopReason` 标 `max-rows`/`max-cells`/`max-bytes`。
6. `format:"csv"` 时 CLI 直接落盘 `--out`，扩展只返回 json 结构（CSV 由 CLI 生成，避免扩展侧编码差异）；CSV 模式也会打印一行覆盖度。

### 12.2.1 观测代数（`revision` / `expectRevision`）

`observe`、`read`、`extract` 的结果都带 `revision`（当前文档的 DOM 代数）。动作方法可以带 `expectRevision: <整数>`，扩展在派发前比对：

- 一致 → 正常执行；
- 不一致 → `E_OBSERVATION_CHANGED`，**不派发任何输入**，并回报"观测代数 N，当前 M"。

```powershell
bridge observe --session <id> --json            # → { "revision": 16, "refs": 42, ... }
bridge read "@e3" --session <id> --json         # → { "value": "...", "revision": 16 }
bridge extract --session <id> --json            # → { "rows": [...], "revision": 16 }
bridge click "a" --expect-revision 16 --session <id>   # 同一代数内，执行
bridge click "a" --expect-revision 3  --session <id>   # → E_OBSERVATION_CHANGED
```

**读和写用同一个代数**，就能表达"我读到的值到现在没变过"：先 `read` 拿 `revision`，接着带 `--expect-revision` 去点/填，中间页面若重渲染过会被挡下——避免把基于旧内容做的判断作用到新页面上。

用途：SPA 自动刷新、轮播、无限滚动这类页面，从观测到动作之间内容可能整体换掉，此时 ref 指向的语义已经变了。默认不开启（不带 `expectRevision` 就不校验），避免误伤无关的 DOM 变化。

### 12.2.2 节点级校验（`nodeScope`，`target_detached` / 节点级 `observed_changes`）

整页 `revision` 只能回答"页面变没变"，回答不了"我要操作/读取的那个节点变没变"。`cooperate sync` 会为当前 ref 表记录一份**节点签名**（tag/id/name、文本哈希、值哈希、属性哈希、几何、disabled/checked；只输出摘要，不含文本内容）：

```json
{ "node_scope": { "count": 42, "unique": 40, "refs": 42, "revision": 16 } }
```

动作/读取可带 `nodeScope: true`（CLI `--node-scope`）+ `--observation`：

- 目标节点仍在且签名未变 → **放行**，即使页面其他位置变了（这是与整页校验的核心差别）；
- 目标节点已被移除 → `E_TARGET_DETACHED`，`data: { ref, scope:'node', reason, observed_revision, current_revision }`；
- 目标节点自身的文本/值/属性/状态变了 → `E_OBSERVATION_CHANGED`，`data.observed_changes = { scope:'node', ref, kinds:['text'|'value'|'attributes'|'state'|'identity'|'detached'], advisory:['geometry'], changes:[{kind,field,before,after}] }`；
- 纯几何变化（滚动/重排）只作为 `advisory` 记录，不阻断；
- 目标是 CSS selector、或该 ref 在 sync 时没有签名 → 回退到整页 `revision` 校验（`E_OBSERVATION_STALE`）。

```powershell
bridge cooperate sync --session <id>                     # → node_scope 摘要
bridge click @e5 --observation ob1 --node-scope --session <id>   # 无关节点变了也放行
bridge read @e1 --observation ob1 --node-scope --session <id>    # 读取类同样支持
```

未带 `--node-scope` 时行为不变（整页 `E_OBSERVATION_STALE`）。

### 12.2.3 焦点策略（默认不抢用户焦点）

对齐参考实现的行为：**默认后台执行，不主动把浏览器窗口/标签页置前**。

- 会话标签页由 `debugger.armTab` 开启 `Emulation.setFocusEmulationEnabled`：页面自认可见/聚焦，
  CDP 原生鼠标/键盘输入可在后台 Agent Window 直接派发；
- 未挂 CDP 的标签页（借用/预挂失败）走同一策略：临时 `Emulation.setFocusEmulationEnabled(true)` +
  `Page.setWebLifecycleState({state:'active'})`，**不调用** `Page.bringToFront` /
  `chrome.windows.update({focused:true})` / `chrome.tabs.update({active:true})`；
- 显式 `--focus`（`params.focus:true`）才会置前：`session start --focus`、`tab new --focus`、
  动作/截图 `--focus`（回退路径用）；
- `tab select`、`window focus`、系统通知点击属于**用户显式要求**的置前，保持原行为；
- `request-help` / borrow 确认是人工交接界面，仍会置前提醒用户（一次一格）；
- `chrome.windows.create` 默认 `focused:false`；`chrome.tabs.create` 默认 `active:false`。

```powershell
bridge session start            # 后台开 Agent Window，不打断用户
bridge session start --focus    # 显式置前
bridge tab new https://x        # 新 tab 不激活
bridge click @e3 --trusted      # 后台派发原生输入（无需置前）
```

未传 `--focus` 时窗口/标签页的前台状态、`window.list` 的 `focused` 与 `active` 均不应被改变。

**实现审计**（2026-11-19；`tools/source-guard.mjs` 会拦截 `extension/src` 里新增的 `Page.bringToFront`）：

| 位置 | 行为 | 可置前 | 触发条件 | 分类 |
| --- | --- | --- | --- | --- |
| `interaction.js` `ensureInputFocus` | `tabs.update(active)` / `windows.update(focused)` | 是 | 仅 `focusRequested(params)` 分支 | 显式 `--focus` |
| `background-execution.js` `withForegroundTab` | 切 active + 恢复 | 是 | 仅 `{focus:true}` / `{foreground:true}` | 显式 |
| `tabs.js` `ensureAgent` / `newAgentWindow` | 建窗/建 tab + 末尾聚焦 | 是 | `focusRequested(params)` | 显式 |
| `tabs.js` `tabNew` | 建 tab/window 的 `active`/`focused` | 是 | `--focus` | 显式 |
| `tabs.js` `tabSelect` / `windowFocus` | 置前 | 是 | `tab select` / `window focus` | 用户显式命令 |
| `screenshot.js` `captureVisibleTab` 回退 | 窗口/标签置前 + 恢复 | 是 | `focusRequested(params)` | 显式 |
| `shadow.js` closed-shadow 点击 | 曾 `Page.bringToFront` | **已移除**（只开焦点仿真） | 任意动作 | 后台 |
| `interaction.js` 可信/拖拽/click-backend | 曾 `Page.bringToFront` | **已移除**（焦点仿真 + lifecycle） | 任意动作 | 后台 |
| `tabs-help.js` `requestHelp` | 置前 + 激活 | 是 | `request-help` | 人工协作 |
| `borrow-ui.js` / `tabs-borrow.js` | 置前/激活/页面内 focus | 是 | 借用确认 | 人工协作 |
| `bridge.js` 通知点击 | 置前 | 是 | 用户点系统通知 | 用户主动 |
| `preview.js` | 置前 | 是 | 用户在扩展 UI 点“预览” | 用户主动 |
| `overlay-ui.js` 借用弹窗 | 页面内 `focus()` | 页面内焦点 | 借用确认弹窗 | 人工协作 |
| `chrome.tabs.query({active:true})`（多处） | 只读查询 | 否 | — | 无影响 |
| `tools/*.mjs` 诊断脚本 | `Page.bringToFront` | 是 | 手工运行 | 不随扩展运行 |

### 12.3 交互补充
| method | params | result | 说明 |
| --- | --- | --- | --- |
| `drag` | `{ tabId, from: ref\|selector, to: ref\|selector, mode?: "hold"\|"click-move-click", steps?: int }` | `{ ok: true }` | 按元素中心点坐标派发 pointerdown/move/up；`steps` 默认 8，范围 2–40 |
| `drag`（视觉坐标） | `{ tabId?, capture: string, imageX: int, imageY: int, imageDx?: int, imageDy?: int, steps?, modifiers?, durationMs? }` | `{ ok: true, trusted: true, from, to }` | 起点取截图里的图片像素坐标，位移也用图片像素；扩展按 `capture.scale/scrollX/scrollY` 换算成页面坐标，**强制走 CDP 原生输入**（页面内合成事件对 canvas 类控件无效）。`capture` 来自 `screenshot --annotate` 或 `click --capture` |
| `wheel` | `{ tabId, deltaY, deltaX?: 0, ref?/selector?, x?, y? }` | `{ ok: true, scrollY }` | 在目标中心（或页面坐标）派发 `wheel`；页面未滚动时退化为 `scrollBy` |
| `blur` | `{ tabId, ref?, selector? }` | `{ ok: true }` | 无目标时 blur `document.activeElement` |
| `upload` | `{ tabId, ref/selector, files: [{ name, mime, base64 }] }` | `{ ok: true, names }` | 页面侧用 `DataTransfer` 组装 `File` 后赋给 `input[type=file].files`，再派发 `input/change`；总字节上限 20MB |
| `download` | `{ tabId, ref?/selector?, url?, timeoutMs?: 30000 }` | `{ downloadId, filename, bytes, state, url }` | 先点元素/导航，再等该 tab 的下载事件（需 `downloads` 权限）；`state` 为 `complete`\|`interrupted` |

### 12.4 `plan` — 一次下发多个已决定动作

`{ tabId, steps: [{ method, params }], continueOnError?: false }` →
`{ steps: [{ method, ok, result?, error? }], completed, failedAt? }`

* 在扩展侧顺序执行，**不再经过 daemon 往返**；每步仍是完整方法（可含 tabId，缺省用 plan 的 tabId）。
* 首步失败即停止（`continueOnError: true` 时继续并记录）。
* 总和超时沿用命令 `timeoutMs`（默认 60s，上限 120s）。

## 13. 原生对话框（`chrome.debugger`）

页面弹原生对话框时渲染进程主线程会被阻塞，注入脚本也跑不动，命令只能等超时。因此对话框能力
**按需**挂载 debugger，挂载期间浏览器会出现「正在调试」提示条。

| method | params | result |
| --- | --- | --- |
| `dialog.arm` | `{ tabId, policy?: { alert?: "accept"\|"dismiss", confirm?: "accept"\|"dismiss", prompt?: "accept"\|"dismiss", promptText?: string, beforeUnload?: "accept"\|"dismiss", queue?: bool } }` | `{ armed: true, policy }` |
| `dialog.disarm` | `{ tabId }` | `{ ok: true }` |
| `dialog.list` | `{ tabId, clear?: bool }` | `{ dialogs: [{ id, type, message, defaultPrompt, action, at }] }` |
| `dialog.handle` | `{ tabId, id, accept: bool, promptText?: string }` | `{ ok: true }` |

* `policy.queue: true` 时不自动处理，把对话框挂起并记入 `dialog.list`，由 `dialog.handle` 决定（默认 60s 后自动 dismiss）。
* 默认 policy：`alert/confirm/beforeUnload: "dismiss"`，`prompt: "dismiss"`；`promptText` 仅在 accept 时使用。
* `beforeUnload` 采用 debugger 的 `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog`，禁止页面阻塞关闭。
* 非本扩展挂载的 debugger 会话必须让路：attach 失败回 `E_DEBUGGER_BUSY`。

## 14. 网络采集（`network`）

| method | params | result |
| --- | --- | --- |
| `network.start` | `{ tabId, bodies?: false }` | `{ captureId, bodies }` |
| `network.stop` | `{ tabId }` | `{ ok: true }` |
| `network.list` | `{ tabId, since?: ts, limit?: 200, filter?: { method?, status?, type?, urlContains? } }` | `{ entries: [...] }` |
| `network.detail` | `{ tabId, id }` | `{ entry, requestBody?, responseBody?, truncated? }` |
| `network.replay` | `{ tabId, id, overrides?: { method?, url?, headers?, body? } }` | `{ status, headers, body, durationMs }` |

条目结构：`{ id, method, url, status, type, startedAt, durationMs, requestBytes, responseBytes, error?, fromCache, pageUrl }`。

* 统一用 debugger 的 `Network` 域采集元数据与正文（可能出现调试提示条），正文上限 1MB、超出标记 `truncated`。
* 采集绑定 tabId，页面导航后继续（同一 tab 的新文档）。
* `network.replay` 在页面上下文用 `fetch` 发同源请求，可能改变服务端数据——CLI 帮助里必须写明。

## 15. 仿真（`emulate`）

`{ tabId, viewport?: { width, height, deviceScaleFactor?, mobile? }, timezone?: string, locale?: string, geolocation?: { latitude, longitude, accuracy? } | null, reset?: bool }`
→ `{ ok: true }`

* 走 `chrome.debugger` 的 `Emulation.setDeviceMetricsOverride` / `setTimezoneOverride` /
  `setLocaleOverride` / `setGeolocationOverride` / `clearGeolocationOverride`。
* `reset: true` 时清空全部覆盖（`Emulation.clearDeviceMetricsOverride` 等）。
* 覆盖在 tab 上保持，直到 `session.stop` 或 `reset`。

## 16. 标签页借用、归还与人工协助

### 16.1 借用

| method | params | result |
| --- | --- | --- |
| `tab.borrow` | `{ tabId, confirm?: bool }` | `{ tabId, windowId, originalWindowId, originalIndex, url, title }` |
| `tab.return` | `{ tabId }` | `{ ok: true, windowId }` |
| `tab.list` | `{ scope?: "agent"\|"user"\|"all" }` | `{ tabs: [ { tabId, windowId, url, title, active, owned: "agent"\|"user", controlled: bool } ] }`

* 借用只**标记**，不移动窗口：标签页留在原窗口原位，`session.stop` 时自动 `tab.return`（只清标记，不关闭）。
* 目标标签在前台时显示模态确认；目标在后台时在当前活动标签显示右下角 Toast，不抢前台；多个后台请求可堆叠。
* `borrowConfirm: true` 时，扩展在目标标签页顶部注入确认条（固定定位、白底、两个按钮，
  60s 无响应视为拒绝），用户点「允许」才完成借用；拒绝回 `E_BORROW_DENIED`，超时回 `E_BORROW_TIMEOUT`。同一标签页已由其他会话借用/确认中时回 `E_BORROW_CONFLICT`。
* 借用期间该 tab 的关闭事件会通知 daemon（`event: tab-removed`），session 随之失效。

### 16.2 人工协助

| method | params | result |
| --- | --- | --- |
| `request-help` | `{ tabId, reason, timeoutMs?: 180000, criteria?: Criterion[] }` | `{ action: "done"\|"skip"\|"timeout", note? }` |

`Criterion`（completion_criteria，最多 10 条）：

| kind | 字段 | 满足条件 |
| --- | --- | --- |
| `selector_exists` | `selector` | `document.querySelector(selector)` 非空 |
| `selector_visible` | `selector` | 元素存在、面积 > 0 且 `display/visibility/opacity` 可见 |
| `text_exists` | `text` | `document.body.innerText` 包含该文本 |
| `url_contains` | `text` | 当前标签页 URL 包含该文本（扩展侧判断） |

* 扩展在页面上叠加一条协助条（说明 `reason` + 「我先处理好了」/「跳过」两个按钮），并把窗口置前。
* 带 `criteria` 时后台每 400ms 检查一次；全部满足 → 自动返回 `action:"done"`（note=`completion criteria satisfied`），不必再点按钮。
* 用户点击后通过 `event: help-resolved` 回 daemon；`allowHelp: false` 时直接 `E_HELP_DISABLED`。
* 超时返回 `action:"timeout"`（不算错误），让 Agent 自行决定。

### 16.3 页面守卫

`pageGuard: true` 时，扩展监听 `chrome.tabs.onCreated`：新标签页落在 agent 窗口且 `openerTabId`
不属于 agent 窗口（外部链接/手动新建），就把它移到最近使用的用户窗口；没有用户窗口就新建一个。
页面自己用 `window.open` 打开的子标签（opener 在 agent 窗口内）保留。

## 17. 长截图

`screenshot` 增加 `mode` 参数：`{ tabId, mode?: "visible"|"auto"|"manual", fullPage?: bool }`。

* `visible`（默认）：当前视口。
* `auto`：等价于 v0.1 的 `fullPage: true`（滚动 − 拼接，最多 8 帧 / 16000px）。
* `manual`：返回 `{ manual: true, frame: { dataUrl, width, height, scrollY }, sessionId }`，
  由调用方多次调用（每次前进一屏）后在 CLI 侧拼接；`bridge screenshot --stitch <sessionId> --out <path>` 完成拼接。
* 弹窗里的长截图按钮走扩展内部流程（不经过 daemon）。

## 18. 观察结果缓存、`step` 与 `recipe`

* daemon 为每个 session 保存**最近一次** `observe` 的完整文本（`{ text, at, url, refs }`），
  供 `view` 分段检索，避免重复采集页面。
* `observe` 增加 `saveFull?: bool`：为 true 时 daemon 额外把完整结果返回（不做任何裁剪），
  并在 CLI 侧可用 `--save-full <path>` 落盘；CLI 用临时文件 + rename 原子写并尽量 chmod 0600。
* `step` 也支持 `--save-full <path>`，落盘本次完整 observation.text。
* `view`：`{ session, grep?, offset?: 0, limit?: 200 }` → `{ lines, total, matched, url, at }`。
* `step`：单个动作 + 同步状态，语义等价于「action → observe 的增量版本」：
  `{ tabId, action: { method, params } }` → `{ action: {...结果}, observation: { text, refs, changed } }`。
  实现上动作后重新 observe，并与上一次比较首行集合得出 `changed`。
* `recipe` 是 CLI 侧的 JSON 流程文件（`BB_HOME/recipes/*.json`）：

```json
{ "name": "登录", "steps": [ { "method": "navigate", "params": { "url": "{{url}}" } } ], "params": ["url"] }
```

  `bridge recipe save <name> --file <json>`、`bridge recipe run <name> --param k=v`、`bridge recipe list|rm`。
  运行等价于逐条 RPC（在 daemon 侧用 `plan` 一次下发，减少往返）。

## 19. profile 命名、审计、install-skill

* **profile/实例名**：设置页里的 `instanceLabel` 随 `hello.label` 上报；`browsers` 结果增加 `label`；
  `session start --browser <名字>` 可用名字精确匹配（大小写不敏感），与 instanceId/浏览器名前缀一样参与歧义判定。
* **审计**：daemon 在 `BB_HOME/audit/YYYY-MM-DD.jsonl` 追加一行/每次 RPC：
  `{ ts, method, sessionId?, id?, ok, code?, durationMs, url?, target? }`，**不记录输入值、页面正文、截图**。
  默认开启（元数据极小）；`BB_AUDIT=0` 关闭；`bridge audit list [--since 24h] [--limit N] [--json]` 读取。
* **install-skill**：`bridge install-skill [--harness dsh|claude|cursor] [--dir <path>] [--force] [--list]`，
  把内置 `skill/SKILL.md`（随 CLI 一起分发，见 `skill/` 目录）写到对应 harness 的 skill 目录：
  `dsh → %USERPROFILE%\.dsh\skills\browser-bridge`、`claude → %USERPROFILE%\.claude\skills\browser-bridge`、
  `cursor → %USERPROFILE%\.cursor\skills\browser-bridge`。已存在时默认跳过，`--force` 覆盖。

## 20. CLI 命令面 v0.2 增补

```
bridge settings [--json]
bridge settings set [--label <名字>] [--borrow-confirm on|off] [--allow-help on|off] [--long-shot auto|manual]

bridge read [--ref @eN | --selector css] [--all]
bridge extract [--ref @eN | --selector css] [--format json|csv] [--out <path>] [--max-rows N]
bridge drag <from> --to <to> [--mode hold|click-move-click] [--steps N]
bridge wheel --delta-y <n> [--delta-x <n>] [--ref @eN | --selector css]
bridge blur [--ref @eN | --selector css]
bridge upload <ref|selector> --file <path> [--file <path> ...]
bridge download <ref|selector> [--out <path>]

bridge dialog arm [--alert accept|dismiss] [--confirm accept|dismiss] [--prompt accept|dismiss] [--prompt-text <t>] [--queue]
bridge dialog disarm
bridge dialog list [--clear]
bridge dialog handle <id> --accept|--dismiss [--prompt-text <t>]

bridge network start [--bodies] | stop
bridge network list [--filter <substr>] [--status <n>] [--method GET] [--limit N]
bridge network detail <id> [--json]
bridge network replay <id> [--json]

bridge emulate [--width N --height N] [--dpr 2] [--mobile] [--timezone Asia/Shanghai] [--locale zh-CN]
               [--geolocation <lat>,<lon>] [--reset]

bridge request-help --reason <text> [--timeout ms]

bridge tab borrow <tabId> | tab return <tabId>
bridge tab list [--scope agent|user|all]

bridge screenshot --out <path> [--mode visible|auto|manual]
bridge screenshot --mode manual --stitch --out <path>

bridge observe --save-full <path>
bridge view [--grep <text>] [--offset N] [--limit N]

bridge plan --steps '<json array>'
bridge step <method> [参数...]

bridge recipe list | save <name> --file <json> | run <name> [--param k=v ...] | rm <name>

bridge audit list [--since 24h] [--json]
bridge install-skill [--harness dsh|claude|cursor] [--dir <path>] [--force] [--list]
```

* 新增命令全部支持 `--json`；人类可读输出与 §7 的风格一致。
* `bridge read` 人类可读输出密码框为 `********`；`--json` 不脱敏。
* `extract --format csv --out` 由 CLI 生成 CSV（UTF-8 BOM，Excel 友好）。
* `download --out <path>` 时 CLI 在下载完成后把文件复制到目标路径（保留扩展下载目录里的原文件）。
* 参数错误一律退出码 2；业务失败 1。

## 21. 错误码增补（v0.2）

| code | 含义 |
| --- | --- |
| `E_DEBUGGER_BUSY` | 目标 tab 已被其它 debugger 会话占用 |
| `E_BORROW_DENIED` | 用户拒绝借用标签页 |
| `E_BORROW_TIMEOUT` | 借用确认条 60s 内无响应 |
| `E_HELP_DISABLED` | 设置里关闭了人工协助 |
| `E_NO_DOWNLOAD` | 超时内没有观测到下载 |
| `E_DOWNLOAD_FAILED` | 下载中断（`state: interrupted`） |
| `E_TOO_LARGE` | 上传/网络正文超过上限 |
| `E_BAD_MODE` | `mode`/`format` 等枚举值非法 |
| `E_CACHE_EMPTY` | `view` 时该 session 还没有 observe 缓存 |
| `E_OCCLUDED` | `--trusted` 动作前命中测试发现目标被遮挡/`pointer-events:none`（可 `--force` 绕过） |
| `E_INPUT_BUSY` | 同标签页已有活跃输入租约，拒绝并发原生输入 |
| `E_UNSUPPORTED_REMOTE` | 远程配对浏览器不支持文件传输（daemon 与浏览器不同机） |
| `E_RESULT_TOO_LARGE` | `operation.await` 结果超过 4MiB；`data.bytes/limit` 给出实际值 |
| `E_QUEUE_FULL` | 会话命令队列达到 64 条，需稍后重试 |
| `E_SESSION_STOPPED` | 会话已停止，排队中的新命令被拒绝 |
| `E_CANCELLED` | 命令被 `command.cancel` 协作式取消 |
| `E_RATE_LIMITED` | 远程 hello 失败次数过多，暂时拒绝连接 |
| `E_SESSION_BUSY` | 会话已在启动/运行中，拒绝重复 start |

## 22. 验收（v0.2 E2E 追加项）

`tools/e2e.mjs` 在 v0.1 的 12 步之外必须再覆盖（夹具页会扩充对应控件）：

1. `read` 读回 fill 过的输入框值与 select 选中项。
2. `extract` 把夹具页表格导出为 JSON，列名/行数正确；`extract --format csv --out` 文件含表头。
3. `drag`（滑块/拖拽区）与 `wheel`（长页面滚动后 `scrollY` 变化）、`blur` 生效。
4. `upload` 把临时文件塞进 `input[type=file]`，页面读到 `files[0].name`。
5. `dialog arm --confirm dismiss` 后点击会弹 `confirm` 的按钮，命令不卡死且被 dismiss。
6. `network start/list/detail` 能抓到夹具页的 `/api/ping` 请求。
7. `emulate --width 800 --height 600` 后 `evaluate window.innerWidth` 为 800；`--reset` 恢复。
8. `tab borrow` 用户标签页（E2E 里设置 `borrowConfirm=false`）→ 单击 → `session stop` 后标签页仍在原窗口。
9. `plan` 一次下发 fill+click，两步结果都成功。
10. `observe --save-full` + `view --grep` 能命中内容；`view` 不触发新的页面采集。
11. `request-help` 在 `allowHelp=false` 时回 `E_HELP_DISABLED`。
12. 扩展弹窗页面（`chrome-extension://<id>/ui/popup.html`）能打开且拿到 `bb.popup.state`（E2E 用 evaluate 断言，
    不依赖人工点击）。


## 23. 实现补充（v0.2 落地记录）

1. **版本**：daemon / CLI / 扩展统一 `0.3.1`；`daemon.json`、`/health`、`/rpc status` 均报 0.3.1。
2. **settings 的路由**：`settings.get` / `settings.set` 是扩展方法，daemon 在本地方法表里同名转发
   （`dispatch` 里调 `routeExtension`），因此 CLI 不需要 session 也能读写。
3. **`ui.open`（扩展方法）**：`{ page?: "popup"|"options" }` → 在浏览器里打开扩展自己的页面，
   返回 `{ tabId, windowId, page, url }`；对应 CLI `bridge ui [--page popup|options]`。
4. **`diagnostics.ui`（扩展方法）**：返回 `{ ok, popup, options, icons, packageVersion }`，
   `doctor` 用它验证弹窗/设置页/图标确实打进扩展包（浏览器未连接时该项为 warn）。
5. **`debugger.detach`（内部方法）**：`session.stop` 时 daemon 自动调用，释放该 tab 的对话框/网络/仿真
   debugger 与会话态采集器；扩展内部对 debugger 做引用计数（acquire/release），全部释放才真正 detach。
6. **手动长截图的真实形态**：扩展方法 `screenshot.manual.start|frame|save`，帧按 tabId 存在扩展内存，
   `save` 返回 `{ ok, dataUrl, frames, width, height }`。CLI 的 `--mode manual` 只调一次 `frame`，
   `--stitch` 调 `save` 后由 CLI 落盘。§17 里 `--stitch <session>` 的写法作废。
7. **`network.start`** 返回 `{ captureId, bodies, mode: "debugger" }`：
   统一挂 debugger 的 `Network` 域；`bodies` 只控制是否读取响应正文
   （有提示条，正文上限 1MB，超出标 `truncated`）。
8. **`network.replay`** 在页面主世界用 `fetch(credentials:"include")` 重放（页面侧方法 `fetch-run`），
   返回 `{ status, statusText, headers, body, durationMs, url }`。
9. **`session.start` 新增 `params.tab`**：把会话绑定到已有标签页，内部先调 `tab.borrow`
   （受 `borrowConfirm` 设置约束），session 带 `borrowed: true`；`session.stop` 只 `tab.return`、不关闭标签页。
10. **`tab.borrow` 的 `confirm` 参数不再有效**：是否弹确认条只由扩展设置 `borrowConfirm` 决定，调用方不能绕过。
11. **`request-help`** 由扩展内的“协助条”闭环，daemon 不需要事件回传；`allowHelp:false` 时直接 `E_HELP_DISABLED`；
    超时返回 `action:"timeout"`（不算错误）。
12. **`plan` / `step` 不参与同 tab 串行链**（否则内部再串行会自锁到超时），但它们的每个步骤仍按 tab 串行；
    `plan` 的 `tabId` 由 daemon 注入，步骤可各自覆盖。
13. **`ui.open` / `diagnostics.ui` 属于实例方法**：多浏览器时按 `--browser` 或默认实例选择。
14. **审计默认开启**：`BB_HOME/audit/YYYY-MM-DD.jsonl`，`BB_AUDIT=0` 关闭；只记元数据。
15. **`bridge extract --format csv --out`** 在 `--json` 下也会落盘，stdout 给
    `{ ok:true, result:{ path, rowCount, truncated } }`。
16. **`screenshot`/`manual.save` 的大结果**：`dataUrl` 可能有数 MB；CLI 在 `--json` 下自行落盘，只输出
    `{ path, width, height, bytes, frames? }`。
17. **扩展错误码白名单**：`bridgeError` 只保留已知码，未知码降级 `E_INTERNAL`；§21 的 v0.2 新码已加入白名单。
18. **emulate 重置的兜底**：Edge 上 `Emulation.clearDeviceMetricsOverride` 可能返回成功但渲染进程仍卡在
    仿真尺寸；`emulate --reset` 会记录仿真前的真实视口，清不掉时用该尺寸再覆盖一次（返回值里带 `restoredTo`）。
19. **验收现状**：`tests/cli/selftest.mjs` 117 项、`tests/plugin/selftest.mjs` 20 项、`tools/plugin-profile-check.mjs` 7 项、`tests/ws-selftest.mjs` 7 项、
    `tools/e2e.mjs` 125 项（含扩展弹窗/快捷功能/视频录制/对话框 pending/共享控制）全绿。


## 24. DSH 插件（`dsh-plugin/`）

插件不是新的线上协议，只是 CLI 的另一个消费者：

* 每个 `browser_*` 工具 = 一次 `bridge <命令> --json`；退出码 0 取 `result`，否则把 `error.code/message`
  原样抛给模型（`E_STALE_REF`、`E_BORROW_DENIED`、`E_HELP_DISABLED`…）。
* 会话、标签页借用、设置约束、审计全部走 daemon，插件不加旁路：模型与用户命令行看到的状态一致。
* 插件只用 `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`；
  `apply()` 在找不到 CLI 时只告警、不抛错，避免拖垮整个 profile。
* 工具清单、安装方式（`link:` / `file:`）、配置项与验证步骤见 `dsh-plugin/README.md`。


## 25. 扩展界面（v0.3，弹窗与快捷功能）

界面全部是扩展自己的页面（`extension/ui/`），不参与线上协议；它们通过 `chrome.runtime` 消息调用
service worker，SW 再走既有命令/WS 通道。

### 25.1 页面与入口

| 页面 | 文件 | 对应截图功能 |
| --- | --- | --- |
| 弹窗 | `ui/popup.html` | 连接开关、当前浏览器（改名/复制指令）、连接设置·本机（折叠）、控制提示、自动化设置、页脚 CLI/Ext 版本 + 实例 ID |
| 快捷功能 | `ui/quick.html` | 五个入口：视频录制 / 网站调试 / 长截图 / 操作录制 / 操作审计 |
| 视频录制 | `ui/record.html` | 选标签页 → 录制 → 预览/下载/删除（MP4 优先，退回 WebM） |
| 网站调试 | `ui/debug.html` | 请求、控制台/异常、页面上下文；停止后进历史（保留 10 条） |
| 长截图 | `ui/longshot.html` | 自动滚动 / 手动拼接，预览后保存 |
| 操作录制 | `ui/ops.html` | 录制用户点击/输入/选择/导航，导出 JSON 供 Agent 参考 |
| 操作审计 | `ui/audit.html` | 审计说明 + 最近记录（经 daemon 只读通道） |

`ui.open` 扩展到全部页面：`{ page, query?, active? }`；CLI 对应
`bridge ui --page popup|options|quick|record|debug|longshot|ops|audit [--query k=v]`。

### 25.2 新增设置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `connectionEnabled` | true | 弹窗「已连接」开关；关掉后扩展断开 WS 且不再自动重连（设置持久化） |
| `controlHint` | true | 会话期间在受控标签页右下角显示「BridgeDeck正在控制此标签页」提示条；导航后自动补挂 |

### 25.3 扩展 → daemon 只读调用通道

SW 在扩展 WebSocket 上发 `{ type:"call", id, method, params }`，daemon 只接受白名单
`audit.list / status / session.list / browsers`，回 `{ type:"call-res", id, ok, result|error }`。
用于弹窗与审计页读取 daemon 状态，不需要 token，也不暴露写操作。

### 25.4 视频录制（真 MP4）

`chrome.tabCapture.getMediaStreamId({targetTabId})` → 扩展 offscreen 文档里
`getUserMedia({video:{mandatory:{chromeMediaSource:"tab", chromeMediaSourceId}}})` →
`MediaRecorder`，优先 `video/mp4;codecs=avc1.42E01E`（Edge 157 实测支持），不支持时退回 WebM。
文件以 Blob 存进扩展 IndexedDB `bb-videos`（页面直接读写，不经过消息通道），预览/下载/删除都在本地。

**兜底**：`tabCapture.getMediaStreamId` 需要扩展在该标签页上被用户调用过（activeTab）。拿不到时自动退回
`chrome.debugger` 的 `Page.startScreencast` 截帧（JPEG 帧 → offscreen canvas → MediaRecorder），
同样产出 MP4/WebM；代价是掉帧与更高的 CPU，且会出现调试提示条。状态里用 `mode: tabCapture|debugger` 区分。

### 25.5 操作录制与网站调试

* `ops`：`chrome.scripting.executeScript` 注入自包含记录器，采集 click/input/change（密码框值为
  `********`）+ tabs.onUpdated 导航事件；停止时写入 `chrome.storage.local` 的 `bb.ops.recordings`（最多 20 条）。
* `debug`：复用 `network`（debugger Network 元数据）+ 主世界 console/异常缓冲 + `page-metrics` 上下文；
  停止时写入 `bb.debug.history`（最多 10 条），导出 JSON。

### 25.6 页面自测钩子

每个子页面支持 `?selftest=1`：在真实浏览器里跑一遍对应流程，把结果写进 `document.title`
（`SELFTEST:ok:<page>:<detail>` / `SELFTEST:fail:<reason>`）。`tools/e2e.mjs` 用 tab 标题断言，
不需要往扩展页面注入脚本（chrome-extension:// 页面本身不允许被 `chrome.scripting` 注入）。


## 26. 语义对齐（v0.1 波次 1）

行为约定，CLI/扩展同步修改：

1. **wait-for-element 超时不报错**：返回
   `{ satisfied, timedOut, state, selector|ref, attached, visible, elapsedMs }`，退出码 0；
   非法 state/参数仍是业务错误。支持 `--ref`；`--timeout` 接受 `400ms / 20s / 2m`。
2. **fill**：`--no-clear` 在现有值后追加；日期类输入（date/time/datetime-local/month/week）不支持
   `--no-clear`，非法值返回 `E_BAD_ARG`（不再静默清空）。
3. **drag**：`--to` 与 `--dx/--dy` 二选一；`--hold`、`--duration`、`--from-offset-x/y`、
   `--to-offset-x/y`；无目标时按位移计算落点；`--mode click-move-click` 保持。
   `--modifiers ctrl+shift` 同时传给 PointerEvent/MouseEvent/DragEvent；可信路径传 CDP
   `Input.dispatchMouseEvent.modifiers`（alt=1、ctrl=2、meta=4、shift=8）。
4. **download 默认拒绝覆盖**：`--out` 已存在且没有 `--overwrite` → `E_EXISTS`（退出码 1）。
   下载检测改为“点击后新出现的下载”（记录基线，兼容 tabId 为 -1 的浏览器）。
5. **screenshot 走 CDP 优先**：`Page.captureScreenshot` 不受窗口焦点影响（后台标签页也能拍），
   支持可视区 / 整页（`captureBeyondViewport` + `clip`）/ 元素（`--ref`/`--selector`，`clip` 为元素盒）；
   CDP 失败才回退 `captureVisibleTab` + 拼接。返回里带 `via: "cdp"` 或回退标记。
6. **read --fields-json**：`[{"key","read","attribute"}]`，read 支持 `text|value|attribute|checked`，
   返回 `{ fields: [ { key: value } ] }`。
7. **extract 子命令**：`extract discover` 返回页面内候选表格/列表（id/kind/label/rows/columns），
   `extract table --target <id>` 按 discover 的 id 导出；旧的 `extract --selector` 仍可用。
8. **--timeout 统一支持时长单位**（`500ms/20s/2m`），适用于所有 RPC 与等待类命令。


## 27. 对话框 pending 与 operation（v0.1 波次 2）

「动作被原生弹窗挡住」模型：

1. **会话自动挂载对话框拦截**：`session.start` 成功后 daemon 对任务标签页执行
   `dialog.arm { policy: { queue: true } }`（挂载期间浏览器显示调试提示条）；`session.stop` 时
   `dialog.disarm` 并自动拒绝仍挂起的对话框。挂载失败只记日志，不影响会话。
2. **动作遇到弹窗 → `E_DIALOG_PENDING`（CLI 退出码 6）**：错误体带
   `data: { dialog: { id, type, message, defaultPrompt }, operationId, dispatched: true, method }`。
   动作已经执行、只是被弹窗挂起，**绝不重放**。
3. **挂起期间的新页面动作不派发**：返回 `E_DIALOG_PENDING` 且 `data.dispatched: false`。
4. **决策命令**：`dialog status`、`dialog accept <id> [--text <t>]`、`dialog dismiss <id>`
   （`--text` 只对 prompt 有意义；空串表示提交空输入）。60s 未决策自动 dismiss。
5. **取回结果**：`operation await <id> [--timeout 60s]` →
   `{ state: "completed" | "failed" | "running" | "cancelled" | "unknown", result?, error? }`；
   已完成的 operation 保留 5 分钟、最多 64 个；`operation.await` 结果超过 4MiB 返回
   `E_RESULT_TOO_LARGE`（daemon 侧 `lib/limits.mjs` 统一检查，`data.bytes/limit` 给出实际值）。
   `operation cancel <id>` 标记取消，等待方立即返回 `cancelled`。
6. **实现位置**：扩展 SW 的 `operation` 注册表 + 动作/弹窗事件竞速；daemon 只做方法路由；
   CLI 把 `E_DIALOG_PENDING` 映射为退出码 6 并打印 dialog id / operation id / 下一步命令。


## 28. 共享控制（cooperate，v0.1 波次 3）

context/observation 授权模型（简化实现，保持向后兼容）：

1. **`cooperate sync`**：观测当前页面并签发一对收据
   `{ control_policy, context_id, observation_id, generation, url, title, observation: { observation_id, text, refs } }`。
   会话首次 sync 选择策略（默认 `target`，`--policy strict` 可选），之后固定。
2. **`--context <id>`**（页面动作）：提供时必须等于当前 context，否则 `E_CONTEXT_STALE`；
   strict 策略下同一 context 只能用一次。未提供时保持旧行为（不强制），便于既有脚本迁移。
3. **`--observation <id>`**（无 DOM 目标的动作，如 evaluate / 无目标 press/wheel）：
   提供时必须等于当前 observation，否则 `E_OBSERVATION_STALE`。
4. **`--expect '<json array>'`**（页面动作）：动作执行前按字面值校验
   `[{ target, field: text|value|checked|attribute|exists, attribute?, equals }]`，
   不满足则 `E_EXPECT_FAILED`，message 带目标、字段、期望值与实际值。不做脚本求值/正则/归一化。
5. **失效**：标签页导航或文档替换时 context/observation 立即吊销（`tabs.onUpdated` 的 loading/url 变化），
   `generation` 递增；需要重新 `cooperate sync`。
6. **`cooperate wait`**：返回 `{ state: { mode }, ready, control_policy, context_id, observation_id }`；
   当前实现为简化版（总是 ready），人工接管检测在后续波次补。
7. **plan / step**：把顶层 `context/expect/observation` 透传给每个步骤（步骤自带则优先）。
   plan/step 本身不参与同 tab 串行链。
8. **节点级校验**：`cooperate sync` 额外记录 `node_scope`（ref 表节点签名摘要）；动作/读取带
   `nodeScope: true`（CLI `--node-scope`）+ `--observation` 时只校验目标节点，
   见 §12.2.2（`E_TARGET_DETACHED` / 节点级 `E_OBSERVATION_CHANGED`）。


## 29. 调试命令（v0.1 波次 4）

debug 采集与读取面（规则/operations 尚未实现）：

| 命令 | 行为 |
| --- | --- |
| `debug start [--name <t>] [--bodies]` | 开始采集当前会话页；`--bodies` 挂 debugger 取请求/响应正文（上限 1MB） |
| `debug stop` | 停止采集，写入扩展历史（最多 10 条，带 name），返回请求/控制台条数 |
| `debug status` | 采集中显示计数；否则列出最近历史 |
| `debug requests [--filter <子串>] [--method M]` | 请求列表（id/method/status/ms/type/url） |
| `debug request <id> [--part headers\|timing\|request\|response\|all]` | 单条详情；headers 来自 debugger Network，正文需 `--bodies` |
| `debug console` | 控制台/未捕获异常（最近 100 条） |
| `debug pages` | 页面上下文（url/title/视口/滚动尺寸/dpr） |
| `debug performance` | TTFF/DOMContentLoaded/load、paint（FCP）、LCP、资源数量与传输字节 |
| `debug aggregate [--filter <子串>] [--slow-ms N]` | 按 method+path 聚合：次数/均值/最大/慢请求数/状态分布 |
| `debug export --output <file>` | 把当前采集导出为 JSON |
| `debug replay <id>` | 页面上下文同源重放（fetch，带 cookie），会真实修改服务端数据 |
| `debug history` | 列出扩展里的历史采集 |

限制（后续波次补）：没有 operations 时间线、`debug wait`、请求规则/拦截/模拟响应（`rule_add`）、
重复请求检测（`duplicates`）、CLS/长任务等更深的性能项。


## 30. 媒体命令（v0.1 波次 5）

### 视频录制（`bridge video`）

| 命令 | 行为 |
| --- | --- |
| `video start [--duration 60s] [--quality standard\|high]` | 开始录制当前会话页；返回 `recordingId`、mime、mode；`--duration` 到期由 offscreen 自动停止 |
| `video status <id>` | 录制中返回 `recording`；已过时长会先自动收尾；否则从库里找 `ready` 并返回 bytes/mime |
| `video stop <id>` | 停止并等待文件落库（最多 15s），返回 bytes/mime/时长 |
| `video save <id> --out <path> [--overwrite]` | 把扩展 IndexedDB 里的录制传到 CLI 机器落盘；默认拒绝覆盖 |
| `video list` | 列出录制（id/类型/大小/时间/标题） |
| `video discard <id>` | 删除录制 |

实现：优先 `tabCapture.getMediaStreamId` + offscreen `MediaRecorder`（MP4/H.264 优先，退回 WebM）；
拿不到 activeTab 时退回 `chrome.debugger` 的 `Page.startScreencast` 截帧。文件以 Blob 存在扩展
IndexedDB `bb-videos`；`recordingId` 由 SW 生成并贯穿 offscreen/SW，停止回包按 id 对齐。
上限：单次 10 分钟、256MiB。尚未实现：24h 过期清理、扩展库分页。

### 操作录制（`bridge record`）

| 命令 | 行为 |
| --- | --- |
| `record start` | 注入记录器，采集人工 click/input/change/导航/文本 diff/媒体进度/hover 停留；默认过滤 Agent 动作，`--include-agent` 可包含 |
| `record stop` | 停止并落库（最多 20 条历史），返回事件条数 |
| `record status` | 进行中的录制与事件数 |
| `record list` | 历史记录（id/事件数/时间/标题） |

与扩展「操作录制」页共用同一套 `ops` 模块与存储。


## 31. 观测分页与呈现折叠（v0.1 波次 6）

1. **`observe --max-tokens N`**：按 ≈4 字符/token 估算，单页 200–20000 字符，按行边界截断。
   返回 `{ observation, refs, url, title, offset, totalChars, truncated, cursor }`；CLI 人类输出在末尾打印
   `@more <cursor>`。
2. **`observe --cursor <token>`**：从上次缓存续读；cursor 绑定 tabId 与缓存时间戳，
   页面重新 observe 或换标签页后返回 `E_CURSOR_STALE`。完整观察缓存在扩展侧（每个 tab 最近一次）。
3. **`view <file> [--find <t>] [--start-line N] [--line-count N]`**：本地文件检索/分段（带行号，
   `--find` 命中行上下各 2 行），不需要 daemon；不带文件参数时仍是原来的 session 观察缓存视图。
4. **`cooperate sync --match-text <t> --context-lines N`**：只保留命中行及其上下 N 行，
   中间折叠为 `… (N lines omitted)`，其余字段（refs/context_id 等）不变。
5. **VOM 标记补充**：`[has-submenu]`（aria-haspopup）、`[expanded]`（aria-expanded=true）、
   `[draggable]`、`[drop-target]`（data-drop-target / class 含 drop-target|dropzone）、
   `[selected:class]`（option/tab/listitem/treeitem 的 class 含 selected|is-selected|active）、
   `[selected:data]`（data-selected=true）。iframe 仍只输出占位，shadow DOM 不展开。


## 32. iframe 与 Shadow DOM（v0.1 波次 7）

1. **open shadow root**：观察会遍历 `el.shadowRoot` 的子节点；影子树里的元素照常分配 `@eN`，
   动作（click/fill/…）用 ref 即可命中。**CSS selector 仍只在主文档查找**，不会穿透 shadow 边界
   （refs 优先、selector 搜主文档）。
2. **同源 iframe**：`walk` 会通过 `iframe.contentDocument` 继续遍历内部文档，内部元素同样获得 ref；
   跨源 iframe 受同源策略限制，仍只输出 `iframe` 占位（后续波次用 CDP 跨帧补）。
3. **可见性**：`isVisible` 使用元素所属文档的 window 计算样式，因此 iframe/shadow 内的元素判断正确。
4. 限制：closed shadow root 不可达；跨源 iframe 只能看到占位；`get-html`/`extract` 仍是主文档。


## 33. 截图标注与视觉坐标点击（v0.1 波次 8）

1. **`screenshot --annotate`**（仅可视区截图）：在 PNG 上为每个有 ref 的主文档元素画方框与 `@eN` 标签，
   并在结果里返回：
   `{ capture_id, visual_refs: [{ ref, role, name, image_x, image_y, x, y, width, height }] }`
   （`image_*` 是图片像素坐标，其余是图片内的左上角/尺寸）。
2. **capture 生命周期**：capture 绑定 tabId，保留 10 分钟、最多 20 个；过期或不存在返回 `E_CAPTURE_STALE`。
3. **`click --capture <id> --image-x X --image-y Y`**：按
   `pageX = scrollX + X / scale`、`pageY = scrollY + Y / scale` 换算成页面坐标，
   优先用 CDP `Input.dispatchMouseEvent`（可信手势），失败退回页面内 `click-point`；
   返回 `{ x, y, via: cdp|page }`。
4. 限制：整页/元素截图不做标注；视觉引用只含主文档元素（同源 iframe/shadow 内的元素暂不参与换算）。


## 34. 上传：文件选择器拦截（v0.1 波次 9）

1. **目标就是 `input[type=file]`**：直接把 CLI 读到的文件内容（base64）塞进 input 的 `files`，
   派发 `input`/`change`（原有行为，不需要 debugger）。
2. **目标是按钮/标签**（页面自己弹选择器）：
   - 挂 debugger，`Page.setInterceptFileChooserDialog({enabled:true})`
   - 先 `scroll-to` 把目标滚进视口，再用 CDP `Input.dispatchMouseEvent` 可信点击
   - 等 `Page.fileChooserOpened`（最多 5s），拿到 `backendNodeId` 后
     `DOM.setFileInputFiles({ files: [绝对路径], backendNodeId })` —— 依赖 CLI 与浏览器同机
   - 结束后关闭拦截并释放 debugger
3. **兜底**：如果选择器没有出现（某些站点用程序化 click），退回给页面里第一个 `input[type=file]` 赋值，
   返回 `via: 'hidden-input'`；完全没有文件输入才报 `E_NO_FILE_CHOOSER`。
4. CLI `upload` 同时发送 `files`（base64，供直接赋值）与 `paths`（绝对路径，供选择器拦截）。


## 35. 共享控制语义补全（v0.1 波次 10）

1. **`--settle <duration>`**（页面动作）：动作成功后等待 `min(ms, 5000)`，
   结果对象附带 `settledMs`；用于等动画/网络余波，不做“网络空闲”判定。
2. **`--depends-on '<json array>'`**：条件格式与 `--expect` 相同（`target/field/attribute/equals`），
   在动作前校验；不满足返回 `E_DEPENDS_FAILED`，`data = { mismatch, conditions, kind: 'depends-on' }`。
3. **`--expect` 结构化错误**：失败时 `data = { mismatch, conditions, kind: 'expect' }`，
   mismatch 含 `{ target, field, expected, actual, reason }`。
4. **人工接管检测**：页面在 capture 阶段记录 **可信** `pointerdown/keydown/input/wheel`
   时间戳（`isTrusted=false` 的合成事件忽略，避免 agent 自己的事件触发）；
   1.5s 内有人操作视为接管进行中。
5. **`cooperate wait [--timeout 5s]`**：轮询该状态，人工停手后返回
   `{ state: { mode: 'ready' }, ready: true, waitedMs }`；超时仍有人操作返回
   `{ state: { mode: 'human' }, ready: false, waitedMs }`。超时上限 30s。


## 36. 调试规则与重复请求（v0.1 波次 11）

### 规则（页面内 fetch/XHR 拦截）

```sh
bridge debug rule_add --rule '{"urlPattern":"*/api/ping*","action":"fulfill","status":200,"headers":{"content-type":"application/json"},"body":"{\"ok\":false}"}'
bridge debug rule_add --rule-file rule.json
bridge debug rule_list
bridge debug rule_clear
```

- `urlPattern` 支持 `*` 通配（页面内转成正则，忽略大小写）；`action` 为 `fulfill|block|modify`。
- 实现方式：`chrome.scripting.executeScript` 在 **MAIN world** 包裹 `window.fetch` 与 `XMLHttpRequest`，
  规则存在扩展内存、导航完成后自动重新注入（`tabs.onUpdated complete`）。
- `fulfill`：直接返回构造的 `Response`（XHR 则伪造 readyState/status/responseText）；
  `block`：fetch 抛 `TypeError: Failed to fetch`，XHR 触发 `error`；
  `modify`：改写 url/method/headers 后走原始请求。
- 限制：只覆盖页面里的 fetch/XHR（不拦图片/脚本等子资源，也不影响 Service Worker/预加载请求）；
  命中计数在页面侧，`rule_list` 的 `hits` 目前不回收。
- 同一 tab 规则按添加顺序取第一条命中；`rule_clear` 清空并卸载拦截器。

### 重复请求

`bridge debug duplicates [--window-ms 1000] [--filter <子串>]`：按 `method + origin+path` 分组，
把时间相邻且间隔 ≤ 窗口的请求聚成簇，输出 `count/span/first`；`--json` 返回 `{windowMs, groups}`。


## 37. 收尾细节（v0.1 波次 12）

1. **视频过期**：录制保留 24 小时（`chrome.storage.local['bb.video.ttlMs']` 可覆盖，测试用）。
   `video list/status/fetch` 前自动清理；`video prune [--ttl 24h]` 显式清理并返回 `{removed, remaining}`。
2. **审计分页**：`audit list [--since 24h] [--limit 50] [--offset 0]`，
   `--json` 返回 `{total, offset, limit, entries}`；CLI 文本输出显示 offset 与总数。
3. **截图范围**：`screenshot --scope viewport|document`。`viewport` 强制只截可视区
   （即使带 `--mode auto`）；默认 `document` 行为不变（整页）。
4. **截帧录制收尾**：`Page.startScreencast` 在自动停止/手动停止后都会显式 `stopScreencast`，
   下一次录制开始前也会清理残留，避免 `Screencast is already active`。


## 38. MCP 接入（v0.1 波次 13）

`mcp/server.mjs` 是一个 stdio MCP server（newline-delimited JSON-RPC 2.0），把桥的能力暴露给任意 MCP 客户端：

```sh
node mcp/server.mjs          # 读取 BB_HOME / BB_PORT，与 CLI 共用 daemon.json 的 token
```

协议面：`initialize`（protocolVersion 2024-11-05，capabilities.tools）、`tools/list`、`tools/call`、
`ping`、`shutdown`；未知方法返回 `-32601`。

工具（13 个）：`browser_status`、`browser_observe`、`browser_navigate`、`browser_click`、
`browser_fill`、`browser_read`、`browser_extract`、`browser_evaluate`、`browser_screenshot`、
`browser_tabs`、`browser_wait_for`、`browser_cooperate_sync`、`browser_dialog`。

- 每个工具都接受可选 `session`；不给时首次调用自动 `session.start`，进程 stdin 关闭时停止。
- 工具参数遵循各自的 `inputSchema`（JSON Schema）；截图工具会把 PNG 落到 `out` 路径并返回宽高/字节数。
- 错误以 `{isError: true, content:[{type:'text', text:'CODE: message'}]}` 返回，不中断会话。
- 限制：只实现 tools（没有 resources/prompts），stdio 传输（未做 HTTP/SSE）。


## 39. 可恢复会话与 incognito（v0.1 波次 14）

1. **会话持久化**：daemon 把会话写入 `$BB_HOME/sessions.json`（临时文件 + rename，避免半截写入），
   启动时恢复；`session.list` 增加 `connected`（所属浏览器是否在线）、`restored`、`incognito` 字段。
   daemon 重启后，扩展以原 `instanceId` 重连即可继续用旧 `sessionId` 发命令（tabId 不变）。
2. **incognito**：`session start --incognito` → 扩展先 `chrome.extension.isAllowedIncognitoAccess()`；
   未获准时返回 `E_INCOGNITO_UNAVAILABLE`，提示在扩展详情里打开「允许在 InPrivate 模式中运行」；
   获准则创建 incognito 窗口并沿用常规会话流程。
3. 限制：会话恢复依赖浏览器里那个 tab 仍然存在；若 tab 已关闭，恢复的会话会在下一次命令时报
   `E_NO_TAB`/`E_NO_BROWSER`，需要重新 `session start`。


## 40. 操作时间线（v0.1 波次 15）

daemon 给每条 RPC 审计记录加稳定 `id`（`<ts36>-<seq>`），并暴露只读查询：

```sh
bridge debug operations [--limit 20] [--since 1h]
bridge debug operation <id>
```

- 记录字段：`id/ts/method/ok/durationMs/sessionId/tabId/url/code`；
- `debug operations` 与 `audit list` 共用同一份 `$BB_HOME/audit/*.jsonl`，按时间倒序；
- `debug operation <id>` 精确取单条，便于把失败命令与耗时对上；
- `download --json` 额外返回 `browserPath`（浏览器实际落盘路径），与 CLI 的 `path`（复制目标）区分。
- 限制：这是**命令级**时间线，暂未把网络请求按时间窗关联进来。


## 41. 远程配对（v0.1 波次 16）

1. **绑定地址**：daemon 默认只监听 `127.0.0.1`；设置 `BB_BIND=0.0.0.0`（或具体网卡地址）后开放局域网 WS。
2. **配对码**：
   ```sh
   bridge pair create [--ttl 10m] [--label 名称] [--host ip]
   bridge pair list
   bridge pair redeem <code>   # 换回 ws 地址 + token
   bridge pair revoke <code>
   ```
   配对码 6 位（去掉易混字符），token 32 hex；TTL 1 分钟–24 小时，默认 10 分钟；过期自动清理。
3. **远程鉴权**：来自非回环地址的 WS `hello` 必须带 `pairToken`，否则 daemon 回
   `{ type: 'hello-error', code: 'E_PAIR_REQUIRED' }` 并以 4003 关闭；回环连接视为本机可信。
4. **激活即作废旧链接**：配对码/token 只用于**首次激活**。首次握手成功后 daemon 立即作废该配对码，
   并为设备换发独立 `deviceToken`（通过 `hello-ack.deviceToken` 下发）；扩展把它持久化到
   `daemonToken`，之后重连用新 token。旧链接（含旧 token）不再能证明已配对身份（本机模式下会降级为
   `unpaired`，远程模式直接 `E_PAIR_REQUIRED`）。再次 `pair redeem` 旧码返回 `E_PAIR_INVALID`。
5. **扩展远程地址**：设置 `daemonUrl`（ws://host:port[/ws]）与 `daemonToken` 后，
   ws-client 优先连该地址、hello 带 `pairToken`；远程模式断线不轮询本地端口，3s 后重连同一目标。
   设置变化（`bridge settings set --daemon-url ...`）会立即触发重连。
6. **撤销即时生效**：`pair revoke` 会断开使用该 token 的已连接实例（返回 `kicked` 计数），
   并删除 `devices.json` 里的设备记录（`bridge pair list` 的 `knownDevices` 可看到）。
7. **模式与提示**：默认可选配对；`bridge daemon trust-local off` 切到必需模式（未配对本机连接被拒绝）。
   `bridge doctor` 会输出当前配对模式、已知设备/待配对码、未配对连接数，以及 `bridge daemon pair` 建议；
   另外输出 `log`（日志路径/大小）、`disk`（BB_HOME 可用空间）、`port`（daemon.json 与 /health 端口一致性）。
8. **browser_id 绑定 + 分阶段 commit**：激活时把设备 token 绑定到 hello 的 `browserId`；换浏览器复用
   同一 token 会返回 `E_PAIR_REJECTED`（远程/本机一致）。设备先 pending，扩展 `auth-commit` 后才 active；
   断线未 commit 可重连恢复（同一 commitTxn），10 分钟未确认则 token 作废。
9. **分阶段 rotation（pair renew / daemon rotate）**：`bridge pair renew <deviceId>`（远程设备）与
   `bridge daemon rotate`（本机 token）都只生成 pending rotation token/txn（`{token, txn, pending:true}`），
   旧 token 在 commit 前仍有效；扩展用新链接/新 token 连接后 daemon 下发 `commitTxn`，扩展 `auth-commit`
   成功后新 token 才替换旧 token（旧 token 立即失效）。10 分钟未 commit 则 rotation 过期，旧 token 继续有效。
10. 限制：目前是 `ws://`（无 TLS），配对 token 是唯一凭据；弹窗「远程配对」可填地址/token 并重连。

## 42. operations 与请求关联（v0.1 波次 18）

- `debug operations` 在有调试采集时，为每条命令标注时间窗内的请求数 `requests`
  （窗口 = `[ts - durationMs - 50, ts + 50]`）。
- `debug operation <id> --with-requests`：返回该命令及其时间窗内的请求列表（id/method/status/ms/url），
  `--json` 时为 `result.requests`。
- 没有采集时 `requests` 恒为 0，CLI 会提示先 `debug start`。
- 限制：按时间窗关联，不是精确的 commandId → 请求映射；并发命令可能互相包含对方的请求。


## 43. TLS / WSS（v0.1 波次 19）

1. **开启**：`BB_TLS=1` 启动 daemon。首次启动会在 `$BB_HOME/tls/cert.pfx` 生成自签证书
   （CN=localhost，SAN 含 127.0.0.1；Windows 用 PowerShell/.NET 生成，PFX 口令固定为 `browser-bridge`）。
2. **传输**：HTTP 变 HTTPS，`/health` 与 `/rpc` 同端口；daemon.json 带 `"tls": true`，
   CLI 读到后自动改用 https（本地自签证书不校验链）。
3. **WS**：扩展/客户端连接 `wss://host:port/ws`；`pair create` 返回的地址自动变成 `wss://`。
4. **浏览器信任**：自签证书默认不被 Edge/Chrome 信任。要么把 `cert.pfx` 导入系统「受信任的根证书」，
   要么在 daemon 前放一层带正式证书的反向代理（Nginx/Caddy），扩展连代理的 wss 地址。
5. 自测：`node tests/tls/selftest.mjs`（https 健康检查、CLI over https、wss 无 token 拒绝/带 token 握手、stop）。


## 44. 子资源拦截（DNR，v0.1 波次 21）

- 页面内 fetch/XHR 规则保持原样（可 fulfill/block/modify）。
- 额外把 **block / redirect** 规则同步为 `declarativeNetRequest` 的 **session 规则**
  （`updateSessionRules`，条件带 `tabIds: [tabId]`），从而覆盖图片、脚本、样式等子资源。
- `redirect` 仅在 `modify` 规则给出绝对 URL 时生成；`urlFilter` 直接用规则的 `urlPattern`。
- `rule_clear` / 标签页关闭会移除对应 session 规则；`rule_list` 返回
  `dnr: { count, error }` 便于排查。
- 限制：fulfill（伪造响应）仍只对页面 fetch/XHR 生效；子资源只能 block/redirect。


## 45. 跨源 iframe（OOPIF，v0.1 波次 22）

- `observe --frames`：通过 `chrome.scripting.executeScript({allFrames:true})` 在每个 frame（含跨源 OOPIF）
  执行页面能力库的 `observe`，合并输出；每个 frame 前有 `frame <frameId> <url>` 标题。
- frame 内元素的 ref 重写为 **`@f<frameId>e<N>`**；动作（click/fill/press/select/…）识别该前缀后
  自动把执行目标切到对应 frame，并把 ref 还原成该 frame 内的 `@e<N>`。
- 仅同源 iframe 的内容也会出现在主文档语义树里（page-lib 会下钻 `contentDocument`），
  因此 `--frames` 下同源 iframe 可能重复出现：主树里是 `@eN`，frame 标题下是 `@fNeM`。
- 限制：closed shadow root 仍不可达；`--frames` 不包含受限页面（如 chrome-extension:// 子帧）。


## 46. 重绑 / 协议字段 / 滚动边界 / CLS（v0.1 波次 23）

1. **`session rebind <id> --tab <tabId> [--release-old]`**：把会话切到另一个标签页。
   daemon 会先 `tab.borrow` 新 tab，卸载旧 tab 的对话框拦截/控制提示/debugger，
   `--release-old` 且旧 tab 是借用时归还给用户；随后在新 tab 重新挂拦截与提示，并持久化会话。
2. **协议字段**：扩展 hello 带 `protocol: 1` 与 `capabilities`；daemon 的 hello-ack、/health、status
   都返回 `protocol` 与能力列表，`browsers` 里每个实例带 `protocol/capabilities`。
   目前只做“通告与展示”，不做强制兼容性校验。
3. **scroll-to 边界**：返回 `{ bounds:{x,y,width,height}, viewport:{width,height}, scroll:{x,y} }`，
   CLI 文本输出会打印元素边界与视口尺寸。
4. **性能指标**：`debug performance` 增加 `cls`（layout-shift 累计，忽略 recent input）与
   `longTasks:{count,maxMs}`（PerformanceObserver buffered）。


## 46b. 跨源 iframe 的 ref 模型

- 默认 `observe` 会包含所有可观察 frame，ref 统一为 `@eN`。
- `observe --frames` 仍返回逐 frame 结构，并附带 `aliases`（`@eN` → frameId + 局部 `@eN`）。
- `@fNeM` 仍然兼容，可直接用于 click/fill 等动作。
- **`observe --frames --vom` 的跨源子图**（2026-11-19 起）：每个 frame 额外返回 `frame.vom` 子图，
  顶层返回 `vomFrames:{count,nodes,edges,truncated}` 与 `vomLimits:{frames,nodes,edges}`：

  ```json
  { "frameId": 3, "url": "http://127.0.0.1:PORT/frame-x.html",
    "vom": { "available": true, "frameNodeId": "frame:3",
             "nodes": [{ "id": "frame:3", "tag": "iframe", "role": "frame", "frame": true }],
             "edges": [{ "type": "frame", "from": "frame:3", "to": "f3:@e1" }],
             "roots": ["frame:3"], "counts": { "nodes": 12, "edges": 14, "byType": { "child": 8, "frame": 1 } },
             "truncated": false } }
  ```

  - 节点 id 统一加 `f<frameId>:` 前缀（不同 frame 的 `@eN` 不会撞车）；`frame:<frameId>` 是子图根，
    通过 `type:"frame"` 边连到该帧的 root；主文档 `frame:0` 的 `tag` 是 `document`，其余是 `iframe`。
  - 上限：**16 帧**、每帧 400 节点 / 800 边；超限 `truncated:true`。无法注入的 frame（CDP 兜底）
    只有 `available:false` 的 frame 节点，不伪造内容。
  - **iframe 元素 → 子图根**：父文档里的 iframe 元素（按该帧 `frame-meta.children[].index` 对应）会在父图中
    补一个 `frame:<childFrameId>` 节点（`parentId` 指向 iframe 元素）并连 `type:"frame"` 边；
    **嵌套 iframe 同样适用**（每个父帧用自己的 `frame-meta` 匹配它的直接子帧）；
    `vomFrames.links = [{fromFrameId, toFrameId, ownerId}]` 给出可遍历的对应关系，
    `vomFrames.unlinked` 是匹配不到元素的可观察子帧数（URL 被重定向/隐藏/无法注入时不硬连）。
  - 子图之间彼此独立（跨源文档没有统一 DOM）；需要跨帧操作时仍用 `@fNeM`/aliases。

## 47. 可取消等待与 recipe 审批（含内容绑定）（v0.1 波次 24）

1. **可取消等待**：`wait-for-element` 返回 `operationId`（可用 `--operation-id <id>` 预先指定），
   运行期间可通过 `operation cancel <id>` 中止；被取消时返回
   `{ satisfied:false, cancelled:true, operationId, elapsedMs }`，CLI 退出码仍为 0。
   取消命令走独立通道（不受同 tab 串行链阻塞）。
2. **recipe 审批**：`recipe save/draft` 写入 `approved:false`；`recipe run` 遇到未审批返回
   `E_RECIPE_NOT_APPROVED`；`recipe approve <name> --confirm-human [--by <x>]` 置为已审批并记录
   `approvedAt/approver`。`--confirm-human` 是面向人类操作的软门禁（CLI 层），不构成密码学保证。
3. `recipe list` 显示审批状态，`recipe show <name>` 输出完整 JSON，`recipe rm` 支持 `--json`。


## 49. 能力门禁与降级（v0.1 波次 28）

- 扩展 hello 里的 `capabilities` 会被 daemon 记录，并通过 `browsers/status` 暴露。
- 门禁：`debug.rule_add`→rules、`video.start`→video、`record.start`→recording、
  `evaluate --unverified`→unverified；缺能力返回 `E_UNSUPPORTED_CAPABILITY`。
- 降级：`observe-frames` 缺 `frames` 时自动改为 `observe`，结果带
  `downgraded:true` 和单 frame 列表，CLI 会打印“已降级为主文档观察”。
- 老客户端（未声明 capabilities）不做门禁，保持兼容。


## 50. closed shadow（CDP pierce，v0.1 波次 29）

- `click --closed-shadow-text <文本>` / `read --closed-shadow-text <文本>`：
  通过 debugger 执行 `DOM.getDocument({depth:-1, pierce:true})`，遍历 `shadowRoots`（含 closed），
  对交互元素（button/a/input/select/textarea/label/summary）用 `Runtime.callFunctionOn` 取文本与可见性，
  命中后 `this.click()` 或返回文本。
- 结果带 `matched/tag/via: 'cdp-closed-shadow'`；找不到返回 `E_NOT_FOUND`。
- `observe --closed-shadow`：把 closed 影子树里的交互元素以
  `- closed-shadow <tag> "<text>"` 追加到观察文本末尾，并在 `--json` 结果里给 `closedShadow` 数组；
  **不分配 ref**，只做只读呈现（open shadow 已在主树里，不重复）。
- 限制：closed shadow 内的元素没有 ref，只能按文本点击/读取；
  候选节点上限 300，按文档顺序取第一个命中。


## 51. 规则三层实现（v0.1 波次 33）

调试规则现在分三层落地：

1. **页面内 fetch/XHR 包裹**（MAIN world）：fulfill/block/modify，覆盖页面脚本发起的 API 调用；
   通配符改为 `split('*')` 逐段转义，绝对 URL 也能正确匹配。
2. **DNR session 规则**（`tabIds` 限定）：block / redirect，覆盖图片、脚本等子资源。
3. **CDP Fetch**（`Fetch.enable` + `Fetch.requestPaused`）：fulfill 子资源（伪造脚本/图片响应）
   与 modify 子资源（`continueRequest` 改写 url/method/headers）；只在存在 fulfill/modify 规则时启用，
   `rule_clear`/标签页关闭时关闭并释放 debugger。改写规则建议收紧 pattern（如 `*/api/x?*`），
   避免改写后的 URL 再次命中同一规则。

`rule_list` 会返回诊断：`dnr:{count,error}`、`fetch:{enabled,paused,error,urls}`。

限制：CDP Fetch 在**跨导航**后可能只覆盖文档请求，子资源 fulfill 建议在导航后重新确认规则
（页面内 fetch/XHR 规则会由 `tabs.onUpdated` 自动重新注入）。


## 52. 协议版本 1.9 与协商（v0.1 波次 36）

- `protocol` 字段为字符串 **`"1.9"`**，与协议 1.9 对齐；1.8 客户端仍可连接。
- 兼容规则：major 必须为 1；同一 major 内允许 minor 偏斜（1.7/1.8 老扩展可连接），
  `browsers`/`status` 里用 `protocolSkew: "older" | "newer" | null` 标注偏斜方向。
- 不兼容（major≠1）时返回 `E_PROTOCOL_UNSUPPORTED` 并以 4004 关闭连接；不带 protocol 的旧客户端按 **1.0** 处理。
- hello / hello-ack / status / `browsers` 均返回 `"1.9"`；能力仍由 `capabilities` 协商（见 §49）。
- 1.9 新增能力：`unverified`（`evaluate --unverified`）、`dom-read`（固定函数的有界 DOM 读取）。
  老扩展缺少这些能力时，新命令返回 `E_UNSUPPORTED_CAPABILITY`，其余功能照常。

- `recipe approve` 会把步骤哈希写入 recipe，并记录 24 小时有效期；审批后修改步骤返回 `E_RECIPE_CHANGED`，超过有效期返回 `E_RECIPE_EXPIRED`。


## 53. `observe --vom` 结构化节点（v0.1 波次 37）

`observe --vom` 在原有语义树之外返回结构化节点数组，供 Agent 直接按字段决策：

```
{ url, title, observation, refs, blocking, nodes: [Node] }
```

`Node` 字段（页面内一次遍历得出，不额外启用 CDP）：

| 字段 | 说明 |
| --- | --- |
| `ref` | `@eN`；只有可交互角色分配，其余为 `null` |
| `tag` / `id` / `role` / `name` | 标签名、元素 id、ARIA 角色、可访问名（≤80 字符） |
| `value` | 控件当前值；password/敏感 autocomplete 始终输出 `********` 或空串 |
| `checked` / `selected` / `expanded` / `disabled` / `required` / `readonly` | 布尔或 `null` |
| `focused` / `inForm` / `inViewport` | 布尔 |
| `inputType` / `inputState` | `inputState` 为 `filled`/`empty`/`checked`/`unchecked`，非控件为 `null` |
| `placeholder` / `href` / `nearbyText` | 占位符、链接绝对地址、邻近兄弟/叔伯文本（≤80 字符，用于消歧） |
| `clickable` | 可交互角色、内联 onclick 或 `cursor:pointer`，且命中测试未被遮挡 |
| `hitTest` | `self`/`descendant`/`ancestor`（可命中）、`blocked`（被遮挡）、`pointer-events-none`、`offscreen`、`empty`、`none`、`unknown` |
| `occludedBy` | `hitTest=blocked` 时的遮挡者摘要 `{tag,role,id,name}`，其余为 `null` |
| `draggable` / `dragHint` | `dragHint` 为 `draggable` / `drag-handle` / `drop-target` / `null` |
| `paintOrder` | 本次观察中的绘制顺序（0 起，越小越靠前） |
| `rect` | `{x,y,w,h}` 视口坐标（整数） |
| `pointerEvents` / `cursor` | 计算样式 |

约束：

1. 最多返回 500 个节点；超出后语义树继续输出，但不再追加节点。
2. `--vom` 不能与 `--cursor`/`--max-tokens` 组合（`--vom` 直接返回完整节点数组，不做分页）。
3. 只覆盖主文档与 open shadow / 同源 iframe（与默认观察一致）；跨源 iframe 用 `observe --frames`。
4. ref 仍遵循稳定策略：同一元素跨多次 observe 复用编号，元素脱离文档后回收；节点里的 ref 可直接用于 click/fill 等动作。
5. `hitTest` 是对元素可见区域中心点做 `elementFromPoint` 的结果；被遮挡时 `clickable=false` 且给出 `occludedBy`。它用于解释“看得到但点不到”，不改变动作命令的选中逻辑。
6. `pointer-events:none`、屏外、零尺寸元素仍会出现在节点数组里（`observe` 的可见性判定是 CSS 可见，不是视口内），并通过 `hitTest`/`inViewport` 区分。
7. **完整关系图**（2026-11-19 起）：`--vom` 额外返回 `vom.graph`（页面侧一次遍历收集的 containment/ownership 图），
   并给每个 `vom.nodes[i]` 补 `id` / `parentId` / `ancestorIds`（近 → 远）：

   ```json
   { "graph": { "available": true,
                "nodes": [{ "id": "@e5", "ref": "@e5", "tag": "button", "role": null, "domId": "submit-btn",
                            "parentId": "vom:n2", "ancestorIds": ["vom:n2", "vom:n1"], "observed": true }],
                "edges": [{ "type": "child", "from": "vom:n2", "to": "@e5" },
                          { "type": "label", "from": "vom:n4", "to": "@e5" }],
                "roots": ["vom:n1"], "counts": { "nodes": 42, "edges": 51, "byType": { "child": 40, "label": 11 } },
                "truncated": false } }
   ```

   - **id 规则**：`ref` > `stableRef` > `vom:<页面内 key>`；重名时追加 `~<key>` 保证唯一。
   - **边类型**：`child`（DOM 包含，完整到 `documentElement`）、`label`（`<label for>`）、`form`、
     `controls`/`labelledby`/`describedby`/`owns`（对应 ARIA 属性），端点全部是图内 id；未知端点直接丢弃。
   - **AX 父子边**（`observe --vom --ax`）：额外并入 `type:"ax"` 的边。AX 节点能映射到图内节点时直接复用 id，
     中间节点补 `ax:<nodeId>` 上下文节点（只含 `role`，不含 name/text）；上限 300 边 / 200 上下文节点，超限 `truncated`。
   - **上限**：页面侧最多 800 节点 / 2000 边，扩展侧再收敛到 600/1500；超限时 `truncated=true`。
   - **兼容**：`vom.nodes[i].ancestors`（旧字段）继续保留；`vom.edges` 仍是 `{type, from, to, child, parent}`
     形式（child/parent 为兼容字段）。没有页面图（AX 兜底/降级管线）时 `vom.graph=null`，行为与旧版一致。
   - 图里只放结构（tag/id/role/ref/父子关系），不放文本内容。

## 53b. `observe --facts`（DOMSnapshot 事实）

开启 `--facts` 后额外调用一次 `DOMSnapshot.captureSnapshot`（计算样式 + 几何 + isClickable），
按 `backendNodeId` 映射到 `nodes` / `axNodes`，为命中的节点附加：

| 字段 | 说明 |
| --- | --- |
| `bounds` | `{x,y,width,height}`，DOMSnapshot 子像素几何；可能与本节的整数 `rect` 有亚像素差异 |
| `visible` | `display!=none && visibility!=hidden/collapse && opacity!=0 && 有面积` |
| `clickable` | page-lib 命中测试结论（动作可用性以此为准） |
| `domClickable` | DOMSnapshot `isClickable`，仅作交叉参考，不覆盖 page-lib 的 `clickable` |
| `visibilityStale` | DOMSnapshot 判定不可见、但 page-lib `hitTest=self` 时为 `true` |
| `underBlockingLayer` | 节点完全落在某个 `blockingLayers` 矩形内时，记录 `{role,name,coverage}` |
| `domValue` | 表单控件在 DOMSnapshot 里的当前值；password/sensitive autocomplete 固定为 `********` |
| `domChecked` / `domSelected` | DOMSnapshot 的 checked / option-selected 事实 |
| `formStateStale` | page-lib 采样值与 DOMSnapshot 不一致时为 `true`（密码字段不参与比较） |
| `domPaintOrder` | DOMSnapshot 的绘制顺序（越小越先绘制），可与 page-lib 的 `paintOrder` 交叉校验 |

返回汇总 `facts: { nodes, axMatched, vomMatched }`。

- `--vom --facts` 不需要 `--ax`：页面侧临时 `data-bb-vom` 标记 + `DOM.getDocument(pierce)` 完成映射。
- 语义树文本会同步修正：DOMSnapshot 判定不可见、但语义树仍带 ref 的行末尾追加 `[dom-hidden]`；
  结果另带 `hiddenRefs: ["@eN"]`，`facts.hiddenRefs` 为数量。
- `--facts` 是 opt-in；未开启时零附加 CDP 成本，语义树文本不变。
- 事实采集失败只记日志，不影响 observe 主体结果。

## 53c. `observe --fallback-ax`（AX 兜底观察）

当 page-lib 无法在该页执行（受限页、错误页、页面脚本异常、扩展重载后的旧页面等）时，
`observe` 会自动尝试用 CDP AX 树 + DOMSnapshot 几何渲染一份降级语义树；也可以显式
`observe --fallback-ax` 强制使用。

- 结果带 `fallback: "ax"`、`refs: 0`、`axNodes`、`url`、`title`；文本形如
  `- button "提交" (interactive, @x,y wxh)`，不分配 `@eN` ref（ref 必须来自页面侧）。
- 不支持与 `--vom`/`--ax` 同用（无 page-lib ref），会返回 `E_BAD_ARG`。
- AX 树更新有一拍延迟，兜底前会先收起 BridgeDeck 接管浮层并等待约 300ms；
  极端情况下仍可能包含少量自身浮层节点。
- 自动兜底失败时仍返回原始错误，不会掩盖 page-lib 的真实失败。

## 53d. 未映射的 AX 交互元素

`observe --ax --vom [--facts]` 时，AX 树里可交互、但没有映射到 VOM ref 的节点（典型是
closed shadow DOM 或 page-lib 漏掉的虚拟列表项）会作为补充信息返回：

- 结果字段 `unmappedAx: [{ role, name, value, backendNodeId, bounds? }]`（最多 20 条）。
- 语义树末尾追加 `── 未映射的可交互元素（AX/DOMSnapshot，仅供定位）──`，每条带几何
  `(@x,y wxh)` 且标注 `[仅供定位，无 ref]`。
- 只在同时给 `--vom` 时计算（需要 VOM → backendNodeId 的映射基准）；单独 `--ax` 不输出该段，
  避免把所有交互元素误报为未映射。
- BridgeDeck 自己接管浮层上的按钮文案会被过滤掉。

## 53e. `click-backend`（按 backendNodeId 点击）

用途：点击 AX/DOMSnapshot 发现、但没有 `@eN` ref 的元素（closed shadow、page-lib 漏掉的节点）。

```
bridge click-backend --backend <backendNodeId> [--session <id>]
params: { backendId }
→ { ok: true, trusted: true, via: "cdp-backend", backendNodeId, x, y }
```

流程：`DOM.resolveNode` → `Runtime.callFunctionOn` 校验 attached/零尺寸/`display`/`visibility`/`opacity`/
`pointer-events`，主文档元素再做 `elementFromPoint` 遮挡检查并 `scrollIntoView` → 派发 CDP
`mouseMoved/mousePressed/mouseReleased`（`isTrusted=true`）。

- 失败：`E_NOT_FOUND`（backend 失效）、`E_NOT_ACTIONABLE`（隐藏/零尺寸/不可交互）、
  `E_OCCLUDED`（命中测试被遮挡），均带 `dispatched:false`。
- 安全边界：属于 `TAB_METHODS`，受 pause/context/`--expect` 策略约束；同时计入
  `AGENT_INPUT_METHODS`，不会被误判为人工输入而自动暂停会话。
- 它不替代 ref 体系：导航/重渲染后 backendNodeId 同样失效；不改变 ref 的选择与校验规则。

## 53f. 表格结构事实（AX 层级）

`observe --ax --vom` 时，从 AX 树的 `table/grid/treegrid → row → cell/columnheader/rowheader`
层级推导表格坐标：

- 结果字段 `tables: [{ role, name, rowCount, colCount, headers }]`。
- `axNodes` 中的单元格附 `table: { role, row, col, header?, headerRow? }`；`row`/`col` 从 0 开始。
- 表头行单元格带 `headerRow: true`；数据行单元格带同名列表头 `header`。
- VOM 节点若通过 backendNodeId 匹配到单元格，也会附同样的 `table` 字段。
- 纯只读推导，不改变 ref/动作规则；复杂合并单元格/多级表头以 AX 实际层级为准。

## 53g. 阻挡层事实（dialog / alertdialog）

`observe --ax --vom --facts` 时，结合 AX 角色与 DOMSnapshot 几何识别阻挡层：

- 结果字段 `blockingLayers: [{ role, name, backendNodeId, bounds, coverage }]`。
- 仅统计 `dialog` / `alertdialog`、DOMSnapshot 判定可见、且面积 ≥ 视口 25% 的节点；
  `coverage` = 节点面积 / RootWebArea 面积（保留 3 位小数）。
- 落在阻挡层矩形内的 VOM 节点会带 `underBlockingLayer:{role,name,coverage}`（阻挡层自身除外）。
- 最多返回 5 条；它是独立交叉检查，不替代 page-lib 的 `blocking`/`hitTest`，也不改变动作策略。

## 53h. 观察管线双跑校验（`observe --compare-ax`）

诊断模式：默认 observe 输出不变，额外独立跑一次 AX + DOMSnapshot 管线，用于替换采集器前的量化基线。

- 结果字段 `pipelineCompare: { pageLib:{ms,refs,chars,lines}, ax:{ms,nodes,chars,lines},
  interactiveTotal, matched, unmappedInteractive, axCoverage }`。
- 校验前给页面打临时 `data-bb-vom` 标记，用同一张 DOMSnapshot 解出 `vomId→backendNodeId`，
  结束后清理；`axCoverage = matched / interactiveTotal`。
- `interactiveTotal` 只统计 AX 中交互角色、且 DOMSnapshot 未判定隐藏的节点；
  `matched` 是其中能在 VOM 找到同 backendNodeId 的数量。
- 该模式有额外 AX/快照开销，不建议生产高频使用；默认 observe 不受影响。

## 53i. 备用采集器（`observe --pipeline ax`）

不经过 page-lib，直接用 AX + DOMSnapshot 产出观察，用于采集器替换前的量化校验与降级：

- 返回 `pipeline:"ax"`、`refs:0`、`fallback:"ax"`；
- `nodes: [{role,name,value,backendNodeId,bounds,visible,clickable,interactive,table?}]`，
  按 AX 顺序最多 `maxNodes` 条（默认 200），跳过 `none/generic/InlineTextBox` 与 DOMSnapshot 不可见节点；
- `observation` 为 AX 文本树（含几何与表格缩进）；
- 没有 `@eN` ref，不能直接 click/fill；需要动作时用 `backendNodeId` + `click-backend`，或改用默认 page-lib；
- 与 `--vom`/`--ax`/`--fallback-ax` 互斥（`E_BAD_ARG`）。


## 54. transfer.* 分块文件传输（v0.1 波次 38）

大文件不再塞进单次 JSON RPC：CLI 先把字节分块写入 daemon staging，再让 daemon 把内部路径注入给扩展。
CLI/页面只持有 opaque `transferId`，真实路径只出现在 daemon 内部与 daemon → 扩展这一跳。

| 方法 | 请求 | 返回 |
| --- | --- | --- |
| `transfer.begin` | `{ session, name, byteSize }` | `{ transferId, chunkSize }` |
| `transfer.chunk` | `{ transferId, offset, dataBase64 }` | `{ nextOffset, eof }` |
| `transfer.finish` | `{ transferId }` | `{ transferId, byteSize }` |
| `transfer.read` | `{ transferId, offset, maxBytes? }` | `{ nextOffset, eof, dataBase64 }` |
| `transfer.release` | `{ transferId }` | `{ released }` |

约束：

1. `byteSize` 1..64MiB；单块 ≤1MiB；`offset` 必须连续，越界/超声明大小返回 `E_TRANSFER_OFFSET`/`E_TRANSFER_LIMIT`。
2. `name` 只能是 basename，拒绝 `../`、路径分隔符与 Windows 非法字符（`E_BAD_ARG`）；staging 目录为
   `BB_HOME/transfers/<transferId>/<name>`，保留原文件名给 `DOM.setFileInputFiles`。
3. `transfer.chunk` 只在 finish 前可写；`transfer.finish` 校验已写字节数等于 `byteSize`，不等返回 `E_TRANSFER_INCOMPLETE`。
4. `transfer.read` 用于读取已 staging 的文件（下载/测试/远程客户端），每次最多 1MiB。
5. `transfer.release` 幂等；`session.stop` 会释放该会话的所有 transfer；daemon 启动时清空上次崩溃遗留的 staging。
6. `upload` 对 >4MiB 的文件自动走 transfer staging，并在 daemon 侧把 `transferId` 换成 `stagedPath`/`paths`；
   小文件仍内联 base64，保留隐藏 `input[type=file]` 兜底。CLI 不接触 staging 路径。
7. 下载完成后 daemon 把浏览器文件导入 staging 并返回 `transferId`/`transferBytes`；CLI 用 `transfer.read`
   分块写入 `--out`，提交成功后立即 `transfer.release`（结果带 `transferReleased:true`）。浏览器路径仍以
   `browserPath` 回显，兼容本地调试。
8. 远程浏览器连接（WSS 配对）暂不支持文件传输，
9. `transfer.*` 参数在 daemon 进入业务逻辑前由 `lib/schemas.mjs` 校验（字段/范围/`tr_` id pattern），
   失败返回带字段路径的 `E_BAD_ARG`；同一 validator 也覆盖 `observe`/`console`/`navigate`/`wait-*`/`click`/`fill`/`press` 等动作参数。


## 55. 可信输入的遮挡校验（v0.1 波次 39）

`--trusted` 的原生鼠标/键盘注入会落到“屏幕坐标上最上层元素”。如果目标被浮层、弹窗或另一个元素覆盖，
注入会点到遮挡层而不是目标，过去表现为“命令成功但页面无反应”。

现在 `click`/`hover` 在派发前调用页面侧 `hit-test`：

```
{ state: "self"|"descendant"|"ancestor"|"blocked"|"pointer-events-none"|"offscreen"|"empty"|"none"|"hidden", occludedBy, rect }
```

- `blocked` 或 `pointer-events-none` 时返回 `E_OCCLUDED`，`data` 带 `{ hitTest, occludedBy, rect }`；
- 扩展浮层会在校验前被 `withOverlaysHidden` 隐藏，不会误报自身接管条；
- `--force` 跳过校验，仍按原坐标派发（用于确认遮挡层可点/需要穿透的场景）；
- 该校验只影响 `--trusted`，普通 click/hover 的页面内语义点击不变；`fill`/`press`/`drag` 仍走原有聚焦/拖拽逻辑。


## 56. 输入租约（v0.1 波次 40）

同一标签页的原生鼠标/键盘派发必须互斥，避免两个动作的 `mouseMoved/mousePressed/keyDown` 交叉
（表现为点击落点漂移、输入被截断）。扩展内维护 `tabId -> {token, owner, expiresAt}`：

- 可信 click/hover/fill/press/drag 在派发前 `acquire`，完成后 `finally release`；
- 同 tab 已有活跃租约时返回 `E_INPUT_BUSY`（`data={tabId,owner,expiresInMs}`），不会静默回退页面内点击；
- 租约默认 15s，drag 30s；`renew` 可延长；过期租约不再阻塞新动作；
- `tab` 关闭时 `clearInputLeases(tabId)`，避免 orphan；
- 单测覆盖互斥、token 校验、TTL、renew、clearTab/releaseOwner。


## 57. `observe --ax` 原始 AX 树（v0.1 波次 41）

`observe --ax` 在常规语义树之外返回 `axNodes`，来自 CDP `Accessibility.getFullAXTree`：

| 字段 | 说明 |
| --- | --- |
| `role` / `name` / `value` | AX 角色、可访问名、当前值（password/保护字段打码） |
| `checked` / `disabled` / `expanded` / `focused` / `required` / `selected` | AX 状态；未知为 `null` |
| `backendNodeId` | Chromium backendNodeId，可用于后续 CDP join |

约束：

1. 只保留未 ignored、role 非 `none/generic` 的节点；最多 1000 个。
2. AX 树不带 `@eN` ref；它用于补充 DOM 语义树，不替代 `--vom`。
3. 每次调用临时挂 debugger（`Accessibility.enable`），完成后释放；页面会短暂显示“正在调试”。
4. 与 `--vom` 可同时使用：`nodes` 是 DOM 结构化节点，`axNodes` 是 AX 语义节点。
5. 同时给 `--vom --ax` 时做两级 join：先用页面侧临时 `data-bb-vom` 标记 + CDP `DOM.getDocument(pierce)`
   得到 DOM 节点的 `backendNodeId`，与 AX 的 `backendDOMNodeId` 精确匹配；未命中的再按 `role + 可访问名`
   （截断 80 字符）退回。命中的 DOM 节点带 `ax` 对象，并用 AX 的 `checked/disabled/expanded/focused` 补强；
   结果带 `axJoin:{matched,unmatched,byBackendNodeId,byRoleName}`。临时标记在返回前清理。





