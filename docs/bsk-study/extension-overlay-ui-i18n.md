# BSK 0.5.0 — in-page overlay, components, theming, i18n, overlay isolation

Source root: `D:/浏览器桥/ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0` (all paths below are relative to it).
Read: `apps/extension/src/content/**`, `apps/extension/src/components/**`, `apps/extension/src/entrypoints/{content.ts,popup/**,audit/**,debug/**,cooperation.content.ts,record-frame.content.ts}`, `apps/extension/src/lib/*bridge*.ts`, `packages/i18n/**`, `packages/ui/**`, `evals/browser/**` (schema + oracle + cooperation runner).

## Core model

Two authorities: background SW owns truth, page-side `OverlayController` owns presentation.

- Wire: one *complete* push `bh-agent-overlay-state` = `{sessionId, mode: control|interrupting|paused|hidden, controller?, cooperation?, minimized?, epoch, generation}` (`lib/overlay-bridge.ts:71-91`). Background stamps `nextOverlayVersion()` on every push (`lib/overlay-version.ts:1-16`; `entrypoints/background.ts:289-336`).
- Page: `OverlayController` holds one mutable record split into user-tab scope (`borrowRequests`, `controlHintsHidden` — survives teardown) and agent-tab scope (`activeHelp`, `activeRecord`, `activeSessionId`, `controller`, `controlMode`, `interrupting`, `automationBypassCount`, `suppressControlAfterRecord`) (`content/overlay-controller.ts:37-169`).
- Render: one shadow host (`createShadowRootUi`, `anchor:"html"`, inline CSS) + one React root; every mutation ends in `renderAll()` → single `flushSync` rendering 4 sibling overlays (`entrypoints/content.ts:115-246`).
- Visibility is computed, not stored: `controlVisible` getter `:58-60`; `shouldShowAgentControlOverlay()` truth table `:172-179`.
- Cooperation is a second derived projection computed background-side from frame state: `CooperationController.view()` ladder `unavailable|yielding|held|human|acting|ready|syncing` (`cooperation/controller.ts:486-509`, types `cooperation/types.ts:125-131`); UI synthesises an 8th display status `editing`.
- Isolation channel is host attributes only: `data-bsk-overlay` (VOM skip, `tools/vom/facts.ts:10-18`), `data-bsk-overlay-surface`/`-blocking`, `data-bsk-input-passthrough`, `data-bsk-capture-hidden` (`content/overlay.css:4-34`).

## 5 invariants

1. Reset is session-scoped and partial: `resetAgentOverlays(other)` no-ops; borrow requests and control-hints preference survive (`overlay-controller.ts:151-168`; tests `content/__tests__/overlay-controller.test.ts:57-69,168-178`).
2. Interactive overlays always beat the control card: `shouldShowAgentControlOverlay` is false while help/record is open; record end sets `suppressControlAfterRecord` + zeroes bypass refs so the mask cannot flash (`overlay-controller.ts:120-137`).
3. Overlay messages are ordered by `(epoch, generation)`; a retired worker epoch can never be admitted again — prevents a late `control` re-pinning a full-viewport blocker (`overlay-bridge.ts:145-171`; `lib/__tests__/overlay-bridge.test.ts:91-112`).
4. Screenshot suppression is refcounted with a two-rAF ack and a stray `end` is a no-op; passthrough leases are id-keyed, 5 s TTL, duplicate `begin` must not extend (`content/capture-suppress.ts:58-98`, `content/input-passthrough.ts:9-53`, `lib/input-passthrough-bridge.ts:2-5`).
5. i18n ships complete bundles: every locale's flattened key set and interpolation-variable set must equal en-US, per namespace (`packages/i18n/tests/i18n.test.ts:111-131`).

## 3 algorithms

1. **Version gate** (`overlay-bridge.ts:158-170`): same epoch → admit iff `generation >= last`; unseen epoch → admit and retire previous epoch; retired → drop.
2. **Countdown vs. transition race** (`content/BorrowConfirmationOverlay.tsx:63-117`): 1 s decrements → at 0 arm `awaitingAutoDeny` + 1000 ms fallback timer; the CSS `transitionend` (propertyName-checked) may settle first; both pass one `settledRef` one-shot guard.
3. **Help-panel placement** (`content/HelpRequestOverlay.tsx:99-161,332-367`): `unionBox(measured)` → `choosePlacement` (below if `spaceBelow >= panelH+gap+margin`, else above, else larger side) → `placePanel` (clamp centre X, `top = anchorBottom+12` or `bottom = vh-anchorTop+12` so the edge stays pinned on collapse); placement memoised per `requestId`, and anchoring is disabled forever after a user drag.

## 5 edge cases

1. Background/hidden tab: rAF never fires → capture ack falls back to 500 ms timer (`capture-suppress.ts:22-41`); pre-message render wait is two 500 ms setTimeout frames (`content.ts:252-265`); auto-deny uses its own timer, not `transitionend`.
2. Host removed and rebuilt mid-operation: `onHostMounted` re-applies hidden/passthrough from the controller's own counters (`capture-suppress.ts:93-98`, `input-passthrough.ts:52`); a `MutationObserver` on `document.documentElement` (childList, subtree:false) remounts the UI with `remountInProgress`/`hostLossReported` guards (`content.ts:618-637`).
3. Frozen page resumes before timers run: `apply()` prunes `expiresAt <= now` leases before setting the attribute, so an expired lease is never revived (`input-passthrough.ts:16-22`; test `input-passthrough.test.ts:122-131`).
4. Agent sends a bad selector or an unmeasurable panel: `querySelectorSafe` try/catch → no highlight; zero `offsetWidth/Height` falls back to 420/180/44 px and no anchor → bottom-centre with `data-anchored="false"` (`HelpRequestOverlay.tsx:163-182,344-358`).
5. Open shadow root is page-controllable: the regression eval itself clicks chrome via `document.querySelector('browser-skill-overlay').shadowRoot.querySelectorAll('[data-slot=cooperation-toolbar] button')[i]` (`evals/browser/cases/regression/cooperation/run.mjs:315-329`) — the same capability a hostile page has.

## Tests

- vitest + happy-dom, setup forces `zh-CN` so component tests assert real copy (`apps/extension/vitest-setup.ts:1-3`); `data-slot` used as selector contract everywhere.
- Tests double as specs: overlay-controller truth table; `ControlOverlay.test.tsx:187-222` reads injected CSSOM (keyframes only animate `opacity`, no `infinite`); `HelpRequestOverlay.test.tsx` (494 lines) pins placement with stubbed `getBoundingClientRect`/`offsetWidth`.
- Full entrypoint harness without React: inject `defineContentScript`, stub `createShadowRootUi`, `sendMessage` throws by default, DSL `state()/reset()/begin()/remount()` + never-resolving promise to prove no deadlock (`entrypoints/__tests__/content-passthrough.test.ts:11-114`).
- Real-Chrome tests are opt-in and self-skip: `describe.skipIf(!process.env.BSK_CLICK_CHROME)`, esbuild bundle + CDP (`content/__tests__/record-input-buttons.browser.test.ts:1-2,72`).
- i18n node suite: `import.meta.glob` registration, detection precedence, storage echo suppression, 38-row normalization table, extensibility (`packages/i18n/tests/*.test.ts`).
- Evals are data-driven and *require* bilingual prompts `{en, zh-CN}`, `site|response|adapter` assertions, structured `expectError{code,reason}` (`evals/browser/schemas/case.schema.json:36-114`); oracle reports `passed-with-unverified` instead of passing missing evidence (`evals/browser/lib/oracle.mjs:31-62`).

## 5 adopt

1. Two-scope overlay state + derived visibility + session-scoped reset (port verbatim).
2. `(epoch, generation)` ordering on every authoritative UI push (SW restarts are real in BridgeDeck).
3. One commit point per state change; page-visible surface = pure function of the snapshot; host attributes as the only page bridge.
4. `data-slot` as style-independent addressing contract shared by unit tests, CSS and CDP evals.
5. Refcounted suppression primitives (screenshot-hide, click-passthrough) with remount re-apply + TTL leases; plus collector-at-`document_start`-all-frames vs UI-at-`document_end`-top-frame split (`entrypoints/cooperation.content.ts:1-12` vs `content.ts:72-79`).

## 3 reject

1. Theme split: only the cooperation card has dark tokens (`overlay.css:349-364`); help banner, record pill and both borrow surfaces are hardcoded light (`HelpRequestOverlay.tsx:373-672`, `RecordOverlay.tsx:186-205`, `BorrowConfirmationOverlay.tsx:128-159`). One token set per surface instead.
2. Four copies of the matchMedia `.dark` bootstrap inside components (`popup/App.tsx:51-60`, `audit/App.tsx:157-164`, `debug/App.tsx:106-112`, `long-screenshot/preview.tsx:29-30`) → one `useSystemTheme()` in `packages/ui`.
3. Inconsistent authorization on sibling UI messages: `overlay.set_minimized` validates sender window + tab ownership, `overlay.interrupt` trusts any `sessionId` from any tab (`entrypoints/background.ts:648-680`); also an open shadow root exposes Stop/Interrupt to page script.

## 5 gaps

1. No automated a11y gate (no axe anywhere); keyboard coverage is one test (`ControlOverlay.cooperation.test.tsx:163-182`). No focus trap/initial focus on the blocking borrow modal (`BorrowConfirmationOverlay.tsx:41-50,124-153`).
2. No RTL support or tests: physical `right/bottom/left` anchoring throughout (`overlay.css:53-66,322-335`); no `dir` handling; shadow root does not set `lang`.
3. i18n blind spots: no unused-key check (verified dead: `popup.stateDetail.*`, `popup.stateLabel.connecting`, 4 of 5 `popup.stateBadge.*`); ~360 keys reachable only via template literals; non-plural `audit.operationCount/errorCount/fileCount/activeRules` vs pluralised `debug.requestCount_one/_other`; manifest strings English-only (`wxt.config.ts:35-72`).
4. No visual/layout regression: CDP evals only assert existence booleans (`cooperation/run.mjs:333-337,764-783`); layout math tested only against hand-stubbed rects because happy-dom has no layout engine.
5. Overlay concurrency + hostile-page boundary untested: no three-way (help+record+borrow) precedence test, and nothing covers a page hiding the host with `!important`, remount storms, or synthesized clicks on overlay buttons; `packages/ui` has no tests at all.
