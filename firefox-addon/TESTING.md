# Addon Testing Anleitung

## Änderungen im Detail

### 1. Content Script (contentScript.js)
- **Schnellere Token-Synchronisation**: Intervall von 2000ms auf 500ms reduziert
- **Sofortige Initialisierung**: Zusätzliche Synchronisation nach 500ms beim Laden
- **Storage-Events**: Erkennt localStorage-Änderungen über Tabs hinweg
- **SPA-Navigation**: MutationObserver für Seitenwechsel in Single-Page-Apps

### 2. Popup (popup.js)
- **Live-Updates**: Status wird alle 500ms aktualisiert
- **Sofortige Reaktion**: Zeigt "angemeldet" innerhalb von Sekunden nach Login

### 3. Background Script (background.js)
- **Automatische Synchronisation**: Token-Abfrage alle 5 Sekunden
- **Browser-Events**: Trigger bei Browser-Fokus, Tab-Aktivierung und Navigation
- **Schnellere Initialisierung**: Reduzierte Wartezeiten

## Test-Schritte

### Test 1: Automatische Anmeldung nach Web-Login
1. Öffnen Sie Firefox
2. Navigieren Sie zu http://localhost:3000/login.html
3. Melden Sie sich an
4. Öffnen Sie das Addon-Popup (sollte innerhalb von 1-2 Sekunden "angemeldet" zeigen)

### Test 2: Bestehende Session beim Start
1. Melden Sie sich auf der Website an
2. Schließen Sie das Addon-Popup
3. Schließen Sie Firefox komplett
4. Starten Sie Firefox neu
5. Öffnen Sie das Addon-Popup (sollte "angemeldet" zeigen)

### Test 3: Tab-Wechsel
1. Melden Sie sich in einem Tab an
2. Wechseln Sie zu einem anderen Tab
3. Öffnen Sie das Addon-Popup (sollte Status erkennen)

### Test 4: Logout-Erkennung
1. Melden Sie sich an (Addon zeigt "angemeldet")
2. Loggen Sie sich aus
3. Öffnen Sie das Addon-Popup (sollte "Nicht verbunden" zeigen)

## Erwartete Verhaltensweisen

### Wenn angemeldet:
- Status: "Web angemeldet" → "Verknüpfe Add-on…" → "Add-on mit localhost:3000 verknüpft"
- Zeitrahmen: 1-3 Sekunden nach Login
- Client-Status: "Client-Session aktiv."

### Wenn nicht angemeldet:
- Status: "Nicht verbunden"
- Meta: "Melde dich auf der Webseite an, um das Add-on zu koppeln."

## Performance-Hinweise

Die häufigen Updates (500ms Intervalle) sind optimiert:
- Nur bei aktiven Tabs auf relevanten Origins
- Kein Update wenn Token unverändert
- Effiziente Cache-Strategie im Background Script

## Debugging

Bei Problemen öffnen Sie die Browser Console:
1. about:debugging#/runtime/this-firefox
2. "Inspect" beim Revolution Addon
3. Überprüfen Sie die Logs: `[revolution-addon]`

## Rollback

Falls Probleme auftreten, können Sie zu den alten Intervallen zurückkehren:
- contentScript.js: 2000ms statt 500ms
- popup.js: Kein Intervall (nur bei Storage-Änderung)
- background.js: Keine Event-Listener
