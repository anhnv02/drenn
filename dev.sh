#!/bin/bash
set -e

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Ensure Electron binary is extracted
if [ ! -d "node_modules/electron/dist/Electron.app" ]; then
  echo "⚡ Extracting Electron binary..."
  node node_modules/electron/install.js
fi

echo "🚀 Starting dev server..."
npm run dev
