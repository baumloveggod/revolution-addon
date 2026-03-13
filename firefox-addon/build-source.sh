#!/bin/bash

# Revolution Firefox Addon - Source Code Package Builder
# Erstellt ein Quellcode-Paket für die AMO-Einreichung

set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ADDON_DIR/build"
SOURCE_FILE="$BUILD_DIR/revolution-addon-source.zip"

echo "📦 Building Source Code Package for AMO..."
echo "📁 Source: $ADDON_DIR"

# Erstelle Build-Verzeichnis falls nicht vorhanden
mkdir -p "$BUILD_DIR"

# Erstelle temporäres Verzeichnis für den Quellcode
TEMP_DIR="$BUILD_DIR/temp-source"
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

echo "📋 Copying source files..."

# Kopiere den kompletten Addon-Ordner (außer build und node_modules)
rsync -av \
  --exclude='build/' \
  --exclude='node_modules/' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='.git*' \
  "$ADDON_DIR/" "$TEMP_DIR/firefox-addon/"

# Erstelle README für Reviewer
cat > "$TEMP_DIR/README-FOR-REVIEWERS.md" << 'EOF'
# Revolution Firefox Addon - Source Code

## Über dieses Paket

Dieses Paket enthält den vollständigen Quellcode des Revolution Firefox Addons.

## Minifizierte Dateien

Das Addon enthält die folgenden minifizierten/generierten Dateien:

1. **sodium.js** (619 KB)
   - Quelle: libsodium-wrappers JavaScript Bibliothek
   - Heruntergeladen von: https://github.com/jedisct1/libsodium.js
   - Version: 0.7.13
   - Zweck: Kryptografische Operationen für End-to-End-Verschlüsselung
   - Direkter Download-Link: https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/browsers/sodium.js

## Build-Prozess

Das Addon verwendet **KEINE** Build-Tools, Bundler oder Transpiler. Alle Dateien werden direkt so verwendet, wie sie im Quellcode vorliegen.

### So erstellen Sie das Addon:

1. Öffnen Sie ein Terminal im Quellcode-Ordner
2. Führen Sie aus: `cd firefox-addon && ./build-addon.sh`
3. Das resultierende ZIP-File befindet sich in `build/revolution-addon.zip`

Das Build-Script (`build-addon.sh`) führt lediglich folgende Schritte aus:
- Kopiert die relevanten Dateien (ohne Test-Dateien und Build-Artefakte)
- Erstellt ein ZIP-Archiv

**Keine Kompilierung, Minifizierung oder Transpilierung findet statt.**

## Datei-Struktur

```
firefox-addon/
├── manifest.json          # Addon-Manifest
├── background.js          # Haupt-Background-Script
├── popup.html/js/css      # Popup-UI
├── contentScript.js       # Content-Script für Website-Integration
├── sodium.js              # Libsodium (minifiziert, extern)
├── messaging-client/      # Messaging-System
├── crypto/                # Kryptografie-Module
├── wallet/                # Wallet-Management
├── scoring/               # Content-Bewertung
├── distribution/          # Verteilungs-Engine
├── privacy/               # Privacy-Layer
├── ngo/                   # NGO-Integration
└── services/              # Utility-Services

```

## Externe Abhängigkeiten

Die einzige externe Abhängigkeit ist:
- **libsodium-wrappers** (sodium.js): Kryptografie-Bibliothek

## Überprüfung

Um zu verifizieren, dass sodium.js die offizielle libsodium-Version ist:

```bash
# Download der offiziellen Version
curl -o sodium-official.js https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/browsers/sodium.js

# Vergleich (sollte identisch sein)
diff sodium.js sodium-official.js
```

## Kontakt

Bei Fragen zum Quellcode kontaktieren Sie bitte den Entwickler über addons.mozilla.org.
EOF

# Erstelle ZIP-Datei mit Quellcode
echo "🗜️  Creating source code ZIP..."
cd "$TEMP_DIR"
zip -r "$SOURCE_FILE" . -x "*.DS_Store"

# Aufräumen
cd "$ADDON_DIR"
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Source code package erstellt!"
echo "📄 Datei: $SOURCE_FILE"
echo ""
echo "📤 Bei der AMO-Einreichung:"
echo "1. Beantworten Sie 'Ja' bei der Frage nach Build-Tools"
echo "2. Laden Sie diese Source-Code-Datei hoch: $SOURCE_FILE"
echo "3. Erklären Sie in den Notizen:"
echo "   'Das Addon enthält sodium.js (libsodium-wrappers 0.7.13)"
echo "    von https://github.com/jedisct1/libsodium.js"
echo "    Keine weiteren Build-Tools werden verwendet.'"
echo ""

# Zeige Dateigröße
SIZE=$(du -h "$SOURCE_FILE" | cut -f1)
echo "📊 Source-Paket-Größe: $SIZE"
