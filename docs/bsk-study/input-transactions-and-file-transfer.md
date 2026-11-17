# BSK 0.5.0 — input transactions, selectors/refs, read-only & file transfer

Source root: `D:/浏览器桥/ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0` (paths below relative to it).
Read in full: `apps/extension/src/tools/{interaction,pointer-transaction,transfer-transaction,input-readiness,click-overlay,read,extract,upload,download,download-capture,file-input-transaction,file-drop-transaction,drag,scroll,waits,wheel}.ts`, `read/**`, `extract/**`, `snapshot-ref.ts`, `target-hit.ts`, `errors.ts`, `policy.ts`, `frame-geometry.ts`, `element-geometry.ts`, `scroll-visibility.ts`, `session-manager/ref-store.ts`, `vom/document-identity.ts`, `__tests__`, `evals/browser/README.md`. Nothing outside this repo was modified.

## Core model

Address → transaction → effect ledger. A target is never a node handle: it is
`(tabId, cdpSessionId?, frameId?, backendNodeId)` resolved from the session `RefStore` or from
`DOM.getDocument(depth:0)→querySelector(All)→DOM.describeNode` (`tools/interaction.ts:184-272`).
Refs are names for that identity with a publication `generation`; a per-tab `documentRevision`
blocks backend-id reuse after navigation, and `visual-region` refs are a separate kind refused as
DOM targets (`session-manager/ref-store.ts:5-30,92-177`; `tools/snapshot-ref.ts:58-79`).
Document identity is a first-class value — `attachmentId + frameId + documentElementBackendNodeId`
— verified around captures and on guarded sends (`tools/read.ts:52-84,144-147`; `tools/extract.ts:197-217`;
`tools/vom/document-identity.ts:51-131`). Every action is one absolute deadline plus one ledger:
`effect_state: none|committed|unknown`, a `phase`, and `cleanup_state: failed` (`tools/errors.ts:44-71`;
`tools/file-input-transaction.ts:16-76`; `tools/file-drop-transaction.ts:15-68`; `tools/download-capture.ts:132-143`),
reused by interaction as `data.effect_state` + `reason ∈ {input_not_ready, input_outcome_unknown,
input_paint_unconfirmed, input_cleanup_failed}` (`tools/input-readiness.ts:283-337`; `tools/click-overlay.ts:141-153`).

## 5 invariants

1. **Exactly one of ref|selector**; both/neither → `invalid_params` (`tools/interaction.ts:170-183`;
   `tools/waits.ts:279-288`). A ref only resolves in its owning tab; unknown → `ref_not_found`,
   visual ref → `ref_kind_unsupported` (`tools/snapshot-ref.ts:19-79`).
2. **No input until verified**: connected, enabled, not inert, topmost at the exact point
   (`tools/drag.ts:222-256`; `tools/target-hit.ts:34-87`; `tools/file-drop-transaction.ts:151-177`).
3. **Once pressed, always released**: `mouseReleased` in `finally`, re-sent even after retirement
   (`tools/interaction.ts:595-670`; `tools/pointer-transaction.ts:95-155`; `tools/drag.ts:407-414`).
4. **Cancellation after possible dispatch is `unknown`, never `none`** (`tools/input-readiness.ts:289-337`;
   `tools/click-overlay.ts:141-153`); cleanup never replaces the result nor extends the deadline
   (`tools/interaction.ts:462-472`; `tools/download-capture.ts:466-489`).
5. **Claims need positive evidence**: a download is attributed only by CDP `Page.downloadWillBegin`
   (url+basename) or a popup URL opened by this tab after press; ambiguity fails closed and cancels
   nothing (`tools/download-capture.ts:219-272,336-357`).

## 3 algorithms

1. **Fill 3-script protocol** (`tools/interaction.ts:1077-1322,1376-1810`): step1 validates and computes
   `expected` through a *detached clone* (sanitization, min/max, line endings), scrolls only if
   off-viewport, focuses, clears via prototype setter + `input`, places the caret, returns readiness
   flags; step2 writes (`Input.insertText`, or value setter for date/time); step3 dispatches
   `input`/`change` and reads back `matches/formatted/actual_value(≤200)`, length-only if sensitive.
2. **Overlay arbitration** (`tools/click-overlay.ts:77-154`): probe `absent|clear|covered|unknown` via
   `elementFromPoint(...).closest(overlayHost)` → bypass → TTL-leased passthrough → re-probe before
   every press; lease expiry mid-gesture downgrades success to `input_outcome_unknown`.
3. **Extract table matrix** (`tools/extract/normalize.ts:77-236`): group-scoped span carry
   (`rowspan=0` clipped to its row group), ARIA index fallbacks + warnings, duplicate `aria-rowindex`
   fragments merged only when indexed/non-overlapping/group-compatible, per-column header paths with
   explicit `headers` precedence, provenance `row_sources`+`spans`, byte fit by binary search over rows
   (`extract/normalize.ts:242-272`).

## 5 edge cases

- Focus flush: hidden/unfocused pages run focus handlers only on the next real input, so fill sends `mouseMoved(-1,-1)` *only* when visible and nothing is `:hover` (incl. cross-origin check), else a no-op `rawKeyDown`+`keyUp`, then verifies `document.hasFocus()` (`tools/interaction.ts:1500-1565`).
- Enter is one `keyDown` with `text` so keydown+keypress stay atomic across navigation; `text` is
  suppressed under ctrl/meta/alt; punctuation needs `PUNCTUATION_KEYMAP` or `Ctrl+/` arrives with
  `code:""` (`tools/interaction.ts:1909-1944,2080-2117`).
- `[hidden]` is only a UA default — computed style is authoritative; `hidden="until-found"` is content-visibility; `visibility:hidden` may be restored by descendants (`tools/extract/collector.ts:68-161`); a child document cannot see a hidden iframe owner (`tools/extract.ts:273-287`; `tools/scroll-visibility.ts:119-151`).
- Upload activation has two independent signals — exact `Page.fileChooserOpened` **or** a frame-scoped
  capturing click listener recording `input[type=file]` and preventDefaulting; programmatic `.click()`
  and File System Access pickers handled explicitly (`tools/file-input-transaction.ts:159-393`).
- Download: a same-URL download seen *before* press must not be attributed; `target=_blank` attachments
  emit no CDP intent on the clicked target, hence popup-URL correlation gated on `dispatched`; another
  extension can override the filename, so the completed path is re-validated and a mismatch leaves the
  file in place (`tools/download-capture.ts:6,219-224,329-335,419-433`).

## Tests

Strict fake `CdpRunner` throwing on unexpected methods + a `sent[]` log asserting command order/params
(`tools/__tests__/interaction.test.ts:36-85`). Effects asserted on `data.effect_state`/`cleanup_state`,
not only codes (`file-transfer.test.ts:411-435,681`; `download-deadline.test.ts:183-185`). Fake timers
prove pending triggers settle, late rejections are ignored, `vi.getTimerCount()===0` after cleanup
(`download-deadline.test.ts:96-131,150-189`). Env-gated real-Chrome lane asserting `event.isTrusted`
(`click.browser.test.ts:1-90`). Extract fixture suite covers spans, header paths, aria gaps, byte
budget, no partial JSON (`extract/extract.test.ts:53-450`). Eval corpus is data-driven with three
independent channels `site`/`response`/`adapter`, `unverified ≠ passed`, `core|matrix|regression`
suites (`evals/browser/README.md:9-24,100-123,148-199`).

## 5 adopt (BridgeDeck)

1. Port `tools/transfer-transaction.ts` (48 lines) as-is — `waitBounded`/`BoundedWaitError`/`remainingMs`
   with `void promise.catch(()=>{})` for retired work; BridgeDeck has no bounded-wait type.
2. Port `tools/pointer-transaction.ts` (187 lines): `retired` check on every dispatch, auto-released
   `release` record updated by later moves, `releasing` guard, `movedWhilePressed` +
   `Input.cancelDragging`, attachment-id ownership fence, `registerClickCleanup`.
3. Add the effect ledger to `extension/src/errors.js` `toWireError` and every input/transfer path.
4. Fence refs at action time: compare `refStore.documentRevision(tabId)` + attachment id before
   dispatch and after waking the renderer (`tools/read.ts:60-84`; `tools/input-readiness.ts:263-269`).
5. Replace blind upload fallbacks with verified-activation transactions, and baseline-diff download
   with intent attribution + byte cap + state-reconciling cleanup
   (`tools/file-input-transaction.ts:159-393`; `tools/download-capture.ts:117-295`).

## 3 reject

1. Visual-capture lineage (`tools/visual-capture.ts`, `visual-target.ts`, 32 ms re-validate in
   `tools/interaction.ts:673-749`) — a second identity system; keep only “capture is single-use, ref
   generation or hit-target change ⇒ stale”.
2. Global `downloadActive` boolean (`tools/download.ts:18-35`) — correct for one session per extension;
   use a per-session lock in BridgeDeck.
3. Duplicated page-side predicates (`STATE_PROBE` `tools/waits.ts:181-194` vs `VISIBLE_RECT`
   `tools/scroll-visibility.ts:18-39`; `FILL_STEP1_FUNCTION` vs `runFallbackPrep`); BridgeDeck's single
   injected page-lib is better — don't port the drift.

## 5 gaps (BridgeDeck)

1. No transaction deadline or bounded cleanup (`extension/src/tools/interaction.js`;
   `extension/src/tools/file-transfer.js:123-124` polling loop).
2. No effect semantics in `extension/src/errors.js`; CLI cannot distinguish “click may have landed”
   from “never dispatched” (only stubs in `reference/extension-mirror/src/cooperation/action-checks.js:10-16`).
3. Ref fencing absent: mirror `ref-store.js` keeps `documentRevision` but no tool checks it, no
   attachment id, no `invalidateChildFrames`/`remapChildFrameSessions` (vs
   `session-manager/ref-store.ts:179-277`).
4. Upload/drop unverified: drop dispatches `dragEnter/dragOver/drop` with no hit test and no
   `dragCancel`; chooser path falls back to “first file input in the document”
   (`extension/src/tools/file-transfer.js:29-47,56-70`).
5. Download is baseline-diff polling with no intent match, size cap, filename routing or cleanup, and
   can steal a concurrent human download (`extension/src/files.js:44-123`).
   Note: `reference/extension-mirror/src/tools/**` does not exist — the tools layer is the missing half
   of the port.
