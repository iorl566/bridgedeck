#!/bin/sh
# BridgeDeck one-line installer for macOS / Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/iorl566/bridgedeck/main/install-online.sh | sh
#
# Optional environment:
#   BRIDGEDECK_DEST=/opt/bridgedeck   install directory
#   BRIDGEDECK_VERSION=0.1.2          pin a release instead of latest
set -eu

REPO=${BRIDGEDECK_REPO:-iorl566/bridgedeck}
API="https://api.github.com/repos/$REPO/releases"
if [ -n "${BRIDGEDECK_VERSION:-}" ]; then
  API="$API/tags/v${BRIDGEDECK_VERSION}"
else
  API="$API/latest"
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "unsupported OS: $OS" >&2; exit 1 ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bridgedeck-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "[bridge] resolving latest release for $OS-$ARCH..."
JSON="$WORK/release.json"
curl -fsSL "$API" -o "$JSON"

URL=$(tr ',' '\n' < "$JSON" \
  | grep -o '"browser_download_url"[^"]*"[^"]*"' \
  | sed 's/.*"\(https[^"]*\)"/\1/' \
  | grep "BridgeDeck-cli-.*-${OS}-${ARCH}\.tar\.gz" \
  | head -n 1)
[ -n "$URL" ] || { echo "no $OS-$ARCH CLI asset in this release" >&2; exit 1; }

echo "[bridge] downloading $URL"
curl -fsSL "$URL" -o "$WORK/pkg.tar.gz"
tar -xzf "$WORK/pkg.tar.gz" -C "$WORK"
INSTALLER=$(find "$WORK" -name install.sh -type f | head -n 1)
[ -n "$INSTALLER" ] || { echo 'install.sh missing in package' >&2; exit 1; }

echo "[bridge] installing..."
if [ -n "${BRIDGEDECK_DEST:-}" ]; then
  sh "$INSTALLER" --dest "$BRIDGEDECK_DEST" --add-to-path
else
  sh "$INSTALLER" --add-to-path
fi

echo "[bridge] verifying..."
if command -v bridge >/dev/null 2>&1; then
  bridge status || true
else
  echo "bridge is installed but not on PATH yet; open a new terminal and run: bridge status"
fi
