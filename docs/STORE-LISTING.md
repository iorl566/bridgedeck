# 商店提交信息（浏览器扩展商店）

## 基本信息

- 名称：BridgeDeck
- 短名称：BridgeDeck
- 版本：0.1.2
- 类别：生产力 / 开发者工具
- 默认语言：英语（美国）；中文（简体）可后续补充

## 简短描述（≤132 字符，英文）

```
Drive your logged-in Edge from an AI agent: read, fill, screenshot, record, debug — all local.
```

## 详细描述（英文，商店 Store 一览）

```
BridgeDeck turns the browser you already use into a workspace for your AI agent.

Give your agent a task; it works in its own Agent Window using your existing logins, while you keep control and can take over at any time.

WHAT YOU CAN DO
• Work where you are already signed in — read documents, search internal sites, complete web flows.
• Turn instructions into browser actions — read page structure, click, type, fill forms, drag, scroll, manage tabs.
• Stay in control — shared control, a visible control card, pause and stop, a blue breathing border around the controlled page, and confirmation before borrowing one of your tabs.
• Take web data with you — extract tables and lists as JSON or CSV with column names and source information.
• Find the evidence behind a failure — requests, response bodies, console messages, page changes, performance and duplicate requests, with JSON export.
• Keep a replay of the work — record one authorized task tab as a silent MP4 and preview, save or delete it from the extension.
• Capture long pages — automatic scrolling, manual stitching, or the visible area only.
• Keep a record — optional operation audit, task history, and evidence stored locally.

BUILT FOR AGENTS
BridgeDeck exposes one CLI, an MCP server (49 tools) and a DeepSeek Harness plugin. Any agent that can run shell commands can use it; nothing is tied to a specific model.

LOCAL AND PRIVATE BY DEFAULT
• Connects to a local daemon on 127.0.0.1 by default; no cloud service and no telemetry.
• Remote pairing is optional and uses authenticated WSS; unpaired local connections still work with an identity warning.
• Screenshots, recordings, debugging evidence and audit records stay on your machine.
• The extension never calls an AI provider by itself.

REQUIREMENTS
• Microsoft Edge or Chrome (Chromium 125+).
• Node.js 18+ for the local daemon and CLI.
• Windows 10 or later (the daemon currently ships for Windows).

Start at the GitHub repository for the CLI, installation guide and documentation:
https://github.com/iorl566/bridgedeck
```

## 截图（1280×800，可直接上传）

1. `docs/assets/store/store-01.png` — Agent 在独立窗口工作 + 接管浮层（总览）
2. `docs/assets/store/store-02.png` — 弹窗主界面（连接 / 任务 / 开关）
3. `docs/assets/store/store-03.png` — 快捷功能（审计、长截图、视频、调试、录制）
4. `docs/assets/store/store-04.png` — 整页截图与调试证据
5. `docs/assets/store/store-05.png` — 蓝色呼吸边框 + 暂停/停止

注意：不要包含第三方品牌、公司名、真实账号信息；演示页面用 `ref/demo-workspace.html` 生成。

## 隐私

隐私说明见 `extension/PRIVACY.md`；提交时把该文件内容发布为可访问的隐私政策 URL。

## 权限说明

见 `docs/STORE-REVIEW.md` 的权限表；提交时可直接粘贴"权限与用途"一节。
