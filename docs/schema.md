# 协议 schema 自查

`bridge schema` 直接从单一来源读取方法元数据与参数 schema，不依赖发版文档：

```powershell
bridge schema                 # 全部方法：method / scope / effect / mutating
bridge schema click           # 单个方法，人类可读 JSON
bridge schema click --json    # 机器可读
bridge help click             # 由 schema 生成的单方法帮助（含必填/可选标记）
```

输出字段：

| 字段 | 含义 |
| --- | --- |
| `method` | 协议方法名 |
| `scope` | `local` / `session` / `instance`；扩展方法按是否依赖会话归入 session/instance |
| `effect` | `lib/protocol.mjs` 的 `METHOD_EFFECT`（`browser_mutation` / `read` / `control_plane` …） |
| `mutating` | 是否进入意图账本保护 |
| `schema` | `lib/schemas.mjs` 的规范参数 schema；没有显式 schema 时为 `null` |
| `flags` | 由 schema 属性生成的 CLI flag（camelCase → kebab-case，`waitTimeoutMs` 映射为 `--wait-timeout`） |

示例：

```json
{
  "method": "click",
  "scope": "session",
  "effect": "browser_mutation",
  "mutating": true,
  "flags": ["--ref", "--selector", "--trusted", "--force", "--wait-timeout"],
  "schema": {
    "type": "object",
    "properties": {
      "ref": { "type": "string" },
      "selector": { "type": "string" },
      "trusted": { "type": "boolean" },
      "force": { "type": "boolean" },
      "waitTimeoutMs": { "type": "integer" }
    }
  }
}
```

## 与其它入口的关系

- CLI 参数校验、daemon `validateMethodParams`、MCP `inputSchema` 都读 `lib/schemas.mjs`；改一处即可。
- `bridge schema` 用于排查“这个参数到底叫什么 / 会不会进账本 / 属于哪个 scope”，也是生成 SDK/文档的输入。
- `bridge help <method>` 与总览帮助里的 `click/fill` 参数片段都由 schema 生成；改 schema 后帮助自动同步。
- 方法集合以 `lib/protocol.mjs` 的 `METHOD_EFFECT` 为准；`tools/protocol-check.mjs` 会校验扩展 handler 与 MCP 方法映射都在其中。
