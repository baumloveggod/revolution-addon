#!/bin/bash

# Permanente Addon-Installation mit web-ext
# Erstellt ein dediziertes Firefox-Profil mit dem Addon

set -e

cd "$(dirname "$0")"

echo "🔧 Revolution Addon - Permanente Installation"
echo ""

# Prüfe ob web-ext installiert ist
if ! command -v web-ext &> /dev/null; then
    echo "📦 web-ext nicht gefunden, installiere..."
    npm install --global web-ext
    echo "✅ web-ext installiert"
fi

PROFILE_DIR="$HOME/.firefox-revolution-profile"

echo "📁 Erstelle Firefox-Profil: $PROFILE_DIR"
echo ""

# Erstelle user.js für das Profil mit den richtigen Einstellungen
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/user.js" << 'EOF'
// Disable signature requirement
user_pref("xpinstall.signatures.required", false);

// Enable unsigned extensions
user_pref("extensions.experiments.enabled", true);

// Allow legacy extensions
user_pref("extensions.legacy.enabled", true);

// Disable automatic updates for this profile
user_pref("app.update.auto", false);
EOF

echo "✅ Profil konfiguriert"
echo ""
echo "🦊 Starte Firefox mit permanentem Addon..."
echo ""
echo "WICHTIG:"
echo "- Ein neues Firefox-Fenster öffnet sich"
echo "- Das Addon ist vorinstalliert"
echo "- Wenn Sie Firefox schließen, bleiben die Einstellungen erhalten"
echo "- Starten Sie Firefox in Zukunft mit diesem Script:"
echo "  ./install-permanent.sh"
echo ""
echo "Oder manuell mit:"
echo "  firefox --profile $PROFILE_DIR"
echo ""

# Starte Firefox mit dem Profil und lade das Addon
web-ext run \
  --firefox-profile "$PROFILE_DIR" \
  --keep-profile-changes \
  --start-url "http://localhost:3000"
