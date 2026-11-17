# Test status — 0.1.11

Last run: 2026-11-17, Windows Edge 157.

## Final result

| Lane | Result |
| --- | --- |
| `node --test tests/unit/*.test.mjs` | **477/477** |
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

- GitHub v0.1.11: public, signed (keyId `c7b5e21301f91a2d`).
- Edge 0.1.11: submitted for review (2026-11-17), screenshot `docs/assets/ui/edge-store-0.1.11-review.png`.
- Extension: **434,037 B**, sha256 `52a2942a75c4bff0558b61a6569d688902f6bccfcebf331969b9e34e9c3cfef4`.
- 0.1.10 artifacts archived under `dist/archive-0.1.10/`.

## 0.1.11 focus

- `observe.layers` + layered text (`L1`/`L2`, blocker role/coverage/bounds);
- `observe.refDetails` (`ref` + `backendNodeId` + `frameId` + `documentId` + `revision`);
- `observe.tokenEstimate`;
- frame alias URL/documentId;
- trusted frame click with owner-quad projection and page-lib fallback;
- released-target fail-closed retained.
