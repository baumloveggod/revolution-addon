#!/bin/bash

# Revolution Firefox Addon Builder
# Erstellt ein signierfähiges .zip-File für addons.mozilla.org

set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ADDON_DIR/build"
OUTPUT_FILE="$BUILD_DIR/revolution-addon.zip"

echo "🔨 Building Revolution Firefox Addon..."
echo "📁 Source: $ADDON_DIR"

# Erstelle Build-Verzeichnis
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Dateien und Verzeichnisse, die NICHT ins Addon sollen
EXCLUDE_PATTERNS=(
  "build/*"
  "build-addon.sh"
  "check-addon-storage.sh"
  "check-registration-status.html"
  "debug-messaging.js"
  "TESTING.md"
  "TRACKING.md"
  "TRACKING_EXAMPLES.md"
  "tests/*"
  ".DS_Store"
  "*.log"
  ".git*"
  "node_modules/*"
)

# Erstelle temporäres Verzeichnis für das Addon
TEMP_DIR="$BUILD_DIR/temp-addon"
mkdir -p "$TEMP_DIR"

echo "📦 Copying addon files..."

# Kopiere alle Dateien außer die ausgeschlossenen
rsync -av \
  --exclude='build/' \
  --exclude='build-addon.sh' \
  --exclude='check-addon-storage.sh' \
  --exclude='check-registration-status.html' \
  --exclude='debug-messaging.js' \
  --exclude='TESTING.md' \
  --exclude='TRACKING.md' \
  --exclude='TRACKING_EXAMPLES.md' \
  --exclude='tests/' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='.git*' \
  --exclude='node_modules/' \
  "$ADDON_DIR/" "$TEMP_DIR/"

# Erstelle ZIP-Datei
echo "🗜️  Creating ZIP file..."
cd "$TEMP_DIR"
zip -r "$OUTPUT_FILE" . -x "*.DS_Store" "*/.git/*" "*/node_modules/*"

# Aufräumen
cd "$ADDON_DIR"
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Build erfolgreich!"
echo "📄 Datei: $OUTPUT_FILE"
echo ""
echo "📤 Nächste Schritte:"
echo "1. Gehen Sie zu https://addons.mozilla.org/developers/"
echo "2. Melden Sie sich an oder erstellen Sie einen Account"
echo "3. Klicken Sie auf 'Submit a New Add-on'"
echo "4. Laden Sie die Datei hoch: $OUTPUT_FILE"
echo "5. Wählen Sie 'On your own' (Selbst-Distribution) für schnellere Signierung"
echo "6. Nach der Signierung laden Sie das signierte .xpi herunter"
echo ""

# Zeige Dateigröße
SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "📊 Dateigröße: $SIZE"
