# Revolution Scoring System

**Client-seitige Bewertungs- und Aufteilungslogik für dezentrales Micropayment-System**

Dieses System bewertet Webseiten basierend auf tatsächlicher Nutzungsqualität und verteilt ein monatliches Budget (10€) fair an Domains.

## 🎯 Kernprinzipien

1. **Deterministisch**: Gleiche Eingaben → Gleiche Ausgaben (Multi-Client Konsens)
2. **Privacy-First**: URLs niemals übertragen, nur Scores
3. **Fair**: Zeitpunkt-neutral, Monatsende garantiert exakte Verteilung
4. **Transparent**: Vollständiger Breakdown aller Berechnungen

## 📁 Architektur

```
firefox-addon/
├── scoring/
│   ├── scoring-config.js          # Versionierte Config (DETERMINISTISCH!)
│   ├── content-detector.js        # Content-Typ Erkennung
│   ├── quality-analyzer.js        # Technische Qualität (Tracker, Ads, etc.)
│   ├── interaction-scorer.js      # Interaktions-Bewertung
│   ├── scoring-engine.js          # Haupt-Bewertungslogik
│   └── revolution-scoring.js      # Integration aller Komponenten
├── distribution/
│   ├── prognosis-model.js         # Deterministisches Prognose-Modell
│   ├── calibration-manager.js     # Tag 1-30 Kalibration
│   └── distribution-engine.js     # Aufteilungslogik (2-Phasen)
├── privacy/
│   ├── e24-rounding.js            # E24-Standardisierung
│   ├── transaction-queue.js       # Batch-Queue mit Delays
│   └── privacy-layer.js           # Integration
└── ngo/
    ├── criteria-matcher.js        # Kriterien-Prüfung
    └── or-wallet-manager.js       # OR-Wallet Logik
```

## 🔢 Bewertungsfunktion

### Scoring-Formel

```javascript
sessionScore = baseScore
  × contentTypeMultiplier
  × (1 - trackerPenalty)
  × (1 + ossBonus)
  × interactionQuality
```

### Faktoren

#### 1. Content-Typ (multiplikativ)
- **Code Repository** (GitHub/GitLab): 1.4x
- **Tutorial/Documentation**: 1.15-1.2x
- **Article/Blog**: 1.0x
- **Video/Podcast**: 0.85-0.9x
- **Social Feed**: 0.5x (Doomscrolling-Schutz!)

#### 2. Interaktion (Basis-Score)
- **Aktive Zeit**: 1.0 Punkte/Sekunde
- **Passive Zeit**: 0.3 Punkte/Sekunde
- **Bonusse**:
  - Code kopiert: +50 Punkte
  - Download: +100 Punkte
  - Bookmark: +150 Punkte
  - Share: +200 Punkte
- **Wiederholte Besuche**: +10% pro Besuch (max 5x)

#### 3. Technische Qualität (multiplikativ)
- **Tracker**: -5% pro Tracker (max -50%)
- **Ads**: -2% pro Ad (max -30%)
- **Performance**: ±10% (< 1s Ladezeit = +10%, > 5s = -10%)
- **Accessibility**: +5% bei guter a11y

#### 4. Open-Source Bonus (multiplikativ, HÖCHSTE PRIORITÄT!)
- **GitHub/GitLab Repository**: +30%
- **NPM Package**: +25%
- **OSS Documentation**: +20%
- **Max Bonus**: +50% (kumulativ)

## 📊 Aufteilungs-System (2-Phasen)

### Phase 1: Kalibration (Tag 1-30)

**Prozess:**
1. Kontinuierliches Tracking ✅
2. **KEINE Transaktionen** ❌
3. Tag 30: Perfekte Normalisierung
4. Bulk-Auszahlung: Σ Budget = 10€

```javascript
// Am Tag 30
TotalScore = Σ(alle Session-Scores)
Budget = 10€ = 10^16 Tokens
für jede Domain d:
  TokenAmount[d] = (DomainScore[d] / TotalScore) × Budget
  SH → DS/OR: TokenAmount[d]
```

### Phase 2: Live-Transaktionen (ab Tag 31)

**On-the-fly Auszahlungen mit konservativer Prognose**

#### Prognose-Modell (DETERMINISTISCH!)

```javascript
1. Sliding Window: Letzte 90 Tage
2. Wöchentliche Aggregation
3. Gewichteter Durchschnitt (hart-codiert):
   - Woche 1 (latest): 50%
   - Woche 2: 30%
   - Woche 3: 15%
   - Woche 4: 5%
4. Linearer Trend (Regression)
5. Projektion auf Monatsende
```

#### Konservativitätsfaktor

```javascript
// Linear: Tag 0 → 0%, Tag 90 → 98%
factor = (0.98 / 90) * totalDaysTracked
```

**WICHTIG**: Keine Auszahlung ohne Prognose-Grundlage!

#### Monatsende-Korrektur (GARANTIERT 10€)

```javascript
// Perfekte Soll-Werte
perfectRatio = (10^16) / Σ(alle Scores)

für jede Domain d:
  shouldGet[d] = DomainScore[d] × perfectRatio
  deficit[d] = shouldGet[d] - alreadyPaid[d]

  if (deficit > 0):
    SH → DS/OR: deficit[d]
```

## 🔒 Privacy-Layer

### E24-Standardisierung

**Elektronik-Standard: ~5% Abstand zwischen Werten**

```javascript
E24_SERIES = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0,
  2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3,
  4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1, 10.0
]
```

**Vorteil**: Nur 24 Basis-Werte pro Dekade → keine Fingerprinting durch krumme Beträge!

**Konservatives Abrunden**: Niemals mehr zahlen als prognostiziert

**Rundungsfehler-Tracking**: Differenzen werden gespeichert und später nachgezahlt

### Transaction-Batching

**Hybrid-Modus**: 6 Stunden ODER 10 Transaktionen

```javascript
BATCH_WINDOW = 6 Stunden
MIN_BATCH_SIZE = 10 Transaktionen

// Ausführung:
1. Random Delay (0 - 6h)
2. Shuffle (Reihenfolge randomisieren)
3. Batch-Execute
```

### Privacy-Garantien

✅ **URLs niemals übertragen** - Nur Scores
✅ **E24-Standardisierung** - Verhindert Fingerprinting
✅ **Zeitliche Verschleierung** - Random Delays + Batching
✅ **Messaging-Service** - E2E-verschlüsselt (Port 4200)

## 🌍 NGO-Förderungssystem

### User-Präferenzen

```javascript
userPreferences = [
  { criterion: "Ökostrom", priority: 1, weight: 0.70 },
  { criterion: "Keine Werbung", priority: 2, weight: 0.50 }
]
```

### Geldfluss-Logik

**Alle Kriterien erfüllt** → DS-Wallet (Domain)
**Nicht erfüllt** → OR-Wallet (NGO), gewichtet

```javascript
// Beispiel: Ökostrom nicht erfüllt (70%), Keine Werbung erfüllt
totalWeight = 0.70
TokenAmount = 1000

OR-Payment:
  OR::oekostrom-example.com: 1000 Tokens
```

### OR-Wallet Lifecycle

1. **Einzahlung**: SH → OR
2. **Haltezeit**: 180 Tage (konfigurierbar)
3. **Fulfillment-Prüfung**: Domain erfüllt X% des Kriteriums
4. **Auszahlung**:
   - X% → DS (Domain)
   - Rest → CT (Charity Fallback)

**Beispiel**:
- Kriterium: "Ökostrom"
- Fulfillment: 50% (Domain nutzt 50% Ökostrom)
- Buffer: 1000 Tokens
- → 500 Tokens → DS, 500 Tokens → CT

## 🧪 Determinismus-Tests

**KRITISCH für Multi-Client Konsens!**

```bash
# In Browser-Console (about:debugging):
runDeterminismTests()
```

**Test-Kategorien**:
- E24 Rounding
- Prognosis Model
- Scoring Engine
- Distribution Engine
- NGO System
- Full Integration

**Alle Tests müssen PASS sein für Production!**

## 🚀 Integration

### Initialisierung

```javascript
// In background.js
const revolution = window.getRevolutionScoring();
await revolution.initialize();
```

### Session-Verarbeitung

```javascript
// Wenn Tracker Session beendet
tracker.onSessionCompleted = async (sessionSummary) => {
  const pageData = {
    url: sessionSummary.url,
    dom: await getPageDOM(tabId),
    meta: await getPageMeta(tabId),
    trackers: await detectTrackers(tabId),
    ads: await detectAds(tabId),
    performance: await getPerformance(tabId)
  };

  const result = await revolution.processSession(
    sessionSummary,
    pageData
  );

  console.log('Score:', result.scoring.score);
  console.log('Tokens:', result.distribution.tokens.toString());
};
```

### Status-Abfrage

```javascript
const status = await revolution.getStatus();
console.log('Calibration:', status.calibration);
console.log('Privacy:', status.privacy);
console.log('OR-Wallets:', status.orWallets);
```

## 📝 Token-Konstanten

```javascript
1 EUR = 10^15 Tokens
10 EUR/Monat = 10^16 Tokens
Minimale Transaktion = 1 Token = 10^-15 EUR
```

## 🔧 Konfiguration

**Config-Version**: `1.0.0` (in [scoring-config.js](scoring-config.js))

**WICHTIG**: Config-Änderungen erfordern neue Version + Migration!

**Snapshot-Zeiten** (UTC):
- 00:00 UTC (Mitternacht)
- 12:00 UTC (Mittag)

Alle Clients aktualisieren zu identischen Zeiten (Determinismus!)

## 📊 Wallet-Flow

```
IN → BA → CL ⟷ EX
      ↓
      SH → DS (Domain/Site)
      ↘→ OR (Organization/NGO) → CT (Charity Fallback)
```

**Deine Komponenten berechnen**: Welche Beträge von SH → DS/OR fließen

## 🎓 Beispiel-Session

```javascript
// Input
sessionData = {
  activeTime: 300s,    // 5 Minuten aktiv
  passiveTime: 100s,   // 1:40 passiv
  codeCopied: true     // Code kopiert!
}

pageData = {
  url: "https://github.com/user/repo",
  contentType: "CODE_REPOSITORY",
  trackers: 0,
  ossBonus: 0.3        // +30%
}

// Berechnung
baseScore = 300*1.0 + 100*0.3 + 50 = 380
× contentTypeMultiplier = 380 * 1.4 = 532
× qualityFactor = 532 * 1.0 = 532
× ossBonus = 532 * 1.3 = 691.6

finalScore = 692 Basis-Punkte
```

## 📚 Weiterführende Dokumentation

- [TRACKING.md](../TRACKING.md) - Tracking-System Details
- [central-ledger README](../../central-ledger/README.md) - Wallet-Flow Backend
- [messaging-service README](../../messaging-service/README.md) - E2E-Messaging

## ⚠️ Wichtige Hinweise

1. **Niemals Floats für Token-Berechnungen!** → Nutze BigInt
2. **Config immer versioniert!** → Breaking Changes = neue Version
3. **Tests vor Production!** → `runDeterminismTests()` muss PASS sein
4. **URLs bleiben lokal!** → Nur Scores werden synchronisiert
5. **Monatsende-Korrektur ist Pflicht!** → Garantiert exakte 10€

---

**© 2025 Andreas Lenkenhoff / Revolution Collective**
