# Test status — 0.2.0

Last run: 2026-11-17, Windows Edge 157.

## Final result

| Lane | Result |
| --- | --- |
| `node --test tests/unit/*.test.mjs` | **484/484** |
| `node --test tests/reference/*.test.mjs` | **507/507** |
| `node --test tests/integration/remote-device.test.mjs` | **1/1** |
| `tests/cli/selftest.mjs` | **155/155** |
| `tests/plugin/selftest.mjs` | **26/26** |
| `tools/overlay-dom-selftest.mjs` | **OVERLAY_DOM_OK:12** |
| `BB_E2E_SYNC_DOCS=0 node tools/e2e.mjs` | **148/148，0 跳过，0 失败** |
| `node tools/check-vendor-leak.mjs` | **clean** |
| `node tools/release-preflight.mjs` | **PASS** |

`skip()` records `ok:false`; any skip exits 1, so skipped checks are not counted as passed.

## Release

- GitHub v0.2.0: public, signed (keyId `c7b5e21301f91a2d`).
- Edge 0.2.0: submitted for review (2026-11-17), screenshot `docs/assets/ui/edge-store-0.2.0-review.png`.
- Extension: **441,717 B**, sha256 `2b2919a5dc6d5174898206fc878343f76823ba5a6fa45fe103bb002b58ada389`.
- 0.1.12 artifacts archived under `dist/archive-0.1.12/`.

## 0.1.11 focus

- `observe.layers` + layered text (`L1`/`L2`, blocker role/coverage/bounds);
- `observe.refDetails` (`ref` + `backendNodeId` + `frameId` + `documentId` + `revision`);
- `observe.tokenEstimate`;
- frame alias URL/documentId;
- trusted frame click with owner-quad projection and page-lib fallback;
- released-target fail-closed retained.

## 0.2.0 WIP (2026-11-18)

- RefKey registry / revision fence / Action Receipt / CDP backend route.
- Nested same-origin iframe owner-chain projection; E2E `23p2` asserts `via=frame-projected`.
- Cooperation frameState counters + 2-rAF capture suppression.
- Record events carry documentId; E2E 20d6 asserts it.
- Per-document record Port registry (`bb-record`) with documentId/frame/url.
- VOM observe returns visualRegions + visualRefs (coordinate map).
- Action Receipt now attached to error paths (`effectState: unknown`).
- Eval tri-state oracle + 12-case real-browser corpus (`tools/eval-from-e2e.mjs`) + CI lane.
- Authority: `cooperate sync` returns generation/revision/context/observation; E2E asserts it.
- RefKey auto-backend: page selector -> DOM.querySelector -> backendNodeId -> CDP click; E2E 7 asserts `via=cdp-backend`.
- Real OOPIF: `23p3` verifies `via=cdp-frame-owner` through `Page.getFrameTree` + `DOM.getFrameOwner`.
- Current full E2E: **150/150**, 0 skipped; unit **487/487**; eval corpus **passed**.\n- `23p3` real OOPIF passes via `cdp-frame-owner`.
- Not released; 0.1.12 remains latest.

## 0.3.0 WIP (2026-11-18)

- VOM: `visualObjects` fusion, `stableRef` metadata (backend/hash), revision-bound cursor.
- Capture: longshot writes capture manifest index (id/size/tiles/url/createdAt).
- Eval: 27-case real Edge corpus; `node tools/eval-from-e2e.mjs` status=passed.
- Cooperation authority: stale generation rejection in content; authority generation/revision returned.
- Current full E2E: 150/150, 0 skipped; unit 487/487.
- Not released; 0.2.0 remains latest.
