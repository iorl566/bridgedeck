# BSK 0.5.0 — shared control, human/agent state machine, borrow, marker, suppression, passthrough

BSK root `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`; paths below are relative to `apps/extension/src`.
BridgeDeck paths are relative to `D:/浏览器桥`.

## Core model

Three independent authorities must agree; a single "agent in control" flag is not enough.

**Ownership.** `CooperationController` keeps `TabState` with four counters that are never bumped together
(`cooperation/controller.ts:115, 357-375, 620-631, 686-687, 767-769`): `authorityRevision` (revokes guards on human
intervention), `controlRevision` (hold/resume ordering), `epoch` (observation validity), `frameEpoch` (frame set).
Counter *inequality* refuses an action, so a stale closure cannot re-acquire permission.

**Freshness.** Two artifacts per tab: `Context` = action ticket `{id, epoch, frameEpoch, refs, frames, evidence,
observationId, consumed, held}` (`controller.ts:59-71, 1019-1044`) and `baseline` = last full observation for deltas,
target policy only (`:1046`). Strict policy consumes the context on use (`:2127-2139, 2234-2235`); target policy spans
one context id over many single-use observation ids. Page identity is a random uuid per document
(`content/cooperation-capture.ts:57, 424-432`), so "same page" ≠ same URL.

**Human authority.** The collector publishes facts only (`cooperation/types.ts:1, 62-94`): `document`, monotonic
`revision/structure/textual/human`, `lastInput`, gesture flags `busy` (drag, IME+editing, pressed pointer, human key
held), `pending` (unconfirmed pointerdown, IME composition, unconfirmed input), `scrolling`, `editing` lease, `focus`,
`media`, `fields`, bounded `events` (128) / `texts` (64) logs. Human vs agent is provenance, not a timer: before each
native dispatch the background arms `InputExpectation {type,x,y,key,keypress,timestamp,text,id}` (`types.ts:1-14`;
`cooperation/action-guard.ts:88-105`) and the collector matches type + calibrated time window (±1.5 ms) + key equality,
or coords within 2 px in the top frame only (`content/cooperation-capture.ts:24, 549-584`). Anything trusted that does
not match is human.

**Derived UI.** Mode is never stored: `unavailable > yielding > held > human > acting > ready > syncing`
(`controller.ts:486-509`); the target marker is published only while `!held && !humanActive` (`:490`, expiry `:2255`).
Overlay chrome is a separate reducer: `controlVisible = activeSessionId && controlMode==='control'`, and
`shouldShowAgentControlOverlay` also requires no help/record overlay and not `suppressControlAfterRecord`
(`content/overlay-controller.ts:58-60, 171-179`).

**Consent.** Borrow = fail-closed approval *then* a physical move with a reservation and rollback
(`tools/tabs.ts:989-1103, 1140-1171`); help is a context-free request/ack/cancel/finish machine with re-arm and
completion polling (`tools/human-loop.ts:166-199, 424-464, 608-714`).

## Invariants

1. Attribution is deny-by-default: agent iff type matches AND `event.timeStamp` is in the armed window (or within 1.5 ms of the epoch projection) AND key matches / coords within 2 px in the top
   frame; every miss records an `attribution` diagnostic and counts as human (`content/cooperation-capture.ts:549-584, 967-1000`).
2. Human input revokes permanently: `human` advance, or a fresh event with `now-lastInput < QUIET_MS(2000)`, ⇒ `preserve()` + `authorityRevision++` + `epoch++` + `context=undefined` + abort of the
   in-flight signal (`controller.ts:149, 609-631, 748-764`).
3. A control guard never reads the renderer or an observation; it is created before async prep and called synchronously at the native effect boundary, and once revoked it is unusable
   (`cooperation/control-authority.ts:1-9`; `controller.ts:357-375`).
4. Only the pristine agent-created `about:blank` may act before the first sync; supplying `expect/observation_id/depends_on` there is `invalid_params` (`controller.ts:1575-1588, 1140-1204`).
5. Effect honesty + never replay: `effect_state` is `unknown` iff something may have reached the page, with `press_sent:false` when a click only prepared, and every refusal carries a "never replay"
   recovery string (`controller.ts:1722-1725, 2387-2461, 269-324`).

## Algorithms

1. **Clock-calibrated attribution** (`browser-driver/native-input-clock.ts:48-201` + `action-guard.ts:139-160`): sample `performance.now()/Date.now()` only when the span ≤0.5 ms, intersect ≥3
   trusted in-extension probe events to recover the epoch→TimeTicks offset, return `nativeTimestamp` plus `assertValid()` re-checked at dispatch. The renderer builds the accept window in
   `cooperation-capture.ts:967-1000`; if no usable sample exists the read returns undefined and the expectation is cleared, so dispatch waits instead of inventing human activity.
2. **`guardedRunner` dispatch fence** (`action-guard.ts:47-227`): Proxy the CdpRunner, classify methods into effect/preparation/release, `prepare()` before any effect, synchronous `onDispatch`
   re-check, per-gesture leases keyed `tab:session:mouse:<button>|key:<key>|drag|focus|chooser` released only by the matching release; a clock error retires an owned key via `keyUp`/detach;
   `resourceCleanup` limited to `Runtime.callFunctionOn|releaseObjectGroup`.
3. **Sync delta tree** (`controller.ts:898-1120` + `cooperation/text-delta.ts:144-214`): `comparable` = same frameEpoch, complete fields, same refs revision, same media; `exact` adds
   revision/structure/focus. Otherwise patch held text only if the frame logged pure text replacements (structure−textual delta, no human, no field/ref change, no `textFloor` gap, unique unambiguous
   text, no truncation/token shift); reply `kind: baseline|delta|unchanged` + `baseline_reason`.

## Edge cases

1. Window blur mid-gesture clears pointer/drag/IME/keys/editing and publishes, so a lost pointerup cannot leave the page `busy` forever (`cooperation-capture.ts:867-895`).
2. An SPA route change (`location.href` differs) mints a new document uuid inside the collector — action authority dies without any navigation event (`:424-432`).
3. Body/html focus counts as "document focus" only without tabindex/role/contenteditable, keeping a key press with no resolved recipient on the strict whole-page check (`:442-444`;
   `controller.ts:1944-1967`).
4. Frozen/background page: passthrough leases expire by wall clock inside `apply()` on remount, and capture hide acks via a 500 ms fallback when rAF never fires
   (`content/input-passthrough.ts:16-22`; `content/capture-suppress.ts:22-41`).
5. Borrowed/blank pages: bootstrap is allowed on `about:blank`/new-tab URLs, and `tab_return` still works for a blocked/failed root document but never while a `pendingUrl` navigation is in flight
   (`controller.ts:163-202, 1208-1250`).

## Tests

1. Injected seams: `attachCooperation` closes over `readFrames/resumeFrames/releaseFrames` plus an injectable `now` (`controller.ts:129-148, 332-334`; `cooperation/browser-bridge.ts:229-253`), so
   quiet windows and TTLs use fake clocks.
2. `cooperation/controller.test.ts` (~100 cases, 145 KB): renderer-independent authority, one context never admits two actions, late hand-back cannot override a newer hold, mid-action stop =
   `user_aborted` + unknown effects.
3. `cooperation/target-policy.test.ts` (~60): `effect_state`/`press_sent`, no silent upgrade of a strict baseline, one-shot observation, bounded wait for a disabled target, push-based human input
   aborts internal targeted steps.
4. `content/__tests__/input-passthrough.test.ts`: synchronous ack without rAF, per-id counting, remount re-apply, TTL expiry of a lost `end`, frozen-page remount, no timer leaks.
5. Real-browser suites: `cooperation/live-text.browser.test.ts`, `hidden-frames.browser.test.ts`, `click.browser.test.ts` (exact overlay-bypass sequences, e.g. `[true,false,true,false]` in
   `tools/__tests__/download-lifecycle.test.ts:362`).
6. Eval harness drives a **second CDP connection as the person** and asserts application state independently plus `activity.length === 0` for agent input
   (`evals/browser/cases/regression/cooperation/intent-signals.mjs:4-72`).

## Adopt (BridgeDeck)

1. Clock-calibrated `InputExpectation` arming per native dispatch, replacing the grace windows in `extension/content/human-watch.js:76-79` and `extension/content/cooperation.js:150-152`; a failed
   calibration must refuse the dispatch.
2. `FrameState` counters (document uuid, revision/structure/textual/human, busy/pending/scrolling/editing, fields, bounded events) instead of `readState()`
   (`extension/content/cooperation.js:200-244`), plus immediate push on a confirmed human event with 60 ms debounce elsewhere (`cooperation-capture.ts:159-171, 585-608`).
3. `authorityRevision` + a guard re-checked inside `onDispatch`, not the single pre-dispatch check in `extension/src/control.js:139-171`.
4. Attribute-driven, ref-counted capture suppression that acks after 2 rAF (500 ms cap) and re-applies on host remount (`content/capture-suppress.ts`; `content/overlay.css:29-34`), replacing
   `executeScript` + `visibility:hidden` + 80 ms sleep and the registry gate (`extension/src/overlay-suppress.js:18-67`).
5. Per-click passthrough ids + pre-press `elementFromPoint` re-probe with `input_not_ready` / `input_outcome_unknown` (`content/input-passthrough.ts`; `tools/click-overlay.ts`), replacing the single
   tab-level token (`extension/src/dispatch.js:367-405`).

## Reject (BridgeDeck)

1. Do not port the 2476-line `run()` with ~15 mutable action flags and `req.params` reassignment (`controller.ts:1366-2475`) as-is; keep the invariants, model the per-action lifecycle explicitly.
2. Do not port learned volatile-text tolerance (`controller.ts:1922-2049`) yet — tolerating a real change in a card sharing a container with a clock is worse than the extra capture; add it after
   counters + evidence scoping.
3. Do not copy the borrow *move-into-Agent-Window* requirement (`tools/tabs.ts:1061-1100`); BridgeDeck's in-place borrow (`extension/src/tabs.js:840-924`) removes the whole original-window/index
   rollback class.

## Gaps

1. No native clock or per-input expectation anywhere (no `prepareInputTimestamp` equivalent), so human input during an agent step is either attributed to the agent or lost.
2. No monotonic human counter or per-frame document identity: `extension/src/human-state.js` keeps one snapshot per tab and `cooperate.wait` compares `lastInputAt` only
   (`extension/src/control.js:121-135`) — an in-progress drag has no events and cannot hold control, and an edit lease cannot be expressed.
3. Nothing cancels a prepared click when human input arrives mid-preparation; `track/untrack` only opens passthrough (`extension/src/dispatch.js:390-406`), contrast `controller.ts:1817-1866,
   2243-2291`.
4. Suppression is gated on an in-memory overlay registry that is empty after an SW restart while the card is still on the page (`extension/src/overlay-state.js:21-34`;
   `extension/src/overlay-suppress.js:45-47`); BSK keeps the flag in the page and re-applies it on mount.
5. `cooperate.sync` writes global per-tab `contextId/observationId` with no candidate store and no "another sync won" refusal (`extension/src/control.js:15, 76-80`), so concurrent syncs can mint a
   context that was never observed (contrast `cooperation/policy-negotiation.test.ts:304-376`).
