# Test status — 0.1.12

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

- GitHub v0.1.12: public, signed (keyId `c7b5e21301f91a2d`).
- Edge 0.1.12: submitted for review (2026-11-17), screenshot `docs/assets/ui/edge-store-0.1.12-review.png`.
- Extension: **438,216 B**, sha256 `60dfbf04b7030a5e71f9954402a3d3865d39a580a13942cea75575097913bd64`.
- 0.1.10 artifacts archived under `dist/archive-0.1.10/`.

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
- Current full E2E: **149/149**, 0 skipped; unit **484/484**.
- Not released; 0.1.12 remains latest.
