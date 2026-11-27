# MCP

BridgeDeck 提供 stdio MCP server，把浏览器能力暴露成工具。适合支持 MCP 的 Agent 直接调用。

## 启动

```powershell
node mcp/server.mjs
```

Agent 配置示例：

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["D:/浏览器桥/mcp/server.mjs"]
    }
  }
}
```

## 一键写入客户端配置

```powershell
node cli/bridge.mjs mcp-install --dry-run --json
node cli/bridge.mjs mcp-install --client claude,opencode,vscode,copilot
```

支持 **30 个客户端**（或 `all`）：`claude`、`claude-desktop`、`cursor`、`opencode`、
`vscode`、`vscode-insiders`、`windsurf`、`kilo`、`amp`、`copilot`、`kiro`、`qwen`、`codebuddy`、
`cortex`、`pi`、`qoder`、`warp`、`junie`、`kimi`、`lm-studio`、`trae`、`trae-cn`、`cline`、
`roo-cline`、`augment`、`codex`、`grok`、`goose`、`hermes`、`dsh`。
JSON/JSONC 注释与格式保留；Codex/Grok 使用 TOML，Goose/Hermes 使用 YAML（已有顶层 key 时插入子项，不重写其他条目），DSH 写 `cordis.patch.yml` patch 行（已有 browser-bridge 行时更新 command/args）。

| 客户端 | 文件 | keyPath |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Claude Desktop | `.../Claude/claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.servers`（local + command 数组） |
| VS Code | `.../Code/User/mcp.json` | `servers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Kilo | `~/.config/kilo/kilo.json` | `mcp`（local + command 数组） |
| Amp | `~/.config/amp/settings.json` | `amp.mcpServers` |
| Copilot | `~/.copilot/mcp-config.json` | `mcpServers` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers` |
| Qwen | `~/.qwen/settings.json` | `mcpServers` |

安全约定：

- 已存在同名但配置不同的 server 时返回 `conflict`，不覆盖；
- JSONC 注释/尾逗号支持，写入后会二次解析校验；
- `--dry-run` 只输出将写入的文本，不落盘；
- Codex 的 TOML 仍走 `install-skill --harness codex --mcp`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_status` | daemon、浏览器与 session 状态 |
| `browser_session_start` | 新建 session / 绑定标签页 |
| `browser_observe` | 读取页面与 `@eN` 引用 |
| `browser_act` | click/fill/press/drag/wheel 等动作 |
| `browser_read` | 读取元素、字段、表格 |
| `browser_extract` | 结构化提取 |
| `browser_screenshot` | 截图 |
| `browser_wait` | 等元素/导航 |
| `browser_dialog` | 对话框处理 |
| `browser_tab` | 标签页操作 |
| `browser_window` | 窗口操作 |
| `browser_debug` | 调试采集与证据 |
| `browser_video` | 视频录制 |
| `browser_audit` | 审计列表 |

完整 51 个工具以 `initialize` / `tools/list` 返回为准。

每个工具都声明了对应的协议方法（`methods`），`tools/protocol-check.mjs` 会校验它们都在
`lib/protocol.mjs` 的 `METHOD_EFFECT` 中；本地 CLI/文件类工具使用显式空映射。

页面动作（observe/navigate/click/fill/read/extract/evaluate）与 tab/record/video/wait/debug/rule/network
控制类工具的 `inputSchema` 由 `lib/schemas.mjs` 经 `lib/mcp-schemas.mjs` 生成；window/dialog/settings
是 action 组合工具，仍手写。新增参数只需改规范 schema 一处。

## 约定

- 多 session 时必须显式传 session；也可以用 `BB_SESSION` / `BB_SESSION_SCOPE` 环境变量或 `session_scope` 参数，见[会话作用域](scope.md)。
- 动作失败返回结构化错误码与 `data`，不要靠文本猜。
- 工具只操作已授权标签页；借用标签页需要用户确认（可由设置关闭确认）。
- 截图/证据默认落本机，不经过远端。

## 自测

```powershell
node tests/mcp/selftest.mjs
```

自测会启动 server、完成 initialize、列出工具，并在无 daemon 时验证明确错误。
