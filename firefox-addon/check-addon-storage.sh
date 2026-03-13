#!/bin/bash
# Check Firefox Addon Storage for Messaging Keys

echo "=== FIREFOX ADDON STORAGE CHECK ==="
echo ""

# Find the Firefox profile directory for "Profil 2"
PROFILE_DIR="/Users/andreaslenkenhoff/Library/Application Support/Firefox/Profiles/viraSM7F.Profil 2"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "❌ Firefox profile directory not found: $PROFILE_DIR"
  exit 1
fi

echo "✅ Firefox profile found: $PROFILE_DIR"
echo ""

# Check if there's an extension storage file
STORAGE_DIR="$PROFILE_DIR/storage/default"
echo "Looking for extension storage in: $STORAGE_DIR"
ls -la "$STORAGE_DIR" 2>/dev/null | grep "moz-extension" | head -5

echo ""
echo "Looking for Revolution addon storage..."

# The addon ID from manifest.json is: revolution-addon@example.com
# Firefox converts this to a UUID in the storage
# We need to find the right extension storage

# List all extension storage directories
echo "All extension storage directories:"
ls -d "$STORAGE_DIR"/moz-extension*/ 2>/dev/null

echo ""
echo "=== CHECKING SERVER DATABASE ==="
echo ""

# Check the messaging service database
DB="/Users/andreaslenkenhoff/Documents/revolution/messaging-service/dev/messaging.sqlite"

if [ ! -f "$DB" ]; then
  echo "❌ Database not found: $DB"
  exit 1
fi

echo "✅ Database found: $DB"
echo ""

# Count clients per group
echo "Clients registered in database:"
sqlite3 "$DB" "SELECT
  groupId,
  COUNT(*) as total_clients,
  GROUP_CONCAT(substr(fingerprint, 1, 16)) as fingerprints
FROM ClientKeys
GROUP BY groupId;"

echo ""
echo "Full client details:"
sqlite3 "$DB" "SELECT
  substr(fingerprint, 1, 32) as fingerprint_short,
  groupId,
  substr(publicKey, 1, 20) as pubKey,
  datetime(lastSynced, 'unixepoch') as last_sync
FROM ClientKeys
ORDER BY lastSynced DESC;"

echo ""
echo "=== CHECK COMPLETE ==="
