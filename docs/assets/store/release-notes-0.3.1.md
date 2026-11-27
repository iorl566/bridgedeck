# BridgeDeck 0.3.1 — Release Notes

## Highlights

- **New brand mark & page layout** — popup and extension pages now share a clearer hierarchy, larger typography, more whitespace and a consistent blue brand.
- **Action recording** — the record panel now generates a ready-to-send instruction for your agent (topic + start URL), while keeping one-click direct recording.
- **Agent takeover card** — brand-consistent status signal, pause/stop icons, click-through card so it never blocks the page.
- **Long screenshot & video status chips** — centered and stacked, with recording progress visible.
- **Popup footer** — now shows CLI / extension / protocol versions.
- **Localization** — 12 UI languages completed for new strings; a11y, RTL and WCAG AA contrast gates pass.
- **Release hygiene** — both source and built artifacts are scanned to be free of third-party brand references.

## Fixes

- Fixed takeover overlay intercepting page clicks.
- Fixed record toast logo foreground color.
- Fixed help card initial placement (bottom-center, draggable).
- Fixed popup quick-features header alignment and nested card layout.

## Verification

- Unit tests 5060 / 5060, CLI selftest 404, MCP selftest 216, Python 181.
- Real Edge E2E 222 / 222.
- Release preflight PASS (9 artifacts, signed manifest; local verification key unless production key is configured).

## Notes

- Chrome/Edge Chromium 111+ required.
- Local daemon on 127.0.0.1 by default; no telemetry, no cloud dependency.
- Privacy policy: https://iorl566.github.io/bridgedeck/privacy-policy.html
- Support: https://github.com/iorl566/bridgedeck/issues
