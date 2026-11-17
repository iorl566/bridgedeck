# Test status — 0.1.9

Last run: 2026-11-17, Windows Edge 157.

## Final result

| Lane | Result |
| --- | --- |
| `node --test tests/unit/*.test.mjs` | **474/474** |
| `node --test tests/reference/*.test.mjs` | **507/507** |
| `node --test tests/integration/remote-device.test.mjs` | **1/1** |
| `tests/cli/selftest.mjs` | **155/155** |
| `tests/plugin/selftest.mjs` | **26/26** |
| `tools/overlay-dom-selftest.mjs` | **OVERLAY_DOM_OK:12** |
| `tests/unit/cooperation-dom.test.mjs` / browser | **COOP_DOM_OK:7** |
| `BB_E2E_SYNC_DOCS=0 node tools/e2e.mjs` | **148/148，0 跳过，0 失败** |
| `node tools/release-preflight.mjs` | **PASS** |
| `node tools/check-vendor-leak.mjs` | **clean** |

`skip()` records `ok:false`; any skip exits 1, so skipped checks are not counted as passed.

## Release

- GitHub v0.1.9: public, signed (keyId `c7b5e21301f91a2d`).
- Edge 0.1.9: submitted for review (2026-11-17).
- Extension: 431,910 B, sha256 `0e673c4c649a22810d6f2e644c38e532cfce6d2b0fd73a02cd0c692a9327c5a9`.
- 0.1.8 artifacts archived under `dist/archive-0.1.8/`.

## Notes

Real-browser E2E includes cross-frame observation, iframe click, record frame events, replaced-target fail-closed, borrow safety, and popup/overlay flows.
