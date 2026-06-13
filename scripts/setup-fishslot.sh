#!/usr/bin/env bash
# Clone the fishslot PWA and patch it with the Fluxer currency bridge.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/public/fishslot"

if [ -d "$DEST/.git" ]; then
  echo "[setup-fishslot] Pulling latest fishslot..."
  git -C "$DEST" pull --ff-only
else
  echo "[setup-fishslot] Cloning fishslot..."
  rm -rf "$DEST"
  git clone --depth 1 https://github.com/vermingov/fishslot.git "$DEST"
fi

echo "[setup-fishslot] Applying Fluxer currency patch..."
node "$SCRIPT_DIR/patch-fishslot.js" "$DEST"

echo "[setup-fishslot] Done."
