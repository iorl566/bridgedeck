#!/usr/bin/env bash
# Submit a signed macOS package/zip to Apple notarization and staple the ticket.
#
# Usage:
#   tools/notarize-macos.sh --file dist/x.pkg \
#     --apple-id you@example.com --team-id TEAMID --password app-specific-password
# or:
#   tools/notarize-macos.sh --file dist/x.pkg --keychain-profile notary-profile
set -euo pipefail

FILE=''
APPLE_ID=''
TEAM_ID=''
PASSWORD=''
KEYCHAIN_PROFILE=''
TIMEOUT='30m'

while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE=$2; shift 2 ;;
    --apple-id) APPLE_ID=$2; shift 2 ;;
    --team-id) TEAM_ID=$2; shift 2 ;;
    --password) PASSWORD=$2; shift 2 ;;
    --keychain-profile) KEYCHAIN_PROFILE=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$FILE" ] || { echo "--file is required" >&2; exit 2; }
[ -f "$FILE" ] || { echo "not a file: $FILE" >&2; exit 1; }
[ "$(uname -s)" = 'Darwin' ] || { echo 'notarize-macos.sh only runs on macOS' >&2; exit 1; }
command -v xcrun >/dev/null 2>&1 || { echo 'xcrun not found' >&2; exit 1; }

args=(notarytool submit "$FILE" --wait --timeout "$TIMEOUT")
if [ -n "$KEYCHAIN_PROFILE" ]; then
  args+=(--keychain-profile "$KEYCHAIN_PROFILE")
else
  [ -n "$APPLE_ID" ] || { echo "--apple-id (or --keychain-profile) is required" >&2; exit 2; }
  [ -n "$TEAM_ID" ] || { echo "--team-id is required" >&2; exit 2; }
  [ -n "$PASSWORD" ] || { echo "--password is required" >&2; exit 2; }
  args+=(--apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$PASSWORD")
fi

xcrun "${args[@]}"
xcrun stapler staple "$FILE"
xcrun stapler validate "$FILE"
echo "notarized and stapled: $FILE"
