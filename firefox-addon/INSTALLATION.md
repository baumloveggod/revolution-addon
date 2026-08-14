# Revolution Addon - Installations-Anleitung

## Problem: Addon verschwindet nach Browser-Neustart

In normalem Firefox werden unsignierte Addons beim Neustart entfernt.

## Lösungen

### ✅ Lösung 1: Firefox Developer Edition (Empfohlen)

**Vorteile:** Addon bleibt dauerhaft, einfache Installation

**Schritte:**
1. Download: https://www.mozilla.org/firefox/developer/
2. Installieren und starten
3. Öffnen: `about:config`
4. Suchen: `xpinstall.signatures.required`
5. Auf `false` setzen
6. Öffnen: `about:debugging#/runtime/this-firefox`
7. Klicken: "Temporäres Add-on laden..."
8. Auswählen: `/Users/andreaslenkenhoff/Documents/revolution/firefox-addon/manifest.json`
9. ✅ Addon bleibt nach Neustart erhalten!

---

### ✅ Lösung 2: web-ext Development Server

**Vorteile:** Automatisches Neuladen bei Code-Änderungen

**Schritte:**
```bash
cd firefox-addon
./start-addon-dev.sh
```

Das Script:
- Installiert web-ext automatisch
- Erstellt ein persistentes Firefox-Profil
- Lädt das Addon automatisch
- Öffnet localhost:3000

---

### ✅ Lösung 3: Firefox Nightly

Alternative zu Developer Edition:
1. Download: https://www.mozilla.org/firefox/nightly/
2. Gleiche Schritte wie Developer Edition

---

### ✅ Lösung 4: Alpha-Test (signiert, Self-Distribution)

**Vorteile:** Kein `about:config`-Hack nötig, läuft in normalem Firefox, aktualisiert sich künftig automatisch.

**Schritte für Alpha-Tester:**
1. Signiertes `.xpi` herunterladen (Link kommt vom Entwickler, z. B. `https://updates.lenkenhoff.de/revolution-addon/revolution-addon-<version>.xpi`)
2. Firefox öffnen, `.xpi`-Datei per Drag & Drop ins Fenster ziehen
   ODER `about:addons` → Zahnrad-Icon → "Install Add-on From File..." → Datei auswählen
3. Installation bestätigen
4. ✅ Addon bleibt nach Neustarts erhalten und prüft künftig automatisch auf neue Versionen über `update_url` (manuell auslösbar: `about:addons` → Zahnrad → "Nach Updates suchen")

Signing-Workflow für den Entwickler: siehe `sign-lite.sh` und Abschnitt "Release-Workflow" unten.

---

## Empfehlung

**Für Entwicklung:** Firefox Developer Edition
**Für schnelles Testen:** `./start-addon-dev.sh`
**Für Alpha-Tester:** signiertes `.xpi` (Lösung 4)

---

## Release-Workflow (für neue Alpha-Versionen)

1. Version in `manifest.json` erhöhen (z. B. `1.2.0` → `1.2.1`)
2. `./sign-lite.sh` ausführen (baut, signiert über AMO, aktualisiert `releases/updates.json`)
   - Voraussetzung: `.amo-credentials` mit `AMO_JWT_ISSUER`/`AMO_JWT_SECRET` aus https://addons.mozilla.org/developers/addon/api/key/
3. Erzeugtes `releases/revolution-addon-<version>.xpi` + `releases/updates.json` auf den Server hochladen (Pfad, der unter `https://updates.lenkenhoff.de/revolution-addon/` ausgeliefert wird)
4. Fertig — bereits installierte Alpha-Addons ziehen das Update automatisch über `update_url`

---

## Aktueller Status

- ✅ Addon funktioniert auf localhost:3000
- ❌ Noch keine produktive Domain konfiguriert
- ⏳ Signing vorbereitet (`sign-lite.sh`), erster signierter Build steht noch aus (fehlende AMO-API-Credentials)

Für Nutzung auf mehreren Geräten muss eine produktive Domain in der manifest.json konfiguriert werden.
