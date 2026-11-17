# BSK 0.5.0 — DSH plugin subsystem: tools, lifecycle, package boundaries, release artifacts

Source studied: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/packages/dsh-plugin-browserskill/**`,
`scripts/check-dsh-package.mjs`, `scripts/validate-skill.mjs`, `install.ps1|sh`, `.github/workflows/*`.
All BSK paths below are relative to that root; no BSK file was modified.

## Core model

Two planes. **Model plane**: exactly six public tools (`src/tool-names.json`: `bsk_session`,
`_page`, `_inspect`, `_interact`, `_tabs`, `_assist`; `bsk_recipe` opt-in). Each is a *router*:
`browser-tools.ts:91-155` forwards parameters/render/isConcurrencySafe/execute/presentCall/
presentResult/finalizeContent to a private operation (`session.start`, `interact.step`, …) keyed by
an action table (`browser-tools.ts:193-548`), then injects `contextId/dependsOn/observationId/expect`
into exec. The ~40 operations are built by `defineBrowserOperations` (`tools.ts:223-1284`) through an
injected collector and are **never** registered on `ctx.tools`.

**Process plane**: every action is one `bsk <cmd> --json` child (`runner.ts:110-324`) →
`{code,stdout,stderr,timedOut,aborted}` → payload or `BskError{code,hint,exitCode,data}` (`runner.ts:626-708`).
Four stateful services sit on top: `SessionRegistry` (ownership + MRU current pointer + capacity
reservations, `sessions.ts`), `SessionStarts` + `StartJournal` (write-ahead starts, stop receipts,
background reconciliation, `session-starts.ts`/`start-journal.ts`), `KeyedExecutor` (one FIFO per
session, `queue.ts`), `ObservationService` + SSE routes for the web UI (`observation.ts`,
`observation-http.ts`).

States: registry `starting→active→cleanup`; CLI request `prepared→ready→active→cancelling→closed/failed`;
durable record `{requestId, owners, cleanup, stop: pending|closed, defaultStopRevision, session}`.
A session's identity is `(sessionId, browserInstanceId)` **plus** `requestId`, because Chromium reuses
short session ids. Scope is closed-world: the daemon may be shared, so foreign ids are rejected, never
adopted (`sessions.ts:1-14, 215-248`).

## 5 invariants

1. **Closed-world ownership.** Only plugin-created sessions are listable/resolvable/interruptible;
   a foreign `session` argument is an error (`sessions.ts:202-248`; `dispose.test.ts:101-104`).
2. **Reserve before spawn.** `sessions.size + pendingStarts + recoveredPending >= maxSessions` throws
   synchronously before any process exists (`sessions.ts:52-60`; recovered journaled requests count —
   `session-starts.ts:62-66`).
3. **Durable intent before side effect.** `begin()` persists the record; a failed save forgets it and
   rethrows, so no process is spawned (`session-starts.ts:75-81`; test `session-starts.test.ts:284`).
   Symmetrically, an explicit stop that cannot persist its intent is rejected whole, leaving the
   session usable (`session-starts.ts:241-265`).
4. **Publication is last and single-shot.** A session becomes current/usable only after
   prepare+start+register+claim; `activate()` throws unless `state==='starting'`
   (`session-starts.ts:144-158`; `sessions.ts:90-96`).
5. **One shared cleanup job per requestId, caller abort only detaches.** `cleaning` map published
   before observation callbacks; tool/overlay/archive/reconcile all join it (`session-starts.ts:284-296,
   437-459`). Composite (step/plan/recipe) results are never retried and never discarded by a late
   abort (`tools.ts:154-158`; `runner.ts:252-260, 649-654`).

## 3 algorithms

1. **Exit/close drain ladder** (`runner.ts:186-295`). On `exit`: clear timer; finish immediately if
   killed by signal / timed out / (aborted && !composite); else `beginDrain` = 1000 ms sliding window
   restarted by every chunk + 2000 ms absolute cap, then flush `StringDecoder`, clear all timers,
   destroy stdin/stdout/stderr and `unref`. Kill path: Windows sends stdin EOF with
   `BSK_CANCEL_ON_STDIN_CLOSE=1` (Node's SIGINT is a hard kill there), elsewhere SIGINT → SIGKILL at
   `killGraceMs` (3000; 15000 on win32) → settle deadline grace+1000 ms (`runner.ts:88-130, 228-238`).
   Reason: the auto-spawned daemon inherits the pipes on Windows, so `close` may never fire (#180).
2. **Receipt validation by exit-code derivation** (`runner.ts:451-602`). A step/plan/recipe payload is
   accepted only if the expected exit code and phase derived from the payload equal the real exit code
   and `ok === (expectedExit===0)`: max of stage error codes, 4 for `reached:"timeout"`, 1 for
   `readiness.satisfied===false` or `post` lacking `context_id`, 2 when cancelled or `storage_error`.
   Plans add `completed<=total<=20`, `stopped.index===completed`, `not_run` exactly the remaining
   indices. An aborted composite must say `cancelled:true`, else it is treated as partial.
3. **Write-ahead owner ledger** (`start-journal.ts:44-157`). Scope dir = `sha256(cwd,bskPath)[:24]`
   under `$BSK_HOME/dsh-starts`; per-owner `<pid>-<uuid>` dir; save = tmp(0600)→write→fsync→rename
   (+dir fsync off Windows). `recover()` skips live pids (`process.kill(pid,0)`; ESRCH ⇒ dead) and
   owners in a `Symbol.for` process-wide set, **claims a stale dir by atomic rename**, validates each
   record, reconstructs `cleanup = stop !== 'closed'`, and recurses into nested `recovered-*` dirs.

## 5 edge cases

1. **Windows pipe inheritance** — `bsk` exits but the daemon still holds the stdio handles, so `close`
   never arrives; without the drain window the tool call hangs forever (`runner.ts:88-101`;
   `runner-exit.test.ts:41-76`).
2. **Short session-id reuse** — a completed stop receipt for id X must not be applied to a new session
   that later gets X; resolution prefers the receipt and is keyed by requestId
   (`session-starts.ts:204-239`; `session-stops.test.ts:412`).
3. **Late replies after a concurrent stop/archive** — `prepare()` must not forget a record an
   independently accepted stop owns; a late `claim()` must fail, not resurrect
   (`session-starts.ts:96-102`; test `:71`).
4. **Abort while draining vs. composite already exited 0** — explicit abort must settle at once and
   destroy pipes; a composite that exited 0 must keep draining its receipt (`runner.ts:252-260, 286-295`).
5. **Foreground thumbnail preemption is not unavailability** — `capturePreempted` keeps preempted
   captures out of the failure/backoff counters, and a `not_found` capture reaps both stores
   (`observation.ts:452-467, 478-487`).

## Tests

`apply(ctx,cfg,{runnerFactory,startJournal})` seams make every test process-free (`index.ts:72-76`).
The highest-value pattern is `DrainingChild` — real `PassThrough` stdio on an EventEmitter with
independent `exit`/`close`, fake timers, and `process.platform` swapped to run the whole matrix twice;
every case ends with `vi.getTimerCount()===0` (`runner-exit.test.ts:8-33`). Lifecycle tests are named
as behaviours ("publishes a session only after both initialization and claim succeed",
"does not cancel a new session that reuses a completed stop's short ID" —
`session-starts.test.ts`, `session-stops.test.ts`). Registration/rollback and unload-ownership tests
cover every public name (`tool-registration.test.ts:31-128`, `dispose.test.ts`). Identity and host
admission are data-driven (`plugin-id.test.ts`, `host-compatibility.test.ts:14-41`). Distribution is
tested on the **real artifact**: `check-dsh-package.mjs` does `npm pack`, extracts, byte-compares the
packed skill tree, then imports the packed `lib/index.mjs` from an unrelated cwd with a fake ctx.

## 5 adopt

1. Router + private-operation split (`browser-tools.ts:91-155`) so BridgeDeck keeps ~10 schemas while
   moving per-action validation out of the flat spec list in `dsh-plugin/lib/tools.mjs`.
2. Lazy reveal gated on `tools/post-execute` (block on failure) + `agent/inbox/claimed` for the same
   request assembly + durable-history restore (`lazy-tools.ts:188-443`); BridgeDeck registers eagerly
   and warns on failure (`dsh-plugin/lib/index.mjs:79-100`).
3. Port the runner (`runner.ts:110-324`): StringDecoder, drain window, stdin-EOF cancellation, grace/
   SIGKILL/settle, per-tag `killFor`, receipt-preserving abort. `dsh-plugin/lib/bridge.mjs:108-157`
   rejects instantly and parses only the last JSON line.
4. `KeyedExecutor` per session + one `session_busy` retry (`queue.ts`; `runner.ts:336-364`) — BridgeDeck
   has no per-session serialization.
5. Ownership/lifecycle layer: registry with current pointer + cap, explicit-stop receipts with revision
   guard (`session-starts.ts:160-239`), and the journal layout of `start-journal.ts:44-157`.

## 3 reject

1. Internal dotted operation names (`session.cooperate.enable`, `assist.dialog-status`) plus the
   missing/reachable cross-check (`browser-tools.ts:554-580`) — they are never registered; use a plain
   `{action→handler}` table.
2. Unbounded stdout accumulation (`runner.ts:172-179`) and error messages built by string concatenation
   (`(hint: …)` + JSON blob, `runner.ts:686-698`); keep code/hint/data structured and cap bytes.
3. Env-var feature doors (`process.env.BSK_RECIPES`, `index.ts:92`) and the pnpm `packageExtensions`
   monkey-patch (`pnpm-workspace.yaml:9-30`); BridgeDeck is dependency-free by design.

## 5 gaps (in BridgeDeck, plus BSK overflow to avoid)

1. No session registry/cap/current-pointer and no prepare+claim handshake — `dsh-plugin/lib/tools.mjs:181-195`.
2. No grace/settle/per-tag kill and no external interrupt path; `bridge.mjs:116-123` loses partial output.
3. No lazy tools and no activation-failure retry; a broken CLI still advertises the full catalogue.
4. No composite/partial-result validation before the model sees it (plan/step/recipe in BridgeDeck's CLI).
5. Release artifact unverified and version-inconsistent: `release-dsh-plugin.yml:30` reads the ROOT
   `package.json` while zipping `dsh-plugin/`, runs no tests first, and never loads/checks the zip.
   Also `name='browser-bridge-tools'` ≠ package name `dsh-browser-bridge` — exactly what
   `plugin-id.test.ts` guards. BSK overflow not to inherit: long work is not backgrounded via
   `ctx.jobs` (`docs/development.md:172-173`), frames are process-memory only, and no output-size cap.
