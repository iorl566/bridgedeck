# BSK 0.5.0 — daemon RPC / process lifecycle / IPC / reconnection / pairing / install

Source studied: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/**` and `crates/bsk-protocol/src/**`.
All BSK paths below are relative to that root; no BSK file was modified.

## Core model

Two transports, one frame model. CLI↔daemon is newline-delimited JSON over a Unix UDS
(`$BSK_HOME/run/daemon.sock`) or a Windows pipe `\\.\pipe\bsk-daemon-<16hex>` hashed from
(USERNAME, BSK_HOME) (`daemon/paths.rs:158-186`); daemon↔extension is WebSocket. Both use
`Frame::{Request,Response,Event}` with a string `RpcId` (`bsk-protocol/src/frame.rs:13-108`) and
`RpcError{code,message,data}` where `code` is a closed enum and `data.reason` is a separately
versioned union (`error.rs:17-189`). Methods are declared once in a macro table that forces owner,
effect class, action-metadata flag and feature requirements (`method.rs:33-181`); `MethodEffect`
(PassiveRead/TransientInput/BrowserMutation/ControlPlane) is the single input to interrupt gating,
mutation detection and WAL gating.

State is in-memory only (`daemon/state.rs:27-70`): BrowserRegistry (instance_id→client + monotonic
`generation`), SessionRegistry (+reservations, `starting` set, capped end tombstones),
ToolQueueRegistry (per-session mpsc(64)+worker+`busy`/`accepting`), AbortRegistry (rpc_id→token),
ToolInflightRegistry (Queued/Forwarded + cancel reason), DialogOperations, SessionInterrupt,
TransferRegistry, IntentWal, ScopeRegistry, AuditStore. Restart ⇒ all sessions gone.

Lifecycle anchored on a kernel advisory lock *and* a published discovery file:
lock → bind IPC → bind WS → write `daemon.json` last → serve → remove json + socket
(`daemon/start.rs:460-496, 571-616, 787-788`). Discovery is availability-by-proof, not by file.

## 5 invariants

1. **One daemon per home.** `fs2` advisory lock on `daemon.lock` is the only authority; pid files and
   liveness are advisory, and a losing starter must exit rather than linger (`daemon/lockfile.rs:48-76`,
   `daemon/start.rs:473-495`).
2. **Availability proven, absence narrow.** Only `NotFound|ConnectionRefused` authorize auto-start;
   PermissionDenied/TimedOut/Reset must stay errors (`daemon/probe.rs:141-148`, tests `191-207`).
3. **Identity before signalling.** A pid is only signalled when `daemon.json.pid` equals the
   kernel-reported peer pid of the connected socket (`daemon/probe.rs:42-53`).
4. **Cancel never precedes its request.** Queued→Forwarded *and* the socket send happen under the
   entry's inner mutex, so cancel either prevents dispatch or lands strictly after the request
   (`daemon/inflight.rs:244-278` + `daemon/queue.rs:697-738`).
5. **Side-effect fidelity beats tidy errors.** A cancel arriving after the extension confirmed
   (session_stop, tab_borrow, request_help, committed transfers) returns the confirmed result
   (`daemon/queue.rs:791-902`); unknown effects are marked, never replayed.

## 3 algorithms

**Probe + verify** (`daemon/probe.rs:68-115`): read json → connect → `system.status` in remaining
budget → require `status.pid == info.pid` → re-read json unchanged → on mismatch sleep 25ms, retry
once → typed `DiscoveryRace`. Whole budget (connect+RPC+retry) is one 500ms timeout (`:14, 71-114`).

**Stop** (`daemon/start.rs:299-388`): probe Ready → `require_local_pid` → SIGTERM → poll
`wait_for_stopped` (lock acquired ⇒ re-verify json equals expected instance, then remove only that
record; lock held with changed metadata ⇒ abort to preserve a replacement) 5s → re-probe and require
identical instance → SIGKILL → require lock release.

**Tool dispatch** (`daemon/ipc.rs:813-1102`): session_id check → feature checks vs the *extension's*
protocol → consume one-shot user-interrupt marker for input methods → intent-WAL gate → transport
timeout from `tool_policy` (`tool_policy.rs:27-128`, `ipc.rs:1323-1387`) → register inflight under
the CLI rpc id → begin intent ticket → queue dispatch → finish ticket → normalize transfer results →
shape error (SessionBusy gets `data.reason/session_busy` + `data.wait` hint).

## 5 edge cases

- **Two-phase start race:** endpoint bound before metadata published; the single 25ms re-read + pid
  conjunction prevents adopting a replaced daemon (`daemon/probe.rs:76-107`).
- **Launcher timeout is not kill authority:** on readiness timeout the child is disowned/reaped, never
  killed — it may already be reused by another client (`daemon/start.rs:242-289`, tests `1708-1794`).
- **Windows pipe handoff:** the next instance must exist before the connected one is handed to a task,
  or a fast handler closing the last instance makes new clients fail NotFound; `ERROR_PIPE_BUSY` is
  retried for a 5s budget, ACCESS_DENIED gets a sandbox hint (`daemon/ipc.rs:2483-2518`,
  `ipc_client.rs:211-264`).
- **Reconnect during teardown:** generation equality means the old socket removes nothing and the new
  registration's sessions survive (`daemon/ws.rs:489-506`, `daemon/browsers.rs:475-485`).
- **Dialog deadline:** exactly one +60s extension per RPC, never resettable by repeated dialog changes
  (`daemon/queue.rs:1234-1261`).

## Tests

Unit tests sit beside each contract: probe admission rules, `pid_alive` for an exited-but-handled
process (`lockfile.rs:132-165`), atomic json writes `info.rs:177-241`, pipe-name charset
`paths.rs:246-263`, timeout algebra `ipc.rs:2701-2954`, cancel-wins tie `queue.rs:1406-1470`.
Integration: 48 files under `crates/bsk-cli/tests/` running the real binary with isolated
`BSK_HOME`. Techniques worth copying: scripted mock daemon over a real socket
(`tests/daemon_discovery.rs:48-171`), gated self-subprocess for lifecycle interleavings
(`start.rs:1633-1706`), thread-local replace-failure hook inside the write primitive
(`skill_install/storage.rs:90-133`), `#[doc(hidden)]` time/order hooks
(`browsers.rs:302-310`, `inflight.rs:47-79`), and the data-driven eval corpus whose rule is
"missing evidence = unverified, never passed" (`evals/browser/README.md`).

## 5 adopt

1. Advisory lifecycle lock as the only single-instance authority (BSK `lockfile.rs`); BridgeDeck
   currently infers it from port occupancy (`daemon/server.mjs:88-89, 2744-2770`).
2. Probe/verify discipline: pid+protocol agreement, one publication-race retry, only
   refused/absent authorizes startup (`probe.rs:68-148`). BridgeDeck's `findRunningDaemon`
   (`daemon/server.mjs:2731-2742`) accepts any `/health`.
3. Stop revalidation + escalation (`start.rs:299-388`); BridgeDeck `runStop`
   (`daemon/server.mjs:2983-3008`) deletes `daemon.json` when health is inconclusive and never escalates.
4. Four-field execution policy per method (`tool_policy.rs:27-128`) instead of scattered timeout constants.
5. Crash-consistent skill install: pending two-sided marker, resources before `SKILL.md`, conflict
   preflight, up-to-date no-op (`skill_install/transaction.rs:14-65`, `conflicts.rs`, `sync.rs:103-206`).

## 3 reject

1. Daemon self-update with in-process handover (`start.rs:977-1320`, `start/handover.rs`) — ~700 lines,
   update lock, rollback, failure side-channel; install + supervised restart is cheaper and safer.
2. Serial one-request-per-connection IPC as the only shape (`ipc.rs:2360-2406`) — a long tool call
   blocks every other frame; use separate connections for cancel/progress rather than multiplexing.
3. Computing kernel-object names from user data (issue #75, `paths.rs:148-186`); hash/UUID only.

## 5 gaps (BridgeDeck)

1. **No lock** anywhere (`daemon.lock` grep empty) ⇒ a foreign listener on 52900 pushes the daemon to
   52901 and `daemon.json` becomes last-writer-wins.
2. **Unverified discovery**: no `health.pid == daemon.json.pid`, no protocol check, no publish-race retry.
3. **Stop can split-brain**: inconclusive `/health` ⇒ delete metadata while the daemon keeps serving.
4. **No cancel/dispatch ordering and no terminal-socket settle**: `cancelInflight`
   (`daemon/server.mjs:1582-1592`) and `dropInstance`/`settleResponse` (`:786-830`) cannot distinguish
   "never sent" from "ran but caller saw cancelled", and reconnects leave waiters to their own timeouts.
5. **Skill install durability unspecified**: no `.bb-source` per-file hashes, pending marker, conflict
   preflight or background sync — the bulk of BSK `skill_install/*`.
