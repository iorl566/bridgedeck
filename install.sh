#!/bin/sh
# BridgeDeck installer for macOS / Linux.
#
# Usage:
#   ./install.sh [--dest DIR] [--force] [--add-to-path] [--node PATH]
#
# Defaults to ${XDG_DATA_HOME:-$HOME/.local/share}/bridgedeck.
# The CLI links into $HOME/.local/bin only when --add-to-path is given.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/bridgedeck"
ADD_TO_PATH=0
FORCE=0
NODE_PATH_ARG=''

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST=$2; shift 2 ;;
    --dest=*) DEST=${1#--dest=}; shift ;;
    --force) FORCE=1; shift ;;
    --add-to-path) ADD_TO_PATH=1; shift ;;
    --node) NODE_PATH_ARG=$2; shift 2 ;;
    --node=*) NODE_PATH_ARG=${1#--node=}; shift ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ROOT/cli/bridge.mjs" ]; then
  echo "install.sh must run from the BridgeDeck package root" >&2
  exit 1
fi

if [ -e "$DEST" ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "destination exists: $DEST (use --force to replace)" >&2
    exit 1
  fi
  rm -rf "$DEST"
fi

mkdir -p "$DEST"

for dir in bin cli daemon lib mcp skill extension sdk; do
  if [ -d "$ROOT/$dir" ]; then
    cp -R "$ROOT/$dir" "$DEST/$dir"
  fi
done

if [ -f "$ROOT/tools/install-update.mjs" ]; then
  mkdir -p "$DEST/tools"
  cp "$ROOT/tools/install-update.mjs" "$DEST/tools/install-update.mjs"
fi

for file in package.json README.md LICENSE uninstall.sh; do
  if [ -f "$ROOT/$file" ]; then
    cp "$ROOT/$file" "$DEST/$file"
  fi
done

# Resolve the runtime: explicit --node, bundled bin/node, then PATH.
NODE_BIN=''
if [ -n "$NODE_PATH_ARG" ]; then
  NODE_BIN=$NODE_PATH_ARG
elif [ -x "$DEST/bin/node" ]; then
  NODE_BIN="$DEST/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi
if [ -z "$NODE_BIN" ]; then
  echo "Node.js 20+ is required: https://nodejs.org/" >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'const m=Number(process.versions.node.split(".")[0]);process.exit(m>=20?0:1)'; then
  echo "Node.js 20+ is required (found $("$NODE_BIN" -v 2>/dev/null || echo unknown)): https://nodejs.org/" >&2
  exit 1
fi

# Keep the portable wrapper self-contained; regenerate it so it always points
# at the installed layout rather than a developer checkout.
cat > "$DEST/bin/bridge" <<'WRAPPER'
#!/bin/sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$DIR/node" ]; then
  NODE_BIN="$DIR/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=node
else
  echo "[bridge] Node.js 20+ is required: https://nodejs.org/" >&2
  exit 1
fi
exec "$NODE_BIN" "$DIR/../cli/bridge.mjs" "$@"
WRAPPER
chmod 755 "$DEST/bin/bridge"
if [ -n "$NODE_PATH_ARG" ] && [ -x "$NODE_PATH_ARG" ]; then
  cp "$NODE_PATH_ARG" "$DEST/bin/node"
  chmod 755 "$DEST/bin/node"
fi

echo "BridgeDeck installed: $DEST"
echo "Run: $DEST/bin/bridge status"

if [ "$ADD_TO_PATH" -eq 1 ]; then
  LINK_DIR="$HOME/.local/bin"
  mkdir -p "$LINK_DIR"
  ln -sf "$DEST/bin/bridge" "$LINK_DIR/bridge"
  echo "Linked: $LINK_DIR/bridge"
  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *) echo "Add $LINK_DIR to PATH (for example in ~/.zshrc or ~/.bashrc): export PATH=\"$LINK_DIR:\$PATH\"" ;;
  esac
else
  echo "Not linked to PATH; rerun with --add-to-path to create $HOME/.local/bin/bridge."
fi
