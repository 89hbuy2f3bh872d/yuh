#!/usr/bin/env bash
# scripts/setup-fishslot.sh
# Clones or updates the fishslot game files into public/fishslot/
# Run once before starting the bot, or let the bot run it automatically.

set -e

DEST="$(cd "$(dirname "$0")/.." && pwd)/public/fishslot"
REPO="https://github.com/vermingov/fishslot.git"

if [ -d "$DEST/.git" ]; then
  echo "[setup-fishslot] Updating existing clone at $DEST"
  git -C "$DEST" pull --ff-only
else
  echo "[setup-fishslot] Cloning fishslot into $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth=1 "$REPO" "$DEST"
fi

echo "[setup-fishslot] Done."
