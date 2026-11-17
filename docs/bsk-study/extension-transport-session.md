# BSK 0.5.0 — extension transport + session-manager (study note)

Root: `D:/浏览器桥/ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0` (paths below relative to it). Read-only study;
nothing under `ref/` or `apps/` was modified. Note: `apps/extension/background.js` does **not** exist in
0.5.0 — the SW entry is `apps/extension/src/entrypoints/background.ts` (783 lines).

## Core model

- Transport = dumb byte pipe, 3 JSON frame shapes (request/response/event), no routing/ordering
  (`apps/extension/src/transport/transport.ts:18-25`, `transport/types.ts:40-114`, `transport/README.md:48-69`).
  `send()` throws unless state==connected && readyState==OPEN (`transport/ws-transport.ts:152-165`).
- `ConnectionState = disconnected|connecting|connected|version_skew` (`transport/types.ts:21`); only the
  handshake layer may set `version_skew` (`lib/connection-controller.ts:452-495`).
- Two nested state machines: socket-level (WS lifecycle, generation-guarded) and connection-level
  (`ConnectionController`: gate `transition`, `connectionGeneration`, `handshakeRetryTimer`,
  `intentionalDisconnects` — `lib/connection-controller.ts:74-86`).
- Session model = `SessionContext{sessionId, agentWindowId, refStore, borrowedTabs, agentCreatedTabs,
  observedTabs?, pendingRoutingTabs?, controlPolicy?, incognito?, remote?}` (`session-manager/manager.ts:5-28`).
  Authority predicate `isAgentControlledTab` = agentCreated ∪ borrowed ∪ observed (`:31-37`).
- No explicit session phase field on the extension side; "live" ⇔ present in `SessionManager.sessions`
  (`:146-176`) plus `expectedWindowClosures` WeakSet marking only the committed stop stage (`:158-167`).

## 5 invariants

1. **One mandatory first frame.** Fresh socket must send `system.handshake` first (`transport/handshake.ts:100`);
   no business frame may be sent before auth+handshake (`transport/ws-transport.ts:152-159`,
   `docs/architecture.md:269-280`).
2. **Stale sockets can never act.** Every WS callback checks `isCurrentSocket(socket, generation)`
   (`ws-transport.ts:200,251,256,299,336-338`); controller re-generationalizes per handshake
   (`connection-controller.ts:227-233,268,286-303`).
3. **Ownership is claimed by concrete id, never inferred from event ordering.** `tab_create` claims the id
   returned by Chrome (`tools/tabs.ts:442-444`); routing/overlay listeners explicitly never mutate ownership
   (`entrypoints/background.ts:409-420`, `session-manager/window-routing.ts:111-123`).
4. **A borrow is reserved before any awaited Chrome work** (`manager.ts:249-286`): reservation map closes the
   cross-session TOCTOU between "is it borrowed?" and the write after `tabs.move`.
5. **Destructive ordering:** return borrowed tabs → clear refs → detach CDP → close agent tabs → close/release
   window; a failed return keeps window+session alive and retryable (`tools/session.ts:188-297,302-453`).

## 3 algorithms

1. **Backoff + auth backoff unified** (`ws-transport.ts:313-327`):
   `delay = max(authBackoffUntil-now, min(1000*2^attempt, 5000))`; counter resets only on a *settled*
   auth+open (`:212-213`). Auth failure sets `authBackoffUntil = now + min(30_000*2^n, 300_000)`
   (`:221-233,282-285`); explicit retry via `resetAuthenticationBackoff()` (`:90-93`).
2. **Serialized window-routing mutations** (`window-routing.ts:201-236`): timer(100ms) → await
   `waitForTabCreation` → append to `this.mutations` promise chain (one shared promise chain ⇒ concurrent
   external links create at most one replacement user window) → `route()` re-reads tab/window/destination
   after every await (`:238-292`), retries `[250,1000,3000]ms`, then keeps the tab in `pendingRoutingTabs`
   so it is excluded from default targeting (`:224-231`, consumed in `tools/shared.ts:340-407`).
3. **Detach/attach attribution** (`session-manager/tab-moves.ts:17-63`): `run()` registers an operation only
   for cross-window moves; no timer, so a lost event cannot "expire"; ambiguity (two candidates same origin,
   or a detach no operation owns) resolves **false** and invalidates that tab's unused snapshots.

## 5 edge cases

1. Old socket's late `close` after replacement must not clear/new-disconnect the live socket — covered by
   generation check and tested (`transport/__tests__/ws-transport.test.ts:260-286`).
2. Close arriving *during* authentication: `handleClose` returns early so the authenticator settles the
   rejection itself, bounded by its 5s timer (`ws-transport.ts:238-248,298-311`).
3. A rejection response immediately followed by socket close: `onRejected` runs synchronously inside the
   message handler so the diagnosis survives the later `catch`/`disconnected`
   (`transport/handshake.ts:83-84,119-124`; `connection-controller.ts:254-265`).
4. Lone UTF-16 surrogate from split page text would make serde_json drop the whole frame → `toWellFormed`
   replacer only when `\u[dD][89a-f]` is present (`ws-transport.ts:160-165,353-355`).
5. User drags an agent tab to another window: `onDetached` → `session.ended{reason:"user_moved_tab"}`, no page
   is returned or closed, overlays/CDP released per tab (`session-manager/event-handler.ts:64-122`); the same
   event after an *expected* move is suppressed via `expectedTabMoves` (`tab-moves.ts:34-55`).

## Tests

- Unit vitest + happy-dom, all `chrome.*` injected as fakes; fake timers everywhere
  (`apps/extension/vitest.config.ts:14-25`).
- Reference transport suite: hand-rolled `FakeSocket`, exact backoff schedule assertions, auth-prelude ordering,
  30s auth backoff (`transport/__tests__/ws-transport.test.ts:7-68,199-232,341-394`).
- Controller suite pins lifecycle policy as table tests: old-daemon rejection guidance retained/replaced,
  per-endpoint reset, handshake bound to its connection (`lib/__tests__/connection-controller.test.ts:354-435,512-529`).
- Routing suite is a 30-case adversarial matrix incl. re-entrancy during destination lookup
  (`session-manager/__tests__/window-routing.test.ts:490-556`); plus `*.browser.test.ts` real-Chrome layers and
  `evals/browser/cases/**` black-box CLI cases.

## 5 adopt (BridgeDeck)

1. Socket generation guard + "settled" reset semantics; BridgeDeck `extension/src/ws-client.js:305-319` has only
   identity checks and no `wasOpen` per-socket capture ⇒ a replaced socket's close can raise `reconnecting`.
2. Exponential backoff with reset-on-success and a separate auth-failure backoff; BridgeDeck uses fixed
  `RETRY_MS = 3000` (`ws-client.js:9`).
3. Generation-scoped handshake: `handshake()` + abort signal, discard a handshake reply whose connection
   generation moved on (`connection-controller.ts:227-303`).
4. Extension-side ownership sets (agentCreated/borrowed/observed) enforced at every tool boundary
   (`tools/shared.ts:324-338,531-563`); today BridgeDeck authority lives only in daemon session records.
5. Diagnostics state: `lastError` + `daemonUpgradeRequired{daemonVersion,daemonProtocolVersion,requiredProtocolVersion}`
   kept across transport failures but cleared by a fresher rejection or endpoint change
   (`connection-controller.ts:402-419,184-190`).

## 3 reject

1. **Purge-on-disconnect session teardown** (`session-manager/disconnect-cleanup.ts:20-38` +
   `entrypoints/background.ts:601-626`). Valid only because the BSK daemon purges its registry on socket loss;
   BridgeDeck deliberately keeps sessions (`daemon/server.mjs:790-810` `markSessionDisconnected`) and rebinds on
   reconnect — copying this would destroy user tasks on every WS flap.
2. **Needing a new port scan per reconnect** (`transport/ws-transport.ts:74`, one configured URL). BSK binds one
   port; BridgeDeck's 10-port probe (`ws-client.js:6,185-206`) is fine but its latency (10×2.5s) must not become
   the reconnect unit.
3. `version_skew` as a *state* is redundant; BridgeDeck keeps skew as data (`protocolSkew`, `ws-client.js:401`).
   Also reject BSK's app-semver floor `min_compatible_peer` (deprecated, `handshake.ts:28-32`) — keep only a
   numeric protocol floor.

## 5 gaps (BridgeDeck, concrete)

1. No extension-side tab ownership / remote-authorization gate; no equivalent of
   `resolveTargetTab`/`enforceAgentWindow`, so any daemon `cmd` with a `tabId` is honored.
2. No borrow reservation ⇒ cross-session double-borrow race (BSK closes it in `manager.ts:255-286`).
3. No popup/observed-tab concept (non-destructive authority + preserved on stop) or routing of unrelated tabs
   out of the agent window (`window-routing.ts`, `task-popups.ts:5-6,102-136`).
4. `cancel` is a flag checked between steps (`extension/src/command-cancel.js:1-25`) — no per-RPC
   `AbortController` registry, no `cancelled` reply, no dialog cleanup on cancel
   (BSK: `tools/dispatcher.ts:325-353,207`, `browser-driver/command-deadline.ts:110-160`).
5. No per-session UI budget/teardown guard; BSK bounds focus/preview at 3s and gives in-flight Chrome
   mutations a 1s grace before continuing cleanup (`session-manager/ui-activity.ts:48-116,120-159`).
