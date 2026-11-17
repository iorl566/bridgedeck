# BSK 0.5.0 — CDP attachment, focus/visibility, frame graph, target selection, cleanup

Source root: `D:/浏览器桥/ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/` (all paths below are relative to it).
Target of the study: BridgeDeck (`D:/浏览器桥`). Studied code: `apps/extension/src/browser-driver/*`, `apps/extension/src/tools/{shared,tabs,window,frame-geometry,focus-state,navigation,input-readiness,element-geometry}.ts`, `tools/geometry/frame-context.ts`, `session-manager/manager.ts`, `evals/browser/`.

## Core model
Four orthogonal registries per tab inside one driver class (`browser-driver/chromium-cdp.ts:280-342`):

- **Attachment identity**: `attachmentIds` (opaque UUID per *real* connection) + `attachmentVersions` (monotonic fence bumped on every detach/soft-detach) + `attachInFlight`/`detachInFlight` coalescing maps. Identity answers "is my connection still live?"; the version answers "did a release happen while I awaited?".
- **Soft-detach state**: `softDetachedTabs`, `softDetachedDocSignatures` (`RootDocumentSignature` = frameId/loaderId/url/urlFragment + DOM `backendNodeId`/documentElement id/documentURL, `chromium-cdp.ts:211-221`), `softDetachedAttachmentIds`, `softDetachedFrameSessions` (`ChildFrameSignature`, `228-234`), `remappedChildSessions` (old→new sessionId chaining, cap 256, `274`).
- **Frame discovery**: one `FrameDiscoveryState` per tab — `sessions`, `pending` attach tasks, `generation`, `enabled` per (session|root), `frameIds` sessionId→frameId (`156-163`); drives `Target.setAutoAttach` and `buildFrameGraph`.
- **Ownership**: `tabOwners` (tab→sessionIds), `claimAttempts` (opaque claim token per session+tab), delegating focus/visibility to `BackgroundExecution` (`background-execution.ts:1-91`).
- **Frame graph** (`frame-graph.ts:1-144`): flat `CdpFrame[]` in discovery order, each frame naming the `CdpTarget{tabId,sessionId}` that can address it, plus `unavailableFrames` as explicit *gaps* (`omitFrameSubtrees`, `21-54`).
- **Two coordinates per gesture**: `actionPoint` (top viewport, root-target input) vs `targetActionPoint` (OOPIF-local viewport, session-target input) — `tools/frame-geometry.ts:26-35,196-211`.
- **Scoping** (`tools/shared.ts`): tools only see `CdpRunner` (`65-133`); target scope is a function of effect — `passive_read` may read user tabs locally, any input/mutation must be inside the session's Agent Window (`436,552-564`). Control is a set union `agentCreatedTabs ∪ borrowedTabs ∪ observedTabs`, with `pendingRoutingTabs` deliberately excluded (`session-manager/manager.ts:31-37`, `shared.ts:340-342`).

## Five invariants
1. **Attach coalesces and rolls back.** Concurrent `ensureAttached` share one `attachInFlight` (`chromium-cdp.ts:480-490,615-616`); a domain-enable failure after raw attach must `api.detach` itself or the tab is stuck on "Another debugger is already attached" forever (`563-601`).
2. **Attachment identity only changes across real reconnects.** Reattach after idle soft-detach reuses the old `attachmentId` iff the root-document signature matches, else rotates a UUID and fires `onDocumentChanged` (`505-506,526-546`; test `__tests__/chromium-cdp.test.ts:370`).
3. **A timed-out read is not cancelled.** It keeps the read gate closed per (tab, session) until Chrome settles it or that session detaches (`command-deadline.ts:108-160`; reset from `Target.detachedFromTarget`, `chromium-cdp.ts:1684`). Guarded reads then refuse instead of queueing.
4. **Topology before measurement.** Ancestry/ownership first, scroll frame owners deepest-first, only then read box models and project (`frame-geometry.ts:129-157`). An OOPIF address without `frameId`, or a frame that belongs to another target key, is rejected (`73-83,122-134`).
5. **Focus is a lease, input needs proven visibility.** Only an owning session may change focus emulation, applied state is keyed by attachment identity, and input must first establish visibility (sample → restore/install override → re-sample → 2 rAF) — `background-execution.ts:52-90`, `tools/input-readiness.ts:173-259`. Cleanup is attachment-fenced: a timed-out disable detaches that attachment (`input-readiness.ts:204-214`).

## Three algorithms
1. **Reattach with signature continuity** (`chromium-cdp.ts:477-618`): await in-flight detach → snapshot version/wasSoftDetached/prevDocSig/prevAttachmentId/prevChildFrames → attach → `Page.enable` bounded by `READ_TIMEOUT_MS` (hang ⇒ "close any open browser dialog", `513-521`) → best-effort `Network.enable` → if soft-detached, compare root signature: unchanged ⇒ keep identity; changed ⇒ rotate, drop session remap, invalidate refs; dialog open ⇒ defer verification (`543-545`) → `Target.setAutoAttach` → reconcile child frames → publish `attachedTabs`/`attachmentIds`.
2. **Frame graph discovery** (`chromium-cdp.ts:678-787` + `1599-1787`): memoized per-session `Target.setAutoAttach{flatten:true, filter:[{type:'iframe',exclude:false}]}`; `Target.attachedToTarget` pre-records `targetInfo.targetId` as the frame token so an unresponsive OOPIF is still omittable (`1692-1699`); `drainFrameAttachTasks` waits for quiescence with a 1s deadline + 20ms quiet window keyed by `generation` (`1745-1768`); root tree then child trees in parallel; `DOM.getFrameOwner` fills `ownerBackendNodeId` (`769-784`); project once with `omitFrameSubtrees` (`786`).
3. **Cross-target projection** (`tools/geometry/frame-context.ts:324-404`): `targetRoot` walks up while the target key is unchanged (cycle-guarded) → `clips()` collects owner content quads inside that target → per outward boundary one edge `{sourceViewport: inner window.innerWidth/Height, destinationQuad: parent DOM.getBoxModel content, destinationClips}`; when inner layout ≠ inner visual viewport, the inner viewport polygon is projected through the same edge into `destinationClips` to remove scrollbar strips (`395-399`).

## Five edge cases
1. **Native modal dialog pauses the renderer**, so `DOM.getDocument` hangs; the pre-detach probe falls back to `Page.getFrameTree` identity only when a dialog is open (`chromium-cdp.ts:1248-1261`), and post-dialog verification is deferred, not dropped (`1883-1904`).
2. **Closed shadow roots**: `host.shadowRoot` is null, so focus must walk `getRootNode().activeElement === node` up via `root.host` (`tools/focus-state.ts:1-12`); background tabs satisfy that but not `document.hasFocus()` (`tools/interaction.ts:1222-1249`).
3. **Requested-but-uncommitted navigation**: lifecycle events for the pending loader are stashed as `pendingLifecycle` and only accepted after a fresh `Page.getFrameTree` proves the loader is current (`tools/navigation.ts:378-393,536-552`); `complete→complete` with no lifecycle event is untrusted (`158-173`).
4. **Commit-less navigation end** (204/download/cancel): `Page.frameStoppedLoading` without commit must revert to the old document and re-probe, not hang (`navigation.ts:807-821`); bfcache restore emits no load, so "load" is synthesized and lifecycle replay re-enabled (`507-519`).
5. **Action point inside a clipped element**: several content quads may exist; the largest *visible* polygon's centroid wins, and "visible in top viewport" vs "visible in its own target" are separate failures (`frame-geometry.ts:105-113,182-203`). `DOM.getContentQuads` may be stale in a background renderer, so layout-flushing `DOM.getBoxModel` is tried first (`element-geometry.ts:94-115`).

## Tests
- Injected `CdpDebuggerApi` + `fakeChromeEvent` shim drives every lifecycle path deterministically; no monkey-patching `chrome` (`__tests__/chromium-cdp.test.ts:17-42`).
- ~85 named driver cases grouped by failure mode: bounded cleanup (`1972-2058`), document-bound refs (`1582-1770`), background execution (`1771-1971`), idle soft-detach 4 guards (`2165-3300`), session/tab reconciliation (`2095-2164`), stuck reattach via dialog (`2637`).
- Deadline/gate is tested as a contract: late reply ignored, late *rejection* ignored, mutations/screenshots unbounded, child gates isolated, replacement attachment fences late completions (`__tests__/command-deadline.test.ts` names at 19,41,52,73,120,135,218,254).
- Pure parts get adversarial unit tests: 5000-deep tree, object cycle, sibling distinctness, nested OOPIF routing, source-order independence (`__tests__/frame-graph.test.ts:40-171`).
- Eval corpus is agent-neutral and separates page-observable / response / adapter evidence, with `unverified` never counted as pass (`evals/browser/README.md:9-23,100-124`; `cases/core/tabs.case.json`).

## Five adopt
1. **Attachment identity + version fence** (`chromium-cdp.ts:284-297,491-503,655-676`) — cheapest primitive that makes late replies, aborts, dialog decisions, screencast frames and cleanup safe.
2. **Read gate with `deadline` vs `blocked` phases + recovery text** (`command-deadline.ts:87-160`): a stuck renderer must refuse later reads, not queue them.
3. **Frame-owner projection chain + two action points** (`frame-geometry.ts:41-62`, `geometry/frame-context.ts:324-404`) — BridgeDeck has the graph and `DOM.getFrameOwner` but no projection, so OOPIF clicks/fills cannot be trusted.
4. **`withInputReady` as the single input entry point** (`tools/input-readiness.ts:173-340`), replacing BridgeDeck's fire-and-forget `Emulation.setFocusEmulationEnabled(...).catch(() => {})` toggles (`extension/src/tools/interaction.js:112-531`, `debugger.js:141-300`).
5. **Document/child-frame signature reconciliation across reattach** (`chromium-cdp.ts:1215-1431`) plus `unavailableFrames` gap reporting surfaced to the agent (`frame-graph.ts:17-19`).

## Three reject
1. **One 2614-line class holding ~35 maps** (`chromium-cdp.ts:280-342`): every new feature = a new map + a new guard. Split into Attachment / SoftDetachSignatures / FrameDiscovery / DialogState with the fence passed in.
2. **Misleading or environment-derived APIs**: `ensureAttachedToUrl(tabId, _expectedUrl)` ignores its parameter (`425-428`); idle-detach timing depends on object identity (`this.api === chromeDebuggerApi`, `1149-1152`).
3. **Double projection at `getFrameGraph` end** (767 vs 786) and the `sources[0]` root-timeout heuristic (`720-730`) — build/project once and carry an explicit `rootFrameId`.

## Five gaps (BridgeDeck, verified in this review)
1. **No native input clock calibration** (BSK `browser-driver/native-input-clock.ts`, 202 lines); BridgeDeck has no equivalent, so `Input.dispatch*` timestamps assume a stable epoch→TimeTicks conversion.
2. **No input-readiness gate / no FOCUS_CHECK** — focus emulation is toggled ad hoc with swallowed errors and only `document.activeElement` is consulted, so closed-shadow focus and hidden-tab input are unverified.
3. **No cross-frame geometry module** — no owner-quad clip chain, no OOPIF-local `targetActionPoint`, no scrollbar-strip clip; only `elementFromPoint` at `extension/src/tools/interaction.js:253`.
4. **Idle detach is a feature-name predicate only** (`extension/src/debugger-idle.js:1-41`): no pre-detach signatures, no child-session remap, no `retainTabAttachment` in-flight lease, so refs can survive a document replacement and OOPIF session ids go stale.
5. **Thin navigation + no driver-level unit suite**: `extension/src/tools/navigation.js` is 4.1KB vs BSK's 1566 lines (no loaderId fencing, pending-request reconciliation, bfcache, beforeunload budget), and the ported driver state machine in `extension/src/browser-driver/` has no fake-`chrome.debugger` unit matrix, only end-to-end coverage.
