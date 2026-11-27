# 兼容 RPC 线名（daemon 本地面）

> 这些方法不是 canonical 协议方法，不进入 `lib/method-catalog.mjs`、不改变扩展协议；它们只由 daemon 本地面接受/应答，用于旧客户端与兼容调用方。
> 矩阵判定：**partial**（可达但非 canonical），证据锚定 `lib/compat-rpc.mjs`。
> 单测：`tests/unit/compat-rpc.test.mjs`。

| 线名 | 路由 | 对应 canonical/实现 | 语义 |
| --- | --- | --- | --- |
| `cancel` | daemon-local | `command.cancel` | 通用取消 `{ rpc_id }`：复用 daemon in-flight 表 + 扩展 WS cancel；无 in-flight 回 `cancelled:false`。 |
| `ledger.request` | daemon-local | `ledger.resolve` | 账本通用入口 `{ action: status\|resolve }`：复用 IntentLedger 与 ledger-report。 |
| `system.ping` | daemon-local | — | 健康检查：`{ ok, pong, protocol, version, ts }`，不触达扩展。 |
| `system.handshake` | daemon-local | — | 握手兼容：`{ ok, protocol, version }`。 |

## 约束

- 新增兼容线名必须同时在 `daemon/local-dispatch.js` 有真实实现，并更新本表与矩阵映射；
- 不允许把兼容线名偷偷加入 canonical 方法目录；
- 兼容方法错误口径沿用现有 `BridgeError` 码（`E_BAD_ARG` 等）。
