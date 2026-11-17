# UI 组件化评估

最后更新：2026-11-16。版本：0.1.3。

## 现状

扩展 UI 共 9 个页面、26 个文件、约 3.5k 行：

- 原生 ES module（无框架、无构建步骤）；
- 共享 `ui/ui.css`、`ui/popup.css`、`ui/i18n.js`；
- 页面：popup、options、quick、audit、debug、longshot、ops、record、privacy；
- 运行时零依赖，安装包约 420KiB（裁剪参考镜像后；132 个参考模块不随包发布）。

## 方案对比

| 方案 | 收益 | 成本 |
| --- | --- | --- |
| 保持原生 + 共享模块 | 包体小、无构建、CSP 简单 | 组件复用靠约定 |
| 引入 React/TSX | 组件化、类型安全 | 增加构建链、依赖与包体；UI 代码需重写 |
| 引入轻量组件函数 | 局部复用 | 收益有限 |

结论：**不引入 React**。当前 UI 规模与零依赖目标下，React 的收益不足以抵消构建链、包体和发布复杂度。

## 必要统一（已落地）

新增 `extension/ui/common.js`：

- `$`：按 id 取元素；
- `toast`：统一提示；
- `formatBytes`：统一字节格式化；
- `send`：统一 `chrome.runtime.sendMessage`。

已把 `options.js`、`audit.js` 改为从 `common.js` 导入，移除重复定义。

## 后续（按需）

1. 其余页面逐步替换本地 `$`/`formatBytes`/`toast`；
2. 统一弹窗内的状态条与空状态样式；
3. 若 UI 规模继续增长，再评估组件函数或构建方案。

## 验证

- 运行时单测 464/464（含真实 Chromium 内联浮层 DOM 测试 7/7）、参考镜像测试 507/507、CLI 155/155；
- 真实 Edge E2E 145/147（2 项按借用确认策略跳过）；
- 弹窗、设置、审计、快捷功能页在 E2E 中真实渲染通过。
