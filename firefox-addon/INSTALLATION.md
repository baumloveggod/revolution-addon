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

### ❌ Lösung 4: Signierung (Nicht empfohlen für Development)

Nur für Produktion, weil:
- Mozilla-Review dauert 1-7 Tage
- Jede Änderung = neues Review
- Nur sinnvoll bei fertigen Versionen

---

## Empfehlung

**Für Entwicklung:** Firefox Developer Edition
**Für schnelles Testen:** `./start-addon-dev.sh`
**Für Produktion:** Mozilla-Signierung

---

## Aktueller Status

- ✅ Addon funktioniert auf localhost:3000
- ❌ Noch keine produktive Domain konfiguriert
- ❌ Noch nicht signiert

Für Nutzung auf mehreren Geräten muss eine produktive Domain in der manifest.json konfiguriert werden.
