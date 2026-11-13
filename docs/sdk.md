# Node / Python SDK

SDK 是 daemon 的薄封装：直接走本地 `/rpc`，不经过 CLI 进程，保留协议错误码与 session 语义。
Node 与 Python 两套 API 形状一致，都对齐 Playwright 的 `browser.newPage()` / `page.*`。

## Node

`browser-bridge/sdk` 是 daemon 的 Node/TypeScript 薄封装：直接走本地 `/rpc`，不经过 CLI 进程，
保留协议错误码与 session 语义。API 形状对齐 Playwright 的 `browser.newPage()` / `page.*`。

## 快速开始

```js
import { connect } from 'browser-bridge/sdk';

const bb = await connect();          // 读 ~/.browser-bridge/daemon.json；未运行会拉起 daemon
const page = await bb.newPage();     // ≈ session.start
await page.goto('https://example.com');
await page.fill('#q', 'browser bridge');
await page.press('Enter');
await page.waitForNavigation({ waitUntil: 'load' });
console.log((await page.observe()).observation);
await page.screenshot({ path: 'shot.png', fullPage: true });
await page.close();
```

## API

### `connect(options?)`

| 选项 | 说明 |
| --- | --- |
| `home` | 状态目录，默认 `BB_HOME` 或 `~/.browser-bridge` |
| `timeoutMs` | 单次 RPC 默认超时，默认 60000 |
| `autoStart` | daemon 未运行时是否自动拉起，默认 `true` |
| `startTimeoutMs` | 自动拉起等待上限，默认 12000 |

返回 `BrowserBridge`。`autoStart: false` 时 daemon 未运行会抛 `E_DAEMON`。

### `BrowserBridge`

- `status()` / `sessions()` / `browsers()`
- `newPage({ url?, browser?, tab?, noFocus?, incognito?, controller? }) → Page`
- `page(sessionId) → Page`（不存在抛 `E_NO_SESSION`）
- `pages() → Page[]`
- `rpc(method, params, { timeoutMs })`：直接调用任意协议方法
- `stopDaemon()`

### `Page`

- 导航：`goto(url)` / `reload()` / `back()` / `forward()`
- 动作：`click(target, opts)` / `hover` / `fill(target, value, opts)` / `press(key, { target? })` /
  `select(target, value)` / `focus` / `scrollTo`
  - `opts.waitTimeoutMs` 控制动作前等待（默认 5000ms，`0` 关闭）；`force` 跳过遮挡检查。
- 读取：`read(target?)` / `evaluate(expr)` / `observe(opts)` / `snapshot()`
- 等待：`waitForElement(target, opts)` / `waitForNavigation(opts)` / `waitMs(ms)`
- 截图：`screenshot({ path?, fullPage?, scope?, annotate? })`（给 `path` 时自动落盘）
- 会话：`pause(reason?)` / `resume()` / `close({ keep? })`

`target` 支持三种写法：`'@e3'`（引用）、`'#name'`（CSS selector）、`{ ref } / { selector }`。

### 错误

所有业务失败抛 `BridgeRpcError`：

```js
try {
  await page.click('#covered');
} catch (error) {
  console.log(error.code);        // E_NOT_ACTIONABLE / E_SESSION_PAUSED / ...
  console.log(error.method);      // click
  console.log(error.data);        // 结构化细节（如有）
  console.log(error.effectState); // unknown 时不要盲目重放
}
```

## 与协议的关系

SDK 不维护第二份方法表：`Page` 的每个动作都映射到 `lib/methods.mjs` 中的规范方法名
（`navigate`、`click`、`fill`、`press`、`select`、`observe` 等）。协议新增方法时，
调用方也可以直接用 `bridge.rpc('method', params)` 透传。

## 类型

`sdk/index.d.ts` 提供 TypeScript 声明；`package.json` 的 `exports["./sdk"]` 同时给出
`types` 与 `import` 入口。

## Python

`sdk/python/browser_bridge.py` 是零第三方依赖的 Python SDK（Python 3.9+），API 与 Node 版对齐：

```python
import sys
sys.path.insert(0, "sdk/python")
from browser_bridge import connect

bb = connect()                 # 读 ~/.browser-bridge/daemon.json；需要时拉起 daemon
page = bb.new_page()           # 或 new_page(url="https://example.com")
page.goto("https://example.com")
page.fill("#q", "browser bridge")
page.press("Enter")
print(page.observe()["observation"])
page.screenshot(path="shot.png")
page.close()
```

- `connect(home=None, timeout=60, auto_start=True, start_timeout=12)`
- `BrowserBridge.new_page / page / pages / status / sessions / browsers / rpc`
- `Page.goto / reload / back / forward / click / hover / fill / press / select / evaluate /
  observe / snapshot / wait_for_element / wait_for_navigation / screenshot / pause / resume / close`
- `target` 同样支持 `"@e3"`、`"#name"`、`{"ref": ...}` / `{"selector": ...}`
- 业务失败抛 `BridgeError`，保留 `code`、`message`、`data`、`method`、`effect_state`

安装（可选，便于打包）：

```powershell
pip install -e sdk/python
```

测试：

```powershell
python -m unittest discover -s tests/python -v
```

## 限制

- 仅 Node 20+（使用全局 `fetch` 之外的 `node:http/https` 与 ESM）。
- 不做浏览器扩展安装/daemon 更新；这些仍走 CLI/安装器。
- 自动拉起 daemon 时使用当前 `process.execPath` 与仓库内 `daemon/server.mjs`，
  因此要求 SDK 与 daemon 同仓部署（本项目的发行形态）。
