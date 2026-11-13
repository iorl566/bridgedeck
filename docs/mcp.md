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

完整 49 个工具以 `initialize` / `tools/list` 返回为准（当前 50 个）。

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
