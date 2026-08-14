#!/usr/bin/env bash
# Sync a built @ziffsplit/sdk into frontend/vendor for Docker/CI installs.
# Expects the sibling repo at ../../ziffsplit-sdk (or ZIFFSPLIT_SDK_PATH).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ZIFFSPLIT_SDK_PATH:-$ROOT/../../ziffsplit-sdk}"
DEST="$ROOT/vendor/ziffsplit-sdk"

if [[ ! -d "$SRC" ]]; then
  echo "ziffsplit-sdk not found at $SRC" >&2
  echo "Set ZIFFSPLIT_SDK_PATH or clone it next to backlog-roadmap-tool." >&2
  exit 1
fi

echo "Building SDK in $SRC…"
(cd "$SRC" && npm run build)

rm -rf "$DEST"
mkdir -p "$DEST/dist"
cp "$SRC/dist/"* "$DEST/dist/"

cat > "$DEST/package.json" <<'PKG'
{
  "name": "@ziffsplit/sdk",
  "version": "0.1.0",
  "description": "Vendored ZiffSplit client SDK (synced from ziffsplit-sdk)",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"]
}
PKG

echo "Vendored SDK → $DEST"
echo "Next: npm install  # refresh lockfile if package.json changed"
