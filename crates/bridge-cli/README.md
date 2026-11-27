# bridge-cli（Rust 架构路线：协议编解码 + 会话状态机 + 真实 daemon 客户端）

对应参考实现中的 `crates/bsk-cli`。当前是 **M-D 第四批**：在 std-only 前提下补齐
**TLS 明确拒绝策略**与**真实会话命令**（`session start|stop|list`、只读 `observe`），
所有命令都接线到**真实 Node daemon**（`daemon/server.mjs`），没有"未接线"占位输出。

## 已实现

| 模块 | 文件 | 内容 |
| --- | --- | --- |
| JSON 编解码 | `src/json.rs` | RFC 8259 解析/紧凑序列化、保留键顺序、`\uXXXX` 代理对、深度上限、数字按 JS 习惯输出 |
| RPC 信封 | `src/envelope.rs` | HTTP `/rpc` 请求/响应、WS `cmd`/`res`/`event`、错误对象（未知码归一 `E_INTERNAL`）、`session/sessionId/tabId` 作用域、HTTP 401/404 映射 |
| WS 帧分发 | `src/wire.rs` | `hello`/`hello-ack`/`hello-error`/`cmd`/`res`/`event`/`ping`/`pong`/`auth-commit`/`commit-ack` 统一编解码 |
| 错误码 | `src/errors.rs` + `src/generated/error_codes.rs` | **158 码 + 48 条恢复建议**，由脚本从 `lib/error-codes.mjs` 生成（不是手写清单） |
| 会话状态机 | `src/session.rs` | 8 状态迁移表、幂等同状态、非法迁移 `E_SESSION_TRANSITION`（data 带 allowed/history）、可注入时钟 |
| hello 握手 | `src/handshake.rs` | 客户端 hello / 服务端 hello-ack / hello-error 编解码（对齐 `normalizeHello`）、1.8/1.9/2.0 协商、9 个 feature floor 与 preflight 门 |
| 协议视图 | `src/protocol.rs` | 165 方法目录、兼容矩阵、握手示例、人类可读/JSON 输出 |
| **daemon 发现** | **`src/discovery.rs`** | `BB_HOME` → `%USERPROFILE%\.browser-bridge\daemon.json`；校验 port/token/pid/version/startedAt/tls；缺失 `E_NO_DAEMON`、坏内容 `E_CONFIG_INVALID`（带路径/字段/JSON 偏移）；**token 永不输出**（只给 `tokenPresent`/`tokenLength`） |
| **HTTP/1.1 客户端** | **`src/http.rs`** | std `TcpStream` 手写请求/响应；`Content-Length` 严格读取、连接关闭时读至 EOF、**chunked 明确拒绝**（`E_UNSUPPORTED_CAPABILITY` 并说明）；连接/读写超时 → `E_NO_DAEMON`/`E_DAEMON_TIMEOUT`；状态码 → 单源错误码映射 |
| **WebSocket 客户端** | **`src/ws.rs`**、**`src/sha1.rs`**、**`src/base64.rs`** | 手写 RFC 6455 握手（`Sec-WebSocket-Key`/`Accept` 校验）、文本/二进制帧、分片重组、ping/pong、close 帧、客户端强制掩码；默认升级地址 `/ws?role=extension`（daemon 只接受该 role）；SHA-1/base64 自实现且带 RFC 向量 |
| **daemon 客户端** | **`src/rpc_client.rs`** | `GET /health`（无需 token）+ `POST /rpc`（`x-bridge-token`）；业务错误透传 daemon 错误码；**错误映射完善**：401 → token 过期下一步、404 → 版本/方法目录下一步、`E_NO_SESSION` → 先 list/start、`E_QUEUE_FULL` → 看 inflight 后重试，并附单源 `recovery`；`tls:true` 时明确拒绝（见下节） |
| **真实 status** | **`src/status.rs`** | 发现 + `/health` + `/rpc status` 归一（browsers/sessions/inflight/queues/auth/compatibility/recovery）、协议 1.9 对齐、`--json` 稳定 schema、文本摘要；失败输出结构化错误 + 退出码 3 |
| **TLS 策略** | **`src/tls_policy.rs`** | `daemon.json` 的 `tls:true` 在**任何网络请求之前**拒绝：`E_UNSUPPORTED_CAPABILITY` + 端点/发现文件/能力位快照 + **可执行替代命令清单**；README 本节与之互为门禁（单测用 `include_str!` 校验） |
| **命令上下文** | **`src/command_io.rs`** | 发现 → TLS 守卫 → `/rpc` → 错误富化（端点/发现文件，不含 token）；`--timeout` 归一（1..=600000，缺省 60s） |
| **时长解析** | **`src/duration.rs`** | `500ms`/`20s`/`2m`/`1h`/`30d`/纯毫秒/小数，与 Node `parseDurationMs` 同口径；`E_ARG_TYPE`/`E_ARG_ENUM`/`E_ARG_RANGE` |
| **会话命令** | **`src/session_cmd.rs`** | `session start`（focus/incognito/browser/tab/share/scope/allowDomains/denyDomains/minIntervalMs/controlMode/controller/requestId）→ `session.start`；`session stop <id> [--keep]` → `session.stop`；`session list` → `session.list`；参数校验 + 稳定 JSON 信封 + 退出码 0/2/3 |
| **只读观察** | **`src/observe_cmd.rs`** | `observe`（session/tabId/maxTokens/maxDepth/VOM/AX/facts/cursor/delta…）；**运行时只读门禁**用单源方法目录确认 `observe` 的 effect 是 `passive_read`，目录漂移或方法名错误直接 `E_READ_ONLY` 拒绝 |
| 命令解析 | `src/cli.rs` | `version` / `protocol …` / `status` / `health` / `ws-hello` / `session start\|stop\|list` / `observe` / `help`；`--flag=value` 与 `--flag value` 两种写法 |

单测与进程级冒烟的条数以 `cargo test` 实际输出为准（见下节）；覆盖编码/报文/帧/掩码/握手/发现/
会话命令/只读观察/TLS 策略/错误映射/输出渲染/错误路径。真实 daemon 冒烟用
`node cli/bridge.mjs status` 触发 daemon 后验证 `/health`、`/rpc status`、WS hello/hello-ack、
`session start/list/stop` 与 `observe` 的真实二进制行为；环境不可用时打印
`SKIP daemon smoke：…`（含 CLI/daemon 失败诊断）并如实说明。
冒烟默认使用 **隔离 `BB_HOME`**（`target/test-tmp/bb-smoke-home`），不依赖也不污染
`%USERPROFILE%\.browser-bridge` 下用户正在运行的真实 daemon，并在测试结束时通过
RPC `daemon.stop` 停掉自己拉起的 daemon（不遗留进程）。

## TLS 策略（不支持 wss）

本 crate 是 **std-only**（`[dependencies]` 为空），没有 TLS 客户端实现。所以当
`daemon.json` 声明 `tls:true` 时，bridge-rs 的行为是**明确拒绝**，绝不静默降级明文，
也不假装握手成功：

```
错误 E_UNSUPPORTED_CAPABILITY：daemon.json 声明 tls:true（127.0.0.1:<port>），
但 bridge-rs 是 std-only 构建、没有 TLS 客户端：不会以明文连接，也不会假装支持 wss。
可执行替代：① 用 Node CLI 连接该 daemon（node cli/bridge.mjs status）；
② 去掉 --tls-pfx 以非 TLS 方式重启 daemon。
```

`--json` 模式的 `error.data` 固定包含：

- `tls:true`、`endpoint`、`discoveryFile`、`home`；
- `capabilities: {tlsClient:false, wss:false, plaintextFallback:"refused"}`；
- `replacements`：**可直接粘贴运行**的替代命令（与 `src/tls_policy.rs` 的 `REPLACEMENTS` 单一来源，
  本 README 与它有 `include_str!` 单测互相门禁）：

```powershell
node cli/bridge.mjs status --json          # 用 Node CLI（有 TLS 支持）读状态
node cli/bridge.mjs session list           # 用 Node CLI 列会话
bridge daemon stop && bridge daemon start  # 去掉 --tls-pfx，以明文端点重启后 bridge-rs 可直连
bridge-rs help                             # 查看 bridge-rs 当前真实支持的命令
```

策略要点：**不假装支持**、不尝试明文连接 TLS 端口、不把 token 发给非预期端点；
TLS 能力的唯一可信来源是 `crates/bridge-cli/README.md` 本节与源码（`TLS_CLIENT_SUPPORTED=false`）。

## 生成物（禁止手改）

```powershell
$env:PATH = 'D:\tools\node;' + $env:PATH
node crates/bridge-cli/scripts/gen-error-codes.mjs          # 重新生成
node crates/bridge-cli/scripts/gen-error-codes.mjs --check  # 漂移门禁（漂移 exit 1）
```

单源（只读）：`lib/error-codes.mjs`（158 码 + 恢复建议）、`lib/method-catalog.mjs`
（165 方法 / 9 feature floor / 协议 1.8→1.9 基线）、根 `package.json`（产品版本）。

## 工具链

本机已装 Rust 1.100（rustup；实际只装 `stable-x86_64-pc-windows-gnu` 工具链，
rustup host 仍是 msvc 但**没有 MSVC 工具链、也没有 MinGW**）。为在当前机器上可编译、可测试，使用 Rust 自带的
`rust-lld` 链接 GNU 目标（需要 `RUSTC_BOOTSTRAP=1` 允许 unstable flag）：

```powershell
$env:PATH = 'C:\Users\CFT\.cargo\bin;' + $env:PATH
$env:RUSTC_BOOTSTRAP = '1'
$env:RUSTFLAGS = '-Z unstable-options -C linker=rust-lld -C linker-flavor=gnu-lld'
cd crates/bridge-cli
cargo +stable-x86_64-pc-windows-gnu test
cargo +stable-x86_64-pc-windows-gnu check --all-targets
cargo +stable-x86_64-pc-windows-gnu build
.\target\debug\bridge-rs.exe status --json
.\target\debug\bridge-rs.exe ws-hello --json
```

> 正式发布形态仍需要 MSVC Build Tools 或 MinGW（写入 `docs/ARCH-TRACK.md` 的 M-D 验收）。
> `RUSTC_BOOTSTRAP` 只用于本机开发/CI 兜底，不得进入正式发布脚本。

## 命令

| 命令 | 行为 | 退出码 |
| --- | --- | --- |
| `bridge-rs version` | crate / 产品 / 协议版本 | 0 |
| `bridge-rs protocol [--json]` | 协议摘要（165 方法 / 158 错误码 / 9 floors / 兼容矩阵 / 8 状态） | 0 |
| `bridge-rs protocol codes [--json]` | 158 错误码 + 恢复建议 | 0 |
| `bridge-rs protocol features [--json]` | 9 个 feature floor + 1.8/1.9/2.0 可用性 | 0 |
| `bridge-rs protocol handshake [--json]` | hello / hello-ack 示例 + 版本协商 | 0 |
| `bridge-rs status [--json]` | **真实** daemon 摘要：发现 + `/health` + `POST /rpc status` | 0 / 3 |
| `bridge-rs health [--json]` | 只探测 `GET /health`（无需 token） | 0 / 3 |
| `bridge-rs ws-hello [--json]` | WebSocket 握手 + hello/hello-ack 真实探测 | 0 / 3 |
| `bridge-rs session start [--json]` | 新建/共享/借用标签页会话（`POST /rpc session.start`） | 0 / 2 / 3 |
| `bridge-rs session stop <id> [--keep] [--json]` | 停止会话（`POST /rpc session.stop`） | 0 / 2 / 3 |
| `bridge-rs session list [--json]` | 列出活动会话（`POST /rpc session.list`） | 0 / 2 / 3 |
| `bridge-rs observe [--json]` | **只读**观察当前页面（`POST /rpc observe`） | 0 / 2 / 3 |
| `bridge-rs help` | 帮助 | 0 |
| 参数/命令错误 | `E_BAD_SUBCOMMAND` / `E_UNKNOWN_FLAG` / `E_ARG_*` | 2 |

`session start` 选项：`--focus --incognito --browser <b> --tab <n> --share`、
`--scope <s> --allow-domains <d> --deny-domains <d> --min-interval <ms>`、
`--control open|exclusive --agent-name <n> --project <p> --controller-color <#rrggbb> --request-id <id>`。
`--share` 必须同时给 `--tab`（`E_ARG_REQUIRES`）；`--min-interval` 超过 5000ms 按 daemon 语义钳到 5000。
`observe` 选项：`--session --tab-id --max-tokens --max-depth --probe-hover --closed-shadow --debug-surfaces
--vom --vom-deep --vom-tree --vom-rank --vom-top --vom-max-nodes --vom-max-tokens --vom-explain
--vom-exclude-hidden --vom-profile --ax --facts --force --cursor --delta [--baseline]`；
它只发 `observe` 一个方法，接受任何动作类参数都会被当成未知选项（`E_UNKNOWN_FLAG`）拒绝。

`--timeout <ms>` 覆盖 RPC/WS 超时（1..=600000，默认 60000 与 daemon `DEFAULT_TIMEOUT_MS` 一致）。

## 测试与冒烟

```powershell
cargo test                                        # 单测 + 进程级冒烟（真实 daemon）
cargo test --test daemon_smoke -- --nocapture     # 看真实 daemon 摘要/hello-ack/会话证据
```

冒烟逻辑（`tests/daemon_smoke.rs`）：

1. 先探测已运行 daemon（隔离 `BB_HOME` 下的 `daemon.json` + `/health`）；不可达则执行
   `node cli/bridge.mjs status --json`（CLI 自带 `ensureDaemon` 自动拉起 + 原子写 `daemon.json`），
   仍失败再直接 `node daemon/server.mjs --foreground --port <free>` 兜底并带回 stderr 诊断；
2. Rust 侧 `DaemonHome::from_env()` → `GET /health` → `POST /rpc status` → WS
   `/ws?role=extension` hello/hello-ack，并断言 `instanceId` 8 位 hex、协议 1.9、capabilities 非空；
3. **会话生命周期**：起一个协议级"扩展桩"（真实 WS hello + 对 daemon 下发的
   `window.newAgent`/`observe`/`tab.close` 等 cmd 回 `res`），然后运行真实二进制
   `session start --json` → `session list --json` → `observe --json` → `session stop --json`
   → `session list --json`，断言会话确实由 daemon 创建、出现在 list、观察结果可渲染、停止后消失。
   桩只替代**浏览器扩展**这一侧（无真实浏览器可用的无头环境），daemon、HTTP `/rpc`、
   WS、会话状态机与 CLI 全是真实链路；报告与输出里明确标注"扩展桩"，不冒充真实浏览器观察；
4. 真实二进制 `status --json` / `health --json` / `ws-hello --json` 的退出码与 JSON 形状；
5. 确定性错误路径（不依赖 daemon）：`BB_HOME` 指向空目录时 `session start/list/observe` 退出 3 +
   `E_NO_DAEMON`；`daemon.json` 写 `tls:true` 时退出 3 + `E_UNSUPPORTED_CAPABILITY`（含 replacements）；
   `session start --share` 缺 `--tab` 退出 2 + `E_ARG_REQUIRES`；
6. 结束时只停止自己拉起/隔离 home 的 daemon（外部 daemon 不动）。

环境变量：`BB_NODE` 可指定 node 可执行文件（默认扫 PATH + `D:\tools\node\node.exe`）；
`BB_SMOKE_AUTOSTART=0` 禁止冒烟自动拉起 daemon。

## 已知边界（本批未做）

1. **TLS**：std-only 无 TLS 栈，`tls:true` 明确 `E_UNSUPPORTED_CAPABILITY` 并提供 Node CLI /
   去 `--tls-pfx` 的替代路径（见上节「TLS 策略（不支持 wss）」）；**不假装支持**；
2. **session 子集**：只接线 `start/stop/list`；`rebind/pause/resume/run-log/control*/handoff/stop_all`
   仍用 Node CLI（daemon 侧已实现，Rust 侧未做参数面）；
3. **chunked 响应**：拒绝并说明（daemon 的 `/health`、`/rpc` 都返回 `content-length`）；
4. **连接复用**：一次连接一次请求（固定 `connection: close`），未实现 keep-alive 池化；
5. **WS 扩展**：未实现 permessage-deflate（RSV 位非 0 直接拒绝）、未实现客户端主动分片发送；
6. **随机源**：std-only 无 OS RNG，WS key/掩码用时间 + pid + 计数器 xorshift（非密码学；
   鉴权依赖 HTTP token / daemon 配对层，不依赖 WS key）。
