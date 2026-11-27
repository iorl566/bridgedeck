# Certification notes — BridgeDeck 0.3.2

Submission type: update to an existing extension (0.3.1 → 0.3.2).

## What changed

- No UI or permission changes. No new permissions.
- `plan` tool gains an optional `observeAfter=false` parameter used by the CLI `--fast` mode;
  default behavior (observation after plan) is unchanged.
- CLI-only performance work (faster startup, `open --reuse-window`, faster extract) is not part of the extension.
- Bug fixes/docs from 0.3.1 remain as published.

## How to review

1. Install the extension; open the popup (renders without the local daemon).
2. Quick actions pages (video / debug / long screenshot / record / audit) render.
3. No account or backend needed; automation requires the user's local daemon on 127.0.0.1.

Privacy policy: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html
