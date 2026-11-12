# 架构

BridgeDeck 由四个进程/运行面组成，彼此只通过本机 WebSocket 与扩展消息通信。

## 组成

| 层 | 职责 |
| --- | --- |
| CLI | 参数解析、命令编排、输出格式、daemon 自动拉起 |
| daemon | WebSocket 服务、鉴权、实例/会话注册、请求路由、流控 |
| 扩展 | 标签页/窗口操作、CDP、VOM/AX、截图、录制、视频、审计、UI |
| MCP / DSH 插件 | 把 CLI 或扩展能力暴露成 Agent 工具 |

```text
Agent
  │  CLI / MCP / DSH plugin
  ▼
bridge / mcp/server.mjs
  │  HTTP health + WebSocket
  ▼
daemon  ── 实例注册、会话、请求/响应、事件
  │  WebSocket
  ▼
MV3 扩展  ── 标签页、CDP、内容脚本、offscreen、IndexedDB
  │
  ▼
Chromium 浏览器
```

## 连接

1. CLI 读取 `daemon.json`；缺失或失效时自动拉起 daemon。
2. 扩展通过 WebSocket 发送 `hello`，daemon 返回实例 id 与协议版本。
3. CLI 创建 session；session 绑定实例、标签页与 Agent Window。
4. 每个命令带 `session` 或由唯一 session 自动选用。
5. 扩展执行命令并回包；事件按连接推送。

## 会话与标签页

- 每个 session 有自己的 Agent Window。
- 用户已有标签页需要显式借用，结束后归还。
- 标签页移动、跨窗口、popup 捕获都由 session-manager 处理。
- 关闭标签页或断连会清理该标签页上的录制、CDP 与借用状态。

## 扩展内部

| 模块 | 职责 |
| --- | --- |
| `browser-driver/` | CDP attach、命令超时、frame graph、console/network、对话框 |
| `content/` | 页面内观察、录制、协作采集、浮层 |
| `debug/` | 调试采集、证据、规则、重放、归档 |
| `video/` | 分片 MP4、恢复、下载、RPC |
| `long-screenshot/` | tile 调度、拼接、PNG 导出 |
| `transport/` | 握手、认证、配对、远端连接 |
| `session-manager/` | 会话、窗口、标签页、任务弹出 |
| `lib/` | 共享纯函数与桥接 |

## 数据流

```text
命令 → daemon 路由 → 扩展 dispatch
  ├─ CDP（可信输入、截图、网络、对话框）
  ├─ 内容脚本（VOM/AX、页面动作、录制）
  └─ offscreen（视频编码、长截图）
        │
        └─ IndexedDB / OPFS / 下载
```

## 本地存储

| 数据 | 位置 |
| --- | --- |
| 连接与设置 | `chrome.storage.local` |
| 会话状态 | `chrome.storage.session` |
| 调试历史 | 扩展 IndexedDB |
| 视频 | 扩展 IndexedDB + OPFS |
| 长截图 | 扩展存储 + 下载 |
| 审计 | 本机 daemon 目录 |

## 失败与恢复

- CDP 读取有 deadline 与 gate，超时不会无限挂起。
- daemon 重启后 session 可恢复并继续操作。
- 视频分片在页面导航/worker 重启后可恢复。
- 扩展重连沿用 `instanceId`，避免把同一浏览器识别成新实例。
