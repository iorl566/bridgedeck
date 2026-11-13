# 会话作用域（session scope）

多会话/多 Agent 并行时，用**确定性的顺序**选会话，避免“到底操作了哪个标签页”的歧义。作用域只是选择规则，不是安全边界。

## 解析顺序

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `--session <id>` | 显式 sessionId，永远优先 |
| 2 | `--session-scope <名字>` | 按 `controller.name` / `controller.project` / `sessionId` 匹配唯一会话 |
| 3 | `BB_SESSION=<id>` | 环境变量兜底（CLI 与 MCP 都支持） |
| 4 | daemon 单会话默认 | 只有一个 session 时自动选用 |
| 5 | 报错 | 多个 session 且没有指定时返回 `E_NO_SESSION` |

`--session` 与 `--session-scope` 同时给时，`--session` 胜出。

## 用法

```powershell
# 开两个 Agent 会话，带可读的作用域身份
bridge session start --agent-name "研究 Agent" --project research --no-focus
bridge session start --agent-name "表单 Agent" --project forms --no-focus

# 之后按项目名选会话，不必记 sessionId
bridge observe --session-scope research
bridge fill '#q' --value "browser bridge" --session-scope forms

# 也可以按 Agent 名称
bridge click '#submit' --session-scope "表单 Agent"

# 环境变量兜底（适合 CI / 子进程）
$env:BB_SESSION = "abcd"
bridge observe
```

scope 支持三种匹配：

- `sessionId`（如 `abcd`）
- `controller.name`（`--agent-name`）
- `controller.project`（`--project`）

## 歧义与报错

- 没有匹配：`E_NO_SESSION`，错误信息会列出可用 scope，例如 `agcb(Agent A/proj-a), shfq(Agent B/proj-b)`。
- 匹配多个：`E_NO_SESSION`，提示改用 `--session` 指定。
- 空 scope：`E_BAD_ARG`。

## MCP

MCP server 同样按顺序解析：

1. 工具参数 `session`
2. 工具参数 `session_scope`（支持时）
3. 环境变量 `BB_SESSION`
4. 环境变量 `BB_SESSION_SCOPE`
5. 没有则自动 `session.start`

例如：

```powershell
$env:BB_SESSION_SCOPE = "research"
node mcp/server.mjs
```

## 与 DSH 子代理

DSH 插件提供 `sessionScope` 配置：插件实例会把 `BB_SESSION_SCOPE=<值>` 注入每次 CLI 调用，
工具未显式传 `sessionId` 时，CLI 按 controller name/project 解析唯一会话。

插件还会在 DSH 传入 `exec` 上下文时自动尝试 `exec.sessionScope || exec.sessionId || exec.agentId`；
显式配置的 `sessionScope` 优先。这样同一个 profile 的子代理若拿到独立 session id，可直接映射到
同名 controller 的浏览器会话。

```yaml
- insert:
    - id: browser-bridge-tools
      name: dsh-browser-bridge
      config:
        sessionScope: research
```

同一个 profile / 子代理使用同一份插件配置；需要每个子代理独立 scope 时，为子代理启动单独的
profile 或显式传 `sessionId`。DSH 是否在 `exec` 里提供 `sessionId/agentId` 取决于运行时版本；
没有时仍可用 `sessionScope` 配置兜底。
