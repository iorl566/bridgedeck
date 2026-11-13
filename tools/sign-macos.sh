#!/usr/bin/env bash
# Sign every Mach-O binary in a packaged BridgeDeck directory (macOS only).
#
# Usage: tools/sign-macos.sh --dir <stage> --identity "Developer ID Application: ..."
# Requires a Developer ID Application certificate in the login keychain.
set -euo pipefail

DIR=''
IDENTITY=''
ENTITLEMENTS="$(cd "$(dirname "$0")" && pwd)/macos-entitlements.plist"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --entitlements) ENTITLEMENTS=$2; shift 2 ;;
    -h|--help)
      sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$DIR" ] || { echo "--dir is required" >&2; exit 2; }
[ -n "$IDENTITY" ] || { echo "--identity is required" >&2; exit 2; }
[ -d "$DIR" ] || { echo "not a directory: $DIR" >&2; exit 1; }
[ "$(uname -s)" = 'Darwin' ] || { echo 'sign-macos.sh only runs on macOS' >&2; exit 1; }

if ! security find-identity -v -p codesigning | grep -Fq "$IDENTITY"; then
  echo "code signing identity not found: $IDENTITY" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 1
fi

signed=0
while IFS= read -r -d '' file; do
  kind=$(file -b "$file" 2>/dev/null || true)
  case "$kind" in
    *Mach-O*)
      if [ "$(basename "$file")" = 'node' ]; then
        codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$file"
      else
        codesign --force --timestamp --options runtime --sign "$IDENTITY" "$file"
      fi
      codesign --verify --strict --verbose=2 "$file"
      signed=$((signed + 1))
      echo "signed: $file"
      ;;
  esac
done < <(find "$DIR" -type f -perm -111 -print0)

# Also sign dylibs and .node addons, which may not carry the executable bit.
while IFS= read -r -d '' file; do
  kind=$(file -b "$file" 2>/dev/null || true)
  case "$kind" in
    *Mach-O*)
      codesign --force --timestamp --options runtime --sign "$IDENTITY" "$file"
      codesign --verify --strict --verbose=2 "$file"
      signed=$((signed + 1))
      ;;
  esac
done < <(find "$DIR" -type f \( -name '*.dylib' -o -name '*.node' \) -print0)

if [ "$signed" -eq 0 ]; then
  echo "no Mach-O binaries found under $DIR" >&2
  exit 1
fi
echo "signed $signed binary(ies)"
