#!/bin/sh
# Remove a BridgeDeck install created by install.sh.
#
# Usage: ./uninstall.sh [--dest DIR] [--keep-data]
# User data in ~/.browser-bridge (or BB_HOME) is preserved unless --keep-data is omitted
# and the user confirms interactively.
set -eu

DEST="${XDG_DATA_HOME:-$HOME/.local/share}/bridgedeck"
KEEP_DATA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST=$2; shift 2 ;;
    --dest=*) DEST=${1#--dest=}; shift ;;
    --keep-data) KEEP_DATA=1; shift ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$DEST" ]; then
  echo "not installed at $DEST" >&2
  exit 1
fi

rm -rf "$DEST"
LINK="$HOME/.local/bin/bridge"
if [ -L "$LINK" ]; then
  rm -f "$LINK"
fi
echo "Removed $DEST"

if [ "$KEEP_DATA" -eq 0 ]; then
  DATA="${BB_HOME:-$HOME/.browser-bridge}"
  if [ -d "$DATA" ]; then
    printf 'Also remove BridgeDeck data (%s)? [y/N] ' "$DATA"
    read -r answer || answer=''
    case "$answer" in
      y|Y|yes|YES) rm -rf "$DATA"; echo "Removed $DATA" ;;
      *) echo "Kept $DATA" ;;
    esac
  fi
fi
