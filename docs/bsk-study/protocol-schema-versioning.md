# BSK 0.5.0 — wire protocol, schemas, versioning, error taxonomy, validation, compatibility

Studied: `crates/bsk-protocol/**`, `apps/extension/src/transport/{protocol,types,compatibility,handshake,ws-transport}.ts`,
`transport/generated/**`, `scripts/protocol.mjs`, `docs/protocol-compatibility.md`. All paths are relative to
`ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/`. No BSK file was modified.

## Core model
One **method catalog** is the only wire contract: a `methods!` macro emits `Method` (78 variants), `ALL`,
`wire_name()`, `owner()` (Daemon/Extension/Shared), `effect()` (PassiveRead/TransientInput/BrowserMutation/
ControlPlane), `accepts_action_metadata()`, `features()` and `describe()` → `(params,result)` schemars types
(`crates/bsk-protocol/src/method.rs:33-181`). Every consumer matches it exhaustively: dispatcher handlers,
extension policy map, daemon deadlines (`crates/bsk-cli/src/daemon/tool_policy.rs:27-129`), schema export.
Frames are hand-coded JSON-RPC-ish: `Request{id,method,params?}`, `Response{id, result|error}` (exactly one),
`Event{event,payload}`, with a manual `Visitor` so scalars/arrays/ambiguous frames/duplicate keys are rejected
(`.../src/frame.rs:103-287`). Errors are **two-level**: closed `ErrorCode` (15 values) for switching
(`src/error.rs:20-77`) plus an open `data.reason` union (`RpcErrorReason`, 100+ values, ignored by old peers,
`error.rs:84-189`); CLI rendering keys on `(code, reason)` over a per-code `{summary,hint,exit_code}` table
(`crates/bsk-cli/src/cli/render_error.rs:109-330`), exit 1 user / 2 protocol+transport+cancelled / 3 cdp /
4 timeout / 5 version / 6 dialog_pending (`:14-34`). Every post-dispatch failure must carry
`data.effect_state ∈ {none,committed,unknown}`; anything else is coerced to `unknown`
(`crates/bsk-cli/src/daemon/queue.rs:1114-1150`). Versioning is **two-axis**: app semver never gates;
`protocol_version` = `MAJOR.MINOR` (`src/catalog.rs:12-13`) is the only handshake input → `Ok|Skew|Reject`
(`src/system.rs:9-100`); optional features are a third axis, a `Feature → (operation, daemon floor, extension
floor, when-predicate)` table (`src/compatibility.rs:37-216`).

## 5 invariants
1. **One source of truth, proven by byte-compare.** `scripts/protocol.mjs` re-derives types, Ajv validators,
   normalizers, manifest and all standalone schemas from `export-protocol`; `--check` fails on modified *or
   unexpected* files (`:352-376, 388`), and missing/duplicate method-contract-feature fails generation (`:56-76`).
2. **Exactly one of `result`/`error`.** Absent, both, or `error:null` are decode errors; explicit `result:null`
   is valid `Ok(null)` (`frame.rs:130-163, 272-285`, tests `:355-431`).
3. **Validate → normalize → re-validate → assert.** Params go wire-schema → immutable generated normalizer →
   canonical schema → typed (`apps/extension/src/transport/protocol.ts:69-98`); a result failing the sender
   contract becomes `protocol_error` with `effect_state:"unknown"` (`:100-112`).
4. **`effect_state` gates replay.** `none` allows retry, `committed`/`unknown` forbid it; per `(session,tab)`
   the IntentWal holds `DISPATCHED→SETTLED|UNKNOWN→RECONCILED` and a pre-dispatch gate answers
   `permission_denied`+`uncertain_prior_effect` (`daemon/intent_wal.rs:9-24, 205-237`).
5. **Parser symmetry between peers.** Rust `parse_major` and TS `parseProtocolMajor` accept the identical set:
   strict `/^\d+$/`, no sign/whitespace, cap `2^53-1` (`system.rs:136-186`, `lib/semver.ts:62-68`), pinned by
   mirrored tests (`system.rs:188-319`).

## 3 algorithms
**Handshake tree** (`system.rs:42-100`): unparseable or major mismatch → Reject; peer below our floor → Reject;
we below peer floor → Reject (skipped when peer omits it); strings differ same-major → Skew; else Ok. Daemon
rejects with `version_too_old` + diagnostic payload (`daemon/ws.rs:303-323`) and always advertises its floor
(`:392-402`); the extension re-implements the same order rather than trusting the daemon
(`lib/connection-controller.ts:435-474`).
**Contract generation** (`protocol.mjs:182-350`): Ajv compiles to **standalone ES modules** (no runtime
compiler/eval/network in MV3); normalizers are emitted per definition and pick `anyOf`/`if` branches by
validating against the *wire* schema, preserving tagged unions and dictionaries (`:206-283`); a sha256 of the
catalog lands in `manifest.json` (`:325, 336-350`).
**Feature preflight** (`compatibility.rs:254-265`): per declared feature evaluate `requested(peer,params)` then
`require(peer,protocol)` → `unsupported` with `data{reason:"unsupported_feature", phase:"negotiate", feature,
component, required/actual_protocol, effect_state:"none", recovery}` before any browser effect (`:218-251`).
`ControlPolicy` is the one asymmetric predicate (CLI probes `target|auto`, daemon forwards only `target`, `:206-215`).

## 5 edge cases
1. **Explicit null vs absent:** normalizer deletes `null` only for *non-required nullable* properties, so
   arbitrary JSON and dictionaries keep nulls (`protocol.mjs:78-116`, generated `normalizers.ts`).
2. **Lone UTF-16 surrogates:** page text split by UTF-16 makes `serde_json` drop the whole frame; extension
   re-serializes with `toWellFormed()` only when `\ud[89ab]` appears (`transport/ws-transport.ts:160-165`).
3. **Deliberately odd versions:** `"1."`/`"1.x"` = major 1 (trailing segments ignored) but `"+1"`, `" 1"`,
   `"1e3"`, `u64::MAX` rejected — std parsing asymmetry is what this guards (`system.rs:100-186, 276-308`).
4. **Duplicate JSON keys:** Rust rejects (local-auth parses the original text, never a `Value`, capped at 4 KiB);
   JS `JSON.parse` is last-wins, so the gap is closed by schema+proof over the same parsed value
   (`src/local_auth.rs:228-235`, `crates/bsk-protocol/README.md:64-69`).
5. **Trace v2/v3 selection with no discriminator:** numeric `version` selects v3 and forbids `pages[]`; else v2
   and `states[]` is an error; JSON Schema encodes the same `if/then/else` (`tools/record.rs:63-129`,
   `tools/record_v2.rs:126-136`).

## Tests
Contract facts are locked next to the type: wire-name/`ALL` uniqueness (`frame.rs:343-353`, `error.rs:220-230`),
`accepts_action_metadata` ⇔ `Feature::ActionConditions` (`method.rs:225-241`), unicode code-point limits
(`tools/cooperate.rs:204-217`), schema shape (`tools/record_v2.rs:256-278`, `src/bin/dump-schema.rs:139-224`).
Cross-language vectors: one JSON fixture read by Rust (`tests/local_auth.rs` + `tests/fixtures/local-auth-v1.json`).
End-to-end over real WS: Ok/Skew/both reject branches/legacy-without-floor/skew in `system.status`
(`crates/bsk-cli/tests/handshake_compat.rs`). `pnpm protocol:check` proves source sync only; browser behavior is
the separate `evals/browser` corpus, which never reports missing adapter evidence as pass (`evals/browser/README.md:9-23`).

## 5 adopt for BridgeDeck
1. **One macro table → exhaustive consumers** (`method.rs:33-101`; ownership table `bsk-protocol/README.md:75-88`):
   wire name, owner, effect, params/result, features in one declaration so a half-registered method cannot compile.
2. **Two-axis versioning + per-feature floors with activation predicates**, so omitted params stay backward
   compatible while explicitly requested features fail before effects (`compatibility.rs`,
   `docs/protocol-compatibility.md:8-21`).
3. **Closed code + open reason + `(code,reason)` render table + fixed exit codes**, with mandatory `effect_state`
   on every post-dispatch failure (`error.rs`, `render_error.rs:109-330`, `queue.rs:1114-1150`).
4. **Generated, byte-compared artifacts** exporting input (deserialize) and output (serialize) schemas separately
   plus a manifest fingerprint (`catalog.rs:128-153`, `protocol.mjs:290-350`).
5. **Effect-safety ledger with RAII downgrade:** `IntentTicket::drop` promotes an unfinished dispatch to `UNKNOWN`,
   so panic/cancel can never leave a tab looking clean (`intent_wal.rs:108-125`).

## 3 reject
1. **Two exported constants, same name, different values:** the real floor is hand-written `"1.6"`
   (`transport/handshake.ts:27`) while generated `MIN_COMPATIBLE_PROTOCOL="1.0"` sits unused in
   `transport/generated/methods.ts:4`, and every consumer imports the hand-written one
   (`lib/connection-controller.ts:1-12`). Derive one floor; make a second one uncompilable.
2. **One flat global reason namespace** for ~20 tools (single `CleanupFailed`, single `TransferTimeout`,
   `error.rs:84-189`). Use `(domain, reason)` or namespaced reasons instead of one growing enum.
3. **Re-deriving effect from raw params at runtime:** `is_tool()` sniffs a wire-name string prefix
   (`method.rs:79-81`) and `requires_interrupt_gate_with_params` re-parses an untyped `action` string to
   reclassify `tool.debug`/`tool.video` (`method.rs:186-203`), duplicating the action tables in `tools/debug.rs`
   and `tools/video.rs`. Keep per-action effect in the catalog.

## 5 gaps
1. **No bounds on the strings that matter:** `session_id`, `selector`, `ref`, `capture_id` have no
   `maxLength`/pattern (`schema/tool_click_params.json:148-170`); only `expect.target` (1024) and `attribute`
   (256) are bounded (`tools/cooperate.rs:76-88, 108-131`).
2. **Params schemas are not closed:** no `additionalProperties` is emitted, so runtime validators accept unknown
   fields while generated *types* are closed (`protocol.mjs:128-136`); only `ActionExpectation` uses
   `deny_unknown_fields` (`tools/cooperate.rs:74-76`). "Validated" ≠ strict.
3. **Schema drift between sibling fields:** `ActionMetadata.context_id` emits `{"type":"string"}` but
   `observation_id` emits `{"type":["string","null"]}` purely from `#[schemars(with="String")]` on one
   (`schema/action_metadata.json:61-87`; `tools/cooperate.rs:48-71`).
4. **The extension's floor is invisible to the catalog:** `"1.6"` lives outside `feature_requirements`/
   `min_compatible_protocol`, so `bsk status`/popup guidance cannot derive "this daemon is too old for this
   extension" from generated metadata (`transport/handshake.ts:22-32` vs `catalog.rs:12-13`).
5. **Cross-field rules are unmodeled:** `ref` XOR `selector`, `capture_id` requiring `image_x/image_y`,
   `expect.equals` type per `field`, `attribute` only with `field=attribute` live in handlers or a hand-written
   `validate()` (`tools/cooperate.rs:108-131`); the README concedes schema cannot establish runtime facts
   (`bsk-protocol/README.md:85-88, 112-116`). Add a per-method cross-field validation registry.
