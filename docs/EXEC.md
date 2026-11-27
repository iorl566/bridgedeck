# bridge exec（受限脚本）

`bridge exec` 让 Agent 用一段 JavaScript 组合多次浏览器操作，接近 Browse 的 `execute`
体验，但**不是安全沙箱**。

## 用法

```powershell
bridge exec --file script.mjs --session <id> --json
bridge exec --code "const r = await page.observe(); return r.title;" --session <id>
# QuickJS 沙箱：同步写法（不要 await）
bridge exec --file script.sync.js --sandbox quickjs --session <id>
```

脚本里可用：

| API | 等价命令 |
| --- | --- |
| `page.goto(url)` / `page.navigate(url)` | `navigate` |
| `page.observe(opts)` | `observe` |
| `page.click(target, opts)` | `click` |
| `page.fill(target, value, opts)` | `fill` |
| `page.press(key, opts)` | `press` |
| `page.read(target)` | `read` |
| `page.evaluate(expression)` | `evaluate` |
| `page.wait(ms)` | `wait-ms` |
| `page.waitFor(target, opts)` | `wait-for-element` |
| `page.screenshot(opts)` | `screenshot`（返回元数据，不含 dataUrl） |
| `page.webmcp.list()` / `page.webmcp.call(name, input)` | `webmcp list/call` |

`target` 可以是 `@e1`、CSS selector，或 `{ref|selector}`。脚本用 `return` 返回结果，
`console.log/warn/error` 会被捕获到 `logs`。

## `page.locator(target)`

locator 是“同一目标 + 一组动作/读取”的语法糖，**vm 与 QuickJS 两边的 surface 完全一致**
（方法清单来自 `lib/exec-page.mjs`，单测防止漂移）：

| 方法 | 作用 |
| --- | --- |
| `click(opts)` / `hover(opts)` / `focus(opts)` / `scrollIntoView(opts)` | 动作 |
| `fill(value, opts)` / `press(key, opts)` / `selectOption(value, opts)` | 输入 |
| `read()` | `read` 原始结果（`fields[]`） |
| `inputValue()` | 表单值（非表单元素退回 textContent） |
| `textContent()` | 文本内容 |
| `getAttribute(name)` | 属性值（不存在为 `null`） |
| `isVisible()` / `isHidden()` / `isAttached()` | 可见/隐藏/在文档中（`wait-for-element` 单次探测，最多 100ms） |
| `isEnabled()` | `read` 的 `disabled` 取反 |
| `actionable()` | 可操作性事实（`{ok, reason, rect, occludedBy}`） |
| `count()` | 元素数量（仅 CSS selector；`@ref` 是单元素句柄，返回 `E_BAD_ARG`） |
| `screenshot(opts)` | 元素截图（元数据；不落盘） |
| `waitFor(opts)` / `waitForVisible` / `waitForHidden` / `waitForAttached` / `waitForDetached` | 等待 |

```js
const button = page.locator('#submit-btn');
await button.click();
const label = await page.locator('#out').textContent();
const n = await page.locator('button').count();
```

## 沙箱

`bridge exec` 默认使用 Node `vm`（`await` 风格，兼容全部 page/locator API）；可显式使用
vendored QuickJS：

```powershell
bridge exec --file script.js --sandbox quickjs --session <id>
```

- QuickJS：WASM/ASYNCIFY，64 MB 内存、512 KB 栈，有超时中断；没有 Node 全局。
- **QuickJS 的 page/locator 是同步 API**：host 调用在 WASM 栈上挂起/恢复并同步返回，
  所以脚本里**不要写 `await`/`async function`**（写了会返回 `E_BAD_ARG` 并提示改用 vm）。
  ```js
  // QuickJS：同步写法
  const observed = page.observe({ maxNodes: 5 });
  page.locator('#submit-btn').click();
  return { title: observed.title };
  ```
- 失败会带结构化错误跨边界：脚本里可以 `catch (e)` 读 `e.code` / `e.data`，未捕获时
  CLI 也保留原错误码（例如 `E_NOT_FOUND`），不会被压成 `E_EXEC_FAILED`。
- 历史坑：旧的“async 用户脚本 + 手写 promise 轮询”驱动方式在连续 2-3 次 host 调用后
  会触发该 vendored asyncify 构建的 QuickJS refcount 断言（wasm abort）。改成同步脚本、
  直接取 `evalCodeAsync` 结果后，25 次连续调用稳定（单测 `exec-quickjs.test.mjs` 覆盖）。
- 依赖版本与许可见 [DEPENDENCIES.md](DEPENDENCIES.md)；两者都不是浏览器官方沙箱。

## 边界

- `vm` 沙箱：没有 `require`、`process`、`fetch`、`fs`、网络与文件系统。
- 但 **Node vm 不是安全边界**；只应执行用户/Agent 自己写的脚本，不要执行不可信第三方代码。
- 有超时（默认 30s，`--timeout` 可调）；页面调用仍受 session 的 scope/只读/tab 策略约束。
- 不替代扩展内的 `evaluate`；脚本组合的是已有的 CLI/RPC 能力。

## 示例

vm（await 风格）：

```js
const observed = await page.observe({ maxNodes: 20 });
await page.locator('#submit-btn').click();
const text = await page.locator('#out').textContent();
console.log('title', observed.title);
return { title: observed.title, text };
```

QuickJS（同步风格）：

```js
const observed = page.observe({ maxNodes: 20 });
page.locator('#submit-btn').click();
const text = page.locator('#out').textContent();
return { title: observed.title, text };
```

## 测试

- 单测：`tests/unit/exec.test.mjs`（vm：page 透传、无 require/process/fetch、console、超时）、
  `tests/unit/exec-page.test.mjs`（page/locator → RPC 映射、surface 防漂移）、
  `tests/unit/exec-quickjs.test.mjs`（同步契约、25 次连续调用、locator 读取、错误码、超时、await 拒绝）。
- E2E：`20s4`（vm：observe/waitFor/locator 读取/console）、`20s7`（QuickJS 同步脚本）、
  `20s8`（QuickJS locator 全量 + 错误码 + await 拒绝）。
