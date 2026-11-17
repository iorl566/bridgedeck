# Test status — 0.1.9-dev

Last run: 2026-11-17, Windows Edge 157.

## Green

| Lane | Result |
| --- | --- |
| `node --test tests/unit/*.test.mjs` | **474/474** |
| `node --test tests/reference/*.test.mjs` | **507/507** |
| `node --test tests/integration/remote-device.test.mjs` | **1/1** |
| `tests/cli/selftest.mjs` | **155/155** |
| `tests/plugin/selftest.mjs` | **26/26** |
| `tools/overlay-dom-selftest.mjs` | **OVERLAY_DOM_OK:12** |
| `tests/unit/cooperation-dom.test.mjs` / browser | **COOP_DOM_OK:7** |
| `tools/release-preflight.mjs` on 0.1.8 | **PASS** |

## Real-browser E2E — not green

`BB_E2E_SYNC_DOCS=0 node tools/e2e.mjs`:

```text
结果：最佳完整运行 147/148，0 跳过，1 失败；最近一次尝试因 20d7 测试改动导致 session 级联失败，已回退。
```

`skip()` now records `ok:false` and the suite exits 1 when any skip exists; skips are **not** counted as passed.

### Failure groups (current)

- `20d7` iframe hover 未打开顶层菜单；
- `20p` 跨源 frame 在完整 E2E 下观察失败（测试本轮出现 frames undefined，尚未稳定复现）。

## Release decision

**Do not publish 0.1.9 yet.** The real-browser lane is not green; publishing would be a false green. 0.1.8 remains the last signed release.

Next work is to fix group 2 first (coordinate freshness, help overlay testability, iframe refs, no-clear, cooperate sync), then update group 1 tests to assert the *new* security/closed-shadow contracts rather than bypass them.
