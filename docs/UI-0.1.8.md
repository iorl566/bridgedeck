# BridgeDeck 0.1.8 UI 收尾记录

最后更新：2026-11-17。范围：只改 `D:\浏览器桥`；未触碰 `D:\CTRM自动录入`。

## 1. Popup 三项真实页面验证

入口：`bridge ui --page popup`（在浏览器里打开真实扩展页 `ui/popup.html`）。

新增/覆盖：

- `#upgradeNotice`：`protocolSkew=daemon_newer` 显示「扩展需要更新」，版本号显示
  `daemon <protocol> / 扩展 <PROTOCOL_VERSION>`，命令文案为「请更新扩展」；
  `protocolSkew=daemon_older` 显示「版本不兼容」和 `bridge update apply`。
- `#localAuthBadge`：已验证 / 未配对 / 跳过配对（身份未验证）/ 需要配对。
- `#copyUpgrade`：复制 `bridge update apply` 或命令文案，成功/失败都有反馈；
  剪贴板 API 失败时回退到 `textarea + execCommand`。
- Popup 自测 `?selftest=1` 在真实扩展页里用合成状态渲染并断言上述三项，
  结束后 `refresh()` 恢复真实状态。
- 视觉验收钩子：`bridge ui --page popup --query preview=upgrade` 用假状态展示
  「扩展需要更新」通知，不修改真实连接设置。

## 2. 内容浮层统一 token 与深色模式

新增 `extension/src/overlay-theme.js`，作为 Borrow 模态、Borrow Toast、Help、
Takeover 四个真实内联浮层的唯一 token 来源：

| token | 浅色 | 深色 |
| --- | --- | --- |
| `--bb-surface` | `#f7f9fc` | `#1c2230` |
| `--bb-surface-raised` | `#ffffff` | `#232c3d` |
| `--bb-fg` | `#1c2230` | `#e6eaf2` |
| `--bb-muted` | `#667085` | `#98a2b3` |
| `--bb-body` | `#475569` | `#b8c4d8` |
| `--bb-line` | `#dbe4f5` | `#2a3140` |
| `--bb-accent` | `#2f6fed` | `#5b8cff` |
| `--bb-accent-strong` | `#1d4ed8` | `#a9c1ff` |
| `--bb-accent-soft` | `#e8f0ff` | `#22304b` |
| `--bb-warn-bg` / `--bb-warn-fg` | `#fdeccd` / `#8a4b08` | `#3b2a12` / `#f3c77a` |

行为：

- 跟随 `prefers-color-scheme`；
- 页面可用 `document.documentElement[data-bb-theme="dark|light"]` 强制主题，
  真机验收和 DOM 测试都用它，避免依赖浏览器主题开关；
- 浮层 host 带 `data-bb-theme`，并随系统主题变化重写变量；
- 浮层宿主加 `data-bb-overlay`，长截图/捕获路径按既有约定跳过浮层。

浮层函数由 `chrome.scripting.executeScript` 序列化执行，因此主题 helper 写在
每个函数体内；token 值只来自 `overlay-theme.js`。`tests/browser/overlay-dom.js`
会先用 `new Function(fn.toString())` 重建函数再测试，确保没有模块作用域泄漏。

## 3. 真实 DOM 组件测试

`tests/browser/overlay-dom.html` + `tests/browser/overlay-dom.js` 在真实
Chromium（headless Edge/Chrome）里直接执行发布版浮层函数，覆盖：

- Borrow 模态：`role=dialog` / `aria-modal`、初始焦点在拒绝、Tab/Shift+Tab
  循环、Escape 拒绝、允许结算、焦点恢复；
- Borrow Toast：关闭 X、进度条、倒计时推进、允许/拒绝结算；
- Help：closed shadow、`role=dialog`、折叠 `aria-expanded`、目标高亮、
  完成/取消回传、备注；
- Takeover：`role=region`、状态 `aria-live=polite`、暂停/恢复、最小化后焦点到
  mini、停止二次确认、消息回传；
- 深色 token：四个浮层在强制深色下背景/变量都切到深色值。

入口：

```sh
node tools/overlay-dom-selftest.mjs
```

`tests/unit/overlay-dom.test.mjs` 把它接进 `node --test tests/unit/*.test.mjs`；
找不到 Edge/Chrome 时跳过（本机有浏览器，实际运行）。

## 4. 协作输入层：从“明确不做”到第一版

第一版已落地（默认关闭，popup/options 可开启 `cooperationGuard`）：

- 新增 manifest content script `content/cooperation.js`（all frames）：
  - `cooperationGuard=true` 时，接管期间用透明覆盖层阻止页面**点击/滚动/touchmove**；
  - 不拦键盘——与 bsk `ControlInputBlocker` 一致；
  - Agent 输入前由 `src/cooperation.js` 发 passthrough（5s TTL），结束后恢复；
  - `bb.cooperation.read` 返回字段/媒体/焦点/文本尾部，密码、文件、OTP、卡号脱敏；
  同时记录可信活动 `lastHumanAt`/`lastKind`/`recent`，并返回 `mode`/`revision`。Agent passthrough 期间和
  结束后 500ms 宽限期不计入人类活动，避免 Agent 点击焦点被误判；
  `cooperate sync` 已把这份快照挂到 `result.cooperation`，CLI 人读输出打印摘要。
- 录制开始/结束时清掉该 tab 的所有 passthrough 租约（对齐 bsk）。
- 接管浮层卡片 z-index 在覆盖层之上，暂停/收起按钮始终可点；暂停/收起立即解锁，
  恢复/展开重新上锁。
- 之前的死协议模块仍已删除：`lib/overlay-bridge.js`、`lib/overlay-interrupt-client.js`、
  `lib/overlay-version.js`、`lib/help-bridge.js`。它们没有对应的运行时监听者。
- 失效测试工具仍已删除：`tools/content-browser-selftest.mjs`、
  `tools/cooperation-trusted-input-selftest.mjs`、`tools/overlay-browser-selftest.mjs`、
  `vite.overlay.config.mjs`、`tests/browser/cooperation-capture.html`。
- `session-manager/event-handler.js` 释放标签页时不再发送无人监听的
  `bh-agent-overlay-reset`，改为直接移除真实接管浮层 DOM。

仍缺 bsk 的完整 cooperation state/toolbar（human/agent 模式切换、事件归因、
target 标记）；这一版只覆盖“点击/滚动锁 + passthrough + read”。

## 5. 不在本批范围

Debug / Audit / 长截图的调查与证据视图是独立产品工作量，本批没有改其交互与
信息架构；只确保浮层增加 `data-bb-overlay` 后长截图仍按既有约定跳过浮层。

## 6. 验证记录（2026-11-17）

构建：

- `dist/BridgeDeck-extension-0.1.8.zip`，429542 B（141 entries，132 个参考镜像已排除）；
- sha256 `7679370b94d00d85478b34160ab02c0cfed0d0d7dd613690767acc791d870900`；
- `dist/release.json` 已更新；旧 Ed25519 签名因制品变化被移除，发布前需重新签名。

自动检查：

- `node --test "tests/unit/*.test.mjs"`：469/469（运行时）；
- `node --test "tests/reference/*.test.mjs"`：507/507（参考镜像，不随包发布）；
- `node tests/cli/selftest.mjs`：155/155；
- `node tests/extension/module-load.mjs`：PASS；
- `node tools/protocol-check.mjs`：`generatedProtocol: ok`；
- `node tools/overlay-dom-selftest.mjs`：`OVERLAY_DOM_OK:12`；
- `node --test tests/unit/cooperation-dom.test.mjs`：`COOP_DOM_OK:7`。

真机（Windows UIA 点真实按钮，使用 `tools/uia-click.ps1` 的 Invoke/坐标兜底）：

- Popup `preview=upgrade` / `preview=incompatible`、`?selftest=1` 均通过；
  点「复制命令」后剪贴板为 `bridge update apply`；
- 浅色借用模态「允许」创建会话；深色借用模态「拒绝」返回 `E_BORROW_DENIED`；
  深色 Toast「允许」创建会话；
- 浅色/深色接管浮层：暂停/恢复、收起/展开、停止两次确认均通过；
- 深色帮助浮层点「完成并交还控制权」，`request-help` 返回 `{action:"done"}`。
- 协作输入锁（`cooperationGuard=on`）：接管时覆盖层 `pointer-events:auto`，原生点击
  页面按钮无效；`bridge click` 经 passthrough 正常点击；UIA 点「暂停 Agent」后
  `{blocked:false,hasBlocker:false}`，点「交给 Agent」后恢复上锁。

证据截图：

- `docs/assets/ui/popup-upgrade-ours.png`
- `docs/assets/ui/popup-incompatible-ours.png`
- `docs/assets/ui/borrow-dark-0.1.8.png`
- `docs/assets/ui/borrow-toast-dark-0.1.8.png`
- `docs/assets/ui/help-dark-0.1.8.png`
- `docs/assets/ui/takeover-dark-0.1.8.png`
- `docs/assets/ui/takeover-light-0.1.8.png`
