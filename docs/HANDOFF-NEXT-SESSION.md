# BridgeDeck Handoff (Round 636)

Working directory: `D:\浏览器桥`
Release version: **0.3.0** (frozen: no version bump, no repackaging, no release)
Workspace: working tree only, no git commit.

## 1. Read first

1. `0.4/STATUS.md` - current 0.4 counts and gates.
2. `0.4/FINAL-AUDIT.md` - current audit and limits.
3. `docs/bsk-study/0.4-MIGRATION-MATRIX.md` - BSK domain comparison.
4. `docs/TEST-STATUS.md` - append-only verification log.
5. `docs/BACKUPS.md` or the backup folder below.

## 2. Current gates

| Gate | Result |
| --- | --- |
| 0.3 unit | 1025/1025 |
| 0.3 full E2E | 212/212 Edge + 212/212 Chrome |
| 0.3 release preflight | PASS / 0.3.0 |
| 0.4 all packages | 1300/1300 |
| 0.4 eval corpus | 43/43 |
| 0.4 stage gate `--with-remote` | 15/15 |
| 0.4 daemon `0.4/daemon/server.mjs` | real Edge + HTTP JSON-RPC |
| 0.4 MCP `0.4/mcp/server.mjs` | 8 tools, live smoke |
| 0.3 session runner E2E | real daemon + Edge |
| 0.4 scale | 396 files / 117,865 true lines / 1300 tests |

0.4 is about 35.8% of BSK 0.5.0 by true lines; 0.3 + 0.4 combined about 63.6%.

## 3. Real capabilities

- Remote CDP over headless Edge; CLI and DSH host tools.
- Real actions: click, hover, scroll, wheel, fill, select, upload, download, press, drag.
- Real observation: VOM, AX, semantic graph, extract, read, network, console, snapshot, full-page screenshot.
- Addressable refs: `domPath` -> `backendNodeId`; snapshot emits `[bnN]`; `tool.click(ref)` tested with real page state change.
- Protocol adapter handlers: 53/53 `tool.*` methods.
- None missing; `tool.video` writes MJPEG AVI and `tool.cooperate` is state-only.

## 4. Known limits

- Several handlers are partial: request_help always times out; session/tab_borrow are metadata-only; debug only exposes capabilities. Recording has real steps/states.
- Host remote calls start a fresh browser, so tab IDs and refs do not persist across calls.
- OOPIF parent-page Input is browser-limited. VOM late-node refs are fixed; drag source/dropzone get `[bnN]` at high budget and ref-drag is in the stage gate.
- Collaboration has capture-control and overlay state machines, but no rendered overlay UI.
- Eval corpus has 39 live fixture cases plus fake cases.
- DSH default executor is wired as the plugin fallback.
- Linux/macOS and native fsync are unverified.
- DSH process-level restart is untested; only plugin reload is tested.
- Chrome extension probe loading recovery remains external.

## 5. Constraints

- Keep 0.3.0; do not bump, repackage, or release without explicit user request.
- Do not modify `D:\CTRM自动录入`.
- Do not touch signed `dist`.
- Do not claim Linux/macOS/native fsync or DSH process restart.
- Use Node or the `write`/`edit` tools for UTF-8 edits; do not round-trip Chinese docs through PowerShell `Set-Content`/`Get-Content`.
- Backup naming: `D:\BridgeDeck-backups\BridgeDeck-<topic>-<timestamp>.zip`, excluding `node_modules` and `.git`.

## 6. Verification commands

```powershell
node 0.4/scripts/test-all.mjs
node 0.4/scripts/eval.mjs run
node 0.4/scripts/stage-gate.mjs --with-remote
node --test tests/unit/*.test.mjs
$env:BB_E2E_SYNC_DOCS='0'; node tools/e2e.mjs
node tools/release-preflight.mjs
```

## 7. Next steps

1. Expand real browser eval cases beyond the fake runner.
2. Connect collaboration overlay/capture suppression.
3. Complete record trace steps/states.
4. Add actual real-video path or keep `tool.video` explicitly unsupported.
5. Wire a 0.4 default DSH executor.
6. Verify Linux/macOS/native fsync in an external environment.

## 8. Backup

Latest backup at time of writing: `D:\BridgeDeck-backups\BridgeDeck-0.4-matrix635-20261123-112709.zip`.
