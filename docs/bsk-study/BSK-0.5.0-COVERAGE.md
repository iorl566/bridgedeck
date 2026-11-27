# BSK 0.5.0 usable-coverage dashboard (BridgeDeck 0.4)

> Read-only dashboard. Every number below is produced by
> `node 0.4/scripts/bsk-coverage.mjs`; the fenced report in section 6 is the
> verbatim generator output and `--check` fails if this page drifts from it.
> "Usable" never means "the wire accepts the name"; see section 4.
>
> Reference source: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`.
> Target: `0.4` (0.3.0 stays frozen; this page does not touch it).

## 0. Headline

| Question | Answer |
| --- | --- |
| BSK 0.5.0 code size | **334,821** lines = 181,866 production + 152,955 test (Rust/TS/JS/CSS/HTML only) |
| 0.4 code size | **261,617** lines = **141,973** production + **119,644** test |
| 0.4 as a share of BSK | **78.1%** production / **78.2%** tests / **78.1%** total |
| 77 BSK wire methods | **77/77** descriptors and **77/77** codecs |
| `tool.*` (53) | **53/53 registered**; **52 full unconditionally + 1 caveated-full** (`tool.cooperate`), **0 partial**, **0 refused** (4 of the full handlers require the opt-in extension ingress; `tool.cooperate` is full only under the `[3e]` scope conditions) |
| Control plane (24) after the alias wave | **24 real**, **0 explicit-unsupported**, **0 absent** |
| BSK-name daemon wire coverage | **1/77** before the wave → **24/77** after |
| Usable methods | **52/77 (67.5%)** before → **77/77 (100.0%)** after |
| Remaining gap | **0/77**: 0 partial tool handlers + 0 refused tool handlers + 0 typed-unsupported control methods |
| Scope conditions on the 100% (rounds 36-39) | 4 full `tool.*` need the opt-in MV3 extension ingress (`[3c]`); `tool.cooperate` is full only with the opt-in MV3 content script (human attribution, now a native-dispatch-timestamp ±1.5 ms exact match; `fill` remains window-mode) and `--cooperate-gate` (one-shot CLI input gating). Round 39 (A3a/A3b/A4a/A4b) only **refreshed the evidence** (`[3f]` + updated `[3c]`/`[3e]`): daemon default video MP4 + fixed tab identity + `owner:'daemon'`, debug operations correlation + browser-source replay, borrow confirmation UI/borrow fidelity, observed-tab/window routing and the single session_stop order; no condition was relaxed |

This is broad protocol and runtime coverage, not BSK parity. The **4 former
refused `tool.*` handlers are now full** (round 34, 2026-11-24) because the opt-in
extension ingress proves the BSK effects on live `chrome.*` state (headed-Edge E2E
128/128 after round 37 added the lifecycle scenarios, not just receipts): `tool.session_start` creates a real Agent Window,
`tool.tab_borrow`/`tool.tab_return` move a real user tab into it and back to its
original window/index, and `tool.session_stop` returns every borrowed tab and
releases the window. They are **opt-in**: a daemon with no injected extension
client still answers those four with typed `E_UNSUPPORTED` before any effect, and
that honest capability gate is stated in the report's `[3c]` block rather than
hidden. The control plane is now **24/24 real**: the
five `local_auth.*` methods are a real local device trust store
(`0.4/daemon/local-auth.mjs`: pair link/code, device list, revoke, two-phase
rotate, three-mode `set_mode`, constant-time `authorize`, atomic 0600 store with
per-secret salted SHA-256 hashes and no plaintext keys) wired through the
daemon. That is a real capability, not a BSK-parity claim: the default mode is
`warn`, `pair` is the only credential-free HTTP route and since round 28 it is
served to loopback peers only (a non-loopback pair request is 403 +
`E_LOCAL_ONLY`; the WS transport has no pair route), and
`system.status.local_auth` reports `{ mode, paired_devices,
last_unpaired_attempt, devices }`: the trust store now records the last rejected
unpaired/credential attempt (`at`, `reason`, optional `device_id`) in
daemon memory only — the status view no longer hard-codes `null`, and the record
is never persisted and carries no secret. `tool.cooperate` now has a real CDP carrier (overlay,
authority/epoch, context/observation, in-page `isTrusted` quiet window), a real
adapter **action gate** for `click`/`hover`/`select`/`fill`/`press`/`drag`
(negotiated `strict`/`target` context/observation validation before any CDP
call), strict-mode **`document_token` binding** (sha256 of `location.href` plus a
per-document nonce, re-read before every strict action/wait; a changed document
fails typed `E_CONTEXT_STALE` with `effectState:"none"` and no dispatch) and a
daemon/CLI cooperation plane (`cooperate.enable/sync/status/wait` over HTTP/WS,
CLI `--session-cooperate-*`) with a real **human-attribution state machine** (an
extension `human.input` moves the session to human/paused, the gate refuses with
`E_SESSION_PAUSED`, the issued context/observation are revoked and the authority
epoch advances, and a 2 s quiet window auto hands control back). Round 36
(2026-11-24) reclassifies it as **caveated-full**: the capability is real and
E2E-proven, but it is full only under written **scope conditions** (printed in the
report's `[3e]` block): human attribution needs the opt-in MV3 content script
(plain CDP `isTrusted` cannot tell a person from CDP input, and without the
extension the human/paused hand-back gate is not armed), and the one-shot CLI
input paths (`--click`/`--fill`/`--press`/`--select`/`--drag`/`--hover`/`--focus`/
`--wheel`) gate only when that invocation passes the explicit `--cooperate-gate`
flag (without it they keep the pre-round ungated behavior). Round 37 made that
opt-in attribution **exact**: the adapter generates the native dispatch timestamp
when it arms a native input and passes the same epoch-ms value to every CDP
`Input.*` call; the content script converts it into the frame monotonic clock
(`performance.timeOrigin`) and requires `|event.timeStamp - armed_at| <= 1.5 ms`,
so a 20 ms near-miss is human (the same +20 ms event matches in the legacy
window mode — the E2E contrast case), and `fill` is the one documented
window-mode exception because `Input.insertText` carries no timestamp. Round 37
also landed the browser-side **lifecycle facts** (`tabs.onMoved`/`onRemoved` +
`windows.onRemoved` -> `extension.event session.ended` with
`user_moved_tab`/`tab_closed`/`window_closed`; the extension's own Agent Window
close is suppressed; `tabs.onDetached`/`onAttached` are deliberately not
subscribed), consumed by the daemon to end the session, release the window and
return borrowed tabs. Evidence: headed-Edge
E2E `0.4/tests/cooperate-attribution-e2e.mjs` **129/129** (now including
±1.2 ms -> agent (inside the 1.5 ms bound) / exact +20 ms -> human / window-mode +20 ms -> agent),
the ingress E2E **128/128** (3 lifecycle scenarios), the strict doc-token
suite **33/33**, and the CLI `--cooperate-gate` suite **13/13**. That is why the
headline is **usable 77/77 with caveats**, not "everything works with no opt-in":
5 of the 53 full `tool.*` handlers (the four extension-ingress methods and
`tool.cooperate`) are full only when their recorded opt-in is present.
`tool.video` is now **full** (round 33, 2026-11-24): the adapter
**default is MP4**, matching BSK's MP4-only contract. A `start` without a
`format` field draws the same CDP screencast JPEG frames into an in-page canvas,
encodes H.264 fragmented MP4 with
`MediaRecorder('video/mp4;codecs=avc1.42E01E')` and only reports `playable` after
`mp4-verify` re-parses the artifact; `capabilities` reports
`format:"mp4"`/`default_format:"mp4"`, an unsupported page fails typed
`E_UNSUPPORTED` with no silent AVI fallback, and the local MJPEG AVI path stays
reachable only through an explicit `format:"avi"`. Rounds 31-32 added the real
**daemon-side persistent catalog** (`0.4/daemon/video-catalog.mjs`: 24 h
retention / 1 GiB budget / 256 MiB cap, `video.list/save/discard` over HTTP/WS
plus CLI verbs, typed `E_NOT_CONFIGURED` when off). **Round 39 (A4a)** closed the
two recording boundaries that were still written down here: the daemon-native
`session-video` default is now **MP4** too, and every recording/start/status/stop
view plus the catalog entry carries the session target's fixed `tab_id`/
`window_id` (null when unreadable — never invented) and `owner:'daemon'` (legacy
catalog indexes normalize to daemon + null identity; `owner:'extension'` is
reserved and never written). The one remaining **non-semantic** boundary is
catalog ownership: a browser/extension-owned artifact store with fixed-tab
authorization is not claimed. `tool.debug` is now **full**: the adapter handler
(`0.4/packages/browser-adapter/src/debug-handlers.js`, `SUPPORTED_DEBUG_ACTIONS`
= `capabilities` + 23 delegated actions) and the session store
(`0.4/daemon/session-debug.mjs`) deliver all **24 of 24** BSK DebugActions —
the Fetch request rules (`rules`/`rule_add`/`rule_enable`/`rule_disable`/
`rule_remove`: real `Fetch.requestPaused` interception with block/modify/mock and
exactly one reply per paused request), `replay` (**browser-first since A4b**:
in-page `fetch` over CDP `Runtime.evaluate`, idempotent key, 15 s / 256 KiB
bounds, Node `fetch` only as the explicit `fallback:true` source, aborted by
`stop`), `performance` (CDP
`Performance.getMetrics` mapped to `DebugPerformance`), `aggregate`/`duplicates`
(pure analysis over the retained run) and the previously delegated
capture/export/pin/wait/operations family. **Round 39 (A4b)** also closed the
operation-correlation gap: a daemon-fed operation now carries the bounded
`request_ids`/`console_ids` derived from its capture window (a miss stays empty,
never invented). Remaining boundaries are recorded in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §3.3: performance only reads the
CDP metrics domain, rules can only be mutated while a run is recording, a
one-shot CLI run has no action feed, and a handler built without
a client stays capabilities-only.

## 1. BSK 0.5.0 source inventory

Measured over `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`, excluding
`node_modules/`, `target/`, `dist/` and `.git/`. Line counting and test
classification rules are in section 6. Full tables are in the section 6 report
(`[1]`, `[1b]`, `[1c]`); the shape is:

| Kind | What is counted | Total lines |
| --- | --- | --- |
| Rust | `.rs`, 216 files | 96,506 (prod 73,736 / test 22,770) |
| TypeScript | `.ts` + `.tsx`, 663 files | 219,653 (prod 105,309 / test 114,344) |
| JavaScript | `.js` + `.mjs`, 74 files | 12,518 (prod 1,585 / test 10,933) |
| CSS | `.css`, 10 files | 1,181 (all production) |
| HTML | `.html`, 37 files | 4,963 (test fixtures 4,908) |
| **Code total** | 1,000 files | **334,821** (prod 181,866 / test 152,955) |

Marked separately, never mixed into code totals:

- docs (`.md`/`.mdx`): 87 files / 12,395 lines (prod 10,281 / test 2,114);
- JSON (`.json`): 187 files / 30,262 lines (prod 27,657 / test 2,605);
- other text (`.yml`, `.toml`, `.svg`, `.sh`, `.ps1`, `.py`, and the rest): 61 files / 18,933 lines;
- binaries (NUL bytes): 12 files, counted by file only.

Domain split (`[1b]`): `apps/extension` is the largest area (571 code files,
189,067 lines, 97,875 of them tests), then `crates/bsk-cli` (177/86,902),
`packages/dsh-plugin-browserskill` (85/25,970), `evals` (89/15,455, tests by
definition), `crates/bsk-protocol` (39/9,604), `packages/vom` (11/5,359),
`scripts` (12/1,586), `packages/ui` (8/299), `packages/i18n` (8/579).

Honest limit: Rust `#[cfg(test)]` modules inside production `src` files are
physically inseparable and therefore count as production; only `tests/` crates
and `*_test.rs` files are counted as Rust test lines. BSK production is
therefore an upper bound for Rust.

## 2. 0.4 production vs test size, and share of BSK

Code languages only; markdown/JSON/binaries of 0.4 are reported separately
(11 docs files / 5,784 lines; 65 JSON files / 30,271 lines; 12 binaries).

| Metric | 0.4 | BSK 0.5.0 | % of BSK |
| --- | ---: | ---: | ---: |
| Production | 141,973 | 181,866 | 78.1% |
| Test | 119,644 | 152,955 | 78.2% |
| **Total** | **261,617** | **334,821** | **78.1%** |

(Round 64/CUT shrinkage: production 145,869 → **141,973** (-3,896) and test
129,186 → **119,644** (-9,542) because the 0.4 self-invented popup surfaces, their
E2E scripts (`ui-quick-record-e2e.mjs`/`ui-more-menu-e2e.mjs`/`ui-help-e2e.mjs`)
and their unit cases were deleted per the scope audit; the wire-method
classification is unchanged (usable **77/77** scope-conditioned, full **53**,
partial **0**, refused **0**, control **24/24 real**). `--check` is the authority
for this table.)

Area split (`[2]`, regenerated in round 64 from the same generator; round-64
shrinkage is concentrated in `tests` and `extension-ingress`): `packages/protocol`
22,715 lines, `packages/browser-adapter` 32,935, `daemon` 56,238,
`packages/dsh-plugin` 15,184, `packages/collaboration` 8,155, `mcp` 7,701,
`packages/vom` 8,007, `cli` 9,402, `packages/actions` 2,682,
`dsh-runtime` 2,384, `dashboard` 13,312, `tests` **32,556** (round-64 scope
shrink: the three deleted popup E2E scripts and the rewritten `ui-popup-e2e.mjs`),
`scripts` **6,529** (this generator, the round-47 product-compliance gate, the
round-52 `dashboard-size-check.mjs` + `dashboard size` step, the round-54
`--with-fastpath-b`/`--with-ui-visual` wiring, and the round-64 removal of the
three cut opt-in steps), `extension-ingress` **40,151** (the opt-in MV3 ingress
extension; round-64 cut the popup self-invented surfaces down to the 0.3 shell +
read-only help card, UI tree 41 files / 391,825 B, and rewrote
`ui.test.mjs`/`ui-compat.test.mjs`/`background.test.mjs` accordingly),
`bench` 3,213, `probe-extension` 446, `fixtures` 7.
(After AF1/round 63, `scripts` reads **6,850** in `[2]` — the +9 production lines of the
`ui-compat.test.mjs` collection entry in `0.4/scripts/test-all.mjs`.)

Known delta vs older docs: `0.4/STATUS.md` §1 keeps a package snapshot measured
in the narrower old `.js`/`.mjs` "true lines" convention (393 files / 117,865
lines at the Round-665 snapshot); this dashboard counts all code languages
(Rust/TS/JS/CSS/HTML), includes test code and the generator, and drops exactly one
trailing newline per file. The difference is measurement convention, not new
code. Older docs also cite a 329,630-line BSK baseline; the measured baseline
here is 334,821. This dashboard is authoritative only for itself.

## 3. The 77 BSK wire methods

Descriptors and codecs: **77/77 methods, 77/77 codecs, 9/9 features, 23 methods
with action metadata** (asserted by
`0.4/packages/protocol/test/bsk-methods.test.mjs` and
`0.4/packages/protocol/test/conformance.test.mjs`).

### 3a. `tool.*` (53): handler + codec status

`handler` = a `'tool.x':` handler key exists in
`0.4/packages/browser-adapter/src/` or `0.4/packages/actions/src/`;
`codec` = the method has a `BSK_CODECS` entry. All 53 are registered; the
semantics column is the usable classification (section 4): 53 full, 0 partial,
0 refused. Two subsets are **not unconditional**: four of the full handlers
(`session_start`, `session_stop`, `tab_borrow`, `tab_return`) are **full only
with the opt-in extension ingress**, and `tool.cooperate` is **caveated-full**
(round 36) — full only with the opt-in MV3 content script for human attribution
and only with `--cooperate-gate` for one-shot CLI input gating. A daemon with no
injected extension client keeps the typed `E_UNSUPPORTED` gate for the four
session/tab methods, and without the extension client no human signal reaches the
daemon, so the cooperate human/paused hand-back gate is never armed (honest
non-support when the capability is not connected). The requirements are printed
per method in the report's `[3c]`/`[3e]` blocks.

| # | method | owner | effect | handler | codec | semantics |
| ---: | --- | --- | --- | :---: | :---: | --- |
| 1 | `tool.cooperate` | extension | control_plane | yes | yes | full (caveated-full, rounds 36-39) - real overlay/authority/context/wait carrier via CDP + action gate on DOM actions + strict `document_token` binding + daemon/CLI plane + human-attribution state machine + `--cooperate-gate` one-shot CLI gate (13/13). Round 37: attribution is an **exact native-dispatch-timestamp match** (±1.5 ms; a 20 ms near-miss is human; `fill` remains window-mode because `Input.insertText` has no timestamp) and browser-side lifecycle facts (`session.ended` from `tabs.onMoved`/`onRemoved`/`windows.onRemoved`) land on the same opt-in extension. Round 39 (A3b): that lifecycle fact is consumed end to end (session ended/released, borrowed tabs returned) and the shared extension surface gained the A3a borrow confirmation UI and borrow-fidelity restore; those are session/tab evidence, and the cooperate scope conditions themselves are unchanged. Scope conditions: attribution needs the opt-in MV3 content script (plain CDP `isTrusted` cannot separate a person from CDP input); one-shot CLI input paths gate only when the invocation passes `--cooperate-gate`; without the extension the human/paused hand-back gate is not armed. Evidence: headed-Edge E2E 129/129 + ingress E2E 128/128 + strict doc-token 33/33 |
| 2 | `tool.session_start` | extension | control_plane | yes | yes | full - opt-in extension ingress: real Agent Window via `chrome.windows.create`; round 39 (A3b) tracks the home tab as `agent_created` and routes a page-opened tab back to a user window (never a default target, `pendingRoutingTabs` never a default target); without the extension client: typed `E_UNSUPPORTED` (hint `session.start`/`session.open`) |
| 3 | `tool.session_stop` | extension | control_plane | yes | yes | full - opt-in extension ingress: returns every borrowed tab, releases the Agent Window; round 39 (A3b) fixes the written order return-borrowed -> clear-refs -> close-agent-created(incl. home) -> remove-window-only-when-no-user-tab, with observed tabs preserved (`window_released:false` + `preserved_tab_ids`); without the extension client: typed `E_UNSUPPORTED` (hint `session.close`) |
| 4 | `tool.window_resize` | extension | browser_mutation | yes | yes | full |
| 5 | `tool.emulate` | extension | browser_mutation | yes | yes | full |
| 6 | `tool.tab_list` | extension | passive_read | yes | yes | full |
| 7 | `tool.tab_create` | extension | browser_mutation | yes | yes | full |
| 8 | `tool.tab_close` | extension | browser_mutation | yes | yes | full |
| 9 | `tool.tab_borrow` | extension | browser_mutation | yes | yes | full - opt-in extension ingress: real user tab moved by `chrome.tabs.move`; round 39 (A3a) adds the real confirmation UI (active-tab shadow-DOM banner via `chrome.scripting`, inactive-tab `chrome.notifications` fallback, 60 s timeout, fail-closed `E_BORROW_CONFIRM_UNAVAILABLE`/`E_BORROW_DENIED`/`E_BORROW_TIMEOUT`, never a default allow) and the pre-move snapshot of original window/index + neighbour ids + group metadata + pinned; without the extension client: typed `E_UNSUPPORTED` (hint `tool.tab_create`/`session.open`) |
| 10 | `tool.tab_return` | extension | browser_mutation | yes | yes | full - opt-in extension ingress: moves the borrowed tab back to its original window/index (`fallback:false` when the window still exists); round 39 (A3a) adds the return fidelity: pinned-zone clamp, neighbour anchoring, group restore/rebuild, fallback window (`fallback:true`) when the original window vanished, honest `snapshot_degraded` when the snapshot is missing; without the extension client: typed `E_UNSUPPORTED` (hint `tool.tab_create`) |
| 11 | `tool.tab_select` | extension | browser_mutation | yes | yes | full |
| 12 | `tool.navigate` | extension | browser_mutation | yes | yes | full |
| 13 | `tool.navigate_back` | extension | browser_mutation | yes | yes | full |
| 14 | `tool.navigate_forward` | extension | browser_mutation | yes | yes | full |
| 15 | `tool.reload` | extension | browser_mutation | yes | yes | full |
| 16 | `tool.click` | extension | browser_mutation | yes | yes | full |
| 17 | `tool.hover` | extension | transient_input | yes | yes | full |
| 18 | `tool.drag` | extension | browser_mutation | yes | yes | full |
| 19 | `tool.wheel` | extension | browser_mutation | yes | yes | full |
| 20 | `tool.scroll_to` | extension | browser_mutation | yes | yes | full |
| 21 | `tool.focus` | extension | browser_mutation | yes | yes | full |
| 22 | `tool.blur` | extension | browser_mutation | yes | yes | full |
| 23 | `tool.fill` | extension | browser_mutation | yes | yes | full |
| 24 | `tool.press` | extension | browser_mutation | yes | yes | full |
| 25 | `tool.select` | extension | browser_mutation | yes | yes | full |
| 26 | `tool.upload` | extension | browser_mutation | yes | yes | full |
| 27 | `tool.download` | extension | browser_mutation | yes | yes | full |
| 28 | `tool.snapshot` | extension | passive_read | yes | yes | full |
| 29 | `tool.observe` | extension | transient_input | yes | yes | full |
| 30 | `tool.get_html` | extension | passive_read | yes | yes | full |
| 31 | `tool.read` | extension | passive_read | yes | yes | full |
| 32 | `tool.extract` | extension | passive_read | yes | yes | full |
| 33 | `tool.screenshot` | extension | passive_read | yes | yes | full |
| 34 | `tool.screenshot_full_page` | extension | transient_input | yes | yes | full |
| 35 | `tool.screenshot_read` | extension | passive_read | yes | yes | full |
| 36 | `tool.screenshot_release` | extension | control_plane | yes | yes | full |
| 37 | `tool.console` | extension | passive_read | yes | yes | full |
| 38 | `tool.debug` | extension | control_plane | yes | yes | full - all 24/24 DebugActions (capabilities + capture reads/export/pin/wait/operations + Fetch rules + replay + performance + aggregate/duplicates) through the injected session-bound client and CLI `--debug`; round 39 (A4b): fed operations carry the bounded `request_ids`/`console_ids` correlation and `replay` defaults to the **browser** source (in-page `fetch` over CDP `Runtime.evaluate`) with Node `fetch` only as the explicit `fallback:true` source; boundaries in SCOPE-DECISIONS §3.3 |
| 39 | `tool.network` | extension | passive_read | yes | yes | full |
| 40 | `tool.evaluate` | extension | browser_mutation | yes | yes | full |
| 41 | `tool.dialog_status` | extension | passive_read | yes | yes | full |
| 42 | `tool.dialog_accept` | extension | browser_mutation | yes | yes | full |
| 43 | `tool.dialog_dismiss` | extension | control_plane | yes | yes | full |
| 44 | `tool.operation_await` | daemon | passive_read | yes | yes | full |
| 45 | `tool.operation_cancel` | daemon | control_plane | yes | yes | full |
| 46 | `tool.wait_for_navigation` | extension | passive_read | yes | yes | full |
| 47 | `tool.wait_for_element` | extension | passive_read | yes | yes | full |
| 48 | `tool.wait_ms` | daemon | passive_read | yes | yes | full |
| 49 | `tool.request_help` | extension | passive_read | yes | yes | full - real in-page overlay |
| 50 | `tool.record_start` | extension | browser_mutation | yes | yes | full |
| 51 | `tool.record_stop` | extension | passive_read | yes | yes | full |
| 52 | `tool.record_await` | extension | passive_read | yes | yes | full |
| 53 | `tool.video` | extension | control_plane | yes | yes | full - adapter default is H.264/fMP4 (`start` without `format`, `capabilities.format:"mp4"`, `mp4-verify` gates `playable`), explicit `format:"avi"` keeps MJPEG AVI, unsupported pages fail typed `E_UNSUPPORTED` without an AVI fallback; real daemon-side catalog (record+sweep, cross-process `list`/`save`/`discard`); round 39 (A4a): the daemon-native `session-video` default is **MP4** too and every recording/catalog entry carries the fixed session `tab_id`/`window_id` + `owner:'daemon'` (null when unreadable; `owner:'extension'` reserved), leaving only a browser/extension-owned catalog as a written boundary |

Caveated-full evidence (same as the generator `[3e]`): `tool.cooperate` is
**full**, but only under the written scope conditions below — without the opt-in
the capability is reduced or not armed. This is deliberately a separate bucket
from "partial" (missing semantics) and from the four extension-ingress methods.

| method | requires (opt-in) | default without the opt-in | file / evidence |
| --- | --- | --- | --- |
| `tool.cooperate` | opt-in MV3 content script (`0.4/extension-ingress/content/human-watch.js`: `isTrusted`-only capture, per-tab arming against `ext.arm_input` with the adapter native dispatch timestamp, exact ±1.5 ms clock match (E2E exercises ±1.2 ms because the browser quantizes CDP timestamps to 0.1 ms; 1.4/1.6 boundary in unit tests); `fill` is the one window-mode exception because `Input.insertText` has no timestamp); one-shot CLI input paths need the explicit `--cooperate-gate` flag | no extension → no human signal reaches the daemon, so the human/paused hand-back gate is **not armed**; no `--cooperate-gate` → the one-shot CLI input paths keep the pre-round ungated behavior. Session-plane actions can still enforce the negotiated `target`/`strict` policy without a human signal | `0.4/packages/browser-adapter/src/cooperate-handlers.js` (overlay/authority/ephemeral context/observation + `actionGate` + strict `document_token` re-read; `action-handlers.js` native timestamp arm), `0.4/daemon/browser-daemon.mjs` (human input → paused → 2 s auto hand-back; `session.ended` consumption), `0.4/extension-ingress/content/human-watch.js` (exact clock match), `0.4/extension-ingress/src/sessions.js` (A3b observed/agent_created ownership + the single session_stop order through which the lifecycle end/release/return runs), `0.4/extension-ingress/src/borrow.js` (A3a real borrow confirmation UI + borrow-fidelity snapshot/return on the same opt-in surface), `0.4/extension-ingress/test/smoke.mjs` (**339/339** A3a/A3b fixtures), `0.4/cli/bridge-remote.mjs` (`createOneShotCooperateGate`), `0.4/tests/cooperate-attribution-e2e.mjs` (headed-Edge E2E **129/129**, exact ±1.2 ms agent (inside the 1.5 ms bound) / +20 ms human / window-mode +20 ms agent), `0.4/tests/extension-ingress-e2e.mjs` (headed-Edge E2E **128/128**, 3 lifecycle scenarios), `0.4/packages/browser-adapter/test/cooperate-handlers.test.mjs` (strict doc-token **33/33**), `0.4/cli/bridge-remote.test.mjs` (`--cooperate-gate` **13/13**) |

Extension-ingress evidence (same as the generator `[3c]`): these four are **full**
because a real headed-Edge E2E proves the BSK effect on live `chrome.*` state
(`0.4/tests/extension-ingress-e2e.mjs`, **128/128 checks**, independent
`chrome.tabs`/`chrome.windows` inspector double-check, clean teardown), but they
are **opt-in**: a daemon with no injected extension client still throws typed
`E_UNSUPPORTED` before any CDP/window effect, which is why the opt-in requirement
and the default are printed next to each method in the report. **Round 39
(A3a/A3b)** deepened the extension-side semantics behind these four: the borrow
decision is a real user decision (shadow-DOM confirmation banner + notifications
fallback, fail-closed deny/timeout — no default allow), the return restores
group/pinned/neighbour position with a fallback window, the Agent Window tracks
`agent_created` vs `observed` ownership, a page-opened tab is routed back to a
user window and never becomes the default target, and `session_stop` has one
written teardown order. Evidence: extension smoke **339/339** (A3a/A3b fixtures)
and `browser-daemon.test.mjs` **69/69**; the three A3a codes
`E_BORROW_DENIED`/`E_BORROW_TIMEOUT`/`E_TAB_PIN_FAILED` are registered in
`0.4/extension-ingress/src/errors.js` and asserted by smoke.

| method | requires (opt-in) | default without the extension client | file / evidence |
| --- | --- | --- | --- |
| `tool.session_start` | MV3 extension ingress + `chrome.windows.create` | `E_UNSUPPORTED` (hint `session.start`/`session.open`) | `0.4/packages/browser-adapter/src/session-handlers.js`, `0.4/daemon/browser-daemon.mjs`, `0.4/extension-ingress/src/{bridge.js,sessions.js}` (A3b: home tab `agent_created`, page-opened tab routed back to a user window, never a default target), `0.4/tests/extension-ingress-e2e.mjs` (real `agent_window_id`, windows +1) |
| `tool.session_stop` | MV3 extension ingress + `chrome.windows`/`chrome.tabs` | `E_UNSUPPORTED` (hint `session.close`) | `0.4/packages/browser-adapter/src/session-handlers.js`, `0.4/daemon/browser-daemon.mjs` (returns borrowed tabs on close), `0.4/extension-ingress/src/sessions.js` (A3b: single teardown order, observed tabs preserved, `window_released:false` + `preserved_tab_ids` when a user tab remains), `0.4/daemon/browser-daemon.test.mjs` (69/69), `0.4/tests/extension-ingress-e2e.mjs` (`window_released`, `returned_tab_ids`, empty `return_failures`) |
| `tool.tab_borrow` | MV3 extension ingress + `chrome.tabs.move` | `E_UNSUPPORTED` (hint `tool.tab_create`/`session.open`) | `0.4/packages/browser-adapter/src/borrow-handlers.js`, `0.4/extension-ingress/src/borrow.js` (A3a: real confirmation UI — shadow-DOM banner via `chrome.scripting` for the active tab, `chrome.notifications` fallback, 60 s timeout, fail-closed deny/timeout; snapshot of original window/index + neighbour ids + group + pinned), `0.4/extension-ingress/test/smoke.mjs` (339/339), `0.4/tests/extension-ingress-e2e.mjs` (original window/index + tab physically in the Agent Window) |
| `tool.tab_return` | MV3 extension ingress + `chrome.tabs.move` | `E_UNSUPPORTED` (hint `tool.tab_create`) | `0.4/packages/browser-adapter/src/borrow-handlers.js`, `0.4/extension-ingress/src/borrow.js` (A3a: pinned-zone clamp, neighbour anchoring, group restore/rebuild, fallback window with `fallback:true`, honest `snapshot_degraded`), `0.4/extension-ingress/test/smoke.mjs` (339/339), `0.4/tests/extension-ingress-e2e.mjs` (back to original window/index, `fallback:false`, inspector re-check) |

### 3b. Control plane (24): before/after the alias wave

`before` = canonical 0.4 daemon wire only, plus the `system.*` protocol handlers;
a mapped name that is not canonical shows as `alias-planned` in the before column
(even if the plane itself landed this round). `after` = live state with the daemon
control-plane alias wave (`0.4/daemon/transport.mjs` `BSK_METHODS` +
`0.4/daemon/server.mjs` `BSK_MAPPED_METHODS`); the generator reads those arrays
and reports `wave source: live` when they are present.

| method | before | after | note / evidence |
| --- | --- | --- | --- |
| `local_auth.pair` | absent | real | local device trust store (`0.4/daemon/local-auth.mjs`): creates a pending device, returns a 5-minute link carrying its key plus a 6-digit code; the only credential-free HTTP route, loopback-only since round 28 (`transport.mjs` `publicMethodAccess`; a non-loopback request is 403 + `E_LOCAL_ONLY`, and WS has no pair route) |
| `local_auth.devices` | absent | real | trust-store device summaries (`kind:"local"`, label/status/created/activated/expires/rotate_requested/gen; never a key) |
| `local_auth.revoke` | absent | real | marks one device (or `all:true`) revoked and bumps `gen`; unknown id -> typed `E_NOT_FOUND` |
| `local_auth.rotate` | absent | real | two-phase rotation: 10-minute pending key while the old key keeps working; the first use of the new key commits it |
| `local_auth.set_mode` | absent | real | persists `warn` (default) / `required` / `trust_local`; `authorize` applies the mode per request |
| `audit.request` | alias-planned | real | mapped to the WAL/audit query path (`0.4/daemon/server.mjs` `BSK_MAPPED_METHODS`, WAL in `0.4/daemon/daemon-wal.mjs`) |
| `ledger.request` | alias-planned | real | mapped to `ledger.list` / `ledger.pending` (`0.4/daemon/server.mjs`, WAL in `0.4/daemon/daemon-wal.mjs`) |
| `system.handshake` | real | real | protocol handlers (`0.4/packages/protocol/src/system.js`) + live daemon status snapshot |
| `system.ping` | real | real | same |
| `system.status` | real | real | same |
| `session.start` | alias-planned | real | mapped to `daemon.sessionOpen()` |
| `session.start_tracked` | alias-planned | real | mapped to tracked session start (`0.4/daemon/server.mjs`); now backed by the real `session.request` plane (`0.4/daemon/session-requests.mjs`) |
| `session.request` | alias-planned | real | mapped to the real managed-start request plane (`prepare/cancel/claim/status` + tombstones) in `0.4/daemon/session-requests.mjs`; the plane itself landed this round |
| `session.stop` | alias-planned | real | mapped to `daemon.sessionClose()`; `{all:true}` -> `session.stop_all` |
| `session.stop_all` | alias-planned | real | closes every known session; per-session failures stay in the reply |
| `session.list` | real | real | already a canonical 0.4 wire name (shared name, no alias needed) |
| `session.run_log` | alias-planned | real | mapped to the session/record log path (`0.4/daemon/server.mjs`, `0.4/daemon/session-record.mjs`) |
| `browser.list` | alias-planned | real | browser/session/tab snapshot from daemon status |
| `transfer.begin` | alias-planned | real | mapped to the daemon transfer store (`0.4/daemon/server.mjs` `createTransferStore`) |
| `transfer.chunk` | alias-planned | real | same |
| `transfer.finish` | alias-planned | real | same |
| `transfer.read` | alias-planned | real | same |
| `transfer.release` | alias-planned | real | same |
| `cancel` | alias-planned | real | mapped to the in-flight request registry (cancel by `rpc_id`) |

The typed-unsupported answer is deliberate: a method that is routed but not
implemented answers the stable BSK wire code `unsupported` with
`data.daemonCode: "E_UNSUPPORTED_METHOD"` plus a hint instead of a generic 404
`unknown_method`; that is explicit non-support, not coverage. After the alias
wave **and** the local-auth round the generator reports **24 real**,
**0 explicit-unsupported** and **0 absent**: the five `local_auth.*` names were
the last typed refusals and are now a real control plane
(`0.4/daemon/local-auth.mjs`, wired by `0.4/daemon/server.mjs`,
`0.4/daemon/transport.mjs`, `0.4/daemon/ws-transport.mjs` and the CLI). The
before column lists them as `absent` on purpose: they were never part of the
original alias plan, so the synthetic before-wave baseline does not credit a
plan that never existed. `session.request` is a real managed-start request plane
(`0.4/daemon/session-requests.mjs`: token `<expiry-unix-ms>:<uuid>`,
`prepare/cancel/claim/status`, monotonic cancel tombstones, bounded registry,
reaper; `session.start_tracked` fails closed without a prepared request), and
`session.start_tracked` is backed by it.

There is also a separate contract-only alias table,
`0.4/packages/protocol/src/aliases.js` (25 legacy-name -> BSK-name aliases,
24 unique BSK targets). It is exported and conformance-tested but imported by no
runtime dispatcher, so it adds **zero** live wire coverage. Do not count it.

## 4. What "usable" means, and honest counts

Definitions:

- **registered** - a handler key exists and the method has a codec. This is
  callable but says nothing about semantics.
- **full** - registered and implements the BSK semantics on a live ingress. It
  is not state-only, metadata-only, timeout-only or a single debug action.
- **caveated-full** (new in round 36) - implements the BSK semantics and is
  E2E-proven, but only under a **recorded opt-in scope condition** (the
  requirements and the default without them are printed in the report's `[3e]`
  block). It is counted full for the same reason the extension-ingress four are,
  but it is **not** an always-on capability claim; it is a separate bucket from
  partial (missing semantics).
- **audited full evidence (round 39)** - `tool.video`/`tool.debug` are full and
  are additionally listed in the report's `[3f]` block with the current evidence
  for their recorded semantics (daemon default MP4 + fixed tab identity + catalog
  owner; operations correlation + browser-source replay). This bucket is
  **evidence only**: it changes no classification and no count, and the guard in
  the generator fails if a listed method stops being full.
- **real control** - the control-plane method has a runtime-equivalent
  implementation behind the BSK name (mapped by the daemon), or is a canonical
  0.4 wire name with the same semantics.
- **explicit-unsupported** - routable, answers the typed `unsupported` error.
  **Counts as 0 usable.**
- **refused (tool)** - registered and codec-valid, but 0.4 cannot deliver the
  BSK semantics and there is no honest partial: throws typed `E_UNSUPPORTED`
  before any CDP/window effect. **Counts as 0 usable and is not a partial
  handler.** The bucket is **empty since round 34**: the last four (session
  start/stop, tab borrow/return) are full under the opt-in extension ingress and
  their no-extension behavior is the documented `E_UNSUPPORTED` gate.
- **BSK-name wire** - the daemon HTTP/WS allowlist accepts the exact BSK name.
  Canonical 0.4 names (`session.open`, `act`, `observe`, etc.) do not count.
- **usable** - full tool handler + real control method. Partial and refused tool
  handlers are excluded from the headline and reported as separate buckets.
  A full handler that needs the opt-in extension ingress (the four session/tab
  methods) or the round-36 cooperate scope conditions is counted full because
  the opt-in E2E proves the effect; it is not counted as always-on capability.

| Count | Before the wave | After the wave |
| --- | ---: | ---: |
| Tool handlers registered | 53/53 | 53/53 |
| Full tool handlers | 48 | **53** (4 of them opt-in extension ingress + 1 caveated-full `tool.cooperate`) |
| Partial tool handlers (caveat) | 1 | **0** |
| Refused tool handlers (typed `E_UNSUPPORTED`) | 4 | **0** |
| Control methods real | 4/24 | **24/24** |
| Control methods alias-planned | 15/24 | 0/24 |
| Control methods explicit-unsupported | 0/24 | 0/24 |
| Control methods absent | 5/24 | 0/24 |
| BSK-name daemon wire | 1/77 (control 1/24, tool 0/53) | **24/77** (control 24/24, tool 0/53) |
| Adapter-dispatch BSK names | 56/77 (53 tool + 3 system) | 56/77 |
| BSK-name ingress union | 57/77 | 77/77 (0 refuse explicitly) |
| **Usable** | **52/77 = 67.5%** | **77/77 = 100.0%** |
| Usable if partial tools are caveated in | 53/77 = 68.8% | 77/77 = 100.0% |

Reading the numbers honestly:

- `tool.*` is not part of the daemon HTTP/WS allowlist; those 53 names are
  accepted by the adapter dispatch layer (`createAdapterHandlers`), the remote
  CLI and the DSH/MCP executors. That is why daemon-wire coverage stays
  0/53 for tools while adapter-dispatch coverage is 53/53.
- After the wave and the local-auth round, **every** control-plane BSK name is
  real: 24/24 are mapped by the daemon, 0 return the typed unsupported error.
  The usable count is now **77/77 (100.0%)**, but this is **scope-conditioned,
  not unconditional**: 4 full tool handlers (the extension-ingress four) are full
  only when the opt-in extension is attached and the default daemon honestly
  answers them with typed `E_UNSUPPORTED`, and `tool.cooperate` (round 36) is
  full only with the opt-in MV3 content script for human attribution and with
  `--cooperate-gate` for one-shot CLI input gating. "77/77 reachable" remains a
  wire fact; the usable figure is full+real under the recorded conditions, never
  a claim that every method works with no opt-in.
- Nothing here is BSK parity: 0 tool handlers are partial or refused and 0
  control methods are explicit-unsupported, but 5 of the 53 full `tool.*`
  handlers carry a written opt-in condition (`[3c]` + `[3e]`). Round 39 refreshed
  the per-method evidence for video/debug (`[3f]`) and the opt-in
  extension/session/tab surface (`[3c]`/`[3e]`) without changing any
  classification or count.

## 5. Remaining gap priority

P0 = handlers that currently return success while not delivering BSK semantics
(they can mislead callers); P1 = missing feature families that already refuse
honestly; P2 = security/session extras and code hygiene.

Resolved in earlier rounds: `tool.cooperate` no longer returns `adapter:"state-only"`.
It has a real CDP carrier: `enable` binds a real tab and draws an independent
shadow-DOM overlay (`bridgedeck-cooperate-overlay`) via `overlay-render.js`,
`status` returns real authority/epoch probes, `sync` performs a real
`Runtime.evaluate` observation and issues context/observation ids, `wait`
installs an in-page `isTrusted` input collector and applies a quiet window, and
the negotiated `control_policy` (`strict`/`target`) is enforced on cooperate's own
page-writing channel. It now also has a real **adapter action gate**: once a
session is enabled, the `tool.click`/`hover`/`select`/`fill`/`press`/`drag`
entries validate the same context/observation tokens before any CDP call
(`E_CONTEXT_REQUIRED` / `E_OBSERVATION_REQUIRED` / `E_CONTEXT_STALE` /
`E_OBSERVATION_STALE` / `E_CONTEXT_EXPIRED`, `effectState:"none"`, `phase:"gate"`);
read/observe/screenshot stay ungated. The daemon relays the same plane as
`cooperate.enable/sync/status/wait` over HTTP/WS (`browser-daemon.mjs`,
`server.mjs`, `transport.mjs`) and the CLI exposes `--session-cooperate-*` plus
`--context-id`/`--observation-id` on act. Round 35 added the two pieces this page
used to list as caveats: strict-mode `document_token` binding (a changed document
fails typed `E_CONTEXT_STALE` before any effect, and `sync` re-signs) and a real
human-attribution state machine (extension `human.input` -> human/paused ->
`E_SESSION_PAUSED` gate refusal -> 2 s quiet auto hand-back; old context
invalidated), proven by the opt-in headed-Edge E2E **129/129** and the strict
doc-token suite **33/33**. Round 36 reclassifies it from **partial** to
**caveated-full**: the semantics are real and E2E-proven, and the one-shot CLI
input paths are now gated by the explicit `--cooperate-gate` flag (13/13
tests: fake-CDP refusal with zero `Input.*` dispatch, plus a real Edge
`--click`/`--fill` smoke whose `--json` output carries `cooperate_gate`, while an
invocation without the flag stays byte-compatible). The remaining conditions are
**opt-in scope**, not missing semantics, and are printed in the report `[3e]`:
human attribution needs the opt-in MV3 content script (a native-clock
`InputExpectation` is not wired; plain CDP `isTrusted` cannot separate agent
input from a person), and without `--cooperate-gate` the one-shot CLI input paths
keep the pre-round ungated behavior (no gate is enabled for them). The plane
state also stays in-process (adapter/daemon memory, never persisted) — a
documented boundary, not a coverage caveat.
`session.request` is the real managed-start request plane
(`0.4/daemon/session-requests.mjs`) and `session.start_tracked` depends on it.
**Resolved in the local-auth round (2026-11-24)**: the last five typed refusals
(`local_auth.*`) are now a real local device trust store
(`0.4/daemon/local-auth.mjs` plus daemon/transport/WS/CLI wiring), so the
control plane is **24/24 real, 0/24 explicit-unsupported, 0 absent** and usable
coverage was **72/77 (93.5%)** = 48 full `tool.*` + 24 real control methods at
that point; the extension-ingress round below raised it to **76/77 (98.7%)** and
round 36 (`tool.cooperate` caveated-full) raised it to **77/77 (100.0%)**.
Boundaries that stay honest: `pair` is credential-free by design but
**loopback-only** since round 28 (`transport.mjs` `publicMethodAccess`: a
non-loopback pair request is 403 + `E_LOCAL_ONLY`, the WS transport has no pair
route, default bind `127.0.0.1`), the default mode is `warn` (the legacy bearer
token is still accepted), no extension client plane consumes the paired
credential yet, and `system.status.local_auth.last_unpaired_attempt` is now a
real daemon-lifetime record (round 30: `at`/`reason`/optional `device_id`,
memory-only, never persisted, no secret) instead of a hard-coded `null`. `tool.debug` is now **full**
(2026-11-24 debug round): all **24 of 24** BSK DebugActions are real — the
adapter handler (`SUPPORTED_DEBUG_ACTIONS` = `capabilities` + 23 delegated)
reaches the session-bound client the daemon injects, the CLI `--debug <action>`
runs the same actions one-shot, and `0.4/daemon/session-debug.mjs` implements the
Fetch rules (`rules`/`rule_add`/`rule_enable`/`rule_disable`/`rule_remove`:
real `Fetch.requestPaused` interception with block/modify/mock and exactly one
reply per paused request), `replay` (**browser-first since A4b**: in-page `fetch`
over CDP `Runtime.evaluate`, idempotent key, 15 s / 256 KiB bounds, Node `fetch`
only as the explicit `fallback:true` source, aborted by `stop`), `performance`
(CDP `Performance.getMetrics`
mapped to `DebugPerformance`) and `aggregate`/`duplicates` (pure analysis over
the retained run). **Round 39 (A4b)** closed the two non-capability items this
page used to list: a daemon-fed operation carries the bounded
`request_ids`/`console_ids` correlation from its capture window (a miss stays
empty, never invented), and replay defaults to the browser source. Boundaries are
recorded in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §3.3: performance only reads the CDP
metrics domain, rules can only be mutated while a run is recording, and a handler
built without
a client stays capabilities-only (`capabilities.actions` stays `['capabilities']`;
the delegated matrix is `debug_actions`/`supported_actions`). The earlier
capture boundaries still hold: pinned requests are exempt from eviction (50-pin
cap, typed `E_LIMIT`; unknown id → typed `E_NOT_FOUND`), `wait` only polls the
retained run state (`wait_complete`/`wait_timed_out`) and never re-sends the
observed command, and a one-shot CLI run has no daemon action feed, so its
`operations`/`activity` are empty by design. `tool.video` is now **full** (round 33): the adapter default is
H.264/fMP4 — a BSK-parameter `start` (no `format` field) draws the CDP
screencast JPEG frames into an in-page canvas, encodes fragmented MP4 through
`MediaRecorder` and only reports `playable` after `mp4-verify`; `capabilities`
reports `format:"mp4"`, an unsupported page fails typed `E_UNSUPPORTED` with no
AVI fallback, and explicit `format:"avi"` keeps the local MJPEG AVI path. Audio is
not a BSK requirement. Rounds 31-32 added the real daemon-side artifact catalog
(`0.4/daemon/video-catalog.mjs`: 24 h retention / 1 GiB budget / 256 MiB cap,
`record` + `sweep` after `stop`, `video.list/save/discard` over HTTP/WS and CLI,
typed `E_NOT_CONFIGURED` when off). **Round 39 (A4a)** made the daemon-native
`session-video` default MP4 as well and pinned every recording/catalog entry to
the session target's fixed `tab_id`/`window_id` + `owner:'daemon'` (null when
unreadable; legacy indexes normalize to daemon + null identity;
`owner:'extension'` reserved), so the only remaining catalog boundary — recorded
in SCOPE-DECISIONS §3.4, not as a partial classification — is a
browser/extension-owned artifact store. The
control-plane alias wave maps `audit.request`, `session.start_tracked`,
`session.run_log`, `transfer.*` and `cancel` to real 0.4 behavior.
**Resolved in the extension-ingress round (2026-11-24, round 34)**: the last four
typed refusals (`tool.session_start`/`session_stop`/`tab_borrow`/`tab_return`) are
**full** through the opt-in MV3 extension ingress (`0.4/daemon/extension-ingress.mjs`
+ `0.4/extension-ingress/`; adapter handlers delegate via the injected extension
client, and `browser-daemon.mjs` returns every borrowed tab before a session
closes). Evidence is a **real headed-Edge E2E** (`0.4/tests/extension-ingress-e2e.mjs`,
**128/128 checks**) that re-reads live `chrome.tabs`/`chrome.windows` state from the
extension service worker and asserts window +1, tab moved into the Agent Window,
returned to the original window/index, and the window/tab id sets back to
baseline after `session_stop`; plus `handler-codecs` 9/9 and the adapter/daemon
session/borrow suites. The boundary is explicit and measured: the capability is
**opt-in**, and a daemon without an injected extension client still answers the
four with typed `E_UNSUPPORTED` before any effect (the `[3c]` block prints that
default next to each method). Classification: full **48 -> 52**, refused
**4 -> 0**, usable **72/77 -> 76/77 (98.7%)**, caveated-in **77/77**.
**Round 39 (A3a/A3b)** added the extension-side semantics behind these four: a
real borrow confirmation UI (shadow-DOM banner + notifications fallback, 60 s
timeout, fail-closed `E_BORROW_DENIED`/`E_BORROW_TIMEOUT` — never a move), borrow
fidelity (group/pinned/neighbour snapshot with restore/rebuild and a fallback
window), `agent_created` vs `observed` tab ownership, page-opened-tab window
routing (never a default target) and the single `session_stop` teardown order
(return borrowed -> clear refs -> close agent-created -> remove window only when
no user tab remains). Evidence: extension smoke **339/339** (A3a/A3b fixtures),
`browser-daemon.test.mjs` **69/69**, and the same headed-Edge E2E **128/128**. The
three A3a stable codes `E_BORROW_DENIED`/`E_BORROW_TIMEOUT`/`E_TAB_PIN_FAILED`
are registered in `0.4/extension-ingress/src/errors.js` (asserted by smoke).
**Resolved in the round-35 human-attribution round (2026-11-24)**: the
attribution/document-token caveats this page listed before are real now — the
adapter `actionGate` re-reads a per-document `document_token` before every strict
action/wait (`document_token = sha256(location.href | per-document nonce)`,
rotated at every `sync`; mismatch or read failure -> typed `E_CONTEXT_STALE` with
`effectState:"none"` and no dispatch, context kept so `sync` can re-sign), and the
daemon consumes extension `human.input` events into a human/paused state machine
with a 2 s quiet window that automatically hands control back (the issued
context/observation are revoked and the authority epoch advances). Evidence: the
opt-in headed-Edge E2E `0.4/tests/cooperate-attribution-e2e.mjs` **129/129** (an
agent click is not counted as human; pseudo-human CDP `Input.dispatch*` on a
second connection -> human/paused -> gate refuses `E_SESSION_PAUSED` -> 2 s auto
hand-back -> the old context fails `E_CONTEXT_STALE`) and the strict doc-token
suite **33/33**. **Round 36 (2026-11-24) closes the classification**: the
one-shot CLI input paths are gated by the explicit `--cooperate-gate` flag
(13/13: fake-CDP refusal with zero dispatch, real Edge click/fill smoke,
byte-compatible no-flag output), so `tool.cooperate` moves from **partial** to
**caveated-full** — full **52 -> 53**, partial **1 -> 0**, usable
**76/77 (98.7%) -> 77/77 (100.0%)**, caveated-in **77/77**. The 100% is
scope-conditioned: the `[3e]` block prints the opt-in MV3 content-script
requirement for human attribution and the per-invocation `--cooperate-gate`
requirement for one-shot CLI gating, plus the defaults without them; the plane
state staying in-process is a documented boundary, not a coverage caveat.

| Priority | Gap | Methods | Concrete files | Exit condition |
| --- | --- | --- | --- | --- |
| ~~P1~~ | ~~Gated DOM actions~~ — **closed round 36**: human attribution + strict `document_token` (round 35) and the one-shot CLI `--cooperate-gate` (round 36) are real; `tool.cooperate` is caveated-full | — | `0.4/packages/browser-adapter/src/cooperate-handlers.js`, `0.4/cli/bridge-remote.mjs` (`createOneShotCooperateGate`), `0.4/daemon/browser-daemon.mjs`, `0.4/tests/cooperate-attribution-e2e.mjs`, `0.4/cli/bridge-remote.test.mjs` | done: no-flag output byte-compatible, gated refusal dispatches no `Input.*`; remaining opt-in conditions (`[3e]`) and in-process state are recorded boundaries, not missing semantics |
| **P2** | Local pairing works and `pair` is now loopback-only (round 28); the credential still has no client plane, and the last unpaired attempt is recorded only in daemon memory (round 30) rather than persisted | `local_auth.*` | `0.4/daemon/local-auth.mjs`, `0.4/daemon/server.mjs` (`publicMethods: ['local_auth.pair']`), `0.4/daemon/transport.mjs` (`publicMethodAccess`), `0.4/daemon/ws-transport.mjs` | a real local client plane consuming the link/credential and a **persisted** `last_unpaired_attempt` in `system.status.local_auth` (the in-memory `at`/`reason`/`device_id` record and the loopback-source gate — non-loopback pair → 403 `E_LOCAL_ONLY`, WS never pairs — are done) |
| **P2** | Dead alias table | 25 aliases in `0.4/packages/protocol/src/aliases.js` | `0.4/packages/protocol/src/aliases.js`, `0.4/packages/protocol/src/index.js`, `0.4/packages/protocol/test/conformance.test.mjs` | either wire `aliasFor()` into a real ingress or delete it so it cannot be mistaken for wire coverage |

## 6. How the generator computes these numbers

`0.4/scripts/bsk-coverage.mjs` is **read-only** (it only calls
`readFileSync`; it never writes). It reads the BSK tree, the 0.4 tree,
`methods-bsk.js`, `codecs-bsk.js`, `aliases.js`, `daemon/transport.mjs`,
`daemon/server.mjs` and the browser-adapter/actions handler sources.

Rules (identical for both trees):

1. **Walk**: every file under the tree, skipping directories named
   `node_modules`, `target`, `dist`, `.git` at any depth.
2. **Lines**: `text.split(/\r?\n/)`, then drop one trailing empty element caused
   by a final newline. Interior blank lines are counted. A file containing a NUL
   byte is a binary: counted by file only, never by lines.
3. **Language**: code = `.rs` (Rust), `.ts/.tsx/.mts/.cts` (TypeScript),
   `.js/.mjs/.cjs` (JavaScript), `.css`, `.html/.htm`. `.md/.mdx` = docs;
   `.json` = JSON; everything else textual = "other text". Only code enters the
   production/test totals.
4. **Test vs production**: a path is test when it has a directory segment
   `tests`, `test`, `__tests__`, `e2e`, `evals`, `fixtures` or `fixture`, or its
   basename matches `*.test.*` / `*.spec.*` / `*_test.rs` / `test_*.rs`.
5. **Tool handlers**: scan `0.4/packages/browser-adapter/src/*.js` and
   `0.4/packages/actions/src/*.js` for `'tool.<name>':` object keys; scan
   `0.4/packages/protocol/src/system.js` for `'system.<name>':` keys.
6. **Codecs**: import `BSK_CODECS` and require one entry per method (77/77).
7. **Control status**: parse `const METHODS_04 = ...` and
   `export const BSK_METHODS = ...` from `daemon/transport.mjs` (canonical wire
   and wave allowlist) and `BSK_MAPPED_METHODS` from `daemon/server.mjs` (which
   BSK names map to real 0.4 behavior). `real = canonical BSK names + mapped`;
   `explicit-unsupported = wave names - mapped`; `absent = 24 - real -
   unsupported`. When the wave arrays are missing the report says
   `wave source: declared only` and the after numbers collapse to the before
   numbers instead of inventing coverage.
8. **Usable** = full tool handlers + real control methods; partial and refused
   tool handlers are separate buckets and count as 0 usable. "Full" is audited by
   hand (section 3a) from the handler bodies, because "metadata-only" and "typed
   refusal" are not visible in a static scan. Two audited sub-buckets keep the
   report honest about opt-ins: the extension-ingress four are **full only with
   the opt-in extension** (`EXTENSION_INGRESS_TOOLS`, printed in `[3c]`) and
   `tool.cooperate` is **caveated-full only under the recorded scope conditions**
   (`CAVEATED_FULL_TOOLS`, printed in `[3e]`). Both buckets are validated: a
   listed method must be classified full or the generator fails. The synthetic
   "before" usable figure excludes both so a reclassification cannot raise both
   sides of the delta. Round 39 adds a third, **evidence-only** bucket
   (`FULL_EVIDENCE_TOOLS`, printed in `[3f]`) for `tool.video`/`tool.debug`: it
   changes no classification and no count, and the same "listed method must be
   full" guard applies.
9. **Verification**: the report block below is compared byte-for-byte by
   `--check`, and the check also fails if any of the 77 method names is missing
   from this page or a refused handler is absent from the refusal list.

Update command:

```powershell
node 0.4/scripts/bsk-coverage.mjs          # print the current report
node 0.4/scripts/bsk-coverage.mjs --check  # verify this page matches it (exit 1 on drift)
node 0.4/scripts/bsk-coverage.mjs --json   # machine-readable figures
```

Canonical report (verbatim generator output; do not hand-edit inside the markers):

<!-- BSK-COVERAGE:START -->

BSK 0.5.0 usable-coverage — read-only report (no files written)
source: ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0
target: 0.4
rules: lines = split(/\r?\n/) with one trailing empty line dropped; test = test-ish path segment or *.test.*/*.spec.*/*_test.rs; excludes node_modules/target/dist/.git and generated dist-extension-ingress* staging copies; binaries (NUL byte) rejected from line counts.

[1] BSK code inventory by language
| language   | files |    prod |    test |   total |
| ---------- | ----: | ------: | ------: | ------: |
| Rust       |   216 |  73,736 |  22,770 |  96,506 |
| TypeScript |   663 | 105,309 | 114,344 | 219,653 |
| JavaScript |    74 |   1,585 |  10,933 |  12,518 |
| CSS        |    10 |   1,181 |       0 |   1,181 |
| HTML       |    37 |      55 |   4,908 |   4,963 |

[1b] BSK code inventory by domain
| domain                           | files |   prod |   test |   total |
| -------------------------------- | ----: | -----: | -----: | ------: |
| crates/bsk-protocol              |    39 |  9,467 |    137 |   9,604 |
| crates/bsk-cli                   |   177 | 64,269 | 22,633 |  86,902 |
| apps/extension                   |   571 | 91,192 | 97,875 | 189,067 |
| packages/vom                     |    11 |  2,506 |  2,853 |   5,359 |
| packages/ui                      |     8 |    299 |      0 |     299 |
| packages/i18n                    |     8 |    302 |    277 |     579 |
| packages/dsh-plugin-browserskill |    85 | 12,611 | 13,359 |  25,970 |
| evals                            |    89 |      0 | 15,455 |  15,455 |
| scripts                          |    12 |  1,220 |    366 |   1,586 |

[1c] Marked separately (never mixed into code totals)
| kind                     | BSK files | BSK lines | 0.4 files | 0.4 lines |
| ------------------------ | --------: | --------: | --------: | --------: |
| docs (.md/.mdx)          |        87 |    12,395 |        11 |     5,883 |
| json (.json)             |       187 |    30,262 |        65 |    30,271 |
| other text               |        61 |    18,933 |        11 |       540 |
| binary (file count only) |        12 |       n/a |        12 |       n/a |

[2] 0.4 code inventory by area
| area                     | files |   prod |   test |  total |
| ------------------------ | ----: | -----: | -----: | -----: |
| packages/protocol        |    60 | 21,628 |  1,087 | 22,715 |
| packages/browser-adapter |   140 | 17,925 | 15,010 | 32,935 |
| packages/actions         |    17 |  1,774 |    908 |  2,682 |
| packages/vom             |    41 |  4,802 |  3,205 |  8,007 |
| packages/collaboration   |    32 |  5,291 |  2,864 |  8,155 |
| packages/dsh-plugin      |    46 |  8,087 |  7,097 | 15,184 |
| daemon                   |    37 | 31,057 | 25,181 | 56,238 |
| cli                      |     4 |  5,107 |  4,295 |  9,402 |
| mcp                      |     8 |  3,005 |  4,696 |  7,701 |
| dsh-runtime              |     3 |  1,065 |  1,319 |  2,384 |
| dashboard                |    25 |  8,231 |  5,081 | 13,312 |
| bench                    |     4 |  2,375 |    838 |  3,213 |
| scripts                  |    32 |  6,161 |    368 |  6,529 |
| tests                    |    25 |      0 | 32,590 | 32,590 |
| probe-extension          |     2 |    446 |      0 |    446 |
| extension-ingress        |    69 | 25,019 | 15,132 | 40,151 |
| fixtures                 |     1 |      0 |      7 |      7 |

[2b] 0.4 vs BSK 0.5.0 (code lines only)
| metric     |     0.4 | BSK 0.5.0 | pct of BSK |
| ---------- | ------: | --------: | ---------: |
| production | 141,973 |   181,866 |      78.1% |
| test       | 119,678 |   152,955 |      78.2% |
| total      | 261,651 |   334,821 |      78.1% |

[3] 77 wire methods
methods: 77 = tool.* 53 + control-plane 24
codecs: 77/77
tool handlers: 53/53 (full 53, partial 0, refused 0)
refused tool handlers: 0/53 typed E_UNSUPPORTED (counted as 0 usable; never folded into partial)
extension-ingress full tool handlers: 4/53 full only with the opt-in extension ingress (MV3 0.4/extension-ingress/); the default daemon without an injected extension client still answers them with typed E_UNSUPPORTED
caveated-full tool handlers: 1/53 full only under the written scope conditions in [3e] (counted full because the BSK effect is E2E-proven; NOT an always-on capability claim)
round-39 audited full evidence (A3a/A3b/A4a/A4b; evidence only, classification and counts unchanged): 2/53 refreshed (tool.debug, tool.video)
missing tool handlers: none
missing codecs: none
control after alias wave: real 24/24, explicit-unsupported 0/24, absent 0/24
control before alias wave: real 4/24, alias-planned 15/24, absent 5/24
daemon BSK-name wire: before 1/77 (tool 0/53, control 1/24) -> after 24/77 (tool 0/53, control 24/24)
adapter-dispatch BSK names: 56/77 (tool 53/53 + system 3/24)
BSK-name ingress union: before 57/77 -> after 77/77
usable (full tool + real control; partial and refused excluded): before 52/77 = 67.5% -> after 77/77 = 100.0%
usable caveat (rounds 36-37): the after figure is usable coverage, not an unconditional capability claim — 4 full tool handlers are full only with the opt-in extension ingress ([3c]) and 1 is full only under the scope conditions in [3e]
usable incl. partial tool handlers (caveat count): 77/77 = 100.0%
not usable after: 0/77 = 0 partial tool + 0 refused tool + 0 explicit-unsupported control
legacy alias table (protocol/src/aliases.js, contract only; no runtime importer): 25 aliases -> 24 unique BSK targets
wave source: live transport.mjs METHODS_04(48) + BSK_METHODS(23), server.mjs BSK_MAPPED_METHODS(24)

[3a] control-plane methods (24): before -> after
| method                | before wave   | after wave | evidence                                                         |
| --------------------- | ------------- | ---------- | ---------------------------------------------------------------- |
| local_auth.pair       | absent        | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| local_auth.devices    | absent        | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| local_auth.revoke     | absent        | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| local_auth.rotate     | absent        | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| local_auth.set_mode   | absent        | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| audit.request         | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| ledger.request        | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| system.handshake      | real          | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| system.ping           | real          | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| system.status         | real          | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.start         | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.start_tracked | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.request       | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.stop          | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.stop_all      | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.list          | real          | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| session.run_log       | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| browser.list          | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| transfer.begin        | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| transfer.chunk        | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| transfer.finish       | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| transfer.read         | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| transfer.release      | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |
| cancel                | alias-planned | real       | 0.4/daemon/server.mjs BSK_MAPPED_METHODS -> existing 0.4 runtime |

[3b] partial tool handlers (0)
| method | reason | evidence |
| ------ | ------ | -------- |

[3c] extension-ingress full tool handlers (4) — full only with the opt-in extension ingress; the default daemon (no injected extension client) still answers typed E_UNSUPPORTED
| method             | requires                                                                    | default without ingress                                                                        | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tool.session_start | opt-in extension ingress (MV3 0.4/extension-ingress/ + chrome.windows)      | typed E_UNSUPPORTED without an injected extension client (hint session.start / session.open)   | 0.4/packages/browser-adapter/src/session-handlers.js, 0.4/daemon/browser-daemon.mjs (createIngressExtensionClient relay), 0.4/extension-ingress/src/bridge.js + sessions.js (A3b: the session home tab is tracked as agent_created, a page-opened tab in the Agent Window is routed back to a user window and never becomes the default target, pendingRoutingTabs is never a default target), 0.4/tests/extension-ingress-e2e.mjs (headed Edge E2E 128/128, incl. 3 real lifecycle scenarios: real agent_window_id + chrome.windows count +1, inspector double-check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| tool.session_stop  | opt-in extension ingress (MV3 0.4/extension-ingress/ + chrome.windows/tabs) | typed E_UNSUPPORTED without an injected extension client (hint session.close)                  | 0.4/packages/browser-adapter/src/session-handlers.js, 0.4/daemon/browser-daemon.mjs (closeSession returns borrowed tabs before closing), 0.4/extension-ingress/src/sessions.js (A3b: stopSession is the single written order — return borrowed tabs (a still-borrowed failure aborts the rest) -> clear extension refs -> close agent_created tabs incl. the home -> remove the window only when no user/observed tab remains, otherwise window_released:false + preserved_tab_ids; observed/borrowed tabs are never closed), 0.4/daemon/browser-daemon.test.mjs (69/69), 0.4/tests/extension-ingress-e2e.mjs (headed Edge E2E 128/128: window_released, returned_tab_ids, empty return_failures, window/tab ids back to baseline; session.ended also ends/releases through the same path)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| tool.tab_borrow    | opt-in extension ingress (MV3 0.4/extension-ingress/ + chrome.tabs.move)    | typed E_UNSUPPORTED without an injected extension client (hint tool.tab_create / session.open) | 0.4/packages/browser-adapter/src/borrow-handlers.js, 0.4/daemon/browser-daemon.mjs (borrowed-tab ownership), 0.4/extension-ingress/src/borrow.js + commands.js (A3a: the borrow decision is a real user decision — active tab gets a shadow-DOM confirmation banner injected through chrome.scripting, an inactive tab gets a chrome.notifications fallback, closing the notification / 60 s timeout is deny, no "default allow" path; a restricted page or a missing confirmation channel fails closed with typed E_BORROW_CONFIRM_UNAVAILABLE, deny -> E_BORROW_DENIED, timeout -> E_BORROW_TIMEOUT and the tab is not moved; before the move it snapshots original window/index, neighbor tab ids, group{id,title,color,collapsed}, pinned and the pinned-prefix count, and a failed tabs.move rolls the state back), 0.4/extension-ingress/test/smoke.mjs (347/347, incl. the A3a confirm/snapshot/rollback fixtures), 0.4/tests/extension-ingress-e2e.mjs (headed Edge E2E 128/128: original_window_id/index + chrome.tabs.get windowId == agent window; a borrowed tab moved inside the Agent Window raises session.ended(user_moved_tab))                                                                   |
| tool.tab_return    | opt-in extension ingress (MV3 0.4/extension-ingress/ + chrome.tabs.move)    | typed E_UNSUPPORTED without an injected extension client (hint tool.tab_create)                | 0.4/packages/browser-adapter/src/borrow-handlers.js, 0.4/extension-ingress/src/borrow.js (A3a return fidelity: a pinned tab is clamped into the pinned prefix and a normal tab never lands in it; the position is anchored on the recorded neighbor tab ids (left first, then right, then the original index) and clamped; the original tab group is re-joined when it still exists, otherwise recreated with title/color/collapsed copied, a group the user changed meanwhile is respected, and a pinned tab reports group_skipped:"pinned"; a vanished original window falls back to the lastFocused normal non-incognito window, then any normal non-incognito window, then a newly created normal window with fallback:true; a missing snapshot degrades honestly to snapshot_degraded instead of pretending a perfect restore), 0.4/daemon/browser-daemon.mjs (returns every borrowed tab on session close), 0.4/extension-ingress/test/smoke.mjs (347/347: snapshot/restore/group-rebuild/fallback/pinned fixtures), 0.4/tests/extension-ingress-e2e.mjs (headed Edge E2E 128/128: returned_to_window_id/index match, fallback=false, inspector re-check; session.ended returns borrowed tabs before ending) |

[3d] refused tool handlers (0) — typed E_UNSUPPORTED, not usable (empty since the extension-ingress round)
| method | code | reason | evidence |
| ------ | ---- | ------ | -------- |

[3e] caveated-full tool handlers (1) — full, but only under the recorded scope conditions; without the opt-in the capability is reduced or not armed
| method         | requires (opt-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | default without the opt-in                                                                                                                                                                                                                                                                                                                                                                                                                         | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tool.cooperate | human attribution needs the opt-in MV3 content script (0.4/extension-ingress/content/human-watch.js: isTrusted-only capture, per-tab arming against ext.arm_input) and uses the adapter native dispatch timestamp for exact matching: the arm timestamp is the same epoch-ms value passed to CDP Input.*, converted into the frame monotonic clock (performance.timeOrigin) and required to be within ±1.5 ms (a 20 ms near-miss is human); plain CDP isTrusted cannot separate a person from CDP input. The same opt-in extension surface also reports the browser-side lifecycle facts (session.ended from tabs.onMoved/onRemoved/windows.onRemoved, A3b) that the daemon consumes to end the session, release the Agent Window and return borrowed tabs, and its borrow plane uses the A3a confirmation UI and borrow-fidelity snapshots; those session/tab facts are evidenced in [3c]/[3f], while the cooperate scope conditions themselves are unchanged | without the extension no human signal reaches the daemon, so the human/paused hand-back gate is not armed; one-shot CLI input paths (--click/--fill/--press/--select/--drag/--hover/--focus/--wheel) are gated only when that invocation passes the explicit --cooperate-gate flag (13/13), otherwise they keep the pre-round ungated behavior. Session-plane actions can still enforce the negotiated target/strict policy without a human signal | 0.4/packages/browser-adapter/src/cooperate-handlers.js (+ action-handlers.js native timestamp arm), 0.4/daemon/browser-daemon.mjs (human input -> paused -> auto hand-back), 0.4/extension-ingress/content/human-watch.js (exact clock match; fill stays window-mode because Input.insertText has no timestamp), 0.4/extension-ingress/src/sessions.js (A3b observed/agent_created ownership + the single session_stop order; the lifecycle session.ended consumer ends/releases/returns through it), 0.4/extension-ingress/src/borrow.js (A3a real borrow confirmation UI + borrow-fidelity snapshot/return), 0.4/extension-ingress/test/smoke.mjs (347/347 A3a/A3b fixtures), 0.4/cli/bridge-remote.mjs (createOneShotCooperateGate), 0.4/tests/cooperate-attribution-e2e.mjs (headed Edge E2E 131/131: exact ±1.2ms -> agent, window-mode +20ms -> agent, exact +20ms -> human/paused), 0.4/packages/browser-adapter/test/cooperate-handlers.test.mjs (strict document_token 33/33), 0.4/cli/bridge-remote.test.mjs (--cooperate-gate 13/13) |

[3f] audited full-tool evidence refreshed in round 39 (A3a/A3b/A4a/A4b) — evidence only: the classification/counts stay full 53 / partial 0 / refused 0, and the opt-in scope stays in [3c]/[3e]
| method     | reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tool.debug | All 24 BSK DebugActions stay real (round 29) and A4b/round 39 closed the two previously written non-capability gaps: a daemon-fed operation is correlated with the captured evidence (a bounded window join yields request_ids/console_ids; a miss stays empty and is never invented, and the correlation is refreshed before a run is retained), and replay defaults to the browser source (in-page fetch through CDP Runtime.evaluate, so the replayed request is page-originated and a CORS/cross-origin failure surfaces as the browser error) with the Node fetch path kept as the explicit fallback:true / no-live-CDP source. Remaining written boundaries: performance only reads the CDP Performance metrics domain; Fetch rules are mutable only while a run records; a one-shot CLI run has no daemon action feed (operations/activity empty by design); a handler built without a client stays capabilities-only. | 0.4/daemon/session-debug.mjs (SESSION_DEBUG_CORRELATION window join + recordOperation request_ids/console_ids; SESSION_DEBUG_REPLAY sources=[browser,node], default_source=browser, fallback_source=node; page fetch via Runtime.evaluate; 15 s / 256 KiB / 20-replay bounds), 0.4/packages/browser-adapter/src/debug-handlers.js (capabilities + 23 delegated actions), 0.4/daemon/browser-daemon.mjs (per-session debug client + action feed), tests: session-debug.test.mjs 55/55 (correlation match/miss, browser replay, Node fallback), browser-daemon.test.mjs 69/69, server.test.mjs 83/83                                                                                                                                                                           |
| tool.video | The BSK-parameter default is MP4 on both planes (adapter default since round 33; the daemon-native session-video default turned MP4 in A4a/round 39). Every recording is pinned to the session target tab_id/window_id (null when unreadable, never invented) and is registered as owner:"daemon"; an explicit format:"avi"/"mjpeg-avi" still writes the verified local MJPEG AVI artifact, and an MP4-unsupported page fails typed E_UNSUPPORTED instead of an AVI renamed to .mp4. The remaining written boundary is catalog ownership: owner:"extension" is reserved but never written, so a browser/extension-owned catalog with fixed-tab authorization is not claimed.                                                                                                                                                                                                                                                  | 0.4/daemon/session-video.mjs (SESSION_VIDEO_DEFAULT_FORMAT=mp4, SESSION_VIDEO_OWNER=daemon, startIdentityOf -> tab_id/window_id on the start/status/stop views and the catalog record), 0.4/daemon/video-catalog.mjs (tab_id/window_id/owner per entry, VIDEO_CATALOG_OWNERS=[daemon,extension], DEFAULT_VIDEO_CATALOG_OWNER=daemon, legacy indexes normalize to daemon + null identity), 0.4/daemon/browser-daemon.mjs + server.mjs (identity passthrough on video.start/stop), tests: session-video.test.mjs 13/13, video-catalog.test.mjs 16 pass + 1 skip (POSIX mode bit on Windows), browser-daemon.test.mjs 69/69, server.test.mjs 83/83; the adapter MP4 path stays pinned by video-handlers 15/15 + the eval video-default-mp4 case + the stage-gate video mp4 step |

[6] verification
doc block: the fenced report is delimited by the BSK-COVERAGE start/end HTML comments
check: node 0.4/scripts/bsk-coverage.mjs --check
generator is read-only: it opens files with readFileSync only.
partial and refused tool handlers are separate buckets: neither is usable coverage.
the extension-ingress handlers are full (headed-Edge E2E on live chrome.* state) but opt-in: without the extension client they keep the typed E_UNSUPPORTED gate.
tool.cooperate is full since round 36, but only under the [3e] scope conditions: the human-attribution state machine needs the opt-in MV3 content script (extension human-watch.js; plain CDP isTrusted cannot separate a person from CDP input); since round 37 the attribution uses the adapter native dispatch timestamp (ext.arm_input timestamp -> CDP Input.* timestamp -> |event.timeStamp - armed_at| <= 1.5 ms exact match; one documented window-mode boundary: fill, because Input.insertText carries no timestamp). The one-shot CLI input paths gate only when the invocation passes --cooperate-gate. Evidence: headed-Edge E2E 131/131 (0.4/tests/cooperate-attribution-e2e.mjs: exact ±1.2ms -> agent, window-mode +20ms -> agent, exact +20ms -> human/paused), strict document_token 33/33 (cooperate-handlers.test.mjs), CLI --cooperate-gate 13/13 (bridge-remote.test.mjs). Without the extension the human/paused hand-back gate is not armed; no flag means the pre-round ungated one-shot behavior.
browser-side lifecycle facts (round 37): the extension subscribes tabs.onMoved / tabs.onRemoved / windows.onRemoved, reports extension.event session.ended(user_moved_tab|tab_closed|window_closed) only for a borrowed tab or the session Agent Window (1000 ms dedupe; self-closed Agent Window suppressed for 2000 ms; window-closing tab removals skipped), and the daemon ends the session, releases the window and returns borrowed tabs (bounded tombstone; system.status.extension.lifecycle_events/last_event). It does NOT subscribe tabs.onDetached/onAttached, so a cross-window move is not reported as user_moved_tab. Evidence: headed-Edge E2E 128/128 (0.4/tests/extension-ingress-e2e.mjs, 3 lifecycle scenarios).
video ownership / daemon default MP4 (round 39, A4a): daemon-native session-video default is MP4 (explicit avi/mjpeg-avi and its typed MP4-unavailable failure are unchanged), every recording carries the fixed tab_id/window_id of the session target (null when unreadable, never invented) and owner:"daemon" on the start/status/stop views and the catalog entry; video-catalog normalizes legacy indexes (no identity) to owner daemon + null identity, and owner:"extension" remains reserved (a browser/extension-owned catalog with fixed-tab authorization is still a written boundary). Evidence: session-video.test 13/13, video-catalog.test 16 pass + 1 skip (POSIX mode bit), browser-daemon.test 69/69, server.test 83/83.
debug operations correlation / browser replay (round 39, A4b): a daemon-fed operation is joined with the captured evidence by a bounded time window and carries request_ids/console_ids (a miss stays empty, never invented; the running correlation is refreshed before retain), and replay defaults to source "browser" (in-page fetch through CDP Runtime.evaluate; CORS/cross-origin failure is the browser error) with the Node fetch path as the explicit fallback:true / no-live-CDP source, still bounded to 15 s / 256 KiB / 20 replays per run. Evidence: session-debug.test 55/55, browser-daemon.test 69/69, server.test 83/83.
session/tab fidelity + routing (round 39, A3a/A3b): borrow is a real user decision (active-tab shadow-DOM banner via chrome.scripting, inactive-tab notifications fallback, 60 s timeout, fail-closed E_BORROW_CONFIRM_UNAVAILABLE / E_BORROW_DENIED / E_BORROW_TIMEOUT, never a default allow), the pre-move snapshot records original window/index + neighbor ids + group metadata + pinned, the return clamps pinned/normal zones, re-anchors on neighbors, restores or rebuilds the tab group, and falls back to a normal non-incognito window (or a new one, fallback:true) when the original window vanished; page-opened tabs in the Agent Window are routed back to a user window and never become the default target (pendingRoutingTabs is never a default target), observed tabs are never closed, and session_stop follows return borrowed -> clear refs -> close agent-created (incl. home) -> remove the window only when no user tab remains. Evidence: extension-ingress smoke 347/347 (A3a/A3b fixtures; manifest exactly four declared content scripts incl. collect.js and record-capsule.js), browser-daemon.test 69/69, headed-Edge E2E 128/128.

<!-- BSK-COVERAGE:END -->

## 7. What changed this round

- **Round 2 (refusal/honesty wave)**: added this dashboard and the read-only
  generator `0.4/scripts/bsk-coverage.mjs` (`--check`, `--json`); moved
  `tool.session_start`, `tool.session_stop`, `tool.tab_borrow` and
  `tool.tab_return` into a new explicit **refused** bucket; `tool.debug`
  enumerates the 24 BSK debug actions and refuses the other 23 with typed
  `E_UNSUPPORTED` (never `E_NOT_IMPLEMENTED`); `tool.video`'s caveat is narrowed
  to the missing H.264/MP4 encode path.
- **BSK control-plane alias wave**: 23 BSK control names added to the transport
  allowlist (+`session.list`, already canonical), **19 mapped** to real 0.4
  behavior, **5** returning the typed `unsupported` code instead of a generic
  404. This took BSK-name daemon wire coverage from 1/77 to 24/77 and usable
  coverage from 50/77 (64.9%) to 65/77 (84.4%).
- **Round 3 (2026-11-23, this wave)**:
  - `session.request` + `session.start_tracked` are now a real managed-start
    request plane (`0.4/daemon/session-requests.mjs`): `<expiry-unix-ms>:<uuid>`
    tokens, `prepare/cancel/claim/status`, monotonic cancel tombstones, bounded
    registry, reaper, fail-closed start without a prepared request, HTTP+WS
    routes and `initialize.bsk` 19 real / 5 unsupported / 24. Control plane
    18→19 real, usable 64/77→65/77.
  - `tool.cooperate` moved from `state-only` to a real CDP carrier: tab binding
    via a Runtime probe, independent shadow-DOM overlay
    `bridgedeck-cooperate-overlay`, authority generation/revision/epoch, real
    `sync` context/observation issuance, `wait` with an in-page `isTrusted`
    collector + quiet window, overlay action channel (`take_control` /
    `dismiss`), and the negotiated `control_policy` enforced on cooperate's own
    page writes. Still **partial** on purpose: generic `tool.click`/`fill`/`press`
    entries are not gated; page `isTrusted` cannot separate CDP input from a
    person; the CLI exposes only `enable/status`; state is per-process. (The gate
    and CLI parts were closed in round 6, below; attribution and state remain.)
  - Video MP4 spike (`docs/VIDEO-MP4-SPIKE.md`): headless Edge MediaRecorder
    reports H.264/fMP4 support, so an opt-in MP4 round is feasible; that round
    makes no MP4 claim and `tool.video` stays partial.
- **Round 4 (2026-11-23, opt-in MP4 round)**:
  - `tool.video` has a real opt-in H.264/fMP4 path: `format:"mp4"` (adapter), plus
    daemon/CLI passthrough (`--video start --format mp4`,
    `--session-video-start <id> mp4`). The same CDP screencast JPEG frames are
    drawn into an in-page canvas and encoded by
    `MediaRecorder('video/mp4;codecs=avc1.42E01E')` into a fragmented MP4; `stop`
    writes the bytes and `mp4-verify` independently re-parses `ftyp`/`moov`
    (`avc1`) /`moof`+`mdat` and the real sample durations. Unsupported browsers
    fail with typed `E_UNSUPPORTED` — no AVI renamed to `.mp4`.
  - Evidence: `video-handlers.test.mjs` 15/15, `session-video.test.mjs` 7/7, a
    real headless-Edge smoke (`0.4/tests/e2e/video-mp4-smoke.mjs`, 17 frames,
    `verify ok`, in-page `<video>` decode), a real `--video start --format mp4`
    CLI run (h264/mp4, verify ok, playable), and the new `video mp4` stage-gate
    step. The default artifact and the default AVI stage-gate step are unchanged.
  - Still **partial**: BSK is MP4-only (`bsk video start` has no `format` field;
    BSK capabilities report `format:"mp4"`), so a BSK-parameter call gets 0.4's
    default MJPEG AVI; 0.4 recordings were adapter-process-local at this round (no
    browser/extension-owned catalog, no fixed-tab identity, no cross-process
    `list`/`save`), unlike BSK's browser-owned 24h artifacts. **Superseded by
    Round 14**: a real daemon-side persistent catalog now exists (record + sweep
    after `stop`, cross-process `video.list/save/discard`), still daemon-owned
    rather than browser-owned.
- **Round 5 (2026-11-23, daemon debug capture plane)**: a real per-session debug
  capture plane now exists on the daemon (`0.4/daemon/session-debug.mjs`): it
  folds real CDP `Network.*`/`Runtime.*`/`Page.*` events into a retained run
  (requests/console/pages/operations), redacts URLs/headers/bodies with the
  adapter rules, bounds each kind (requests 200 / console 500 / pages 100 /
  operations 200, 512 KiB body cap), pages `query` 1..100 with `next_since`,
  writes a JSON `export`, and keeps runs in daemon memory only (dropped on
  session close; 26/26 module tests). It is wired as BridgeDeck-native
  `debug.start/stop/status/query/export` (`browser-daemon.mjs`, `transport.mjs`,
  `server.mjs`) and the CLI exposes `--session-debug-start/stop/status/query/
  export`; browser-daemon 43/43, server 64/64, transport 23/23, ws-transport
  18/18. **It does not change the coverage classification**: `tool.debug` is a
  BSK adapter handler that still answers `capabilities` only and refuses the
  other 23 DebugActions with typed `E_UNSUPPORTED`; the daemon plane is not the
  BSK ingress and rules/replay/performance are not implemented, so the method
  stays **partial**. The generator `[3b]` reason now states exactly this.
- **Round 6 (2026-11-23, cooperate gate + daemon/CLI plane)**: the generic action
  entries now honor the negotiated `control_policy`. `tool.cooperate` exposes an
  `actionGate(params)` (same `sessions`/token store as `wait`) and the adapter
  injects it into the click/hover/select/fill (`action-handlers.js`), press
  (`press-handlers.js`) and drag (`drag-handlers.js`) factories; the daemon also
  injects it when it builds the adapter fallback itself
  (`browser-daemon.mjs`), and `act` forwards `session_id` +
  `context_id`/`observation_id` to it. A refusal is raised as
  `adapterError(code, ..., { effectState:'none', phase:'gate' })` before any CDP
  call; an action without an enabled session is passed through unchanged, and
  read/observe/screenshot are never gated. The daemon now exposes the plane as
  `cooperate.enable/sync/status/wait` over HTTP and WS (`transport.mjs` 4 new
  methods, `server.mjs` routes, `initialize` advertises them) with snake/camel
  parameter normalization and the adapter gate codes preserved, and the CLI adds
  `--session-cooperate-enable/sync/status/wait` plus `--control-policy`,
  `--context-id`, `--observation-id`, `--timeout-ms`, `--quiet-ms` (act also
  takes the token flags). Evidence: `cooperate-handlers.test.mjs` 25/25,
  action suites 8/8 + 3/3 + 4/4 + dispatch 9/9, browser-daemon 47/47, server
  68/68, transport 24/24, ws-transport 18/18, bridge-daemon-client 81/81 (238
  daemon/CLI cooperation-related tests in the five files). **Classification is
  unchanged**: `tool.cooperate` stays **partial**, never usable. This round
  supersedes round 3's "generic actions not gated" and "CLI exposes only
  enable/status" statements. Remaining boundaries: one-shot CLI
  `--click`/`--fill`/`--press` still build ungated handlers, `isTrusted` cannot
  separate CDP input from a person, `sync` and actions are not tied by a
  `document_token` comparison, and state is per-process/in-memory. The generator
  `[3b]` reason now states exactly this.
- **Round 7 (2026-11-23, debug delegation + dsh mp4 enum)**: `tool.debug` now
  delegates its capture reads. `debug-handlers.js` exports
  `SUPPORTED_DEBUG_ACTIONS` (capabilities + 9 delegated actions) and
  `UNSUPPORTED_DEBUG_ACTIONS` (14), accepts an injected
  `debug` client (`createDebugHandlers({ debug })`), and maps BSK
  start/stop/status/export/requests/request/console/pages/activity onto the
  session-bound daemon store (requests/console/pages come from `query`, `request`
  scans by id and falls back to url/status/method filters, `activity` maps the
  latest `operations` record or falls back to the run status). `dispatch-handlers.js`
  passes the client through, `browser-daemon.mjs` injects the per-session client
  (`sessionDebugClientFor`) into every session and adapter-fallback path, and the
  CLI adds one-shot `--debug <action>` (11 verbs: `capabilities` + 10 capture
  reads; local store, auto stop on exit, exit does not lose evidence). Without a
  client the handler stays capabilities-only, and `capabilities.actions` is still
  `['capabilities']` (the 0.4 live-case frozen assertion); the real matrix is
  advertised as `debug_actions` + `supported_actions`. The 14 remaining actions
  (`rules`/`rule_*`/`replay`/`performance`/`aggregate`/`duplicates`/`operations`/
  `operation`/`wait`/`pin`/`unpin`) return typed `E_UNSUPPORTED` with
  `supported_actions`; `operations` needs a daemon action-loop feed
  (`recordOperation()` is not called outside tests), so `activity` has no
  daemon-fed data yet. Evidence: `debug-handlers.test.mjs` 17/17, dispatch 10/10,
  browser-daemon 49/49, and a real Edge CLI smoke (`requests`/`console`/`export`/
  `start`/`stop`/`status`/`query`/`request`). **Classification is unchanged**:
  `tool.debug` stays **partial** (10 of 24 actions real is not the BSK debug
  contract; rules/replay/performance/operations remain absent). `dsh-plugin` also
  exposes the already-verified MP4 path in its own schema:
  `SESSION_VIDEO_FORMATS` and the `video_start.format` tool enum add `mp4`
  (`plugin.test.mjs` 15/15 + `session-tools.test.mjs` 26/26 = 41). Video stays **opt-in** by decision: BSK has no
  `format` field and is MP4-only, so defaulting 0.4 to MP4 would change the 0.4
  contract, not close the gap; the decision and the audit evidence are recorded in
  `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §3.4/§6/§7 and
  `docs/VIDEO-MP4-SPIKE.md`.
- **Round 8 (2026-11-23, debug pin/unpin/wait)**: `tool.debug` now delegates **13
  of 24** actions. `0.4/daemon/session-debug.mjs` gained `pin`/`unpin` (pinned
  requests are exempt from the retained-request eviction; at most 50 pinned at
  once, past which it is typed `E_LIMIT`; an unknown request id is typed
  `E_NOT_FOUND`; `export` reports the live `pins` count) and `wait` (polls the
  retained run state, `wait_complete` when the run stopped / `wait_timed_out`
  when `wait_ms` 0..60000 elapsed while still recording, and it **never
  re-sends** the observed command). `debug-handlers.js` maps BSK
  `pin`/`unpin`/`wait` onto the injected client (`id` also accepted as
  `request_id`/`requestId`; `wait` normalizes `wait_ms`, echoes an optional
  `command_id`), the daemon debug client exposes `pin`/`unpin`/`wait`, and the
  one-shot CLI adds `--debug pin|unpin|wait` with `--debug-id <id>`. Evidence:
  `session-debug.test.mjs` 31/31, `debug-handlers.test.mjs` 21/21,
  `browser-daemon.test.mjs` 49/49, `bridge-daemon-client.test.mjs` 81/81 and a
  real CLI `--debug wait` smoke. **Classification is unchanged**: `tool.debug`
  stays **partial** — the other 11 actions (rules/rule_* / replay / performance /
  aggregate / duplicates / operations / operation) still refuse typed
  `E_UNSUPPORTED`, `operations` still has no daemon action-loop feed, and an
  unbound handler stays capabilities-only. The generator `[3b]` reason states
  exactly this.
- **Round 9 (2026-11-23, debug operations feed)**: `tool.debug` now delegates **15
  of 24** actions. The missing `operations` collection is now fed by the daemon:
  while a session's debug run records, `browser-daemon.mjs` records every
  dispatched `act` (the adapter action name, target ref/selector, started/
  finished timestamps, `completed`/`error` + the error text) and every explicit
  `observe` as one operation through `session-debug`'s bounded
  `recordOperation()` (200 records/run), fail-soft — a broken feed never changes
  the action result or masks its original error, and no debug run means zero
  writes. `debug-handlers.js` adds `operations` (paged
  `query({kinds:['operations']})`) and `operation` (paged id scan, miss ->
  `operation:null` + `truncated`), and the one-shot CLI adds
  `--debug operations|operation` (`--debug-id` for `operation`, `--since/--limit`
  for `operations`); a one-shot CLI run has no daemon feed, so its
  `operations`/`activity` are empty by design. Evidence: `browser-daemon.test.mjs`
  50/50 and `debug-handlers.test.mjs` 24/24 (74/74 combined) plus a real Edge CLI
  smoke. **Classification is unchanged**: `tool.debug` stays **partial** — the
  other 9 actions (rules/rule_* / replay / performance / aggregate / duplicates)
  still refuse typed `E_UNSUPPORTED`, and fed operations carry no
  `request_ids`/`console_ids` correlation links yet. The generator `[3b]` reason
  states exactly this.
- **Round 10 (2026-11-24, local auth)**: the five `local_auth.*` control methods
  are real. `0.4/daemon/local-auth.mjs` is a persistent local device trust store
  (`pair` link/code, device summaries, revoke, two-phase rotate, three-mode
  `set_mode`, per-request `authorize`, atomic 0600 writes, per-secret salted
  SHA-256 hashes, no plaintext keys); `server.mjs` maps all five into
  `BSK_MAPPED_METHODS` (a build without the module keeps the honest 19/5
  fallback), makes `pair` the only credential-free HTTP route, routes the other
  four through `authorize`, exposes `system.status.local_auth` (mode and paired
  device count; `last_unpaired_attempt` stays `null`), and
  `transport.mjs`/`ws-transport.mjs` take an injectable `authorize` callback for
  all three credential channels with mid-session rotation; the CLI adds
  `--local-auth-pair/devices/revoke/rotate/set-mode`. Control plane **19 -> 24
  real / 0 unsupported / 0 absent**, usable **65 -> 70/77 (90.9%)**. Evidence:
  `local-auth.test.mjs` 19/19, transport 26/26, ws-transport 20/20, server 72/72,
  bridge-daemon-client 87/87 (224/224). Honest risks: `pair` is credential-free
  (loopback bootstrap — do not expose `--host 0.0.0.0` without `required` plus a
  firewall), the default mode is `warn`, no extension client plane consumes the
  paired credential yet, and `last_unpaired_attempt` is not implemented.
- **Round 11 (2026-11-24, pair loopback-only)**: the credential-free
  `local_auth.pair` bootstrap is now transport-enforced loopback-only.
  `transport.mjs` exports `publicMethodAccess(method, publicMethods, address)`: a
  listed public method is served only to a loopback peer (`127.0.0.0/8`, `::1`,
  `::ffff:127.x`); any other peer gets **403** + `data.daemonCode =
  "E_LOCAL_ONLY"` and never reaches the handler. The WS transport has no pair
  route (the upgrade is the auth boundary), so a tokenless client pairs over HTTP
  from the same host only; the default bind stays `127.0.0.1`. Evidence:
  `transport.test.mjs` 27/27 (one new classifier test; round 27 was 26), test-all
  1519/1519. **Classification is unchanged**: control plane 24/24 real, usable
  70/77. This supersedes round 10's "do not expose `--host 0.0.0.0`" caveat with
  the stronger statement that `pair` itself is refused off-loopback.
- **Round 12 (2026-11-24, debug full)**: `tool.debug` left the partial bucket —
  all **24 of 24** BSK DebugActions are now real. `0.4/daemon/session-debug.mjs`
  gained the Fetch request-rule plane (`rules`/`rule_add`/`rule_enable`/
  `rule_disable`/`rule_remove`: `Fetch.requestPaused` patterns per enabled rule,
  block via `Fetch.failRequest(BlockedByClient)`, modify via
  `Fetch.continueRequest` with rewritten url/method/headers, mock via
  `Fetch.fulfillRequest` (+ optional abortable delay); `times`/`exhausted`, exactly
  one reply per paused request, 32-rule cap), `replay` (Node `fetch`, idempotent
  key, 15 s / 256 KiB bounds, 20 replays, `stop` aborts), `performance` (CDP
  `Performance.getMetrics`, at most 10 snapshots per run, mapped to
  `DebugPerformance`), and the pure analyses `aggregate` (endpoint groups with
  nearest-rank p50/p95) and `duplicates` (retry suspects inside `window_ms`);
  `debug-handlers.js` maps all of them (24 actions = `capabilities` + 23
  delegated) and the CLI `--debug <action>` covers the 24 verbs. Tests:
  `session-debug.test.mjs` 48/48, `debug-handlers.test.mjs` 34/34,
  dispatch 10/10, browser-daemon 52/52 (handler/daemon 86/86 combined), plus a
  real Edge CLI smoke. **Classification changes: full 46 -> 47, partial 3 -> 2,
  usable 70/77 (90.9%) -> 71/77 (92.2%)**. Boundaries are in
  `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §3.3 (replay on Node `fetch`,
  performance CDP-metrics-only, rules mutable only while recording, no
  cross-process artifact).
- **Round 13 (2026-11-24, local_auth `last_unpaired_attempt`)**: the last
  `local_auth.*` status gap is closed. `0.4/daemon/local-auth.mjs` records the
  last rejected `authorize()` outcome in daemon memory (`deny()` writes
  `{ at, reason, device_id? }`) and exposes a real `snapshot()`
  (`mode`, `daemon_id`, `paired_devices`, `last_unpaired_attempt`, `devices`
  summaries — never a key). `server.mjs` `system.status.local_auth` now derives
  its view from that snapshot instead of hard-coding the field to `null`, so
  `last_unpaired_attempt` reports the concrete rejection (`missing_token`,
  `unknown_token`, `revoked`, `expired`, `legacy_disabled`, `not_loopback`).
  Boundaries: the record is memory-only (daemon lifetime, never persisted), it
  carries no key or hash, and a fresh daemon honestly reports `null` until the
  first rejection. Tests: `local-auth.test.mjs` 20/20 (one new snapshot/rejection
  test on top of the round-27 19; fresh store honestly `null`). **Classification
  is unchanged**: control plane 24/24 real, usable 71/77 (92.2%); only the 0.4
  line totals move (`daemon` 31,832 -> 31,893; production 86,102 -> 86,137;
  total 146,000 -> 146,061). This supersedes round 10's
  "`last_unpaired_attempt` is not implemented" and the section 5 P2 exit
  condition's in-memory part; a **persisted** record and the client plane remain.
- **Round 14 (2026-11-24, video catalog rounds 31-32)**: the recording artifact
  catalog is now real and wired end to end. `0.4/daemon/video-catalog.mjs` is a
  persistent catalog (atomic 0600 JSON index, 24 h retention, 1 GiB total budget,
  256 MiB/entry cap, `list`/`get`/`save`/`discard`/`sweep`/`stats`, pinned entries
  exempt, missing/discarded tombstones, corrupt index read as empty and healed on
  the next write). `session-video.mjs` records every finished artifact after
  `stop` (`record()` + `sweep()`, best-effort — a catalog failure never loses the
  artifact or fails `stop()`) and exposes
  `catalogList/Save/Discard/Stats`; `browser-daemon.mjs` injects and passes
  through the catalog; `transport.mjs` `METHODS_04` gains
  `video.list/video.save/video.discard` (**31 -> 34**); `server.mjs` routes them
  (typed `E_NOT_CONFIGURED` when no catalog, never an empty fake page) and the CLI
  adds `--session-video-list/save/discard`. Tests: `video-catalog` 15 pass + 1
  skip (POSIX mode bit), `session-video` 13/13, transport 27/27, ws-transport
  20/20, browser-daemon 53/53, server 74/74, bridge-daemon-client 91/91.
  **Classification is unchanged**: `tool.video` stays **partial** (BSK is
  MP4-only, so the default/BSK-param path is still MJPEG AVI; the catalog is
  daemon-owned, not browser-owned). Only the measured 0.4 line totals move
  (`daemon` 31,893 -> 34,413; `cli` 6,182 -> 6,493; production 86,137 -> 87,611;
  test 59,924 -> 61,288; total 146,061 -> 148,899). The generator's `[3b]` reason
  for `tool.video` now states exactly this.
- **Round 15 (2026-11-24, adapter default MP4 -> `tool.video` full)**: the
  adapter default artifact is now H.264/fMP4, matching BSK's MP4-only contract.
  A `tool.video start` without a `format` field draws the same CDP screencast
  JPEG frames into an in-page canvas and encodes fragmented MP4 through
  `MediaRecorder('video/mp4;codecs=avc1.42E01E')`; the recording only reports
  `playable:true` after `mp4-verify` independently re-parses
  `ftyp`/`moov`(`avc1`)/`moof`+`mdat`. `capabilities` now reports
  `format:"mp4"` / `default_format:"mp4"` with a real probe-backed
  `default_format_available`; an unsupported page fails typed
  `E_UNSUPPORTED` (no silent AVI fallback) and the local MJPEG AVI path stays
  reachable only through an explicit `format:"avi"` (adapter/CLI). The
  daemon-native `session-video` default remained MJPEG AVI at that round
  (**superseded by Round 39/A4a**: the daemon default is MP4 and every
  recording/catalog entry carries the fixed `tab_id`/`window_id` +
  `owner:'daemon'`). Evidence:
  `video-handlers` 15/15 (default-MP4 success, refusal and verify-failure
  cases), eval/CLI `video-default-mp4` on real Edge (bare `--video start`)
  plus the explicit `--format avi` sibling, `handler-codecs` 9/9,
  `live-runner` 22/22, test-all 1578 passed / 1 skipped, eval 43/43.
  **Classification changes: full 47 -> 48, partial 2 -> 1, usable 71/77
  (92.2%) -> 72/77 (93.5%)**. Boundaries kept honest (SCOPE-DECISIONS §3.4):
  the catalog is daemon-owned and a recording has no extension/browser-owned
  fixed-tab identity.
- **Round 16 (2026-11-24, extension ingress -> the last four refusals become full)**:
  the opt-in MV3 extension ingress (`0.4/extension-ingress/` +
  `0.4/daemon/extension-ingress.mjs`, wired through `server.mjs`/`browser-daemon.mjs`
  and the adapter's `session-handlers.js`/`borrow-handlers.js`) closes the last
  four typed refusals. `tool.session_start` creates a real Agent Window through
  `chrome.windows.create` (width/height 100..7680, `interaction` reported),
  `tool.tab_borrow` moves a real user tab into that window with
  `chrome.tabs.move` and records original window/index, `tool.tab_return` moves it
  back (fallback only when the original window is gone), and `tool.session_stop`
  returns every borrowed tab before removing the window; `browser-daemon.mjs`
  also returns borrowed tabs on session close/idle/shutdown and never closes a
  user tab. Evidence: `0.4/tests/extension-ingress-e2e.mjs` — **real headed Edge**,
  **87/87 checks**, staged MV3 extension on a real daemon/WS ingress, with an
  independent CDP inspector reading the extension service worker's
  `chrome.tabs`/`chrome.windows`: window count +1, borrowed tab physically in the
  Agent Window, returned to the original window/index with `fallback:false`, and
  window/tab id sets back to baseline after `session_stop` (cleanup verified; the
  staging dir is deleted). The E2E is **opt-in** (not in the default gate; the
  stage gate runs it only with `--with-extension`) and a daemon without an
  injected extension client keeps the honest typed `E_UNSUPPORTED` default.
  **Classification changes: full 48 -> 52, refused 4 -> 0, usable 72/77 (93.5%)
  -> 76/77 (98.7%)**, caveated-in 77/77; the `[3c]` block prints the opt-in
  requirement and the no-extension default per method. Only the measured 0.4
  totals move (new `extension-ingress` area: 8 files / 2,011 production / 805
  test; the ingress module + E2E land under `daemon`/`tests`).
- **Round 17 (2026-11-24, cooperate human attribution + `document_token` -> the
  last cooperate caveats closed; `tool.cooperate` still partial)**: the adapter
  now binds strict contexts to the page document — `documentTokenOf(url, nonce)`
  = sha256(`location.href | per-document nonce`), the nonce is injected/rotated
  with one `Runtime.evaluate` at every `sync`, and each strict action/wait
  re-reads the token before any CDP effect (mismatch or read failure -> typed
  `E_CONTEXT_STALE`, `effectState:"none"`, context kept, nothing dispatched;
  `sync` re-signs). The daemon consumes relayed extension `human.input` events
  into a human/paused state machine: `mode=human`, `paused=true`, `held=true`,
  `last_human_input_at`, the issued context/observation are revoked and the
  authority epoch advances; with `HUMAN_QUIET_MS=2000` and
  `IDLE_RESUME_MS=3000` the automatic hand-back happens at
  `max(quiet window, last agent activity + idle)` and reports `auto_resumed_at`
  (tokens stay invalid until a new `sync`). Actions arm the extension's own
  `InputExpectation` (`ext.arm_input` -> content script) before native input, so
  the extension can separate its own agent event from an unmatched human one.
  Evidence: opt-in headed-Edge E2E `0.4/tests/cooperate-attribution-e2e.mjs`
  **96/96 checks, 3 consecutive runs** (agent click is not counted as human and
  `system.status.extension.human_events` does not move; pseudo-human CDP
  `Input.dispatchMouseEvent` on an independent connection -> human/paused ->
  gate refuses `E_SESSION_PAUSED` -> 2 s auto hand-back -> the old context fails
  `E_CONTEXT_STALE`) plus the strict doc-token suite **33/33**. The stage gate
  gains an opt-in step `cooperate attribution` under `--with-extension`
  (18 -> 20 steps; the default 18-step set is unchanged).
  **Classification is unchanged**: `tool.cooperate` stays **partial** — one-shot
  CLI `--click`/`--fill`/`--press` still build ungated handlers, attribution
  needs the opt-in MV3 content script, and the plane state is per-process; the
  `[3b]` reason states exactly that. Only measured totals move (0.4 code
  159,605 -> 164,521 = 94,364 production + 70,157 test; `scripts` 2,896 ->
  2,934 because this round edits the gate and the generator).
- **Round 18 (2026-11-24, `tool.cooperate` partial -> caveated-full)**: the
  one-shot CLI cooperation gate `--cooperate-gate` landed and closed the last
  written cooperate caveat this dashboard listed: the flag enables a real
  target-policy cooperate session and awaits `actionGate` before every
  `--click`/`--fill`/`--press`/`--select`/`--drag`/`--hover`/`--focus`/`--wheel`
  action; a refusal is a typed error (`E_SESSION_PAUSED` etc.) and dispatches
  **zero** `Input.*`; `--json` carries `cooperate_gate: { enabled, context_id,
  observation_id, gated }`, and an invocation **without** the flag stays
  byte-compatible (no `cooperate_gate` field, untracked timing). Evidence:
  `0.4/cli/bridge-remote.test.mjs` **13/13** (pure argument/mutual-exclusion validation,
  fake-CDP gate refusal with zero dispatch, real-Edge click/fill smoke, no-flag
  compatibility) plus the round-35 headed-Edge attribution E2E **96/96** and the
  strict doc-token **33/33**. Classification: `tool.cooperate` moves from
  **partial** to a new **caveated-full** bucket (`CAVEATED_FULL_TOOLS`, printed in
  `[3e]`) because the requirement is now **opt-in scope**, not missing
  semantics: human attribution needs the opt-in MV3 content script and one-shot
  CLI input gating needs the per-invocation `--cooperate-gate` flag; without the
  extension the human/paused hand-back gate is not armed, and without the flag
  the one-shot paths keep the pre-round ungated behavior. Counts: full
  **52 -> 53**, partial **1 -> 0**, usable **76/77 (98.7%) -> 77/77 (100.0%)**,
  caveated-in **77/77**; the synthetic "before" figure stays **52/77** (round 36
  excludes the caveated-full handler, exactly like the extension-ingress four).
  The generator also prints a `usable caveat` line so the 100% can never be read
  as unconditional. Only measured totals move (0.4 code 165,214 -> 165,244 in the
  same working tree, `scripts` 2,964).
- **Round 19 (2026-11-24, exact native-timestamp attribution + browser lifecycle
  facts)**: the opt-in human attribution is now **exact** instead of
  window-based. The adapter generates the native dispatch timestamp when it arms
  an input (`ext.arm_input.timestamp`, epoch ms) and passes the *same* value to
  every CDP `Input.*` call; the content script converts it into the frame's
  monotonic clock (`performance.timeOrigin`) and requires
  `|event.timeStamp - armed_at| <= 1.5 ms`. The opt-in headed-Edge E2E now proves:
  ±1.2 ms dispatch -> **agent** (no human count, expectation consumed; the browser quantizes CDP timestamps to 0.1 ms, so the E2E uses ±1.2 ms and the deterministic 1.4/1.6 boundary stays in the content-script unit test),
  a `window`-mode contrast where the same +20 ms delta still matches (old
  behavior), and exact +20 ms -> **human** with `daemon paused` and
  `attribution.delta_ms ≈ 20`. `fill` remains the one window-mode exception
  (`Input.insertText` has no timestamp field — `fill.js` documents it; no fake
  exact match is claimed). Round 19 also lands the **browser-side lifecycle
  facts**: the extension subscribes `chrome.tabs.onMoved` / `onRemoved` /
  `windows.onRemoved`, resolves the session from the borrowed-tab ledger or the
  Agent Window (never guesses), and pushes `extension.event
  session.ended(reason=user_moved_tab|tab_closed|window_closed)` (1000 ms dedupe;
  the extension's own Agent Window close suppressed for 2000 ms; window-closing
  tab removals counted as `skipped`, not faked `tab_closed`). The daemon consumes
  it: marks the session ended, releases the Agent Window, returns borrowed tabs,
  keeps a bounded tombstone, and reports
  `system.status.extension.{lifecycle_events,last_event}`. Boundaries: it does
  **not** subscribe `tabs.onDetached`/`onAttached` (a cross-window move is not a
  lifecycle fact), and only a borrowed tab or the session's Agent Window maps to a
  session. Evidence: opt-in headed-Edge E2E
  `0.4/tests/cooperate-attribution-e2e.mjs` **129/129** (was 96/96) and
  `0.4/tests/extension-ingress-e2e.mjs` **128/128** (was 87/87; 3 lifecycle
  scenarios: move -> `user_moved_tab` + borrowed tab returned to its original
  window/index, close borrowed tab -> `tab_closed`, close Agent Window ->
  `window_closed`; each asserts the daemon session is gone, the extension ledger
  released, window/tab counts back to baseline, and the extension-side
  `lifecycle_forwarded` exactly +1). Classification is unchanged (53 full, 0
  partial, 0 refused, usable 77/77 scope-conditioned); only measured totals move
  (0.4 code 165,244 -> 168,112 = 95,638 production + 72,474 test in the same
  working tree, which also carries parallel adapter/extension work — cite the
  generator output). The `[3c]`/`[3e]` evidence cells and the `[6]` verification
  lines were regenerated with these figures.
- **Round 39 (2026-11-24, A3a/A3b/A4a/A4b)**: evidence refresh only — the
  classification is unchanged (53 full, 0 partial, 0 refused, usable 77/77
  scope-conditioned) and no opt-in condition was relaxed. `tool.video` and
  `tool.debug` are now printed in the new `[3f]` evidence block (daemon default
  MP4 + fixed `tab_id`/`window_id` + `owner:'daemon'`; operations
  `request_ids`/`console_ids` correlation + browser-source replay with Node
  `fetch` as the explicit fallback), and the `[3c]`/`[3e]`/`[6]` evidence now
  records the A3a borrow confirmation UI / borrow fidelity and the A3b
  observed-tab ownership, page-opened-tab window routing and single
  `session_stop` order. The extension smoke is **339/339** (A3a/A3b fixtures);
  `test-all` is **1685 passed + 1 skipped** and eval **43/43** in the same tree.
  The fenced block was regenerated and `--check` passes. Measured code total:
  **174,620** lines = 99,345 production + 75,275 test (54.6% / 49.2% / 52.2% of
  BSK 334,821; cite the generator output).
- **Round 39 (2026-11-24, A3a/A3b/A4a/A4b — evidence refresh, no
  reclassification)**: the classification stays full 53 / partial 0 / refused 0 /
  usable 77/77 (scope-conditioned), and only the printed evidence changes:
  - `tool.video` enters the new evidence-only `[3f]` bucket: the daemon-native
    `session-video` default is MP4 (`format:'avi'`/`'mjpeg-avi'` still the
    verified local AVI writer, an MP4-unavailable page fails typed
    `E_UNSUPPORTED`), every recording/start/status/stop view and catalog entry
    carries the session target's fixed `tab_id`/`window_id` (null when
    unreadable) and `owner:'daemon'`, and `video-catalog.mjs` normalizes a legacy
    index to daemon + null identity while reserving `owner:'extension'`. Only a
    browser/extension-owned catalog remains a written boundary. Evidence:
    `session-video` 13/13, `video-catalog` 16 pass + 1 skip (POSIX mode bit),
    `browser-daemon` 69/69, `server` 83/83.
  - `tool.debug` enters `[3f]`: a daemon-fed operation now carries the bounded
    `request_ids`/`console_ids` correlation (window join; a miss stays empty) and
    `replay` defaults to the browser source (in-page `fetch` over CDP
    `Runtime.evaluate`) with Node `fetch` only as the explicit `fallback:true`
    source. Evidence: `session-debug` 55/55, `browser-daemon` 69/69, `server`
    83/83.
  - The extension-ingress four (`[3c]`) and `tool.cooperate` (`[3e]`) evidence now
    records A3a/A3b: real borrow confirmation UI (shadow-DOM banner via
    `chrome.scripting` + notifications fallback, 60 s timeout, fail-closed
    `E_BORROW_DENIED`/`E_BORROW_TIMEOUT`), group/pinned/neighbour snapshot +
    restore/rebuild + fallback window, the observed-tab ownership set,
    page-opened-tab routing (never a default target), and the single
    `session_stop` order (return borrowed -> clear refs -> close agent-created ->
    remove window only when no user tab remains). The three A3a codes are
    registered in `errors.js`. Evidence: extension smoke **339/339**,
    `browser-daemon` 69/69, headed-Edge ingress E2E 128/128.
  - The fenced block was regenerated; `--check` passes, and `[3f]` plus the
    updated `[3c]`/`[3e]`/`[6]` lines are the verbatim generator output. 0.4 code
    (generator convention) is **174,620** lines = 99,345 production + 75,275 test
    (54.6% / 49.2% / 52.2% of BSK 334,821 in the same working tree; cite the
    generator, not this prose).
- `tool.*` coverage: 53/53 handlers registered, **53 full** (4 of them opt-in
  extension ingress + 1 caveated-full `tool.cooperate`), **0 partial**,
  **0 refused**.
- 0.4 code is 196,373 lines (110,166 production + 86,207 test), 58.7% of BSK by
  the measurement rules above (60.6% of BSK production).

Refresh after code changes:

```powershell
node 0.4/scripts/bsk-coverage.mjs          # print
node 0.4/scripts/bsk-coverage.mjs --check  # must exit 0 before committing this page
```

### Round 40 (2026-11-24, Wave B) — block regenerated, classification unchanged

Wave B (bench budget gate, CLI lazy loading, opt-in warm browser pool, BSK
baseline method) changed code and 0.4 docs but **no coverage classification**, so
the fenced block above was regenerated and `--check` passes verbatim. On the
same working tree the 0.4 code snapshot moves from 174,620 to **177,441** lines =
**101,146** production + **76,295** test (**55.6% / 49.9% / 53.0%** of BSK
334,821 = 181,866 production + 152,955 test); the delta is the Wave B
scripts/tests (`budget-check.mjs` + its 15 tests, `bsk-compare.mjs` + its 19
tests, the warm-pool code/tests, and the `test-all.mjs` wiring). Counts stay:
usable **77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**,
control **24/24 real**, 0 typed-unsupported control methods.
### Round 42 (2026-11-24, C1-C3 code + C4 docs) — block regenerated, classification unchanged

Round 42 merged real code (VOM depth, the multi-tenant MVP, the resumable
transfer store) and the gate-docs sync, but **no coverage classification
changed**: usable **77/77 (scope-conditioned)**, full **53**, partial **0**,
refused **0**, control **24/24 real**, 0 typed-unsupported control methods. The
fenced block above was regenerated and `--check` passes verbatim (77 method names
+ output block). On the clean working tree the 0.4 code snapshot moves from
177,441 to **182,522** lines = **103,864** production + **78,658** test
(**57.1% / 51.4% / 54.5%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-42 modules and their tests: `0.4/packages/vom`
`funnel.js`/`affordance.js`/`layers.js`/`active-region.js`/`identity.js`/
`observe.js` + the VOM suites (**156/156**), `0.4/daemon/tenant-registry.mjs`
(12/12) + the server (**96/96**) / browser-daemon (**74/74**) multi-tenant
wiring, `0.4/daemon/transfer-store.mjs` (15/15) and the `cooperate` E2E
hardening (the E2E now reports **131/131**; the `[3e]` evidence string was
updated accordingly). The coverage of the four extension-ingress methods and
`tool.cooperate` keeps its written opt-in scope (`[3c]`/`[3e]`); nothing was
relaxed. Boundaries for all three new subsystems are recorded in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §12 and `docs/0.4-BEYOND-BSK.md`
Wave C status.

### Round 43 (2026-11-24, Wave C2: transfer wire + replay/crash-inject + dashboard) — block regenerated, classification unchanged

Round 43 wired the second Wave C slice into the product and the gates, but **no
coverage classification changed**: usable **77/77 (scope-conditioned)**, full
**53**, partial **0**, refused **0**, control **24/24 real**, 0
typed-unsupported control methods, 0 missing codecs. The fenced block above was
regenerated with `node 0.4/scripts/bsk-coverage.mjs` and `--check` passes
verbatim (77 method names + output block). The delta is new runtime/tests/doc
code with **no new wire method**: `0.4/daemon/replay.mjs` + `replay.test.mjs`
(24/24, deterministic TraceV3/WAL replay with `E_REPLAY_DRIFT`/`E_REPLAY_WAL`),
`0.4/tests/crash-inject-e2e.mjs` (12/12 real-daemon + headless-Edge + real
SIGKILL crash-injection E2E), `0.4/dashboard/server.mjs` + `server.test.mjs`
(20/20 read-only dashboard/trace proxy), the resumable-transfer **wire** work in
`0.4/daemon/server.mjs` (`transfer.resume`/`transfer.finalize` routes),
`transport.mjs`/`ws-transport.mjs` (method tables 27/27 and 20/20), the CLI
`--transfer-resume`/`--transfer-finalize` surface
(`bridge-daemon-client.mjs`, 96/96) and the gate wiring in
`0.4/scripts/test-all.mjs` + `0.4/scripts/stage-gate.mjs` (dashboard suite in
`test-all`; opt-in `--with-crash-inject` step). The 0.4 code snapshot moves from
**182,522** to **188,220** lines = **106,875** production + **81,345** test
(**58.8% / 53.2% / 56.2%** of BSK 334,821 = 181,866 production + 152,955 test).
`transfer.resume`/`transfer.finalize` are additive members of the existing
77-method surface (they already existed as transport/server routes and stay
counted exactly once); no BSK method was added, removed or reclassified.
Boundaries for this slice are recorded in SCOPE-DECISIONS §13 and the Wave C
status table in `docs/0.4-BEYOND-BSK.md` (replay is offline evidence analysis,
not a browser re-execution driver; the dashboard is a read-only loopback UI;
WSS tenant identity + reconnect/resume and mixed Edge+Chrome tenants remain
open).

### Round 44 (2026-11-24, Wave C3: mixed-browser tenants + WS identity + tag persistence, VOM passthrough, 100 MiB transfer E2E) -- block regenerated, classification unchanged

Round 44 landed the third Wave C slice but **no coverage classification
changed**: usable **77/77 (scope-conditioned)**, full **53**, partial **0**,
refused **0**, control **24/24 real**, 0 typed-unsupported control methods, 0
missing codecs, no new wire method (the 77-method surface is unchanged). The
fenced block above was regenerated with `node 0.4/scripts/bsk-coverage.mjs` and
`--check` passes verbatim (77 method names + output block). The 0.4 code snapshot
moves from **188,220** to **190,627** lines = **107,609** production + **83,018**
test (**59.2% / 54.3% / 56.9%** of BSK 334,821 = 181,866 production + 152,955
test). The delta is runtime and tests, not wire surface: the round-44 multi-tenant
work in `0.4/daemon/server.mjs` / `browser-daemon.mjs` / `ws-transport.mjs` /
`session-store.mjs` (**217/217**: server 102, browser-daemon 76, ws-transport 22,
session-store 5, tenant-registry 12), the VOM passthrough in
`0.4/packages/browser-adapter/src/snapshot-handlers.js` (**15/15** plus CLI parser
tests), the CLI flags for `--snapshot`/`--observe`, the browser-free
`0.4/tests/transfer-resume-e2e.mjs` (**846-line** opt-in E2E, deliberately not a
`*.test.mjs` so `test-all` never collects it), and the stage-gate wiring
(`--with-transfer` step + its serial lane, `test-all` comment/collection note).
The four extension-ingress methods and `tool.cooperate` keep their written opt-in
scope (`[3c]`/`[3e]`); nothing was relaxed. Boundaries for this slice are in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §14 and the Wave C status table in
`docs/0.4-BEYOND-BSK.md` (the "2 browsers x 4 tenants" stage test is
fake-launcher-proven, not a real headed two-browser E2E; the transfer E2E's
reconnect policy is in the script, not the product transport; WSS uses the
self-signed test certificate with client verification disabled process-wide).

### Round 45 (2026-11-24, Wave C4: real dual-browser tenants, product transfer client, authenticated multi-tenant dashboard) -- block regenerated, classification unchanged

Round 45 landed the fourth Wave C slice but **no coverage classification
changed**: usable **77/77 (scope-conditioned)**, full **53**, partial **0**,
refused **0**, control **24/24 real**, 0 typed-unsupported control methods, 0
missing codecs, no new wire method (the 77-method surface is unchanged — the
tenant E2E, transfer client and dashboard add runtime/tests, not BSK methods).
The fenced block above was regenerated with `node 0.4/scripts/bsk-coverage.mjs`
and `--check` passes verbatim (77 method names + output block). The 0.4 code
snapshot moves from **190,627** to **196,373** lines = **110,166** production +
**86,207** test (**60.6% / 56.4% / 58.7%** of BSK 334,821 = 181,866 production +
152,955 test). The delta is the round-45 work: the real dual-browser tenant E2E
(`0.4/tests/tenant-multi-browser-e2e.mjs`, deliberately not a `*.test.mjs` so
`test-all` never collects it), the product-side resumable transfer client
(`0.4/daemon/transfer-client.mjs` + `transfer-client.test.mjs` **16/16**) and its
CLI `--transfer-upload` wiring (`bridge-daemon-client.mjs` 96→105,
`bridge-remote.mjs`), the authenticated multi-tenant dashboard
(`0.4/dashboard/server.mjs` 20→39 tests, new `dashboard` area row in `[2]`), and
the stage-gate `--with-tenant` step (+ `test-all` comments). The four
extension-ingress methods and `tool.cooperate` keep their written opt-in scope
(`[3c]`/`[3e]`); nothing was relaxed. Boundaries for this slice are in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §15 and the Wave C status table in
`docs/0.4-BEYOND-BSK.md` (the tenant E2E is headless, extension-free and 2-tenant;
the transfer reconnect policy is product code only for callers of the new module;
the dashboard token is one shared secret with no TLS, loopback-only and view-only).

### Round 46 (2026-11-24, Wave D: dashboard write plane, mTLS WSS, quota persistence + tenant-attributable global planes, VOM into MCP/DSH) -- block regenerated, classification unchanged

Round 46 landed the four Wave D capability slices but **no coverage
classification changed**: usable **77/77 (scope-conditioned)**, full **53**,
partial **0**, refused **0**, control **24/24 real**, 0 typed-unsupported
control methods, 0 missing codecs, no new wire method (the 77-method surface is
unchanged — the dashboard write plane, mTLS transport options, tenant quota
persistence/global-plane attribution and the MCP/DSH option passthrough add
runtime/tests, not BSK methods). The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method
names + output block). The 0.4 code snapshot moves from **196,373** to
**203,532** lines = **113,921** production + **89,611** test
(**62.6% / 58.6% / 60.8%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-46 work: the dashboard write plane
(`0.4/dashboard/auth.mjs` + `server.mjs`, `auth.test.mjs` **13/13** +
`server.test.mjs` **55/55**), the mTLS/per-connection-TLS client + server
options (`ws-transport.mjs`/`tls.mjs`) and the mTLS WSS E2E
(`0.4/tests/mtls-wss-e2e.mjs` + committed PEM fixtures, **13/13**, deliberately
not a `*.test.mjs` so `test-all` never collects it), the tenant quota ledger
(`tenant-registry.mjs` `quotaFile`, **18/18**) and the tenant-attributable global
planes (`server.mjs` **105/105**, `browser-daemon.mjs` **78/78**), and the
MCP/DSH VOM options (`mcp/server.mjs` **38/38** + `mcp/daemon-executor.mjs`
**33/33**, DSH plugin suite **253/253**), plus the stage-gate `--with-mtls` step
and the `test-all` explicit `dashboard/auth.test.mjs` entry. Reporting fix: the
`[2]` area table now genuinely includes the `dashboard` and `bench` rows (the
prose had listed them while the generated table omitted them; after the fix the
`[2]` areas sum to the `[2b]` totals). The four extension-ingress methods and
`tool.cooperate` keep their written opt-in scope (`[3c]`/`[3e]`); nothing was
relaxed. Boundaries for this slice are in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §16 and the Wave D status table in
`docs/0.4-BEYOND-BSK.md` (dashboard has no TLS, local-JSON accounts and in-memory
sessions; the mTLS default is a same-host LAN-NIC equivalence path with test-only
fixtures; quota persistence is opt-in with the config winning and browser-instance
metadata stays a global view, transfer ownership is per-process; the MCP/DSH
options are an opt-in reporting/pagination passthrough, not BSK's visual
heuristics).

### Round 47 (2026-11-24, 方案 B first slice: product-compliance gate, extension UI skeleton, internal audit docs, gate-matrix sync) -- block regenerated, classification unchanged

Round 47 landed the first 方案 B slice but **no coverage classification changed**:
usable **77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**,
control **24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no
new wire method (the 77-method surface is unchanged — the compliance gate, the
extension popup/options UI and the two internal audit documents add product
surface/tooling/tests, not BSK methods). The fenced block above was regenerated
with `node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method
names + output block). The 0.4 code snapshot moves from **203,532** to
**207,146** lines = **116,475** production + **90,671** test
(**64.0% / 59.3% / 61.9%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-47 work: the **product-compliance gate**
(`0.4/scripts/product-compliance.mjs`, **716 lines**, pure-lane stage-gate step +
`0.4/compliance-baseline.json`), the **extension UI skeleton**
(`0.4/extension-ingress/ui/` popup/options/settings + CSS/HTML, **1,573 lines**,
wired into `manifest.json` and the staging build) plus its browser-free
`extension-ingress/test/ui.test.mjs` (**1,060 lines, 23/23**, explicitly collected
by `test-all`), the `src/bridge.js` `ui.status` routing/settings wiring, and the
gate-matrix/doc sync. The `[2]` areas that moved are `extension-ingress`
11,191 → **14,069** and `scripts` 4,386 → **5,122**; every other area is
unchanged, and the `[2]` areas still sum to the `[2b]` totals. The compliance
boundaries are recorded in `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §17 and
`0.4/STATUS.md` §5: `hard` is zero-tolerance on the user-visible surface while
the `ratchet` baseline (599 occurrences / 149 files) may only go down; the
internal research docs (`docs/`, `0.4/STATUS.md`, `FINAL-AUDIT.md`) are excluded
from the scan and are not product copy; the UI suite uses fake `chrome.*` +
fake DOM, so real-browser loading is only evidenced by the headed-Edge
`extension ingress` E2E. Nothing was relaxed: the four extension-ingress methods
and `tool.cooperate` keep their written opt-in scope (`[3c]`/`[3e]`).
### Round 48 (2026-11-24, B1 close-out: extension UI merge, i18n, borrow-confirmation visual, status overlay, headed-Edge UI E2E, `--with-ui` gate, ratchet 251) -- block regenerated, classification unchanged

Round 48 landed the B1 UI close-out but **no coverage classification changed**:
usable **77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**,
control **24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no
new wire method (the 77-method surface is unchanged — the UI merge, the two
declarative content scripts and the new gate step add product surface/tests, not
BSK methods). The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method
names + output block; the generator's stale `smoke.mjs 339/339` evidence strings
were corrected to **341/341**, which is why the block changed in those rows).
The 0.4 code snapshot moves from **207,146** to **215,523** lines =
**119,872** production + **95,651** test (**65.9% / 62.5% / 64.4%** of BSK
334,821 = 181,866 production + 152,955 test). The delta is the round-48 work:
the H1 **i18n/popup cards** (`ui/i18n.js`, `ui/direction.js`, `ui/locales/*.json`
— 12 language files, JSON counted separately — and `ui/popup.js` L0-L3 cards),
the H2 **borrow-confirmation visual** rework in `content/borrow-confirm.js`, the
H3 **status-overlay content script** (`content/status-overlay.js`) that is the
manifest's second declarative `content_scripts` entry, and the four browser-free
suites **`ui.test.mjs` (26/26), `ui-i18n.test.mjs` (19/19),
`borrow-confirm-ui.test.mjs` (21/21), `status-overlay.test.mjs` (27/27)** plus the
opt-in headed-Edge UI E2E `tests/ui-popup-e2e.mjs` (**99/99**, now a
`--with-ui` stage-gate step). `test-all` grows to **2059 passed + 1 skipped /
2060**; `smoke.mjs` is **341/341** after its manifest assertion was made exact
for the two content scripts. The `[2]` areas that moved are
`extension-ingress` 14,069 → **20,081**, `scripts` 5,122 → **5,171** and
`tests` 19,440 → **21,756**; every other area is unchanged and the `[2]` areas
still sum to the `[2b]` totals. The `[1c]` non-code side is 10 docs files /
3,311 lines, 72 JSON files / 24,460 lines and 8 binaries. Product compliance
`--check` passes on **438 files** with **hard 0** and ratchet **251 occurrences
in 78 files** (round 47: 599/149 → **-58.1%**, baseline only goes down; the
boundaries are recorded in `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §18 and
`0.4/STATUS.md` §5). Nothing was relaxed: the four extension-ingress methods and
`tool.cooperate` keep their written opt-in scope (`[3c]`/`[3e]`), and the
`--with-ui` step is orthogonal (+1) without touching the default 19-step /
extension 20-step gate semantics.

### Round 49 (2026-11-24, I1: human-attribution flake root-cause fix + a real `tool.cooperate wait` race) -- block regenerated, classification unchanged

Round 49 landed the attribution hardening but **no coverage classification
changed**: usable **77/77 (scope-conditioned)**, full **53**, partial **0**,
refused **0**, control **24/24 real**, 0 missing codecs, no new wire method. The
human-attribution E2E now runs **134/134** checks (3 new precondition checks
before the measurement window plus the content-script duplicate-delivery guard;
no existing assertion was relaxed) and the adapter regression suite is
**34/34** (the `tool.cooperate wait` human branch now captures its marker before
awaiting the overlay refresh, so the daemon's auto hand-back can no longer null
it mid-await; the fix is pinned by a test that fails with the null deref when
reverted). `extension-ingress/content/human-watch.js` gained the bounded
read-only event ring and the E2E a main-world probe purely as diagnostics. The
round-49 code delta is folded into the round-50 snapshot below (both slices were
generated in one run). The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method
names + output block). Nothing was relaxed: the four extension-ingress methods
and `tool.cooperate` keep their written opt-in scope (`[3c]`/`[3e]`); boundaries
are in `0.4/STATUS.md` §5「Wave D (round 49) boundaries」.

### Round 50 (2026-11-24, B2 close-out: borrow-confirmation 12-language i18n, popup control plane `ui.intent`, HAR 1.2 export, fast-path evaluation) -- block regenerated, classification unchanged

Round 50 landed the B2 close-out but **no coverage classification changed**:
usable **77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**,
control **24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no
new wire method (the 77-method surface is unchanged — the `ui.intent` control
plane reuses the existing `session.open`/`session.close` RPCs, `debug.export`
gains an artifact **format**, and the borrow word tables are extension content
script/JSON data, so no BSK method is added or reclassified). The fenced block
above was regenerated with `node 0.4/scripts/bsk-coverage.mjs` and `--check`
passes verbatim (77 method names + output block). The 0.4 code snapshot moves from
**215,523** to **220,438** lines = **122,387** production + **98,051** test
(**67.3% / 64.1% / 65.8%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-49/50 work: the attribution hardening and the
`cooperate-handlers` race fix, the `ui.intent` router + popup control cards +
their tests (`ui.test.mjs` 26→**48/48**), the 12-language
`extension-ingress/content/borrow-i18n.js` + `borrow-i18n.test.mjs`
(**20/20**), the daemon **HAR 1.2 export** (`0.4/daemon/har-export.mjs` +
`debug.export format:"har"` + CLI `--format har`, `har-export.test.mjs`
**12/12**), and the `human-match.test.mjs` (**10/10**) collection gap closure.
`test-all` grows to **2130 passed + 1 skipped / 2131**. The `[2]` areas that moved
are `extension-ingress` 20,081 → **23,300**, `scripts` 5,171 → **5,180**,
`daemon` 51,516 → **52,658**, `cli` 8,779 → **9,052** and `tests` 21,756 →
**21,971**; every other area is unchanged and the `[2]` areas still sum to the
`[2b]` totals. Product compliance `--check` passes on **442 files** with
**hard 0** and ratchet **251 occurrences in 78 files** (unchanged, baseline only
goes down; boundaries in `docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §19 and
`0.4/STATUS.md` §5). The fast-path evaluation (`docs/FASTPATH-SPIKE.md`) changes
no code and adds no claimed coverage: A1 lazy ref resolution is a measured
optimization candidate (−43%/−44% p50, 1002→302 CDP commands, byte-identical
text), the page-internal renderer (B) is deliberately not started. Nothing was
relaxed: the four extension-ingress methods and `tool.cooperate` keep their
written opt-in scope (`[3c]`/`[3e]`).

### Round 51 (2026-11-24, B3 close-out: fast-path A landed, dashboard capture/HAR view, ratchet 63/14, panels port plan) -- block regenerated, classification unchanged

Round 51 (B3 close-out) **did not change any coverage classification**: usable
**77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**, control
**24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no new wire
method (fast path A only changes how many DOM commands `tool.observe`/`tool.snapshot`
issue; the dashboard capture/HAR view is a dashboard HTTP route over the existing
`debug.query`/`debug.export`; the panels port plan is a document). The fenced block
above was regenerated with `node 0.4/scripts/bsk-coverage.mjs` and `--check` passes
verbatim (77 method names + output block). The 0.4 code snapshot moves from
**220,438** to **222,271** lines = **123,510** production + **98,761** test
(**67.9% / 64.6% / 66.4%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-51 work: the fast-path lazy-ref implementation in
`packages/browser-adapter/src/snapshot-handlers.js` + the `refResolutionAffectsRows`
safety valve in `packages/vom/src/render.js` and their tests
(`snapshot-handlers.test.mjs` **22/22**, 7 new fast-path cases), the dashboard
capture/HAR routes + page block + 8 new tests (`dashboard/server.test.mjs`
**55→63/63**, `auth.test.mjs` **13/13**), and the compliance ratchet policy/generated
file regeneration (scripts/tooling; `product-compliance.mjs`). The `[2]` areas that
moved are `dashboard` 6,668 → **8,049**, `scripts` 5,180 → **5,284**,
`packages/browser-adapter` 31,235 → **31,540** and `packages/vom` 7,964 →
**8,007**; every other area is unchanged and the `[2]` areas still sum to the
`[2b]` totals. `test-all` is **2145 passed + 1 skipped / 2146** tests (15
`node --test` segments, all `fail 0`; +15 over round 50 = dashboard server
55→63 (+8) and the 7 new fast-path cases), and the README/json counts are
**10 docs / 3,603 lines** and **72 json / 24,665 lines**. Product compliance
`--check` passes on **442 files** with **hard 0** and ratchet **63 occurrences in
14 files** (down from 251/78 in round 50; **168** exact-token allowlisted
occurrences are reported but not counted, hard remains zero-tolerance — policy in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §20.3). Nothing was relaxed: the four
extension-ingress methods and `tool.cooperate` keep their written opt-in scope
(`[3c]`/`[3e]`); the fast path has documented fallbacks (`<64` addressable nodes,
budget/pageSize zero-gain, table-cell row set, non-convergence) and leaves the
injected test/recording seams on the legacy path.

### Round 52 (2026-11-24, B4 close-out: dashboard 18-module split + size budget, read-only session detail, ratchet 26/4, fast-path B spike) -- block regenerated, classification unchanged

Round 52 (B4 close-out) **did not change any coverage classification**: usable
**77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**, control
**24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no new wire
method. The dashboard split moves the existing HTTP routes into 18 modules behind
the same daemon methods, `/api/session` only issues six existing read-only
methods, `/api/session/sources` is a static descriptor, the size budget measures
bytes/lines, and the fast-path B document is an evaluation (no product code, no
bench scenario, no budget row). The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method names
+ output block). The 0.4 code snapshot moves from **222,271** to **224,182** lines
= **124,932** production + **99,250** test (**68.7% / 64.9% / 67.0%** of BSK
334,821 = 181,866 production + 152,955 test). The delta is the round-52 work: the
dashboard 18-module split + assembly over the same routes, the read-only
`/api/session` composed route + `/api/session/sources` + the session-detail page
(+9 dashboard tests, `dashboard/server.test.mjs` **63 → 72/72**), and the new
`0.4/scripts/dashboard-size-check.mjs` + stage-gate `dashboard size` wiring. The
`[2]` areas that moved are `dashboard` 8,049 → **9,429** and `scripts` 5,284 →
**5,815**; every other area is unchanged and the `[2]` areas still sum to the
`[2b]` totals. `test-all` is **2154 passed + 1 skipped / 2155** tests (15
`node --test` segments, all `fail 0`; +9 over round 51 = dashboard server 63→72),
and the docs/json counts are **10 docs / 3,831 lines** and **73 json / 24,685
lines** (the new `dashboard/size-budget.json`). Product compliance `--check`
passes on **460 files** with **hard 0** and ratchet **26 occurrences in 4 files**
(down from 63/14 in round 51; **168** exact-token allowlisted occurrences are
reported but not counted, hard remains zero-tolerance — policy in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §21.4). Nothing was relaxed: the
four extension-ingress methods and `tool.cooperate` keep their written opt-in
scope (`[3c]`/`[3e]`). The page-internal extraction prototype
(`docs/FASTPATH-SPIKE-B.md`) is a conditional GO at 6–8.5 person-days with no
landed code; A1 (lazy ref resolution) remains the landed fast path.

### Round 53 (2026-11-24, B5 close-out: fast-path B seam + read-only drill-downs, size-budget adjustment, ratchet 4/2) -- block regenerated, classification unchanged

Round 53 (B5 close-out) **did not change any coverage classification**: usable
**77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**, control
**24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no new wire
method. The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method names
+ output block). The fast-path B work is an **opt-in, default-off extension
capability**, not a new BSK wire method: the page-internal collector
(`extension-ingress/content/collect.js`, CompactTree v1) + the bridge-intercepted
`ext.collect` ingress command + the daemon-side `tree-render.js` renderer and the
`createSnapshotHandlers({fastpathB, treeProvider})` seam (silent fallback matrix;
the daemon `ext.collect` → `treeProvider` wiring is **not landed**), so
`tool.observe`/`tool.snapshot` keep their existing classification and default
behavior. The three dashboard drill-downs (`/api/session/audit`, `/api/video`,
`/api/session/cooperate`) are thin read-only proxies over existing daemon methods
(`audit.request`+`ledger.list`/`ledger.pending`, `video.status`+metadata-only
`video.list`, `cooperate.status`), and the dashboard size ceilings are
reviewability limits only. The 0.4 code snapshot moves from **224,182** to
**230,251** lines = **127,538** production + **102,713** test (**70.1% / 67.2% /
68.8%** of BSK 334,821 = 181,866 production + 152,955 test). The delta is the
round-53 work: the collector + `ext.collect` route + optional semantic fields,
the adapter `tree-render.js` + opt-in fastpath-B seam and the dashboard read-only
drill-down module + page blocks, plus their tests. The `[2]` areas that moved are
`extension-ingress` 23,300 → **25,933**, `packages/browser-adapter` 31,540 →
**32,935**, `dashboard` 9,429 → **10,521**, `tests` 21,971 → **22,862** and
`scripts` 5,815 → **5,873**; every other area is unchanged and the `[2]` areas
still sum to the `[2b]` totals. `test-all` is **2217 passed + 1 skipped / 2218**
tests (15 `node --test` segments, all `fail 0`; +63 over round 52 = the newly
collected `collect.test.mjs` **29** + the new `tree-render.test.mjs` **16** +
`snapshot-handlers` 22→**31** + dashboard server 72→**81**), and the docs/json
counts are **10 docs / 4,051 lines** and **73 json / 24,704 lines**. The
extension `test/smoke.mjs` fixture runner stays standalone at **345/345** (four
stale assertions were replaced by stronger exact ones: three declared content
scripts incl. `collect.js`, `INGRESS_COMMAND_METHODS` incl. `ext.collect`, and
the collect source in the encoding scan). Product compliance `--check` passes on
**465 files** with **hard 0** and ratchet **4 occurrences in 2 files** (down from
26/4 in round 52 and 63/14 in round 51; **186** exact-token allowlisted
occurrences are reported but not counted, hard remains zero-tolerance — policy in
`docs/bsk-study/BSK-0.5.0-SCOPE-DECISIONS.md` §22.5). Exactly one capacity
ceiling was raised in a dedicated change: the dashboard **source-tree** total
262,144 → **294,912 B** (the round-52 read-only module left 411 B of headroom);
per-module/assembly/page/ingress-UI/locale ceilings are unchanged and the
`dashboard size` step now reports **25 checks**. Nothing was relaxed: the four
extension-ingress methods and `tool.cooperate` keep their written opt-in scope
(`[3c]`/`[3e]`), and fast-path B makes no performance claim until the daemon
wiring and the real-Edge A/legacy byte-equivalence + performance comparison
land.

### Round 54 (2026-11-24, B6 close-out: fast-path B daemon wiring + real headed-Edge E2E, pixel-level visual baseline, ratchet 0/0) -- block regenerated, classification unchanged

Round 54 (B6 close-out) **did not change any coverage classification**: usable
**77/77 (scope-conditioned)**, full **53**, partial **0**, refused **0**, control
**24/24 real**, 0 typed-unsupported control methods, 0 missing codecs, no new wire
method. The fenced block above was regenerated with
`node 0.4/scripts/bsk-coverage.mjs` and `--check` passes verbatim (77 method names
+ output block). **The round-53 written boundary "the daemon does not wire
`ext.collect` into `treeProvider`" is closed**: `createBrowserDaemon({fastpathB,
fastpathBOpts})` reads `BB_FASTPATH_B` when the option is omitted (default
false), builds one **session-bound** `treeProvider` per observation
(`ext.collect { session_id }` or an explicit `tab_id`) into
`createSnapshotHandlers({fastpathB:true, treeProvider})`, and reports only
enablement through `initialize.fastpath_b`/`server.fastpathB`/
`daemon.fastpathBInfo()`; the round-53 silent fallback matrix is unchanged and B
is **still opt-in/default-off**, so the 77-method classification and default
behavior are untouched. A real headed-Edge E2E (opt-in gate step
`--with-fastpath-b`) passes **106/106 checks on each of 2 runs** with
byte-identical text between A/off/on (3,684 B, 86 refs, `sha256 df30ff52…`),
page-side `Runtime.evaluate` **10 → 0**, and a real daemon `observe` served by B
with 5/5 session-bound `ext.collect` calls, **0** `Runtime.evaluate` and text
identical to the off baseline. **The pixel-level visual baseline** (opt-in gate
step `--with-ui-visual`) captures the popup (420×760), options (900×1000) and
dashboard session-detail region (1400×800) through CDP, decodes the PNGs without
third-party libraries and compares them against the committed
`0.4/tests/fixtures/ui-baseline/*.json` (exact size; 16×16 grid with per-cell
≤10/255, or ≤12% differing cells and a 256-cell mean ≤3.0; visible-term/
external-link/CSP checks), with two runs both matching and cross-comparing
(**41/41** each). **Compliance is now hard 0 / ratchet 0 occurrences in 0 files**
over **466** scanned files with **189** allowlisted occurrences: the last 4/2
generated-contract provenance hits were neutralised in the **generator**
(`neutralize-contract-text.mjs` rewrites only `description` strings' passive
`derived from` → `computed from`; `import-schemas.mjs`/`gen-bsk-codecs.mjs`
apply it, and the source-parity test applies the same function before
`deepEqual`, so the 113 contracts stay field-by-field equal and the wire is
unchanged). The allowlist was not widened, the scan scope/exclusions were not
changed and the baseline may only go down. The 0.4 code snapshot moves from
**230,251** to **234,974** lines = **128,215** production + **106,759** test
(**70.5% / 69.8% / 70.2%** of BSK 334,821 = 181,866 production + 152,955 test).
The delta is the round-54 work: the daemon wiring + its suites, the two new
real-browser E2Es and the three committed visual baselines. The `[2]` areas that
moved are `daemon` (wiring + tests), `cli` (the one-shot `--fastpath-b` option),
`scripts` (the two opt-in stage-gate steps + the test-all collection note),
`tests` 22,862 → **26,404** (the new E2Es) and `packages/protocol` 22,638 →
**22,715** (the generator neutraliser); every other area is unchanged and the
`[2]` areas still sum to the `[2b]` totals. `test-all` is **2228 passed +
1 skipped / 2229** tests (15 `node --test` segments, all `fail 0`; +11 over
round 53 = `daemon/server.test.mjs` 105→**111**, `daemon/browser-daemon.test.mjs`
78→**82**, `cli/bridge-remote.test.mjs` 18→**19**), and the docs/json counts are
**11 docs / 4,251 lines** and **76 json / 28,757 lines** (three committed visual
baselines). Exactly two **opt-in** gate steps were added
(`--with-fastpath-b` 420 s, `--with-ui-visual` 600 s; each +1 and orthogonal;
default 19/20/21-step semantics unchanged) and nothing was relaxed. Two
non-green runs are recorded in `docs/TEST-STATUS.md` #54 (a headless-Edge MCP
live-smoke DOM-extract flake and a first combined-gate `fastpath b e2e` exit 1
whose retry exposed a wrapper summary-status bug, fixed, then 21/21 green).
Fast-path B still makes **no release-level performance claim** (the measured
benefit is page-extraction commands 10→0; latency is same-machine relative), and
the visual baseline is a bounded comparison of three fixed surfaces, not a
whole-site visual regression.

### Round 55 (2026-11-24, 0.3-UI port close-out: 0.3 shell + `bb.*` compat layer, capacity-only size budgets, rewritten UI E2E, regenerated visual baselines) -- block regenerated, classification unchanged

Round 55 (0.3-UI port close-out) **did not change any coverage
classification**: usable **77/77 (scope-conditioned)**, full **53**, partial
**0**, refused **0**, control **24/24 real**, 0 typed-unsupported control
methods, 0 missing codecs, no new wire method or field. The fenced block above
was regenerated with `node 0.4/scripts/bsk-coverage.mjs` and `--check` passes
verbatim (77 method names + output block). **The UI is now the ported 0.3
40-file shell (380,245 B) behind a 5-type `bb.*` compat layer**: `bb.state`
(derived from the 0.4 `ui.status` snapshot with deep redaction),
`bb.call` (writes whitelisted to `session.open`/`session.close`/`act`),
`bb.settings.set` (pure `storage.local['bb.settings']`, credentials returned
empty), `bb.connection` (real `start()`/`stop()` lifecycle) and
`bb.devices.list` (honest empty state); the other 26 of the 31 grepped 0.3
`bb.*` messages return typed `E_UI_COMPAT_UNSUPPORTED` with
`supported_types`/`allowed_methods` instead of an empty success, so the panel
data planes for audit/record/longshot/ops/debug stay **not ported**. The size
budget was raised **only for capacity classes in a dedicated change** (ingress
UI 262,144 -> **524,288 B**, locale 122,880 -> **204,800 B**; the size step
still runs 25 checks and the dashboard per-module/assembly/page/tree ceilings
are untouched, page 90,088/90,112 B = 24 B headroom), and the locale budget now
recognises `extensionUi.localeFiles` (`["locales.js"]`) in addition to
`localesDir/*.json` so the single-table 0.3 layout cannot report a false
"0 locale bytes". The old UI E2E was **rewritten, not relaxed**: the 0.4
skeleton DOM no longer exists and the new suite covers the 0.3 popup/options/
12-language RTL/`bb.*` layer/borrow-confirmation/status-overlay at **140/140**
(standalone x2 and in-gate), while the three pixel baselines were regenerated
for the 0.3 UI (write mode 37/37, verify mode 2 x 43/43 = **86/86**, all-cells
max cell difference 2.25, same tolerances/floors/0 px size tolerance). The 0.4
code snapshot moves from **234,974** to **266,854** lines =
**156,175** production + **110,679** test
(**85.9% / 72.4% / 79.7%** of BSK 334,821 = 181,866
production + 152,955 test). The delta is the round-55 work: the 0.3 `ui/` shell
(40 files / 380,245 B), `src/ui-compat.js` and their browser-free suites; the
`[2]` areas that moved are `extension-ingress` 33,021, `tests`
29,635 and `scripts` 6,242; every other area is unchanged
and the `[2]` areas still sum to the `[2b]` totals. `test-all` is **2202 passed
+ 1 skipped / 2203** tests (15 `node --test` segments, all `fail 0`; -26 vs
round 54's recorded 2229 because the 0.3 port replaced the 0.4 skeleton unit
suites -- the measured total is reported as-is, no still-applicable assertion
was deleted or skipped), and the docs/json counts are **11 docs /
4,437 lines** and **67 json / 30,354 lines** (three
0.3-UI visual baselines; the JSON count follows the 0.3 `ui/` tree replacing
the split 0.4 skeleton assets). Honest boundaries: the ported UI writes
`bb.uiLang` while the page content scripts read `bb04.ui.language`, so a
language chosen in options is not yet bridged to the in-page confirm/overlay
(next-round fix; the E2E verifies the two layers separately); the manifest
still carries the now-unmatched `web_accessible_resources: ui/locales/*.json`
declaration (harmless, no permission/data change); 0.3 "stop persistence" is
not ported (an extension reload reconnects by default). Five real-browser gates
passed first-run (default **20/20** 216,597 ms, extension **21/21** 202,960 ms,
`--with-ui` **20/20** 183,684 ms, `--with-ui-visual` **20/20** 177,928 ms,
`--with-budget` **20/20** 175,916 ms); two browser-concurrency **BLOCKED**
events with the sibling UI-parity run are recorded in `docs/TEST-STATUS.md` #55,
not hidden, and no assertion/threshold/budget was relaxed.

### Round 56 (2026-11-24, quick-actions/record-workflow close-out: language-key bridge, `bb.call` 15-method whitelist + `bb.quick`, re-recorded visual baselines, `--with-quick-record` gate) -- block regenerated, classification unchanged

Round 56 adds **no wire method, field or error code** and changes **no
classification**: usable is still **77/77 (scope-conditioned)**, full **53** /
partial **0** / refused **0**, control **24/24 real**, 0 missing codecs. The
landed work is the quick-actions / record-workflow surface (task-140..142) plus
this task's integration: `ui/i18n.js` now writes both `bb.uiLang` and the content
scripts' `bb04.ui.language` and mirrors the former to the latter at startup (the
language key is no longer an unbridged boundary), `bb.call` is a **15-method**
whitelist and the 0.4-compat `bb.quick` envelope registers **18 actions = 14
available + 4 typed-unavailable with a real reason** (`help.request`,
`tab.borrow`, `dashboard.open`, `screenshot.capture`), the popup gained
`#quickBar` (8 actions whose enabled/disabled state and reasons come from the
real backend `bb.state.ui_compat.quick_actions`) and `#recordCard` (purpose ->
real `record.start` -> real `record.status` polling -> 4 real daemon actions ->
`record.stop` -> TraceV3 summary rows/digest/duration -> export / copy replay
command / clear), and the opt-in UI E2E was extended to **142/142** checks (it now
also asserts the bridged language auto-applies to the in-page confirmation
banner) while a new opt-in E2E (`tests/ui-quick-record-e2e.mjs`, **160 checks per
run**, default `--repeat 2`) drives the whole workflow against a real daemon with
a real `traceStore`. The three pixel baselines were **re-recorded** because the
popup layout really changed (`#quickBar` + `#recordCard`): write mode 37/37,
verify mode 2 runs x 43/43 (86/86 in-gate), all-cells max cell difference popup
2.17 / options 0 / dashboard 1.09 and **0 over cells**, same
tolerances/floors/0 px size tolerance. The gate matrix gains one **opt-in** step
`--with-quick-record` (+1, browser lane, 660 s cap, gate runs `--repeat 1` = 160
checks); the default 19/20/21 and extended 21/22 step counts are unchanged.

**Measurement-scope correction (recorded, not hidden)**: the generator now
excludes generated `dist-extension-ingress*` staging directories (byte copies of
the MV3 tree written by the build/E2E scripts). Round 55's snapshot had counted
one leftover copy (**21,211** lines), which is why its product total was
156,175; the comparable round-55 figure is ~**245,643** lines. Round 56 measures
**251,536** lines = **137,201** production + **114,335** test
(**75.4% / 74.8% / 75.1%** of BSK 334,821 = 181,866 production + 152,955 test),
i.e. a real **+5,893** over the comparable round-55 figure from the R1-R4
landings (`daemon` 53,883, `extension-ingress` 35,909, `tests` 32,026, `scripts`
6,376, `packages/browser-adapter` 32,935, `dashboard` 10,829; every other area
unchanged and the `[2]` areas still sum to the `[2b]` totals; JSON **65** files /
**30,259** lines, docs 11 files / 4,642 lines). Only same-generator snapshots are
comparable. `test-all` is **2220 passed + 1 skipped / 2221** tests (15
`node --test` segments, all `fail 0`; +18 vs round 55: `ui-i18n` 15->21, `ui`
22->31 for the quick-bar/record-workflow cases, plus the compat/daemon-route
cases). Honest gate record: the extension (22 steps), `--with-ui`, `--with-ui-visual`,
`--with-budget` and `--with-quick-record` gates passed first-run, while the
default gate's **first attempt failed only on `bench quick`**
(`concurrency-4-speedup=1.64x < 1.75x`, 20/21 checks) and passed **20/20 on the
retry**; no threshold, assertion or budget was relaxed, the failure is recorded
in `docs/TEST-STATUS.md` #56 and `0.4/STATUS.md` round 56. Remaining written
boundaries: the manifest still declares the unmatched
`web_accessible_resources: ui/locales/*.json` (out of this task's write scope),
`trace.get`/`trace.list`/`record.status` need a daemon `traceStore` (no store ->
honest `found:false`), TraceV3 has no per-step timestamp so the summary duration
column is `—`, and `it` has no content-script word table (written as-is, the
content script falls back to the browser language exactly as before the bridge).
### Round 57 (2026-11-24, quick-action / more-menu / in-page record-capsule close-out: T1 capability correction + capsule E2E, smoke/E2E expectation updates, third visual-baseline re-record) -- block regenerated, classification unchanged

Round 57 adds **no wire method, field or error code** and changes **no
classification**: usable is still **77/77 (scope-conditioned)**, full **53** /
partial **0** / refused **0**, control **24/24 real**, 0 missing codecs. The
landed work is the T1-T3 product surface (task-144..146) plus this task's
integration: T1 made `tab.borrow` / `dashboard.open` / `screenshot.capture` real
channels, so the compat layer now advertises **18 quick actions = 17 available +
1 typed-unavailable (`help.request`)** and `bb.call` is a **17-method** whitelist
(15 existing + `tab.borrow` + `screenshot.capture`) plus the local
`dashboard.open`; the opt-in quick-record E2E's stale "four permanently disabled
actions" expectation was corrected to real capability plus explicit runtime-truth
assertions (an unconfigured dashboard address stays a typed
`E_UI_COMPAT_UNAVAILABLE`, a bounded inline screenshot really returns an image,
a missing-param borrow is a typed failure and never a fabricated user
confirmation). T2 added the popup "more" overflow menu (9 items), T3 added the
in-page record capsule (`content/record-capsule.js`, second wrapper surface after
the status overlay): the real-page E2E proves the open shadow-DOM capsule
appears while recording and ticks for real, a real CDP Input click on Finish
drives the SW `record.stop` (daemon `record.status.recording=false`, host
removed, `snapshot.state=inactive`), and the popup then reports "stopped
externally" honestly instead of faking its own stop. The declared
`content_scripts` went **3 -> 4** (exact matches/js/run_at/all_frames +
classic-script checks for `record-capsule.js`), standalone smoke is **347/347**
and `test-all` explicitly collects `record-capsule.test.mjs`: **2273 passed + 1
skipped / 2274** tests (15 `node --test` segments, all `fail 0`; +53 vs round
56's 2221 = capsule 37 + T1/T2/T3 unit cases 16). The three pixel baselines were
**re-recorded a third time** because the "more" menu really changed the popup
pixels: write mode 37/37, verify mode 2 runs x 43/43 standalone (86/86 in the
`--with-ui-visual` gate), all-cells max popup 2.07 / options 0 / dashboard 0.86
and **0 over cells**, same tolerances/floors/0 px size tolerance (verify mode
never writes). Coverage scope is unchanged (generated `dist-extension-ingress*`
staging copies stay excluded): **257,097** lines = **140,131** production +
**116,966** test (**77.0% / 76.5% / 76.8%** of BSK 334,821), a real **+5,561**
vs round 56's 251,536 on the same scope (`extension-ingress` 35,909 -> 40,267,
`daemon` 53,883 -> 54,585, `tests` 32,026 -> 32,518, `scripts` 6,376 -> 6,385;
other areas unchanged and the `[2]` areas still sum to the `[2b]` totals; JSON
65 files / 30,270 lines). Gate record: the default (**20/20**), `--with-ui`
(**20/20**), `--with-ui-visual` (**20/20**), `--with-budget` (**20/20**) and
`--with-quick-record` (**20/20**, quick-record **179/179**) gates passed
first-run; the extension gate needed **two retries** — attempt 1 hit the
historically recorded headed-Edge human-attribution duplicate-delivery flake
(`cooperate attribution` 56/57, human 0->2 / revision 2->4; standalone 134/134),
attempt 2 hit a `bench quick` p95-latency miss (`daemon-act-p95=161.14ms <=
150ms`, 20/21) — before passing **22/22**; both non-green attempts are recorded
in `docs/TEST-STATUS.md` #57 and `0.4/STATUS.md` round 57, no threshold,
assertion or budget was relaxed. Remaining written boundaries: quick actions
advertise backend capability, not "configured on this machine" (the dashboard
address must be explicit), the capsule is a status mirror that hides when the
state is untrusted or the page is not visible, the manifest still declares the
unmatched `web_accessible_resources: ui/locales/*.json` (out of this task's write
scope), `trace.get`/`trace.list`/`record.status` need a daemon `traceStore`, and
TraceV3 still has no per-step timestamp (duration column `—`).

### Round 62 (2026-11-25, task-163: notification icon/buttons/click routing + 21-artifact pagination stress) — block regenerated, classification unchanged

Round 62 adds **no wire method, field or error code** and changes **no
classification**: usable is still **77/77 (scope-conditioned)**, full **53** /
partial **0** / refused **0**, control **24/24 real**, 0 missing codecs. The
landed work (AD1/task-161, AD2/task-162) and this integration round touch only
the extension notification surface and the dashboard read plane: the help/borrow
notification icon moved from inline `data:image/svg+xml` (which real Edge
rejected) to the packaged `icons/icon128.png`, with two buttons and SW-level
`onClicked`/`onButtonClicked` routing, so the real headed-Edge E2E can now
assert `create ok:true` + a real notification id; the dashboard E2E records
**21** real MJPEG-AVI artifacts and reports **45** checks/run; the paginated
artifact page discloses a bounded (truncated) 1,000-row catalog scan on the
**empty** page as well; `test-all` explicitly collects
`extension-ingress/test/background.test.mjs` so the routing suite is no longer
standalone-only. Coverage scope is unchanged (generated
`dist-extension-ingress*` staging copies stay excluded; 0.4 markdown/JSON are
reported separately in `[1c]`, now 11 docs files / 5,822 lines and 65 JSON files
/ 30,271 lines): **275,046** lines = **145,860** production + **129,186** test
(**80.2% / 84.5% / 82.1%** of BSK 334,821) — a real **+1,057** vs round 61's
**273,989** on the same scope; the `[2]` areas still sum to the `[2b]` totals.
The `[0]`/`[2]` prose rows were brought back in sync with the generator this
round (they had drifted since round 57 while `--check` only validates the
`[1]`/`[2]`/`[3]` block and method names). Gate record (test-all **2335 passed +
1 skipped / 2336**, 10 stage-gate runs and the standalone
eval/coverage/source-guard/compliance/size steps) is in `docs/TEST-STATUS.md`
#62 and `0.4/STATUS.md` round 62; no threshold, assertion, budget or tolerance
was relaxed.

### Round 63 (2026-11-25, task-164 AF1 + task-166 AG1: encoding close-out) — block re-checked, numbers re-synced

Round 63 adds **no wire method, field or error code** and changes **no
classification**: usable is still **77/77 (scope-conditioned)**, full **53** /
partial **0** / refused **0**, control **24/24 real**, 0 missing codecs. The
round is encoding/documentation close-out only: AF1 (task-164) collected
`extension-ingress/test/ui-compat.test.mjs` in `test-all` (+9 **production** lines
in `0.4/scripts/test-all.mjs`), rewrote `0.4/bench/README.md` as strict UTF-8 and
extended the source-guard encoding root to 0.4 product docs; AG1 (task-166) fixed
the one remaining illegal UTF-8 test name in
`0.4/packages/browser-adapter/test/fill.test.mjs` (same line count) and added all
194 0.4 `*.test.mjs` files to the strict-UTF-8 scan. Because only the `scripts`
production lines changed, the authoritative figures are now **275,055** lines =
**145,869** production + **129,186** test (**80.2% / 84.5% / 82.1%** of BSK
334,821); `[2]` still sums to `[2b]` (the `scripts` row is 6,850). The `[0]`/`[2]`
prose rows were re-synced to the generator this round (§0, §2), and
`node 0.4/scripts/bsk-coverage.mjs --check` passes (77 method names + output
block). Gate record (test-all **2371 tests / 2370 passed + 1 skipped / 0
failed**, the stage-gate matrix and the standalone eval/coverage/source-guard/
compliance/size steps) is in `docs/TEST-STATUS.md` #63 and `0.4/STATUS.md`
round 63; no threshold, assertion, budget or tolerance was relaxed.

### Round 64 (2026-11-25, task-168/169/170 CUT: 0.4 self-invented popup surfaces removed) — block regenerated, classification unchanged

Round 64 adds **no wire method, field or error code** and changes **no
classification**: usable is still **77/77 (scope-conditioned)**, full **53** /
partial **0** / refused **0**, control **24/24 real**, 0 missing codecs. The round
is a **scope shrink** driven by `docs/FEATURE-SCOPE-0.3-BSK.md` (only features
that already exist in 0.3.0 or upstream 0.5.0 stay; self-invented UI surfaces are
removed):

- Removed product surface: popup quick bar (8 items), "more" menu (9 items),
  quick-item recent-memory keys, single/combo-key shortcuts + shortcut-help layer,
  `#helpNotify` notification toggle, `#videoSavePanel`, `#recordNavWarn`, the
  TraceV3 `#recordCard` record console, the popup answer form `#helpAnswer*`, the
  `bb.quick` 25-action envelope + `bb.state.ui_compat.quick_actions`,
  `dashboard.open`/`bb.dashboard.url|port`, the `HELP` badge branch, the
  dashboard notification button, and the popup-record workflow E2E
  (`ui-quick-record-e2e.mjs`, `ui-more-menu-e2e.mjs`, `ui-help-e2e.mjs`).
- Kept (0.3/0.5.0-aligned) surface: 0.3 popup/options id surface + read-only
  `#helpCard`, five feature panels, four 0.3 settings switches, borrow
  confirmation, in-page status overlay (now reads 0.3
  `bb.settings.controlHint`), record capsule, human input attribution,
  `ext.collect`, one-button help notification, `REC`-only badge, `bb.*`
  5 supported types with a 17-method `bb.call` allowlist and the
  `UI_COMPAT_LEGACY_PANEL_TYPES` 0.3-panel mapping, 12-language key bridge.
- Authoritative size figures are now **261,617** lines = **141,973**
  production + **119,644** test (**78.1% / 78.2% / 78.1%** of BSK 334,821);
  `[2]` sums to `[2b]` (`tests` 32,556, `scripts` 6,529,
  `extension-ingress` 40,151; UI tree 41 files / 391,825 B). The `[0]`/`[2]`
  prose rows were re-synced to the generator this round (§0, §2), and
  `node 0.4/scripts/bsk-coverage.mjs --check` passes (77 method names + output
  block). Gate record (test-all **2345 tests / 2344 passed + 1 skipped / 0
  failed**, the reduced opt-in matrix, eval/coverage/source-guard/
  compliance/size steps) is in `docs/TEST-STATUS.md` #64 and `0.4/STATUS.md`
  round 64; no threshold, assertion, budget or tolerance was relaxed — the
  decrease is deleted surface, not weakened assertions.
