# 对照 BSK 0.5.0：我们还缺什么（2026-11-19）

对照对象：`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`（源码，只读研究）。
我方：`D:\浏览器桥` 当前工作树（0.3.0，未重新打包）。
方法：读 BSK 的 `CHANGELOG.md` 0.5.0 段、`crates/bsk-protocol/src/method.rs`（77 个 wire 方法）、
`crates/bsk-cli/src/**`，逐项在本仓库 grep/读码确认；不把“命名不同”算成缺口。

## 1. 结论摘要

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 实质缺口 | 0 | G1/G2/G3 均已补齐 |
| 已补强（差异已记录） | 0 | 配对（激活/pending-commit/断点恢复/browser_id）+ doctor 已对齐 |
| 已对齐（不必补） | 18+ | 见第 4 节 |
| 命名/架构差异（非缺口） | 4 | `tool.*` 命名、扩展侧 session start/stop、`system.ping/handshake`、`local_auth.*` |

> 2026-11-19 更新：G1 run log+draft、G2 stop --all、G3 截图流式已补齐；Q1 配对（激活/pending-commit/
> 断点恢复/browser_id 绑定/rotation）与 Q2 doctor 配对+环境检查均已对齐。剩余仅 doctor 的安装级诊断深度，
> 不影响现有能力对齐。

## 2. 实质缺口

### G1. `session.run_log` + recipe 草稿（已补齐 2026-11-19）

- BSK：daemon 内存 run log（≤200 步/8000 refs；Navigate 只留 origin/path，Action 记 target role/name/context，
  不存输入值），用于把一次运行沉淀成 recipe 草稿。
- 我方实现：`lib/run-log.mjs`（`SessionRunLog`，同样的上限/脱敏规则，目标白名单只留
  ref/stableRef/role/name/selector/text）；daemon 在每次扩展派发后记录；`session.run_log` RPC；
  `bridge session run-log <id>`；`lib/recipe-draft.mjs` + `bridge recipe draft --name <n> --session <id>`
  （只映射 navigate/reload/click/hover/focus，fill/press/select 等因缺输入值/参数被跳过并在 `skipped` 说明）。
- 测试：`run-log.test.mjs` 7 条、`recipe-draft.test.mjs` 5 条；E2E `20s9`（真实动作 → run log → draft →
  approve → run，且断言日志不含 fill 值）。

### G2. `session stop --all`（已补齐 2026-11-19）

- BSK：`session.stop_all` + CLI `--all`。
- 我方：`session.stop_all`（逐个 stop，单个失败不影响其它，返回 `stopped/failed`）+ CLI
  `bridge session stop --all`；E2E `36` 收尾用 `--all` 清空会话。

### G3. 大截图的流式读取（已补齐 2026-11-19）

- BSK：`tool.screenshot_full_page` 之后用 `tool.screenshot_read` / `tool.screenshot_release` 分块读、再释放。
- 我方实现：`screenshot --stream`（或 dataUrl > ~1.5MB 自动）时，扩展把 base64 暂存（5 分钟 TTL、最多 4 份），
  返回 `{captureId, streamed:true, bytes}`；CLI 用 `screenshot.read` 按 base64 字符分块（512KB/块）拼回文件，
  完成后 `screenshot.release`。单次 RPC 不再携带数 MB dataUrl。
- 测试：`capture-stream.test.mjs` 6 条（分块拼回/TTL/淘汰/越界/release）；E2E `31h`（tall.html 流式 + PNG 魔数 +
  字节一致 + 默认小图不流式）。

## 3. 需确认/待补强

### Q1. 配对安全模型与“未配对”UX（已对齐 2026-11-19）

已实现/验证（`tests/pairing/selftest.mjs` 33 项）：

- **激活即作废旧链接**：首次握手成功后 daemon 作废配对码并换发独立 `deviceToken`（`hello-ack.deviceToken`），
  扩展持久化到 `daemonToken`；旧 token 重连不再视为已配对（本机可选模式降级 `unpaired`，远程 `E_PAIR_REQUIRED`）；
  旧配对码 `pair redeem` 返回 `E_PAIR_INVALID`。
- **分阶段 commit / 断点恢复**：设备先 `pending`，`hello-ack` 下发 `commitTxn`/`commitProof`；扩展用新 token
  签名 `auth-commit`，daemon 验证后 pending→active 并回 `commit-ack`。未 commit 就断开时，带 pending token
  重连会重新拿到同一 txn 完成激活；10 分钟未 commit 则 token 作废。
- **browser_id 绑定**：token 绑定 hello 的 `browserId`，换浏览器复用返回 `E_PAIR_REJECTED`（远程/本机一致）。
- **双向证明**：daemon 用同一 token 对挑战签名（`serverProof`），扩展校验后才完成 hello。
- **撤销即时清理**：`pair revoke` 断开使用该 token 的连接（`kicked`）并删除设备记录。
- **未配对身份提示 + 必需/可选模式**：popup 十语言警告；`bridge daemon trust-local on|off`。

剩余差异（小）：

- BSK 的 activation check 还会校验 pending/commit 的持久化事务日志细节；我们用 `devices.json` 的
  `status/commitTxn/pendingUntil/rotationToken/rotationTxn` 字段实现等价语义（本机在 `local-trust.json`）。
- `pair renew`（远程设备）与 `daemon rotate`（本机）均已实现 pending rotation + commit/超时回退。

### Q2. `doctor` 深度（已对齐 2026-11-19）

- BSK `doctor.rs` 54KB：环境/安装/配对/连接/日志等系统化诊断与指引。
- 我方 `cmdDoctor` 现已包含：node、BB_HOME、daemon/token、browsers、扩展 UI、配对模式/设备/未配对连接、
  日志路径/大小、BB_HOME 可用空间、daemon.json 与 /health 端口一致性、**repo 与扩展版本一致性（install）**、
  **TLS 证书状态**、**日志尾部可疑错误摘要（log-errors，只读 64KB）**；可 `--json` 断言。
- 剩余：BSK 仍有更多细项（安装目录各组件校验、日志内容分类摘要等），属低优先级记录项。

## 4. 已对齐（同一能力，不同实现/命名）

| 能力 | BSK 0.5.0 | 我方 |
| --- | --- | --- |
| 会话 run log | `daemon/run_log.rs`（≤200 步/8000 refs，不存值） | `lib/run-log.mjs` + `session.run_log`（同样上限/脱敏） |
| run log → recipe 草稿 | 一次运行沉淀 recipe draft | `lib/recipe-draft.mjs` + `recipe draft`（跳过需要输入值的步骤） |
| 批量停止 | `session.stop_all` / `--all` | `session.stop_all` / `session stop --all` |
| zero-ceremony 生命周期 | `bsk open/sync/close` | `bridge open` / `bridge sync` / `bridge close`（别名到 session stop） |
| 预写意图账本 | JSONL WAL + 重启 UNKNOWN + sync reconcile | `lib/intent-ledger.mjs`：原子 `ledger.json`（0600）+ `load()` + `cooperate.sync` reconcile，语义等价 |
| ledger 命令 | `ledger status/resolve` | 同名命令 + `E_LEDGER_PENDING` 拦截盲重放 |
| VOM 字段/选项提示 | `[field: ...]`、`[options: ...]`、`custom-dropdown` | `page-lib` 已实现（`fieldLabel`/`options`/`custom-dropdown`） |
| select 选项标签/歧义错误 | option labels、`option_ambiguous/not_found` | `E_OPTION_AMBIGUOUS`/`E_OPTION_NOT_FOUND` + 候选列表 |
| 虚拟行回收防护 | `rowAnchor` + `virtual_row_recycled` | `page-lib` `assertRowAnchor` + 同码 |
| 注入提示剥离 | opacity/font/contrast/offscreen/clipped 启发式 | `stealthHidden` 同类实现 |
| 空闲软分离 | 75s 空闲 detach + 透明重挂 | `debugger-idle.js` `DEFAULT_DEBUGGER_IDLE_MS=75000` + 长生命周期 feature 保护 |
| 批量动作 | `plan`/MCP `bsk_plan` | `plan`/`step` + DSH 插件 |
| recipe | save/approve/run + 过期/篡改/中断保持 | `recipe save/approve/run`（`E_RECIPE_NOT_APPROVED/EXPIRED/CHANGED`） |
| 只读/未验证 | `bsk read`、`evaluate --unverified` | `read`、`evaluate --unverified`（verified:false） |
| 设备管理 | `daemon pair --replace`、devices/revoke/rotate/trust-local | 同名子命令 + `pair.*` RPC |
| MCP 作用域 | implicit scope/caller_scope | MCP `BB_SESSION`/`BB_SESSION_SCOPE` + `resolveSessionByScope` |
| 安装目标 | Qoder/Qoder CN | `install-skill --harness qoder|qoder-cn` |
| 日志跟随 | `bsk logs -f` | `bridge logs --follow`（同名语义） |
| 10 语言 UI | 十语言指引 | `translation/` + `overlay-locales.js`（ar/de/es/fr/he/it/ja/ko/pt/zh-TW…） |

## 5. 命名/架构差异（非缺口，不建议照搬）

- BSK `tool.*` 命名空间 vs 我方扁平命令：协议方法集合不同但语义覆盖；我方 154 个 canonical 方法（含本地/实例方法）。
- BSK 扩展侧 `tool.session_start/session_stop` vs 我方 daemon 侧 `session.start/stop`：归属不同。
- BSK `system.ping/handshake` vs 我方 WS hello + `/health`：协议传输不同。
- BSK `local_auth.*` vs 我方 `pair.*` + `local.trust`：命名不同。
- 大截图流式（G3）已补齐（`screenshot --stream` + `screenshot.read/release`）。

## 6. 下一轮建议顺序

1. ~~G1 `session.run_log` + `recipe draft`~~ 已补齐。
2. ~~G2 `session stop --all`~~ 已补齐。
3. ~~Q1 配对行为对照~~ 已对齐（激活作废旧链接、pending-commit 断点恢复、browser_id 绑定、pending rotation、
   双向证明、revoke 清理、未配对提示；配对自检 46 项）。
4. ~~G3 大截图流式读~~ 已补齐。
5. ~~Q2 doctor 配对/环境检查~~ 已补强；剩余是安装级诊断深度（低优先级）。
