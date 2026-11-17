# BSK 0.5.0 — Observation / VOM / Refs / Visual Facts

Source: `D:/浏览器桥/ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0` (read-only study). Paths below are under
`apps/extension/src/` unless noted: `tools/observation.ts`, `snapshot-ref.ts`, `visual-*.ts`, `geometry.ts`,
`tools/vom/*`, `session-manager/ref-store.ts`, `packages/vom/src/*`.

## Core model

Six stages ending in an explicit, validated publish — not one "dump the tree" call.

1. **Facts**: `withObservationFacts` enables `Accessibility` per target, runs `DOMSnapshot.captureSnapshot`
   (computedStyles/paintOrder/rects) + `getFullAXTree` per frame + form enrichment, then an *optional* geometry
   phase; each stage may fail into `CaptureIssue{stage,reason}` rather than abort
   (`tools/vom/capture-coordinator.ts:362-817`; `tools/vom/facts.ts:1762-1803`).
2. **Identity**: per frame `{attachmentId,target,frameId,documentElementBackendNodeId}`, verified live in an
   isolated world; unverifiable root ⇒ `OBSERVE_IDENTITY_CHANGED` (`tools/vom/document-identity.ts:51-132`;
   `capture-coordinator.ts:745-750`).
3. **Semantic graph**: AX joined to DOM by `(frameId,backendNodeId)`, AX-only nodes kept, overlay exclusion
   propagates down both edge sets (`semantic-graph/build.ts:73-139`; `facts.ts:1660-1745`).
4. **Resolve/structure**: role precedence `ax > explicit dom role > native dom role > ax-ignored`, then
   `keep | inferred-group | transparent | excluded` plus an AX-or-DOM parent choice
   (`semantic-graph/resolve.ts:145-164`; `structure.ts:191-226,403-427`).
5. **Scene**: flat `VomNode[]` with `id/parentId/backendNodeId/frameId/contextScopeId/referenceable/rect/
   localRect/paintOrder/position/pointerEvents`; `packages/vom` stays CDP-free (`packages/vom/src/types.ts:22-101`).
6. **Render + publish**: headers `@vom 1 / @view WxH / @layers N focus=L1 / L1 page|modal|mask`, lazy row
   generator, refs allocated during render, per-line token metering (`packages/vom/src/render.ts:1701-1882`).
   `RefStore.replace()` bumps a generation and mints `observation_id`; pagination state lives in
   `WeakMap<RefStore, Continuation>` (`session-manager/ref-store.ts:121-133`; `visual-observation.ts:172-366`).
   Optional visual pass: Canvas from facts+geometry as `@eN canvas "…" [visual:screenshot]` plus `visual-region`
   refs carrying crop+mapping (`tools/vom/visual-discovery.ts`; `visual-observation.ts:20-162`).

## 5 invariants

1. **Ref = node, not record**: entries carry node addressing only (`ref-store.ts:5-14`; `docs/dynamic-reading.md:43-48`).
2. **Ref identity = `(documentRevision, frameId, cdpSessionId, backendNodeId)`**, never an index; stable refs survive
   reordering/replacement (`ref-store.ts:70-79`; `tools/__tests__/observation.test.ts:3048-3097`).
3. **Reservation ≠ actionability**: `allocateRef` reserves `eN` during render, only `replace()` rows resolve —
   truncated pages leave numbering gaps (accepted).
4. **Publish after identity validation** of every touched frame and its ancestors (`visual-observation.ts:288-317`);
   visual refs expire on every page even under stable refs (`ref-store.ts:123-125`; test `:198-226`).
5. **Text/refs cannot desync**: refs get `line = lines.length` at push only, so truncation never emits a ref for an
   unrendered row (`render.ts:1482-1493`; `render.test.ts:471`); `@warning` notices are budget-reserved (`observation.ts:1105-1118`).

## 3 algorithms

1. **Paint-order-band layers** (`packages/vom/src/layers.ts:17-102`): a candidate must be positioned with `pointer-events != none` and either `spansViewport` (±1 CSS px edge tolerance) or `modal===true` with coverage>0;
   winner = max coverage, tie by paintOrder; members = same-frame nodes with `paintOrder >= threshold`; kind = modal
   if any member is dialog/modal/form/iframe else mask; root-frame guard `:70`. The renderer folds the rest to `L2 page … occluded by L1 (~N nodes, not actionable)` (`render.ts:1681-1699`).
2. **Streaming token budget** (`render.ts:1472-1496`): header cost pre-charged, each row costs `estimateLineTokens`,
   first overflow sets `truncated` and stops. The estimator is a real pre-tokenizer (o200k regex) with fitted constants,
   1.05 safety factor and **unrounded per-line cost** (`packages/vom/src/tokens.ts:30-37,318-329`); pagination adds
   one-row lookahead footer reservation, a `minimal` row form and a "too small to advance" error (`visual-observation.ts:216-247`).
3. **Cursor state machine** (`visual-observation.ts:250-366`): accepted only when `tabId==state.tabId && revision==store.revision
   && (cursor==token || cursor==last.input)`; retrying `last.input` with a *different* budget is rejected, same budget
   returns the memoized page without advancing; consumed rows are spliced out; the final page drops candidates/identities/frames/notices.

## 5 edge cases

1. **Sidebar vs modal**: a 99%-wide fixed aside must not fold; only modal evidence or a true viewport span does (`layers.test.ts:111-200`).
2. **Cross-frame paint order** is incomparable — resolve to the nearest common document lineage, else skip (`render.ts:1532-1614`); children of a blocker join via `collectDescendants`, not paint order.
3. **`backendNodeId` reuse after navigation** is caught only by per-tab `documentRevision` plus entry deletion (`ref-store.ts:157-177`); OOPIF churn remaps or invalidates child refs (`:180-277`).
4. **Cancellation stays retryable**: cancel during capture keeps the previous store (`observation.test.ts:3099-3159`); cancel
   during page validation must not publish or clear a newer observation; a cancelled final page retries with a smaller budget (`visual-observation.test.ts:740-958`).
5. **Sensitive state**: password/autocomplete/AX `inputType` ⇒ `•••`, and a sensitive field with a runtime default reports
   `filled` never `default` (`resolve.ts:166-198`; `snapshot.ts:116-129`; `render.ts:914-922`). Do not copy `value.slice(0,200)` (splits surrogate pairs) or the unescaped `[→ href]` (`render.ts:896-898,921`).

## Tests

- **Golden text contract shared with the consumer**: `packages/vom/src/__tests__/contract.test.ts` renders every case of
  `crates/bsk-cli/tests/fixtures/vom_contract.json` and asserts exact text for both `renderVom` and `prepareObservationRender`
  (fixture `:169,371`), so the Rust recipe parser cannot drift.
- **Layer tests** with an edge-tolerance table plus a sidebar/position/role matrix (`layers.test.ts:36-267`), and an env-gated
  **real-browser matrix**: 14 fixtures × deviceScale 1/1.25/1.5 × zoom 1.1 asserting `@layers 2`, absence of the main action ref,
  `elementFromPoint` hit and a real click (`tools/__tests__/observation-layers.browser.test.ts`).
- **Continuation suite**: no ref re-issue across pages, cursor rejected after DOM/replace/clear/tab change, too-small budget
  consumes nothing, minimal row, Canvas below depth limit, cancel/retry paths (`vom/__tests__/visual-observation.test.ts:163-268,740-958`).
- **Estimator eval**: recorded o200k reference counts, bounds −10%/+30% (tight ±12% English VOM/prose) and an explicit
  `ceil(chars/4)` undercount regression (`tokens.test.ts:4-104`).
- Fake-CDP mocks (a `send(tabId,method,params)` that can hang or reject) are what make timeout/fallback/identity paths
  testable without a browser; `evals/browser` adds case/oracle/coverage on top.

## Adopt (5)

1. Default two-layer document (`@layers`, `L1 … cover=NN%`, `L2 … occluded`) with paint-order-band membership and
   root-frame-only modality — replaces the role/area-only `extension/src/lib/blocking-layers.js:27-51`.
2. Ref identity + negotiated stable refs + `documentRevision` + generation-stamped publication (`ref-store.ts:62-177`);
   removes the `role\0name` AX join fallback in `extension/src/tools/observation.js:76-119`.
3. Opaque revision-bound cursors with idempotent retry and a buffered row iterator — replaces `{t,o,at}` char offsets
   (`extension/src/tools/observation.js:34-43,624-690`).
4. The pre-tokenizer estimator + per-line cost + header/footer/notice accounting (`packages/vom/src/tokens.ts`) —
   replaces char-run heuristics in `extension/src/tokens.js:6-79`.
5. Failure taxonomy on the wire: terminal `AbortError|CdpReadTimeoutError|CdpAttachmentChangedError`,
   `reason:renderer_read_timeout`+`phase`, child-OOPIF timeout isolation, read gate, and budget-reserved `@warning`
   lines (`capture-abort.ts:17-26`; `command-deadline.ts:10-160`; `capture-coordinator.ts:423-448`).

## Reject (3)

1. Site/locale-fitted heuristics in `render.ts` (`NON_CAPTION_*`, `WEAK_ACTION_LABELS`, `MAX_RECOVERABLE_*`, the
   ICP/Beijing filters at `:135-180`); keep only the generic compaction rules.
2. `cursor:pointer`/inline-handler role promotion by default (`render.ts:367-523`) — it invents controls the browser
   does not have; in untyped BridgeDeck JS take at most CDP `isClickable` plus outermost-pointer.
3. Post-hoc line diffing as the primary delta path (`extension/src/lib/observation-delta.js:39-88`): it compares only
   `@e\d+` runs, so a "successful" patch can reference different nodes. Gate it on per-line ref identity plus document
   revision, else fall back to a full page.

## Gaps (5, BridgeDeck)

1. No layered/occluded document: `computeBlockingLayers` returns a side array (`observation.js:545-554,699`) and the
   text has no `@layers`/`L1`/`L2`/occlusion line.
2. No document-scoped ref identity: no `documentRevision`, no per-entry `generation`/`cdpSessionId`, no stable-refs
   negotiation; closed-shadow refs merge by numeric continuation (`observation.js:401-420`).
3. Offset cursor is not idempotent and can exceed budget (one over-budget line returned whole, `tokens.js:70-74`);
   no per-page ref publication and no identity re-check between pages.
4. No Canvas/visual-region capability (no `visual:screenshot` rows, no `visual-region` ref kind, no crop↔image
   mapping or single-use `capture_id`) — port from `visual-screenshot.ts:23-137` + `visual-capture.ts:6-111`.
5. Degradation is invisible: failures collapse to `bridgeError` and skipped AX/facts/blocking work is only `log()`-ed
   (`observation.js:437-439,550-553`); no golden observation contract shared with CLI/MCP parsers; no env-gated
   real-browser observation matrix.
