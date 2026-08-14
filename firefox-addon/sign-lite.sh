#!/bin/bash

# Revolution Firefox Addon - Self-Distribution Signing
# Baut das Addon, signiert es über Mozillas AMO API (Kanal "unlisted",
# siehe MOZILLA-SUBMISSION-GUIDE.md "On your own") und aktualisiert
# releases/updates.json, damit bereits installierte Addons das neue
# Release automatisch über browser_specific_settings.gecko.update_url finden.
#
# Voraussetzung: .amo-credentials im selben Verzeichnis mit
#   AMO_JWT_ISSUER=<issuer>
#   AMO_JWT_SECRET=<secret>
# Erzeugen unter: https://addons.mozilla.org/developers/addon/api/key/

set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS_FILE="$ADDON_DIR/.amo-credentials"
BUILD_DIR="$ADDON_DIR/build"
RELEASES_DIR="$ADDON_DIR/releases"
UPDATES_JSON="$RELEASES_DIR/updates.json"
ADDON_ID="{e1388eed-e872-4a9c-bd5e-89687109ec77}"
UPDATE_BASE_URL="https://updates.lenkenhoff.de/revolution-addon"

if [ ! -f "$CREDS_FILE" ]; then
  echo "❌ $CREDS_FILE fehlt."
  echo ""
  echo "AMO-API-Credentials erzeugen unter:"
  echo "  https://addons.mozilla.org/developers/addon/api/key/"
  echo ""
  echo "Dann Datei anlegen mit:"
  echo "  AMO_JWT_ISSUER=dein-issuer"
  echo "  AMO_JWT_SECRET=dein-secret"
  exit 1
fi

# shellcheck disable=SC1090
source "$CREDS_FILE"

if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
  echo "❌ AMO_JWT_ISSUER oder AMO_JWT_SECRET nicht in $CREDS_FILE gesetzt."
  exit 1
fi

if ! command -v web-ext &> /dev/null; then
  echo "📦 Installiere web-ext..."
  npm install -g web-ext
fi

VERSION=$(node -pe "require('$ADDON_DIR/manifest.json').version")
echo "🔖 Version: $VERSION"

echo "🔨 Baue Addon (build-addon.sh)..."
"$ADDON_DIR/build-addon.sh"

SIGN_SRC="$BUILD_DIR/sign-src"
rm -rf "$SIGN_SRC"
mkdir -p "$SIGN_SRC"
unzip -q "$BUILD_DIR/revolution-addon.zip" -d "$SIGN_SRC"

echo "✍️  Signiere über AMO (channel=unlisted)..."
SIGNED_DIR="$BUILD_DIR/signed"
rm -rf "$SIGNED_DIR"
web-ext sign \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel=unlisted \
  --source-dir="$SIGN_SRC" \
  --artifacts-dir="$SIGNED_DIR"

XPI_FILE=$(find "$SIGNED_DIR" -maxdepth 1 -name "*.xpi" | head -n1)
if [ -z "$XPI_FILE" ]; then
  echo "❌ Kein signiertes .xpi gefunden – Signing vermutlich fehlgeschlagen."
  exit 1
fi

mkdir -p "$RELEASES_DIR"
RELEASE_XPI="$RELEASES_DIR/revolution-addon-$VERSION.xpi"
cp "$XPI_FILE" "$RELEASE_XPI"

HASH=$(shasum -a 256 "$RELEASE_XPI" | awk '{print $1}')
echo "🔐 SHA256: $HASH"

node -e "
const fs = require('fs');
const path = '$UPDATES_JSON';
const version = '$VERSION';
const entry = {
  version,
  update_link: '$UPDATE_BASE_URL/revolution-addon-' + version + '.xpi',
  update_hash: 'sha256:$HASH',
};
let manifest = { addons: { '$ADDON_ID': { updates: [] } } };
if (fs.existsSync(path)) {
  manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
}
const updates = manifest.addons['$ADDON_ID'].updates.filter(u => u.version !== version);
updates.push(entry);
updates.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
manifest.addons['$ADDON_ID'].updates = updates;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
"

echo ""
echo "✅ Signiert: $RELEASE_XPI"
echo "📝 updates.json aktualisiert: $UPDATES_JSON"
echo ""
echo "📤 Nächster Schritt (manuell, produktiv):"
echo "   scp \"$RELEASE_XPI\" \"$UPDATES_JSON\" andi@lenkenhoff.de:/pfad/zu/updates.lenkenhoff.de/revolution-addon/"
