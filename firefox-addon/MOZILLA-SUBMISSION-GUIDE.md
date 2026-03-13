# Mozilla AMO Submission Guide
## Revolution Addon - Selbst-Distribution für produktiven Firefox

### 📦 Vorbereitete Dateien

Bereits erstellt und bereit:
- ✅ `build/revolution-addon.zip` (374K) - Das Addon
- ✅ `build/revolution-addon-source.zip` (397K) - Quellcode für Reviewer

---

## 🚀 Schritt-für-Schritt Anleitung

### 1. Mozilla-Account erstellen

1. Gehen Sie zu: https://addons.mozilla.org/developers/
2. Klicken Sie auf "Register" oder "Log in"
3. Erstellen Sie einen Firefox Account (falls noch nicht vorhanden)
4. Bestätigen Sie Ihre E-Mail-Adresse

### 2. Addon einreichen

1. Nach Login klicken Sie auf: **"Submit a New Add-on"**
2. Klicken Sie auf: **"Submit a New Version"**

### 3. Distribution wählen

**WICHTIG:** Wählen Sie **"On your own"** (Selbst-Distribution)

✅ **"On your own"** bedeutet:
- Addon wird signiert, aber NICHT im Mozilla Store veröffentlicht
- Schnellere Review-Zeit (oft < 24 Stunden)
- Sie erhalten ein signiertes .xpi-File zum Download
- Addon funktioniert in normalem Firefox dauerhaft

❌ NICHT wählen: "On this site" (würde öffentlich im Store erscheinen)

### 4. Addon-Datei hochladen

1. Klicken Sie auf **"Select a file..."**
2. Wählen Sie: `/Users/andreaslenkenhoff/Documents/revolution/firefox-addon/build/revolution-addon.zip`
3. Warten Sie auf die automatische Validierung (1-2 Minuten)

**Bei Validierungs-Fehlern:**
- Kopieren Sie die Fehlermeldung
- Fragen Sie mich nach einer Lösung

### 5. Build-Tools Frage

**Frage:** "Do you use any code generators, transpilers, minifiers, or other tools to generate the code?"

**Antwort:** ✅ **JA**

### 6. Quellcode hochladen

1. Klicken Sie auf **"Upload source code"**
2. Wählen Sie: `/Users/andreaslenkenhoff/Documents/revolution/firefox-addon/build/revolution-addon-source.zip`

### 7. Build-Prozess erklären

**Fügen Sie in das Textfeld ein:**

```
Dieses Addon verwendet libsodium-wrappers (Version 0.7.13) für
kryptografische Operationen. Die minifizierte Datei sodium.js wurde
heruntergeladen von:

https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/browsers/sodium.js

Quellcode: https://github.com/jedisct1/libsodium.js

Das Addon verwendet KEINE Build-Tools, Bundler oder Transpiler.
Alle anderen Dateien sind unminifiziert und direkt lesbar.

Build-Anleitung:
1. cd firefox-addon
2. ./build-addon.sh
3. Das Script erstellt lediglich ein ZIP-Archiv ohne Code-Transformationen

Der Quellcode enthält auch ein README-FOR-REVIEWERS.md mit
detaillierten Informationen.
```

### 8. Addon-Details ausfüllen

**Version Number:** `0.1.9` (bereits in manifest.json)

**Release Notes (optional):**
```
Erste signierte Version für Entwicklung und Testing.
Funktioniert mit localhost:3000.
```

**License:** MIT (oder Ihre bevorzugte Lizenz)

### 9. Einreichen

1. Überprüfen Sie alle Angaben
2. Klicken Sie auf **"Submit Version"**
3. ✅ Fertig!

---

## ⏳ Was passiert jetzt?

### Automatische Validierung (1-2 Minuten)
- Prüft JavaScript-Syntax
- Prüft manifest.json
- Scannt nach offensichtlichen Problemen

### Manuelle Review (ca. 2-24 Stunden bei Selbst-Distribution)
- Mozilla-Reviewer prüfen den Code
- Überprüfen Sicherheit und Richtlinien
- Prüfen Quellcode vs. minifizierte Dateien

### Genehmigung
Sie erhalten eine E-Mail mit:
- ✅ Bestätigung der Signierung
- 📥 Download-Link für das signierte .xpi-File

### Bei Ablehnung
Sie erhalten eine E-Mail mit:
- ❌ Gründen für die Ablehnung
- 📝 Was geändert werden muss
- → Kontaktieren Sie mich für Korrekturen

---

## 📥 Signiertes Addon installieren

Nach Genehmigung:

1. Laden Sie das signierte .xpi-File herunter
2. Öffnen Sie Firefox (normaler produktiver Firefox!)
3. Öffnen Sie die .xpi-Datei mit Firefox ODER
4. Ziehen Sie die .xpi-Datei in Firefox ODER
5. `about:addons` → Zahnrad → "Install Add-on From File..."
6. ✅ Addon ist installiert und bleibt nach Neustarts erhalten!

---

## 🔍 Status überprüfen

Während des Reviews können Sie den Status hier sehen:
https://addons.mozilla.org/developers/addons

Dort sehen Sie:
- ⏳ "Awaiting Review" = Warten auf Reviewer
- ✅ "Approved" = Signiert und bereit zum Download
- ❌ "Rejected" = Änderungen erforderlich

---

## ⚠️ Wichtige Hinweise

### Bei Updates
Wenn Sie das Addon ändern:
1. Erhöhen Sie die Version in manifest.json (z.B. 0.1.9 → 0.2.0)
2. Führen Sie `./build-addon.sh` und `./build-source.sh` aus
3. Reichen Sie die neue Version erneut ein
4. Jede Version braucht ein neues Review

### Localhost-Limitierung
- Addon funktioniert aktuell NUR mit localhost:3000
- Für andere Geräte müssen Sie später eine Domain hinzufügen
- Dann neue Version einreichen

---

## 🆘 Hilfe

**Bei Problemen während der Einreichung:**
- Kopieren Sie die Fehlermeldung
- Fragen Sie mich

**Support von Mozilla:**
- https://extensionworkshop.com/
- https://discourse.mozilla.org/c/add-ons/

---

## ✅ Checkliste

Vor Einreichung:
- [ ] Mozilla-Account erstellt
- [ ] `build/revolution-addon.zip` existiert
- [ ] `build/revolution-addon-source.zip` existiert
- [ ] "On your own" (Selbst-Distribution) wählen
- [ ] Build-Prozess-Beschreibung kopiert
- [ ] Alle Felder ausgefüllt

Nach Genehmigung:
- [ ] Signiertes .xpi heruntergeladen
- [ ] In produktivem Firefox installiert
- [ ] Getestet mit localhost:3000
- [ ] Funktioniert nach Neustart

---

**Viel Erfolg! 🚀**

Bei Fragen melden Sie sich jederzeit.
