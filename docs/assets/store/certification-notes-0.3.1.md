# Certification notes — BridgeDeck 0.3.1

Submission type: update to an existing extension (0.3.0 → 0.3.1).
Package: `BridgeDeck-extension-0.3.1.zip` (uploaded through the Edge Add-ons API as a draft).

## What BridgeDeck is

BridgeDeck is a local bridge between a command-line AI agent and the browser the user is already
signed in to. The extension itself contains no AI model and does not contact any AI provider. It
talks to a daemon that the user runs on their own machine, on `127.0.0.1`, over a local WebSocket;
the daemon exposes a CLI / MCP server that an agent can call.

## What changed in 0.3.1

- Refreshed branding and page layout for the popup and the extension pages.
- New accessibility overlay option (uses open shadow DOM with `role` / `aria-live`; closed by default).
- Action recording can now generate a ready-to-send instruction for the agent, and export a
  `trace.json` plus per-step states.
- Protocol compatibility layer: more CLI aliases, 27 error-code aliases, and added fields on
  several commands.
- Smaller package: the bundled word list was re-packed, about 18% smaller than 0.3.0.
- Fixes: takeover overlay could intercept page clicks; record toast logo color; help card placement;
  popup quick-features alignment.

## How to review without a daemon (no account needed)

The extension is completely usable at the UI level without the local daemon, and no sign-in or test
account is required. Steps:

1. Install the extension from the submitted package.
2. Open the extension popup. It renders immediately and shows the connection state
   ("Not connected" is expected on a reviewer machine, because the local daemon is not running).
   The popup also shows the CLI / extension / protocol versions and the automation settings
   (control card, confirm before borrowing a tab, allow human-help requests).
3. Click "Quick actions" in the popup: video recording, website debugging, long screenshot,
   action recording and operation audit pages all open as normal extension pages and render.

Automation itself requires the user's own daemon, which is a Node.js program outside the extension
package. Reviewers do not need it to verify that the extension loads, is interactive and stays within
its declared permissions.

## Permissions and privacy

- `<all_urls>`: the agent works on arbitrary sites the user chooses; page automation and content
  scripts cannot be scoped to a fixed list.
- `debugger`: trusted input events, screenshots, accessibility tree, closed shadow DOM and network
  evidence — these are required by the product's purpose and are used only while a task runs.
- `tabCapture` + `offscreen`: optional task recording started explicitly by the user.
- `declarativeNetRequest`: user-defined request block/redirect rules while debugging.
- No remote code: everything is bundled in the package. No `eval`, no `new Function`, no remotely
  hosted scripts.
- No telemetry, no analytics, no advertising. Network traffic goes to `127.0.0.1` only, unless the
  user explicitly configures a remote daemon, in which case WSS with authentication is required.

Privacy policy: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Contact

https://github.com/iorl566/bridgedeck/issues
