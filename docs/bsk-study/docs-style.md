# BSK 0.5.0 — docs / code style / contracts

Source root: `ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0`.

## Core model

Documentation is part of the runtime contract, not release prose. `README.md`
states the user-visible capabilities; `docs/*.md` define the invariants that
CLI/extension tests assert (`docs/protocol-compatibility.md`,
`docs/dynamic-reading.md`, `docs/recoverable-session-starts.md`). Code style is
enforced by `biome.json`, `tsconfig*`, and naming rules; generated protocol files
are checked in and byte-compared (`scripts/protocol.mjs`).

## Five invariants

1. One behavior has one normative document; tests quote the same terms.
2. Protocol docs state defaults for omitted parameters and the failure before
   effects for new ones (`docs/protocol-compatibility.md:8-21`).
3. Read-only vs mutating is defined by `ToolEffect`, not by prose
   (`apps/extension/src/tools/policy.ts`).
4. Error text names the component, the missing feature and the recovery action.
5. Generated artifacts are never hand-edited; `protocol:check` proves drift.

## Three practices

- Design notes start from an incident or a concrete failure mode (recoverable
  starts, dynamic reading, scroll-to, video recording) and end with regression
  coverage.
- Naming is verb-noun at the CLI, noun/state at the protocol, and explicit
  `effect_state` / `stop_reason` / `coverage` in results.
- Docs use tables for compatibility and state matrices; code uses narrow
  interfaces (`Transport`, `CdpRunner`, `ToolHandlerMap`).

## Adopt for BridgeDeck

1. Keep `docs/PROTOCOL.md` + generated schemas as the contract; add a
   `docs/CODE-THEORY.md` index so new modules have a decision record.
2. Every new optional feature gets a protocol floor and a test that proves
   rejection happens before browser effects.
3. Every state machine has a named terminal state and a published reason.
4. Keep a small set of normative docs (protocol, lifecycle, error taxonomy,
   test oracle); everything else is an ADR.

## Reject

- Copying BSK's React/WXT/i18n dependency surface into our zero-dependency
  runtime.
- Long prose without a matching test or invariant.
- Two sources of truth for a protocol constant or feature floor.

## Gaps in BridgeDeck

1. Many design decisions live only in chat/release notes, not in a normative
   theory document.
2. Error taxonomy has codes but no universal `(category, effect_state,
   recovery)` contract.
3. No checked-in method/feature catalog that both daemon and extension consume.
4. Browser lifecycle docs are thinner than the actual edge cases.
5. No ADR template for "why this state machine exists".
