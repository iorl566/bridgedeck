# BridgeDeck — en-US store listing

Locale: `en-US` (package locale `en`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/en/messages.json`, read-only):
BridgeDeck turns the browser you already use into a workspace for your AI agent. Local daemon + MV3 extension; no telemetry.

## Description

BridgeDeck turns the browser you already use into a workspace for your AI agent.

Give your agent a task and it works in its own Agent Window using the sessions you are already signed in to — while you stay in control and can take over at any moment.

WHAT YOU CAN DO

- Work where you are already signed in: read documents, search intranet sites, and complete web flows that need your own account.
- Turn instructions into browser actions: read page structure, click, type, fill forms, select options, drag, scroll, upload and download files, and manage tabs.
- Stay in control: a visible control card, a blue breathing border around the controlled page, pause and stop at any time, and a confirmation prompt before the agent borrows one of your tabs.
- Take web data with you: extract tables and lists as JSON or CSV, with column names and the page or frame each value came from.
- Find the evidence behind a failure: requests, response bodies, console messages, page changes, performance timings and duplicate-request checks, exportable as JSON.
- Keep a replay of the work: record one authorized task tab as a silent MP4, then preview, save or delete it inside the extension.
- Capture long pages: automatic scrolling, manual stitching, or just the visible area.
- Keep a record: optional operation audit, task history and evidence stored locally.

BUILT FOR AGENTS

One CLI, an MCP server (92 tools), a DeepSeek Harness plugin (37 tools), and Node.js and Python SDKs. Any agent that can run shell commands can drive the browser; nothing is tied to a specific model or vendor.

LOCAL AND PRIVATE BY DEFAULT

- Connects to a local daemon on 127.0.0.1; no cloud service and no telemetry.
- Remote pairing is optional and always uses authenticated WSS; unpaired local connections still work but show an identity warning.
- Screenshots, recordings, debugging evidence and audit records stay on your machine.
- The extension never calls an AI provider by itself.

REQUIREMENTS

- Microsoft Edge or another Chromium-based browser, version 111 or later.
- Node.js 20 or later for the local daemon and CLI.
- The daemon runs on Windows, macOS and Linux. Windows has a graphical installer; macOS and Linux use a tar.gz archive with install.sh.

GET STARTED

Install the extension, open the popup, and confirm it shows "Connected". The daemon starts automatically the first time you run a bridge command.

Source code, CLI installation guide and documentation: https://github.com/iorl566/bridgedeck

Privacy notice: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- browser automation
- AI agent
- browser control
- web scraping
- page reading
- MCP server
- Edge extension

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/*/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
