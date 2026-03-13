#!/bin/bash

# Revolution Firefox Addon - Development Launcher
# Startet Firefox mit dem Addon und persistentem Profil

cd "$(dirname "$0")"

echo "🦊 Starte Firefox mit Revolution Addon..."
echo ""

# Installiere web-ext falls nicht vorhanden
if ! command -v web-ext &> /dev/null; then
    echo "📦 Installiere web-ext..."
    npm install -g web-ext
fi

# Starte Firefox mit Addon
web-ext run \
  --keep-profile-changes \
  --profile-create-if-missing \
  --start-url "http://localhost:3000"

echo ""
echo "✅ Firefox geschlossen"
