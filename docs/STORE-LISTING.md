# BridgeDeck 商店提交信息（Edge Add-ons / Chrome Web Store）

> 版本：0.3.1；扩展包：`dist/BridgeDeck-extension-0.3.1.zip`；发布流程见 `docs/STORE-PUBLISH-RUNBOOK.md`。
> 本文件只包含面向商店审核/用户的文案，不含第三方品牌。

## 1. 基本信息

| 字段 | 值 |
| --- | --- |
| 名称 | BridgeDeck |
| 短名称 | BridgeDeck |
| 版本 | 0.3.1 |
| 类别 | 生产力（Productivity）/ 开发者工具（Developer tools） |
| 默认语言 | English (United States) |
| 支持语言 | UI 12 语言：zh, zh-TW, en, ja, ko, de, es, fr, it, pt, ar, he |
| 官网 | https://github.com/iorl566/bridgedeck |
| 支持/反馈 | https://github.com/iorl566/bridgedeck/issues |
| 隐私政策 | https://iorl566.github.io/bridgedeck/privacy-policy.html（启用 GitHub Pages 的 `docs/` 后生效；内容源：`docs/privacy-policy.html` 与 `extension/PRIVACY.md`） |
| 定价 | 免费 |
| 单一用途 | 让本地 CLI/MCP Agent 在用户已登录的浏览器里执行用户授权的页面操作 |

## 2. 简短描述（≤132 字符）

```
Drive your logged-in Edge/Chrome from a local AI agent: read, fill, screenshot, record and debug — all on-device.
```

## 3. 详细描述（English）

```
BridgeDeck turns the browser you already use into a workspace for your AI agent.

You give your agent a task; it works in its own Agent Window using your existing sign-ins, while you stay in control and can take over at any time.

WHAT YOU CAN DO
• Work where you are already signed in — read documents, search internal sites, complete web flows.
• Turn instructions into browser actions — read page structure, click, type, fill forms, drag, scroll, manage tabs.
• Stay in control — shared control, a visible control card, pause/stop, a breathing border around the controlled page, and confirmation before borrowing one of your tabs.
• Take web data with you — extract tables and lists as JSON or CSV with column names and source information.
• Find the evidence behind a failure — requests, response bodies, console messages, page changes, performance and duplicate requests, with JSON export.
• Keep a replay of the work — record one authorized task tab as a silent MP4 and preview, save or delete it from the extension.
• Capture long pages — automatic scrolling, manual stitching, or the visible area only.
• Keep a record — optional operation audit, task history, and evidence stored locally.

BUILT FOR AGENTS
BridgeDeck exposes one CLI, an MCP server (92 tools) and a DeepSeek Harness plugin. Any agent that can run shell commands can use it; nothing is tied to a specific model.

LOCAL AND PRIVATE BY DEFAULT
• Connects to a local daemon on 127.0.0.1 by default; no cloud service and no telemetry.
• Remote pairing is optional and uses authenticated WSS; unpaired local connections still work with an identity warning.
• Screenshots, recordings, debugging evidence and audit records stay on your machine.
• The extension never calls an AI provider by itself.

REQUIREMENTS
• Microsoft Edge or Chrome (Chromium 111+).
• Node.js 20+ for the local daemon and CLI (or use a bundled CLI package).
• Windows 10+, macOS 12+, or mainstream Linux (x64/arm64).

Start at the GitHub repository for the CLI, installation guide and documentation:
https://github.com/iorl566/bridgedeck
```

## 4. 详细描述（中文，可选 listing 语言）

```
把你在用的浏览器变成 Agent 的工作区：任务在独立 Agent Window 里执行，复用你已登录的站点；你随时可以接手、暂停或停止。
支持页面读取/点击/填表/拖拽、表格导出、网络与控制台证据、长截图、MP4 录制与操作审计；
默认只连接本机 127.0.0.1 daemon，无云端、无遥测；远程连接需显式配对并使用 wss://。
同时提供 CLI、MCP（92 工具）与 DeepSeek Harness 插件，适配能用 shell 的任意 Agent。
```

## 5. 截图（1280×800，可直接上传）

| 顺序 | 文件 | 说明 |
| --- | --- | --- |
| 1 | `docs/assets/store/store-01.png` | Agent 在你已登录的浏览器里工作（工作区/接管浮层总览） |
| 2 | `docs/assets/store/store-02.png` | 弹窗主面板（连接/任务/开关/版本） |
| 3 | `docs/assets/store/store-03.png` | 快捷功能（视频、调试、长截图、操作录制、审计） |
| 4 | `docs/assets/store/store-04.png` | 操作录制：复制给 Agent 的指令 + 直接录制 |
| 5 | `docs/assets/store/store-05.png` | 网站调试：请求/控制台/时间线/证据 |

图标：`docs/assets/store/icon-300.png`（300×300）。截图与图标均不含第三方品牌或真实账号信息。

## 6. 权限与数据说明（审核用）

- 权限逐项用途：见 `docs/STORE-REVIEW.md`；
- 数据实践：默认本机处理、无遥测/广告/分析 SDK、不上传第三方；用户主动导出才会写文件；
- 隐私政策：`https://iorl566.github.io/bridgedeck/privacy-policy.html`；
- 已知限制：`chrome://`、商店页、PDF 内置查看器等受限页面不可注入；`debugger` 生效时浏览器显示调试提示属预期。

## 7. 0.3.1 更新说明（Release notes）

```
BridgeDeck 0.3.1
• 新的品牌 mark 与 popup/页面版式（更清晰的层级与留白）
• 操作录制：生成给 Agent 的录制指令（主题/起始网址）+ 直接录制
• 接管控制条品牌化：状态信号、暂停/停止图标、可点击穿透
• 长截图/视频状态 chip 居中；popup 底部显示协议版本
• 12 语言 UI 词条补齐，a11y/RTL/对比度门禁通过
• 发布物清理：不含第三方品牌字眼（源码与打包产物均有扫描门禁）
```
