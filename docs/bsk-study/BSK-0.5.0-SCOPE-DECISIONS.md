# BSK 0.5.0 partial-method scope decisions

> Decision record for the `tool.*` handlers that were partial at the start of
> the round and the control-plane methods that are not real yet. Companion to
> [BSK-0.5.0-COVERAGE.md](BSK-0.5.0-COVERAGE.md) (authoritative counts, generated)
> and [BSK-0.5.0-METHODS.md](BSK-0.5.0-METHODS.md) (wire table).
> Target: `0.4/`. `0.3.0` and `0.3.0/dist/packages/CLI` are frozen and out of scope.
> Reference source: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`.

## 0. The only question this page answers

For each method: **does a real runtime channel exist to deliver the BSK
semantics, and is the delivered effect visible to a user?** If yes and the
channel already exists, decide NOW. If the channel exists but the effect is not
required by any current user flow, decide LATER with a named trigger. If no
channel exists, decide OUT OF SCOPE and make the method refuse honestly instead
of returning pleasing metadata.

## 1. The usable line (policy)

A **production line counts as usable** only when both hold:

1. it is reached by a runtime handler on a live ingress (daemon RPC, adapter
   dispatch, CLI), **and**
2. it is either (a) proven by a real E2E that exercises the user-visible effect
   (real browser/CDP/WS/file, not a fake), or (b) required production support
   without which that E2E path fails (error mapping, capability check,
   redaction, transport, cleanup).

Everything else is **not usable line count**:

- schema-only files, descriptors, codecs, `methods-bsk.js`-style tables;
- constants, typed-unsupported maps, `E_NOT_IMPLEMENTED` stubs, dead exports;
- a handler that returns success while the effect did not happen — that is
  **negative** coverage and must be converted to a typed refusal;
- tests. Tests are reported separately and never added to production lines;
- wiring/knobs only reachable from a test double (a fake `cdp` in unit tests).

Enforcement: every "IMPLEMENT NOW" item below must add or extend
`0.4/scripts/stage-gate.mjs` (the real remote check) or a real daemon E2E under
`0.4/tests/`; unit tests with a mocked `cdp` do not satisfy the line.

## 2. Decision table

`NOW` = this round if not already running. `LATER` = not this round, trigger
named. `OOS` = out of scope for 0.5.0; must refuse typed and be declassified.
`THIS ROUND` = a parallel agent is implementing it; criteria in section 4.
`已落地（按本轮范围）` = implemented and tested in the named round, but only within
the stated scope/boundaries (a landed carrier does not automatically make the
method usable — see the coverage dashboard's classification).

| # | method | decision | channel reality (1 line) | prod LOC est |
| --: | --- | --- | --- | ---: |
| 1 | `tool.request_help` | **已落地（2026-11-23 round 2）** | real in-page shadow-DOM overlay (`overlay-render.js`, `help-handlers.js`), trusted human decision path | 380-460 |
| 2 | `tool.cooperate` | **已实现 full（caveated-full；2026-11-24 round 36 收口 CLI 门；round 37 归因改为原生派发时间戳精确匹配）** | real CDP carrier: overlay + authority/epoch + sync context/observation + `wait` `isTrusted` window; **adapter actionGate** gates click/hover/select/fill/press/drag before any CDP call; strict contexts are bound to a per-document `document_token` (re-read before every strict action/wait, mismatch -> `E_CONTEXT_STALE` no-effect); the daemon/CLI plane (`cooperate.enable/sync/status/wait`, `--session-cooperate-*`) relays the same state and consumes extension `human.input` into a real human/paused state machine with 2 s auto hand-back (headed-Edge E2E **129/129**); round 37 makes attribution an **exact native-dispatch-timestamp match** (`ext.arm_input.timestamp` -> CDP `Input.*` timestamp -> `|event.timeStamp - armed_at| <= 1.5 ms`; `fill` stays window-mode because `Input.insertText` has no timestamp) and lands browser-side lifecycle facts (`tabs.onMoved`/`onRemoved` + `windows.onRemoved` -> `session.ended`), proven by the ingress E2E **128/128**; one-shot CLI input paths are gated by the explicit `--cooperate-gate` flag (13/13, refusal dispatches zero `Input.*`, no-flag output byte-compatible). Full only under written **scope conditions**: human attribution needs the opt-in MV3 content script, one-shot CLI gating needs the per-invocation flag, and without the extension the human/paused gate is not armed; plane state is per-process/in-memory (documented boundary). Round 39 (A3b) closes the browser-side lifecycle fact end to end (the same opt-in extension reports `session.ended` and the daemon ends the session / releases the Agent Window / returns borrowed tabs), and the borrow plane it shares now has a real confirmation UI and borrow-fidelity restore (A3a); those are session/tab evidence (`[3c]`/`[3f]`), not new cooperate semantics, and the cooperate scope conditions are unchanged | 300-450 |
| 3 | `tool.session_start` | **已实现（opt-in extension ingress，2026-11-24 round 34；round 39 A3b 补 observed/路由）** | real Agent Window: injected extension client -> `chrome.windows.create` (width/height 100..7680, `interaction` reported); without the extension client the typed `E_UNSUPPORTED` refusal is preserved; round 39 (A3b) adds observed-tab ownership + window routing: a tab a page opens inside the Agent Window is routed back to a user window and never becomes the default target (`pendingRoutingTabs` never a default target), and the session home tab is tracked as `agent_created`; evidence browser-daemon 69/69 + headed-Edge E2E 128/128 (round 37 adds the 3 lifecycle scenarios) | 5-15 (refuse) -> landed in `session-handlers.js` + `0.4/extension-ingress/` |
| 4 | `tool.session_stop` | **已实现（opt-in extension ingress，2026-11-24 round 34；round 39 A3b 固定 stop 顺序）** | returns every borrowed tab and releases the Agent Window (`window_released` / `returned_tab_ids` / `return_failures`); round 39 (A3b) makes the order explicit and testable: return borrowed tabs (a still-borrowed failure aborts the rest) -> clear refs -> close `agent_created` tabs incl. home -> remove the window only when no user/observed tab remains (otherwise `window_released:false` + `preserved_tab_ids`); observed/borrowed tabs are never closed; browser-daemon also returns borrowed tabs on close; no-extension default stays typed `E_UNSUPPORTED`; evidence browser-daemon 69/69 | 5-15 (refuse) -> landed |
| 5 | `tool.tab_borrow` | **已实现（opt-in extension ingress，2026-11-24 round 34；round 39 A3a 真实确认 UI + 借用快照）** | real user tab moved by `chrome.tabs.move`; round 39 (A3a) makes the decision a real user decision — active tab: shadow-DOM confirmation banner injected via `chrome.scripting`; inactive tab: `chrome.notifications` fallback; closing the notification / 60 s timeout = deny; fail-closed `E_BORROW_CONFIRM_UNAVAILABLE` (restricted page/missing channel), deny -> `E_BORROW_DENIED`, timeout -> `E_BORROW_TIMEOUT`, and the tab is not moved; pre-move snapshot records original window/index, neighbor tab ids, `group{id,title,color,collapsed}`, pinned + pinned-prefix count, and a failed move rolls back; smoke 339/339; no-extension default stays typed `E_UNSUPPORTED` | 5-15 (refuse) -> landed in `borrow-handlers.js` |
| 6 | `tool.tab_return` | **已实现（opt-in extension ingress，2026-11-24 round 34；round 39 A3a 归还保真）** | moves the borrowed tab back to its original window/index; round 39 (A3a): pinned returns only into the pinned prefix (normal tabs never enter it), the position is anchored on the recorded neighbor tab ids then clamped, the original tab group is re-joined or rebuilt with its title/color/collapsed (a user-changed group is respected, a pinned tab reports `group_skipped`), a vanished original window falls back to a normal non-incognito window/new window with `fallback:true`, and a missing snapshot degrades honestly (`snapshot_degraded`); smoke 339/339; no-extension default stays typed `E_UNSUPPORTED` | 5-15 (refuse) -> landed |
| 7 | `tool.debug` | **已落地 full（2026-11-24 round 29，24/24 DebugActions；round 39 A4b 关闭关联/replay 边界）** | all 24 BSK DebugActions delegate through a session-bound client the daemon injects (`createDebugHandlers({ debug })`) and the one-shot CLI `--debug <action>`: capabilities/start/stop/status/export/requests/request/console/pages/activity/pin/unpin/wait/operations/operation (rounds 7/24/25) plus the Fetch request rules rules/rule_add/rule_enable/rule_disable/rule_remove, replay (idempotent key, 15 s/256 KiB, 20/run), performance (CDP Performance.getMetrics), aggregate and duplicates (round 29); round 39 (A4b) closes the two previously written gaps — a daemon-fed operation is correlated with the captured evidence into bounded `request_ids`/`console_ids` (window join; a miss stays empty/never invented) and `replay` **defaults to the browser source** (in-page `fetch` through CDP `Runtime.evaluate`, page-originated; CORS/cross-origin failure is the browser error) with Node `fetch` kept as the explicit fallback:true source; remaining boundaries: performance only reads the CDP metrics domain, rules mutable only while recording, one-shot CLI runs have no action feed, unbound handler stays capabilities-only | ~1,486 prod + ~1,049 test (daemon plane, round 5) + ~470 prod (debug-handlers delegation) + ~120 prod (round-24 pin/unpin/wait) + round-25 operations feed + round-29 rules/replay/performance/analysis + round-39 correlation/browser replay |
| 8 | `tool.video` | **已落地 full（2026-11-24 round 33：adapter 默认 MP4；round 39 A4a：daemon 默认 MP4 + 固定 tab 身份 + owner:'daemon'）** | adapter default is H.264/fMP4: a BSK-parameter `start` (no `format` field) draws the CDP screencast JPEG frames in-page and encodes fragmented MP4 through `MediaRecorder`, `mp4-verify` gates `playable`, `capabilities` reports `format:"mp4"`/`default_format:"mp4"`, an unsupported page fails typed `E_UNSUPPORTED` with no AVI fallback, and explicit `format:"avi"` keeps the local MJPEG AVI path; rounds 31-32 (2026-11-24) added a real **daemon-side persistent catalog** (`0.4/daemon/video-catalog.mjs`, 24h/1GiB/256MiB, record+sweep after `stop`) wired end to end (`session-video` → daemon → `video.list/save/discard` over HTTP/WS and CLI, typed `E_NOT_CONFIGURED` when off); round 39 (A4a) makes the daemon-native `session-video` default MP4 too and pins every recording to the session target's `tab_id`/`window_id` (null when unreadable, never invented) with `owner:"daemon"` on the start/status/stop views and the catalog entry (legacy indexes normalize to daemon + null identity; `owner:"extension"` remains reserved); the remaining written boundary is a browser/extension-owned catalog with fixed-tab authorization. Decision history and boundaries are in §3.4 | 450-750 was the estimate; actual +1,052 prod (`mp4-recorder.js` 585 + `mp4-verify.js` 467) + `video-catalog.mjs` + default-MP4 wiring |
| 9-13 | `local_auth.*` (pair, devices, revoke, rotate, set_mode) | **已实现（2026-11-24 round 27）；风险已缓解（round 28）** | real local device trust store (`0.4/daemon/local-auth.mjs`) + daemon/transport/WS/CLI wiring; control plane 19 -> 24/24 real; round 28 makes the credential-free `pair` loopback-only (`transport.mjs` `publicMethodAccess`: a non-loopback pair request is 403 + `E_LOCAL_ONLY`; the WS transport has no pair route), so the "0.0.0.0 can be paired" risk is mitigated; round 30 records the last rejected unpaired/credential attempt in daemon memory and exposes it through `system.status.local_auth` (at/reason/device_id, never persisted, no secret); remaining risks: default mode `warn`, no extension client consumes the credential, `last_unpaired_attempt` is not persisted across restarts | ~1,000 prod (`local-auth.mjs`) + ~620 test + wiring |
| 14 | `session.request` | **已落地（按本轮范围）** | real managed-start request plane landed (`0.4/daemon/session-requests.mjs`); `start_tracked` depends on it and fails closed without a prepared request | 150-250 |
| 15 | `session.start_tracked` | **已落地（按本轮范围）** | rewired onto the real request plane; same token+params retry returns the same session | 250-400 |
| 16 | `session.run_log` | **已落地（2026-11-23 round 2）** | mapped to the session/record log path (`session-record.mjs`), metadata-only | 300-450 |
| 17 | `audit.request` | **已落地（2026-11-23 round 2）** | mapped to the WAL/audit query path (`daemon-wal.mjs`) | 350-500 |
| 18 | `cancel` | **已落地（2026-11-23 round 2）** | mapped to the in-flight RPC registry (cancel by `rpc_id`) | 200-300 |
| 19-23 | `transfer.begin/chunk/finish/read/release` | **已落地（2026-11-23 round 2）** | mapped to the daemon chunk-transfer store (sha256, atomic rename) | 500-700 |

Not real channels, stated plainly (the prompt's list):

- **cooperate / request_help**: there is no extension UI. The one real human
  surface is the CDP-rendered in-page overlay (`overlay-render.js`), wired into
  `request_help` and into the real `tool.cooperate` carrier landed this round
  (independent shadow-DOM overlay `bridgedeck-cooperate-overlay`, authority/
  generation/epoch, `sync` context/observation, `wait` in-page `isTrusted`
  collector, overlay `take_control`/`dismiss` actions). The gate is not limited to
  cooperate's own page writes: the adapter injects `cooperate.actionGate` into
  the click/hover/select/fill/press/drag factories and the daemon injects it when
  it builds the adapter fallback, so those entries validate the negotiated
  `strict`/`target` context/observation tokens before any CDP call (read/observe/
  screenshot stay ungated). The daemon also relays the plane as
  `cooperate.enable/sync/status/wait` over HTTP/WS and the CLI exposes
  `--session-cooperate-*`. Round 35 (2026-11-24) added the two pieces this
  paragraph used to list as missing: strict contexts are bound to a per-document
  `document_token` (sha256 of `location.href` + nonce, re-read before every
  strict action/wait; mismatch -> typed `E_CONTEXT_STALE`, no dispatch) and the
  daemon consumes relayed extension `human.input` into a real human/paused state
  machine (issued tokens revoked, epoch advanced, 2 s quiet + 3 s agent-idle
  automatic hand-back; actions arm the extension's `InputExpectation` first),
  proven by the opt-in headed-Edge E2E **129/129** (round 37 re-ran it with the
  exact-native-timestamp cases, see §3.2) and the strict doc-token suite
  **33/33**. Round 37 (2026-11-24) then made the attribution **exact** (the arm
  timestamp is the same epoch-ms value passed to CDP `Input.*`; the content
  script requires `|event.timeStamp - armed_at| <= 1.5 ms`, so a 20 ms near-miss
  is human) and landed the browser-side `session.ended` lifecycle facts
  (`tabs.onMoved`/`onRemoved` + `windows.onRemoved`), proven by the ingress E2E
  **128/128**. Round 36 (2026-11-24) closed the last written caveat: the one-shot
  CLI input entries (`--click`/`--fill`/`--press`/`--select`/`--drag`/`--hover`/
  `--focus`/`--wheel`) now honor a real cooperation gate when the invocation
  passes the explicit `--cooperate-gate` flag — `createOneShotCooperateGate`
  enables a target-policy session first, awaits `actionGate` before each action,
  a refusal is a typed error (`E_SESSION_PAUSED` etc., `effectState:none`) with
  **zero** `Input.*` dispatch, `--json` reports `cooperate_gate`, and an
  invocation without the flag stays byte-compatible
  (`0.4/cli/bridge-remote.test.mjs` **13/13**, including a real-Edge click/fill
  smoke). `tool.cooperate` therefore moves from **partial** to **full** in the
  coverage dashboard, but as **caveated-full**: full only under written scope
  conditions — human attribution needs the opt-in MV3 content script (plain CDP
  `isTrusted` cannot tell a CDP-dispatched agent input from a person, and no
  extension-independent native-clock BSK `InputExpectation` is wired; without the
  extension no human signal reaches the daemon, so the human/paused hand-back
  gate is not armed),
  one-shot CLI gating needs the per-invocation `--cooperate-gate` flag (without
  it those paths keep the pre-round ungated behavior), and the state is
  per-process/in-memory (no daemon-shared cross-process plane, never persisted —
  a documented boundary, not a missing-semantics caveat). The dashboard prints
  these conditions in its `[3e]` block.
- **tab borrow / Agent Window**: **implemented 2026-11-24 (round 34) as an
  opt-in extension ingress**, superseding the earlier "no channel" call. The
  channel is no longer CDP: `0.4/extension-ingress/` is a real MV3 extension
  (permissions `tabs`/`windows`/`storage`/`alarms`; no `debugger`) loaded
  headed-Edge-only via `--load-extension`, connected to the daemon over the
  authenticated `/ws` ingress (`extension.register`/`pull`/`complete` long-poll
  queue in `0.4/daemon/extension-ingress.mjs`). The daemon injects the extension
  client into `createSessionHandlers({ extension })` /
  `createBorrowHandlers({ cdp, extension })`, so `chrome.windows.create` /
  `chrome.tabs.move` execute the 4 BSK methods, and
  `0.4/daemon/browser-daemon.mjs` returns borrowed tabs before a session closes.
  Evidence: `0.4/tests/extension-ingress-e2e.mjs` on real headed Edge (128/128
  checks, CDP inspector re-reads the extension SW's chrome state). Boundary:
  **opt-in** — a daemon without the injected extension client keeps the typed
  `E_UNSUPPORTED` refusal before any effect, and the default gate does not load
  the extension (stage gate step only with `--with-extension`). `0.4/probe-extension`
  remains a self-test probe, not a product client plane.
- **local_auth pairing**: **implemented 2026-11-24 (round 27)**, superseding the
  earlier OOS call. No client consumes the pairing credential yet (the round-34
  extension ingress authenticates to the daemon WS with the daemon token, not the
  local-auth pairing link/credential), so the consumer is the CLI/operator
  (`--local-auth-pair/devices/revoke/rotate/set-mode`) and the daemon HTTP/WS
  routes, not a browser client. Real pairing exists in frozen
  0.3.0 (`docs/local-pairing.md`); 0.4 now has its own store
  (`0.4/daemon/local-auth.mjs`) written to the 0.4 wire contract, so 0.3.0 was
  not ported or touched. Residual risks are recorded in section 5.
- **audio**: no channel and not a requirement. BSK video is MP4/H.264 **without
  audio** (`ref/.../crates/bsk-cli/skill/references/video.md`; `docs/video-recording.md`);
  0.4 `session-video.mjs` reports `audio: false` in its capabilities, and CDP
  screencast carries no audio. The "no audio" caveat in the coverage page is a
  non-gap; never claim an audio path.

## 3. Tool methods

### 3.1 `tool.request_help` — IMPLEMENT NOW

- **Required user-visible use case**: the agent hits login/CAPTCHA/OTP/payment
  confirmation, asks the person to act in the *same* visible tab, waits while the
  person works, then resumes with a fresh observation. The person must see a
  prompt and be able to say "done" or "cancel"; the result must carry their
  decision (`continued` / `cancelled` / `timed_out` / `completed` / `disabled`).
- **Channel**: `overlay-render.js` already renders a real, user-visible overlay
  (fixed host, open shadow root, `role=status`, action buttons, epoch/revision,
  trusted `Input.dispatchMouseEvent` clicks). Missing pieces: human-decision
  capture (the renderer's `click()` is programmatic; a real person's click must be
  recorded by an in-page listener and read back by the handler), completion
  criteria evaluation, and the `Bridgedeck-help` handler that owns show/wait/end.
- **Not fake**: the overlay is the effect; `outcome` comes from a real input path,
  not from a timer that always expires. If the overlay cannot be drawn (restricted
  page, PDF, no document), fail **before** waiting with a typed reason.
- **Acceptance (real browser, extends `0.4/scripts/stage-gate.mjs`)**:
  1. session on a fixture page → `request_help {prompt, targets, timeout_ms}`
     draws `#bridgedeck-overlay` with the prompt and Done/Cancel buttons;
  2. a trusted Input click at the Done button centre (the path a person's click
     takes) → `outcome: "continued"`; Cancel → `"cancelled"`; both remove the
     overlay;
  3. no input before the deadline → `"timed_out"`, overlay removed, no residue;
  4. `completion_criteria` that match while waiting → `"completed"`,
     `completed_by: "system"`; a full reload while waiting → not silently
     "success";
  5. `BSK_REQUEST_HELP=off` → `"disabled"` immediately, no overlay;
  6. `resolved_targets` reports per-target match/miss;
  7. restricted page → typed error, no overlay, no browser effect.
- **LOC**: 380-460 prod (`help-handlers.js` 14 → ~250; human-decision bridge and
  overlay extension ~120; completion criteria ~80), tests separate.

### 3.2 `tool.cooperate` — 已实现 full（caveated-full；2026-11-24 round 36 收口 CLI 门）

- **Executed 2026-11-23 (round 3).** `enable` binds a real tab through the page
  CDP channel (Runtime probe: URL/title/readyState/document token) and draws an
  independent shadow-DOM overlay (`bridgedeck-cooperate-overlay`) via
  `overlay-render.js`; `status` returns real page/authority/overlay facts or
  `enabled:false` with a real probe; `sync` performs a real
  `Runtime.evaluate` observation and issues `context_id`/`observation_id`
  (old context/observation invalidated); `wait` installs an in-page `isTrusted`
  input collector (pointer/mouse/keyboard/input/wheel/touch, capture/passive)
  and decides after a quiet window (default 2000 ms, BSK `QUIET_MS`); trusted
  human input revokes context/observation and advances
  `authority.generation/epoch`; overlay buttons write
  `data-bridgedeck-cooperate-action` and the next `status`/`sync` processes
  `take_control` (revoke + human holder) or `dismiss`.
- **control_policy is recorded and enforced on cooperate's own page-writing
  channel** (overlay injection and the `wait` collector install): `strict`/
  `target` negotiation, `E_CONTEXT_REQUIRED` / `E_OBSERVATION_REQUIRED` /
  `E_CONTEXT_STALE` / `E_CONTEXT_EXPIRED` / `E_OBSERVATION_STALE`, single-use
  context/observation under `strict`.
- **Executed 2026-11-23 (round 6): the generic DOM action entries are now gated,
  and the plane is exposed by the daemon and CLI.** `tool.cooperate` returns an
  `actionGate(params)` that reuses the same `sessions`/token store as `wait`, and
  `dispatch-handlers.js` / `browser-daemon.mjs` inject it into the
  click/hover/select/fill (`action-handlers.js`), press (`press-handlers.js`) and
  drag (`drag-handlers.js`) factories. Before any CDP/executor call the gate:
  passes an action through unchanged when the session was never enabled
  (`gated:false`); under `strict` consumes the single-use `context_id` and, for
  untargeted actions, a single-use `observation_id`; under `target` a DOM-target
  action needs only a reusable context while an untargeted/visual action needs
  and consumes the latest observation. Refusals are raised as
  `adapterError(code, ..., { effectState:'none', phase:'gate' })`; read/observe/
  screenshot are never gated. The daemon relays the plane as
  `cooperate.enable/sync/status/wait` over HTTP and WS (transport +4,
  server routes, advertised in `initialize`) with snake/camel normalization;
  `act` forwards `session_id` + `context_id`/`observation_id` and the adapter
  gate codes are preserved (`invalid_params` + `daemonCode` at the HTTP layer).
  The CLI adds `--session-cooperate-enable/sync/status/wait` plus
  `--control-policy`, `--context-id`, `--observation-id`, `--timeout-ms`,
  `--quiet-ms`; `session.close`/reaping disposes the plane. Tests:
  `cooperate-handlers.test.mjs` 25/25, action 8/8 + press 3/3 + drag 4/4 +
  dispatch 9/9, browser-daemon 47/47, server 68/68, transport 24/24,
  ws-transport 18/18, bridge-daemon-client 81/81 (238 cooperation-related tests
  across the five daemon/CLI files).
- **Executed 2026-11-24 (round 35): human attribution + strict `document_token`
  binding are real.** The adapter computes `document_token = sha256(location.href
  + '|' + per-document nonce)`; `enable`/`sync` inject/rotate the nonce with one
  `Runtime.evaluate`, store the token on the context/observation, and every strict
  `actionGate` decision re-reads it before any CDP call. Mismatch or read failure
  refuses with typed `E_CONTEXT_STALE` (`effectState:"none"`, `phase:"gate"`,
  `data.document_token_stale=true`), keeps the session and dispatches nothing;
  `sync` re-signs a fresh context. The daemon consumes relayed extension
  `human.input` events (`extension.event`) into the cooperate plane:
  `mode=human`, `paused=true`, `held=true`, `last_human_input_at`; the issued
  context/observation are revoked and the authority epoch advances; after
  `HUMAN_QUIET_MS=2000` quiet **and** `IDLE_RESUME_MS=3000` agent idle the
  automatic hand-back resumes (`auto_resumed_at`, old tokens stay invalid until a
  new `sync`), and `system.status.extension.human_events` counts the relayed
  events. Actions arm the extension's own expectation (`ext.arm_input` → content
  script `content/human-watch.js`, all frames, `isTrusted` only) before native
  input, so the extension can match its agent event and only unmatched input
  counts as human. Evidence: opt-in headed-Edge E2E
  `0.4/tests/cooperate-attribution-e2e.mjs` **96/96 checks (3 consecutive
  runs)**: an agent click does not increment `human`; pseudo-human CDP
  `Input.dispatchMouseEvent` on an independent connection → human/paused → gate
  refuses `E_SESSION_PAUSED` → 2 s auto hand-back → the old context fails
  `E_CONTEXT_STALE`; plus strict doc-token suite **33/33**. The stage gate gains an
  opt-in `cooperate attribution` step under `--with-extension` (18 → 20 steps; the
  default 18-step set is unchanged).
- **Executed 2026-11-24 (round 36): the one-shot CLI input paths honor a real
  cooperation gate under the explicit `--cooperate-gate` flag.** `bridge-remote.mjs`
  adds `createOneShotCooperateGate({ cdp })`: the flag enables a target-policy
  session first (`tool.cooperate enable`, real context/observation), then
  `gate(actionKind, { hasDomTarget })` awaits `handler.actionGate` before every
  `--click`/`--fill`/`--press`/`--select`/`--drag`/`--hover`/`--focus`/`--wheel`
  action; a refusal is a typed error (`E_SESSION_PAUSED` etc., code preserved,
  `effectState:"none"`) and dispatches **zero** `Input.*`. `--json` reports
  `cooperate_gate: { enabled, context_id, observation_id, gated }`, the gate is
  disposed on exit/error, and `--cooperate-gate` is validated before any browser
  start (must decorate a gated input action; mutually exclusive with
  `--cooperate` and the `--ref-*` roundtrips -> typed `E_INVALID_PARAMS`). An
  invocation **without** the flag stays byte-compatible: no `cooperate_gate`
  field, the previous untracked timing. Tests:
  `0.4/cli/bridge-remote.test.mjs` **13/13** (argument validation / mutual
  exclusion / help text / fake-CDP gate refusal with zero dispatch / real-Edge
  `--click` through the gate / no-flag compatibility).
- **Executed 2026-11-24 (round 37): the opt-in attribution is an exact
  native-dispatch-timestamp match, and browser-side lifecycle facts land on the
  same extension.** The adapter (`action-handlers.js`, `press-handlers.js`,
  `drag-handlers.js`, `pointer.js`) generates one epoch-ms dispatch timestamp at
  arm time, passes it to the extension as `ext.arm_input.timestamp`, and passes
  the **same** value to every CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`
  as `timestamp: ts/1000`; `content/human-watch.js` converts it into the frame
  monotonic clock with `performance.timeOrigin` and requires
  `|event.timeStamp - armed_at| <= 1.5 ms`. A timestamp that cannot be converted
  fails the whole expectation closed (no silent fallback to window mode). The
  opt-in headed-Edge E2E now proves, on real Edge: ±1.2 ms -> **agent** (no human
  count, expectation consumed; the browser quantizes CDP timestamps to 0.1 ms, so
  a -1.4 ms offset measures about -1.5001 ms and fails — the deterministic
  1.4/1.6 boundary is covered by the content-script unit test), the legacy window-mode contrast (timestamp-less
  arm, same +20 ms event -> agent), and exact +20 ms -> **human** (daemon paused,
  `attribution.delta_ms ≈ 20`, expectation not consumed) — 129/129 checks.
  **Boundary: `fill` stays window-mode** because the write channel
  (`Input.insertText`, then focus/change side effects) carries no CDP timestamp;
  `fill.js` accepts `timestampMs` but never fakes an exact match (documented in
  its file header). The extension also subscribes `chrome.tabs.onMoved` /
  `tabs.onRemoved` / `windows.onRemoved` and pushes
  `extension.event session.ended` with
  `reason=user_moved_tab|tab_closed|window_closed`, but only for a borrowed tab
  or the session's Agent Window (1000 ms dedupe; the extension's own Agent Window
  close suppressed for 2000 ms; `isWindowClosing` tab removals counted as
  `skipped` and never reported as `tab_closed`). The daemon consumes the fact by
  marking the session ended, releasing the Agent Window, returning borrowed tabs,
  keeping a bounded ended-session tombstone (`session.list` no longer contains it)
  and reporting `system.status.extension.{lifecycle_events,last_event}`.
  **Boundary: 0.4 does not subscribe `tabs.onDetached`/`onAttached`**, so a
  cross-window move alone is not a lifecycle fact (and `tool.tab_borrow` moves
  are therefore not self-reported). Evidence: headed-Edge ingress E2E 128/128
  with 3 scenarios — move inside the Agent Window -> `user_moved_tab` + borrowed
  tab returned to its original window/index; close the borrowed tab ->
  `tab_closed`; close the Agent Window -> `window_closed`; each also asserts the
  window/tab counts return to baseline and the extension-side
  `lifecycle_forwarded` is exactly +1.
- **Honest scope conditions (full, but only under these; not unconditional):**
  human attribution requires the opt-in MV3 content script — in-page
  `isTrusted` alone cannot distinguish CDP `Input.dispatch*` input (also
  `isTrusted:true`) from a person. Since round 37 the matching itself is exact
  (native dispatch timestamp, ±1.5 ms) rather than a TTL window, but the
  extension is still the channel that receives the expectation and reports the
  unmatched event; an extension-independent native-clock BSK
  `InputExpectation` is not wired, and without the extension no human signal
  reaches the daemon, so the human/paused hand-back gate is **not armed**. The
  one documented window-mode exception is `fill` (`Input.insertText` has no
  timestamp). One-shot CLI input gating
  requires the per-invocation `--cooperate-gate` flag — without it those paths
  keep the pre-round ungated behavior; state is per-process/in-memory
  (adapter/daemon memory, never persisted, no cross-process sharing) — a
  documented boundary, not a missing-semantics caveat. `document_token` staleness
  is **done** (round 35). The coverage dashboard lists `tool.cooperate` as
  **caveated-full** and prints these conditions in its `[3e]` block.
- Exit condition to *unconditional* full: a native-clock input attribution (or an
  equivalent typed decision) that does not require the opt-in extension, a
  default-on one-shot CLI gate (or `--cooperate-gate` becoming the default),
  exactness for the `fill` channel (blocked by `Input.insertText` carrying no
  timestamp unless a timestamped input path is adopted), and daemon-shared state.

### 3.3 `tool.debug` — 已落地 full（2026-11-24 round 29，24/24 BSK DebugActions；round 39 A4b 关闭 operations 关联与浏览器来源 replay）

- **Delegation (real; round 7 + round 24 + round 25 + round 29 + round 39)**: `debug-handlers.js`
  accepts an injected `debug` client (`createDebugHandlers({ debug })`) and
  exports `SUPPORTED_DEBUG_ACTIONS` (**capabilities + all 23 delegated actions =
  24/24**) / `UNSUPPORTED_DEBUG_ACTIONS` (empty). `dispatch-handlers.js` passes the
  client through; `browser-daemon.mjs` binds it per session
  (`sessionDebugClientFor({ sessionId, tabId })`) and injects it into every
  session path (live session and adapter fallback), so `tool.debug` reads the
  per-session store on the session's *existing* CDP connection. The CLI adds
  one-shot `--debug <action>` (all 24 verbs; local store, auto stop on exit,
  evidence is not lost). Mapping:
  start/stop/status/export are direct; requests/request/console/pages/activity/
  operations/operation go through `query` (`request`/`operation` scan by id first
  — `request` then falls back to url/status/method/resource_type filters;
  `activity` maps the latest `operations` record or falls back to run status;
  `operation` miss returns `operation:null` + `truncated`); `pin`/`unpin`/`wait`
  delegate to the store's pin/unpin/wait; `rules`/`rule_add`/`rule_enable`/
  `rule_disable`/`rule_remove` delegate to the Fetch rule plane; `replay`,
  `performance`, `aggregate` and `duplicates` delegate to the store's replay,
  metrics and analysis methods.
- **Round-29 Fetch rule plane (real, written boundaries)**: while a run records,
  `start` subscribes `Fetch.requestPaused` and enables the Fetch domain with no
  patterns; `ruleAdd`/`ruleEnable` then arm `Fetch.enable` with one
  `requestStage:"Request"` URL pattern per enabled rule (`times` ->
  `exhausted`; 32-rule cap -> typed `E_LIMIT`). Effects are real:
  `block` -> `Fetch.failRequest(BlockedByClient)`; `modify` ->
  `Fetch.continueRequest` with rewritten url/method/headers/body;
  `mock` -> optional abortable `delay_ms` then `Fetch.fulfillRequest`.
  Exactly **one reply per paused request** is guaranteed (a rejected primary
  reply falls back to `failRequest(Aborted)`); `stop`/`drop` abort in-flight
  mocks with `Fetch.failRequest(Aborted)` and revoke rules. Boundary: **rules
  are only mutable while a run is recording** (`rules`/`rule_*` on a stopped run
  is typed `E_NOT_RECORDING`), and a target that cannot enable
  Fetch fails `ruleAdd` typed `E_CDP` instead of faking an armed rule.
- **Round-29 replay boundary (written down; superseded by A4b/round 39)**: `replay`
  re-sends one retained request — the source method/url/headers/body are replayed,
  the transport key is idempotent (the same `key` returns the same record; a bare
  `{id}` defaults to the source request id), the replay is bounded to **15 s /
  256 KiB** and at most **20 replays per run** (typed `E_LIMIT`), and `stop`
  aborts in-flight replays; cookie/credential transport headers are never
  replayed. **Round 39 (A4b) supersedes the round-29 "Node `fetch`, not through
  the browser" part**: replay now defaults to `source:"browser"` — an in-page
  `fetch` through the session's CDP `Runtime.evaluate`, so the replayed request is
  page-originated (browser cookies/origin apply, and a CORS/blocked-origin
  failure surfaces as the browser's own error); the Node `fetch` path remains the
  explicit `source:"node"` / `fallback:true` source (also used when the session
  has no live CDP connection). Both sources keep the idempotent key and the same
  bounds/cap.
- **Round-29 performance boundary (written down)**: `performance` enables the CDP
  `Performance` domain and maps `Performance.getMetrics` counters into
  `DebugPerformance` values (at most 10 snapshots per run, `coverage:
  ["performance_metrics"]`); it does **not** compute BSK aggregation itself —
  `aggregate` (endpoint groups with nearest-rank p50/p95 using captured
  `duration_ms`) and `duplicates` (suspected retries inside `window_ms`,
  `include_controlled` excluded by default) are pure analysis over the retained
  request records and never touch the browser.
- **Round-25 operations feed boundary (written down)**: while a session's debug run
  records, the daemon records every dispatched `act` (adapter action name, target
  ref/selector, started/finished timestamps, `completed`/`error` + error text) and
  every explicit `observe` as one `operations` record through
  `session-debug.mjs`' `recordOperation()` (bounded 200/run, redacted error text);
  the feed is **fail-soft** (no store/no recording = zero writes; any bookkeeping
  error is swallowed and never changes the action result or masks its original
  error, and a failed act still throws its own error). (a) is **closed in round 39
  (A4b)**: `session-debug.mjs` joins each fed operation with the captured evidence
  by a bounded time window and attaches `request_ids` / `console_ids` from the
  captured `Network.requestWillBeSent` / `Runtime.consoleAPICalled` records; the
  join is bounded, a miss stays empty instead of being invented, and the running
  correlation is refreshed before a run is retained. One honest limit remains:
  (b) the feed only exists inside a daemon session — a one-shot CLI run has no
  action loop, so its `operations`/`activity` are empty by design, not a failure.
- **Round-24 pin/unpin/wait boundary (written down)**: `pin` exempts a retained
  request from eviction and is bounded at **50 pins per run** (typed `E_LIMIT`
  past the cap; typed `E_NOT_FOUND` for an id absent from the retained run;
  `pins` count is exposed on `status`/`export`); if a run is configured so small
  that every retained request is pinned, the request bound wins and the oldest
  pinned record is evicted instead of growing. `wait` **only polls** the retained
  run state — `wait_complete` when the run stopped, `wait_timed_out` when
  `wait_ms` (0..60000) elapsed while still recording, optional `command_id`
  echoed, and it never re-sends or cancels a command.
- **Evidence**: `debug-handlers.test.mjs` 34/34, `session-debug.test.mjs` **55/55**
  (round-39 correlation match/miss + browser replay + Node fallback cases),
  dispatch 10/10, browser-daemon **69/69**, server **83/83**, bridge-daemon-client
  81/81, plus a real Edge CLI smoke (`requests`/`console`/`export`/`start`/`stop`/
  `status`/`query`/`request` + `--debug wait` + `--debug operations|operation` +
  rules/replay).
- **Daemon plane (round 5, still the carrier)**: a retained per-session capture
  plane now exists — `0.4/daemon/session-debug.mjs` owns one bounded run per
  `sessionId` on the *live* session's existing CDP connection. It folds real
  `Network.*`/`Runtime.*`/`Page.*` events into requests/console/pages (and
  `operations` when the daemon action loop feeds them), redacts URLs/headers/
  bodies with the adapter rules, bounds each kind (requests 200 / console 500 /
  pages 100 / operations 200; 512 KiB body cap), pages `query` 1..100 with
  `next_since`, writes a JSON `export`, and keeps runs in daemon memory only
  (`stop`/session close drops them; export artifacts are never deleted).
- **Wiring (round 5, real)**: `browser-daemon.mjs` `debugStart/debugStop/
  debugStatus/debugQuery/debugExport`, `transport.mjs` `METHODS_04` +5 and
  `ws-transport.mjs` hardcoded allowlist, `server.mjs` routes, and the CLI
  exposes `--session-debug-start/stop/status/query/export` (with `--since/
  --limit/--kinds` for query). Evidence: `session-debug.test.mjs` 26/26,
  browser-daemon 43/43 at that round, server 64/64, transport 23/23,
  ws-transport 18/18.
- **Why it is full / boundaries**: all 24 BSK DebugActions are real, so the
  method delivers the BSK contract and moved to **full** in round 29 (counts 1
  usable). Not every action is browser-originated, and that is recorded rather
  than hidden: **since round 39 (A4b) `replay` defaults to the browser source**
  (in-page `fetch` over CDP `Runtime.evaluate`) with Node `fetch` as the explicit
  fallback, and the daemon-fed `operations` **do** carry the bounded
  `request_ids`/`console_ids` correlation; still recorded: `performance` only
  reads the CDP `Performance` metrics domain, `rules` are mutable only while a run
  records, a one-shot CLI run has no action feed (`operations`/`activity` empty
  there by design), and a handler built without a client remains
  capabilities-only (`capabilities.actions` stays `['capabilities']` for the
  frozen 0.4 live case; the delegated matrix is advertised as
  `debug_actions`/`supported_actions`).
- **Remaining (browser-origin caveats, not capability)**: `performance` stays on
  the CDP metrics domain and Fetch rules stay recording-only by design; the
  correlation is a bounded window join (a miss is empty, never invented). No BSK
  DebugAction is missing; do not reintroduce a partial classification for this
  method. Round 39 (A4b) closed the previous two remaining items (correlation and
  Node-only replay).
- LOC: landed ~1,486 prod (`0.4/daemon/session-debug.mjs` + ~1,049 test in round
  5) plus the round-7 delegation in `debug-handlers.js`/`dispatch-handlers.js`
  and the round-24 pin/unpin/wait actions and round-25 operations feed in
  `debug-handlers.js`, `session-debug.mjs`, `browser-daemon.mjs` and the CLI; the
  original BSK-anchored estimate was
  900-1,300 prod (`crates/bsk-cli/src/cli/debug.rs` 549 +
  `crates/bsk-protocol/src/tools/debug.rs` 753 + extension `tools/debug.ts` 178).

### 3.4 `tool.video` — 已落地 full（2026-11-24 round 33：adapter 默认 MP4；round 39 A4a：daemon 默认 MP4 + 固定 tab 身份 + owner:'daemon'）

- **Correction to the brief**: the gap was not audio. BSK records one authorized
  tab as MP4/H.264 **without audio**; `tool.video` in 0.4 is otherwise complete and
  real: all eight BSK actions (`start/capabilities/list/status/stop/read/discard/
  exported`), capability tokens, bounded offset reads, MJPEG AVI artifact,
  `completeness`/`stop_reason` (`0.4/packages/browser-adapter/src/video-handlers.js`).
- **Executed 2026-11-23 (MP4 round).** The opt-in MP4 path is real:
  `format:"mp4"` on `start` (adapter, `0.4/packages/browser-adapter/src/mp4-recorder.js`)
  draws the same CDP screencast JPEG frames into an in-page canvas and encodes
  them with `MediaRecorder('video/mp4;codecs=avc1.42E01E')` into a fragmented
  MP4; `stop` writes the Blob bytes and `mp4-verify.js` independently re-parses
  `ftyp`/`moov` (`trak vide`, `stsd avc1`)/`moof`+`mdat`/`trun` and derives the
  real sample count and duration. The daemon and CLI pass `format` through
  (`--video start --format mp4`, `--session-video-start <id> mp4`). If
  `MediaRecorder.isTypeSupported`/`captureStream` is missing the adapter throws
  typed `E_UNSUPPORTED` (with the probe result) and writes **no** AVI — it never
  renames another container to `.mp4`. Default AVI behavior is unchanged.
- **Evidence**: `video-handlers.test.mjs` 15/15, `session-video.test.mjs` 13/13
  (7 format cases + 6 catalog cases), real headless-Edge smoke
  `0.4/tests/e2e/video-mp4-smoke.mjs` (17 frames, `verify ok`, in-page `<video>`
  self-decode), a real CLI MP4 run (h264/mp4, verify ok, playable), and the new
  `video mp4` stage-gate step that re-verifies the produced file (CLI +
  `verifyMp4File`, hard FAIL). **Round 33 evidence**: `video-handlers.test.mjs`
  15/15 including the default-MP4 success path, the typed `E_UNSUPPORTED` refusal
  (with `isTypeSupported` in `data`) and the `E_MP4_VERIFY` failure path; the eval
  live case `video-default-mp4` (bare `--video start`, real Edge) plus the
  explicit `--format avi` sibling; `handler-codecs.test.mjs` 9/9 (the fake-CDP
  contract test pins `format:"avi"` because it has no in-page MediaRecorder);
  `live-runner` 22/22; test-all 1578 passed + 1 skipped; eval 43/43.
- **Executed 2026-11-24 (video-catalog rounds 31-32).** The recording catalog is
  now real and wired end to end. `0.4/daemon/video-catalog.mjs` is a persistent
  artifact catalog — one atomic 0600 JSON index (temp + fsync + rename), 24 h
  retention, 1 GiB total budget, 256 MiB per-entry cap, `list`/`get`/`save`/
  `discard`/`sweep`/`stats`, pinned entries exempt from eviction, missing and
  discarded tombstones, and a corrupt index read as an empty catalog (the next
  write heals it). `session-video.mjs` registers each finished artifact through
  `catalog.record()` and enforces retention/capacity with `catalog.sweep()` after
  `stop` — **best-effort**: a catalog failure neither loses the artifact nor fails
  `stop()`, and the stop result reports `catalog: { recording_id, registered,
  saved, expires_at, ... }`; it exposes `catalogList/Save/Discard/Stats`.
  `browser-daemon.mjs` accepts the catalog (`videoCatalog`/`videoCatalogDir`/
  `videoCatalogFile`/`videoCatalogOptions`) and passes it through
  (`videoList/Save/Discard/CatalogStats`), `transport.mjs` `METHODS_04` gains
  `video.list/video.save/video.discard` (**31 → 34**), `server.mjs` routes them
  with strict parameter validation, and the CLI adds
  `--session-video-list [--limit] [--since]` / `--session-video-save <id> <out>` /
  `--session-video-discard <id>`. A daemon/recorder **without** a catalog answers
  those three methods with typed `E_NOT_CONFIGURED` — never an empty fake page.
  Evidence: `video-catalog` 15 pass + 1 skip (POSIX mode bit on Windows),
  `session-video` **13/13**, `transport` **27/27**, `ws-transport` **20/20**,
  `browser-daemon` **53/53**, `server` **74/74**, `bridge-daemon-client` **91/91**.
  That round did not change the classification (`tool.video` stayed **partial**
  because the default/BSK-param path was still MJPEG AVI); **round 33 reversed
  that** — the adapter default is now MP4, so the method is **full** and usable is
  **72/77 (93.5%)** (details below).
- **Why it is now full (round 33, 2026-11-24)**: BSK 0.5.0's contract is
  MP4-only — `bsk video start` has **no** `format` field and BSK capabilities
  report `format:"mp4"` (`crates/bsk-cli/src/cli/video.rs`,
  `apps/extension/src/video/manager.ts`). The adapter default now matches that
  contract: `video-handlers.js` `VIDEO_DEFAULT_FORMAT='mp4'`, so
  `tool.video start` without `format` probes the page
  (`MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E')` +
  `canvas.captureStream`), encodes the same CDP screencast JPEG frames with the
  in-page MediaRecorder into a fragmented MP4, and only reports `playable:true`
  when `mp4-verify` independently re-parses `ftyp`/`moov`(`avc1`)/`moof`+
  `mdat`. `capabilities` reports `format:"mp4"`,
  `default_format:"mp4"` and a probe-backed `default_format_available`; an
  unsupported page fails typed `E_UNSUPPORTED` (probe data included) and never
  writes an AVI renamed to `.mp4`; the MJPEG AVI path is still real but only
  through an explicit `format:"avi"`/`"mjpeg-avi"`. The classification moved
  from partial to **full**: full 47 -> 48, partial 2 -> 1, usable 71/77 (92.2%)
  -> **72/77 (93.5%)**. The daemon and CLI pass `format` through
  (`--video start --format mp4`, `--session-video-start <id> mp4`), and the
  one-shot CLI bare `--video start` uses the adapter default (MP4) — pinned by
  the `video-default-mp4` live case on real Edge.
- **Executed 2026-11-24 (round 39, A4a)**: daemon-native default MP4 + fixed
  identity + catalog owner. `session-video.mjs` flips the default
  (`SESSION_VIDEO_DEFAULT_FORMAT='mp4'`, `SESSION_VIDEO_FORMATS=['mp4','mjpeg-avi','avi']`),
  keeps `format:'avi'`/`'mjpeg-avi'` on the AVI writer, threads
  `tabId`/`tab_id` + `windowId`/`window_id` into the recording and every view
  (`start`/`status`/`stop`) and into the catalog record, and reports
  `owner:'daemon'`; `server.mjs`/`browser-daemon.mjs` pass the identity through.
  `video-catalog.mjs` gained optional `tab_id`/`window_id`/`owner` with strict
  validation, backward-compatible reads (legacy entries -> `daemon` + `null`) and
  the same fields on list/save/discard results. Evidence (measured this round):
  `session-video.test.mjs` **13/13** (default-MP4 assertion, explicit AVI,
  identity, `info().default_format='mp4'`), `video-catalog.test.mjs`
  **16 pass + 1 skip** (POSIX mode bit; tab/window/owner round-trip, legacy index
  compat, pinned/eviction unchanged), `browser-daemon.test.mjs` **69/69**,
  `server.test.mjs` **83/83**; the adapter default-MP4 path stays pinned by
  `video-handlers` 15/15 + the eval `video-default-mp4` live case + the
  stage-gate `video mp4` step.
- **Remaining boundaries after round 39 (A4a) — documented, not partial**:
  - **Daemon-native `session-video` default is now MP4** (A4a):
    `SESSION_VIDEO_DEFAULT_FORMAT='mp4'`, so the daemon writer and the
    adapter/BSK-param path agree; explicit `format:'avi'`/`'mjpeg-avi'` keeps the
    verified local MJPEG AVI writer, and an MP4-unavailable page fails typed
    `E_UNSUPPORTED` with the adapter probe data (no AVI fallback, no renamed
    container).
  - **Fixed tab/window identity is now recorded, not invented** (A4a): every
    finished recording (start/status/stop view and catalog entry) carries the
    session target's `tab_id`/`window_id` — read from the live session/CDP
    target, `null` when it cannot be read — plus `owner:'daemon'`
    (`0.4/daemon/session-video.mjs` `startIdentityOf`).
    `0.4/daemon/video-catalog.mjs` persists `tab_id`/`window_id`/`owner`, accepts
    an `owner` only from `['daemon','extension']`, and normalizes a legacy index
    (no identity) to `owner:'daemon'` + `null` identity. `owner:'extension'` is
    reserved for a future extension-owned writer and is never written today.
  - **Catalog ownership still daemon-owned**: a browser/extension-owned artifact
    store with fixed-tab authorization is not claimed (0.4 records over a single
    daemon CDP attachment and owns the index). Cross-process
    `list`/`save`/`discard` is real through the daemon (rounds 31-32).
  - Both boundaries are re-checked whenever the daemon video writer or the
    catalog ownership changes.
- **Exit condition met (round 33 + round 39)**: a BSK-parameter `start` (no
  `format`) produces H.264/MP4, capabilities report `format:"mp4"`, and the
  daemon-native writer defaults to MP4 too (A4a) with a recorded fixed
  tab/window identity; a browser/extension-owned catalog remains the only written
  non-semantic boundary.
- **Decision revision (2026-11-24 round 33): the adapter default is MP4.**
  This supersedes the 2026-11-23 round-7 decision "MP4 stays opt-in, AVI stays
  the default", which was correct while the encode path was proven only on
  Windows/Edge headless and the BSK-param mismatch was a contract risk:
  - BSK is MP4-only (no `format` field), so the default had to move to close the
    semantics gap; keeping AVI by default was the last technical blocker.
  - The encode+mux path is no longer a spike: it is exercised by
    `video-handlers.test.mjs` (default-MP4 start/stop with `mp4-verify`), the
    eval `video-default-mp4` case on real Edge through the shipped CLI, and the
    stage-gate `video mp4` step; a page without the encoder gets a typed
    `E_UNSUPPORTED`, never a fake playable artifact.
  - Explicit AVI is preserved (not deprecated): `format:"avi"` keeps the local
    MJPEG AVI writer and its `avi-verify` evidence, the eval corpus keeps the
    `video-avi-artifact` case plus explicit-`--format avi` cases, and the
    stage-gate `video avi` step is explicit.
  - DSH plugin schema (`SESSION_VIDEO_FORMATS` / `video_start.format` enum)
    already exposes both formats, so the plugin surface does not change.
  - Revisit only if a real cross-environment matrix (Chrome/headed/long runs)
    shows the default-MP4 path is not reliable; that would be a new measured
    decision, not a silent revert.

### 3.5 `tool.session_start`, `tool.session_stop` — 已实现（opt-in extension ingress，2026-11-24 round 34）

Why the earlier OOS call (2026-11-23): no user browser and no Agent Window. The
daemon launched/owned one browser (its `BSK_BROWSER_INSTANCE_ID` is per-process),
so "isolate the agent's work in its own window and hand it back" had no
counterpart; `session.open`/`session.close` own the lifecycle and `start_tracked`
(section 4) is the real managed-start path. The old handlers returned
`agent_window_id: null` / empty returned-tab arrays and were classified partial —
success without the effect.

**Executed 2026-11-23 (refusal state).** Both handlers threw typed `E_UNSUPPORTED`
before any CDP/window effect (`effectState: 'none'`; hint `session.start` /
`session.open` for start, `session.close` for stop), recorded no state, and
coverage reported them under **refused**. `session_id` was still validated first
(`E_INVALID_PARAMS`). The written reconsider trigger was: "reconsider only when a
real extension ingress exists".

**Round 34 (2026-11-24) closes it.** A real MV3 extension ingress now exists
(`0.4/extension-ingress/` + `0.4/daemon/extension-ingress.mjs`). The daemon wraps
it as a client (`sessionStart`/`sessionStop`/`tabBorrow`/`tabReturn`/`status`,
injected by `server.mjs` / `browser-daemon.mjs`), and
`createSessionHandlers({ extension })` delegates when it is present:
`session_start` validates `session_id` (and width+height pairs 100..7680, boolean
`incognito`/`focused`, object `controller`), calls the extension's
`chrome.windows.create` path and normalizes the result to
`{ agent_window_id, interaction:{ borrow_confirmation, request_help } }`;
`session_stop` returns `{ window_released, returned_tab_ids, return_failures }`,
and `browser-daemon.mjs` returns every borrowed tab before closing a session
(never `Target.closeTarget` on a user tab). **Opt-in boundary (explicit):** with no
injected extension client both handlers keep exactly the old typed `E_UNSUPPORTED`
refusal — the capability gate is honest, and the default gate never loads the
extension. Evidence: real headed-Edge E2E `0.4/tests/extension-ingress-e2e.mjs`
**87/87 checks** (independent CDP inspector re-reads the extension SW's
`chrome.windows`; window count +1, `agent_window_id` real, teardown back to
baseline), adapter session-handler tests, `handler-codecs` 9/9. Coverage: both
moved **refused -> full**, usable 76/77; the stage gate runs the E2E only with
`--with-extension`.

**Round 39 (2026-11-24, A3b) adds the session/window semantics.** The extension
now tracks two disjoint ownership sets in `0.4/extension-ingress/src/sessions.js`:
`agent_created_tab_ids` (the Agent Window home and any tab the extension itself
opened — closed at stop, never routed) and `observed_tab_ids` (pages a person or a
page pop-up opened in the Agent Window — non-destructive ownership: the agent may
operate them, but `session_stop` never closes them). `0.4/extension-ingress/src/bridge.js`
routes a tab a page creates inside the Agent Window back to a user window
(lastFocused normal non-incognito window, else any normal non-incognito window,
else a newly created one) and never makes a pending/uncertain tab the default
target; routing failures stay in `pendingRoutingTabs`. `stopSession()` is the
single written teardown order: **return borrowed tabs** (a still-borrowed failure
returns immediately with `return_failures` and keeps the session so it can be
retried) -> **clear refs** -> **close agent-created tabs including home** ->
**remove the Agent Window only when no user/observed tab remains** (otherwise
`window_released:false` + `preserved_tab_ids`); the test evidence is
`browser-daemon.test.mjs` **69/69** plus the existing headed-Edge E2E **128/128**
(3 lifecycle scenarios, each asserting the real chrome state and the return of a
borrowed tab before the session ends).

### 3.6 `tool.tab_borrow`, `tool.tab_return` — 已实现（opt-in extension ingress，2026-11-24 round 34）

Why the earlier OOS call (2026-11-23): nothing to borrow. There was no user tab
(daemon-launched browser), no `chrome.tabs.move`, and CDP cannot move a tab
between windows. The old `tab_borrow` returned
`agent_window_id = original_window_id` — a claim that the tab now lived in an
agent window, which it did not.

**Executed 2026-11-23 (refusal state).** Both handlers threw typed `E_UNSUPPORTED`
before sending any CDP command (hint `tool.tab_create`; borrow also named
`session.open`); the borrow map and the fake window id were deleted, tests
asserted no `Browser.*`/`Target.*` mutation, and coverage reported them under
**refused**. Real borrow/Agent Window required an extension ingress with the
`tabs` permission — a different round.

**Round 34 (2026-11-24) closes it.** The opt-in MV3 extension ingress
(`0.4/extension-ingress/`: `tabs`, `windows`, `storage`, `alarms`; no `debugger`)
executes the real `chrome.tabs.move`. `createBorrowHandlers({ cdp, extension })`
delegates when an extension client is injected and normalizes strict BSK results:
`tab_borrow -> { tab_id, original_window_id, original_index, agent_window_id }`
(original window/index snapshotted before the move) and
`tab_return -> { tab_id, returned_to_window_id, returned_to_index, fallback? }`.
The handler validates `session_id`/`tab_id`, preserves the extension's typed
errors (`E_ALREADY_BORROWED` on a double borrow, `E_UNKNOWN_SESSION` on a second
stop) and raises `E_EXTENSION` on malformed results instead of faking success.
**Opt-in boundary (explicit):** with no injected extension client both handlers
keep their typed `E_UNSUPPORTED` refusal before any effect. Evidence: real
headed-Edge E2E **87/87** — the borrowed tab is physically in the Agent Window
(inspector `chrome.tabs.get`), returns to the original window/index with
`fallback:false`, and the window/tab id sets return to baseline; `handler-codecs`
9/9. Coverage: both moved **refused -> full**, usable 76/77.

**Round 39 (2026-11-24, A3a) adds the borrow decision and return fidelity.**
`0.4/extension-ingress/src/borrow.js` implements a **real confirmation UI** for
`tab_borrow` (`borrowConfirm:'always'` is the default): an active target tab gets an
on-demand `chrome.scripting` injection of a shadow-DOM confirmation bar, an
inactive tab gets a `chrome.notifications` fallback (closing the notification =
deny; 60 s default timeout, max 300 s), and every failure path is fail-closed —
no confirmation surface/restricted page -> typed `E_BORROW_CONFIRM_UNAVAILABLE`,
deny -> `E_BORROW_DENIED`, timeout -> `E_BORROW_TIMEOUT`, and the tab is never
moved. Before the move it snapshots `original_window_id`/`original_index`, the
neighbour tab **ids** (not indices), `group{id,title,color,collapsed}`, `pinned`
and the pinned-prefix count in `chrome.storage.session` (bounded 64, survives
service-worker restarts); `tab_return` computes the position from that snapshot
(pinned only into the pinned prefix, normal tab never there, neighbour anchoring
then a clamped original index), re-joins the original tab group or rebuilds it
with the copied metadata (a group the user changed meanwhile is respected, a
pinned tab reports `group_skipped:"pinned"`), falls back to a normal
non-incognito window (or creates one, `fallback:true`) when the original window
is gone, and reports `snapshot_degraded:true` instead of pretending a perfect
restore when the snapshot is missing. The three A3a codes
`E_BORROW_DENIED`/`E_BORROW_TIMEOUT`/`E_TAB_PIN_FAILED` are registered in
`0.4/extension-ingress/src/errors.js` (asserted by smoke). Evidence:
`0.4/extension-ingress/test/smoke.mjs` **339/339** (confirm allow/deny/timeout,
restricted-page fail-closed, snapshot/restore plan, group rebuild, pinned clamp,
fallback window) and the existing headed-Edge E2E **128/128** (borrow into the
Agent Window, return to the original window/index with `fallback:false`).

## 4. Control plane — THIS ROUND (parallel agent) and one dependency

Refusal wave complete (2026-11-23). The `session.request` / `session.start_tracked`
dependency was resolved in round 3 (option A: same-round implementation, section
4.1 executed); `session.run_log`, `audit.request`, `cancel` and `transfer.*` were
executed in round 2.

### 4.1 `session.start_tracked` (+ its dependency `session.request`) — 已落地（按本轮范围）

**Executed 2026-11-23 (round 3).** `0.4/daemon/session-requests.mjs` implements
the real request plane and `0.4/daemon/server.mjs` routes/maps both methods
(`BSK_MAPPED_METHODS` 19 mapped / 5 unsupported / 24; `initialize.bsk` reports
19/5/24). Test evidence: `session-requests.test.mjs` 16/16, `server.test.mjs`
62/62 (HTTP + WS), control plane 18→19 real, usable 64/77→65/77.

- Use case: a host/plugin starts a session durably and survives a lost reply, a
  killed CLI or a daemon restart without leaking or duplicating an Agent Window;
  the token is the ownership handle, not the short session id.
- **Dependency flag (resolved)**: BSK's tracked start is meaningless without the
  request plane (`ref/.../crates/bsk-cli/src/daemon/session_requests.rs`): the
  token is prepared first, and `start` fails closed when no prepared request
  exists. `session.request` ships in the same round, so `start_tracked` is the
  real managed-start path, not "start with a random UUID".
- `session.request`: `{request_id, action: status|prepare|cancel|claim}`;
  token `<expiry-unix-ms>:<uuid>`; admission ≤ 10 min; `prepare` creates **no**
  browser side effect; `cancel` is monotonic, including before `prepare`
  (terminal tombstone that cannot be resurrected); `claim` only after `ready`;
  registry bounded; unclaimed requests reaped at the deadline.
- `session.start_tracked`: start with the same token+params twice → same
  `session_id`; different params → `invalid_params`; unprepared / post-restart
  token → fail closed, **no session and no window**; a start cancelled mid-flight
  is cleaned up by the daemon (ownership retained, cleanup failure retryable and
  visible, never reported as closed).
- **Acceptance E2E** (real daemon): prepare → start_tracked → session listed;
  retry → same id; cancel-before-start → start fails and the browser target count
  is unchanged; daemon restart → old token rejected; reaper closes an unclaimed
  prepared request. Unit tests with a fake browser are not enough.
- LOC: 250-400 (`start_tracked`) + 150-250 (`session.request`) prod; BSK anchor
  587 lines of request plane.

### 4.2 `session.run_log`

- Use case: a finished run becomes a recipe/draft and the caller can answer
  "what did this session do" without ever persisting input values.

- Metadata only: per-session steps (action, target role/name/context,
  `first_seen` observation index, wait/skipped/uncertain), observation count,
  `truncated`, `borrowed_tabs`; bounded (~200 steps, text ≤ 256 chars). **Never**
  input values, page text or selectors beyond the recorded role/name.
- Must log implicitly for every session (not require `record.start`), survive
  across CLI processes (daemon-owned), and disappear with the session.
- Acceptance: 3 real actions + 1 observe → 3 ordered steps and observations=1;
  201 actions → `truncated: true`; after `session.stop` → `not_found`; a filled
  password field never appears in the log.
- LOC: 300-450 prod (reuse `session-record.mjs` steps; BSK `run_log.rs` 635).

### 4.3 `audit.request`

- Use case: after a task, the person reviews which operations the agent ran on
  their browser (default off, metadata only).

- Real persisted records written from the dispatch path: method, ok/code,
  duration, session id, tab id, result URL; default **off** switch; query
  `since/limit/offset`; export; retention/pruning. Redaction: no input values,
  page text, headers, bodies, screenshots, file paths.
- Write failure must be explicit (storage error) and must not fabricate entries;
  when audit is off, return `enabled: false`, not an empty success.
- Acceptance: 3 RPCs (one failing) → query returns 3 records with correct
  method/ok/duration/url; pagination; export round-trips JSONL; audit off → no
  file written and an explicit disabled answer; a `fill` of a secret never
  appears.
- LOC: 350-500 prod (BSK `audit.rs` 1005 + extension bridge 121; can build on
  `daemon-wal.mjs` + `session-record.mjs`).

### 4.4 `cancel`

- Use case: a waiter gives up on a hung/slow operation without killing the
  daemon or losing track of whether the browser already acted.

- Cancels a real in-flight operation addressed by rpc/operation id; the original
  call returns `cancelled` **with** `effect_state` (`none|committed|unknown`) and
  never claims "no effect" when the browser may have acted; unknown id →
  `not_found`; terminal/idempotent; waiter cancellation must not cancel the
  original operation.
- Acceptance: WS client starts a slow `wait_ms`/action, second client sends
  `cancel`, the original returns `cancelled` within the deadline and no further
  browser command is dispatched after the cancel.
- LOC: 200-300 prod (BSK `abort.rs` 266 + `cancel_forward.rs` 38).

### 4.5 `transfer.begin/chunk/finish/read/release`

- Use case: move a file larger than one RPC frame between the CLI machine and the
  browser machine under a per-session capability, without exposing paths.

- Daemon-issued opaque, session-scoped transfer id + capability token checked on
  every chunk; declared and enforced byte limit; bounded chunks; private staging
  dir; path traversal/symlink rejection; upload staging released at session
  teardown/startup, download staging released after commit; release idempotent.
- **Usable only with a real client E2E**: a file larger than one chunk crosses the
  wire and the browser actually receives it (upload → the input node holds the
  file) or the CLI writes byte-identical content (download, sha256 equal).
  A registry that mints ids with no client path is schema padding, not coverage.
- Acceptance: upload/download round-trip with sha256 equality; wrong capability
  denied with no state change; oversized chunk rejected; traversal path rejected;
  staging dir empty after teardown.
- LOC: 500-700 prod (BSK `file_transfer.rs` 728 + protocol `tools/file_transfer.rs`
  213).

### 4.6 `cancel`/`transfer` cross-check

`cancel` must be able to address a transfer in flight; otherwise a stalled
transfer cannot be cleaned up. Add one E2E for that pair.

## 5. `local_auth.*` (5) — IMPLEMENTED 2026-11-24 (round 27), with residual risks

| method | decision | what landed | boundary |
| --- | --- | --- | --- |
| `local_auth.pair` | **implemented** | creates a pending device and returns a 5-minute `ws://127.0.0.1:<port>/#bsk-local.v1.<daemon_id>.<device_id>.<key>` link (the key lives only in the fragment), a 6-digit code compared in constant time, and `expires_at`; at most 16 pending links (typed `E_TOO_MANY_PENDING`); it is the only credential-free HTTP route, served to loopback peers only (round 28) | no client consumes the link/credential yet; credential-free by design, but since round 28 a non-loopback pair request is refused with 403 + `E_LOCAL_ONLY` and the WS transport never serves `pair` (risk record below) |
| `local_auth.devices` | **implemented** | device summaries (`kind:"local"`, label/status/created/activated/expires/rotate_requested/gen), never a key; the store holds only per-secret salted SHA-256 hashes | no extension plane lists or uses these devices |
| `local_auth.revoke` | **implemented** | marks one device (or `all:true`) revoked and bumps `gen`; unknown id is typed `E_NOT_FOUND` | the legacy bearer token is not a device and stays valid in `warn` mode |
| `local_auth.rotate` | **implemented** | two-phase rotation: a 10-minute pending key while the old key keeps working; the first use of the new key commits the rotation, expiry rolls back | the new credential is returned as a link plus a bare `token`; delivering it is the caller's job |
| `local_auth.set_mode` | **implemented** | persists `warn` (default) / `required` / `trust_local` and applies the current mode to every request | `trust_local` accepts any loopback connection with no credential by design |

Why this is no longer OOS: the earlier decision said "no extension client plane
to pair, so it would be a store with no consumer". The policy update in section 9
(依赖可用、能力优先) changed the bar: the capability is real and its effects are
visible (pairing link/code, device list, revoke/rotate/mode persisted), and it is
verified by unit + HTTP/WS tests, so it ships **capability-first** even though the
consumer is still the CLI/operator rather than a browser extension. It counts as
24/24 real control methods, not as a client plane, and it is not BSK parity.

Risk record:

- **Credential-free `pair` (MITIGATED, round 28)**: `server.mjs` passes
  `publicMethods: ['local_auth.pair']` and `transport.mjs` accepts it without
  credentials, but no longer regardless of the peer interface. The round-28
  `publicMethodAccess(method, publicMethods, address)` serves a public method
  only to a loopback peer (`127.0.0.0/8`, `::1`, `::ffff:127.x`); a non-loopback
  request is refused with **403** + `data.daemonCode = "E_LOCAL_ONLY"` instead of
  being silently authorized. The WebSocket transport has no public/pair route at
  all (the upgrade handshake is its auth boundary), so a tokenless client can only
  pair over HTTP from the same host. The returned link still carries the device
  key in its fragment and presenting that key activates the device, so pairing
  remains a local-operator bootstrap; a daemon started with `--host 0.0.0.0`/`::`
  no longer exposes `pair` to that network (the round-27 "0.0.0.0 can be paired"
  risk is closed). Other authenticated routes are still reachable over that
  network by whoever holds a valid credential, so `local_auth=required` plus a
  firewall stays the advice for non-loopback exposure.
- **Default mode `warn`** keeps the legacy bearer token accepted so existing
  clients are not broken; `required` rejects it (`legacy_disabled`) and needs a
  paired device; `trust_local` is the explicit no-auth loopback mode.
- **`last_unpaired_attempt` is recorded in memory (RESOLVED, round 30)**:
  `system.status.local_auth` reports
  `{ mode, paired_devices, last_unpaired_attempt, devices }`. The store's
  `authorize()` records every rejection through `deny()` as
  `{ at, reason, device_id? }` (reasons: `missing_token`, `unknown_token`,
  `revoked`, `expired`, `legacy_disabled`, `not_loopback`) and `snapshot()`
  exposes it; a fresh daemon honestly reports `null` until the first rejection.
  The record is **daemon-memory only** (never persisted, no key/hash, no
  secret), which matches the status-view scope; a persisted record across
  restarts is still outstanding and would be a separate storage decision.
- **No extension client plane**: the paired credential has no browser consumer
  yet; that is a product gap, not a wire gap.

## 6. Projection after this round (not generator output)

Labeled projection; the authoritative numbers must come from
`node 0.4/scripts/bsk-coverage.mjs --check` after the code lands. Round 3 landed
`session.request`/`start_tracked` and the real `cooperate` carrier; round 4 landed
the verified opt-in MP4 path (which does not change the partial/usable counts,
because the BSK-param path is still AVI and the catalog was process-local at that
round — a real daemon-side persistent catalog landed in rounds 31-32, see 3.4); round 5
landed the daemon-side debug capture plane (`debug.start/stop/status/query/export`
+ CLI, `0.4/daemon/session-debug.mjs`), which also does not change the counts
because the BSK `tool.debug` adapter handler still does not delegate to it; round
6 landed the cooperate action gate plus the daemon/CLI cooperation plane
(`cooperate.enable/sync/status/wait`, `--session-cooperate-*`), which also does
not change the counts: `tool.cooperate` still stays partial (one-shot CLI
actions, CDP-vs-human attribution, `document_token` staleness and cross-process
state remain). Round 7 landed the `tool.debug` adapter delegation (10/24
DebugActions through the injected session-bound client + one-shot CLI `--debug`),
which again does not change the counts: `tool.debug` still stays partial because
the rules/replay/performance/operations families are absent and the
`operations` stream has no daemon feed. Round 8 added `pin`/`unpin`/`wait`
(13/24) with written boundaries (50-pin cap, `wait` polls only), which likewise
does not change the counts. Round 9 wired the **operations feed** (every
`act`/`observe` while a run records → bounded `operations`, fail-soft) and
delegated `operations`/`operation` (**15/24**): still no count change, because
`tool.debug` stays partial (9 refusals left, no request/console correlation, no
one-shot CLI feed). Round 10 (2026-11-24) landed the real local pairing/device
plane: the previous 5 typed-unsupported control methods (`local_auth.*`) are now
real, so the control plane is **24/24 real, 0 unsupported, 0 absent** and usable
coverage is **70/77 (90.9%)**. Round 29 (2026-11-24) closed the debug family, so
`tool.debug` left the partial bucket and usable coverage is **71/77 (92.2%)**
(partial 3 -> 2, full 46 -> 47). Round 30 (2026-11-24) added the memory-only
`last_unpaired_attempt` to the local-auth status view: it does not change any
classification (control 24/24, usable 71/77), only the measured 0.4 code totals
(daemon 31,832 -> 31,893; production 86,102 -> 86,137; total 146,000 -> 146,061).
Rounds 31-32 (2026-11-24) added the persistent daemon-side video catalog and
wired it end to end (`session-video` record+sweep, daemon/transport/server
`video.list/save/discard`, CLI verbs, typed `E_NOT_CONFIGURED` when off): no
classification change that round (the BSK-param default was still MJPEG AVI), only
the measured totals moved (production 86,137 -> 87,611, test 59,924 -> 61,288,
total 146,061 -> 148,899). Round 33 (2026-11-24) moved the adapter default to
MP4, closing the BSK-param contract gap: `tool.video` left the partial bucket, so
full 47 -> 48, partial 2 -> 1 and usable **71/77 (92.2%) -> 72/77 (93.5%)**; only
the measured totals move again (production 87,611 -> 87,664, test 61,288 ->
61,490, total 148,899 -> 149,154). Round 34 (2026-11-24) landed the opt-in MV3
extension ingress and closed the last four refusals: `tool.session_start`/
`session_stop`/`tab_borrow`/`tab_return` are **full** when the injected extension
client is present (real headed-Edge E2E **87/87 checks** on live `chrome.*`
state; without the extension client the typed `E_UNSUPPORTED` gate is kept), so
full 48 -> 52, refused 4 -> 0 and usable **72/77 (93.5%) -> 76/77 (98.7%)**;
caveated-in **77/77 (100%)**. The measured totals move to production 93,950 /
test 65,655 / total 159,605 (the new extension surface: `extension-ingress` 8
files / 2,816 lines, plus the ingress module and the E2E under `daemon`/`tests`).
Round 35 (2026-11-24) made the cooperate human-attribution and strict
`document_token` caveats real (opt-in headed-Edge E2E **96/96**, strict doc-token
suite **33/33**) and added the opt-in `cooperate attribution` stage-gate step;
there is **no classification change** (`tool.cooperate` stays partial: one-shot
CLI entries ungated, attribution opt-in, per-process state), only the measured
totals move (production 93,950 -> 94,364, test 65,655 -> 70,157, total 159,605 ->
164,521) and the gate becomes 20 steps with `--with-extension` (18 by default).
Round 36 (2026-11-24) landed the explicit `--cooperate-gate` one-shot CLI gate
(**13/13**: fake-CDP refusal with zero `Input.*` dispatch, real-Edge click/fill
smoke, no-flag byte compatibility), so `tool.cooperate` moves from **partial** to
**caveated-full** (`CAVEATED_FULL_TOOLS` in the generator, printed in the
dashboard's `[3e]`): full 52 -> 53, partial 1 -> 0, usable **76/77 (98.7%) ->
77/77 (100.0%)**, caveated-in 77/77. The 100% is **scope-conditioned**: the four
extension-ingress methods need the opt-in extension and `tool.cooperate` needs
the opt-in MV3 content script (human attribution) plus the per-invocation
`--cooperate-gate` flag (one-shot CLI gating); without them the human/paused gate
is not armed and the one-shot paths keep the pre-round ungated behavior. The
synthetic "before" figure stays 52/77 (the caveated-full handler is excluded from
it, exactly like the extension-ingress four), so the delta is not double-counted.
Measured totals in the same tree: production 94,651 / test 70,593 / total
165,244 (round 35 measured 164,521; the difference includes this round's CLI-gate
tests and generator changes plus other in-tree work measured at the same time).
Round 37 (2026-11-24) made the opt-in attribution exact (native dispatch
timestamp -> CDP `Input.*` timestamp -> ±1.5 ms clock match; a 20 ms near-miss is
human; `fill` stays window-mode) and landed the browser-side `session.ended`
lifecycle facts; **no classification change** (full 53, partial 0, refused 0,
usable 77/77 scope-conditioned), only measured totals move (production
94,651 -> 95,638, test 70,593 -> 72,474, total 165,244 -> 168,112; the same
working tree also carries parallel adapter/extension work, so cite the generator
output).
The "Before this wave" column is the state at the
start of round 3 and "Now (generator)" is the measured post-round state.

| Metric | Before this wave | Now (generator) | Note |
| --- | ---: | ---: | --- |
| Control methods real | 18/24 | **24/24** | +`session.request`/`start_tracked` (4.1) + `local_auth.*` ×5 (section 5); 0 typed refusals left |
| Full tool handlers | 46/53 | **53/53** | `request_help` already full before this wave; +`tool.debug` round 29, +`tool.video` round 33, +`session_start`/`session_stop`/`tab_borrow`/`tab_return` round 34 (opt-in extension ingress), +`tool.cooperate` round 36 (caveated-full: opt-in MV3 content script for attribution + `--cooperate-gate` for one-shot CLI gating); round 37 keeps the same classification and hardens the attribution evidence (exact native timestamp, `fill` window-mode exception) + lifecycle facts |
| Partial tool handlers | 3 | **0** | all three left as they became real: `tool.debug` round 29 (24/24 DebugActions), `tool.video` round 33 (adapter default MP4), `tool.cooperate` round 36 (CLI gate 13/13 + round-35 attribution/doc-token). No handler is classified partial now; 5 full handlers carry written opt-in conditions (`[3c]` + `[3e]`) |
| **Usable methods** | **64/77 (83.1%)** | **77/77 (100.0%)** | 53 tools + 24 control; scope-conditioned: 4 tool handlers are full only with the opt-in extension ingress and 1 (`tool.cooperate`) only under the `[3e]` conditions — not an unconditional capability claim |
| Ceiling after LATER items | — | **reached (round 36)** | the former "only remaining partial" `tool.cooperate` is now caveated-full |
| Ceiling with an extension ingress | — | **reached (round 34)** | session_start/stop + tab_borrow/return are **full** under the opt-in ingress; usable 77/77 now, caveated-in 77/77 |

## 7. Honesty limits, corrections, refresh

- **Correction to the attribution model (2026-11-24 round 37)**: earlier
  paragraphs (rounds 35/36 and the coverage page's round-17 text) described the
  content-script match as "window mode: the first same-type event inside the TTL
  is the agent" with `exact` as a narrower sub-mode. That is superseded: the
  shipped adapter arms with the **native dispatch timestamp** (one epoch-ms value
  generated at arm time, passed as `ext.arm_input.timestamp` and as the same
  `timestamp: ts/1000` to every CDP `Input.*` call), and the content script
  requires `|event.timeStamp - armed_at| <= 1.5 ms`; a 20 ms near-miss is a
  human event even though it is inside the old TTL window. Window mode is kept
  only as a fallback for arms without a timestamp and as the one documented
  exception for `fill` (`Input.insertText` carries no timestamp), so no "fill is
  exact" claim is made. See §3.2 round-37 execution for evidence.
- **Correction to the coverage page**: `session.request` is not "a
  user-interaction request queue". In BSK it is the managed-start request plane
  (`prepare/cancel/claim/status` + tombstones) that `start_tracked` depends on
  (`daemon/session_requests.rs`). It landed this round as
  `0.4/daemon/session-requests.mjs`; the section 3b note now says so.
- **Correction to this round's brief**: `tool.video`'s missing audio is not a
  BSK gap; BSK records without audio. The H.264/MP4 gap itself is now closed for
  the opt-in path (`format:"mp4"`, verified by `mp4-verify` + real Edge/CLI
  evidence), but the method stayed **partial** in that round: BSK's contract is MP4-only while
  0.4's default/BSK-param artifact was MJPEG AVI (superseded by round 33, see the
  video correction below). The earlier statement that "0.4's
  recording catalog is adapter-process-local" is **superseded by rounds 31-32**
  (2026-11-24): a real daemon-side persistent catalog
  (`0.4/daemon/video-catalog.mjs`) now records every finished artifact after
  `stop` (24 h retention / 1 GiB / 256 MiB), sweeps retention/capacity, and is
  reachable cross-process via `video.list/save/discard` over HTTP/WS plus the CLI
  verbs; it fails closed with typed `E_NOT_CONFIGURED` when no catalog is
  configured. It is still not the BSK artifact story: the catalog is
  **daemon-owned**, not browser/extension-owned with fixed-tab identity. See
  section 3.4 and the coverage page's `[3b]` reason.
- **Correction to the debug entry (2026-11-23 round 7)**: this supersedes the
  round-5 statement that "the BSK `tool.debug` adapter handler is still
  capabilities-only (23 actions typed `E_UNSUPPORTED`), the daemon wire names are
  not BSK names, and rules/replay/performance are not implemented". The handler
  now delegates **10 of 24** actions through the injected session-bound debug
  client (`capabilities` + `start`/`stop`/`status`/`export`/`requests`/`request`/
  `console`/`pages`/`activity`) and the CLI runs them one-shot via
  `--debug <action>`; the remaining 14 still refuse typed `E_UNSUPPORTED`,
  `activity` falls back to the run status until `operations` has a daemon
  action-loop feed, and the method is still counted **0 usable / partial**. The
  generator's `[3b]` partial reason states exactly this.
- **Correction to the debug entry (2026-11-23 round 8)**: this supersedes the
  round-7 "10 of 24" number. `tool.debug` now delegates **13 of 24** actions —
  the round-7 set plus `pin`/`unpin`/`wait` — through the injected session-bound
  client and the one-shot CLI `--debug <action>`; `pin` is capped at 50 with
  typed `E_LIMIT`/`E_NOT_FOUND` and `wait` only polls run state
  (`wait_complete`/`wait_timed_out`, never re-sends). The remaining 11
  (`rules`/`rule_*`/`replay`/`performance`/`aggregate`/`duplicates`/`operations`/
  `operation`) still refuse typed `E_UNSUPPORTED`, `activity` falls back to the
  run status until `operations` has a daemon action-loop feed, and the method is
  still counted **0 usable / partial**. The generator's `[3b]` partial reason
  states exactly this.
- **Correction to the debug entry (2026-11-23 round 9)**: this supersedes the
  round-8 "13 of 24 / remaining 11" number. The daemon now feeds the `operations`
  collection (every `act`/`observe` while a run records, fail-soft) and
  `debug-handlers.js` delegates `operations`/`operation`, so `tool.debug` now
  covers **15 of 24** DebugActions; the one-shot CLI has 16 `--debug` verbs.
  The remaining 9 (`rules`/`rule_*`/`replay`/`performance`/`aggregate`/
  `duplicates`) still refuse typed `E_UNSUPPORTED`; fed operations do not carry
  `request_ids`/`console_ids` links yet and a one-shot CLI run has no feed, so
  `activity`/`operations` are empty there by design. The method is still counted
  **0 usable / partial**. The generator's `[3b]` partial reason states exactly
  this.
- **Correction to the local_auth entry (2026-11-24 round 10)**: this supersedes
  the section 5 "OOS" decision and the decision-table OOS row. The five
  `local_auth.*` methods are now a real local device trust store
  (`0.4/daemon/local-auth.mjs`, wired through `server.mjs`,
  `transport.mjs`, `ws-transport.mjs` and the CLI); `initialize.bsk` reports
  **24/24/24** (with an honest 19/5/24 fallback on a build that lacks the module),
  `pair` is the only credential-free HTTP route, and `system.status.local_auth`
  reports mode + paired device count while `last_unpaired_attempt` stays null
  (not tracked). They are real control methods (**+5 usable, 70/77**), not a
  client plane. Residual risks are in section 5.
- **Correction to the local_auth risk record (2026-11-24 round 11)**: round 10's
  residual risk "a non-loopback `--host` exposes `pair`" is **closed**.
  `transport.mjs` `publicMethodAccess` serves public methods to loopback peers
  only (a non-loopback request is 403 + `E_LOCAL_ONLY`) and `ws-transport.mjs`
  has no pair route, so the default `127.0.0.1` bind is no longer the only thing
  protecting `pair`. Sections 5 and 10 carry the updated record; the other
  residual risks (`warn` default, no client plane) are unchanged, and the
  round-11 note "no `last_unpaired_attempt`" was superseded by round 30
  (memory-only record; see the round-30 correction in section 7).
- **Correction to the debug entries (2026-11-24 round 29)**: this supersedes the
  round-7/8/9 corrections that kept `tool.debug` partial at 10/13/15 of 24
  actions. All 24 BSK DebugActions are now real (the Fetch rules, `replay` on
  Node `fetch`, `performance` on CDP metrics, and `aggregate`/`duplicates`
  landed), the handler delegates all of them, and the coverage page reports
  `tool.debug` as **full**: full 46 -> 47, partial 3 -> 2, usable **70/77 ->
  71/77 (92.2%)**. The remaining debug item is correlation
  (`request_ids`/`console_ids` on fed operations), not a missing action.
- **Correction to the local_auth status entry (2026-11-24 round 30)**: this
  supersedes the round-10/11 statements that
  `system.status.local_auth.last_unpaired_attempt` "stays null (not tracked)".
  `0.4/daemon/local-auth.mjs` now records the last rejected `authorize()` attempt
  in daemon memory (`deny()` → `{ at, reason, device_id? }`) and exposes a real
  `snapshot()` (`mode`, `daemon_id`, `paired_devices`, `last_unpaired_attempt`,
  device summaries, never a key); `server.mjs` derives the status view from that
  snapshot, so the field reports the concrete rejection reason instead of a
  hard-coded `null`. Boundaries: memory-only (daemon lifetime), no key/hash, and
  a fresh daemon honestly returns `null`. Evidence: `local-auth.test.mjs`
  20/20 (snapshot/rejection recording). **Classification is unchanged**:
  control plane 24/24 real, usable 71/77 (92.2%). The residual item is a
  **persisted** record across restarts plus the browser client plane.
- **Correction to the video entries (2026-11-24 round 33)**: this supersedes the
  round-7 decision "MP4 stays opt-in, AVI stays the default" and every earlier
  "tool.video stays partial because the BSK-param default is MJPEG AVI" note. The
  adapter default is now H.264/fMP4 (`format:"mp4"` capabilities, `mp4-verify`
  gating `playable`, typed `E_UNSUPPORTED` without an AVI fallback) while
  explicit `format:"avi"` preserves the local MJPEG AVI path, so `tool.video`
  is **full**: full 47 -> 48, partial 2 -> 1, usable **71/77 (92.2%) -> 72/77
  (93.5%)**. Remaining boundaries are non-semantic and stay recorded in §3.4: at
  that round the daemon-native `session-video` default was still MJPEG AVI and a
  recording had no fixed-tab identity — **both closed in round 39 (A4a)**, see the
  round-39 correction below — while the catalog stays daemon-owned (not
  browser/extension-owned). Evidence: `video-handlers` 15/15, `handler-codecs` 9/9,
  `live-runner` 22/22, eval 43/43 (incl. the real-Edge `video-default-mp4`
  case), test-all 1578 passed + 1 skipped.
- The coverage page and `0.4/scripts/bsk-coverage.mjs` classify the 0 partial and
  0 refused tools from hardcoded lists (audited by hand from the handler bodies),
  while the control-plane status is auto-derived from `transport.mjs` +
  `server.mjs`, so `local_auth.*` flipped to real without editing a list. The
  2026-11-23 refusal wave edited the tool lists in the same change, and the
  2026-11-24 debug round removed `tool.debug` from the partial list, round 33
  removed `tool.video`, round 34 emptied `REFUSED_TOOLS` (the four session/tab
  methods are audited full via `EXTENSION_INGRESS_TOOLS` and the report's `[3c]`
  block), and round 36 emptied `PARTIAL_TOOLS` (`tool.cooperate` moved to
  `CAVEATED_FULL_TOOLS`, printed in `[3e]`), so the page no longer claims partial
  success that no longer exists.
- **Correction to sections 2/3.5/3.6 (2026-11-24, round 34)**: the "tab borrow /
  Agent Window: no channel" call and the OOS decisions for
  `tool.session_start`/`session_stop`/`tab_borrow`/`tab_return` are **superseded**
  by the opt-in MV3 extension ingress: the four methods are **full** with the
  injected extension client (real headed-Edge E2E 87/87 on live `chrome.*` state)
  and keep the typed `E_UNSUPPORTED` refusal before any effect when no extension
  client is injected. "Refused today" is no longer true, but the default
  no-extension behavior is still an honest refusal — not coverage — and the
  stage gate loads the extension only with `--with-extension`.
- Nothing here is BSK parity. Out-of-scope items are honest refusals, not
  coverage; LATER items keep their caveats until the named trigger fires.
  `tool.cooperate` is delivered capability and is **full** as of round 36, but
  as **caveated-full** (not unconditional): its action gate covers the adapter
  click/hover/select/fill/press/drag entries, round 35 closed the human-vs-agent
  attribution and `document_token` staleness caveats (opt-in headed-Edge E2E
  96/96; strict doc-token 33/33), and round 36 gated the one-shot CLI input paths
  behind the explicit `--cooperate-gate` flag (13/13). The written scope
  conditions are: opt-in MV3 content script for human attribution (without it the
  human/paused gate is not armed), `--cooperate-gate` for one-shot CLI gating
  (without it those paths keep the pre-round ungated behavior), and per-process
  state (a documented boundary).
- **Correction to this page's earlier cooperate boundary (2026-11-23 round 6)**:
  "the negotiated `control_policy` gates only cooperate's own page-writing
  channel (generic `tool.click`/`fill`/`press` are not gated)" and "the CLI
  exposes only `enable`/`status`" were true before round 6 and are now
  superseded. The gate is injected into the DOM action factories (and by the
  daemon fallback), and the CLI exposes `--session-cooperate-enable/sync/status/
  wait` with token flags. The remaining limits are listed in section 3.2; since
  round 36 the classification is **full under written scope conditions**
  (`[3e]`), not partial.
- **Line numbers move during this round** (daemon and CLI files are edited
  concurrently), so evidence is cited by file + symbol, not by line.
- Two previously unwired modules (`collaboration/src/overlay.js`,
  `browser-adapter/src/overlay-render.js`) now sit on live paths via
  `request_help` and `tool.cooperate`; they are cited as carriers, not as BSK
  parity.
- **Correction to the video/debug/session/tab boundaries (2026-11-24 round 39,
  A3a/A3b/A4a/A4b)**: this supersedes the earlier "remaining boundary" wording
  that this page and the coverage dashboard carried:
  - **video** — "the daemon-native `session-video` default is still MJPEG AVI"
    and "a recording has no fixed-tab identity" are **no longer true**: the
    daemon default is MP4 and every recording/catalog entry carries the session
    target's fixed `tab_id`/`window_id` plus `owner:'daemon'` (unknown identity is
    `null`, never fabricated). The only video boundary left is a
    **browser/extension-owned** catalog with fixed-tab authorization
    (`owner:'extension'` is reserved, never written). See §3.4.
  - **debug** — "replay is a Node `fetch` re-send (not browser-originated)" and
    "fed operations carry no `request_ids`/`console_ids` links" are **closed**:
    replay now defaults to `source:"browser"` (in-page `fetch` over CDP
    `Runtime.evaluate`, Node `fetch` only as explicit `fallback:true`), and a fed
    operation carries the bounded correlation ids (a miss stays empty). See §3.3.
  - **session/tab** — the round-34 description only promised a real Agent Window
    and a move/return; round 39 adds the written semantics: observed-tab
    ownership, page-opened-tab routing back to a user window (never a default
    target), the single `session_stop` teardown order, the real borrow
    confirmation UI (fail-closed deny/timeout) and borrow-fidelity restore
    (group/pinned/neighbour/fallback). The three A3a stable codes
    `E_BORROW_DENIED`/`E_BORROW_TIMEOUT`/`E_TAB_PIN_FAILED` are registered in the
    ingress error table. See §3.5/§3.6.
  - **No classification changes**: full 53, partial 0, refused 0, usable 77/77
    with the same `[3c]`/`[3e]` opt-in scope conditions; round 39 refreshed the
    evidence (`[3f]` in the coverage report), it did not relax a condition.

## 8. Benchmark gate policy: the 2-session speedup is reported, not gated (2026-11-23)

- **Decision**: `0.4/bench` still measures both concurrency waves (2 and 4
  independent daemon sessions), but only the **4-session** wave is a gate
  (`concurrency-4-speedup` >= 1.75x, `concurrency-4-throughput` >= 80
  actions/s). The 2-session speedup stays in
  `measurements.concurrency[0].speedupVsSequential` and in the saved-baseline
  prose, but it has **no `checks[]` record**: a 2-session ratio miss does not
  fail a run. That is why the check count is **21** and the old
  `concurrency-2-speedup` id no longer exists.
- **Why**: the removed `concurrency-2-speedup` (>= 1.6x) check was flaky by
  measurement, not by product. Identical quick runs on this machine measured
  1.48x / 1.81x / 2.48x at 3 actions/session; after raising both waves to
  **8 actions/session (quick) / 10 (full)**, repeated quick runs still measured
  **1.05x-1.20x**, because one ~800 ms stall in a single session is enough to
  halve the ratio at n=8 (the saved 2026-11-23T15:47Z baseline measured
  **1.08x**). Round 24's **21/22** run was exactly this: only the 2-session
  ratio missed (1.49x), every other check passed. A gate that fires on OS
  scheduling noise trains people to ignore it.
- **What replaces it**: the 4-session wave runs 8 (quick) / 10 (full) actions
  per session across four browsers, so a one-session stall is diluted by the
  other three; it keeps both the speedup and the absolute-throughput gates.
  The absolute daemon/cold-path latencies (`daemon-act-p95`,
  `daemon-observe-p95`, `daemon-session-open`, the cold CLI p95s) remain gates.
  The 2-session number is still printed and compared in prose every run, so a
  real 2x-class regression would still be visible - it is just not a pass/fail
  bit.
- **Scope boundary**: this is a methodology change to our **own internal
  baseline**, not a BSK comparison (no Rust toolchain here; see the bench
  README's BSK section). `loopSizes` in `0.4/bench/run.mjs` is the single source
  of truth for sample counts (quick: 3 one-shot, 8 acts, 8 actions/session,
  2 warm observes; full: 5 / 20 / 10 / 3), `DEFAULT_THRESHOLDS` is the single
  source of truth for the gates, and `0.4/bench/README.md` records both with the
  saved run. Changing either is a methodology change and must be stated in
  `0.4/STATUS.md` and `docs/TEST-STATUS.md`.

## 9. Dependency policy update: available dependency, capability first (2026-11-24)

- **Decision**: the project no longer refuses a real capability merely because
  delivering it would need a dependency. If a capability is required by a user
  flow and a dependency that is already available to the build (Node built-ins,
  a vendored module under `vendor/`, or an already-approved package) can deliver
  it, take the capability first and record the dependency (version, license,
  source, test evidence) per `docs/DEPENDENCIES.md`. "Zero dependency" is a
  preference, not a gate. **Runtime npm installs stay forbidden**, the 0.3.0
  freeze stays, and an unvendorable/unlicensable dependency is still out of
  scope.
- **Why now**: `local_auth.*` was OOS on "no client plane to pair" grounds, not
  because the capability was unwanted. The trust store needed only `node:crypto`
  (random ids/codes/keys, per-secret salted SHA-256 hashes, timing-safe compare)
  and `node:fs` atomic writes, so it landed in 0.4 with **no new package and no
  new vendored module**. This round added **zero** packages.
- **Effect**: control plane **19 -> 24/24 real** (usable **65 -> 70/77** at that
  round); the remaining gap then was the 3 partial + 4 refused `tool.*` handlers
  (after round 29's debug-full close it was 2 partial + 4 refused, usable
  71/77; round 33's video-full close made it 1 partial + 4 refused, usable
  72/77 (93.5%); round 34's opt-in extension ingress made it 1 partial + 0
  refused, usable 76/77 (98.7%); round 36's `tool.cooperate` caveated-full makes
  it **0 partial + 0 refused, usable 77/77 (100.0%)**, scope-conditioned as the
  dashboard's `[3c]`/`[3e]` blocks state). Section 5 records
  what is still missing (a browser client plane consuming the credential) and
  the residual risks.
- **What does not change**: the usable line in section 1 still applies (a real
  handler on a live ingress, proven by tests); metadata-only code and
  success-without-effect code is still negative coverage.
- **Risk record update (2026-11-24, round 28)**: the round-27 risk recorded in
  section 5 ("a non-loopback `--host` exposes `pair`") is **mitigated**:
  `transport.mjs` now enforces loopback-only for `publicMethods` (403 +
  `E_LOCAL_ONLY`), the WS transport never served `pair`, and the default bind
  remains `127.0.0.1`. No dependency and no policy change was needed for it.

## 10. Credential-free public methods are loopback-only (2026-11-24, round 28)

- **Decision**: an unauthenticated `publicMethods` entry (today only the
  `local_auth.pair` bootstrap) is served **only to a loopback peer**. A request
  from any other address is answered `403` with `data.daemonCode =
  "E_LOCAL_ONLY"` (JSON-RPC error code -32001 `unauthorized`) and never reaches
  the handler. This is enforced in the transport, not by the handler, so a future
  public method inherits the same boundary.
- **Implementation**: `0.4/daemon/transport.mjs` — `isLoopbackAddress()` (also
  the `trust_local` hint) and the new exported
  `publicMethodAccess(method, publicMethods, address)`; the unauthorized-body
  prescan calls it before replaying the envelope, and `server.mjs` /
  `transport.mjs` module headers state the contract. The WS transport
  (`ws-transport.mjs`) has no public/pair route: the upgrade handshake is its auth
  boundary, so a tokenless client pairs over HTTP only.
- **Why not a handler check**: the pair handler cannot know the peer address, and
  a per-handler check would silently not apply to the next credential-free method.
  The transport already owns auth and the loopback hint, so the rule lives there.
- **Evidence**: `transport.test.mjs` 27/27 (`publicMethodAccess` covers
  `127.0.0.1`, `::1` and `::ffff:127.0.0.1` allow; `192.168.1.20` / `10.0.0.5`
  deny; non-listed methods stay non-public on loopback); test-all 1519/1519.
- **Residual**: `trust_local` mode still accepts any loopback connection without a
  credential by design; no browser client plane consumes the paired credential
  yet; `last_unpaired_attempt` is now tracked in daemon memory (round 30:
  `at`/`reason`/`device_id`, never persisted, no secret) but not persisted across
  restarts.

## 11. Wave B performance boundaries: lazy CLI, opt-in warm pool, bench budgets, BSK unavailable (2026-11-24, round 40)

This section records what Wave B's optimizations and its new gates **do and do
not** claim. It is a boundary record, not a capability claim.

### 11.1 CLI cold start (B2): laziness is a bootstrap boundary, not a speed claim on the browser path

- `0.4/cli/bridge-remote.mjs` no longer imports the one-shot/daemon runtime
  modules at the top of the file. `runCli` returns on `--help` / usage / argument
  errors **before** `loadOneShotRuntime()` / `loadDaemonRuntime()` are awaited, so
  those paths never parse/instantiate the ~2 MB of adapter/protocol source.
- Measured by B2: help and pure argument-validation paths **p50 -46.9% / p95
  -47.9%**, module graph **-77%**; re-checked round 40 on the current tree:
  `--help` 74-95 ms (5 runs) and a bad-flag usage error 84 ms / exit 2.
- **Boundary**: the browser-launch one-shot path still loads the same modules and
  its p95 (~3.4-3.7 s in the committed baseline) is browser-launch dominated. The
  lazy import is **not** a claim that a real one-shot collect got faster, and the
  bench one-shot table must not be read as a B2 improvement. Behavior is
  unchanged: the whole unit suite (including `bridge-remote.test.mjs`) passes.

### 11.2 Warm browser pool (B3): opt-in only, the default stays lazy, and the baseline is cold

- Two ways to opt in: `node 0.4/daemon/server.mjs --warm-browser`, or
  `BB_DAEMON_WARM=1` (only `1`/`true`/`yes`/`on`, case-insensitive, opt in — see
  `warmBrowserFromEnv`). Default (no flag, no env) is unchanged: the browser
  launches on the first `session.open`.
- Mechanism: `browser-daemon.prewarm()` runs the same `start()` (launch + browser
  CDP connect) up front, idempotently and without opening a tab; the server runs
  it concurrently with `transport.listen()` and only reports ready once the
  browser is warm; a later `session.open` only creates its own target, and
  `session.close` keeps the browser alive (`stop()` still closes it). A failed
  prewarm is **fail-soft**: the daemon still serves, `warmReady` stays false,
  `session.open` retries the launch and surfaces the real error.
- Measured round 40 on this machine, real headless Edge, 2 runs each: default
  startup **120.5 / 120.9 ms** with first `session.open` **695.1 / 685.2 ms**;
  warm startup **572.4 / 566.0 ms** with first `session.open` **188.0 / 198.9
  ms**. B3 recorded the same shape (session.open median 657 → 175 ms, startup
  140 → 550 ms). The ~0.45 s moves from the first session open into startup and
  stays far inside the 1,500 ms `daemon-startup` gate.
- **Boundaries**: (1) the pool is **off by default** — the committed baseline,
  the budgets and the `daemon-startup` / `daemon-session-open` rows are all
  measured on the cold path, so warm-pool numbers are never compared with them as
  an improvement of the saved baseline; (2) enabling it trades startup for first
  session open (a deployment decision, not free latency); (3) it changes **when**
  the browser launches, not session semantics — recovery on a warm browser is
  covered by `server.test.mjs` (`warm: true keeps recovery working on the warm
  browser`), and the prewarm failure path is tested fail-soft.

### 11.3 Bench budgets (B1): a budget may tighten the bench gate, never loosen it

- `0.4/bench/budgets.json` records one maximum or minimum per bench check with
  its baseline actual, baseline timestamp, limit, headroom and rationale. The
  budgets are deliberately **tighter** than `DEFAULT_THRESHOLDS` in `run.mjs`;
  `budget-check.mjs` treats these as `E_INVALID` input errors (exit 2), never
  PASS: a limit looser than the recorded bench threshold, headroom that does not
  equal `limit/baseline` (or `baseline/limit` for a floor), a budgeted metric
  missing from the report or `null`, malformed JSON/schema, duplicate ids, a
  zero baseline with a ratio.
- The stage gate's opt-in `bench quick` step runs `run.mjs --quick --json
  --no-write` and pipes that report through `budget-check.mjs --stdin --json`
  **inside the same step**, so the saved baseline is never overwritten and the
  documented step counts (18 default / 20 with `--with-extension`) do not change.
- Round 40 refreshed the baseline to `2026-11-24T04:51:01.592Z` and re-recorded
  the new actuals + recomputed headroom; **no limit was raised** (the observed
  baselines stayed inside the existing limits). A future baseline refresh must
  keep the same rule: record the new actuals, recompute the metadata, and never
  raise a limit to make a run pass.

### 11.4 BSK 0.5.0 comparison: unavailable, and no BSK number is implied

- This workspace has no Rust toolchain (`bsk.rustc`/`bsk.cargo` are `null` in the
  bench report), so `ref/bsk-0.5.0-src` is neither built nor benchmarked, and the
  prebuilt `ref/bsk-0.5.0-bin/bsk.exe` is not driven by this harness. The bench
  thresholds are **internal targets**, not measured BSK values.
- `0.4/bench/BSK-BASELINE.md` is the method to produce a real same-machine
  baseline (build, extension, metric mapping, `bsk-results.json` schema,
  unavailable declaration template). `bsk-compare.mjs` compares a real
  `bsk-results.json` with `results/latest.json`; with no baseline file it prints
  `status: "unavailable"` + the build guide and exits 0. Tests
  (`bsk-compare.test.mjs` 19/19) use fake JSON only — a fake fixture is never a
  measured BSK number.

### 11.5 Quick-run flake is recorded, not smoothed away

Three consecutive round-40 quick runs on the same machine (background Edge window
open) measured one-shot p95: observe 3,720 / 3,686 / 3,701 ms, click 4,239 /
3,562 / 3,494 ms, fill **5,326** / 3,468 / 3,506 ms, and 4-session speedup 3.39x /
2.74x / 1.96x. The first run's fill spike is one slow sample out of three, not a
code change; the committed baseline is the second run (all 21 checks and all 21
budgets pass, mid-range ratio). A single quick report — including a failed budget
row or a failed bench check — is therefore a **sample**, not a verdict: repeat it
(or run full mode on a quiet machine) before calling a regression, exactly as
`0.4/bench/README.md` says. No threshold, budget limit or assertion was changed
because of this variance.

## 12. Wave C boundaries: multi-tenant MVP, resumable-transfer store layer, default-compatible VOM (2026-11-24, round 42)

This section records what the first Wave C slice (round 42: VOM depth, multi-tenant
MVP, resumable transfer store) **does and does not** claim. It is a boundary
record, not a capability or parity claim.

### 12.1 Multi-tenant MVP (round-42 baseline; three boundaries below were superseded in round 44 — see §14)

- Config is `createDaemonServer({ tenants: [...] })` (array or id-keyed object),
  one entry per tenant `{ id, token, browser?: 'edge'|'chrome', maxSessions?,
  artifactDir? }`. Bad config fails at construction (duplicate id/token, unsafe
  id, unknown browser, non-positive quota) before a listener or browser exists;
  omitting `tenants` keeps the exact pre-tenant 0.4 behaviour (single legacy
  bearer token, no scoping) — that regression is asserted by `server.test.mjs`
  and `browser-daemon.test.mjs`.
- Tokens: every configured token is compared in constant time (SHA-256 digest +
  `crypto.timingSafeEqual`, no early exit), and `list()`/`status()`/`system.status
  .tenants` return only sanitized views (`id`, `browser`, `max_sessions`,
  `artifact_dir`, active count) — never a token. A request's tenant is resolved
  per request and carried in an `AsyncLocalStorage` scope, so concurrent requests
  cannot observe each other's tenant; a direct/tool handler call has no tenant and
  behaves like pre-tenant 0.4.
- Isolation: a tenant sees only its own sessions (`session.list`/`status`/
  `session.recover`/`tab.*`/`stop_all`/`cancel` are scoped or answer like an
  unknown id); cross-tenant session ids fail closed with the same shape as an
  unknown id (no existence oracle). `session.open` enforces `maxSessions`
  (`E_LIMIT`; in-flight opens are counted so the quota read does not race;
  recovered/ended/closed records never consume quota) and each tenant gets its
  own artifact root (`<baseArtifactDir>/tenants/<id>` unless configured).
- **Boundary — one browser process** *(round-42 baseline; superseded by §14.1 in
  round 44: a mixed tenant config now runs one Edge instance and one Chrome
  instance in the same daemon, and each session is routed to its tenant's browser
  kind)*. One daemon ran **one** browser. The launcher kind was pinned only when
  every tenant agreed on `edge`/`chrome`; a mixed config kept the legacy
  **Edge-first discovery** and each session recorded the browser actually running
  (never an invented one). The tenant `browser` field was a selection hint, not
  per-session browser processes.
- **Boundary — HTTP Bearer only** *(round-42 baseline; superseded by §14.2 in
  round 44: the WS/WSS connection keeps the credential/tenant resolved at the
  upgrade, so tenant-scoped methods work over WS with cross-tenant refusal)*.
  Tenant identity came from the authenticated HTTP Bearer credential; the
  WebSocket transport had no tenant identity, so a multi-tenant WS/WSS request
  that needed a session failed closed (`E_TENANT_REQUIRED`) instead of falling
  back to a global view. Only tenant-neutral bootstrap/health methods were
  reachable without a tenant.
- **Boundary — daemon-global planes are forbidden in multi-tenant mode.** With
  the current on-disk schemas, catalog/WAL/transfer/ledger/audit objects cannot
  be attributed to one tenant, so `record.list`, `video.list/save/discard`,
  `ledger.*`, `audit.request` and `transfer.*` answer typed
  `E_TENANT_UNSUPPORTED` (wire `unsupported`) rather than leak another tenant's
  ids. Session-scoped artifact methods (`video.start/stop/status`, `debug.*`,
  `record.start/stop/get`) stay available once the named session is proven to be
  the tenant's. Methods that would implicitly resolve "the latest session"
  (`observe`, `act`, `tabs`, `navigate`, `tab.list`, `tab.close`,
  `session.run_log`) require an explicit `session_id` in multi-tenant mode.
- **Boundary — in-memory tenant tags** *(round-42 baseline; superseded by
  §14.3 in round 44: `session-store` now persists optional
  `tenant_id`/`browser` tags, and a restarted daemon can attribute and recover a
  tenant session in its own browser — a pre-tenant record still fails closed)*.
  The default session store did not persist a tenant tag, so `session.recover`
  for a legacy/untagged record failed closed for a tenant request, and the
  recovered-session tag map was daemon memory (a restart dropped it). Per-tenant
  artifacts were created lazily on `session.open`.
- Evidence (round-42 tree): `tenant-registry.test.mjs` **12/12**,
  `server.test.mjs` **96/96**, `browser-daemon.test.mjs` **74/74**. Not measured
  at round 42: a headed Chrome tenant E2E (browser kind selection was
  unit-tested), quotas across daemon restarts (they are per-process), and
  multi-tenant WSS. Round 44 measured WS tenant identity + mixed per-tenant
  Edge/Chrome + tag persistence in the unit/integration suites (§14), and still
  did **not** claim a real headed Edge+Chrome side-by-side E2E. **Round 45 landed
  that E2E for real** (headless Edge tenant + headless Chrome tenant side by side
  in one daemon, §15.1): the fake-launcher-only boundary below is superseded for
  the headless launcher path, while headed windows and the extension ingress plane
  remain unmeasured for tenants, and quotas are still per-process (not
  persisted).

### 12.2 Resumable transfer: real store layer, no WSS client wiring yet

- `0.4/daemon/transfer-store.mjs` is a real resumable, chunked byte store:
  positional `chunk({ offset, data|bytes, sha256? })` accepts out-of-order
  chunks and repairs; a duplicate identical range is an idempotent no-op and a
  different byte in a staged range is `E_TRANSFER_CONFLICT` unless
  `replace: true`; `resume({ transfer_id })` reports exact sorted/merged
  `ranges`, `missing`, contiguous `received`, `received_bytes`, `next_offset` /
  `next_index` and `complete`; `finalize({ transfer_id, sha256? })` requires a
  gap-free transfer, verifies a caller digest, and commits with fsync +
  atomic rename (a digest mismatch is retryable `E_INTEGRITY`, keeps bytes and
  the transfer open); a `writer_id` makes it single-writer (`E_TRANSFER_BUSY` for
  other writers); TTL sweeps, `maxChunkSize`/`maxTransferBytes`/`maxActiveTransfers`
  /`maxChunksPerTransfer`/`maxReadBytes` bounds, path-only-output (`path` is
  returned, never accepted) and `release` are implemented. The legacy BSK wire
  shapes (`begin`/`chunk`/`finish`/`read`/`release`, `E_TRANSFER_DIGEST`, the
  strict append `index` spelling) are unchanged; `finalize`/`resume` are additive
  store methods.
- **Boundary — wire exposure.** `transport.METHODS_04` still exposes only the
  legacy five `transfer.*` methods; `transfer.finalize`/`transfer.resume` have
  **no wire route yet**, and no client (CLI/MCP/DSH tool) calls them. The
  `transfer.resume` result is the authoritative reconnect answer for a future
  sender, but the **WSS reconnect wiring** (client reconnect policy, resume
  negotiation, retransmit of missing ranges, TLS/WSS transport path) is not
  implemented or verified. Cross-machine transfer over TLS/WSS remains
  unmeasured.
- **Boundary — multi-tenant.** `transfer.*` is one of the daemon-global planes
  refused in multi-tenant mode (see 12.1); transfer staging is not yet
  attributable to a tenant.
- Evidence (round-42 tree): `transfer-store.test.mjs` **15/15** (out-of-order
  resume, duplicate/conflict/replace, chunk sha256, gap/size errors,
  digest-mismatch retry, idempotent finalize, writer ownership, TTL/limits,
  atomic commit). Not measured: a real 100 MB / disconnect-reconnect run.

### 12.3 VOM depth is default-compatible: the six-stage funnel, typed affordances, layers/activeRegion, stable-ref negotiation and pagination

- `0.4/packages/vom` now exposes the BSK-shaped depth as **opt-in reporting or
  opt-in policy on top of the unchanged default render**:
  - **six-stage funnel** (`funnel.js`): `raw → filter → interactive → typed →
    layers → refs → budget`, each stage with a count and `drops` reasons;
    `predicates.<stage>` can override a stage and `dedupeKey` can override dedupe;
    the legacy `raw/visible/semantic/addressable/deduped/emitted` counters are
    preserved, so `runFunnel` output stays byte-compatible unless `withFunnel` is
    requested.
  - **typed affordances** (`affordance.js`): `kind` (unchanged values) plus the
    additive `type` (`activate/navigate/toggle/select/input/adjust/drag/drop/
    read/structure/visual/unavailable`), `actions` and `target`; rendered only
    with `withAffordanceTypes` (or by reading the classifier directly).
  - **layers / activeRegion** (`layers.js`, `active-region.js`): L1 page vs L2
    overlay candidates (positioned + non-`pointer-events:none`, explicit modal
    fallback for legacy fixtures; a page-level overlay must cover the viewport
    within 1 px), and the explicit `activeRegionPolicy` removes interactive/
    readable targets occluded by a higher-paint-order positioned region using
    9-point sampling, ancestor/descendant exemption and same-document paint-order
    comparison. **Both are off by default.**
  - **stable refs** (`identity.js`): `stableRef` from a FNV-1a signature plus
    cross-snapshot negotiation (reuse on unique signature, re-assign for new
    nodes, `invalidated` for vanished refs, conflict → old identity invalid,
    same-name ordering with `-2/-3` suffixes); activated by
    `previousNodes`/`refNegotiator`, not by default.
  - **pagination / byte budget** (`render.js`, `observe.js`): `pageSize` /
    `cursor` / `maxTokens` / `maxBytes` on `renderVom` (cursor carries the
    offset + budgets; last page has `next_cursor: null`), and
    `prepareObservationRender` returns `headers` + one page + `nextCursor` with a
    reserved footer only when more lines remain; no budget means one full
    output, exactly the pre-pagination behaviour.
  - **diagnostics** (`render.js`): `withActiveRegion` per-node marks
    (`occluded/outside/partial/active/unknown`), `viewportPolicy` viewport
    clipping and `funnel` in the result are all opt-in fields; the default
    rendered text/lines are unchanged.
- **Boundary**: the funnel counts are diagnostics, not business decisions; the
  strategies never change the default render (opt-in only) and are not a claim
  that every BSK visual-observation heuristic is ported. Evidence (round-42
  tree): `0.4/packages/vom/test` **156/156** across funnel fidelity,
  typed-affordance, stable-ref negotiation, active-region marking,
  pagination-bytes and the existing VOM suites.

## 13. Wave C second slice: transfer wire, offline replay/crash injection, read-only dashboard (2026-11-24, round 43)

This section records what the second Wave C slice **does and does not** claim:
the resumable-transfer wire, deterministic replay + crash injection, and the
read-only dashboard/trace UI. It is a boundary record, not a parity claim, and
the coverage classification is unchanged (usable **77/77** scope-conditioned,
full 53 / partial 0 / refused 0).

### 13.1 Resumable transfer is wired end to end; automatic client reconnect is still not

- `0.4/daemon/transport.mjs` `METHODS_04` now advertises `transfer.resume` and
  `transfer.finalize` next to the legacy five (`begin`/`chunk`/`finish`/`read`/
  `release`, whose shapes are unchanged), `server.mjs` routes both
  (`BSK_MAPPED_METHODS`), and `initialize.limits.transfer.resume/finalize` is
  `true`. Both are reachable over **HTTP and WebSocket** with the same result
  validation as the retained `transfer.*` methods, and the CLI exposes
  `--transfer-resume <ID>` / `--transfer-finalize <ID> [SHA256]`
  (`0.4/cli/bridge-daemon-client.mjs`, `0.4/cli/bridge-remote.mjs`).
- Semantics: `transfer.resume { transfer_id }` is the authoritative reconnect
  answer — sorted/merged `ranges`, `missing`, contiguous `received`,
  `received_bytes`, `next_offset`/`next_index`, `complete`, plus the staged
  `name`/`mime`/`size`/`status`. `transfer.finalize { transfer_id, sha256? }`
  requires a **gap-free** staged transfer, verifies the caller digest and commits
  with fsync + atomic rename; a digest mismatch is retryable `E_INTEGRITY` and
  keeps the bytes/open transfer, typed `E_TRANSFER_CONFLICT`/`E_TRANSFER_BUSY`/
  `E_TRANSFER_NOT_FOUND` stay distinguishable on the wire.
- Evidence (round-43 tree): `server.test.mjs` **98/98** (HTTP + WS
  resume/finalize round trips, offset chunks and repair, typed
  conflict/busy/not-found), `transport.test.mjs` **27/27** (method table),
  `ws-transport.test.mjs` **20/20** (HTTP/WS parity + result validation),
  `bridge-daemon-client.test.mjs` **96/96** (CLI flags, `E_INTEGRITY` kept as a
  typed daemon code).
- **Boundary — no automatic reconnect.** The wire now has a resume answer, but
  the **client-side reconnect policy** is still not implemented: no transport
  automatically reconnects a dropped socket, negotiates resume or retransmits
  the missing ranges — a caller must call `transfer.resume` and resend `missing`
  itself. A real **100 MB disconnect/reconnect over TLS/WSS** remains
  unmeasured, and `transfer.*` is still one of the daemon-global planes refused
  with `E_TENANT_UNSUPPORTED` in multi-tenant mode (see 12.1).

### 13.2 Deterministic replay: offline evidence analysis, not a browser re-execution driver

- `0.4/daemon/replay.mjs` is a pure, deterministic analyzer over the two durable
  evidence sources a real session leaves behind: the **TraceV3** document
  (`session-record.mjs` / `record.stop`) and the daemon **action WAL**
  (`daemon-wal.mjs`). It validates step order (step ids must be 1..N), state
  references, op shapes, `target.ref` resolvability inside the pre-state body
  (a `truncated`/ref-less state degrades to `unverifiable`, not drift), and
  `steps_here` annotations; it **derives** each step's `effect_state` and
  cross-checks WAL-committed intents against recorded trace steps.
- `effect_state` is derived, never read (TraceV3 has no such field; its wire
  schema is `additionalProperties:false`): a recorded step is `committed`
  because `browser-daemon.mjs` only records an act after it succeeded; WAL
  `done`→`committed`, `failed`→`none`, `prepared`/`dispatched`→`unproven`,
  `unknown`→`unknown`. The session terminal state is `unknown` as soon as any
  intent is unresolved — a committed sequence never masks UNKNOWN.
- Determinism is a contract: canonical JSON (object keys sorted, arrays kept in
  order) + SHA-256 `digest`, same input → same digest across calls and across
  restarts (verified by the crash-inject E2E). Drift is typed `E_REPLAY_DRIFT`
  with a complete `error.data.errors` list; an unreadable/invalid WAL is
  `E_REPLAY_WAL` — it is never silently treated as an empty WAL.
- **Boundary — no browser re-execution.** There is no "run the actions again"
  driver: 0.4 has no durable ref→element identity across observations (a ref is
  only valid within one observation), so re-dispatching would turn replay into
  guessing. What replay provides is the deterministic, reviewable action
  sequence (op/target/state order + digest) that a crash-injection test can
  compare against. Additional written limits: `drag`/`focus`/`blur` have no
  TraceV3 step variant (they are reported as `unrecordable_method` warnings and
  never faked as steps), `navigate` bypasses the action WAL (reported as a
  `navigate_plane` warning when the WAL has content), and operator
  `ledger.resolve()` outcomes carry `evidence:"operator"` (an assertion, not an
  observed effect).
- Evidence (round-43 tree): `replay.test.mjs` **24/24** (determinism, digest
  round-trip through disk, ref/truncated degradation, order/shape/schema drift,
  unknown stays UNKNOWN, operator evidence, session scoping) and the
  crash-inject E2E **12/12**.

### 13.3 Crash injection: the crash point is the WAL dispatched→settled gap

- `0.4/tests/crash-inject-e2e.mjs` is a standalone opt-in script, deliberately
  **not** named `*.test.mjs` so `test-all` never collects it (it starts a real
  daemon and headless Edge and restarts three times), and the stage gate runs it
  only with `--with-crash-inject` (gate cap 420 s, script watchdog 300 s
  overridable via `BB_E2E_TIMEOUT_MS`). Exit codes: `0` pass, `1` fail, `2`
  BLOCKED (no local Edge/Chrome) — and the gate treats a non-zero exit,
  including BLOCKED, as a **FAIL** step, never as a silent skip.
- What it proves on real Edge: run 1 records two committed acts (TraceV3 replay
  reproduces click→fill deterministically, fill value redacted), then leaves one
  click in flight — the WAL is polled until it is durably `dispatched`, the
  fixture server has actually received the page-side `/slow-click`, and the
  daemon+browser tree is SIGKILLed. Run 2 (same WAL, new daemon) shows
  `ledger.pending` listing it as `needsReconciliation`, replay reporting
  committed 2 / unresolved 1 / effect_state `unknown`, `resolve(unknown)`
  keeping it pending and `resolve(failed)` settling it. Run 3 shows the
  resolution persisted (`failed` + `resolution:"operator"` + timestamp, pending
  0) and replay digests identical across restarts.
- **Boundary.** The injected crash lands exactly between the durable WAL
  `dispatched` write and the settled write-back; the page-side effect of the
  crashed click is **unknowable by design** — the fixture only proves the click
  reached the page, and the WAL keeps the intent UNKNOWN until an operator
  resolves it (a `failed` resolution is an operator assertion, not an observed
  outcome). `--trace-store` has no CLI flag yet, so the script persists the
  `record.stop` TraceV3 itself (captured before the crash).

### 13.4 Dashboard: a read-only loopback operator view, not a control surface

- `0.4/dashboard/server.mjs` is a dependency-free `node:http` listener on
  `127.0.0.1` that serves one self-contained HTML page (inline CSS/JS; no
  framework, CDN, external font/image/script/link) and a thin JSON proxy in
  front of the daemon's existing HTTP JSON-RPC transport. Routes: `GET /`,
  `GET /api/status` (`daemon.status` + `session.list` + `system.status` fanned
  out concurrently and reduced to `{ daemon, sessions, sessions_count, system,
  events, errors }`), `GET /api/trace?session_id=…[&since][&limit][&kinds]`
  (proxies `debug.query` and reduces the merged capture to `{ session_id,
  run_id, state, counts, next_since, truncated, events[] }`). Everything else is
  a JSON `404 E_NOT_FOUND`; every non-GET method is `405 E_METHOD_NOT_ALLOWED`.
- **Read-only.** The dashboard issues only the four read-only RPCs
  (`daemon.status`, `session.list`, `system.status`, `debug.query`) and adds no
  protocol surface to the daemon: there is no launch/stop/write route at all.
  The daemon Bearer token lives only in the outgoing `Authorization` header —
  the page never receives it, and the tests assert the token does not appear in
  the page/status/trace bodies or in the logs (the `runDashboardCli` startup
  line is token-free).
- **Honest failure mapping, no invented data**: socket refused → 503
  `E_DAEMON_UNREACHABLE`; RPC timeout → 503 `E_DAEMON_TIMEOUT`; upstream
  401/403 → 502 `E_DAEMON_AUTH`; other upstream HTTP error → 502
  `E_DAEMON_HTTP`; JSON-RPC error → 502 `E_DAEMON_RPC`; non-JSON/wrong id →
  502 `E_DAEMON_BAD_RESPONSE`; a daemon without `debug.query` → honest 501
  `E_NOT_SUPPORTED`; unknown session → 404 `E_UNKNOWN_SESSION`. A failed
  enrichment RPC keeps the primary result and reports the failure in
  `errors[]` — the dashboard never fabricates a trace/status field.
- **Startup (manual, documented; the gate has no dashboard smoke step)**: start
  the daemon (`node 0.4/daemon/server.mjs --port 0` prints one JSON line with
  `url`/`token`), then the dashboard
  (`node 0.4/dashboard/server.mjs --daemon-url <url> --token <token>` prints one
  JSON line with its `url`; `--port 0` picks an ephemeral port, `--host`
  defaults to `127.0.0.1`), then open the printed URL (the page refreshes every
  2 s). Exit codes: `0` started/`--help`, `1` cannot listen, `2` usage error.
  The full startup/troubleshooting description lives in
  `0.4/dashboard/README.md`.
- **Boundary**: it is an operator UI on loopback with **no authentication of its
  own** in the round-43 baseline (any local process that can reach the port can
  read it), so it must not be bound to `0.0.0.0`; it is view-only (no session
  launcher, no transfer controls) and therefore not the Wave D control surface.
  The dashboard suite is browser-free (fake loopback daemon + `fetch`) and runs in
  `test-all`; evidence at round 43: `dashboard/server.test.mjs` **20/20**.
  **Round 45 superseded this boundary** with the opt-in `--auth-token` dashboard
  authentication and the real `--tenants` multi-tenant fan-out (§15.3): the
  current suite is **39/39**, and the "no authentication / no tenant view"
  statements above describe the round-43 surface only (see
  `0.4/dashboard/README.md`).

### 13.5 Gate wiring for this slice

- `0.4/scripts/test-all.mjs` adds `0.4/dashboard/server.test.mjs` by explicit
  path (it sits outside every walk root) to the **browser-free regular 4-way
  group**; `0.4/daemon/replay.test.mjs` needs no entry (the `daemon/` walk root
  already collects it); the crash-inject E2E keeps its non-`*.test.mjs` name and
  is never collected by `test-all`.
- `0.4/scripts/stage-gate.mjs` gains the opt-in `--with-crash-inject` step
  (`crash inject`, browser lane, 420 s cap) placed after the extension steps and
  before the `remote` cleanup step; it is additive (+1) to any switch
  combination and does not change the default 17/18/19/20-step semantics
  (`--with-remote` 17, `--with-bench` 18, `--with-extension` 19, both 20,
  `--with-budget` 18/19/21 as before). The summary JSON adds `withCrashInject`.
  A `--with-dashboard` gate step was deliberately **not** added: the dashboard
  is browser-free and already covered by `test-all`, so wiring a second
  daemon+listener smoke into the gate would add wall time without new coverage;
  its manual startup is documented above and in `0.4/dashboard/README.md`.
## 14. Wave C3 boundaries (round 44): mixed-browser tenants, WS tenant identity, tag persistence, VOM passthrough, 100 MiB transfer

This section records the third Wave C slice. It is a boundary record, not a
parity claim: what the round-44 code really does, and what it deliberately does
**not** measure or claim.

### 14.1 Mixed Edge + Chrome tenants in one daemon

- **Landed.** `browser-daemon.mjs` owns one browser instance **per distinct
  browser kind** a tenant asks for: a mixed config (`edge` + `chrome`) launches
  (and keeps) both in the same daemon, `session.open { tenant, browser }` routes
  to the tenant's own instance, session listing is scoped to that instance, and
  `browser.list` never returns another tenant's tabs. The launcher decision is
  per tenant/browser kind (`browserKind`/`exe` are asserted with a fake
  launcher), not the round-42 Edge-first global pin.
- **Evidence (unit/integration, fake launcher).** `server.test.mjs` **102/102**
  (mixed tenant config launches two browser kinds, per-tenant WS identity,
  persisted tags/recovery, quota), `browser-daemon.test.mjs` **76/76**,
  `ws-transport.test.mjs` **22/22**, `session-store.test.mjs` **5/5**,
  `tenant-registry.test.mjs` **12/12** (217/217).
- **Boundary.** At round 44 the "2 browsers x 4 tenants" Wave C acceptance test
  was proven with the **fake launcher** (exe/args/instance routing), not with a
  real headed Edge+Chrome side-by-side E2E. **Round 45 added the real thing for
  the headless launcher path** (`0.4/tests/tenant-multi-browser-e2e.mjs`: one real
  Edge instance + one real Chrome instance in one daemon, §15.1) — headless, no
  extension, so a **headed** Edge+Chrome tenant E2E (window/visibility/focus) is
  still not claimed. Both browser kinds in one daemon cost memory/CPU and share
  the daemon process; per-tenant quotas remain per-process (not persisted), the
  daemon-global planes still fail closed `E_TENANT_UNSUPPORTED`, and no headed
  Chrome tenant E2E is claimed.

### 14.2 WS/WSS tenant identity

- **Landed.** The WebSocket transport keeps the credential accepted by the
  upgrade handshake (and the channel it came from) on the connection context;
  the server resolves the tenant from it per request — exactly like the HTTP
  Bearer — so tenant-scoped methods work over WS/WSS. Cross-tenant session ids
  are refused with the same shape as unknown ids (no existence oracle). A legacy
  non-tenant credential still authenticates the transport but is **not** a tenant
  identity: tenant-scoped methods stay fail-closed (`E_TENANT_REQUIRED`).
- **Evidence.** `server.test.mjs` 102/102 includes
  `multi-tenant: a WebSocket connection carries its tenant identity and rejects
  cross-tenant calls`; `ws-transport.test.mjs` 22/22 keeps the handshake/credential
  context contract (including the WSS test listener).
- **Boundary.** With a credential, identity, not a new credential type: the WS
  tenant still comes from the same Bearer tokens offered through the existing WS
  credential channels (subprotocol / `?token=`); `local_auth.*` device
  credentials are still not consumed by the WS transport, and there is no
  cross-machine tenant E2E.

### 14.3 Tenant tag persistence across restart

- **Landed.** `session-store.mjs` persists optional `tenant_id`/`browser` tags,
  only when the caller supplies them (a no-tenant daemon keeps the exact legacy
  record shape). A restarted daemon can attribute a recovered record to its
  tenant and reopen it in that tenant's browser; a record without a tag loads
  without one and stays invisible to every tenant (fail-closed, never guessed).
- **Evidence.** `session-store.test.mjs` 5/5 (legacy shape, additive tags,
  corruption tolerance, atomic write) and `browser-daemon.test.mjs` 76/76
  (restart keeps a Chrome tenant session tenant-owned; cross-tenant/legacy
  recovery refused with the same not_found answer).
- **Boundary.** Persistence covers the session tag only: the daemon-global planes
  (`record.list`, `video.list/save/discard`, `ledger.*`, `audit.request`,
  `transfer.*`) are still refused in tenant mode until their storage becomes
  tenant-attributable, and pre-tenant/untagged records cannot be adopted.

### 14.4 VOM passthrough in `tool.snapshot` / `tool.observe` and the CLI

- **Landed.** The four new VOM options are request-level and opt-in:
  `max_bytes` (>0, per-page UTF-8 byte budget; first-of `max_tokens`/`max_bytes`
  wins; an observe cursor carries the `:b<bytes>` suffix), `with_affordance_types`
  (inline typed-affordance badges), `with_active_region` (additive
  `result.active_region` marking) and `viewport_policy` (`clip`/`keep`); observe
  also accepts `page_size`/`pageSize` (default 100 lines). Invalid values are
  typed `E_INVALID_PARAMS` **before** any page capture/CDP round trip. Result
  fields (`bytes`, `active_region`) appear only when requested, so the default
  output stays byte-compatible; the BSK `SnapshotResult`/`ObserveResult` roots
  allow additive fields, so no codec change was needed. The one-shot CLI
  exposes `--max-bytes`, `--with-affordance-types`, `--with-active-region` and
  `--viewport-policy` for `--snapshot`/`--observe` (invalid combinations are
  rejected by the CLI parser).
- **Evidence.** `snapshot-handlers.test.mjs` **15/15** (option validation,
  byte-paginated observe pages, typed/activeRegion marks, default shape
  unchanged), CLI parser tests, and a real headless-Edge CLI run (max_bytes
  pagination continuation, typed affordance badges, activeRegion marks).
- **Boundary.** This is a **passthrough of opt-in reporting/pagination
  options**, not a port of BSK's visual-observation heuristics. `max_bytes` on
  `tool.snapshot` is a hard cap (`truncated:true`, no cursor: snapshot has no
  cursor contract); paginated continuation is an `observe` feature only.

### 14.5 100 MiB resumable-transfer E2E over WSS/WS

- **Landed (`0.4/tests/transfer-resume-e2e.mjs`).** A browser-free E2E that
  starts the real daemon (`createDaemonServer { ws: true, wsPort: 0, transferDir,
  wsMaxFrameBytes }`), tries **WSS first** with the daemon suite's embedded
  self-signed PKCS#12 fixture (subject `localhost`/`127.0.0.1`, passphrase
  `bdtest`) and falls back to plain WS only if WSS cannot be established,
  recording `tls.mode`/`tls.fallbackReason`. It builds deterministic 100 MiB
  content **streaming** (one reusable 1 MiB buffer; periodic 64 KiB pattern +
  per-block salt, so any byte is a function of its absolute offset) and sends it
  as 1 MiB chunks through `transfer.begin` -> `transfer.chunk { offset }`. After
  30 confirmed chunks it closes the WebSocket (close code 4001) with one chunk
  still in flight, reconnects with a **brand-new** WS client, asks
  `transfer.resume`, resends **only** the reported `missing` ranges, then calls
  `transfer.finalize { sha256 }`, streams the published file back, compares it
  byte-for-byte with the generator and re-computes its SHA-256. It prints one
  JSON report, exits 0/1/2 (PASS/FAIL/BLOCKED) and removes its temp directory;
  the script watchdog is 240 s (`BB_E2E_TIMEOUT_MS` overrides it).
- **Measured.** Standalone `--repeat 1 --mode wss`: mode **wss**, 100 MiB
  verified byte-for-byte with a matching SHA-256, a real mid-transfer drop and
  resume, throughput recorded in the JSON report (load-sensitive sample, see the
  round-44 record in `docs/TEST-STATUS.md` #44 / `0.4/bench/README.md`); the
  forced `--mode ws` fallback and a two-run WSS default run also pass (D3 round).
- **Boundary — WS frame cap / chunk default.** The daemon's default WS frame cap
  is **1 MiB**, while a 1 MiB chunk becomes ~1.34 MiB as base64+JSON, so the
  unchanged daemon would close the connection. The E2E therefore raises the
  **existing** `wsMaxFrameBytes` option to 4 MiB (no `daemon/server.mjs` change)
  and records the probe. The **WS-safe product default stays `chunk_size`
  512 KiB**; this is an E2E configuration, not a new default.
- **Boundary — WSS client TLS.** Node's global `WebSocket` has no
  per-connection TLS options (`ws-transport.mjs` documents the ignored third
  argument), so the E2E opts **only its own process** out of certificate
  verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`) while talking to its own
  loopback self-signed test daemon: the traffic is still real TLS, only the
  self-signed test certificate is unverified. No client-verification claim is
  made beyond this test fixture.
- **Boundary — transfer plane only.** No browser, no extension ingress, no
  `daemon/server.mjs`/`store` changes, and `transfer.*` is still refused in
  multi-tenant mode. The client reconnect/resume policy lives **in the E2E
  script**: the product transport still does not auto-reconnect, negotiate
  resume or retransmit missing ranges; the wire only answers `transfer.resume`.

### 14.6 Gate wiring for this slice

- `0.4/scripts/stage-gate.mjs` gains the opt-in `--with-transfer` step
  (`transfer resume`, browser-free) that runs
  `transfer-resume-e2e.mjs --repeat 1 --mode auto --quiet --json` with a 420 s
  gate cap (script watchdog 240 s). It runs in its **own serial transfer lane**
  (cap 1) after the pure lane (`0.4 unit` included) and before the browser lane,
  so 100 MiB of loopback transfer + hashing never competes with a real browser
  step. Non-zero exit — including exit 2 BLOCKED (no WS transport) — is a FAIL
  step, never a silent skip. The wrapper adds honest report checks on top of the
  script's own assertions (parsable JSON, `ok===true`, exactly one run,
  `transfer.verified`, and published/file/expected SHA-256 equality); it does
  not weaken or replace the script's byte/digest/resume assertions. The summary
  JSON adds `withTransfer`, and the switch is orthogonal (+1) to every other
  switch: `--with-remote --with-transfer` is 18 steps, the default
  `--with-remote --with-bench` 18-step gate and the 19/20-step extension gates
  are unchanged.
- `0.4/scripts/test-all.mjs` needs no new path entry: the round-44 suites under
  `daemon/`, `packages/browser-adapter/test/` and `cli/` are inside existing walk
  roots and are collected automatically. `tests/transfer-resume-e2e.mjs`
  deliberately keeps a non-`*.test.mjs` name, so it is never collected by
  `test-all` (the regular group must not pay 100 MiB of transfer + hashing); the
  same is true of the crash-inject E2E (`--with-crash-inject`).

## 15. Wave C4 boundaries (round 45): real dual-browser tenants, product transfer client, authenticated multi-tenant dashboard

This section records the fourth Wave C slice. It is a boundary record, not a
parity claim: what the round-45 code really does, and what it deliberately does
**not** measure or claim.

### 15.1 Real dual-browser tenant E2E (E1)

- **Landed (`0.4/tests/tenant-multi-browser-e2e.mjs`).** A browser E2E that
  launches a **real Edge tenant and a real Chrome tenant side by side** in one
  daemon (`createDaemonServer({ tenants: [edge-t, chrome-t], ws: true, wsPort: 0,
  launcherOptions: { headless: true } })`, one session each, independent
  `artifactDir`). It asserts against the live processes/endpoints: each
  `session.open` really launches the tenant's own browser kind (launcher
  `browserKind`/`browserPath`/`pid` plus DevTools `/json/version`
  `Browser: Edg/*` vs `Chrome/*`), both browsers coexist (different pids, two CDP
  endpoints), `session.list` is tenant-scoped, a cross-tenant `sessionId` answers
  `not_found` (and does not close the other tenant's session/browser), the second
  same-tenant `session.open` is `E_LIMIT` (wire `payload_too_large` with
  `data.daemonCode = 'E_LIMIT'`, `maxSessions = 1`), the session-record
  `artifactDir` equals each tenant's configured directory with prefix-disjoint
  paths, and cleanup (session close -> `server.stop()` tree kill -> temp dir
  removal) leaves no browser process, no work root and no leaked profile
  directory. It prints one JSON report and exits 0/1/2 (PASS/FAIL/BLOCKED when
  Edge or Chrome is missing); a 240 s watchdog bounds it
  (`BB_E2E_TIMEOUT_MS` overrides).
- **Evidence.** Standalone `--repeat 1`: **PASS in 3.5 s / 10 checks** with real
  **Edge `Edg/158.0.4370.33` (pid 31420)** and **Chrome
  `Chrome/157.0.8103.80` (pid 11304)**; artifactDir isolation and every cleanup
  flag true. The E1 slice's own acceptance was **2/2 runs × 2** (`--repeat 2`)
  on the same machine; it is wired as the opt-in gate step `--with-tenant`
  (§15.4).
- **Boundary.** This is **headless** Edge/Chrome launched by the 0.4 launcher
  with **no extension** — it proves the daemon's per-tenant browser-instance +
  tenant session-scope chain, not the extension ingress plane and not headed
  window visibility/focus behaviour. `session.open` writes no artifact file, so
  isolation is asserted on the tenant-config path + real directory existence +
  prefix disjointness (no fabricated artifacts). The E2E is a test asset only:
  no daemon/extension/adapter behaviour was changed for it.
- **Boundary — global browser-instance view (measured, not hidden).**
  `daemon.status().browsers` (and `initialize.browser.browsers[]`) is a
  **global** browser-instance view: any authenticated tenant can see the other
  tenant's browser instance metadata (`browserKind`/`pid`/`wsEndpoint`/
  `browserPath`/`sessionCount`; the E2E asserts `browsers.length === 2` from the
  Edge tenant's own client). Tenant isolation covers `sessions[]` and the
  session/tab methods only — browser-instance metadata is **not** tenant-filtered
  at this revision, so this is a session-scope isolation claim, not a
  browser-instance-scope isolation claim.

### 15.2 Product-side resumable transfer client and `--transfer-upload` (E2)

- **Landed (`0.4/daemon/transfer-client.mjs`).** The reconnect/resume policy that
  used to live only in the E2E script is now a reusable product module:
  `uploadTransfer()` drives `transfer.begin` -> `transfer.chunk` (512 KiB default
  chunk, positional offsets) -> `transfer.resume` (only the daemon-reported
  missing ranges) -> `transfer.finalize { sha256 }`, with a locally computed
  whole-file SHA-256 (streamed from disk), per-chunk SHA-256 on by default,
  bounded exponential-backoff reconnects (`E_TRANSFER_RECONNECT_LIMIT` when
  exhausted), a separate retry budget for retryable daemon chunk errors,
  progress callbacks, an abort signal, typed `E_TRANSFER_*` errors and
  transport injection for tests. `createWsTransport`/`createHttpTransport` are
  the two production transports (WS `createWsClient` at `/ws`; plain JSON-RPC
  over HTTP). The CLI exposes the module as
  `--transfer-upload FILE [--chunk-size N] [--chunk-retries N]`, a composite
  daemon command (begin/chunk/resume/finalize), not a thin RPC.
- **Evidence.** `transfer-client.test.mjs` **16/16** (fake transports: lost ack
  with the chunk already staged, drop before staging, out-of-order resume gap,
  retryable chunk errors, bounded reconnect backoff, digest mismatch ->
  `E_TRANSFER_INTEGRITY` with no blind retry, abort, release-on-failure, typed
  argument/source errors, chunk-size clamping) plus two **real 0.4 daemon**
  runs over WS (clean 2 MiB upload and a mid-transfer drop that reconnects and
  resumes). `bridge-daemon-client.test.mjs` **105/105** includes
  `--transfer-upload` against a **real daemon over WS and over HTTP** publishing
  the file. CLI parser coverage lives in `bridge-remote.test.mjs` (18/18,
  including the daemon-mode `--transfer-upload` forwarding).
- **Boundary.** This is the **client-side policy**, not a transport
  auto-reconnect: a caller that does not use this module still has no automatic
  resume (the wire only answers `transfer.resume`). A begin response lost on the
  wire is retried after reconnect, which can leave one orphaned empty transfer
  for the daemon TTL sweeper (there is no release-on-begin-failure path).
  `resumes`/`missing_bytes`/`resent_bytes` describe resume calls that actually
  reported a gap. Client-originated errors are typed `E_TRANSFER_*`; daemon-side
  codes pass through unchanged. `transfer.*` is still refused in multi-tenant
  mode, there is no cross-machine/LAN E2E, and the WSS boundary (self-signed
  test certificate, process-wide client verification disabled) is unchanged.

### 15.3 Dashboard: opt-in dashboard auth and a real multi-tenant fan-out (E3)

- **Landed (`0.4/dashboard/server.mjs`, supersedes the round-43 "no
  authentication / no tenant view" boundary in §13.4).** The read-only loopback
  operator view now has two opt-in additions:
  - **`--auth-token`** (`$BB_DASHBOARD_TOKEN`): every `/api/*` route requires
    `Authorization: Bearer <token>` or `X-Dashboard-Token: <token>`; a
    missing/wrong credential answers `401 E_DASHBOARD_AUTH` **before any daemon
    call** (no upstream traffic). The comparison hashes both sides with SHA-256
    and uses a constant-time compare; the presented token is never logged,
    returned or echoed. The page shell `/` stays public (it carries no secret)
    and prompts for the token, keeping it in that browser's `localStorage` only
    and sending it as a request header (never a URL).
  - **`--tenants SPEC`** (`$BB_DASHBOARD_TENANTS`, inline JSON array or JSON
    file): a list of daemons `{ id, daemonUrl?, daemonToken? }` (ids 1–64 chars
    of `A-Z a-z 0-9 _ . : @ -`, unique, at most 16). `/api/status` fans out to
    **every tenant concurrently**; the result carries per-tenant
    `ok/daemon/sessions/system/events/errors`, aggregate
    `tenants_count`/`tenants_ok_count`, and a dead tenant never hides the
    healthy ones (its mapped error is its own `ok:false` entry plus a top-level
    `errors[]`). Status is `200` while at least one tenant answers, and the
    first mapped upstream status when all fail. `?tenant=ID` returns one tenant
    in the flat single-daemon shape (`404 E_UNKNOWN_TENANT` for unknown ids);
    `/api/trace` routes by tenant (`400 E_TENANT_REQUIRED` when several are
    configured and none is given). Each tenant's daemon token is used **only**
    in that tenant's outgoing `Authorization` header.
- **Evidence.** `dashboard/server.test.mjs` **39/39** (auth: 401 without/wrong
  credential and no daemon call, both `Authorization` and `X-Dashboard-Token`
  accepted, page shell public, token never in HTML/JSON/logs; multi-tenant:
  concurrent fan-out barrier, per-tenant tokens, dead-tenant isolation,
  aggregate status semantics, `?tenant=` filtering/unknown id, all-tenant
  failure, trace tenant routing; plus the original single-daemon shapes,
  501/404 trace paths, upstream error mapping and a token-free CLI startup
  line). The suite is browser-free (fake upstream HTTP JSON-RPC daemons) and
  runs inside `test-all`.
- **Boundary.** The dashboard token is **one shared secret**, not per-user
  accounts, and there is still no TLS: the bind default stays `127.0.0.1` and
  it must not be exposed beyond loopback without an authenticating reverse
  proxy. Tenants are configuration-level: the dashboard proxies each with its
  own daemon credential, it does not implement tenant discovery/registration,
  and the "all tenants" view is a health summary — cross-tenant session-list
  aggregation is still not offered (pick one tenant for detail). It remains
  **view-only** (no launch/stop/act/transfer controls), so it is still **not**
  the Wave D control surface.
  **(Round 46 superseded the account and write parts of this boundary — see
  §16.1: opt-in `--accounts` adds per-user viewer/operator accounts,
  HMAC-signed HttpOnly cookie sessions, CSRF, login throttling, tenant-scoped
  RBAC, an audit ring/file and three write routes (`session.open`,
  `session.close`, `session.act` limited to click/fill), suites 68/68. Still
  standing: no TLS, loopback-only bind, accounts from the operator's local
  JSON, sessions/lockout in memory, configuration-level tenants and a health
  summary "all tenants" view.)**

### 15.4 Gate and test wiring for this slice

- `0.4/scripts/stage-gate.mjs` gains the opt-in **`--with-tenant`** step
  (`tenant multi-browser`, **browser lane**, 420 s cap) that runs
  `tenant-multi-browser-e2e.mjs --repeat 1 --quiet`. Exit 2 BLOCKED (Edge or
  Chrome missing) is a FAIL step, never a silent skip; the wrapper additionally
  requires a parsable JSON report, `ok === true` / `status === 'pass'`, exactly
  one run, the Edge tenant's DevTools `Browser` matching `Edg/` and the Chrome
  tenant's matching `HeadlessChrome|Chrome/`, two distinct positive pids, and
  complete cleanup (`serverStopped`/`workRootRemoved`, no leaked profile dirs,
  no leftover pids) — it does not weaken or replace the script's
  tenant/quota/isolation assertions. The summary JSON adds `withTenant`; the
  switch is orthogonal (+1): `--with-remote --with-tenant` is 18 steps, and the
  default 18-step, extension 19/20-step and budget step sets are unchanged.
- `0.4/scripts/test-all.mjs` needs no new path entry: `daemon/transfer-client.test.mjs`
  is collected by the existing `daemon/` walk root, and
  `dashboard/server.test.mjs` was already listed explicitly (round 43).
  `tests/tenant-multi-browser-e2e.mjs` deliberately keeps a non-`*.test.mjs`
  name (two real browsers are too heavy for the regular group), so it is only
  reachable through `--with-tenant`, never through `test-all`.

**Round-46 note:** §16 below supersedes four Wave C4 boundaries written in this
section — the daemon-global planes are now tenant-attributable (§16.3), tenant
quotas can persist across restarts (§16.3), the dashboard has an
accounts/RBAC/CSRF/audit write plane (§16.1), and the mTLS/per-connection-TLS
client path is real and E2E-tested (§16.2); the VOM options are also exposed on
the MCP/DSH schemas now (§16.4). The Wave C4 statements above stay as history
for rounds 42-45 and are not rewritten.

## 16. Wave D boundaries (round 46): dashboard write plane, mTLS WSS, quota persistence + tenant-attributable global planes, VOM into MCP/DSH

Round 46 closes the four Wave D capability slices (F1-F4) and wires/validates
them into the stage gate. Like §15, this section records what is real, what was
measured, and what stays a written boundary — not a wave-complete claim.

### 16.1 Dashboard accounts, RBAC, CSRF and audit: a real but minimal write plane

- **What is real.** `0.4/dashboard/auth.mjs` is the authentication half of the
  write plane (dependency-free `node:crypto`), `0.4/dashboard/server.mjs` wires
  it into the HTTP surface. Opt-in `--accounts` (inline JSON array or path to a
  JSON file, at most 64 accounts) configures `viewer` (read-only) and `operator`
  (read + tenant-scoped writes) accounts; credentials are a password hash
  (`scrypt$<salt-hex>$<hash-hex>` with the Node defaults N=16384/r=8/p=1 and a
  16-byte random salt, or the lower-cost `sha256$<salt-hex>$<hash-hex>`) and/or
  a static API token; a plaintext `password` field is rejected on purpose.
  `--hash` on `auth.mjs` generates a hash offline. A successful login
  (`POST /api/login`) returns an HMAC-SHA256-signed `bd_session` cookie
  (`v1.<session-id>.<signature>`, HttpOnly, SameSite=Strict, random session id
  only) plus a non-HttpOnly `bd_csrf` cookie; sessions live in memory with an
  8 h default TTL, and `--auth-secret` defaults to a per-process random key, so
  a restart signs everyone out. Cookie-authenticated writes must echo the signed
  session's CSRF token in `X-CSRF-Token` (double-submit); Bearer API clients are
  exempt because their credential is not ambient. Failed logins are counted per
  username/static token and lock the key for 60 s after 5 failures (`423
  E_AUTH_LOCKED`), reset by a successful login.
- **RBAC and the write surface.** `authorizeWrite(user, tenantId)` checks role
  first (`viewer` -> `403 E_FORBIDDEN_ROLE`) and tenant scope second
  (`403 E_FORBIDDEN_TENANT`), before any daemon call. Exactly three write routes
  exist in accounts mode: `POST /api/session/open` (`{tenant_id?, url}`),
  `POST /api/session/close` (`{tenant_id?, session_id}`) and
  `POST /api/session/act` (`{tenant_id?, session_id, action, selector?/ref?,
  value?}` with `action` limited to `click`/`fill`), proxying the daemon's
  `session.open`/`session.close`/`act`. Reads add `GET /api/auth/session` and
  `GET /api/audit[?limit=N]`. Without `--accounts` the previous legacy surface
  (opt-in `--auth-token` and `--tenants`, read-only) is unchanged and **no write
  route exists**.
- **Audit.** Every write attempt (allowed, role-denied, tenant-denied,
  CSRF-denied, or failed upstream) and every login attempt is appended to a
  bounded in-memory ring (`--audit-limit`, default 200, hard cap 1000) and,
  with `--audit-file PATH`, also as one JSON line per entry. Entries hold only
  `{at, user, role, tenant, action, result, code, session_id, detail}`: never a
  password, password hash, session cookie, CSRF token or daemon token; upstream
  messages are scrubbed (`[redacted]`) before an audit entry or log line.
- **Boundary.** There is still **no TLS** and no user database: the dashboard
  binds `127.0.0.1` by default and must not be exposed beyond loopback without an
  authenticating TLS reverse proxy. Accounts are operator-provisioned local
  config (no registration/discovery), sessions and lockout state are in memory
  only, and the write surface is deliberately minimal (no transfer/video/tenant
  administration writes). The 68-test suite (`dashboard/auth.test.mjs` 13 +
  `dashboard/server.test.mjs` 55) is browser-free and runs in `test-all`; there is
  still **no `--with-dashboard` gate step**.

### 16.2 mTLS over WSS: per-connection client TLS, measured same-host on the LAN NIC

- **What is real.** `createWsClient({ url: 'wss://…', tls: { ca, cert, key,
  rejectUnauthorized } })` (or the `rejectUnauthorized`/`ca` shortcuts) uses the
  built-in `node:https`-based RFC 6455 client (`NodeTlsWebSocket`) when TLS
  options are supplied, so the CA, client certificate, `servername` and hostname
  verification are applied to **that one connection** — mTLS clients and verified
  self-signed test daemons no longer need a process-wide
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. A caller-supplied `WebSocketImpl` still wins
  and receives the normalized options as its third constructor argument. On the
  server side `tls: { key, cert }`, `tls: { pfx, passphrase }` and
  `tls: { ca, requestCert: true, rejectUnauthorized: true }` are supported;
  `normalizeTlsOptions()` validates the material eagerly (a `SecureContext` is
  built at `createDaemonServer()` time), `ca` is mandatory with `requestCert`,
  and the HTTPS/WSS listeners are TLS-native (no inner loopback proxy). mTLS is
  **additive**: the daemon Bearer token is still enforced after a successful
  mutual handshake, proved by the "wrong Bearer token over a valid mTLS socket"
  case.
- **What the E2E measured.** `0.4/tests/mtls-wss-e2e.mjs` starts the real daemon
  from the committed PEM fixtures (bound to `127.0.0.1` and then `0.0.0.0`, no
  browser) and runs 13 checks over real **TLS 1.3** mutual handshakes: the
  fixture leaf/SAN, TLS-native listeners, a raw mutual handshake seeing the
  fixture certificate, `initialize`/`daemon.status` with a valid client
  certificate, and the negative cases — no client certificate, a client
  certificate signed by the rogue CA, a client trusting only the rogue CA, a
  valid mTLS socket with a wrong Bearer token, and a SAN/hostname mismatch
  (`127.0.0.2` is reachable via `0.0.0.0` but not in the SAN ->
  `ERR_TLS_CERT_ALTNAME_INVALID`). It also dials this host's real non-loopback
  LAN IPv4 through the real NIC (on this machine `10.10.35.206`, interface
  `以太网`, TLS 1.3) and stops every listener it created.
- **Boundary.** The default run is a **same-host LAN-NIC equivalence test, not a
  second machine**: firewall, routing, DNS and remote OS behaviour are not
  covered. A real cross-machine run needs the `--serve` mode on the daemon host
  and `--connect wss://<host>:<port>/ws --token …` on the client, and the
  fixtures must be regenerated on the daemon host
  (`0.4/tests/fixtures/tls/generate.ps1 -LanIp <addr>`) so the certificate SAN
  covers the address the client dials; if the SAN does not cover it the LAN check
  reports `blocked` (exit 2), which the gate treats as a FAIL step rather than
  faking a cross-machine result. The committed PEM fixtures (CA, daemon, client,
  rogue CA/client, `fixtures.json`, generator) are **test-only material**: they
  are not trusted by the OS, the daemon or any production client and must never be
  reused outside these tests. The E2E launches no browser and only exercises
  `initialize`/`daemon.status`, not sessions, extension or transfer paths.

### 16.3 Tenant quota persistence (opt-in) and tenant-attributable global planes

- **Quota persistence is opt-in.** `createTenantRegistry({ quotaFile })` /
  `createDaemonServer({ tenantQuotaFile })` enable a small restart-safe usage
  ledger (`TENANT_QUOTA_STATE_VERSION=1`): per tenant the quota in force
  (`max_sessions`) and the session ids currently holding a slot
  (`active_sessions`/`sessions`, bounded by `MAX_PERSISTED_TENANT_SESSIONS=512`).
  Writes are atomic (temp + fsync + rename) and best effort — a read-only or
  broken quota path never turns a successful open/close into an error — and reads
  never throw (a missing/corrupt file rehydrates as "no held sessions");
  invalid/foreign/corrupt entries are dropped rather than trusted. After a
  restart the **config stays authoritative for `maxSessions`**: a persisted
  `max_sessions` is a record of the quota that was in force, never an override,
  so a reconfigured tenant takes effect immediately. `reconcileQuota()` re-anchors
  the ledger to the daemon's own recovered session records on `session.open`;
  leases the daemon cannot account for are released (fail-open) instead of
  locking a tenant out. The quota decision uses
  `active = max(live, held) + pending` (in-flight opens count), and close /
  `stop_all` release slots. Without `quotaFile` the registry is exactly the
  pre-task-92 in-memory registry.
- **Global planes are now tenant-attributable.** The former
  `E_TENANT_UNSUPPORTED` set is empty: `record.list/get` filter persisted traces
  by their persisted `tenant_id` (pre-tenant/untagged traces stay invisible to
  every tenant — fail closed — and `record.get` answers `found:false` for both a
  foreign and an unknown id, so there is no existence oracle);
  `video.list/save/discard` read the request tenant's own catalog under its
  `artifactDir` (a foreign id is the catalog's `E_NOT_FOUND`; no tenant artifact
  dir is `E_NOT_CONFIGURED`, never a fake listing); `ledger.list/pending/resolve`
  filter WAL intents by their owner (an unattributable resolve fails closed);
  `audit.request` scopes every section (ledger/traces/recordings) to the tenant's
  sessions; `transfer.*` keeps a per-request-scope ownership map so a
  cross-tenant transfer id answers exactly like an unknown id (`not_found`, and
  `transfer.release` answers `released:false`).
- **Remaining global views (recorded, not hidden).**
  `system.status.browsers[]` / `browser.list.browsers[]` / `daemon.status().browsers`
  are still a **global browser-instance view** (`session_count`, `pid`,
  `ws_endpoint`, `browser_kind`); `initialize.browser.browsers[]` only exposes a
  sanitized `browserKind`/`pid`/`wsEndpoint` (no tenant data, no other tenant's
  session counts); `initialize.tenants` / `system.status.tenants` are a sanitized
  configuration summary (`id`, `browser`, `max_sessions`, `artifact_dir`, never a
  token). Transfer ownership lives in a per-process map: after a restart an old
  transfer id can no longer be attributed (the transfer store itself is TTL
  cleaned). The `extension` and `local_auth` planes are not tenant-partitioned.
  Tenant isolation remains session-scope isolation plus per-tenant instance
  routing, not browser-instance-level isolation.

### 16.4 VOM options in MCP and DSH: new parameters, default-compatible

- **MCP.** The `browser_observe` JSON Schema now exposes the four opt-in VOM
  options with the same contract as the adapter: `maxBytes` (integer >= 1, a
  per-render UTF-8 byte budget), `withAffordanceTypes` / `withActiveRegion`
  (strict booleans, no truthy coercion) and `viewportPolicy` (`clip`|`keep`,
  trimmed and lower-cased). In daemon mode they are mapped 1:1 onto the `observe`
  snake_case params (`max_bytes`, `with_affordance_types`, `with_active_region`,
  `viewport_policy`); in one-shot mode they become remote-CLI flags
  (`--max-bytes`, `--with-affordance-types`, `--with-active-region`,
  `--viewport-policy`). Because the one-shot CLI applies them on its
  `--snapshot`/`--observe` paths only, `browser_observe` adds `--observe` when
  `snapshot` is not `true` (so `maxBytes` goes through the paged observe result
  with `bytes`/`next_cursor`); with `snapshot: true` it keeps `--snapshot`, where
  `maxBytes` is a hard text cap and **no cursor is produced**.
- **DSH.** `browser_remote_observe` in `0.4/packages/dsh-plugin/src/remote-tools.js`
  exposes the same four parameters, and `default-executor.js` normalizes/validates
  them with the same rules (`vomOptionsOf`; invalid values are typed
  `E_INVALID_PARAMS`) before appending the remote-CLI flags.
- **Default compatibility.** When none of the four options is supplied, the MCP
  argv and daemon observe params are byte-for-byte the pre-round ones, and the
  DSH executor appends no flag at all (`requested === false`). The options only
  make the adapter attach `bytes`/`active_region` to the snapshot/observe result
  roots, which the BSK codecs accept additively (those roots do not set
  `additionalProperties: false`), so no protocol/codec change is needed.
- **Boundary.** This is an opt-in reporting/pagination passthrough, not a port of
  BSK's visual-observation heuristics; `tool.snapshot`'s `max_bytes` remains a
  hard cap without a cursor (continuation pagination belongs to observe), and an
  MCP one-shot observe that asks for `maxBytes` returns the paged observe block
  in addition to / instead of the snapshot-only shape.

### 16.5 Gate and test wiring for this slice

- `0.4/scripts/stage-gate.mjs` gains the opt-in **`--with-mtls`** step
  (`mtls wss`, **pure lane**, 420 s cap) that runs
  `mtls-wss-e2e.mjs --quiet`. Exit 2 BLOCKED (no non-loopback IPv4, SAN not
  covering it, missing fixtures) is a FAIL step, never a silent skip; the wrapper
  additionally requires a parsable single JSON report, `ok === true` /
  `status === 'pass'` / `mode === 'same-host'`, a self-consistent summary
  (`failed`/`blocked` 0, `total === checks.length`, `passed === checks.length`),
  every check `pass`, at least four `negative:` rejection checks and a cleanup
  that does not report a live listener — it does not weaken or replace the
  script's TLS/mTLS assertions. The summary JSON adds `withMtls`; the switch is
  orthogonal (+1): `--with-remote --with-mtls` is 18 steps, and the default
  18-step, extension 19/20-step and budget step sets are unchanged.
- `0.4/scripts/test-all.mjs` adds `dashboard/auth.test.mjs` to its explicit list
  (browser-free: `node:crypto` + in-memory state, no http listener, no browser),
  next to the already-listed `dashboard/server.test.mjs`. `mcp/`,
  `dsh-runtime/`, `daemon/` and `cli/` are existing walk roots, so the F4
  MCP/DSH suites are collected automatically. `tests/mtls-wss-e2e.mjs`
  deliberately keeps a non-`*.test.mjs` name, so it is only reachable through
  `--with-mtls`, never through `test-all`.
- `0.4/scripts/bsk-coverage.mjs`'s `[2]` area table now includes `dashboard` and
  `bench` rows (prose had listed them while the generated table omitted them, so
  the area rows no longer summed to the `[2b]` totals). This is a reporting fix
  only: the classification, the 77/77 usable scope and the `--check` semantics
  are unchanged.

## 17. 方案 B 首轮收口边界（round 47, 2026-11-24）：产品合规两级门禁、基线棘轮、内部研究文档、原创 UI

本节记录 task-99 收口时确立的产品面边界。它是**产品文案/发布面策略**，不改变任何
BSK 方法分类或门禁阈值。

### 17.1 产品合规门禁是两级判定，不是“零禁词”

- **hard（硬失败，零容忍，不参与基线）**：用户可见面出现外部产品名称/缩写/版本、
  借用/衍生/移植来源字样即 FAIL——CLI usage/help、MCP/DSH 工具描述、错误消息、
  dashboard 与扩展 UI 的 HTML/JS/CSS 文案、产品 README 正文（行内代码/围栏块之外）。
  `--write-baseline` 在 hard>0 时**拒绝**写基线，不允许“以后再说”。
- **ratchet（按文件计数，基线只降不升）**：代码注释、内部标识符、测试/内部工具目录、
  生成契约数据里的同类字样按文件计数，与 `0.4/compliance-baseline.json` 比较：
  新增 → FAIL；低于基线 → 只提示（必须显式 `--write-baseline` 才下调）；基线缺失/
  不可解析 → exit 2（门禁整步 FAIL，绝不静默通过）。
- **为什么分两级**：0.4 是独立产品（BridgeDeck），不是任何外部产品的复刻/移植说明。
  对齐 wire 合同需要在注释/内部标识里记录外部契约名，那是内部研究信息；一旦出现在
  用户可见面就是产品归属/借鉴表述，硬失败。
- **扫描范围与判级**：产品根 `extension-ingress/`、`dashboard/`、`cli/`、`mcp/`、
  `packages/`、`daemon/`、`dsh-runtime/` 的 `.js/.mjs/.cjs/.html/.css/.json/.md`，
  加 5 个产品 README（`0.4/README.md`、`extension-ingress/README.md`、
  `dashboard/README.md`、`packages/browser-adapter/README.md`、`bench/README.md`）；
  `.md` 的行内代码/围栏块按 ratchet、正文按 hard；`.js/.mjs` 注释按 ratchet、
  带空白的字符串字面量（散文/错误消息/usage）按 hard、无空白标识符/路径按 ratchet；
  HTML/CSS 全文 hard；JSON/测试/内部工具/生成文件全文 ratchet。显式排除
  `0.4/scripts/`（门禁工具自身）、`0.4/STATUS.md`/`FINAL-AUDIT.md`/`ROUND-644-REPORT.md`、
  `docs/`、`dist*`、`node_modules/`、`bench/` 下除 README 之外的文件。
- **已知边界（如实）**：轻量词法扫描（不完整解析正则字面量的歧义）、启发式判级，
  既不是商标检索也不能替代人工 review；它只保证“发布面不泄漏 + 内部计数不增长”。
  本轮实测 **420 files scanned，hard 0，ratchet 599 处 / 149 文件**；
  G3 清理把 hard 从 38 降到 0，随后 `--write-baseline` 生成当前基线。

### 17.2 基线只降不升（ratchet）

- `0.4/compliance-baseline.json` 是**已提交的棘轮基线**：每文件一个 ratchet 计数 +
  schema `bridgedeck-0.4-compliance-baseline/1` + 策略/范围元数据。`--check` 只接受
  `actual <= baseline`。
- 本轮（task-99）**没有下调也没有上调**：没有新增产品违规、也没有再清理注释，
  所以基线维持 G3 生成的 599/149。合规基线只降不升是硬规则：任何新写的注释违规
  必须先清理，或走一次显式的基线评审并记录理由。
- 门禁里它是 **pure lane 步骤 `product compliance`**（与 unit/eval/source guard/scale
  同批，无浏览器、毫秒级）；非零退出（含 hard 违规、ratchet 新增、基线缺失/格式错误）
  即整步 FAIL。

### 17.3 内部研究文档不进产品面

- `docs/`（含 `docs/bsk-study/`）、`0.4/STATUS.md`、`FINAL-AUDIT.md` 等被合规扫描
  **明确排除**：它们是内部研究/审计材料，允许写外部合同名与来源对照，但**不是产品
  文案**——不随扩展/CLI/dashboard 发布，也不能被复制进 README 正文、HTML 文案、
  CLI usage、MCP/DSH 工具描述或错误消息。
- 本轮新增两份内部审计文档：`docs/UI-DESIGN-BRIEF.md`（界面/交互/视觉/禁止项）与
  `docs/MERGE-0.3-0.4.md`（资产清单/对接/分阶段/风险）。产品文档（`0.4/README.md`、
  `extension-ingress/README.md` 等）只能**引用其结论**，不能粘贴其内部表述；产品面
  禁词由 17.1 的 hard 级与 G4 的 UI 禁词测试双重覆盖。

### 17.4 UI 原创与禁止项（popup / options）

- popup 是**只读**状态面：连接态/人类三态/会话列表/版本 + 技术信息开关 + 复制诊断；
  它只发 `ui.status`（不触达 WebSocket、不发 pull，`counters.pulls=0` 由单测断言）。
  options 只读写 `chrome.storage.local`（刷新间隔/诊断级别/技术信息），恢复默认；
  保存失败**如实提示**，不假装成功。
- 视觉/交互规则（`docs/UI-DESIGN-BRIEF.md`）：暗色适配（`prefers-color-scheme: dark`）、
  保留 `:focus-visible`、状态用 tone class + `aria-label`；严格 CSP——单文件外链
  `type=module` 脚本、本地 CSS，**无内联脚本/内联事件处理器/外部资源/@import**；
  `manifest` 不新增权限（现有 `alarms/notifications/scripting/storage/tabGroups/tabs/windows`
  保持不变），只接 `action.default_popup` 与 `options_ui`。
- 禁止项（硬性）：不复制外部产品的 UI 结构/文案/图标/交互叙述；不引入 CDN/框架/遥测/
  外部字体；不在 UI 出现外部产品名/来源表述（由 5) 的禁词测试 + 17.1 的 hard 双重覆盖）；
  不用 popup 充当写操作/控制通道（写面仍只在 daemon/CLI/dashboard 的既有路径）。
- **边界（如实）**：UI 单测是 **fake `chrome.*` + fake DOM**（23/23），不是真实浏览器
  UI 自动化；真正的“扩展能加载”由 headed-Edge `extension ingress` E2E 对 staging 产物
  （已含 `ui/`）验证，`smoke.mjs` 仍是 339/339 的扩展逻辑冒烟——三者都不能互相替代。

### 17.5 门禁接线与步数矩阵（G3 后 +1）

- `0.4/scripts/test-all.mjs` 显式收集 `0.4/extension-ingress/test/ui.test.mjs`
  （`extension-ingress/` 不在 walk 根内；该套件 browser-free：fake chrome/DOM +
  `node --check` + 一次临时 staging build，跑在 regular 4 路组，绝不进 serial heavy
  lane）。`test/smoke.mjs` 不是 `*.test.mjs`，保持 standalone（339/339）。
- 步数矩阵（脚本文件头、STATUS、TEST-STATUS、bench README、BEYOND-BSK、0.4 README
  统一）：`--with-remote` **18**；`--with-remote --with-bench`（文档默认）**19**；
  `--with-remote --with-extension`（扩展）**20**；加 bench **21**；
  `--with-budget`/`--with-crash-inject`/`--with-transfer`/`--with-tenant`/`--with-mtls`
  各为 **19**，且与其它开关正交（各 +1，`--with-extension` +2）。步骤集与判定语义
  未变，本轮只同步文档与脚本头注释，未改任何断言/阈值/预算/步骤语义。

## 18. B1 收口边界（round 48, 2026-11-24）：UI 原创与禁词、i18n 策略、状态浮层与 CDP 浮层分工、ratchet 棘轮

本节记录 task-105（B1 收口）确立的 UI/i18n/浮层/合规边界。它是产品面与门禁策略的
记录，不改变任何 BSK 方法分类或既有门禁阈值。

### 18.1 UI 原创与禁词（popup / options / 借用确认 / 状态浮层）

- 四个用户可见面都是**原创实现**，不复制外部产品的 UI 结构/文案/图标/交互叙述：
  popup（`ui/popup.*`，只读状态面板）、options（`ui/options.*`，只读写
  `chrome.storage.local`）、借用确认条（`content/borrow-confirm.js`，按需
  `scripting` 注入的 shadow-DOM 决策卡）、状态浮层（`content/status-overlay.js`，
  声明式注入的 shadow-DOM 状态胶囊）。
- 共同硬约束：严格 CSP（单 `type=module` 外链脚本 + 本地 CSS，**无内联脚本/内联事件
  处理器/外部资源/@import**）；不引入 CDN/框架/遥测/外部字体；动态外部字符串用
  `textContent` 与 `<bdi>` 隔离；manifest **不新增权限**（仍是
  `alarms/notifications/scripting/storage/tabGroups/tabs/windows`）。
- **禁词双重覆盖**：产品合规门禁的 `hard` 级（UI HTML/CSS/JS 文案零容忍）与 UI
  测试的禁词断言共用同一词表（`product-compliance.mjs` 导出
  `findForbiddenTerms`/`hasForbiddenTerms`，测试用字面量拼接避免自命中）；
  `product compliance --check` 本轮扫描 **438 文件、hard 0**。
- **边界（如实）**：`ui.test`/`ui-i18n`/`borrow-confirm-ui`/`status-overlay` 是
  fake `chrome.*` + fake DOM 单测；真实渲染/真实扩展加载只由 **opt-in** 的
  headed-Edge UI E2E（`0.4/tests/ui-popup-e2e.mjs`，**99/99**）证明。popup 仍
  **只读**（只发 `ui.status`，不 pull、不触达 WebSocket、无写/控制通道）；options
  只写 `chrome.storage.local`。

### 18.2 i18n 策略（12 语言、按需加载、回退与 RTL）

- 内置 **12 种语言**：en / zh-CN / zh-TW / ja / ko / es / fr / de / pt-BR / ru /
  ar / he；词表按语言拆成 `ui/locales/<code>.json`，初始化只加载回退语言（en）与
  当前语言，切换时按需加载并缓存（进程内不重复请求）。
- **语言选择**：默认跟随 `chrome.i18n.getUILanguage()`（用
  `matchBrowserLanguage` 把 zh/zh-hans/zh-hant/pt 等标签归一），
  `storage.local['bb04.ui.language']` 可覆盖（`'auto'`＝跟随浏览器）。
- **回退顺序**：当前语言缺键 → `en` 同键 → 返回键名本身（便于测试/排障发现缺失，
  **绝不编造译文**）；`{{name}}` 插值统一双花括号。
- **RTL**：ar/he 为 `dir=rtl`；`ui/direction.js` 在首帧前同步设置 `<html lang dir>`，
  `applyDocumentLanguage()` 之后再校正；动态文本用 `<bdi>`；布局用逻辑属性，借用确认/
  状态浮层只镜像必要的方向（例如倒计时 ring 填充方向）。
- **边界（如实）**：i18n 是**本地词表层**，不是翻译服务/机器翻译；借用确认条是
  classic script（`scripting.executeScript` 注入页面后不能 import ESM 的
  `ui/i18n.js`/locales），所以它只能内置 `zh-CN`/`en` 两套词表，其余 10 种语言回退
  英文文案，但 `[dir="rtl"]` 方向仍按真实语言生效；`installMessages()` 是预留的
  词表注入点。

### 18.3 状态浮层与 CDP 浮层的分工

- **页内状态浮层（`content/status-overlay.js`）**是 MV3 **声明式内容脚本**
  （`<all_urls>`、`document_idle`、仅顶层 frame，H3）：常驻的**只读**状态胶囊，
  展示连接/human/暂停/借用/录制/协助，固定优先级（录制 100 > 协助 90 > 断连 80 >
  human 70 > paused 60 > borrowed 50）+ 120ms 去抖；无状态不挂载 DOM、可折叠
  （折叠状态只在页面内存，不写 storage）、host/card `pointer-events:none`（只有折叠
  按钮可点并拦截 `pointerdown`/`click` 冒泡）、`role=status` + `aria-live=polite`
  隐藏朗读区；状态源两条且只读：SW 推送 `bb04.status`/`bb04.status.event`（转发
  `extension.event`，推送优先）与 `ui.status` 只读轮询兜底（有活动会话 2.5s、空闲
  10s 退避，页面隐藏即停），**不触达 daemon、不排队命令**；全局隐藏由
  `storage.local['bb04.ui.statusOverlayHidden']` + `storage.onChanged` 生效。
- **CDP 浮层**（`request_help` 的页面浮层、cooperate 的协作浮层等）是 daemon/CDP
  路径在**具体页面/具体会话**内的交互面，按需出现、需要真实页面焦点与输入通道。
  两者**分工不重叠**：状态浮层只做“提示”，不承载任何决策/输入；CDP 浮层做“交互”，
  由 daemon 会话驱动。状态浮层**不是** CDP 浮层的替代，也不复制其交互。
- **边界（如实）**：状态浮层展示的是**浏览器级** `ui.status`；0.4 还没有
  「当前 tab 属于哪个会话」的映射，因此有会话时胶囊会在所有页面出现（推送带
  `params.tab_id/session_id` 后才可能收窄到当前页）。录制/暂停/协助没有真实后端状态
  源时保持隐藏（不伪造）；页面操作面仍留给 CDP 路径；它是只读提示，不构成
  “UI 控制端”。

### 18.4 ratchet 棘轮（251/78，只降不升）

- `0.4/compliance-baseline.json` 的 ratchet 计数本轮为 **251 处 / 78 文件**
  （round 47 基线 599 处 / 149 文件 → **-348 处、-58.1%**），`--check` 只接受
  `actual <= baseline`；`hard` 仍为 **0**（438 文件扫描）。
- 下调来自 H5 对代码注释/内部标识的实际清理，不是放宽判定或忽略文件；**没有为过门禁
  上调基线**，也没有改 `FORBIDDEN_TERMS`/扫描范围/判级规则。新增注释违规必须先清理，
  或走显式基线评审并记录理由（硬规则：只降不升）。
- **边界（如实）**：它是轻量词法启发式（不完整解析正则字面量歧义），不是商标检索，
  不能替代人工 review；`docs/`、`STATUS.md`、`FINAL-AUDIT.md` 被排除在扫描外是
  产品面/内部材料的**设计决定**（内部研究表述不得粘贴进产品面）。

### 18.5 门禁接线与步数矩阵（`--with-ui` +1）

- `0.4/scripts/test-all.mjs` 显式收集四个 `extension-ingress` 套件：`ui.test.mjs`
  （round 47 起）、`ui-i18n.test.mjs`、`borrow-confirm-ui.test.mjs`、
  `status-overlay.test.mjs`（round 48 起）；`extension-ingress/` 不在 walk 根内，
  这些套件均 browser-free，跑在 regular 4 路组，绝不进 serial heavy/browser lane。
  `test/smoke.mjs` 不是 `*.test.mjs`，保持 standalone（**341/341**）。
- `0.4/scripts/stage-gate.mjs` 新增 opt-in `--with-ui` 步骤 `ui popup e2e`
  （`0.4/tests/ui-popup-e2e.mjs`，**browser lane**、`timeoutMs: 420_000`、exit 2
  BLOCKED 也是整步 FAIL、summary JSON 增 `withUi`）。它与其它开关正交 +1：
  `--with-remote` **18**；默认（含 bench）**19**；扩展 **20**（+bench 21）；
  `--with-budget`/`--with-crash-inject`/`--with-transfer`/`--with-tenant`/
  `--with-mtls` 各 **19**；新增 `--with-remote --with-ui` **19**。默认 19 / 扩展 20
  步的步骤集与判定语义未变，未改任何断言/阈值/预算。

## 19. B2 收口边界（round 50, 2026-11-24）：借用确认 12 语言 i18n、popup 控制面 `ui.intent`、HAR 1.2 导出、页内快路径评估

本节记录 task-111（B2 收口）确立的四块新边界。它不改变任何 BSK 方法分类、门禁步骤集或
既有阈值/预算；新能力都落在**产品面已有通道**上（`scripting` 注入的 classic script、
service worker 的 `runtime.onMessage`、daemon 的 `debug.export`），没有新增 chrome 权限、
没有新增 wire 方法、没有新增 stage-gate 步骤。

### 19.1 借用确认的 12 语言词表（classic script + 懒加载覆盖层）

- **为什么是 classic script**：借用确认条 `content/borrow-confirm.js` 由 service worker 在
  「真的要借用」时用 `chrome.scripting.executeScript({files})` 按需注入页面隔离世界，不能
  `import` ESM 的 `ui/i18n.js` 或 `ui/locales/*.json`。因此 round 50 新增
  `content/borrow-i18n.js`（classic IIFE，命名空间 `__bb04IngressBorrowI18n`）自带：
  12 种语言（en / zh-CN / zh-TW / ja / ko / es / fr / de / pt-BR / ru / ar / he）的
  **完整内置键表**、语言解析、方向判定、`translate()`/`installMessages()`/`setLanguage()`。
- **语言来源优先级**（与 `ui/i18n.js` 一致）：显式 `setLanguage()` >
  `storage.local['bb04.ui.language']`（popup/options 写入，`auto` = 跟随）>
  `navigator.languages`/`navigator.language` > `chrome.i18n.getUILanguage()` >
  页面 `<html lang>` > 产品基线 `zh-CN`；有语言信号但不属于 12 种时回退 `en`。
- **词表结构**：内置 12 语言保证「拿到消息的同一帧即可同步渲染」（不依赖网络）；
  `ui/locales/<lang>.json` 是**覆盖层**——按需 `fetch` 一次（按语言幂等、进程内缓存），
  只取 `borrow.confirm.*` 前缀的非空字符串覆盖内置同键词条；文件缺失/结构不对/网络失败
  一律**静默回退内置词表**（不阻塞确认、不影响 fail-closed、不往页面控制台刷错误）。
- **注入顺序无关**：`src/borrow.js` 在同一次 `executeScript` 里按
  `files:[CONFIRM_BAR_SCRIPT, CONFIRM_BAR_I18N_SCRIPT]` 注入（`files[0]` 契约不变）；
  确认条先注册消息监听，收到消息（两个文件都已执行）后才读词表命名空间，因此
  「先 confirm 后 i18n」也能读到模块；模块缺席时确认条退回内置 `zh-CN`/`en` 词表
  （round 48 行为不回归，单测覆盖）。
- **方向**：ar/he 为 `rtl`，其余（含未知/空值）`ltr`；确认条用逻辑属性镜像、
  `<bdi>` 隔离页面可控文本，本模块只提供语言方向判定与 `applyDirection()`。
- **新增的扩展资源暴露面（如实）**：内容脚本 `fetch` 扩展资源需要 manifest 的
  `web_accessible_resources` 放行，因此 manifest 新增
  `{resources:["ui/locales/*.json"], matches:["<all_urls>"]}`。它**不是 chrome 权限**
  （permissions 集合不变），但确实把 12 个词表文件暴露给任意页面读取——词表只含 UI 文案、
  不含 token/端点/配置，风险是**指纹/枚举面**而非凭据泄漏；若后续要收窄，可改为
  只在确认注入时通过 `scripting` 传词表（代价是多一次消息往返）。
- **边界**：i18n 仍是本地词表层（不编造译文：缺键回退 `en` → 键名）；懒加载失败不阻塞
  确认决策；确认条本身仍是 fail-closed（无默认同意、Esc/超时/关闭 = 拒绝）。

### 19.2 popup 控制面 `ui.intent`（协议与安全边界）

- **协议**：popup → service worker 的消息
  `{kind:'ui.intent', action:'session.open'|'session.close', url?, session_id?}`；
  `src/bridge.js` 的 `createUiIntentRouter({isConnected, callRpc, listSessions})` 处理，
  service worker 顶层 `runtime.onMessage` 只接管 `ui.intent`（其它消息返回 `false`，
  交给 `ui.status`/内容脚本分支），并**异步** `sendResponse`（监听器返回 `true`）。
- **白名单**：仅两个动作 `session.open` / `session.close`，都落到**既有 daemon RPC**
  （不新增 wire 方法、不新增 chrome 权限、不暴露任意 RPC）。未知动作 →
  `E_UI_INTENT_UNSUPPORTED` + `allowed_actions`。
- **失败语义（不伪造成功，不排队）**：daemon 未连接 → `E_UI_INTENT_OFFLINE`（不重试、
  不排队）；`session.open` 的 URL 只接受 `http:`/`https:`、≤4096 字符，非法 →
  `E_UI_INTENT_URL_REQUIRED`/`E_UI_INTENT_URL_INVALID`；`session.close` 的目标判定
  「显式 `session_id` > 唯一会话 > fail-closed `E_UI_INTENT_NO_TARGET_SESSION`」（多会话
  且未指定时不猜）；daemon 回包形状不符（open 无 `sessionId` / close 的 `closed !== true`）
  → `E_UI_INTENT_BAD_RESULT`/`E_UI_INTENT_NO_EFFECT`；RPC 异常按 typed `E_*` 回传。
- **凭据不外泄**：daemon token 只存在于 bridge 内部（config + `buildWsUrl`）；回包只含
  调用方已知的会话身份；错误 message 经 `redactSecrets()`（`token=...` → `token=***`）
  后才回 popup；不回 `ws_url`。计数器 `counters.ui_intents`/`ui_intent_failures` 只增。
- **destructive 二次确认**：`session.close` 在 popup 内先进入确认态（显示目标会话 id），
  确认后才发 `ui.intent`；未确认/无目标/离线时按钮禁用且直接调用也被拒绝（防御层）。
- **相对 round 47/48「popup 只读」的关系（如实更正）**：round 47/48 的 popup 只发
  `ui.status`、无写/控制通道；round 50 **取代**该表述——popup 现在是**最小控制面**，
  但写面严格限于这两个既有会话面操作（不能 act/observe/navigate/transfer，不能发任意
  RPC，不排队重试）。`ui.status` 仍是唯一只读状态源，popup 本身仍不直连 WebSocket
  （RPC 由 service worker 用既有的 daemon 客户端发出）。
- **边界**：控制面依赖 service worker 存活（MV3 回收时 `sendMessage` 失败 →
  `E_UI_INTENT_UNREACHABLE`，如实显示）；`ui.test.mjs` 是 fake `chrome.*`/fake DOM
  单测（含真实 `bridge.js` 经 fake WebSocket 的路由/脱敏用例），真实浏览器渲染证据仍是
  opt-in 的 `--with-ui` headed-Edge UI E2E。

### 19.3 HAR 1.2 导出（`debug.export` 的 `format:"har"`）

- **位置与接线**：`0.4/daemon/har-export.mjs`（`buildHar(recording, opts)` 纯函数 +
  `exportHar(store, {sessionId})` 落盘）；`0.4/daemon/server.mjs` 的 `debug.export`
  接受 `format:"json"`（默认，行为不变）或 `"har"`；CLI
  `--session-debug-export <id> --format json|har`（非法 format 在**任何网络调用之前**就是
  usage error）。HAR 复用 store 自己的 JSON 产物作为快照源（`exportHar` 调
  `store.export()`），JSON 源**保留**并在结果里报为 `source_artifact`。
- **形状**：`log.version:"1.2"` + `log.creator:{name:"BridgeDeck",version:"0.4.0"}`，
  每个保留的 `DebugRequest` 一条 `log.entries[]`（method/url、请求头/可选请求体、
  status/mime/响应头/可选响应体、decoded/transfer 大小、timing 分解）；
  `log.pages[]` 来自捕获的页面导航快照（只 title/url；`onContentLoad`/`onLoad` 恒 -1，
  不伪造加载计时）。
- **缺失数据如实表达（不猜）**：未知 status → `status:0` +
  `_bridgedeck.status_missing:true`；未观测的 duration/size/timing → `-1`（HAR 约定）；
  请求/响应体缺失 → 不写 `postData`/`content.text`，用 `_bridgedeck.body.*.state`
  说明原因（`omitted`/`unavailable`/…）；URL 不可解析 → 空 `url`/`queryString`；
  头按捕获原样（小写名 + 掩码值）；`cookies` 恒 `[]`（cookie 头在捕获时已掩码）。
- **截断/脱敏标记**：`[redacted]` 保留在原位，截断体的 `content.comment` 说明；
  每个 entry 的 `_bridgedeck.redacted`/`_bridgedeck.truncated` 与文件级
  `log._bridgedeck.redacted_entries`/`truncated_entries` 计数，
  `log._bridgedeck.notes[]` 汇总（含「捕获在导出前已淘汰 N 条请求」这类事实）。
- **边界（如实）**：HAR 是**已脱敏、已有界捕获**的投影——不会重新抓包、不会二次脱敏；
  已被掩码的值不可恢复（`[redacted]` 不是占位待还原）；timing 只含 CDP 能观测到的段
  （没有 queue/proxy 区间，`blocked` 恒 -1）；边界继承 `session-debug` 的
  200 请求/500 console/100 pages/200 operations 与 512 KiB body cap；没有 HAR 导入/回放，
  默认 `json` 输出与 CLI 其它视图逐字节不变。

### 19.4 页内快路径评估：做 A1、不做「整套平移」（`docs/FASTPATH-SPIKE.md`）

- **决策（评估结论，不是发布证据）**：**A1（只解析「会落地的行」的 ref）立即落地**——
  1000/5000 元素合成页 p50 **−44% / −43%**，CDP 命令 **1002 → 302（−3.3×）**，
  渲染文本与现状**逐字节相同**；fixture 类小页面落在噪声区（两个方向都出现过，p95 更差），
  实现时按可寻址节点数加阈值（<64 走原路）回退。可叠加 A3（`objectId` 替代
  `domPath`，预计再砍一半 ref 命令）。
- **不做**：把 0.3 的 `injected/page-lib.js` 整套平移（方案 B）。它是**新建页内渲染器**
  而不是移植：0.4 ref 模型（`bn<backendNodeId>`）与 0.3 页内 `@eN` 句柄不兼容、需要
  `Page.createIsolatedWorld` 注入、约 150 KB 渲染管线（layers/stealth/affordance/context/
  table-fold/activeRegion/cursor）要保住全部语义、需要新的 bundle 构建步骤、cursor 分页
  语义要重对齐、跨源/OOPIF 覆盖要逐帧验证、页内渲染器还扩大反爬注入痕迹。
- **成本/收益**：B 的最小可用原型 **3–5 人日**（isolated world 0.5、bundle 构建 1、
  页内渲染接线 1、ref 映射 1、验证 1），换来 p50 **2.7 / 9.7 / 29.0 ms**（−9.8×/−7.8×/−4.1×）、
  回复字节 4.5/8.0/8.0 KB（−26×~−47×）、1 个 CDP 往返，以及 **unchanged 快路径**
  （重复 observe 0.2 ms，0.4 目前完全没有）。三个硬门槛先过再做：isolated world 注入可用、
  页内 `ref → backendNodeId` 按需映射可行、cursor 分页语义可对齐。
- **测量限制（必读）**：一次性内部 spike（不改产品代码、不跑门禁）；loopback CDP
  数字偏高、机器负载下有 ≤20% 波动，只能当同机同批次的**相对量级**；合成页偏理想；
  0.3 输出未受 token 预算约束（不是等预算对比）。因此 A1 落地仍须用 bench/阶段门
  自己的 before/after 证据，本文不构成「性能已提升」的发布结论。

### 19.5 门禁/测试接线（round 50 只补收集，不改判定）

- `0.4/scripts/test-all.mjs` 的显式 `extension-ingress` 收集列表补齐两个**既有缺口**
  （round 47/48/49 一直记录为 follow-up）：
  `extension-ingress/test/borrow-i18n.test.mjs`（**20/20**：12 语言词表完整性、
  语言解析/回退/RTL、懒加载覆盖层只取一次且失败静默回退、注入顺序无关、模块缺席回退、
  `src/borrow.js` 同批注入接线、manifest `web_accessible_resources` 放行、
  源码/12 语言文案禁词 hard 0、UTF-8/BOM/CRLF 编码）与
  `extension-ingress/test/human-match.test.mjs`（**10/10**：原 standalone-only 的人类输入
  匹配器测试）。两者都 browser-free（fake `chrome.*`/fake DOM/`node:vm`），跑在
  regular 4 路组，**不进 serial heavy/browser lane**；`test/smoke.mjs` 仍不是
  `*.test.mjs`，保持 standalone。
- 步骤集、门禁判定、断言与阈值**本轮未改**：`--with-remote` 18 / 默认 19 /
  扩展 20（+bench 21）/ 各 opt-in +1 的矩阵不变（`--with-ui` 已在 round 48 接入）。

---

## 20. B3 收口边界（round 51, 2026-11-24）：快路径 A 落地、dashboard 捕获/HAR、ratchet 精确 token allowlist、panels 计划

本节记录 task-116（B3 收口）确立的边界。它**不改变任何 BSK 方法分类、门禁步骤集或既有阈值/预算**：
J1-J4 的产品能力由前置任务 landing，本节写清「做到了什么、什么时候会回退、什么是代理/计划而不是能力」。

### 20.1 快路径 A（懒解析 ref）落地：只在「少解析会改变输出」的页面上生效

- **实现**：`0.4/packages/browser-adapter/src/snapshot-handlers.js` 的 `capture` 增加
  `renderWithLazyRefs`——先 `renderVom(withRefs:false)` 拿**真正落地的行**，只对这些行
  （`emittedResolvableNodes`）调用 `resolveVomBackendIds` 回填 `backendNodeId`，再带 ref
  重渲染；未落地节点**一条 DOM 命令都不产生**（旧路径是每个可寻址节点 2 条
  `DOM.querySelector` + `DOM.describeNode`）。常量：`LAZY_REF_MIN_ADDRESSABLE = 64`、
  `LAZY_REF_MAX_ROUNDS = 3`。
- **回退（安全阀，输出与旧路径逐字节一致）**：①可寻址节点 `< 64`（fixture 类小页在
  噪声区，实测无收益）；②分页 `pageSize` 已覆盖全部可寻址节点；③非分页 token 预算装得下
  全部可渲染节点（`tokenBudgetTruncates` 为 false，本来就不会有行被截断）；④
  `refResolutionAffectsRows()`（`0.4/packages/vom/src/render.js` 新出口）命中「表格单元格
  在无地址态会折叠后代、而全量解析会给后代回填地址从而保留后代行」的页面；⑤3 轮未收敛
  （解析持续失败/行集反复）。任一命中即走旧**全量预解析**路径。
- **范围**：懒解析只对默认 `extractVomNodes`/`renderVom` 实现生效；单测/录制的**注入 seam**
  （`createSnapshotHandlers({extractNodes, render})`）保持旧路径。`tool.snapshot`/`tool.observe`
  的 `text`/`ref_count`/`truncated`/`next_cursor` 形状与语义不变；分页 cursor 逐页一致。
- **证据（内部分界）**：`snapshot-handlers.test.mjs` **22/22**（新增 7 条快路径用例：只解析
  落地行 / 等价文本 / 分页 cursor / `<64` 回退 / 解析失败只少 ref 不报错 / 预算与 pageSize
  零收益回退 / 表格单元格安全阀）；真实 headless Edge 独立复核（7 次/模式，before = 注入
  seam 强制全量预解析）：1000 行页 CDP 命令 **1002 → 202**、p50 **62.3 → 36.2 ms（0.58x）**；
  5000 行页 **1002 → 202**、p50 **139.5 → 60.1 ms（0.43x）**；fixture **298 → 202** 命令但
  p50 **20.5 → 19.5 ms（0.95x，噪声区）**；三页 lazy/legacy 的 **text sha256 全相同**。
- **边界**：数字是同机同批次相对量级（loopback CDP、后台负载，历史记录过 ±20% 波动），
  不是发布级性能结论；**方案 B（页内渲染器）未启动**，本轮不对 B 作任何声明；
  `docs/FASTPATH-SPIKE.md` 的 A1 评估数字（1002→302）是估算路径（每页明确 pageSize），
  实际默认 observe（100 行/页）落在 **202**，两者不矛盾但不要混用。

### 20.2 dashboard 捕获/HAR 视图：已脱敏、已有界 daemon 证据的代理

- **路由**：`GET /api/capture?session_id=&tenant=&since=&limit=&kinds=` 代理 `debug.query`，
  按 kind 归约 requests/console/pages 精简列表（每类最多 `MAX_CAPTURE_ROWS = 100` 行）；
  `GET /api/har?session_id=&tenant=` 代理 `debug.export {format:"har"}` 并服务 daemon 报告的
  产物。两者都走既有 dashboard 鉴权/租户/RBAC；页面「网络/捕获」区块手动 Load + 最多 10s
  低频刷新（**不跟随 2s 状态刷新**），CSP 不变、无外部资源、token 不回显。
- **HAR 产物校验（唯一读 daemon 本地文件的 dashboard 路径）**：路径必须来自 loopback daemon
  主机、后缀 `.har`、普通文件且 ≤ `MAX_HAR_ARTIFACT_BYTES = 32 MiB`、字节必须是 HAR 1.x JSON
  （string `log.version` + `log.entries[]`），并逐个扫描已配置凭据（命中 → `502 E_HAR_SECRET`
  **拒绝服务**）；失败为 `502 E_HAR_ARTIFACT_UNAVAILABLE`/`E_HAR_ARTIFACT_INVALID`（附已脱敏
  元数据）；`Content-Disposition: attachment; filename="bridgedeck-<session>-<utc timestamp>.har"`。
- **失败语义（不伪造）**：`debug.query`/`debug.export` 不支持 → 501 `E_NOT_SUPPORTED`；未知
  会话 → 404 `E_UNKNOWN_SESSION`；非法 `session_id`/过滤参数 → 400 `E_INVALID_PARAMS`。
- **边界**：dashboard **不重建 HAR、不重新抓包、不二次脱敏**；HAR 是 daemon 已有界（200
  请求/500 console/100 pages/200 operations、512 KiB body cap）且已脱敏捕获的投影，掩码值
  不可恢复；无 HAR 导入/回放；dashboard 仍无 TLS、loopback-only、账号本地 JSON、会话内存。

### 20.3 合规 ratchet：精确 token allowlist 与「只降不升」

- **数字**：ratchet **251 处 / 78 文件 → 63 处 / 14 文件**（−74.9%），hard **0**，442 文件扫描；
  allowlist 命中（不计入基线，仅报告）**168** 处。
- **allowlist 规则（硬边界）**：只按「命中所在的最大 token（`[A-Za-z0-9_$.-]`，两端被其它
  字符或文件边界截断）」与条目**区分大小写、完整相等**匹配；只豁免 **ratchet** 计数，
  **hard 零容忍不变**；**不接受**通配/前缀/正则/整文件豁免。条目只收**内部合同面标识符**：
  协议模块文件名（`methods-bsk.js`/`codecs-bsk.js`/`schemas-bsk.js`/`bsk-protocol.js` 等）、
  wire 字段/响应路径（`initialize.bsk.*`、`bsk-local.v1` 等）、上游参考源目录名
  （`bsk-0.5.0-src`/`BrowserSkill-cli-v0.5.0`）、wire 格式标记（`data-bsk-redacted`）；
  新的产品名/来源叙述仍按原规则计违规。
- **生成物**：`packages/protocol/src/{methods,codecs,schemas}-bsk.js` 与 `reasons.js` **不手改**——
  改生成器脚本的注释/header 文案后重生成，生成物与生成器一致；内部路径类注释改中性描述
  （不改行为）。基线重新生成且**只降不升**（本轮未上调、未为降计数删注释）。
- **边界**：ratchet 是轻量词法启发式（不解析正则字面量歧义），不是商标检索，不能替代人工
  review；hard 只覆盖「扫描范围」内的用户可见面，`docs/`/`STATUS.md`/`FINAL-AUDIT.md`
  等内部研究文档本来就在扫描外。

### 20.4 0.3 面板移植计划：只做计划、不做移植

- **结论**：0.3 的 audit/debug/ops/video/longshot 5 个面板（共 12,831 B，数据面全在扩展 SW，
  对 0.3 协议耦合 0）**一律不进 0.4 popup、不新开 0.4 扩展页、不加
  `debugger`/`tabCapture`/`offscreen`/`declarativeNetRequest` 四项权限**；能力收敛到
  dashboard 的**只读「会话详情」下钻**（B3 只读最小页 → B4 补齐网络/HAR、审计/账本、视频
  元数据、协作/human 视图），ops 真人脚本录制与截图/视频播放可视化记为 P4/P3、不移植。
- **协议面**：最小详情页**不新增任何 daemon 方法**，最多用现有 **13 个只读 + 2 个既有写**
  RPC；不引入 0.3 的 170 条 legacy 方法或通用 RPC 透传（dashboard 只读白名单原则保持）。
- **风险与验收**：`docs/PANELS-PORT-PLAN.md` 给出 B3/B4 任务表、真实 Edge E2E/DOM 断言、
  10 条风险、禁抄清单与开放问题。**关键风险如实**：该计划测得 dashboard 单文件
  139,815 B（3,354 行）且 `tools/scale-report.mjs` 跳过 `0.4/`（无体积门禁），而 J2 合并后
  `server.mjs` 已增至 **174,851 B** → B3 起必须先拆模块并把单文件预算写死。
- **边界**：本节与 `docs/PANELS-PORT-PLAN.md` 都是计划，**B3/B4 未启动**；不构成 UI 能力声明，
  也不改变 Wave D 验收本体（10 步 DSH 任务 + 可重放证据在 UI 展示）仍未完成的记录。

### 20.5 门禁/测试接线与证据（round 51，未改判定）

- `0.4/scripts/test-all.mjs` **未改**：J1 改的 `render.js` 及 `snapshot-handlers.test.mjs` 在
  `packages/` walk 内；J2 的 `dashboard/server.test.mjs`/`auth.test.mjs` 早已显式列出；J3 只改
  生成器/生成物；J4 只加文档。实测 **2145 passed + 1 skipped / 2146**、15 段全 `fail 0`。
- `0.4/scripts/stage-gate.mjs` **未改**、无新开关：`--with-remote` 18 / 默认 19 / 扩展 20 /
  `--with-ui` 19 / 仅预算 19（+bench 各 +1）。四次门禁全部**首跑绿**（`failed: []`/
  `retried: []`）：默认 **19/19**（228,628ms、`bench quick` 49,963ms 21/21）、扩展
  **20/20**（182,355ms；ingress 128/128、attribution 134/134）、`--with-ui` **19/19**
  （171,243ms；UI E2E 99/99）、仅预算 **19/19**（163,280ms；budgets 21/21 saved-latest）。
- `bsk-coverage --check`：围栏块按生成器重生成到不动点后 **OK**；分类不变 usable **77/77**
  （scope 条件）、full **53** / partial **0** / refused **0**、control **24/24 real**；
  代码 **222,271** 行 = **123,510** production + **98,761** test
  （**67.9% / 64.6% / 66.4%** of BSK 334,821）。

## 21. B4 收口边界（round 52, 2026-11-24）：dashboard 模块拆分与体积预算、只读会话详情的数据真源/部分失败、快路径 B 的 go/no-go 门槛、ratchet 26

本节记录 task-120（B4 收口）确立的边界。它**不改变任何 BSK 方法分类、既有阈值/预算/断言**；
唯一门禁语义变化是步数矩阵整体 **+1**（新增 pure 步 `dashboard size`），且该步只做只读体积测量。
K1-K3 的产品代码/文档由前置任务 landing，本节写清「做到了什么、数据真源在哪、什么时候降级、
什么是评估而不是能力」。

### 21.1 dashboard 拆分为 18 模块 + 装配层，体积上限是 reviewability 门禁

- **结构**：`0.4/dashboard/server.mjs` 从 **174,851 B** 降为 **28,240 B** 的装配模块（选项校验、
  共享状态、路由表、监听器生命周期、CLI re-export），路由逻辑全部下沉到 18 个模块：
  `constants`/`util`/`rpc`/`reducers`/`http`/`status-handlers`/`tenant-handlers`/
  `capture-handlers`/`har-handlers`/`session-handlers`/`auth-handlers`/`auth`/`html`/
  `page-css`/`page-script`/`page-capture-script`/`page-detail-script`/`cli`（外加
  `size-budget.json` 与两个测试套件）。页面 bundle 由 `html.mjs + page-css.mjs +
  page-script.mjs + page-capture-script.mjs + page-detail-script.mjs` 组成，仍是**单页面、
  无框架、无 CDN、无依赖、无外部资源**，CSP 不变（`img-src 'none'`）。
- **预算（`0.4/dashboard/size-budget.json` 的唯一真源）**：单模块 `maxModuleBytes 40,960` /
  `maxModuleLines 1,600`；装配模块 `maxServerBytes 32,768`；page bundle `maxPageBytes 90,112`；
  dashboard 源码树 `maxTotalBytes 262,144`；ingress UI 树 `maxTotalBytes 262,144`、
  locale 表 `maxLocalesBytes 122,880`。当前实测：page **73,069 B**、dashboard 树
  **236,297 B**（19 文件）、server **28,240 B**、ingress UI **219,787 B**、locales
  **105,978 B**，全部在限内。
- **判定**：`0.4/scripts/dashboard-size-check.mjs`（`--check` 是门禁动作、`--json` 机器可读、
  无参数打印表）逐项测量并按字节/行数判定；超限、预算路径缺失/不可解析、被预算的模块缺失
  一律非零退出。stage-gate 把它作为 pure 步 `dashboard size`（24 项检查，毫秒级、只读、
  不启浏览器、无依赖）——超限即整步 FAIL，不静默跳过。
- **边界**：这是**可复核性上限**，不是性能/安全结论（只测字节与行数，不做依赖/许可证/
  安全审查）；`*.test.mjs` 不计入单模块上限；`server.mjs` 有独立的装配上限（防止装配层
  重新长回单体）；调上限必须是一次**专门的**改动（改预算文件 + 说明），不能夹在无关 PR 里；
  `size-budget.json` 只计入 JSON 总量统计，不是代码行数。

### 21.2 `/api/session` 的数据真源、组合方式与部分失败语义

- **数据真源（全部是既有只读方法，不新增 daemon 方法）**：并发发出六个只读调用——
  `session.list`、`daemon.status`、`system.status`、`debug.status`、`cooperate.status`、
  `session.run_log`，归约为 `{ok, at, source:"daemon", session_id, daemon, session,
  borrowed_tab_ids, observed_tab_ids, agent_window_id, agent_window_released, human,
  cooperate, capture, runs, trace_summary, extension, sources, errors[]}`。
  逐块真源：`session` ← `session.list`，不可用时回退 `daemon.status.sessions`；
  `borrowed_tab_ids`/`observed_tab_ids`/`agent_window_id`/`agent_window_released` ←
  `daemon.status`；`human`/`cooperate` ← `cooperate.status`；`capture` ← `debug.status`；
  `runs` ← `session.run_log`（有界条目，**不含 trace body**）；`extension` ← `system.status`；
  `trace_summary` 合并 capture 的 run id/state/counts 与 run 的 step/state 总数。
  `GET /api/session/sources` 返回这层映射（每个 block 对应哪个 daemon 方法、属于
  `daemon` 还是 `extension` 平面），**不发起任何 RPC**。
- **失败语义（绝不编造值）**：主 `daemon.status` 失败 → 整个路由返回映射后的上游错误
  （502/503）；未知会话 → `404 E_UNKNOWN_SESSION`；缺失/不安全 `session_id` →
  `400 E_INVALID_PARAMS`；其余任一方法缺失/失败 → 该 block 为 `null`（`human` 为 `null`）
  并在 `errors[]` 追加 `{method, code, message, upstream_status, upstream_code}`，**会话事实
  仍然可用**。`?tenant=` 与 `/api/trace` 完全一致的租户解析/鉴权；accounts 模式下仍受
  RBAC/CSRF 约束（读路由免 CSRF，与既有只读面一致）。
- **页面（只读、按需）**：点会话行或聚焦后回车打开页内 **Session detail** 块；
  `#/session/<session_id>` 记录选择（可复制/书签/刷新后保留），`Back to sessions` 清除。
  该块**故意不参与 2 s 状态轮询**：选中时加载一次，只在 Refresh 或换选中时重读；展示
  L0 状态行 / L1-a 会话事实 / L1-d 借用与窗口 / L1-e human 协作 / L1-b 有界 run 摘要 /
  L1-g capture / 数据源映射 / 部分失败列表 / L3 有界 JSON（`textContent`，截断 6000 字符）。
  空态、未知会话、上游不可达、部分失败四类状态都显式渲染；**从不接收或显示** daemon token、
  dashboard token、cookie、CSRF token。
- **边界**：这是 dashboard 的 HTTP 层组合，**不是新的 daemon 协议面**；无重试、无缓存、
  无流式；不提供截图/视频/trace body；详情视图**只读**（不提供 act/open/close）；不改变
  `/api/status`、`/api/trace`、`/api/capture`、`/api/har` 的既有语义；六个方法任一未实现时
  按上条降级而不是假装成功。

### 21.3 快路径 B（页内紧凑提取）spike 的 go/no-go 门槛（未落代码）

- **决策：有条件 GO —— 选「B-提取」，不做「页内渲染器」**：页内只做一次自包含 collector
  （语义对齐 `vom-extract.js`，**不复制** 0.3 `page-lib.js` 代码/文案），渲染仍在 daemon 侧
  用 0.4 现有 `vom/src/render.js`；ref 保留 `bn<backendNodeId>` 语义，v1 用「只回填落地行」
  的懒 ref。**不**把 observe 默认改成无 ref（0.4 动作链只认 `bn` 句柄），**不**平移 page-lib
  的 150 KB 渲染管线。
- **实测（真实 headless Edge 158，2 次预热 + 10 次计时，三页）**：B-提取（无 ref）p50
  **2.8 / 5.7 / 5.8 ms**、p95 3.4 / 6.9 / 8.1 ms、**每次观察 1 条 CDP 命令**、回复
  14.9 / 41.9 / 41.9 KB（请求 73 B）；B-整链（含 ref 回填）p50 12.2 / 20.6 / 20.9 ms、
  131 / 153 / 153 命令、回复 71.7 / 177.1 / 177.3 KB；**text 与现状 A 及 pre-A 逐字节相同
  （3/3）**、节点字段投影差异 **0**；unchanged 快路径 1 命令 / 47 B / 0.18–0.22 ms；
  cursor 第 2 页 0.84–1.93 ms（带 `rev` 校验 0 命令）。
- **验收门槛（G1–G12，不过就停）**：text 逐字节相同（含 refs）、节点投影差异 0、
  1000/5000 行页 p50 ≤ A 的 0.5×、p95 ≤ A 的 0.6×、命令数 = 3 + 落地未解析行数、
  回复字节 ≤ A 的 0.7×、unchanged ≤1 命令/≤1 KB/≤1 ms、cursor 第 2 页 ≤3 ms、
  隔离世界不可被主世界看见/篡改 DOM API 不影响结果、collector 零 DOM 写且单次 <10 ms、
  OOPIF 覆盖不回归（v1 明确排除需文档化）、重复 id 的 ref 语义变更已登记且有测试。
  **G13（observe ≤1 命令且回复 ≤10 KB）只有"页内句柄 ref"路线能满足，B-整链不满足**。
- **no-go / 停止条件**：①产品要求 ref 与现状**逐字节一致（包括重复 id 的既有 bug 行为）**
  且不接受 domPath 回退的 +7 ms；②v1 必须覆盖 OOPIF（+2–4 人日）；③远程 daemon 要求
  observe 回复 ≤10 KB 而拒绝句柄 ref 路线；④页内 `rev` 失效语义无法覆盖布局型变化且不接受
  保守重抓（属可接受降级，不阻塞 G1–G6）。
- **成本**：v1（主帧 + 同源 iframe + open shadow，B-整链）**6–8.5 人日**（含测试与回退）；
  加惰性句柄 ref 为 **7–10.5**；OOPIF 单列 **+2–4**（建议 v2）。
- **边界**：这是 spike（原型在 `%TEMP%`，跑完已清理，**未入仓**），同机同批次相对量级
  （loopback CDP、后台负载，历史有 ±20% 波动），**不构成发布性能结论**；未改任何产品代码、
  测试、bench 场景或预算行；A1（懒解析 ref）仍是已落地的快路径，B **未落地**；fixture 有
  1 处 ref 差异（重复 id `#marker-drag`），B 指向真实元素、现状指向第一个元素——B 更正确，
  但这是**语义变更**，需产品拍板。

### 21.4 合规 ratchet：63/14 → 26/4，只降不升

- **数字**：ratchet **63 处 / 14 文件 → 26 处 / 4 文件**（−37 处、−10 文件，−58.7%；
  相对最初的 251/78 为 −89.6%），hard **0**，**460** 文件扫描；allowlist **168** 处不变。
  剩余 4 个文件：`bench/README.md` **20**（BSK 对照章节，设计上的例外）、
  `packages/protocol/scripts/report-methods.mjs` **2**、`packages/protocol/src/codecs-bsk.js`
  **2**、`packages/protocol/src/schemas-bsk.js` **2**。
- **做法**：把 `extension-ingress` 的注释与测试样本文案改成中性表述（**不改行为、不改断言**，
  自测/回归仍全绿），基线由 `--write-baseline` 重新生成为**更低**的值；没有为降计数删注释、
  没有放宽 hard 判定、没有扩大 allowlist、没有改扫描范围/排除项。
- **边界**：ratchet 是轻量词法启发式（不解析正则字面量歧义）、不是商标检索、不能替代人工
  review；`docs/`/`STATUS.md`/`FINAL-AUDIT.md` 等内部研究材料本来就在扫描外；`bench/README.md`
  的 BSK 对照是唯一被接受的成规模例外（它是 bench 基线文档，不是产品面）。

### 21.5 门禁/测试接线与证据（round 52，步数矩阵 +1、无阈值变化）

- `0.4/scripts/stage-gate.mjs` 新增 pure 步 `dashboard size`（`dashboard-size-check.mjs
  --check`），**所有组合 +1**：`--with-remote` **19** / 默认（+bench）**20** / 扩展 **21**
  （+bench **22**）/ `--with-budget` **20** / `--with-crash-inject`/`--with-transfer`/
  `--with-tenant`/`--with-mtls`/`--with-ui` 各 **20**；开关仍相互正交，summary JSON 字段不变
  （该步是默认步骤，不需要新 `with*` 字段）。未改任何断言/阈值/预算值/步骤判定语义。
- `0.4/scripts/test-all.mjs` **未改**：拆分后的 `dashboard/server.test.mjs`（**72**）与
  `dashboard/auth.test.mjs`（**13**）早已在显式列表内；`dashboard-size-check` 是门禁步骤而
  不是 `node --test` 套件，无需收集；无新增 walk 根外测试。实测 **2154 passed + 1 skipped /
  2155** tests、15 段全 `fail 0`。
- 门禁/独立验证（全部实跑）：默认 gate **20/20**、扩展 gate **21/21**、`--with-ui` **20/20**、
  `--with-budget` **20/20**，均**首跑绿**（`failed: []`/`retried: []`）；`eval` **43/43**；
  `product-compliance --check` **PASS（460 / hard 0 / ratchet 26 in 4 / allowlisted 168）**；
  `source-guard` clean（encoding **1141** 文件）；`dashboard-size-check --check` **PASS
  （24 项）**；`bsk-coverage --check` 围栏块重生成后 **OK**：分类不变 usable **77/77**
  （scope 条件）、full **53** / partial **0** / refused **0**、control **24/24 real**；
  代码 **224,182** 行 = **124,932** production + **99,250** test（**68.7% / 64.9% / 67.0%**
  of BSK 334,821），JSON **73** 文件 / **24,685** 行。
- **边界**：以上是实测事实（同机、真实 Edge，单次采样）；未观测到 flake，历史 flake
  （round 38/41/42 phase-13、round 46/48 人类归因、round 49 wait 竞态）记录不变，
  低概率仍是「未复现」而非「概率 0」；本机无 `git`，改动以文件列表为准。

## 22. B5 收口边界（round 53, 2026-11-24）：快路径 B 页内紧凑提取、dashboard 只读下钻代理、体积预算调整、ratchet 4

本节记录 task-121..task-126（B5 收口）确立的边界。它**不改变任何 BSK 方法分类、既有阈值、
断言或步骤数**：usable 仍 **77/77**（scope 条件）、full **53** / partial **0** / refused **0**、
control **24/24 real**；门禁步数矩阵不变（默认 **20**、扩展 **21**、`--with-ui` **20**、
`--with-budget` **20**），本轮没有新增门禁步骤。唯一数值变化是 **dashboard 源码树体积上限
262,144 → 294,912 B**（专门改动，理由与实测见 §22.5），其余预算值不动。

### 22.1 快路径 B 契约：页内只提取、daemon 侧渲染、惰性 ref

- **页面侧只做提取**：`0.4/extension-ingress/content/collect.js` 是 MV3 声明式内容脚本
  （classic IIFE，`globalThis.__bb04Collect(opts)`，命名空间 `__bb04Collector`）；
  `opts = {maxNodes=2000, includeShadow=true, includeIframes=false, viewportOnly=false}`
  （SW 侧 `maxNodes` 夹紧到 20000），返回 **CompactTree v1**
  `{v:1, url, title, truncated, nextId, nodes[]}`，节点基础字段
  `id/path/tag/role/name/rect/visible/actions/depth/parentId`（iframe 内节点另有 `frame`）。
- **path 语义**：从 `documentElement` 起逐级 `nth-of-type` 的唯一选择器；open shadow 用
  ` >>> ` 分隔，同源 iframe 用 ` >>frame>> ` 分隔。渲染不读 path 的业务含义，只在 daemon 侧
  用 path 解析 ref。
- **只读契约（collector 零副作用）**：只调用 `getBoundingClientRect`/`getComputedStyle`/
  `getAttribute`/`textContent`/`children`/`attributes`/`shadowRoot`/`contentDocument` 与只读
  property（`value/checked/selected/href/type/multiple/disabled`）；不写 DOM、不改属性、不注入
  样式、不装 observer。closed shadow root 无法遍历（`shadowRoot === null`，与页面可见性一致）
  就跳过；跨源 iframe 访问 `contentDocument` 抛错/返回 null 就跳过（不伪造跨源内容）；
  `head/script/style/template` 等 `display:none` 子树剪掉；布局盒为 0 的节点不返回。
- **命令面与发现**：daemon ingress 命令 `ext.collect` 由 `src/bridge.js` 在 dispatch 之前拦截
  （`commands.js` 的 ext.* 路由表保持不动）；SW 用
  `chrome.tabs.sendMessage(tabId, {kind:'bb04.collect', opts})` 触发页内提取，回包先过
  CompactTree 结构校验再交给 daemon。`register.capabilities` 与 `bridge.snapshot().methods`
  使用 **`INGRESS_COMMAND_METHODS` = commands.js ext.* 白名单 + `ext.collect`**，daemon 据此
  发现快路径 B 支持。
- **typed 错误（两个稳定码，已登记 `src/errors.js`）**：`E_COLLECT_UNAVAILABLE` —— 页面不可
  提取（受限页/内容脚本未注入/无回执/超时/无目标 tab）；`E_COLLECT_INVALID` —— 参数非法或
  回包不是合法 CompactTree。**不把「没有回执」当成空树**，失败走 `extension.complete{ok:false}`。
- **daemon 侧渲染不出现第二份实现**：`0.4/packages/browser-adapter/src/tree-render.js` 把
  CompactTree 映射回 `VomNode[]`（role/tag/name/rect/visible/actions 与可选字段透传），用 0.4
  现有 `packages/vom/src/render.js` 渲染；先以 `withRefs:false` 渲染拿到**真正落地**的行，
  只对这些行的 path 做只读 `DOM.querySelector` + `DOM.describeNode` 回填 `bn<backendNodeId>`，
  再带 ref 重渲染（最多 3 轮收敛安全阀）。
- **证据**：`tree-render.test.mjs`、`snapshot-handlers.test.mjs`、`collect.test.mjs`
  （`node:vm` + fake DOM，浏览器-free）、extension smoke（manifest `content_scripts` 三条
  human-watch/status-overlay/collect 精确匹配、编码扫描含 `content/collect.js`、错误码登记）。

### 22.2 seam、开关与回退矩阵（默认关闭，行为不变）

- **开关**：`createSnapshotHandlers({cdp, extractNodes, render, fastpathB = false,
  treeProvider = null, resolveTreeRefs = null})`。只有 `fastpathB === true` **且**
  `treeProvider` 是函数时才尝试快路径 B；否则连分支都不进入。
- **本轮如实边界**：`treeProvider` 的 daemon 接线（把扩展 `ext.collect` 注入 snapshot handler）
  **尚未落地**，daemon 里没有任何默认启用 B 的路径；因此 0.4 的观察/快照行为与 round 52
  完全一致，B 只是已测试的 adapter seam + 单测/录制注入点，不是已接线的默认能力。
- **回退矩阵**（任何一项都返回 `{ok:false, reason}`，由 `snapshot-handlers` 静默回退现有
  快路径 A/legacy；输出与关闭开关时一致）：

  | reason | 触发条件 | 结果 |
  | --- | --- | --- |
  | `provider-throw` | `treeProvider()` 抛错（扩展离线/`E_COLLECT_*`/超时） | 回退，不影响本次观察 |
  | `invalid-tree` / `invalid-node` | 结构/字段非法、重复 id、父链成环 | 回退（拒绝半可信树） |
  | `tree-truncated` | 节点数 > 500（与 `vom-extract.js` 页内上限一致） | 回退 |
  | `cross-frame` | 节点带非 0 `frameId`（v1 只覆盖主帧） | 回退（同源 iframe 是后续开关） |
  | `ref-resolution-affects-rows` | 表格单元格行集受 ref 解析影响 | 回退 |
  | `shadow-unsupported` | path 含 `>>>` 但没有 `resolveTreeRefs` pierce seam | 回退 |
  | `ref-resolution-failed` | 落地行解析失败 / 3 轮未收敛 | 回退 |
  | `render-throw` | 渲染/解析抛异常 | 回退 |

- **回退语义**：静默、同输出；**绝不**输出半可信文本，也**绝不**把 B 的失败变成空观察
  （空树同样是非法的）。B 只是优化，输出契约仍是现有 A/legacy。
- **证据**：`snapshot-handlers.test.mjs` 覆盖 fastpathB on/off、provider 失败回退、非法树
  回退、cursor 分页一致；`tree-render.test.mjs` 覆盖 golden 文本、只解析落地行、路径解析失败
  回退、truncated、零 DOM 写；无新增 wire 方法、无 bench 场景、无预算行。

### 22.3 可选语义字段：只在存在时携带，敏感值不出页面

- **字段（全部可选，只在存在/适用时出现；缺失时由现有渲染器自行降级）**：

  | 字段 | 语义 | 截断/脱敏 |
  | --- | --- | --- |
  | `value` | input/textarea 当前值；select 单选 = 选中值字符串，多选 = 选中值数组（无选中项 `[]`） | 敏感控件置空 `''` 并置 `sensitive:true` |
  | `checked` | `input[type=checkbox\|radio]` 的当前 `checked` | — |
  | `selected` | `option` 的当前 `selected` | — |
  | `href` | `a[href]` 的绝对 URL（`element.href` 优先，相对值按页面基址解析） | 截断 2048；无 href 不携带 |
  | `attrs` | 白名单属性的当前值：`aria-expanded`/`aria-checked`/`aria-pressed`/`placeholder`/`disabled`/`readonly`/`required` | 每个值截断 120；一个白名单属性都没有时不携带 |
  | `sensitive` | 敏感控件标记（`password`/`file`/`hidden` 或敏感 autocomplete），仅 `true` 时携带 | 与 `human-watch.js` 的 `isSensitiveField` 同一约定 |

- **为什么需要它们**：CompactTree 基础字段只覆盖「只有这些字段参与渲染」的页面；完整 collector
  提供上述字段时，B 的渲染文本才能与 CDP 提取路径逐字节一致。`tree-render.js` 只透传
  `renderVom` 真正会读的 VomNode 字段（`PASSTHROUGH_FIELDS` 白名单），**不在 adapter 造第二份
  渲染语义**，缺失字段时渲染器自动降级（最小契约只有 `name` 也能渲染）。
- **边界（如实）**：`attrs` 只是白名单而不是全量属性镜像；`href`/`attrs` 的截断是字节/字符上限，
  超长链接只能看到前缀；敏感控件的明文值绝不出页面（置空 + `sensitive:true`），但字段名/数量/
  是否敏感仍会随树返回。可选字段不改变现有节点数量、路径或 `actions` 推断。

### 22.4 dashboard 只读下钻代理（B4.2-B4.4）

- **三条只读薄代理（全部走既有 daemon 方法，不新增协议面）**：
  - `GET /api/session/audit?session_id=[&tenant=][&limit=]` —— daemon 自己的 `audit.request`
    摘要 + 有界动作 WAL（`ledger.list`/`ledger.pending`）；与 dashboard 写审计环 `/api/audit`
    是两件事（后者是 dashboard 自身写操作审计）；
  - `GET /api/video?session_id=[&tenant=][&limit=]` —— `video.status` + 该 session 的
    **metadata-only** `video.list` 目录行；没有播放器、不读文件，`artifact_dir`/`path` 只做
    有界文本；
  - `GET /api/session/cooperate?session_id=[&tenant=]` —— `cooperate.status` 视图
    （human 状态、authority/overlay、已签发的 context/observation）。
- **有界**：audit 行数上限 **100**、video 行数上限 **50**（`limit` 1..max 夹紧，非法 `limit`
  → `400 E_INVALID_PARAMS`）。
- **失败语义（绝不编造）**：主调用未实现 → `501 E_NOT_SUPPORTED`；未知 session →
  `404 E_UNKNOWN_SESSION`；坏/缺 `session_id` → `400 E_INVALID_PARAMS`；其余上游失败沿用既有
  映射；富化块失败 → `null` + typed `errors[]` 条目，主块仍可用。
- **边界**：租户作用域与 `/api/session` 一致；daemon token 只走出口 `Authorization` 头，
  所有返回字符串都经 redact/clamp；页面只读展示（无 act/open/close、无视频播放、无文件读取、
  无重试/缓存/流式），不改变既有 `/api/status|trace|capture|har|session` 语义。
- **证据**：`dashboard/server.test.mjs`（代理成功/未知会话/上游失败/租户/token 不回显）、
  `dashboard-session-e2e.mjs`（真实 headless Edge + 真实 daemon 的会话详情 E2E，standalone）。

### 22.5 体积预算调整（dashboard 源码树 262,144 → 294,912 B）与 ratchet 4/2

- **预算调整（专门改动，只上调容量类上限）**：round 52 的 dashboard 源码树上限
  **262,144 B** 在 round 52 的只读会话详情模块 `session-read-handlers.mjs`（9,487 B）落地后
  只剩 **411 B** headroom（实测 **261,733 B**），不足以容纳下一个可复核模块。本轮把
  **dashboard 源码树 `maxTotalBytes` 262,144 → 294,912 B**（288 KiB，headroom 33,179 B），
  并在 `size-budget.json` 的 note 与 `dashboard/README.md` 写明理由；**单模块 40,960 B/1,600 行、
  装配模块 32,768 B、page bundle 90,112 B、ingress UI 树 262,144 B、locale 表 122,880 B
  全部不变**（不虚高源码/页面预算，拆分架构仍被强制）。`dashboard size` 步实测 **25 项 PASS**
  （page **81,070 B**、dashboard 树 **261,733 B**、server **29,223 B**、ingress UI
  **219,787 B**、locales **105,978 B**）。
- **ratchet 26 → 4（只降不升）**：剩余 **4 处 / 2 文件**，都是生成契约数据的 provenance 措辞
  （`packages/protocol/src/codecs-bsk.js` 2 + `packages/protocol/src/schemas-bsk.js` 2）；
  hard **0**，**465** 文件扫描，allowlist **186** 处（精确 token，只豁免 ratchet 计数，hard 仍零
  容忍）。本轮**没有**扩大 allowlist、没有改扫描范围/排除项、没有为降计数删注释；基线只降不升。
- **边界**：体积上限只是可复核性上限（字节/行数），不是性能/安全结论；ratchet 是轻量词法
  启发式，不是商标检索，不能替代人工 review。

### 22.6 门禁/测试接线与证据（round 53，步骤数/阈值/分类均不变）

- **步骤数不变**：`0.4/scripts/stage-gate.mjs` **未改**（未加/未改任何步骤），组合矩阵仍是
  `--with-remote` **19** / 默认（`--with-remote --with-bench`）**20** / 扩展
  （`--with-remote --with-extension`）**21** / `--with-ui` **20** / `--with-budget` **20**；
  `dashboard size` 仍是默认 pure 步（本轮 **25 项**，因为 dashboard 模块数从 19 → 20 后检查项
  仍是每模块一项 + 装配/页面/总量/ingress 两项）。未改任何断言/阈值/判定语义。
- **`test-all` 收集**：显式加入 `0.4/extension-ingress/test/collect.test.mjs`（browser-free：
  `node:vm` + fake DOM/`chrome.*`/clock，无真实浏览器、无 bench → regular 4 路组，不进 serial
  heavy lane）；其余 6 个 `extension-ingress/test/*.test.mjs` 已由 round 47/48/50 收集，
  `test/smoke.mjs` 仍是 standalone fixture runner（不是 `*.test.mjs`）。
- **smoke 4 条陈旧断言修复**（不放宽）：`content_scripts` 两条 → **恰好三条**且逐条精确匹配
  `human-watch`/`status-overlay`/`collect`（含 matches/js/run_at/all_frames 与三条 classic-script
  检查）；`register.capabilities` 与 `bridge.methods` 改比 **`INGRESS_COMMAND_METHODS`**
  （ext.* + `ext.collect`）；编码扫描加 `content/collect.js`；新增 `E_COLLECT_*` 登记一致性检查。
  修复前 **337 passed / 4 failed / 341** → 修复后 **345 passed / 0 failed / 345**。
- **实测证据（全部实跑；同机、真实 Edge 158、单次采样）**：
  - `test-all` **2217 passed + 1 skipped / 2218**（15 段全 `fail 0`；相对 round 52 的 2155
    **+63** = collect **29** + tree-render **16** + snapshot 22→**31** + dashboard server 72→**81**）。
  - 默认 gate **20/20 PASS 首跑**（wall **215,128ms**；`bench quick` **47,875ms 21/21**、
    `dashboard size` **25 项**、`product compliance` **465 / hard 0 / ratchet 4 in 2 /
    allowlisted 186**、`source guard` clean encoding **1141**、`eval` 43/43）；
    扩展 gate **21/21**（wall **154,045ms**；ingress **128/128**、attribution **134/134**）；
    `--with-ui` **20/20**（wall **173,364ms**；UI E2E **99/99**）；
    `--with-budget` **20/20**（wall **166,666ms**；`bench budget` 50ms → 21/21 saved-latest）。
  - standalone：dashboard 会话详情 E2E **24/24 checks + 4/4 cleanup ×2**（status pass、exit 0、
    1,564/1,571ms、profile/临时目录清理、无残留进程、token 不回显）；`collect` **29/29**；
    adapter（`tree-render` + `snapshot-handlers`）**47/47**；`smoke` **345/345**；dashboard
    **94/94**（server 81 + auth 13）；`eval` **43/43**（17 seeds）；`product-compliance --check`
    **PASS**；`source-guard` clean（253 files / encoding 1141）；`scale` ok（baseline 760/91016）。
  - `bsk-coverage --check`：围栏块重生成到**不动点**后 **OK**（77 method names + 输出块逐行
    一致）；分类不变 usable **77/77**（scope 条件）、full **53** / partial **0** / refused **0**、
    control **24/24 real**；代码 **230,251** 行 = **127,538** production + **102,713** test
    （**70.1% / 67.2% / 68.8%** of BSK 334,821）；`[2]` 区域 `extension-ingress` 23,300 →
    **25,933**、`packages/browser-adapter` 31,540 → **32,935**、`dashboard` 9,429 → **10,521**、
    `tests` 21,971 → **22,862**、`scripts` 5,815 → **5,873**；JSON **73** 文件 / **24,704** 行。
- **flake / retry**：test-all + 4 次门禁 + 全部 standalone **首跑绿**，`failed: []` /
  `retried: []`，**未观测到 flake**；历史 flake（round 38/41/42 phase-13、round 46/48 人类归因、
  round 49 wait 竞态）记录不变，低概率仍是「未复现」而非「概率 0」。
- **边界**：以上是实测事实（同机、真实 Edge，单次采样；bench quick 为单样本，并发比例噪声的
  历史结论不变）；未观测到 flake 不等于概率 0；本机无 `git`，改动以文件列表为准。

## 23. B6 收口边界（round 54, 2026-11-24）：快路径 B daemon 接线（默认关闭）、像素级视觉基准、ratchet 0

本节记录 task-127..task-130（B6 收口）确立的边界。它**不改变任何 BSK 方法分类、阈值或断言**：
usable 仍 **77/77**（scope 条件）、full **53** / partial **0** / refused **0**、
control **24/24 real**、0 typed-unsupported control methods；**没有新增 wire 方法/字段/错误码**。
门禁矩阵只新增两个 **opt-in** 步骤（`--with-fastpath-b`、`--with-ui-visual`，各 +1），默认
19/20/21 步语义与扩展 21/22 步语义**不变**。合规 ratchet 从 **4 处 / 2 文件** 降到
**0 处 / 0 文件**（生成器中性化，见 §23.3），基线只降不升。

### 23.1 快路径 B：daemon 接线落地（round 53 的书面边界已关闭，默认仍关闭）

- **开关语义（显式 > 环境变量 > 默认关）**：`createBrowserDaemon({ fastpathB, fastpathBOpts })`；
  `fastpathB` 省略/`null` 时读 **`BB_FASTPATH_B`**（`1`/`true`/`on`/`yes` 视为开启，其它值/
  未设置视为关闭），显式布尔值优先且 `fastpathB:false` **不会**被继承的环境变量覆盖。默认 **false**。
- **`fastpathBOpts` 只收两个可选字段**：`tab_id`（显式扩展 tab id；省略时 provider 绑定本
  session）与 `opts`（原样转发给 `ext.collect` 的 collector 选项：`maxNodes`/`includeShadow`/
  `includeIframes`/`viewportOnly`）；未知字段是 typed `TypeError`，绝不静默忽略。
- **接线**：开启且注入的扩展客户端有 `collect()` 时，daemon 为**每个 observation** 建一个
  **session 绑定** 的 `treeProvider`（`ext.collect { session_id }`，或显式 `tab_id` 覆盖；
  provider 自身不抛错，失败由 adapter 当作“回退”），并以
  `createSnapshotHandlers({ fastpathB: true, treeProvider })` 交给 adapter。**一次 observation
  只做一次扩展往返**，页面侧 `Runtime.evaluate` 提取被完全替代。
- **能力视图（read-only、不含页面数据/token）**：`initialize.fastpath_b`、`server.fastpathB`、
  `daemon.fastpathBInfo()` 报告
  `{ enabled, active, collect, session_bound, default:false, env:'BB_FASTPATH_B' }`；
  `active:true` 才表示“开关打开 **且** ingress `ext.collect` 可用”。一次性 CLI 的
  `--fastpath-b` 没有 extension ingress，JSON 里如实报 `E_UNSUPPORTED`（不伪造快路径）。
- **回退矩阵不变（round 53 §22.2 仍然有效）**：provider 抛错 / 非法树、非法节点、重复 id、
  父链成环 / >500 节点截断 / 非主帧 / 表格行集受 ref 解析影响 / 无 pierce seam 的 shadow 路径 /
  落地行解析失败 / 3 轮未收敛 / 渲染抛错 → 一律 `{ok:false, reason}` 后**静默回退** A/legacy，
  输出与关闭开关一致；绝不输出半可信文本，也绝不把失败变成空观察。
- **真实 headed-Edge E2E 证据**（`0.4/tests/fastpath-b-e2e.mjs`，opt-in）：同一页面、同一标签页
  A / fastpathB off / on 各 5 次 observe+snapshot，**106/106 checks ×2 轮稳定**：
  - 文本**逐字节相同**（3,684 B、86 refs、sha256 `df30ff52…`），敏感值脱敏一致
    （`[redacted]` 存在、明文 `secret_absent`）；
  - 页面侧 `Runtime.evaluate`：**on = 0 次 vs off = 10 次**（10 次调用），on 路径仍有只读
    `DOM.querySelector`（懒 ref 未退化）；
  - p50（同机相对、单次采样）：on observe 26.95 ms vs off 30.47 ms（Δ **−3.52 ms**），on
    snapshot 22.76 ms vs 25.39 ms（Δ **−2.63 ms**）；门禁内一次采样 Δ observe **−12.71 ms**/
    snapshot −1.73 ms。脚本只断言“额外开销 < 150 ms”，**不**把 p50 改善当门槛；
  - daemon 真实 `observe` 走 B：5 次 `ext.collect` **全部带 `session_id`**、期间 session CDP
    **0 次 `Runtime.evaluate`**、文本与 off 基线逐字节相同、结果 ref 集合一致；
  - `initialize.fastpath_b` 与 `daemon.fastpathBInfo()` 一致（`enabled/active/session_bound=true`、
    `default:false`），清理（session/channels/server/fixture/browser/staging/workRoot）全 true。
- **文本字段边界（重要，round 53 已写、B6 复述）**：CompactTree 契约**不带** A 提取路径的
  `text` 字段；带直接文本的节点在 `planBudget` 里成本不同，**“截断型” snapshot 的截断点可能
  不同**。E2E 夹具改用 `aria-label` 让两条路径逐节点成本一致，才断言截断文本逐字节相同——
  “逐字节等价”是在该夹具/该成本条件下证明的，不是对任意页面的无条件承诺。
- **其它边界**：v1 仍**仅主帧**（collector `all_frames:false`，渲染器遇非 0 `frameId` 回退）；
  open shadow 行若进入渲染窗口且没有 pierce seam，B 如实回退 A；B 仍**默认关闭**，默认
  observe/snapshot 与之前逐字节一致；**没有**发布级性能结论——收益口径是“页面侧提取命令
  10→0”，时延只是同机相对量。

### 23.2 像素级视觉基准（opt-in `--with-ui-visual`）

- **三个真实表面**：扩展 popup（420×760）、options（900×1000）、dashboard 会话详情
  （1400×800）；真实 headed Edge + staging MV3 扩展 + 真实 daemon/dashboard，截图走 page session
  的 CDP `Page.captureScreenshot`。
- **零第三方图像依赖**：自写 PNG 解码（`node:zlib` inflate + IHDR/IDAT + 5 种 filter 反滤波 +
  RGB(A) 展开），断言 IHDR 尺寸、非空像素/ink 覆盖率、对比度（p05/p95 WCAG ≥4.0）与关键区域
  ink。
- **基线即数据**：`0.4/tests/fixtures/ui-baseline/{popup,options,dashboard}.json`（version 1，
  每页：尺寸 + 16×16 网格平均色 + 统计 + PNG sha256），只由 `--write-baseline`（1 轮）生成；
  **校验模式只读基线、绝不回写**（门禁只跑校验模式）。
- **容差（写进基线 JSON 便于审阅）**：每格每通道平均色差 **≤10/255** → 整页 256 格全过即
  PASS（严格 all-cells）；否则允许“差异格比例”模式：>10/255 的格子 **≤12%（≈30 格）** 且
  256 格平均差 **≤3.0** → PASS。**尺寸必须精确相等**（viewport 固定，1 px 漂移即 FAIL，
  `sizeTolerancePx:0`）。统计下限：nonBackgroundRatio ≥0.01、inkCoverage ≥0.003、contrast ≥3、
  distinctColors ≥8、regionInk ≥0.002。
- **每页检查**：尺寸、非空/ink、对比度、网格基线、可见文本禁词（与产品合规同一张词表）、
  无外链（DOM 里不得出现 http(s):// 外部来源）、CSP（扩展页注入内联 `<script>` 必须被
  `script-src 'self'` 阻断；dashboard 校验真实响应头 `default-src 'none'`/无外部 script origin/
  `connect-src 'self'`）。
- **默认两轮**：`--repeat 2`（校验默认）→ 两轮都必须匹配**同一份**基线，且两轮网格互比
  （同一容差）一致（`consistencyRequired:true`、`consistent:true`）；门禁只接受这种形态。
  实测证据：**41/41 checks ×2 轮**，三页 all-cells 全过（差异格 0、最大单格差 ≤1.9/255），
  cleanup（staging/workRoot）true；门禁步骤 `--with-ui-visual`（+1，browser lane，600 s 上限）
  只做附加校验，exit 2 = BLOCKED（缺 Edge / 检测到并发浏览器测试）在门禁里同样 **FAIL**。
- **诚实边界**：截图是真实渲染帧，但**不冻结时钟**——会话 id/时间字样逐次微变，由网格容差
  覆盖并如实报告差异格数；截图只落临时目录；它不是全站视觉回归（只覆盖三个固定表面、固定
  viewport/locale），容差是**有界比较**而非像素相等；默认门禁**不含**该步骤。

### 23.3 ratchet 4/2 → 0/0：在生成器中性化，而不是手改生成物

- 剩余 4 处是生成契约数据的 provenance 措辞（`packages/protocol/src/codecs-bsk.js` 2 +
  `schemas-bsk.js` 2）。这两个文件首行标“勿手改”，所以本轮**不手改产物**，而是新增生成器后处理
  `0.4/packages/protocol/scripts/neutralize-contract-text.mjs`：
  - `NEUTRAL_TEXT_RULES` 只把 `description` 字符串里的被动来源叙述 `derived from` 换成
    语义等价的 `computed from`（整词、大小写不敏感、幂等）；
  - **只处理 `description`**；`title`/`type`/`enum`/`pattern`/`required`/`additionalProperties`
    等结构字段一律不碰；
  - `import-schemas.mjs` 与 `gen-bsk-codecs.mjs` 在写文件前调用同一函数，产物可重生成；
  - 协议源码对拍测试对上游原始 schema 调用**同一个** `neutralizeSchema()` 再做 deepEqual，
    因此 113 份契约仍是**逐字段全等**（只有来源叙述文案被规范化），wire 方法/字段/错误码不变。
- **合规现状**：hard **0**、ratchet **0 处 / 0 文件**、扫描 **466** 文件、
  allowlist **189** 处（精确 token，只豁免 ratchet 计数，hard 仍零容忍）。本轮**没有**扩大
  allowlist、没有改扫描范围/排除项、没有为降计数删注释或改断言；基线 note 明确“ratchet 基线
  为零，任何新的来源叙述措辞都是回归”，基线**只降不升**。

### 23.4 门禁/测试接线（默认步数不变，两个新步骤均为 opt-in）

- **stage-gate 新增两个 opt-in 步骤**（只加进 opt-in 组合）：
  - `--with-fastpath-b` → `fastpath b e2e`：`0.4/tests/fastpath-b-e2e.mjs`（默认 `--runs 2`），
    browser lane cap=1，门禁侧 **420 s** 上限（脚本内部 360 s watchdog）；
  - `--with-ui-visual` → `ui visual baseline`：`0.4/tests/ui-visual-baseline.mjs`（默认
    `--repeat 2`，校验模式），browser lane cap=1，门禁侧 **600 s** 上限（脚本内部 480 s）。
  两个步骤都排在 `request_help overlay`/extension/UI 之后、crash/tenant 之前，仍是浏览器段
  串行；`exit 2 = BLOCKED` 在门禁里一律 **FAIL**，绝不静默跳过。组合矩阵：基准 **19**；
  `--with-bench` **20**；`--with-extension` **21**（+bench **22**）；`--with-budget` **20**；
  `--with-crash-inject`/`--with-transfer`/`--with-tenant`/`--with-mtls`/`--with-ui`/
  `--with-fastpath-b`/`--with-ui-visual` 各 **20**，任意组合**正交相加**；门禁 summary JSON
  增加 `withFastpathB`/`withUiVisual` 两个布尔字段。
- **门禁只做附加校验，不替换/不放宽脚本断言**：
  - fastpath-b：exit 0 + `mode:"summary"` + `ok/stable` + 恰好 2 轮 run 报告 + 每轮
    `checks.passed===total>0` + 文本 `identical:true` 且有 sha256/字节数 + on 路径
    `Runtime.evaluate===0` / off `>0` + daemon observe `session_bound`/`text_identical`/
    `runtime_evaluate===0`/`collect_calls>0` + 能力视图 `active/session_bound` 且 `default:false`
    + 清理字段为真 + 两轮文本 sha256 一致；
  - ui-visual：exit 0 + `verify-baseline`/`baseline.mode:"compare"`（**拒绝写基线**）+ ≥2 轮
    全部完成并通过 + `consistencyRequired && consistent` + 每页尺寸/统计/网格 `comparison.pass`
    /页内 checks 全过 + 清理字段不为 false；报告是 pretty-print 时也能解析（BLOCKED 路径）。
- **`test-all` 收集**：本轮**没有新增路径条目**。M1 的接线测试落在既有 walk 根内：
  `daemon/server.test.mjs` **111/111**、`daemon/browser-daemon.test.mjs` **82/82**、
  `cli/bridge-remote.test.mjs` **19/19**（= test-all 相对 round 53 的 **+11**：server +6、
  browser-daemon +4、CLI +1）；两个新 E2E 都是非 `*.test.mjs`，保持 opt-in 门禁步骤；
  `0.4/tests/fixtures/ui-baseline/*.json` 是夹具数据（连同其 README 计入 docs，不进入测试
  收集）。
- **flake / 重试记录（如实）**：①首次 `--with-ui` 门禁在 `0.4 unit` 中失败：真实 headless
  Edge 的 `mcp/daemon-live-smoke.test.mjs` 报 `browser_observe returned isError ...
  "DOM extract failed: Uncaught"`（internal_error，915 ms）；该文件单独重跑 **9/9 PASS**，
  `--with-ui` 重跑 **20/20 PASS**（158,051 ms）。②首次合并门禁 `fastpath b e2e` 以脚本 exit 1
  失败（当时 wrapper 还没把脚本 stderr/失败 check 带进摘要，未保留断言现场）；重跑先暴露了
  **wrapper 自身的判定 bug**（稳定 summary 没有 `status` 字段，被误判 fail，已修复为
  `mode:"summary"` + `ok` 判定，并新增失败 check/stderr 诊断），修复后合并门禁 **21/21 PASS**
  （207,783 ms）。**没有修改任何断言/阈值/预算**；这两次都按“未复现的低概率 flake”记录，
  不等于概率 0。

### 23.5 本轮验证（全部实跑；Windows 24H2 + 真实 Edge 158；日志 `D:\浏览器桥\.tmp-b6-*.log`）

- `test-all`：**2228 passed + 1 skipped / 2229** tests（15 段全 `fail 0`，wall **113.3 s**；
  skip 仍是 `video-catalog` 的 POSIX mode 位）。
- 默认 gate `--with-remote --with-bench`：**20/20 PASS 首跑**（wall **208,407 ms**；
  `0.4 unit` 111,858 ms、`bench quick` **48,751 ms / 21 checks PASS**（`--no-write`）、
  `dashboard size` **25 项**、`product compliance` 466 文件/hard 0/ratchet 0/allowlist 189、
  `source guard` clean（encoding 1,141）、`eval` 43/43、`scale` ok）。
- 扩展 gate `--with-remote --with-extension`：**21/21 PASS 首跑**（wall **206,354 ms**；
  `extension ingress` 128/128、`cooperate attribution` 134/134 phase 22）。
- `--with-ui` gate：**20/20 PASS（重跑；首跑见 §23.4 flake）**（wall **158,051 ms**；
  `ui popup e2e` 99/99）。
- `--with-budget` gate：**20/20 PASS 首跑**（wall **142,844 ms**；`bench budget` 55 ms →
  `budgets 21/21 within budget (source: saved latest.json)`，`latest.json` 未改写）。
- 合并 gate `--with-remote --with-fastpath-b --with-ui-visual`：**21/21 PASS**（wall
  **207,783 ms**；`fastpath b e2e` **106/106 ×2**、`ui visual baseline` **82/82**）。
- standalone：`fastpath-b-e2e.mjs` **106/106 ×2 PASS**（多次重跑 9.0–9.4 s 稳定）、
  `ui-visual-baseline.mjs` **PASS**（2 轮、41/41 ×2、16.5 s）、`dashboard-session-e2e.mjs`
  **24/24 checks + 4/4 cleanup ×2**（1,785/1,620 ms、`profileDirsLeaked:[]`、
  `leftoverBrowserProcesses:0`、`tokenLeaked:false`）、`eval` **43/43**（17 seeds、100%/100%、
  executionFailures 0）、`product-compliance --check` **PASS**、`tools/source-guard.mjs`
  **clean**（253 files；encoding 1,141）、`bsk-coverage --check` 围栏块重生成后 **OK**
  （分类不变 usable 77/77、full 53 / partial 0 / refused 0、control 24/24 real）。
- 代码量（生成器口径）：**234,974** 行 = **128,215** production + **106,759** test
  （**70.5% / 69.8% / 70.2%** of BSK 334,821）；`tests` 22,862 → **26,404**（两个新 E2E），
  `scripts` 5,873 → **6,200**（stage-gate/test-all 接线与注释），JSON 73 → **76** 文件 /
  24,704 → **28,757** 行（三份视觉基线）。
- **边界**：以上是实测事实（同机、真实 Edge，单次采样；bench quick 单样本，并发比例噪声的
  历史结论不变）；未观测到 flake 不等于概率 0；本机无 `git`，改动以文件列表为准。

## 24. 0.3 UI 移植集成收口边界（round 55, 2026-11-24）：0.3 UI 外壳 + `bb.*` 兼容层、尺寸预算、旧 UI E2E/视觉基线重写

本节记录 task-137（0.4 移植 0.3 UI 后的集成收口）确立的边界。它**不改变任何 BSK 方法分类、
阈值或门禁步骤语义**：usable 仍 **77/77**（scope 条件）、full **53** / partial **0** /
refused **0**、control **24/24 real**；**没有新增 wire 方法/字段/错误码**；门禁矩阵仍是
默认 **20** / 扩展 **21** / `--with-ui` **20** / `--with-ui-visual` **20** / `--with-budget`
**20**（本任务**未改 `stage-gate.mjs`**），合规基线只降不升。产品层移植（P1 外壳 40 文件、
P2 `bb.*` 兼容层、P3 overlay/借用确认视觉）由前置任务 landing；本任务只做集成/重写旧 UI
E2E/重生成视觉基线/文档/覆盖/门禁验证。

### 24.1 移植策略：0.3 外壳原样移植，行为差异只经兼容层

- **移植范围**：`0.4/extension-ingress/ui/` 整体换成 0.3 外壳（40 文件 / **380,245 B**：
  `popup.html|js|css`、`options.html|js`、5 个 inline 面板、`audit/record/longshot/debug/ops/
  quick/preview/privacy` 页、`ui/support/*` 共享模块、`ui/panels/*`、`ui/locales.js` 单表、
  `direction.js`、`i18n.js`、`common.js`、`ui.css`）。0.3 用更少更大的文件承载同一表面，
  文件数/字节数与 0.4 旧骨架不可逐文件对比。
- **兼容层是唯一行为适配点**：0.3 UI 页面只发 `bb.*` 消息，SW 侧由 `src/ui-compat.js`
  应答；**显式支持 5 个类型**：`bb.state`（只读状态，从 0.4 `ui.status` 同一份快照派生并深脱敏）、
  `bb.call`（仅白名单写方法 `session.open`/`session.close`/`act`）、`bb.settings.set`（纯
  `storage.local['bb.settings']`，0.3 normalize 语义）、`bb.connection`（真实 `start()`/`stop()`
  生命周期）、`bb.devices.list`（如实空态 `{ok:true,devices:[],devices_supported:false}`）。
  其余 `bb.*` 一律 typed `E_UI_COMPAT_UNSUPPORTED`，带 `supported_types`/`allowed_methods`，
  **不伪造成功**。
- **token 脱敏**：`bb.state` 的 `settings.daemonUrl` 走 `redactSecrets`，`daemonToken`/
  `daemonCode` 回包为空串；`bb.state.bridge` 是 0.4 快照的 `redactValue` 深拷贝，页面拿不到
  明文凭据。E2E 的 JSON 报告同样只出现 `<redacted>`。
- **语言键边界（如实，未在本轮写域内修）**：0.3 移植的 `ui/i18n.js` 写
  `storage.local['bb.uiLang']`，而 0.4 页内内容脚本（`content/borrow-confirm.js` /
  `content/status-overlay.js`）读 0.4 的 `bb04.ui.language`（0.3 原生 popup/options 会同时写
  这个 key）。因此**“在 options 里选 ar 会自动让页内确认条变 RTL”尚未自动桥接**；E2E 分别验证
  两层（options/popup 的 `bb.uiLang` 真实 RTL；内容脚本用自身 `setLanguage()` 真 API 验证 ar
  RTL 渲染），报告 `notes` 明写该边界，没有把它当作已实现。修 `ui/i18n.js` 不在 task-137 写域。

### 24.2 旧 UI E2E 重写：等价覆盖，不是放宽阈值

`0.4/tests/ui-popup-e2e.mjs` 从 0.4 临时骨架（`bb-connection-state`/`bb-refresh`/
`bb04.ui.*`）**整体重写为 0.3 移植面**，旧断言作废（旧 DOM 已不存在）。等价覆盖对照：

| 旧骨架断言（作废） | 0.3 UI 新断言（同语义/更强） |
| --- | --- |
| popup 版本号 `bb-version` = 0.4.0 | popup `#extVersion` = manifest 0.4.0，`#cliVersion` = 真实 daemon 版本 |
| 连接态 `bb-connection-state` class/aria | `#stateLabel` + `#stateDot.dot.on` + `#connToggle` role=switch `aria-checked/on` |
| 详情列表回显 instance/daemon 版本 | `#instanceId` === staging instance_id + `#daemonInfo` 回显真实端口 |
| 「复制诊断」/「设置」按钮 | 0.3 `#copyCmd`/`#copyInstance`/快捷功能 5 面板 + 内嵌审计面板 + 返回 |
| 刷新按钮 + 更新时间 | 0.3 popup 无手动刷新（2.5 s 轮询）；改为 **开关往返**：popup 点击 → `bb.settings.set` → `storage.local['bb.settings']` 真写 → 再点恢复 |
| `ui.status`（0.4 私有 `kind`） | `bb.state`（0.3 契约）+ `bb.devices.list` 空态 + `bb.audit.list` typed unsupported + `supported_types` 恰 5 个 |
| human 卡/会话列表 | popup 的「当前任务」来自 0.4 受控 tab：断言行数 === `bb.state.sessions` 数量（有则渲染、无则隐藏，不伪造） |
| options 刷新间隔/诊断级别/显示技术信息（`bb04.ui.*`） | 0.3 设置表单（实例名/借用确认/人工协助/输入锁/页面守卫/12 语言/长截图）→ 写 `storage.local['bb.settings']` → 重载复核 → 恢复默认 → 复制启动命令反馈 |
| options 语言选择 ar/RTL（若落地） | 12 种语言逐一 `?lang=<code>` 断言 html lang/方向/标题译文（ar/he 必须 rtl）+ 真实切 ar 写 `bb.uiLang` 并 reload |
| 借用确认 H2 视觉（ring/秒数/44px/dialog） | **保留原断言**（内容脚本未换），新增 `setLanguage('ar')` 后的真实 RTL 卡片断言；真实 CDP 点击 deny + 超时 fail-closed 不变 |
| 状态浮层 H3 结构 | 保留原断言（宿主/初始隐藏/pointer-events/aria-live/优先级/折叠/清空/无禁词）；`recording` 文本断言改用 shadow root 的**可见节点文本**（`.bb04-label/.bb04-detail`）判定，因为样式表文本会占满 `textContent` 前 4000 字符（换到真实可见来源，不是放宽） |

E2E 仍要求真实 headed Edge + 真实 MV3 staging + 真实 daemon；CSP（MV3 默认
`extension_pages script-src 'self'`，0.3 页面无 meta CSP，用注入内联 script 被阻断证明）、
无控制台错误、可见文本禁词、`cleanup`（staging/workRoot）全保留。脚本内部 watchdog 300 s，
门禁侧 420 s 上限，exit 2 = BLOCKED 在门禁里同样 FAIL。

### 24.3 尺寸预算：只上调容量类，page/模块预算不虚高

- `0.4/dashboard/size-budget.json`：`extensionUi.maxTotalBytes` **262,144 → 524,288 B**
  （实测 0.3 UI **380,245 B**，余量 144,043 B ≈ 28%）；`extensionUi.maxLocalesBytes`
  **122,880 → 204,800 B**（200 KB；0.3 的 12 语言单表 `ui/locales.js` 实测 **168,119 B**）。
  理由写进 JSON `note`（本文件即**专门改动**，不是顺手放宽）。
- **`dashboard-size-check.mjs` 增加 locale 识别**：`extensionUi.localeFiles`（相对 UI 根，
  如 `["locales.js"]`）与既有 `localesDir/*.json` 同时计数；**列出的 locale 文件缺失是
  violation**，不再出现“0 locale bytes”假绿。默认值保持向后兼容（旧 JSON 无该字段仍跑）。
- **未上调**：dashboard 单模块 40,960 B/1,600 行、装配层 32,768 B、page bundle **90,112 B**
  （实测 **90,088 B**，只剩 24 B 余量，仍是 reviewability 硬约束）、dashboard 源码树
  294,912 B（实测 270,751 B）。门禁只测字节/行数，不做依赖/安全审查。

### 24.4 视觉基线：0.3 UI 全量重生成，旧基线作废

- `0.4/tests/ui-visual-baseline.mjs` 的 popup/options 就绪判定与 DOM 字段改为 0.3 外壳
  （popup：真实连接态/实例 ID/设备空态；options：设置表单 + 12 语言选择器），
  `0.4/tests/fixtures/ui-baseline/{popup,options,dashboard}.json` 由 `--write-baseline`
  **整体重生成**（旧 0.4 骨架基线作废）。截图 viewport 不变：popup 420×760、options
  900×1000、dashboard 会话详情 1400×800；容差/统计下限/尺寸 0 px 容差都不变。
- **CSP 断言随 0.3 页面调整（等价）**：0.3 页面没有 meta CSP，因此扩展页断言改为三件真实事实
  ——注入内联 `<script>` 未执行（MV3 默认 `extension_pages script-src 'self'`）、DOM 无内联
  script、未用 meta 覆盖默认策略；dashboard 仍校验真实响应头 CSP。
- **不遮罩**：instance ID/端口/session id 是逐次变化的真实文本，仍靠 16×16 网格容差（每格
  ≤10/255 或差异格 ≤12% 且 256 格均值 ≤3.0）覆盖，差异格数如实报告，不做像素遮罩/伪造。

### 24.5 本轮验证（全部实跑；Windows 24H2 + 真实 Edge 158；日志 `D:\浏览器桥\.tmp-gate-*.log`）

- `test-all`：**2202 passed + 1 skipped / 2203**（15 段全 `fail 0`、wall **103 s**；与 round 54
  记录的 2229 相差 **−26**，来自 0.3 UI 移植对旧 0.4 骨架单测集合的替换——ui.test 26→22、
  ui-i18n 19→15、新增 ui-compat 24、borrow/status 21/29 等；按本轮实测记录、未跳过/删除仍适用
  断言，替换本身由前置任务 landing）。
- 默认 gate `--with-remote --with-bench`：**20/20 PASS 首跑**（wall **216,597 ms**；
  `0.4 unit` 117,909 ms、`bench quick` **50,682 ms / 21 checks PASS**（`--no-write`）、
  `dashboard size` **25 项**（ingress UI 380,245/524,288 B、locales 168,119/204,800 B、
  page 90,088/90,112 B、dashboard 树 270,751/294,912 B）、`product compliance`
  **487 文件 / hard 0 / ratchet 0 in 0 / allowlist 189**、`source guard` clean（encoding 1,142）、
  `eval` 43/43、`scale` ok）。
- 扩展 gate `--with-remote --with-extension`：**21/21 PASS 首跑**（wall **202,960 ms**；
  `extension ingress` **128/128**、`cooperate attribution` **134/134**；0.3 UI 的
  manifest/icons/content_scripts 不破坏真实 Edge 加载）。
- `--with-ui` gate：**20/20 PASS 首跑**（wall **183,684 ms**；`ui popup e2e` **140/140**，
  notes 1 = 语言键边界）。
- `--with-ui-visual` gate：**20/20 PASS 首跑**（wall **177,928 ms**；`ui visual baseline`
  **2/2 轮、86/86 checks、consistent:true**；all-cells popup max=1.52 / options 0 /
  dashboard 1.24）。
- `--with-budget` gate：**20/20 PASS 首跑**（wall **175,916 ms**；`bench budget` 78 ms →
  `budgets 21/21 within budget (source: saved latest.json)`，`latest.json` 未改写）。
- standalone：UI E2E **140/140 ×2**（19.0/19.9 s）、视觉基线校验 **2 次 × 2 轮 43/43**
  （各 16.2 s、跨轮 consistent）、`eval` **43/43**（17 seeds、100%/100%、
  executionFailures 0）、`dashboard-size-check --check` **25/25 PASS**、
  `source-guard` **clean**（253 files；encoding **1,143**）、`product-compliance --check`
  **PASS（487 / hard 0 / ratchet 0/0 / allowlist 189）**、`bsk-coverage --check` 围栏块
  重生成到不动点后 **OK**（usable 77/77 scope、full 53 / partial 0 / refused 0、
  control 24/24、0 missing codecs；代码量见 COVERAGE round 55 段）。
- **并发协调（如实）**：与 sibling `impl-ui-parity`（task-138）共用本机真实浏览器：①我的
  第一次视觉基线 standalone 校验被其 parity 浏览器 run 并发检测 **BLOCKED**（exit 2、未起
  浏览器）；②协调后其正式验收前的一次尝试被我的 `ui-visual-baseline` 进程 **BLOCKED**
  （exit 2、未起浏览器）；我 kill 自己的 run、其 `--repeat 2` **PASS**（14/14 变体），随后我
  补跑视觉校验 **2 次各 2 轮 PASS**。两次 BLOCKED 均为脚本并发检测的真实结果，未改任何断言/
  阈值，也未把 BLOCKED 记成 PASS。
- **flake**：5 个门禁 + test-all + standalone 全部首跑绿（`failed: []`/`retried: []`）；
  历史 flake（round 38/41/42 phase-13、round 46/48 人类归因、round 49 wait 竞态）记录不变，
  低概率 flake 仍是「未复现」而非「概率 0」；bench quick 单样本结论不变（未放宽阈值）。



## 25. 快捷操作 / 录制工作流收口边界（round 56, 2026-11-24）：语言键桥接、`bb.call` 15 白名单 + `bb.quick`、录制摘要与 `traceStore`、视觉基线重录、`--with-quick-record`

本节记录 task-143（快捷操作/录制工作流收口）确立的边界。它**不改变任何 BSK 方法分类、
阈值或门禁步骤语义**：usable 仍 **77/77**（scope 条件）、full **53** / partial **0** /
refused **0**、control **24/24 real**；**没有新增 wire 方法/字段/错误码**；门禁矩阵仍是
默认 **20** / 扩展 **21**（+bench **22**）/ `--with-ui` **20** / `--with-ui-visual` **20** /
`--with-budget` **20**，本轮**新增一个 opt-in 步骤** `--with-quick-record`（**+1**，只加进
opt-in 组合，默认步数不变）；合规基线只降不升。产品层（R1 简报、R2 后端 `record.status`/
`trace.get`/`trace.list` + 兼容层白名单/快捷动作、R3 `#quickBar`/`#recordCard`、R4 真实
Edge E2E）由前置任务 landing；本任务只做语言键桥接、基线重录、门禁接线、文档/覆盖/验证。

### 25.1 语言键桥接：0.3 UI 键与 0.4 内容脚本键双向一致（`ui/i18n.js`）

- **问题**：0.3 原生 popup/options 在写 `storage.local['bb.uiLang']` 的同时也写
  `bb04.ui.language`；0.4 页内内容脚本（`content/borrow-confirm.js` / `status-overlay.js` /
  `borrow-i18n.js`）只读后者。移植后的 0.3 UI 只写 `bb.uiLang`，于是「options 选 ar」不会
  自动传给页内确认条/状态浮层（round 55 如实记录为未修边界）。
- **修法**（`0.4/extension-ingress/ui/i18n.js`）：`setLang()` **两键同写**；
  `loadLang()` 启动时把显式 `bb.uiLang` **单向镜像**到 `bb04.ui.language`（两键已一致时不
  重复写；URL `?lang=` 临时覆盖不落盘；`storage` 写失败只影响内容脚本语言，不回落 UI 语言、
  不假装成功）。读取优先级：`?lang` > `bb.uiLang` > 内容脚本键（仅作兜底读取）> 浏览器语言。
- **语言集不一致的处理（如实）**：0.3 UI 用 `zh`/`pt`/`it`，0.4 内容脚本 12 语言 id 用
  `zh-CN`/`pt-BR`/`ru`（无 `it`）。写入时 `zh→zh-CN`、`pt→pt-BR`，读回反向映射；`it` 原样
  写入后内容脚本按既有规则回退浏览器语言（与桥接前行为一致，**不伪造内容脚本支持 it**）。
- **测试**：`extension-ingress/test/ui-i18n.test.mjs` **15 → 21**（新增 6 条 VM/fake-storage
  用例：两键同写 + 规范化、启动单向镜像且不反写、幂等不重复写、只有内容脚本键时采用且
  不反写、`?lang` 不落盘、storage 写失败不破坏渲染）；`ui-popup-e2e.mjs` 在真实 Edge 上
  断言「options 选 ar → storage 两键都为 ar」+「注入的确认条**无需显式 setLanguage** 就自动
  采用 ar（`state().language==='ar'`/`dir==='rtl'`）」，并保留 `setLanguage('ar')` 的显式
  RTL 结构断言。

### 25.2 `bb.call` 15 方法白名单 + `bb.quick` 18 动作（14 可用 / 4 typed 不可用）

- **白名单**（`src/ui-compat.js` 的 `UI_COMPAT_WRITE_METHODS`，**15 个**）：
  `session.open`/`session.close`/`act`；`record.start`/`record.stop`/`record.status`/
  `trace.get`/`trace.list`；`debug.query`/`debug.status`；`session.request`/
  `cooperate.status`/`video.status`/`ledger.list`/`ledger.pending`。白名单外一律 typed
  `E_UI_COMPAT_UNSUPPORTED` + `allowed_methods`（**没有**空成功、没有静默降级）。
- **`bb.quick`** 是 0.4-compat 新增的轻量信封（不是 0.3 消息）：`{action, params}` 与
  `bb.call` 同一白名单/同一结果形状。动作表 **18 个 = 14 可用 + 4 typed 不可用**：
  `help.request`（0.4 人工协助面是 `cooperate.wait`，需 cooperate enable/sync，兼容层只开放
  只读 `cooperate.status`）、`tab.borrow`（0.4 ingress 借用仍走 0.3 extension 通道
  `bb.borrow.*`）、`dashboard.open`（0.4 无可用 dashboard 打开 RPC）、`screenshot.capture`
  （截图是 adapter 工具，未开放到兼容层）；四者返回 `E_UI_COMPAT_UNAVAILABLE` + `reason`，
  未知动作返回 typed 失败。
- **前端不猜可用性**：`bb.state.ui_compat.quick_actions` 把同一动作表的
  `{action, method, available, reason}` 交给 popup；`#quickBar` 8 项的 `data-available`/
  `disabled`/`aria-disabled`（两者必须一致）/`data-reason` 都从该表派生，禁用项点击
  **不发消息、不改反馈**。`qaPause`/`qaSettings` 是 popup 自己的行为（恒可用，不受后端禁用）。
- **边界**：白名单只包含**有 0.4 真实路由**的方法；`trace.get/trace.list` 额外依赖 daemon
  的 `traceStore`（见 25.3）。0.3 的 `bb.rec.*`/`bb.audit.*`/`bb.ops.*` 仍然是 typed
  unsupported（录制面板改走 `record.*`/`trace.*`，审计/运维数据面**未**开放）。

### 25.3 录制摘要与 `traceStore` 边界（如实）

- **`traceStore` 是前置条件**：`record.status`/`trace.get`/`trace.list` 需要 daemon 配置
  持久化 store；没有 store 时 daemon 如实返回 `found:false`/不可用，UI 显示「没有可复制的
  trace」而不是编造步数。round 56 的 E2E 用**真实** `traceStore`（`workRoot/traces.json`）。
- **TraceV3 没有逐 step 时间戳**：摘要表「耗时」列固定 `—`，只断言行数/动作/target/状态与
  整体 `duration_ms`；**不编造逐步行耗时**。
- **摘要是本机临时状态**：`storage.local['bb.record.workflow']` 持久化
  `{phase, sessionId, purpose, startedAt, summary}`，popup 重开恢复；`bb.record.purpose`
  是设计内的「上次 purpose 预填」键，不在清理断言内；`#recordClear` 移除工作流键并收起摘要。
- **导出/复制是真实副作用**：导出用 CDP 下载到临时目录并校验真实 JSON（TraceV3 原文，不含
  sessionId 字段）；复制用真实剪贴板（测试侧钩子 + UI 反馈双证据）；环境不给权限时 UI 如实
  报错。**摘要 digest 是 daemon `trace.get` 的 `sha256`**，不是前端自算。
- **human-watch 交互**：页内 human-watch 会把合成分派点击归因为 `human.input`，daemon 自动
  hand-back（quiet 2s）后才继续；E2E 不绕过状态机，因此完整录制链路约 20–30 s/轮。

### 25.4 视觉基线重录（popup 布局已变）

- round 55 的 3 页基线是 0.3 UI 移植时的布局；round 56 的 R3 在 popup 增加了 `#quickBar`
  与 `#recordCard`，**popup 布局必然变化**，因此用 `--write-baseline` **重录三页**
  （popup/options/dashboard，37/37 page checks，8.1 s），随后校验模式默认 2 轮 × **43/43**。
- **容差/统计下限/0 px 尺寸容差全部不变**（每格 ≤10/255，或差异格 ≤12% 且 256 格平均 ≤3.0）；
  重录原因是布局事实变化，不是放宽阈值；instance id/端口/session id 等逐次变化文本仍靠网格
  容差覆盖，不做遮罩。实测 all-cells 最大格差：popup ≤2.6、options 0、dashboard ≤1.2，
  差异格 0。`fixtures/ui-baseline/README.md` 记录重录时间与原因。

### 25.5 本轮验证（全部实跑；Windows 24H2 + 真实 Edge 158；standalone 日志 `D:\浏览器桥\.tmp-t143-verify\`，门禁串行日志 `D:\浏览器桥\.tmp-t143-gates\`）

- `test-all`：**2220 passed + 1 skipped / 2221**（15 段全 `fail 0`、wall **146 s**；
  相对 round 55 的 2203 **+18** = `ui-i18n` 15→21（+6）、`ui.test` 22→31（+9）、
  R2 兼容层/daemon 路由新增用例）。
- 默认 gate `--with-remote --with-bench`（20 步）：**attempt 1 = 19/20**，唯一失败
  `bench quick`（`concurrency-4-speedup=1.64x < 1.75x`，bench 20/21；`--no-write` 未改基线）；
  **重跑 20/20 PASS**（wall **234,849 ms**、`bench quick` 50,850 ms 21/21、compliance
  488 文件 / hard 0 / ratchet 0 / allowlist 191、source guard clean encoding 1,144、
  eval 43/43、size 25 项、scale ok）。首次失败与重跑都如实记录，**未改阈值**。
- 扩展 gate `--with-remote --with-bench --with-extension`（22 步）：**22/22 PASS 首跑**
  （wall **247,731 ms**；ingress 128/128 8,754 ms、attribution 134/134 7,984 ms、
  bench 21/21 53,098 ms）。
- `--with-ui` gate（20 步）：**20/20 PASS 首跑**（wall **168,442 ms**；UI E2E **142/142**
  22,174 ms、notes 1）。
- `--with-ui-visual` gate（20 步）：**20/20 PASS 首跑**（wall **162,615 ms**；视觉 2/2 轮
  **86/86**、`consistent:true`、all-cells popup 2.17 / options 0 / dashboard 1.09、
  0 差异格）。
- `--with-budget` gate（20 步）：**20/20 PASS 首跑**（wall **202,394 ms**；`bench budget`
  57 ms → 21/21 saved-latest，`latest.json` 未改写）。
- `--with-quick-record` gate（20 步）：**20/20 PASS 首跑**（wall **207,067 ms**；
  `ui quick-record e2e` **160/160** 25,990 ms、steps 4、cleanup true）。
- standalone：UI E2E **142/142 ×2**（19,545 / 21,401 ms）、quick-record **320/320 ×2**
  （53.4 / 51.7 s，每轮 160/160、`stable:true`、cleanup true、notes 2、skipped 0）、
  视觉校验 **2 次 × 2 轮 43/43**（16.1 / 15.7 s、`consistent:true`、all-cells max
  popup 1.79/2.60、options 0/0、dashboard 1.04/1.14、0 差异格）、`eval` **43/43**、
  `dashboard-size-check --check` **25/25**、`source-guard` **clean**（253 files；
  encoding 1,144）、`product-compliance --check` **PASS（488 / hard 0 / ratchet 0/0 /
  allowlist 191）**、`bsk-coverage --check` 围栏块重生成到不动点后 **OK**
  （usable 77/77 scope、full 53 / partial 0 / refused 0、control 24/24、0 missing
  codecs；代码量 **251,536** = 137,201 production + 114,335 test，75.4%/74.8%/75.1%
  of BSK 334,821，JSON 65 文件 / 30,259 行；见 COVERAGE round 56 段与口径修正说明）。
- **flake**：6 个门禁里 5 个首跑绿；默认 gate 第 1 次只挂 `bench quick`（同 round 42/43
  的 quick 并发噪声），重跑 20/20；未改任何断言/阈值/预算，首次失败未被隐藏。历史 flake
  记录不变（低概率 flake 仍是「未复现」而非「概率 0」）。

## 26. 快捷动作 / 更多菜单 / 页内录制胶囊收口边界（round 57, 2026-11-24）

本节记录 task-147（U1 收口）确立的边界。它**不改变任何 BSK 方法分类、阈值或门禁步骤语义**：
usable 仍 **77/77**（scope 条件）、full **53** / partial **0** / refused **0**、control
**24/24 real**；**没有新增 wire 方法/字段/错误码**（T1 的 `tab.borrow`/`screenshot.capture`
用的是既有 daemon 路由与既有扩展 `ext.tab_borrow`，dashboard.open 是兼容层本地动作，不触达
daemon RPC）；门禁矩阵步数与默认/扩展语义不变（无新增 opt-in 开关）；合规基线只降不升。
产品层（T1 task-144 的三条真实通道、T2 task-145 更多菜单、T3 task-146 页内胶囊）由前置任务
landing；本任务只做 smoke/收集/E2E 期望与胶囊断言/基线/文档/覆盖/门禁验证。

### 26.1 T1 三条真实通道的语义与边界（`tab.borrow` / `dashboard.open` / `screenshot.capture`）

- **`tab.borrow`（真实借用链路）**：兼容层 `bb.quick`/`bb.call` → daemon `tab.borrow` 路由 →
  `ext.tab_borrow` → 页面真实确认条（沿用 A3a 的 allow/deny/timeout fail-closed）→ 借用回执
  （`tab_id/original_window_id/original_index/agent_window_id`），daemon 侧记录 receipt。
  借用等待用户确认的时间必须小于 ExtensionIngress 的 `commandTimeoutMs`（E2E/门禁按
  `commandTimeoutMs: 30_000` 与 daemon 默认 60s 确认窗配大 RPC 超时；兼容层
  `UI_COMPAT_RPC_TIMEOUT_MS['tab.borrow']=120_000`）。E2E 不伪造用户确认：只用缺参探针证明
  真实 daemon 路由与 typed 失败，确认条的 allow/deny/timeout 已由 `ui-popup-e2e` 覆盖。
- **`screenshot.capture`（只读 CDP 截图）**：daemon 在 session 既有 CDP 连接上
  `Page.captureScreenshot`，viewport 默认 / `fullPage:true` 用 `Page.getLayoutMetrics` 的
  clip；**内联 base64 有上限**（0.4 既有 `DEFAULT_SCREENSHOT_MAX_BASE64_CHARS`，512 KiB 字符
  级），超限时返回 `inline:false` + 真实 `bytes`/`base64_chars` + CLI 提示（**绝不截断图像冒充
  成功**）；fullPage 高度 clamp 到 `MAX_SCREENSHOT_FULL_PAGE_HEIGHT`(16 384) 并在结果标
  `truncated`。E2E 在真实 session 上断言 `ok:true` + `inline:true` + 真实 PNG base64/字节数/
  尺寸，且 `base64_chars <= max_base64_chars`。
- **`dashboard.open`（兼容层本地动作，不触达 daemon RPC）**：只接受**显式事实**——
  `storage.local['bb.dashboard.url']`（完整 http(s)）、`storage.local['bb.dashboard.port']` +
  当前 ingress 连接 host、或 daemon 状态暴露的 `dashboard_url`；**绝不把 ingress 连接端口猜成
  dashboard 端口**。都没有时返回 typed `E_UI_COMPAT_UNAVAILABLE` + 真实原因（不猜 URL、不伪造
  跳转）。`bb.quick` 由 SW `chrome.tabs.create` 打开；`bb.call` 只回 `{url, opened:false}`，
  由页面自己打开（避免同一按钮开两个 tab）。E2E 环境未配置地址 → 显式断言「运行时 typed
  不可用」而不是把快捷项写死成禁用。
- **快捷栏/更多菜单的可用性口径**：`bb.state.ui_compat.quick_actions` 现在是 **18 个注册动作 =
  17 可用 + 1 typed 不可用（`help.request`）**；`bb.call` 方法白名单 **17 个**（15 个既有 +
  `tab.borrow` + `screenshot.capture`）+ 本地 `dashboard.open`。`#quickBar` 8 项中
  `qaBorrow`/`qaDashboard`/`qaScreenshot` 必须按后端真实能力启用（E2E 断言），不再沿用 round 56
  的「四项恒禁用」旧期望（旧期望已随 T1 落地而更正，不是放宽断言）。
- **「更多」菜单（`#qaMore`/`#moreMenu`，9 项）**：视频开始/停止/保存、调试开始/停止/导出、
  整页长截图、审计/账本摘要、会话详情。可用性只从 `bb.state.ui_compat.quick_actions`（优先）
  与 `write_methods`/`read_methods`（回落）派生，不可用项 `disabled`+`aria-disabled`+
  `data-reason`+`title` 真实原因，点击只回显原因（不发消息）；可用项按 `bb.quick`（动作命中）
  或 `bb.call`（仅方法命中）执行，结果/错误原样回显在 `#moreStatus`；键盘
  ArrowUp/Down/Home/End/Enter/Space/Esc + `aria-activedescendant`/`tabindex` 真焦点。
  **边界**：视频/调试面板的**数据面**仍取决于 daemon 对应路由（`video.*`/`debug.*`），菜单
  只负责真实能力发现与信封路由，不把「面板存在」说成「数据面已通」。

### 26.2 页内录制胶囊的轮询/生命周期边界（`content/record-capsule.js`）

- **状态来源是轮询，不是事件推送**：内容脚本每 2s 向 SW 发 `{kind:'bb04.record.state'}`，
  SW 用 pull 同一 JSON-RPC 客户端调 daemon 只读 `record.status`（多 session 取最早开始的一条，
  SW 内 1.2s 缓存合并多标签页轮询，并写 `storage.local['bb04.record.state']` 快照供 SW 回收后
  首轮恢复，快照仅 8s 内可信，随后由 daemon 校正）。
- **不可信就隐藏（fail-closed，不猜）**：SW 未连接/daemon 不认 `record.status`/传输失败/
  回包非法/回执 `available:false` → 胶囊隐藏并在下一次轮询重试；页面 `visibilityState` 非
  visible 时暂停轮询与计时（后台 tab 不计时，也不「猜可能还在录」）；页面导航后内容脚本重新
  注入，第一轮轮询即恢复显示。
- **Finish → `record.stop` 只在 SW 内发生**：胶囊 Finish 发
  `{kind:'bb04.record.finish', session_id}`；SW 先 `record.status` 确认该 session 在录再
  `record.stop`，只有回执 `stopped:true`（或 `not_recording`）才收起胶囊；失败保留胶囊并播报
  「无法结束录制」，下一次轮询再校正。daemon token 与 trace 内容**不进入页面**。
- **交互/无障碍边界**：host `pointer-events:none`、只有胶囊本体 `auto`；拖拽/按钮的 pointer
  事件不冒泡到页面、拖拽限制在视口内；`role=group`+`aria-label`、计时 `role=timer`、
  Finish/折叠/关闭都有 aria-label、`role=status aria-live=polite` 播报一次；12 语言词表整包
  切换（ar/he RTL）、`prefers-reduced-motion` 关闭脉冲、Finish 可点区域 ≥44px。
- **与 popup 的职责边界（E2E 覆盖）**：胶囊是页内控制器，popup `#recordCard` 是工作流面板；
  胶囊 Finish 停下后 popup 的 `record.stop` 会得到 `E_NOT_RECORDING`，UI 必须如实显示
  「录制已由外部停止」并仍能收口摘要——**不伪造是本 UI 停止的**。E2E 用真实 CDP Input 点击胶囊
  Finish（降级隔离世界 DOM click），并以 daemon `record.status.recording=false` + 胶囊
  `snapshot.state=inactive/宿主移除` 双证据判定。

### 26.3 视觉基线重录（popup 更多菜单改变像素）

- T2 在 popup 增加「更多」溢出菜单（`#qaMore`/`#moreMenu`，9 项）与布局微调，popup 像素确实
  变化（重录前后 popup 网格 sha256 不同）；按任务要求三页一并 `--write-baseline` 重录
  （37/37 page checks，8.2 s），校验模式默认 2 轮 × **43/43**。
- **容差/统计下限/0 px 尺寸容差全部不变**（每格 ≤10/255，或差异格 ≤12% 且 256 格平均 ≤3.0；
  尺寸容差 0 px）；重录原因是布局事实变化，不是放宽阈值。实测 all-cells 各轮最大格差 popup
  1.03 / 2.74、options 0、dashboard 1.09 / 0.87，差异格 0；两轮互比一致
  （`consistent:true`）。instance id/端口/session id 逐次变化文本仍靠网格容差覆盖，不遮罩；
  校验模式绝不回写基线。`fixtures/ui-baseline/README.md` 记录 round 55/56/57 三次重录原因。

### 26.4 smoke / 收集 / E2E 期望更新（不放宽）

- **smoke（`extension-ingress/test/smoke.mjs`）**：声明式 `content_scripts` 断言由 3 条 →
  **4 条**（新增 `content/record-capsule.js`：`<all_urls>`、`document_idle`、`all_frames:false`），
  并新增「record-capsule.js 是 classic script（无 import/export）」检查；js 指向真实文件与顺序
  断言同步到 4 条。旧断言是**改准**（3→4），没有删除/放宽任何检查；smoke **345 → 347**。
- **test-all 收集**：`extension-ingress/test/record-capsule.test.mjs`（T3 的 37 条 browser-free
  用例）显式加入 regular 4 路组（`extension-ingress/` 不是 walk 根）；`test-all`
  **2220 passed + 1 skipped / 2221 → 2273 passed + 1 skipped / 2274**。
- **`ui-quick-record-e2e.mjs` 期望更新（按真实能力，不硬编码旧值）**：
  `EXPECTED_UNAVAILABLE` 四项 → **`qaHelp` 一项**（T1 打通后 borrow/dashboard/screenshot 由
  `quick_actions` 断言 available=true 且 DOM 启用）；新增 T1 运行时真相断言——dashboard 未配置
  地址 → typed `E_UI_COMPAT_UNAVAILABLE`（`bb.quick` 与 `#recordDashboard` UI 两条路径），
  screenshot 真实回图（inline base64 受上限约束），tab.borrow 缺参 typed 失败（不伪造用户确认）；
  checkbox 点击禁用的对象由 qaBorrow 改为仅剩的 qaHelp。**没有把任何真实不可用写成可用，也没有
  反过来把可用项继续硬编码成禁用**。
- **页内胶囊 E2E（本轮新增）**：再起一条短录制 → 把录制目标真实页面带到前台（后台 tab 的
  `visibilityState=hidden` 会暂停轮询，这是产品既有行为）→ 在扩展隔离世界读 open shadow-DOM
  胶囊（HOST_ID/命名空间/role=group/role=timer/Finish aria/文案严格等于当前语言词条/
  `pointer-events`/方向）→ 计时 2.6s 内真实前进 → 真实 CDP Input 点击胶囊 Finish → daemon
  `record.status.recording=false`、胶囊收起（宿主移除 + `snapshot.state=inactive`）→ popup 点
  `#recordStop` 如实显示「已由外部停止」并收口摘要 → `#recordClear` 清掉第二条工作流。
  `ui-quick-record-e2e` 单轮 checks **160 → 179**（standalone 358/358 ×2，`stable:true`）。

### 26.5 与 0.3 冻结区 / dist 的隔离

- 本轮只改 `0.4/` 内的测试/脚本/文档与 `docs/`；**未改** 0.3 `extension/` 产品代码、`dist/`、
  `D:\CTRM自动录入`、`0.4/extension-ingress/manifest.json`（陈旧 `web_accessible_resources`
  仍记为 follow-up）、`0.4/compliance-baseline.json`（只降不升）、`0.4/scripts/stage-gate.mjs`
  （本轮没有新增/修改门禁步骤，`--with-quick-record` 早已由 round 56 接入）；未装依赖；
  未改任何断言/阈值/预算弱化（视觉基线重录与 smoke/E2E 期望更新均在上文说明原因）。


## 27. 视频/调试启用 + help 扩展侧接收 + 更多菜单收口边界（round 58, 2026-11-25）

本轮（task-151/W1）只做四件事：①把 daemon 原生 `video.start/stop/save` 与
`debug.start/stop/export` 加入 0.3 UI 兼容层白名单/快捷动作；②修 popup「审计/账本摘要」
读错字段（`entries/total` → 真实 `intents/count`）；③扩展侧接收 daemon 的
`ext.help_request` 广播（此前会回 `E_UNKNOWN_COMMAND`）；④把两条真实 Edge E2E
（更多菜单、借用确认）接入 opt-in 门禁并全量复验。

### 27.1 help 闭环：只有 pending 展示面，没有 operate 面

- **daemon（task-148，本轮只验证）**：`session.request_help` 记录一条有界 pending 请求
  （同 session 幂等复用、`timeout_ms` 有上下界、到期如实 `expired`），并通过 extension
  ingress **广播** `ext.help_request`；`session.request_status` 是只读视图
  （pending/expired/resolved/cancelled，`can_operate:false`）。
- **扩展侧（本轮落地，`src/commands.js`）**：新增 `ext.help_request` 命令 handler，把
  `{kind:'bb04.status.event', event:'help.requested', params}` 转给目标 tab 的页内状态浮层
  （`content/status-overlay.js` 早已支持该事件），回执 `{acknowledged:true, pending:true,
  can_operate:false, surfaced}`。目标 tab 取 daemon 记录的 `tab_id`，否则 session Agent Window
  的活动 tab；session/窗口消失或浮层不可达 → 仍回执 acknowledged + pending + 真实 `reason`
  （**不伪造人工回答，也不把一个通知失败伪装成命令失败**）。该命令同时进入
  `COMMAND_METHODS`（`register.capabilities` 真实能力声明）。
- **真实证据**：`ui-quick-record-e2e` 在真实 Edge 上先 `bb.quick help.request` → daemon
  `session.request_status` 记录 pending → 轮询到 `extension.ok===true`
  （`reason:queued`、`command_id` 真实、`settled_at` 有值、`code:null`）→ `bb.state.help`
  只读回显 `source:'daemon.last_request'` + `pending:true` + 同一 `request_id`。
  **边界**：0.4 仍无 operate 面（扩展/页面不能回答请求），到期后由 `request_status` 如实
  `expired`；`interaction.request_help:'enabled'` 只表示“可展示 pending”。

### 27.2 视频/调试：白名单启用的是 daemon 原生面，不是 0.3 消息

- `UI_COMPAT_WRITE_METHODS` 19 → **25**：新增 `video.start/video.stop/video.save`、
  `debug.start/debug.stop/debug.export`；`bb.quick` 快捷动作 18 → **24**（23 个 daemon 方法 +
  本地 `dashboard.open`），全部 available。0.3 的 `bb.rec.*`/`bb.debug.*` **消息类型仍
  typed unsupported**（只开放 `bb.call`/`bb.quick` 的 daemon 方法通道）。
- RPC 超时：`video.start` 60 s、`video.stop` 120 s（写 artifact，与 `record.stop` 同等余量）、
  `video.save` 60 s、`debug.start/stop/export` 各 60 s。租户/错误映射/token 深层脱敏沿用同一条
  `bb.call` 通道，不新增第二套实现。
- **真实 Edge 证据（ui-more-menu-e2e）**：`video.start` → `video.status.recording=true`
  （format mp4 / mime video/mp4）→ 同一页面 act click 制造 screencast 帧 → `video.stop` →
  `video.list` 登记 artifact（12,614 B、session_id/tab_id/window_id/format/mime 真实）且
  产品自己的 `mp4-verify` 通过（2 帧可播放）；`debug.start` → navigate 采集 →
  `debug.status.counts.requests>0` → `debug.stop` → `debug.export` 写 JSON artifact
  （3,363 B、state stopped、counts.pages=1）。
- **如实边界**：默认视频格式是 MP4（页内 MediaRecorder + canvas.captureStream），**录制期间
  导航会销毁页内 recorder**（`video.stop` 会如实 `E_CDP`）——本轮 E2E 因此不导航、只做同页
  交互；`video.save` 需要 `{id,out}`，更多菜单只传 `sessionId` → 点击如实
  `E_RPC_INVALID_PARAMS`（白名单通道用 `bb.call video.save {id,out}` 验证真实写出 12,614 B
  文件；UI 缺产物选择器，记为 follow-up）；daemon 原生存在但本轮未开放的 `video.list/discard`
  仍 typed `E_UI_COMPAT_UNSUPPORTED`（白名单纪律探针）。

### 27.3 更多菜单账本摘要修复

- 现象（task-149/V2 发现）：`popup.js moreResultSummary` 对 `moreAudit` 读
  `result.entries/result.total`，而 daemon `ledger.list` 返回 `{intents,count,configured}`，
  成功文案显示「账本 0 条 / 共 0 条」而真实后端有 N 条。
- 修复（本轮写域 `ui/popup.js`）：优先读 `intents/count`，兼容旧形状 `entries/total`，
  条数与总数都显示真实值；`ui.test` 覆盖三种形状（daemon 真实 `{intents,count}`、旧
  `{entries,total}`、只有 `intents` 无 `count`），真实 Edge E2E 断言
  「账本 1 条 / 共 1 条（最近 click）」与 daemon 直连/bb.call 三方一致。

### 27.4 截图 clamp / 借用超时（前序任务落地，本轮 E2E 复验）

- `screenshot.capture fullPage`：高度按 `MAX_SCREENSHOT_FULL_PAGE_HEIGHT=16384` clamp，内联
  base64 上限 524,288 字符；真实 `/tall`（17,050 px）页截图为 906×16,384、`truncated:true`、
  `inline:false` + 真实 reason + CLI 提示（**绝不回传截断图像**）；小页面 921×920 走
  `inline:true` 真实 PNG。两次独立截图的像素宽度差异（906 vs 921 滚动条）如实记 notes，不伪造。
- 借用确认：daemon 侧 `tab.borrow` 的 RPC/命令超时（120 s）覆盖「用户确认 60 s + 搬 tab」；
  真实 Edge E2E（82 checks）用真实 CDP 点击 Allow（借用回执/账本/`tab_return` 归还）、Deny
  与超时 fail-closed（无借用），本轮只复跑并把该 E2E 接入 opt-in 门禁。

### 27.5 门禁矩阵

新增两个 opt-in 步骤（默认 19/20/21 与扩展 21/22 步语义不变）：
`--with-more-menu`（运行 `0.4/tests/ui-more-menu-e2e.mjs --repeat 1 --quiet`，browser lane，
1260 s，**168 checks**）与 `--with-borrow-confirm`（运行
`0.4/tests/borrow-confirm-e2e.mjs`，browser lane，660 s，**82 checks**）。两步骤的包装层只做
**附加**校验（可解析 JSON、`mode/status/ok`、runs/stability、`checks.failed===0` 且
`passed===total`、staging/workRoot 清理、server 停止），不替换/不放宽脚本自身断言。

### 27.6 与 0.3 冻结区 / dist 的隔离

- 本轮改 `0.4/extension-ingress/src/ui-compat.js`、`src/commands.js`、`ui/popup.js`、
  `test/ui-compat.test.mjs`、`test/ui.test.mjs`、`0.4/tests/ui-quick-record-e2e.mjs`、
  `0.4/tests/ui-more-menu-e2e.mjs`、`0.4/scripts/stage-gate.mjs` 与文档/覆盖；**未改**
  0.3 `extension/` 产品代码、`dist/`、`D:\CTRM自动录入`、`0.4/compliance-baseline.json`
  （只降不升）、`0.4/tests/borrow-confirm-e2e.mjs`（V3 landing，本轮只复跑）；
  未装依赖；未改任何断言/阈值/预算弱化（白名单/期望更新均为产品能力真实变化，账本摘要是修
  真实 bug）。
- 本机仍无 `git`，改动以文件列表为准；Wave D 验收本体等既有 follow-up 不变。





## 28. help 回答面收口边界（round 59, 2026-11-25）

本轮（task-154）只做 help「回答面」的收口：①扩展 `src/commands.js` 真实接收 daemon 的
`ext.help_resolved` 广播（此前回 `E_UNKNOWN_METHOD`）；②popup 在 pending 期间轮询
`session.request_status`，检测到真实 `resolved` 时显示「已解决 + answer 摘要/answered_by」；
③`test-all` 收集 `ui-help.test.mjs`；④`stage-gate` 新增 opt-in `--with-help`；
⑤文档/覆盖/全量门禁。X1（视频保存 `/video.list` 白名单/保存面板）与 X2（daemon
`session.answer_help` + CLI `--help-answer` + 事件）由前置任务 landing，本轮只做扩展接收面、
UI 展示、测试/门禁/文档收口。

### 28.1 `ext.help_resolved`：只转发事实，没有 operate 面

- **命令形状**：`ext.help_resolved {session_id, request_id, state:'resolved'|'cancelled',
  answer?, by?, resolved_at?, tab_id?}` 进入 `COMMAND_METHODS`（`register.capabilities` 真实
  能力声明），由 `createCommandRouter` 的 handler 处理；`state` 只接受
  `resolved`/`cancelled`，其它值/缺参数 → typed `E_INVALID_PARAMS`（不静默当 resolved）。
- **事件映射**：把 daemon 已记录的事实转成页内状态浮层的
  `{kind:'bb04.status.event', event:'help.resolved'|'help.cancelled', params}`；
  `content/status-overlay.js` 早已支持这两个事件（`model.help.active=false`），因此页内
  pending 胶囊随之收掉。目标 tab：daemon 记录的 `tab_id` 优先，否则 session Agent Window
  的活动 tab。
- **回执**：`{ok:true, acknowledged:true, resolved:boolean, cancelled:boolean, state, event,
  session_id, request_id, can_operate:false, surfaced, tab_id?, surface?, answer?, by?}`。
  `answer`/`by` 只是**有界回显**（4,000 / 120 字符，与 daemon `session.answer_help` 的上界
  一致），不是 payload 通道。
- **诚实失败面**：Session/窗口/目标 tab 不存在或 `tabs.sendMessage` 失败时，命令**仍被消费**
  （`ok:true`）但 `surfaced:false` + 真实 `reason`/`code`——不把“没有页面看到”伪装成“页内已
  展示”，也不让通知失败把 daemon 的记录回滚（daemon 侧 `resolution_extension` 记账照旧）。
- **边界**：0.4 仍然**没有 operate 面**（扩展/页面不能回答请求）；扩展只转发 daemon 已记录的
  真实回答，不修改 daemon 记录、不伪造回答。页内浮层事件的逐项断言在
  `0.4/extension-ingress/test/ui-help.test.mjs`（fake chrome + 真 router）。

### 28.2 popup resolved 展示：只读轮询 + 有界摘要

- pending 期间（`session.request_help` 回执 `state:'pending'`）保持原有 deadline 兜底，
  另加**只读轮询** `session.request_status`（2 s 一次；只读接口，不触达 daemon 写面）。
  检测到 `resolved` 后按事实显示：`人工协助已解决：<answer 摘要>（由 <answered_by> 回答）`；
  answer 折空白后截断到 **120** 字符（完整回答仍以 daemon/CLI 为准），没有正文时如实
  `人工协助已解决（没有回答正文）`；`cancelled` 显示已取消；`expired`/未知仍如实。
- qaHelp 上写 `data-help-state`（pending/resolved/cancelled/none）、
  `data-help-answer`、`data-help-answered-by`、`data-help-request-id`，供真实 E2E/诊断读取；
  `bb.state.help` 的 live pending 仍压过旧的已解决事实，stale 缓存不会把旧 pending 当实时，
  但真实 resolved 事实不会被 stale 标记吞掉。
- 轮询失败不制造重试风暴（保留 deadline 兜底，下一次轮询再确认）；新请求只有在 daemon
  **真实记录 pending** 后才清掉上一次 resolved 展示（请求失败时保留上一次真实事实）。
- 0.3 i18n：新增词条 `人工协助已解决（没有回答正文）` 与三条动态 pattern
  （`人工协助已解决：X（由 Y 回答）` / `人工协助已解决：X` /
  `人工协助已解决（没有回答正文，由 Y 标记）`），zh 原样、其余语言回退 en。

### 28.3 X1 视频保存的路径约束（前置 landing，本轮复跑/记录）

- **真实链路**：popup/更多菜单的 `video.list`（本轮前由 X1 加入 `bb.call` 白名单，26 方法表）
  取当前会话最新录制 → 保存面板确认输出名 → `video.save {id, out}`。UI 默认输出名为
  `<session>-<UTC>.mp4`；保存位置**由 daemon 产物目录决定**（UI 不接受路径）。
- **输出名只做文件名**：空/超过 **180** 字符/含路径分隔符（`/`、`\`）/含 `..`/含非法字符/
  以点结尾 → 本地拒绝并如实显示，不发 `video.save`；真实保存成功显示 daemon 返回的 `out` 与
  真实字节数（X1 证据：**12,632 B** 文件；本轮 `ui.test` 的 video-save 用例 **41/41** 里复跑）。
- **失败如实**：`video.list` 为空/只有其它会话的录制/无可用文件路径/`video.save` 失败都按
  daemon 的真实回包显示原因，不伪造成功；菜单里 `video.save` 只传 `sessionId` 仍是
  `E_RPC_INVALID_PARAMS`（UI 缺产物选择器，follow-up 不变）。
- **导航限制**：默认视频是**页内 MediaRecorder**，录制中导航会销毁 recorder（`video.stop`
  如实 `E_CDP`）；UI 在录制中导航前弹真确认：取消 → 不导航（录制继续）、确认 → 导航并结束
  当前视频录制（`ui.test` 覆盖 `video.status.recording=true` 才警告的两种分支）；跨导航继续
  录制**不存在**，不包装成能力。

### 28.4 权限与租户边界

- **扩展没有自己的租户/权限模型**：help 的 pending/resolved 都是 daemon 的 session 记录，
  daemon 负责租户作用域与鉴权；扩展只把事实转成页内事件/popup 展示，**不**回答、不改记录。
- **token 不出页面**：`bb.call`/`bb.quick` 通道沿用 `ui-compat` 的深层脱敏（`token=***`、
  settings 凭据置空）；视频保存/help 回答都走 daemon RPC（CLI 用 daemon token），页面/内容
  脚本拿不到 token。`ext.help_resolved` 的 `answer`/`by` 是**有界回显**（4,000/120 字符，
  与 daemon `answer_help` 上界一致），不是把回答当 payload 转发给页面之外的任何地方。
- **回答权限**：只有 daemon/CLI（`session.answer_help` / `--help-answer`）能记录人工回答；
  0.4 扩展/页面仍**没有 operate 面**，`can_operate:false` 如实声明这一点。
### 28.5 测试/门禁接线

- `test-all` 显式收集 `extension-ingress/test/ui-help.test.mjs`（browser-free：真 daemon
  handler + 真 ingress 队列 + fake chrome + 真 command router），加入 regular 4 路组。
- `stage-gate` 新增 opt-in `--with-help`：`ui help e2e`（browser lane，cap=1，660 s 上限，
  脚本 `--repeat 1 --quiet`，单轮 **45 checks**，`total>=40` 下限只防空跑）。包装层只做
  **附加**校验（可解析 JSON、`mode='headed-edge-help-answer-e2e'`、`ok/status=pass`、
  runs/stability 自洽、`checks.failed===0 && passed===total`、staging/workRoot 清理、
  `browserAliveAfterStop!==true`），不替换/不放宽脚本自身断言；默认 19/20/21 与扩展 21/22
  步语义不变（新开关各 +1，正交）。
- `ui-help-e2e` 断言更新：扩展 `ext.help_resolved` 回执从「如实 typed E_UNKNOWN_METHOD」
  改为 **ok:true**（handler 真实存在），并新增 5 条真实 popup DOM 断言（resolved 状态、
  文案 = 已解决 + answer 摘要 + answered_by、`data-help-answer` 是有界摘要、
  `data-help-answered-by` = CLI `--by`、同一 `request_id`），单轮 checks 40 → **45**。

### 28.6 与 0.3 冻结区 / dist 的隔离

- 本轮改 `0.4/extension-ingress/src/commands.js`、`ui/panels/record-panel.js`、`ui/i18n.js`、
  `test/ui-help.test.mjs`、`test/ui.test.mjs`、`0.4/tests/ui-help-e2e.mjs`、
  `0.4/scripts/test-all.mjs`、`0.4/scripts/stage-gate.mjs`、`0.4/scripts/bsk-coverage.mjs`
  （仅围栏块/证据文案）与文档/覆盖；**未改** 0.3 `extension/`、`dist/`、
  `D:\CTRM自动录入`、`0.4/compliance-baseline.json`（hard 0 / ratchet 0 不变）、
  `ui/popup.js`（popup 的 help 面在 `ui/panels/record-panel.js`，无改动需要）、
  `0.4/tests/ui-visual-baseline.mjs` 与基线 JSON（初始渲染未变，见下）；未装依赖；
  未改任何断言/阈值/预算弱化。
- 视觉基线：本轮只改 resolved 之后的文案/属性，popup **初始渲染**不变；`--with-ui-visual`
  用原基线 verify 通过，因此**不重录**（重录只在像素真实变化时做，本轮无此事实）。
- 本机仍无 `git`，改动以文件列表为准；Wave D 验收本体等既有 follow-up 不变。

### 28.7 边界（如实，供后续引用）

- help **仍无 operate 面**：页面/扩展不能回答 pending；“已解决”只来自 daemon 的真实
  `session.answer_help`（CLI 或 daemon API）。这是产品缺口，不是本轮遗漏。
- popup 的 resolved 展示依赖打开着的 popup（关掉后重开是新的 `bb.state`，`bb.state.help`
  不带 answer，故不会重新显示 answer 摘要，只显示 state；如实记录）。
- answer 摘要只有 120 字符且折空白；完整回答以 daemon `session.request_status`/CLI 为准。
- 页内浮层收掉 pending 胶囊由 `status-overlay.test.mjs`（help.resolved/cancelled 状态机）
  与 `ui-help.test.mjs`（事件真实转发）覆盖；`ui-help-e2e` 不注入/不改浮层 DOM。

## 29. 快捷项记忆 / 单键 / 快捷键帮助层 + Z1/Z2 集成边界（round 60, 2026-11-25）

本轮（task-157）是**集成与验证**轮：Z1（task-155：dashboard 帮助回答面 + `/api/video/download`
真实产物下载）与 Z2（task-156：快捷项最近使用记忆 + 单键 `r`/`d`/`?` + 快捷键帮助层 + 页内胶囊
「同页录制」提示）已由前置任务 landing；本轮的写域只有尺寸预算、视觉基线、三个 E2E、覆盖/文档，
**没有改产品代码**。以下记录本轮做出的边界决定与前置 landing 的安全边界（以便后续引用）。

### 29.1 尺寸预算：只做容量类专门上调

- `0.4/dashboard/size-budget.json` 的 `extensionUi.maxTotalBytes` **524,288 → 655,360 B**，是
  **专门改动**：task-156 在 0.3 外壳上新增了快捷栏页脚「恢复默认顺序」/「快捷键」入口、快捷键
  帮助层（标记/样式/行为）、快捷项与「更多」菜单的最近使用排序逻辑及 12 语言词条，属于真实新增
  UI 面。实测 **534,833 B / 41 个文件**；旧上限已超 **10,455 B**；新上限余量 **120,527 B
  （18.4%）**，不是按余量大开的口子。
- **其余上限一律未动**：dashboard 单模块 40,960 B / 1,600 行、装配 32,768 B、page 110,592 B、
  源码树 327,680 B、locale 204,800 B。size-check 实测 **27 项 PASS**（assembly 31,107 B、
  page 101,784 B、tree 315,310 B、ingress 534,833/655,360 B、locales 168,119/204,800 B）。
  预算上调理由同时写进 JSON `note` 与 `0.4/dashboard/README.md`。

### 29.2 popup 视觉基线：按事实重录，容差不变

- 重录原因是 **popup 初始渲染真的变了**：task-156 在页脚新增两个真实可见按钮，并加入隐藏的
  快捷键帮助层标记。重录前先跑 verify 取证（**cell-ratio 模式、1/256 格超差、max 17.57/255**），
  不是“先重录再看”。
- 三页一并 `--write-baseline`（37/37），随后 **verify 2 次、每次 2 轮全部 43/43**：
  `consistent:true`；run 内最大格差 popup **1.60 / 0.85**、options **0 / 0**、dashboard
  **0.97 / 0.53**；cross-run popup **2.43 / 1.69**、options **0 / 0**、dashboard
  **1.18 / 0.83**，差异格 **0**。
- **容差（每格 ≤10/255 或差异格 ≤12% 且均值 ≤3.0）、统计下限、0 px 尺寸容差全部未改**；
  verify 模式不回写基线；重录记录进 `tests/fixtures/ui-baseline/README.md`，基线 `note`/`TASK`
  同步为 task-157/round 60。instance id/端口/session id 等逐次变化文本仍由容差覆盖，不遮罩。

### 29.3 快捷项最近使用记忆：本地 UI 偏好，只在打开时前置

- **存储面**：主快捷栏 `storage.local['bb.quick.recent']`、「更多」菜单
  `storage.local['bb.quick.recent.more']`，值都是 id 数组：最近在前、去重、最多 **4** 个，
  未知 id 一律丢弃（`normalizeQuickRecent`）；写入按 storage 键串行（快速连点不丢记忆）。
- **排序语义**：`orderIdsByRecent(defaults, recent)` 把最近项前置、其余保持默认相对顺序，**不增删
  快捷项**（主快捷栏仍恰好 8 项、更多菜单仍恰好 9 项）。排序**只在 popup 打开 / 菜单打开时**应用，
  **点击当下不重排当前 DOM**（避免首屏跳动；E2E 显式断言这一点）。
- **不改变可用性**：记忆只影响顺序，不改变 `data-available`/disabled/reason；后端不可用的项照旧
  禁用并显示真实原因。
- **恢复默认顺序**：`#qaOrderReset` 清空两处记忆键并立即还原两处顺序，`#quickStatus` 显示
  「已恢复默认顺序」。**边界**：如果 `storage.remove` 失败，当前 DOM 仍会还原并给出该反馈，但
  磁盘记忆可能残留（下一次打开可能再次前置）——本轮**没有**做 storage 故障注入，故这是写明的
  边界而不是已测试能力；正常路径下 E2E 断言两键都消失。
- **失败面**：storage 读/写失败只让排序降级为默认/不记忆，不阻断任何快捷项动作；不写假记忆。
- **未验证**：跨窗口/多 profile 行为（同一 profile 内 `storage.local` 共享；本轮只验证单 profile
  的“下次打开前置”）。memory 在 popup 关闭期间由其它页面/设置变更触发的重排也未验证。

### 29.4 单键快捷键与快捷键帮助层：popup 作用域，不是全局命令

- 单键 `r`（录制开关）、`d`（打开 dashboard）、`?`（显示/隐藏快捷键帮助层）**只在弹窗聚焦且
  目标不在输入框/可编辑区域时**生效，并 `preventDefault`；组合键 `Ctrl+Shift+R` / `Alt+R` /
  `Alt+Shift+D` 保持既有行为。**没有注册 `chrome.commands`**，因此不会覆盖浏览器全局快捷键，
  也不是全局可用。
- 按钮上的 `aria-keyshortcuts` 与真实键位同步：`qaRecord=r`、`qaDashboard=d`、`qaPause=Alt+R`
  （`qaPause` 的 Alt+R 是“立即刷新”组合键而非单键），帮助层入口 `#shortcutHelpOpen`
  带 `aria-keyshortcuts=?`。
- 帮助层是真实 overlay（`role=dialog`、`aria-modal=true`、`aria-labelledby=shortcutHelpTitle`、
  7 条词条、Esc/关闭按钮收起，入口 `aria-expanded` 同步）；它是**静态说明**，不新增数据面，
  也不改变录制/刷新/dashboard 行为。
- **边界**：单键在 popup 之外不生效（这里不是全局快捷键）；`?` 在输入框内不会触发（避免输入
  问号被劫持）；`aria-modal=true` 表示视觉/焦点上的遮罩层，但页面里没有实现焦点陷阱
  （popup 是短生命周期页面，未新增）。

### 29.5 页内录制胶囊「同页录制」提示：只是状态文本

- `content/record-capsule.js` 在录制胶囊上渲染 `role=note` 的整句提示「同页录制：导航会结束
  本次视频录制」，取自 12 语言词表 `record.capsule.samePageHint`（ar/he 随方向）；展开态显示
  整句，折叠态只保留 `!` 标记（`aria-hidden`），整句始终在 `aria-label`/`title` 里（读屏可达）。
- 它**只是状态说明**：不改变 SW 轮询（2 s）、Finish→`record.stop`、导航重建等逻辑，不读取/渲染
  录制内容，也不把 daemon token/trace 带到页面。E2E 断言整句等于命名空间
  `translate(KEY.HINT)`（不是硬编码文案）且可见正文与快照 `hint` 一致。

### 29.6 dashboard 帮助回答面 / 视频产物下载的安全边界（Z1 landing，本轮验证/记录）

- **帮助回答是操作员写面**：`POST /api/session/help/answer` 需要已登录 **operator** + **租户匹配**
  + **CSRF**（`X-CSRF-Token` 双提交），daemon `session.answer_help` 才落库；`answer` 非空
  ≤4,000 字符、`by` 有界（默认登录名）、`request_id` 为权威标识（与 `session_id` 同时给时由
  daemon 校验一致）。真实错误码如实：`404 E_UNKNOWN_HELP_REQUEST`、`409 E_HELP_REQUEST_EXPIRED`/
  `E_HELP_REQUEST_ALREADY_RESOLVED`、`400 E_INVALID_PARAMS`、`501 E_NOT_SUPPORTED`、
  `403 E_FORBIDDEN_ROLE`/`E_FORBIDDEN_TENANT`/`E_CSRF`；**每次拒绝/失败写审计**，不伪造成功。
- **只读帮助面**：`GET /api/session/help?session_id=ID[&tenant=ID]` 只是 daemon
  `session.request_status` 视图，`found:false` 时返回 `state:"unknown"`、`answer:null`，
  不发明请求；所有文本被 clamp/脱敏，不回显 daemon token。
- **视频产物下载是受限流**：`GET /api/video/download?id=RECORDING_ID[&tenant=ID]` 用 daemon
  `video.list` 解析 id（要求 `state:"available"`），目录登记 `path` 必须落在该 session
  `video.status` 报告的 `artifact_dir` 内（两侧 realpath 解析），只接受
  `.avi/.mp4/.webm/.mov/.mkv` 常规文件、≤ **64 MiB**（登记尺寸先校验、读前再校验真实尺寸）；
  **dashboard 与 daemon 两端都必须是 loopback**；响应是
  `attachment; filename="bridgedeck-video-<id>.<ext>"` + `video/*`，**绝不带绝对路径/token**。
  诚实错误码：`403 E_LOOPBACK_ONLY`、`409 E_DOWNLOAD_NOT_LOCAL`、`404 E_UNKNOWN_ARTIFACT`、
  `409 E_ARTIFACT_UNAVAILABLE`、`403 E_ARTIFACT_OUTSIDE_ROOT`、`404 E_ARTIFACT_MISSING`、
  `413 E_ARTIFACT_TOO_LARGE`、`502 E_ARTIFACT_INVALID`/`E_ARTIFACT_UNAVAILABLE`、
  `501 E_NOT_SUPPORTED`；无法下载时页面给 CLI `--session-video-save` 提示，不伪造下载。
  Z1 的真实 E2E 记录过 **24,152 B** 下载逐字节一致；本轮 `dashboard-session-e2e` standalone
  复跑覆盖 auth/CSRF/租户/下载边界（结果见 TEST-STATUS #60）。
- **写面最小化**：dashboard 的写路由只有 `session.open`/`session.close`/`act {click,fill}` 与
  operator help answer，**没有 navigate/observe/transfer**；所有写路由共享租户解析、错误映射与
  token 脱敏边界；**0.4 仍没有 help operate 面**（扩展/页面不能回答，回答只来自 daemon/CLI）。

### 29.7 测试/门禁接线（本轮只改 E2E/基线/预算，不改 stage-gate 步骤）

- `ui-quick-record-e2e` **178 → 198 checks/轮**：记忆排序（默认顺序/用后写 storage/点击当下不重排/
  下次打开前置/恢复默认清两键）+ 快捷键帮助层开合/dialog 契约 + 单键 aria-keyshortcuts +
  胶囊同页提示。`ui-more-menu-e2e` **177 → 185 checks/轮**：菜单最近使用记忆/恢复默认/重开仍默认。
  `ui-popup-e2e` **142 → 146 checks**：页脚入口/帮助层契约/单键声明，0.3 一致性断言保留。
- **没有新增或修改 `stage-gate.mjs` 步骤**：现有 `--with-ui`/`--with-ui-visual`/
  `--with-quick-record`/`--with-more-menu` 等 opt-in 步骤直接跑同一批脚本；默认 19/20/21 与扩展
  21/22 步语义不变。
- 视觉基线：只重录 fixture JSON（真实渲染变化），容差/下限/verify 不回写；`--with-ui-visual`
  步骤仍做 2 轮跨轮一致性。尺寸预算：只改 JSON 上限与文档理由，size-check 27 项 PASS。

### 29.8 隔离/未改边界（如实）

- **未改产品代码**：Z1/Z2 的 dashboard help/download（`help-handlers.mjs`/`artifact-handlers.mjs`/
  `page-detail-script.mjs` 等）与 quick-memory/单键/帮助层/胶囊提示（`popup.js`/
  `ui/panels/record-panel.js`/`content/record-capsule.js`/`locales.js`）由前置任务 landing；
  本轮只写测试、基线、预算与文档，并验证。
- **未改** `compliance-baseline.json`（hard 0 / ratchet 0，只降不升）、`stage-gate.mjs`（无步骤
  变更）、0.3.0 冻结区 / `dist` / `D:\CTRM自动录入`；未装依赖；未改任何断言/阈值/预算弱化。
- more-menu E2E 结尾 `storage.local` 会留下最后一个 `bb.quick.recent.more` 偏好（后续真实点击
  自然重写；这是用户偏好，不是测试污染）；quick-record E2E 则在“恢复默认顺序”处断言两键被清空。
- 本机无 `git`，改动以文件列表为准；Wave D 验收本体仍未做。

## 30. 扩展内协助回答 / HELP–REC 徽标 / 系统通知 + dashboard 分页收口边界（round 61, 2026-11-25）

本轮的 AB1（task-158：扩展内 help 回答、工具条徽标 HELP/REC、help.requested 系统通知 + 点击
打开、status-overlay help pending）与 AB2（task-159：dashboard `--with-dashboard` E2E 门禁 +
`/api/video` 分页/加载更多/产物目录提示）由前置任务落地；task-160 只做**集成与验证**（尺寸
注释 nit、视觉基线重录、E2E 复跑、文档/覆盖、全量门禁），不新增线协议方法、不改任何分类、
未弱化断言/阈值/预算。以下是可引用的边界与证据。

### 30.1 扩展内帮助回答（popup `#helpCard` → `session.answer_help`）

- `ui-compat` 的 `bb.call` 白名单从 26 → **27**（新增 `session.answer_help`），`bb.quick` 动作表
  从 24 → **25**（新增 `help.answer`）；两者只是把操作员回答送到 daemon 的**同一条** RPC，不新增
  数据面。
- 回答是**操作员显式写操作**：`#helpAnswer`（answer，≤4,000，与 daemon
  `MAX_HELP_ANSWER_LENGTH` 对齐）/ `#helpAnsweredBy`（by，≤120）/ `#helpAnswerSubmit`，只有
  真实点击才写；扩展不会自动回答、不会猜 request 是否已解决，`#helpCard` 的 pending/resolved
  展示只来自 `bb.state.help`（SW 缓存的 daemon `ext.help_request`/`ext.help_resolved` 广播与
  `bb.call` 回包）与本页刚提交的真实回包。「关闭」只收起本地卡片，**不取消** daemon 记录。
- 回答后的 resolved 展示（answer 摘要/answered_by）、重复回答 typed
  `E_HELP_REQUEST_ALREADY_RESOLVED`、过期 typed `E_HELP_REQUEST_EXPIRED` 都以 daemon 为准；
  没有 daemon 侧 operate 面，页内不能替代操作员。
- 证据：headed-Edge `ui-help-e2e` **67/67 checks/轮**（本轮复跑 2 次、每次默认 `--repeat 2`，
  共 4 轮全绿；含 popup 真实点击 `#qaHelp`、真实 CLI `--help-answer`、popup 回答输入 →
  `session.answer_help` → 已解决展示、重复/过期 typed 拒绝、清理全 true）。

### 30.2 工具条徽标（HELP / REC）

- `deriveLegacyBadge()` 是**纯派生**：help pending（未过期、`stale!==true`、`pending!==false`）优先
  → `HELP`（`#d97706`、title「BridgeDeck：Agent 请求人工协助」）；否则录制中 → `REC`
  （`#dc2626`）；否则清空文本并恢复默认 tooltip。应用只用 `chrome.action.setBadgeText` +
  `setBadgeBackgroundColor`，失败静默降级（warn 日志，不抛）。
- 边界：徽标是**本地投影**，不新增数据面、不伪造状态；resolved/expired 后必须清空（E2E 用
  `chrome.action.getBadgeText` 真读断言，且断言 resolved 后恢复默认 title）。
- 证据：`ui-help-e2e` 的 badge 段（pending 真读 `HELP` → resolved 后清空）；fake-chrome 单测
  `ui-compat.test.mjs` 覆盖派生优先级/过期/stale。

### 30.3 协助请求系统通知（`bb.help.notify`）

- 开关是 `storage.local['bb.help.notify']` 的**独立布尔键**（默认开；不塞进 0.3 `bb.settings`，
  避免被 options 的 `normalizeSettings` 丢弃）。popup 第五个设置行
  「协助请求系统通知」写这个键；开关可用性取 SW 真实 `chrome.notifications.create` 能力
  （不可用时禁用并显示原因，不假装可弹）。
- `ext.help_request` 到达且开关未关时，SW 创建 `bb04.help.<request_id>` 通知（标题
  「BridgeDeck 需要你的协助」、body 含 request 摘要、`requireInteraction:true`），
  resolved/cancelled 时清理。点击由 SW 顶层同步注册的 `notifications.onClicked` 打开
  `ui/popup.html?help=<request_id>`（优先 `windows.create`，失败退 `tabs.create`）；页面只把
  id 当**路由线索**，展示哪条请求以 `bb.state.help`/daemon 事实为准，不把 id 当可信状态。
- **如实失败（本轮实测，不隐藏）**：在当前 Windows Edge staging 的真实 E2E 中，
  `chrome.notifications.create` **失败**，记录 `attempted:true / ok:false /
  reason:'notification_create_failed' / error:'Unable to download all specified images.'`
  ——通知 `iconUrl` 是内联 `data:image/svg+xml`，Edge 的通知服务拒绝该图标。E2E 断言的是
  「真实尝试 + 诚实失败原因」，**不伪造弹过通知**；`onClicked` 点击打开路径目前只有 bridge
  单测覆盖（该环境通知未实际出现，E2E 没有点真实系统通知）。因此「系统通知」当前是
  **已实现但未在真实 Edge 上成功显示**，后续 follow-up：改用扩展打包图标
  （`chrome.runtime.getURL('icons/icon128.png')`）或不用图标后重跑 E2E，并把「必须 ok=true」
  写进断言；在此之前不得宣称通知可用。通知失败/关闭/权限拒绝都不阻塞 `help.request`。
- 证据：`ui-help-e2e` 的 badge/notification 段（attempted=true、reason 原样、resolved 后
  notification 清理）；`ui-popup-e2e` 新增 4 条断言（设置行 label/tooltip/`aria-describedby` +
  `role=switch` 默认开且可用 → 关写 `bb.help.notify=false` 且不进 `bb.settings` → 再开写 true）；
  合计 146 → **150 checks**，旧断言全部保留。

### 30.4 status-overlay 的 help pending

- 页内状态浮层接收 `help.requested` → 合并为高优先级 `help` 状态（12 语言标题/原因），
  `help.resolved`/`help.cancelled` 收起；它只是**状态镜像**，不改变 2s 轮询/Finish 逻辑，也不
  新增数据面。

### 30.5 dashboard `/api/video` 分页 / 加载更多 / 清理提示

- 分页契约：`limit` 1..100（默认 20）、`offset` 0..1000（0-based），**最新在前**；响应带
  `count`/`total`/`has_more` 与有界 `since`-cursor 扫描事实（`scan_limit`/`truncated` 等）；
  `offset` 越过 `total` 但在扫描窗口内 → 诚实空页（`count:0`、`has_more:false`），越过窗口 →
  `400 E_OFFSET_OUT_OF_RANGE`，非法 limit/offset → `400 E_INVALID_PARAMS`。
- 页面（第 4 个内联脚本 `page-video-script.mjs`）：产物列表「加载更多」第二页、空/错误态如实、
  只读产物字节数与清理提示（cleanup hint）；下载走有界 loopback `/api/video/download`（catalog
  id + artifact-dir containment + size cap），**逐字节一致**、不伪造、不回显 token/绝对路径。
- 证据：`dashboard-session-e2e` **43/43 checks/轮**（本轮复跑 2 次、每次默认 `--repeat 2`，
  共 4 轮全绿）：真实 2 段 MJPEG-AVI 录像、`videoPagination.total=2`、`loadMoreRows=1`、
  `emptyPage=0`、`clampedLimit=100`、下载 12,192–24,152 B（真实录像大小逐次不同，如实记录）、
  accounts 轮登录/CSRF/operator/help 回答与清理全 true。
- 门禁：`--with-dashboard` 是 opt-in 步骤（browser lane cap=1、420 s 上限、`--repeat 1 --quiet`、
  `checksTotal>=40` 防空跑，附加校验报告 `ok/status/script`、stability、cleanup、两段录像与
  分页事实）；它只做**附加**校验，不替换/不放宽脚本自身断言。

### 30.6 预算 655,360 / 344,064 的理由（本轮未改预算值）

- `extensionUi.maxTotalBytes = 655,360 B` 由 round 60（task-157）在专门改动里上调（524,288 →
  655,360，实测 534,833 B / 41 文件，旧上限已超 10,455 B，余量 120,527 B≈18.4%），原因是
  task-156 的快捷栏页脚/快捷键帮助层/记忆排序/12 语言词条。
- `dashboard.maxTotalBytes = 344,064 B` 由 round 61（task-159）在专门改动里上调（327,680 →
  344,064，实测 329,483 B，余量约 14,581 B≈4.2%），原因是分页 `/api/video` 页面、有界
  `since`-cursor 扫描与第 4 个单职责 page script（`page-video-script.mjs`，11,598 B）把视频
  列表从 `page-detail-script.mjs` 拆出（46,185 → 35,388 B）；per-module / assembly /
  page bundle / ingress UI / locale 上限未动。
- 本轮 task-160 **没有改任何预算值**，只改 `dashboard-size-check.mjs` 顶部注释的
  「three script parts」→「four script parts」（与 6 个 pageFiles = HTML + CSS + 4 个 script
  一致的事实更正，非阈值变更）。

### 30.7 测试/门禁接线（本轮写域）

- 视觉基线：task-158 的 popup 新增设置行/回答区改变初始渲染（popup sha256 `069b7668…` →
  `7d489096…`），三页一并 `--write-baseline` **37/37**（8.6 s），verify **2 次 standalone 各 2 轮
  × 43/43**（`consistent:true`；run 最大格差 popup 0.83–1.48、options 0、dashboard 1.59–2.49；
  两轮互比 popup 1.17、dashboard 0.62，差异格 0）；容差/下限/0 px 尺寸容差**未改**，verify
  不回写。`TASK`/基线 `note`/`fixtures/ui-baseline/README.md` 同步 task-160/round 61。
- E2E：`ui-help-e2e` 67/67 ×2 次（每次 2 轮）、`dashboard-session-e2e` 43/43 ×2 次（每次 2 轮）、
  `ui-popup-e2e` **150/150**（新增 4 条协助通知设置行断言，旧 146 条保留）。
- 文档/覆盖：STATUS round 61、TEST-STATUS 第 61 条、HANDOFF §47、本文 §30、BEYOND-BSK、
  ingress/dashboard/0.4/bench README、ui-baseline README；COVERAGE 报告块重生成到
  `bsk-coverage --check` 通过（只读生成器，不手改围栏内数字）。
- 全量门禁（test-all、默认、扩展、--with-ui、--with-ui-visual、--with-budget、
  --with-quick-record、--with-more-menu、--with-borrow-confirm、--with-help、--with-dashboard、
  eval、coverage、source guard、compliance、size-check）结果与 flake 记录见 TEST-STATUS 第 61 条；
  **未改** `stage-gate.mjs` 步骤（`--with-dashboard` 由 task-159 加入并复验）、
  `compliance-baseline.json`（hard 0 / ratchet 0，只降不升）。

### 30.8 隔离/未改边界（如实）

- 0.3.0 冻结区 / `dist` / `D:\CTRM自动录入` 未改；未装依赖；本轮只改测试/基线/文档/尺寸注释，
  未改产品代码（AB1/AB2 产品代码由前置任务 landing）、未弱化任何断言/阈值/预算。
- 本机无 `git`，改动以文件列表为准；Wave D 验收本体（一个 DSH 10 步任务 + 可回放 UI 证据）
  仍未做；系统通知在真实 Edge 上的成功显示未验证（见 §30.3），headed-Chrome、跨机 mTLS、
  dashboard TLS/持久会话等既有 follow-up 不变。

## 31. 通知图标/按钮/点击边界 + dashboard 分页压力与截断提示收口（round 62, 2026-11-25）

本轮把 round 61 留下的两条 follow-up 收口：AD1（task-161：通知图标改扩展内打包 PNG +
两个按钮 + 点击路由）与 AD2（task-162：21 条真实录制分页压力 + 发现并修复空页丢截断提示）。
task-163 只做**集成与验证**：修 UI 缺口、把门禁摘要里硬编码的 `artifacts=2` 改成读 E2E
报告、把 `background.test.mjs` 显式纳入 `test-all`、文档/覆盖、全量门禁。**新增 0 个 wire
方法、未改任何分类/断言/阈值/预算**。

### 31.1 系统通知：图标改打包 PNG（task-161 落地，本轮验证/记录）

- 失败事实（round 61 记录）：真实 Edge staging 下 `chrome.notifications.create` 以
  `Unable to download all specified images.` 失败，原因是 `iconUrl` 用了内联
  `data:image/svg+xml`（Edge 通知服务拒绝该图标）。round 62 起图标改为扩展内打包 PNG：
  `chrome.runtime.getURL('icons/icon128.png')`（`manifest.icons` 已声明、构建 staging 时随包
  复制），`NOTIFICATION_ICON_PATH`/`notificationIconUrl()` 在 `src/borrow.js` 统一定义，
  borrow 确认通知与 help 通知共用同一来源。
- 真实 E2E 里的通知事实（本轮实测，**不再是「尝试过」**）：`attempted:true / ok:true /
  notification_id:'bb04.help.<request_id>' / icon_url:'chrome-extension://<id>/icons/icon128.png' /
  buttons:['打开弹窗回答 / Open popup','打开 Dashboard / Open dashboard']`；断言
  `chrome.notifications.getAll` 真含该 id、resolved 后通知被清理。创建失败时浏览器返回的真实
  `error` 直接进断言详情（不再「失败也放过」）。
- 两个按钮与点击路由：`notifications.onButtonClicked(notificationId, buttonIndex)` 由
  `background.js` 在 SW 顶层**同步注册**（MV3 SW 冷启动也能收到），按钮 0 → popup 回答面
  （`ui/popup.html?help=<request_id>`，优先 `windows.create` 独立窗口，失败/缺失降级
  `tabs.create`），按钮 1 → dashboard（复用 0.3 UI 兼容层的 `dashboard.open`，未配置地址/失败
  降级 popup）；点击通知本体（`onClicked`）同样打开 popup。页面只把 `help=<request_id>` 当
  **路由线索**，展示哪条请求仍以 `bb.state.help`/daemon 事实为准，不把 id 当可信状态。
- **能力边界（如实）**：真实 OS 通知是否弹到屏幕、真实鼠标点击按钮无法由 CDP 自动化断言，
  E2E 只断言「create 成功 + 通知 id 真实存在 + 按钮随 create 提交 + 监听器已注册」，**不伪造
  用户点击**；点击/按钮路由的单元级断言在 `extension-ingress/test/background.test.mjs`
  （fake chrome 驱动真实 `background.js`/`src/bridge.js`/`src/borrow.js`：按钮 0 → popup、
  按钮 1 → dashboard、窗口失败降级 tab、create 失败诚实路径）。这是**能力边界**，不是「用户
  已看见/点击通知」的宣称。
- 开关与降级不变：`storage.local['bb.help.notify']` 独立布尔键（默认开，不进 0.3
  `bb.settings`），不可用时 popup 禁用并显示原因；通知失败/关闭/权限拒绝都不阻塞
  `help.request`。

### 31.2 dashboard 21 条真实录制分页压力 + 空页截断提示（task-162 落地，本轮修缺口）

- 分页压力：`dashboard-session-e2e` 的真实录制循环从 **2 → 21** 段 MJPEG-AVI（真 daemon 自己
  录、真 artifact 目录、真 `video.list` catalog 行），因此默认页 20 行 + `has_more:true`、
  load-more 尾页（`offset=20`，1 行，`has_more:false`）、21 行整页、越过 total 的诚实空页、100
  行 clamp 与 typed `E_INVALID_PARAMS`/`E_OFFSET_OUT_OF_RANGE` 全部对**真实 catalog** 断言；
  单轮 checks **43 → 45**。`dashboard/server.test.mjs` 同步加 21 行（混入其它 session 行）压力
  用例与截断扫描窗口边界用例（**96/96**）。
- **本轮修掉的 UI 缺口（如实）**：`page-video-script.mjs` 的 `renderVideoPager()` 原来只在
  `total>0` 分支拼接 `truncated` 提示；当 session 的行全部落在有界 1,000 行扫描窗口之外时
  （daemon 目录是**最旧优先**扫描，`total:0` + `catalog.truncated:true`），页面只显示
  「0 entries for this session」，可能被读成「完整目录为空」。修复后**空页也拼**同一句
  「the catalog scan was bounded at <scan_limit> entries; use the CLI
  `--session-video-list --since` for deeper pages」，状态行改为
  「no rows in the bounded catalog scan window」（与 `total>0` 分支同一事实，不是新阈值）。
  分页契约/字段/上限未改。
- 门禁摘要更正：`stage-gate.mjs` 的 `--with-dashboard` 摘要原来硬编码
  `artifacts=2 (id1, id2)`；现在从 E2E 报告的 `evidence.video.count`/`ids` 读真实数量并打印
  `oldest/newest` id（本轮实测 `artifacts=21`）。门禁的附加校验（`checksTotal>=40`、
  `catalogCount>=2`、`total>=2`、`loadMoreRows===1`、`emptyPage===0`）**阈值全部未改**，
  只改摘要文本。
- 证据：standalone `dashboard-session-e2e --repeat 1 --quiet` **45/45**（`catalogCount=21`、
  `totalBytes` 为 21 段真实文件之和、下载 24,152 B 一例、`refusals:[E_INVALID_PARAMS,
  E_OFFSET_OUT_OF_RANGE]`，清理全 true）；`--with-dashboard` 门禁步骤见 §31.5 的门禁记录。

### 31.3 测试收集：`background.test.mjs` 显式加入 `test-all`

- `extension-ingress/` 不在 `test-all` 的 walk 根内，`extension-ingress/test/background.test.mjs`
  此前是 standalone-only；本轮在 `0.4/scripts/test-all.mjs` 的显式列表加入该文件（browser-free：
  fake `chrome.*` + 真实 `background.js`/`src/bridge.js`/`src/borrow.js`，无 Edge/Chrome、无
  bench），进入 regular 4 路组。
- 核对结论（如实）：AD1/AD2 的其它新增测试都在既有 walk 根内自动收集（`dashboard/server.test.mjs`
  早已显式列出；`tests/dashboard-session-e2e.mjs` 保持非 `*.test.mjs`，只由 opt-in
  `--with-dashboard` 覆盖）；`extension-ingress/test/smoke.mjs` 仍是 fixture runner 不进收集。
  **既有缺口（非本轮引入）**：`extension-ingress/test/ui-compat.test.mjs` 仍为 standalone-only
  （本轮实测 standalone **35/35**、3.4 s、browser-free）；扩收超出 AD1/AD2 范围，如实记录为
  follow-up，不在本轮伪装已覆盖。
  **round 63 更正（task-164 AF1 + task-166 AG1）**：该缺口已关闭 —— AF1 把
  `ui-compat.test.mjs` 显式加入 `0.4/scripts/test-all.mjs`（browser-free regular 4 路组），
  round 63 复跑 `test-all` 得 **2371 tests / 2370 passed / 0 failed / 1 skipped**（基线
  2336 → +35），standalone 单跑仍 35/35。

### 31.4 文档编码事故（本轮修复/记录，如实）

- `0.4/dashboard/README.md` 在本轮开始前已不是合法 UTF-8：**75 处**三字节标点被写成
  `E2 xx 3F`（`—`/`–`/`→`/`≤`/`≥`/`∈`/`▶`/`│` 的第三字节被替换成 `?`，其中 4 处还把紧随的
  数字/空格吞掉），`read`/`edit` 工具直接拒绝读取。本轮按上下文 + 代码常量修复：range
  `1–64`（`ACCOUNT_USERNAME_PATTERN`/`TENANT_ID_PATTERN` 的 `{1,64}`）、`10–1000`
  （`MAX_AUDIT_LIMIT`）、`100–60000`（`--refresh-ms` 校验）、`261,733 B — 411 B` 等；修复后
  strict UTF-8 通过、文件可正常读写，并顺带补回被吞掉的空格（`— `、`→ `、`≤ `）。仓库
  `tools/source-guard.mjs` 的编码守卫只扫根目录 `docs/`/`extension/`/… 等 TEXT_ROOTS，
  **不含 `0.4/`**，所以这类损坏此前不会被门禁抓到。
- **未修复但记录**：`0.4/bench/README.md` 存在**既有的 GBK 双重编码 mojibake**（183 处
  `鈥?`/`鈮?`/`鈫?`/`脳`/`搂` 等，来自更早一轮的非 UTF-8 回写；文件本身是合法 UTF-8 所以
  编码守卫/合规都不报）。它不在本轮写域必要项内，未做全量重写（避免大范围非必要 diff），
  如实记录为文档技术债；本轮只保证新增/修改段落自身内容准确。
  **round 63 更正（task-164 AF1 + task-166 AG1）**：该项已关闭 —— `0.4/bench/README.md`
  已全量重写为严格 UTF-8（152 行 / 194 个 mojibake 字形），round 63 独立复核 strict UTF-8
  通过 + mojibake 特征 **0**；`tools/source-guard.mjs` 的 encoding 扫描根也不再只扫根目录：
  AF1 扩到 5 个 0.4 产品文档（1,145 → 1,150 文件），round 63 再扩到 0.4 全部 **194 个
  `*.test.mjs`**（→ **1,344** 文件）并修掉 `0.4/packages/browser-adapter/test/fill.test.mjs:175`
  的非法 UTF-8 测试名（GBK 字节 `d3eb…cfe0b7b4` → 合法 UTF-8 `与 noClear 相反`，语义不变）。

### 31.5 测试/门禁接线（本轮写域）

- `0.4/scripts/test-all.mjs`：+1 条显式收集路径（`extension-ingress/test/background.test.mjs`）
  与说明注释；其余收集逻辑未改。
- `0.4/scripts/stage-gate.mjs`：只改 `--with-dashboard` 的**摘要与文档注释**（artifact 数从
  E2E 报告读、不硬编码 2；注释从「两段」更新为 21 段/45 checks），**未加/未改步骤**，默认
  19/20/21 与扩展 21/22 步语义、任何阈值/预算/断言均未变。
- 文档同步：`0.4/STATUS.md` round 62 + header、`docs/TEST-STATUS.md` 第 62 条、
  `docs/HANDOFF-2026-11-23-session-loss.md` §48、本文 §31、`docs/0.4-BEYOND-BSK.md`、
  `0.4/README.md`、`0.4/dashboard/README.md`、`0.4/extension-ingress/README.md`、
  `0.4/bench/README.md`；COVERAGE 围栏块由生成器重生成到 `bsk-coverage --check` 通过。

### 31.6 隔离/未改边界（如实）

- 0.3.0 冻结区 / `dist` / `D:\CTRM自动录入` 未改；未装依赖；`compliance-baseline.json`
  保持 hard 0 / ratchet 0（只降不升）；**未弱化任何断言/阈值/预算**（`--with-dashboard`
  的 `checksTotal>=40`、`catalogCount>=2`、分页事实阈值、size 上限全部未动）。
- 本机无 `git`，改动以文件列表为准；真实 OS 通知的屏幕可见性/真实点击仍是能力边界（见
  §31.1）；dashboard 分页 >1000 offset 窗口的真实大数据集仍未 E2E；Wave D 验收本体、
  headed-Chrome、跨机 mTLS 等既有 follow-up 不变。

## 32. 编码/验收收尾边界（round 63, 2026-11-25）：0.4 测试文件编码门禁、`ui-compat` 收集复核、验收文档更正

### 32.1 能力/分类：零变化

- 本轮（AF1 / task-164 + AG1 / task-166）**未改任何产品行为代码**、未加/改 wire method、
  未改 usable 分类：usable **77/77（scope 条件）**、full **53** / partial **0** / refused **0**、
  control **24/24 real**、0 missing codecs；tool.* 的 4 个 opt-in extension 条件与
  `tool.cooperate` 的 `[3e]` scope 条件全部不变。COVERAGE 围栏块 `--check` 通过
  （77 method names + output block）。
- 代码量口径：AF1 的 `test-all` 收集条目使 production **+9**（`scripts` 6,841 → **6,850**），
  故 0.4 = **275,055** 行 = **145,869** production + **129,186** test（80.2% / 84.5% / 82.1%
  of BSK 334,821）；round 63 的 `fill.test.mjs` 修复**不改行数**（只改 3 个字节的编码）。
  COVERAGE §0/§2 散文数字已按生成器重同步（此前自 round 62 漂移 +9）。

### 32.2 编码门禁：0.4 测试文件纳入严格 UTF-8 扫描

- **发现的缺口**：`tools/source-guard.mjs` 的 encoding 守卫 `TEXT_ROOTS` 不含 `0.4/`；
  AF1 只把 5 个 0.4 产品文档加进 UTF-8/U+FFFD + mojibake 守卫（1,145 → 1,150 文件），
  但 0.4 的 `*.test.mjs` 仍未扫 —— `0.4/packages/browser-adapter/test/fill.test.mjs:175`
  的测试名因此长期是 GBK 回写字节（`20 74 65 73 74 28 27 … 20 d3eb 20 6e 6f 43 6c 65 61 72
  20 cfe0b7b4 27 …`），文件不是合法 UTF-8，`node --test` 仍能跑（V8 按替换字符解析字符串），
  门禁/compliance 都不报。
- **修复**：测试名恢复为合法 UTF-8 `fillClearBefore 与 noClear 相反`（`d3eb`=`与`、
  `cfe0b7b4`=`相反`），**语义不变**（同一用例、同一断言；standalone **6/6**）。
- **门禁扩展**：encoding 扫描集新增 0.4 下全部 **194 个 `*.test.mjs`**（跳过 `node_modules`；
  只做 strict UTF-8 / U+FFFD，**不加 mojibake 启发式**，避免把测试里有意引用的乱码夹具误判）；
  0.3.0 冻结区、`dist/`、`ref/` 与 0.4 工作笔记仍在集合外。encoding 文件
  **1,150 → 1,344**，`source-guard` PASS（focus clean / mojibake clean 5 个 0.4 文档）。
- **负向自测（不弱化门禁的证明）**：①把历史 GBK 字节原样写回 `fill.test.mjs` → guard
  **FAIL** 并输出 `0.4\packages\browser-adapter\test\fill.test.mjs: 不是合法 UTF-8（疑似被
  ANSI/GBK 回写）`；恢复后 PASS，恢复前后 sha256 一致
  （`0c1ea5eb…b217be`）。②向 `0.4/scripts/budget-check.test.mjs` 注入一个孤立 `0x80` 字节 →
  同样 FAIL 并指名文件；恢复后 sha256 一致（`7a6dd257…7efe1e`）。两次都证明「新扫描集真的会
  失败」，不是只把文件数变大。

### 32.3 `ui-compat.test.mjs` 收集复核（AF1 落地、round 63 复跑）

- AF1 已把 `0.4/extension-ingress/test/ui-compat.test.mjs` 显式加入
  `0.4/scripts/test-all.mjs`（非 walk-root 显式列表，browser-free regular 4 路组）；
  round 63 全量复跑：**2371 tests / 2370 passed / 0 failed / 1 skipped**（15 段
  `node --test` 汇总全 `fail 0`；skip 仍是 `video-catalog` POSIX mode 位），standalone
  单跑仍 35/35。
- **`0.4/bench/README.md` 编码债**：AF1 全量重写为严格 UTF-8（152 行 / 194 个 mojibake 字形 +
  1 处中文短语）；round 63 独立复核 1 文件 strict UTF-8 通过、mojibake 特征 0（同批复核
  `0.4/README.md`、`extension-ingress/README.md`、`dashboard/README.md` 均 strict UTF-8 +
  mojibake 0）。

### 32.4 文档更正（过期表述改为「已完成/已收集」，数字随实测）

- `docs/0.4-CAPABILITY-ACCEPTANCE.md`：E1（2371/2370/1/0，round 63 复跑）、E12（encoding
  **1,344**）、E14、§2.4、§4.5（`ui-compat` 收集 → 已关闭 + 复核）、§4.6（bench README 债 +
  0.4 测试编码缺口 → 已关闭，含负向自测）、§5.1/§5.3/§6；不再保留「预计 ~2370」「standalone-only」
  这类过期口径。
- `0.4/STATUS.md`：header 改 round 63；round 62 段内 ③⑥/边界/下一步的「183 处未修」
  「`ui-compat` standalone-only」就地标注 **round 63 已关闭**（保留历史事实，不删证据）。
- `docs/TEST-STATUS.md`：第 62 条同样就地更正 + 新增第 63 条（本条）。
- `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md`：§31.3/§31.4 就地更正 + 本节 §32。
- `docs/bsk-study/BSK-0.5.0-COVERAGE.md`：§0/§2 散文数字重同步（275,055 / 145,869 /
  `scripts` 6,850）+ Round 63 段；`docs/0.4-BEYOND-BSK.md`：status 行（2371/2370/1、
  145,869、275,055）+ Round 63 段。

### 32.5 隔离/未改边界（如实）

- 0.3.0 冻结区（根 `extension/`、`lib/`、`daemon/` 等）/ `dist` / `D:\CTRM自动录入` 未改；
  未装依赖；未改产品行为代码；未改任何断言/阈值/预算/预算值（`compliance-baseline.json`
  保持 hard 0 / ratchet 0，只降不升）。
- 仍然成立的边界：真实 OS 通知可见性/点击不可 CDP 自动化（§31.1 不变）；dashboard 分页
  >1000 offset 真实大数据集未 E2E；Wave D 验收本体未做；低概率 headed-Edge 归因 flake 仍是
  「未复现」而非「概率 0」；本机无 `git`，改动以文件列表为准。
- 门禁复跑记录见 `0.4/STATUS.md` round 63 与 `docs/TEST-STATUS.md` 第 63 条。

## 33. CUT3：范围收缩边界（round 64, 2026-11-25，task-168/169/170）

### 33.1 范围纪律（本轮唯一口径）

- 用户口径（已明确、本轮执行）：**只按 0.3.0 与上游 0.5.0（BSK）已有功能来；0.4 自造的“更快/更多”
  增量（乱加的）砍掉；0.3/上游有而 0.4 缺失/失效的属“该有未对齐”，但本轮只做删除，不扩大新增面。**
- 执行依据：`docs/FEATURE-SCOPE-0.3-BSK.md`（AF3 / task-167 只读审计，精确到文件/DOM id/消息名/
  存储键/权限/测试）。本轮的删除面严格取自该审计的 CUT 清单；未列入 CUT 的面不动。
- 判定边界：0.3.0 冻结区（仓库根 `extension/`、`lib/`、`daemon/` 等）只读；`dist/` 与
  `D:\CTRM自动录入` 未触碰；本轮未装依赖；未改任何断言严格度/阈值/预算值（合规基线 hard 0 /
  ratchet 0，只降不升）。
- **工作拆分（互不越界）**：task-168 只改 `0.4/extension-ingress/ui/`（+ 其 `test/ui.test.mjs`）；
  task-169 只改 `src/`、`background.js`、`manifest.json`（+ `ui-compat`/`background`/`status-overlay`
  smoke 测试）；task-170 只改测试/门禁/文档（`0.4/tests/`、`0.4/scripts/`、READMEs、STATUS/
  TEST-STATUS/HANDOFF/ACCEPTANCE/BEYOND/COVERAGE/SCOPE-DECISIONS）。这样“删产品面”与“改验收面”
  由不同写入者完成，集成者复核最终 diff。

### 33.2 砍掉清单（已执行；精确到面）

popup/扩展侧（0.3 与上游都没有的 0.4 自造面）：

- 快捷栏 `#quickBar` 8 项（`qaRecord/qaHelp/qaBorrow/qaCopyTrace/qaDashboard/qaPause/qaScreenshot/
  qaSettings`）与页脚（`#qaOrderReset`/`#shortcutHelpOpen`/`#qaMore`/`#quickStatus`/`#quickReasons`）；
- 「更多」菜单 `#qaMore`/`#moreMenu` 9 项（视频×3/调试×3/长截图/账本/会话详情）与
  `#moreStatus`/`#moreReasons`；
- 最近使用记忆：`storage.local['bb.quick.recent']`/`['bb.quick.recent.more']` 两键 + 排序/重置；
- 单键 `r`/`d`/`?`、组合键与 `aria-keyshortcuts`、快捷键帮助层 `#shortcutHelp*`（7 词条）；
- 协助通知开关 `#helpNotify` + `storage.local['bb.help.notify']`；
- 视频保存面板 `#videoSavePanel` 与 popup 录制中导航警告 `#recordNavWarn*`；
- TraceV3 录制控制台 `#recordCard`（purpose/计时/步骤表/摘要/digest/导出/复制回放命令/清除/
  `bb.record.workflow`/`bb.record.purpose` 持久化）；
- 弹窗回答表单 `#helpAnswer*`（`#helpAnswer/#helpAnsweredBy/#helpAnswerSubmit/#helpAnswerDismiss/
  #helpAnswerStatus/#helpAnswerArea`）；
- `bb.quick` 25 动作信封、`UI_COMPAT_QUICK_ACTIONS`、`bb.state.ui_compat.quick_actions`；
- `dashboard.open` 本地动作、`UI_COMPAT_LOCAL_METHODS`、`DASHBOARD_SETTINGS_KEYS`、
  `bb.dashboard.url|port`、通知里的「打开 Dashboard」按钮；
- `HELP` 徽标分支（只保留 `REC`，录制事实）；
- 对应测试/门禁：`0.4/tests/ui-quick-record-e2e.mjs`、`ui-more-menu-e2e.mjs`、`ui-help-e2e.mjs`
  三个 E2E 删除；`stage-gate` 的 `--with-quick-record`/`--with-more-menu`/`--with-help` 三个
  opt-in 步骤删除（矩阵 19..34 → **19..31**，默认 19/20/21 与扩展 21/22 语义不变）；
  `test-all` 无 E2E 收集项变化（被删脚本都不是 `*.test.mjs`）。

### 33.3 保留/对齐清单（0.3 或上游已有，KEEP）

- popup 回到 0.3 `extension/ui/popup.html` 原面（86 个 id 全在），额外只允许 5 个**只读**帮助卡 id
  （`#helpCard/#helpState/#helpMeta/#helpMessage/#helpResolvedText`）；`options.html` 与 0.3 逐字节
  一致；5 个 0.3 快捷功能面板（record/debug/longshot/ops/audit）仍由 `#openFeatures`/
  `#featuresView` 打开。
- 借用确认（页内 shadow-DOM 确认条 + inactive tab 通知 Allow/Deny + 60 s 超时 fail-closed）；
  页内状态浮层（`content/status-overlay.js`；全局隐藏改读 0.3 的 `bb.settings.controlHint`，
  0.4 自造键 `bb04.ui.statusOverlayHidden` 删除）；页内录制胶囊（`content/record-capsule.js`，
  0.3/上游同面）；人类输入归因（`content/human-watch.js`，±1.5 ms 精确匹配）；`ext.collect`
  快路径 B（内部 seam、默认关、无 UI 入口）；扩展生命周期/窗口路由/借用保真（A3a/A3b）。
- 协助系统通知保留（打包 PNG 图标、`requireInteraction`、点击/按钮打开 popup 独立窗口失败降级 tab），
  但**只剩 1 个按钮**「打开协助面」；`HELP` 徽标删除后帮助状态由页内浮层/通知表达。
- `bb.*` 兼容层：5 个支持类型不变；`bb.call` 白名单 **27 → 17**（无 UI 消费者的
  `record.*`/`trace.*`/`video.save`/`video.list`/`debug.export`/`cooperate.status`/`session.request`
  等移除）；新增 `UI_COMPAT_LEGACY_PANEL_TYPES`（14 个 0.3 面板消息）把 `bb.rec.*`/`bb.debug.*`/
  `bb.capture`/`bb.audit.list` 映射到真实 daemon 面（`video.*`/`debug.*`/`screenshot.capture`/
  `ledger.list`），`bb.ops.*`/`bb.audit.clear` 返回 `E_UI_COMPAT_UNAVAILABLE`（0.4 无人类示范录制
  数据面，不伪造）。
- 语言桥接（`bb.uiLang` ↔ `bb04.ui.language` 单向镜像）、12 语言/RTL、CSP、0.3 像素一致面保留。

### 33.4 测试/门禁/文档收缩（如实，不弱化）

- 测试：`test-all` **2371 tests / 2370 passed / 1 skipped**（round 63）→ **2345 / 2344 / 1 / 0 failed**
  （round 64）；减少的 26 条全部来自被砍面单测（`ui.test.mjs` 46→28、`ui-compat.test.mjs` 35→31、
  `background.test.mjs` 13→11），保留断言逐条不变。
- 门禁：3 个 opt-in 步骤删除，矩阵组合上限 34→31；**`--with-ui` 的 `ui-popup-e2e.mjs` 重写**为
  「0.3 popup/options id 集合不多不少 + 5 面板逐一打开 + 被砍面缺席 + CSP/RTL/借用确认/状态浮层」；
  `--with-ui-visual` 因 popup 首屏真实变化按事实重录基线（容差/下限不变）；`--with-borrow-confirm`、
  `--with-dashboard` 原样保留；默认/扩展门禁步骤数和阈值不变。
- 文档：`0.4/STATUS.md` round 64 / `docs/TEST-STATUS.md` #64 / HANDOFF §50 / 本 §33 /
  `docs/0.4-CAPABILITY-ACCEPTANCE.md`（四件套改为对齐版）/ `docs/0.4-BEYOND-BSK.md` /
  `0.4/README.md` / `0.4/bench/README.md` / `0.4/extension-ingress/README.md` /
  `docs/FEATURE-SCOPE-0.3-BSK.md`（标注已执行）/ COVERAGE 围栏块与散文数字。
- 覆盖看板：**分类零变化**——usable **77/77**（scope 条件）、full **53** / partial **0** / refused **0**、
  control **24/24 real**、0 missing codecs；但代码量按事实下降：production **145,869 → 141,973**、
  test **129,186 → 119,644**、total **275,055 → 261,617**（78.1% / 78.2% / 78.1% of 334,821）；
  `[2]` 行 `tests` 32,556、`scripts` 6,529、`extension-ingress` 40,151；`bsk-coverage --check` 通过。

### 33.5 未执行的 ALIGN 项（如实，留给后续）

见 `docs/0.4-CAPABILITY-ACCEPTANCE.md` §4.9：页内协助备注输入（审计 D2）、`allowHelp`/
`cooperationGuard`/`pageGuard`/`borrowConfirm` 的行为接线（审计 B2/B4/B5；`controlHint` 已接）、
三份内嵌 12 语言表合并 + `web_accessible_resources` 删除（D6/E9）、5 面板数据面逐面板真实读写
验收（A3/B3）、录制胶囊 `samePageHint` 自造文案（D5，`content/` 不在本轮写域）、dashboard 本体
（E8，冻结为 0.4 自建面）。这些**未执行、也不按“已达成”记录**。

### 33.6 隔离/约束（如实）

- 0.3.0 冻结区 / `dist` / `D:\CTRM自动录入` 未改；未装依赖；本轮未改 wire method/字段/错误码，
  未改工具分类；合规基线 hard 0 / ratchet 0（只降不升）。
- 真实浏览器 E2E 互斥（并发 BLOCKED 不记 PASS）；门禁与 standalone 数字见
  `0.4/STATUS.md` round 64 与 `docs/TEST-STATUS.md` #64。
