# 环境与连接

## 自检

```sh
bridge doctor
bridge status --json
bridge browsers --json
bridge daemon status
```

- `doctor` 逐项查 node、`BB_HOME` 可写、`daemon.json`、daemon `/health`、token、已连接浏览器、扩展 UI 能否加载；有 `fail` 按提示处理，别先删文件。
- `status --json` 给 service/version/protocol/pid/port/uptime + browsers + sessions；`browsers --json` 每个实例带 instanceId、label、浏览器/扩展版本、protocol 与 capabilities。
- 先读错误码：`E_AUTH`（token 对不上）、`E_DAEMON`（连不上或未就绪）、`E_NO_BROWSER`、`E_PROTOCOL_UNSUPPORTED`。

## 目录与端口

- 运行目录 `BB_HOME`，默认 `%USERPROFILE%\.browser-bridge`：`daemon.json`（pid/port/token/tls）、`daemon.log`、`sessions.json`、`audit/`、`recipes/`。
- daemon 默认监听 `127.0.0.1:52900`；被占用时在 52900–52909 里挑。`BB_PORT` 指定首选端口，`--port` 只影响本次自动拉起。
- `BB_NO_PROBE=1` 关掉“猜孤儿端口”的探测（多 daemon 并存时用）。
- `BB_AUTO_START=0` 禁止 CLI 自动拉起 daemon：没有 daemon 时直接报 `E_DAEMON`，适合沙箱/主机托管 daemon；先 `bridge daemon start` 再复用。
- CLI 发现没有 daemon 会 detached 自动拉起，最多等 10s；拉不起来回 `E_DAEMON` 并给出日志路径。

## daemon

```sh
bridge daemon start|stop|status|log
bridge logs --tail 50
```

- `start` 幂等；`stop` 走内部 RPC 并清理 `daemon.json`；`log` / `logs --tail N` 看最近日志。
- 不要为了单个任务重启共享 daemon，也不要删除 `daemon.json`、`sessions.json` 等运行文件来“恢复”。
- 先 `session stop` 再停 daemon。daemon 重启后旧 sessionId 可继续用（要求原 tab 还在），否则下一次命令报 `E_NO_TAB`，重新 `session start`。
- 远程/容器环境用 `--host`/`--port` 或配对 token。

## 远程与配对

```sh
bridge daemon pair                       # 生成 5 分钟有效的本机配对链接
bridge daemon trust-local off            # 拒绝本机未配对连接（严格模式）
bridge pair create [--ttl 10m] [--label 名称] [--host <ip>]
bridge pair list
bridge pair redeem <code>
bridge pair revoke <code>
```

- daemon 默认只监听回环；远程场景设 `BB_BIND=0.0.0.0`（或具体网卡地址），并在扩展设置里填 daemon URL 与 token。
- 非回环连接必须带配对 token，否则 `E_PAIR_REQUIRED`；`pair revoke` 会立即断开使用该 token 的实例。
- 扩展设置：`bridge settings set --daemon-url ws://host:52900/ws --daemon-token <token>`，写入后立即重连。
- 不要把配对链接/token 写进日志、截图或共享报告；`daemon devices` 可看已配对设备。

## TLS / MCP

- `BB_TLS=1` 启动 daemon：HTTP/WS 变 HTTPS/WSS，同端口；Windows 自签证书写到 `$BB_HOME/tls/cert.pfx`，macOS/Linux 用 `openssl` 生成 `key.pem`/`cert.pem`。浏览器需信任该证书，或在 daemon 前放一层带正式证书的反向代理。
- `bridge mcp` 以 stdio 启动 MCP server（等价 `node mcp/server.mjs`），供外部客户端接入；它和 CLI 共用 `daemon.json` 的 token。
