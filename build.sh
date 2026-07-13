#!/bin/bash
set -e

echo "🔨 Drenn — build script"
echo ""

# 1. Install deps if missing
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
else
  echo "📦 Refreshing deps..."
  npm install
fi

# 2. Ensure Electron binary is extracted (needed for native module rebuild)
if [ ! -d "node_modules/electron/dist/Electron.app" ] && [ ! -d "node_modules/electron/dist" ]; then
  echo "⚡ Extracting Electron binary..."
  node node_modules/electron/install.js
fi

# 3. Rebuild native modules (node-pty) against the installed Electron version
echo "🧰 Rebuilding native modules for Electron..."
npm run rebuild

# 4. Type-check (electron-vite build fails on TS errors anyway, but this surfaces them early)
echo "🔍 Type-checking main + preload + shared..."
npx tsc --noEmit -p tsconfig.node.json
echo "🔍 Type-checking renderer + shared..."
npx tsc --noEmit -p tsconfig.web.json

# 5. Parse args (e.g. ./build.sh --dir for unpacked, or --x64 / --arm64 for arch)
ARGS=""
if [ "${1:-}" = "--dir" ]; then
  echo "📁 Building unpacked directory only (no DMG/ZIP)..."
  ARGS="--dir"
elif [ -n "${1:-}" ]; then
  ARGS="$1"
fi

# 6. Build source
echo "🏗️  Building source (electron-vite)..."
npm run build

# 7. Package via electron-builder
if [ -n "$ARGS" ]; then
  echo "📦 Packaging (electron-builder --mac$ARGS)..."
  npx electron-builder --mac $ARGS
else
  echo "📦 Packaging DMG + ZIP for arm64 + x64..."
  npx electron-builder --mac
fi

echo ""
echo "✅ Done. Artifacts in ./dist"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || ls -lh dist
