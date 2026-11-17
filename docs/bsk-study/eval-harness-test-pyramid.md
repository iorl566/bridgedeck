# BSK 0.5.0 — test pyramid, deterministic browser harness, eval corpus, flake/cancel control

BSK root: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`; paths below are relative to it (else relative to `D:/浏览器桥`).
Nothing in the BSK checkout was modified.

## Core model

One case format with three consumers. `evals/browser/schemas/case.schema.json` + `lib/case-loader.mjs:156-234` turn a
manifest `{id,suite,tags,seed,fixture.startPath,coverage,assertions{site,response,adapter},smoke.steps[]}` into a frozen case
that is at once (a) a localised agent prompt, (b) a declarative CLI smoke script, (c) an oracle triple;
`lib/repository-validation.mjs:15-48` proves suite==directory, every `{var}` is defined before use, and every adapter assertion
has an evidence producer. Suites are cost lanes: `core` (6) is the default for smoke/run-agent, then `matrix` (seeded),
`regression`, `stress`, `manual` (`cli.mjs:87-128`, README:100-119).

Verdicts are tri-state, and that is the whole point: site events counted to `minCount`, response substring, adapter fact
present/absent → `failed` / `passed-with-unverified` / `passed` (`lib/oracle.mjs:12-62`); `lib/summary.mjs:40-58` keeps
`passRate` and `fullyVerifiedRate` apart so "we could not observe it" never renders green. Cleanup evidence is derived:
`sessionStopped` is true only when `stopped[]` contains the id and `failed[]` is empty (`lib/bsk-runner.mjs:334-348`). Events
are run-scoped: `lib/server.mjs` is a localhost fixture server with a `runId`-keyed append-only log (:44-60), per-run reset,
64 KiB body cap (:27-36); the injected `browserEval.send` posts `keepalive:true` so unload/bfcache events still arrive
(`lib/fixtures.mjs:22-44`).

Under it: the dispatch state machine (`crates/bsk-cli/src/daemon/queue.rs`) — per-session serial queue with `QueueState{busy,active}`
(:208-212), errors `SessionNotFound{ended}/SessionStopping/SessionBusy/QueueFull/QueueClosed/Timeout/Rpc` (:107-142), capacity 64
(:59), `CANCEL_CLEANUP_TIMEOUT 2s` (:66-69). Extension machines are tested separately: capture terminal errors
(`tools/vom/capture-abort.ts:17-26`), CDP deadline classes + per-tab read gate (`command-deadline.ts:10-27,110-160`), frame graph.

## 5 invariants

1. **Unclassifiable cases never run** — duplicate ids, unknown keys/actions, non-kebab ids, suite≠dir, undefined template
   vars, orphan adapter assertions (`lib/case-loader.mjs:156-222`; `lib/repository-validation.mjs:15-48`), and every command
   path calls `loadValidatedCorpus` first (`cli.mjs:141-146`).
2. **Receipts are explicit data** — `sync` returns receipts and accepts none, `observationId` requires `contextId`
   (`case.schema.json:93-104`); the runner carries only what a step names (`bsk-runner.mjs:150`) and a rejected action is never
   retried with a newer implicit receipt (`tests/control-workflow.test.mjs:114-137`).
3. **Cleanup on every outcome** — try/finally stop with a 90 s budget, `sessionStopped` recorded, original `executionError`
   preserved (`bsk-runner.mjs:324-348`); failure paths still assert `sessionStopped===true` (`tests/readiness-workflow.test.mjs:120-133`).
4. **A timeout ends the caller's wait, not Chrome's work** — `CdpReadGate` refuses new guarded reads until the original settles
   or its session detaches; caller abort marks the read still-pending (`command-deadline.ts:6-9,108-160`).
5. **Never touch the user's browser/daemon** — mkdtemp profile + `BSK_HOME`, `BSK_AUTO_START=0`, and an assertion that the
   built `background.js` contains the private port (`cooperation/run.mjs:36-52`; `element-waits/run.mjs:16-24`).

## 3 algorithms

1. **Seeded dimensions** — FNV-1a → mulberry32 → `{labelMode,nestingDepth,hydrationDelayMs,decoy,fieldOrder,idSuffix}`; the
   fixture re-derives from `?seed=`, so a badcase replays exactly (`lib/seeded-generator.mjs:1-39`;
   `fixtures/pages/generated-form.fixture.mjs:36-58`), and every normalized seed is stored in the report (`cli.mjs:328`).
2. **Deadline taxonomy + gate** — method sets map to 10 s read / 20 s capture / 1 s AX-cleanup / unbounded mutations
   (`command-deadline.ts:10-27,186-198`); the gate keys the blocker by `(tabId, sessionId|root)`, blocks only `GUARDED_READS`,
   unblocks on settle, never on caller timeout (:110-160).
3. **Native input clock** — ≥3 probes, intersect `[eventTs-after-ts+wall±0.25, …+1]`, midpoint = epoch↔TimeTicks offset,
   `sameClock` before and after, `assertValid()` as the synchronous fence before dispatch (`browser-driver/native-input-clock.ts:54-201`).

## 5 edge cases

- `Target.closeTarget` is acked before Chrome removes the tab → poll tab inventory, do not retry the behaviour under test
  (`cooperation/run.mjs:869-878`).
- A timed-out read may later **resolve or reject**; both must be swallowed with no `unhandledRejection` and no pending timer
  (`browser-driver/__tests__/command-deadline.test.ts:38,52-101`), even after attachment replacement (:218-252).
- Emulation must be applied to the blank tab before navigation and reject wrong width / wrong height / no event while still
  closing the session (`tests/readiness-workflow.test.mjs:70-133`).
- A tab moved into the user's own window ends the session but the page survives; a human-held session must not be idle-reaped
  (`cooperation/lifetime.mjs:85-149`).
- SIGINT mid-flight must deliver the effect that already happened (`action.result.delivered===true`, exit 2, `cancelled=true`),
  send exactly one cancel as the last RPC, and never redispatch (`crates/bsk-cli/tests/step_cancel.rs:117-133`).

## Tests

- L0 harness unit, no browser: `evals/browser/tests/*.mjs` (7 files) — oracle tri-state, manifest rejection matrix, event
  record/reset, runId length, seed reproducibility, scaffold escaping, CLI JSON surface.
- L0.5 deterministic workflow: injectable `executeProcess` + `node:test` mock timers pin command order, the 750 ms event
  boundary and the runner's 350 ms grace (`tests/readiness-workflow.test.mjs:13-68`); page scripts run in `node:vm` with stubbed
  layout (`tests/oopif-readiness.test.mjs:15-58`).
- L1 extension unit: 236 `*.test.ts` + 19 `*.test.tsx`, of which 46 are `*.browser.test.ts` — ~3.56 MB tests vs 3.01 MB
  non-test source, happy-dom (`apps/extension/vitest.config.ts:14-21`). L2 browser tests are env-var opt-in + `describe.skipIf`,
  own profile, real CDP behind a fake `chrome.debugger` (`tools/__tests__/download-deadline.browser.test.ts:15-82`).
- L3 standalone regressions: `cases/regression/*/run.mjs` (cooperation, video, dialogs, drag, waits, fill-editor, oopif,
  coordinates) — real CLI+daemon+extension, each with a README assertion table.
- L4 corpus 30 operations with 3 named manual lanes (`lib/operations.mjs:27-34`); L5 optional agent-run release audit (111
  scenarios) with a sha256 evidence ledger and gate (`release_audit.py`; `references/evidence-contract.md:7,104-106`).
- Rust: ~60 integration binaries, one property each, over a fake-extension WS with condition-based waits
  (`crates/bsk-cli/tests/support/mod.rs:16-33`). CI: 10 jobs by risk/platform; six browser jobs set `BSK_*_CHROME` plus
  `if: always()` artifacts (`.github/workflows/ci.yml:242-462`).

## 5 adopt (BridgeDeck)

1. **Case model + tri-state oracle** as `tests/eval/**/*.case.json` (site/response/adapter). `tools/e2e.mjs:78-82` records skip
   as `ok:true`, so "not tested" currently becomes "passed".
2. **`withChrome` harness** (`cases/regression/snapshot-coordinates/chrome.mjs:25-137`): mkdtemp profile,
   `--remote-debugging-port=0` + parse "DevTools listening on", per-command CDP deadline, reject-all-pending, SIGTERM→SIGKILL,
   `rm` with retries; env-gated so `node --test tests/unit` stays browser-free.
3. **Condition waits + fake timers**: `waitUntil(label,…)` that panics with the label (`support/mod.rs:16-33`), `poll()` at
   80-100 ms to a deadline; replace raw sleeps in `tests/unit/session-queue.test.mjs:9,23`, `command-deadline.test.mjs:15`,
   `debugger-attach.test.mjs:10`, `tools/e2e.mjs:76`.
4. **Run-scoped event channel** (`lib/server.mjs`, `lib/fixtures.mjs:22-77`, `keepalive:true`, stable markers) so assertions read
   page events instead of re-querying the DOM through the CLI.
5. **Read gate + terminal-error taxonomy** in `extension/src/command-deadline.js` (today one `createDeadline` → `E_TIMEOUT`;
   1.8 KB of tests vs BSK's 288-line matrix): per-method classes, per-(tab,session) block after a timeout, fallback stop.

## 3 reject

1. **Rust+TS double implementation** (`queue.rs` + ~60 Rust binaries mirrored by ~255 TS tests). BridgeDeck is single-language:
   spend that budget on one browser-capable lane.
2. **Monolithic imperative runners** (`cooperation/run.mjs` 944 lines + 28 KB helpers) as the way to add coverage — they contradict
   the corpus README's own "adding a case needs no central switch" (README.md:5).
3. **"Optional, not a required check" for a 111-scenario suite** (`SKILL.md:8-10`) and the 8 s accelerated session-idle clock
   (`cooperation/run.mjs:171-175`): a skippable suite, or a product timer changed to make tests fast, cannot gate.

## 5 gaps (BridgeDeck)

1. **No browser in CI**: `.github/workflows/ci.yml` is 11 node steps × 3 OSes, zero Chrome/xvfb — yet `npm test` ends with
   `node tools/e2e.mjs` (`package.json:40`), so the only real-browser test runs on laptops, never on a PR.
2. **No case/oracle layer**: assertions live in `tests/cli/selftest.mjs` (47 KB) and `tools/e2e.mjs` (2571 lines); no
   suites/tags/seed, no `passed-with-unverified`, so coverage cannot be counted or filtered.
3. **No read-gate/deadline taxonomy** and the hard cases are untested: late resolve, late reject, attachment replacement,
   child-session isolation (`tests/unit/browser-command-deadline.test.mjs` is 1.8 KB).
4. **No dispatch-observable `session_busy`**: `lib/session-queue.mjs` collapses the one-active-command case into `E_QUEUE_FULL`
   (`tests/unit/session-queue.test.mjs:21-27`), and nothing asserts two sessions on one browser do not block each other.
5. **No seeded fixtures, evidence ledger, manual-lane inventory or flake policy** — and `tests/extension/mock-daemon.mjs:25` binds
   the production probe band 52900-52909 that `tools/e2e.mjs:93` explicitly avoids; resolve that before adding a browser lane.
