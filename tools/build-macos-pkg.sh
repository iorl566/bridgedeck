#!/usr/bin/env bash
# Build a signed/unsigned macOS installer package from a staged CLI directory.
#
# Usage:
#   tools/build-macos-pkg.sh --stage <dir> --version 0.1.2 --out dist/x.pkg \
#     [--identity-installer "Developer ID Installer: ..."]
#
# Layout: /usr/local/lib/bridgedeck + /usr/local/bin/bridge (symlink).
set -euo pipefail

STAGE=''
VERSION=''
OUT=''
IDENTITY=''
IDENTIFIER='com.bridgedeck.cli'

while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --identity-installer) IDENTITY=$2; shift 2 ;;
    --identifier) IDENTIFIER=$2; shift 2 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$STAGE" ] || { echo "--stage is required" >&2; exit 2; }
[ -n "$VERSION" ] || { echo "--version is required" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
[ -d "$STAGE" ] || { echo "not a directory: $STAGE" >&2; exit 1; }
[ "$(uname -s)" = 'Darwin' ] || { echo 'build-macos-pkg.sh only runs on macOS' >&2; exit 1; }
command -v pkgbuild >/dev/null 2>&1 || { echo 'pkgbuild not found (install Xcode Command Line Tools)' >&2; exit 1; }

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bb-pkg.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/usr/local/lib/bridgedeck" "$ROOT/usr/local/bin"
cp -R "$STAGE"/. "$ROOT/usr/local/lib/bridgedeck/"
ln -s ../lib/bridgedeck/bin/bridge "$ROOT/usr/local/bin/bridge"
chmod 755 "$ROOT/usr/local/lib/bridgedeck/bin/bridge" 2>/dev/null || true

mkdir -p "$(dirname "$OUT")"
unsigned="$OUT.unsigned"
pkgbuild --root "$ROOT" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  "$unsigned"

if [ -n "$IDENTITY" ]; then
  command -v productsign >/dev/null 2>&1 || { echo 'productsign not found' >&2; exit 1; }
  productsign --sign "$IDENTITY" "$unsigned" "$OUT"
  rm -f "$unsigned"
else
  mv "$unsigned" "$OUT"
fi

echo "pkg: $OUT"
shasum -a 256 "$OUT" | awk '{print "sha256 " $1}'
