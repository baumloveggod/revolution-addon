# Webseiten-Bewertungssystem - Tracking

## Übersicht

Das Tracking-System erfasst automatisch den Wert von Webseiten-Aufrufen basierend auf verschiedenen Metriken. Das System ist vollständig erweiterbar und kann mit zusätzlichen Bewertungsfaktoren angereichert werden.

## Aktuell erfasste Metriken

### 1. Aktive Zeit (Active Time)
- **Was wird gemessen:** Zeit, während der der Tab aktiv/fokussiert ist
- **Gewichtung:** 100% (Faktor 1.0)
- **Verwendung:** Zeigt echtes Nutzer-Engagement

### 2. Passive Zeit (Passive Time)
- **Was wird gemessen:** Zeit, während der Tab offen aber nicht fokussiert ist
- **Gewichtung:** 30% (Faktor 0.3)
- **Verwendung:** Zeigt Hintergrund-Interesse

## Wann werden Daten erhoben?

Das System erfasst Daten automatisch bei folgenden Ereignissen:

1. **Tab wird geschlossen**
   - Session wird beendet und Daten werden gespeichert

2. **Webseite wechselt (Navigation)**
   - Alte Session wird beendet
   - Neue Session wird gestartet

3. **Tab wird aktiviert/deaktiviert**
   - Timer für aktive/passive Zeit werden umgeschaltet

4. **Browser-Fenster verliert Fokus**
   - Aktive Zeit wird pausiert, passive Zeit läuft weiter

## Bewertungssystem

### Basis-Score Berechnung
```javascript
baseScore = (activeTime * 1.0) + (passiveTime * 0.3)
```

### Qualitätsfaktor
```javascript
activeRatio = activeTime / totalTime
qualityFactor = 0.5 + (activeRatio * 0.5)  // Range: 0.5 bis 1.0
```

### Finaler Score
```javascript
finalScore = baseScore * qualityFactor
```

**Beispiel:**
- Aktive Zeit: 300 Sekunden
- Passive Zeit: 100 Sekunden
- Gesamt Zeit: 400 Sekunden
- Basis-Score: 300 * 1.0 + 100 * 0.3 = 330
- Active Ratio: 300 / 400 = 0.75
- Qualitätsfaktor: 0.5 + (0.75 * 0.5) = 0.875
- **Finaler Score: 330 * 0.875 = 289**

## Architektur

### Komponenten

#### 1. `MetricCollector` (Basis-Klasse)
Abstrakte Basisklasse für alle Metriken.

```javascript
class MetricCollector {
  start()    // Startet die Erfassung
  pause()    // Pausiert die Erfassung
  stop()     // Stoppt und gibt Wert zurück
  getValue() // Aktueller Wert
  serialize() // Für Storage
}
```

#### 2. `TimeMetric`
Implementierung für Zeit-basierte Metriken.

```javascript
const activeTime = new TimeMetric('activeTime', 'active');
activeTime.start();
// ... Zeit vergeht ...
activeTime.pause();
const seconds = activeTime.getValueInSeconds();
```

#### 3. `CounterMetric`
Implementierung für Zähler-basierte Metriken (z.B. Klicks, Scrolls).

```javascript
const clicks = new CounterMetric('clickCount');
clicks.increment(1); // +1 Klick
clicks.increment(5); // +5 Klicks
```

#### 4. `PageVisitSession`
Verwaltet eine einzelne Besuchs-Session.

```javascript
const session = new PageVisitSession(url, tabId, windowId);
session.activate();   // Tab wird aktiv
session.deactivate(); // Tab wird inaktiv
const summary = session.end(); // Session beenden
```

#### 5. `PageVisitTracker`
Haupt-Tracker für alle Sessions.

```javascript
await tracker.initialize();
tracker.getActiveSessions();    // Aktuelle Sessions
tracker.getCompletedSessions(); // Abgeschlossene Sessions
```

## Erweiterbarkeit

### Neue Metrik hinzufügen

#### Beispiel 1: Scroll-Tiefe Tracking

```javascript
// In tracking.js eine neue Metrik-Klasse erstellen
class ScrollDepthMetric extends MetricCollector {
  constructor(name) {
    super(name);
    this.maxScrollDepth = 0;
  }

  updateScrollDepth(percentage) {
    if (percentage > this.maxScrollDepth) {
      this.maxScrollDepth = percentage;
      this.value = percentage;
    }
  }

  serialize() {
    return {
      ...super.serialize(),
      type: 'scroll_depth',
      maxDepth: this.maxScrollDepth
    };
  }
}
```

#### Beispiel 2: Interaktions-Tracking

```javascript
class InteractionMetric extends CounterMetric {
  constructor(name) {
    super(name);
    this.clickCount = 0;
    this.keypressCount = 0;
  }

  recordClick() {
    this.clickCount++;
    this.increment(1);
  }

  recordKeypress() {
    this.keypressCount++;
    this.increment(1);
  }

  serialize() {
    return {
      ...super.serialize(),
      type: 'interaction',
      clicks: this.clickCount,
      keypresses: this.keypressCount,
      total: this.value
    };
  }
}
```

#### Metrik zu Session hinzufügen

```javascript
// In PageVisitSession constructor
const session = new PageVisitSession(url, tabId, windowId);

// Füge custom metric hinzu
const scrollMetric = new ScrollDepthMetric('scrollDepth');
session.addMetric('scrollDepth', scrollMetric);

const interactionMetric = new InteractionMetric('interactions');
session.addMetric('interactions', interactionMetric);
```

### Content Script für erweiterte Metriken

Für Metriken die DOM-Zugriff benötigen (Scrolls, Klicks, etc.):

```javascript
// In contentScript.js hinzufügen
let scrollDepth = 0;

window.addEventListener('scroll', () => {
  const winHeight = window.innerHeight;
  const docHeight = document.documentElement.scrollHeight;
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

  const depth = Math.round((scrollTop + winHeight) / docHeight * 100);
  if (depth > scrollDepth) {
    scrollDepth = depth;
    // Sende an Background Script
    browser.runtime.sendMessage({
      type: 'UPDATE_SCROLL_DEPTH',
      depth: scrollDepth
    });
  }
});
```

```javascript
// In background.js Message Handler erweitern
if (message.type === 'UPDATE_SCROLL_DEPTH') {
  const session = tracker.activeSessions.get(sender.tab.id);
  if (session && session.customMetrics.scrollDepth) {
    session.customMetrics.scrollDepth.updateScrollDepth(message.depth);
  }
}
```

## Bewertungslogik anpassen

Die Bewertungsfunktion in `background.js` kann erweitert werden:

```javascript
function evaluateSession(sessionSummary) {
  const activeTime = sessionSummary.metrics.activeTime.valueSeconds;
  const passiveTime = sessionSummary.metrics.passiveTime.valueSeconds;

  // Basis-Gewichtungen (anpassbar!)
  const activeWeight = 1.0;
  const passiveWeight = 0.3;

  let baseScore = (activeTime * activeWeight) + (passiveTime * passiveWeight);

  // Erweiterte Faktoren hinzufügen
  if (sessionSummary.customMetrics.scrollDepth) {
    const scrollBonus = sessionSummary.customMetrics.scrollDepth.value * 0.1;
    baseScore += scrollBonus;
  }

  if (sessionSummary.customMetrics.interactions) {
    const interactionBonus = sessionSummary.customMetrics.interactions.value * 0.5;
    baseScore += interactionBonus;
  }

  // Qualitätsfaktor berechnen
  const activeRatio = totalTime > 0 ? activeTime / totalTime : 0;
  const qualityFactor = 0.5 + (activeRatio * 0.5);

  const finalScore = baseScore * qualityFactor;

  return {
    baseScore: Math.round(baseScore),
    qualityFactor: Math.round(qualityFactor * 100) / 100,
    finalScore: Math.round(finalScore),
    // ...
  };
}
```

## Zukünftige Erweiterungsmöglichkeiten

### 1. Viewport-Zeit
- Wie lange war die Seite tatsächlich im Viewport sichtbar?
- Erfordert: Page Visibility API

### 2. Engagement-Metriken
- Mouse-Bewegungen
- Klicks auf Elemente
- Formular-Eingaben
- Copy/Paste Events

### 3. Content-Konsum
- Scroll-Geschwindigkeit
- Verweildauer bei bestimmten Elementen
- Video-Wiedergabe-Zeit
- Bild-Ansichten

### 4. Qualitäts-Signale
- Bounce-Rate (schnelles Verlassen)
- Return-Rate (mehrfache Besuche)
- Session-Dauer Trends
- Tageszeit-Muster

### 5. Server-Integration
- Automatischer Upload abgeschlossener Sessions
- Aggregation über mehrere Geräte
- Echtzeit-Dashboards
- Reward-Berechnung

## API für Popup/UI

Das Tracking-System kann über Messages abgefragt werden:

```javascript
// Hole alle Sessions
const response = await browser.runtime.sendMessage({
  type: 'GET_TRACKING_SESSIONS'
});
console.log(response.activeSessions);
console.log(response.completedSessions);

// Lösche abgeschlossene Sessions (nach Upload)
await browser.runtime.sendMessage({
  type: 'CLEAR_COMPLETED_SESSIONS'
});
```

## Storage

### Gespeicherte Daten

**Key:** `rev_tracking_sessions`

**Format:**
```javascript
{
  "rev_tracking_sessions": [
    {
      "sessionId": "session_1234567890_abc123",
      "url": "https://example.com/page",
      "tabId": 1,
      "windowId": 1,
      "startTime": "2025-01-15T10:30:00.000Z",
      "endTime": "2025-01-15T10:35:00.000Z",
      "metrics": {
        "activeTime": {
          "name": "activeTime",
          "value": 180000,
          "type": "active",
          "valueSeconds": 180
        },
        "passiveTime": {
          "name": "passiveTime",
          "value": 120000,
          "type": "passive",
          "valueSeconds": 120
        }
      },
      "customMetrics": {},
      "totalTimeSeconds": 300
    }
  ]
}
```

## Testing

### Browser Console Tests

```javascript
// Im Background Script Console (about:debugging)

// 1. Tracker Status prüfen
tracker.getActiveSessions()
tracker.getCompletedSessions()

// 2. Manuelle Session erstellen
const testSession = tracker.startSession(999, 'https://test.com', 1);
testSession.activate();
setTimeout(() => testSession.deactivate(), 5000); // Nach 5 Sekunden

// 3. Session beenden und prüfen
await tracker.endSession(999);
tracker.getCompletedSessions()
```

## Logging

Das System loggt alle wichtigen Events:

```javascript
[tracking] Tracker initialisiert
[tracking] Neue Session gestartet: {...}
[tracking] Session aktiviert: tabId
[tracking] Tab URL geändert: {...}
[tracking] Session beendet: {...}
[revolution-addon] Verarbeite abgeschlossene Session: {...}
[revolution-addon] Session-Bewertung: {...}
```

## Performance

- Alle Timer laufen nur wenn nötig
- Daten werden alle 30 Sekunden automatisch gespeichert
- Sessions werden nur bei Bedarf aktualisiert
- Minimaler Memory-Footprint durch effizientes Event-Handling

## Privacy

- Alle Daten bleiben lokal im Browser
- Keine automatische Übertragung an Server
- URLs werden vollständig gespeichert (anpassbar für Privacy)
- Nutzer hat volle Kontrolle über gespeicherte Daten
