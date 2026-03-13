/**
 * E48-Standardisierung für Privacy (upgraded von E24)
 *
 * Rundet Token-Beträge auf E48-Reihe (Elektronik-Standard)
 * Verhindert Fingerprinting durch krumme Beträge
 *
 * E48-Reihe: ~5% Abstand zwischen Werten (upgraded von E24 ~10%)
 * 48 Basis-Werte pro Dekade → hohe Privacy + bessere Präzision
 *
 * WICHTIG:
 * - Konservatives Abrunden (nie mehr zahlen als prognostiziert!)
 * - Rundungsfehler werden getrackt und später nachgezahlt
 * - Deterministisch
 * - Kompatibel mit 5%-Regel nach Tag 30
 */

class E24Rounding {  // Name bleibt für Backward Compatibility
  constructor(config) {
    this.config = config;
    // Prefer E48 if available, fallback to E24
    this.e24Series = config.e48 || config.e24;
    this.roundingErrors = new Map(); // domain -> accumulated error

    console.log('[E24Rounding] Initialized with series:', {
      seriesLength: this.e24Series?.length,
      isE48: this.e24Series?.length === 49,
      isE24: this.e24Series?.length === 25
    });
  }

  /**
   * Standardisiert Token-Menge auf E24-Reihe
   *
   * @param {BigInt} amount - Token-Menge (BigInt)
   * @param {string} domain - Domain (für Rundungsfehler-Tracking)
   * @returns {BigInt} Standardisierte Token-Menge
   */
  standardizeAmount(amount, domain = null) {
    if (amount === 0n) {
      return 0n;
    }

    // Konvertiere zu Number für Berechnung (sicher bis ~2^53)
    const amountNum = Number(amount);

    // Finde Dekade (10er-Potenz)
    const magnitude = Math.floor(Math.log10(amountNum));
    const decade = Math.pow(10, magnitude);

    // Normalisiere zu 1.0 - 10.0 Bereich
    const normalized = amountNum / decade;

    // Finde nächsten E24-Wert (ABRUNDEN!)
    const closestValue = this.findClosestE24Value(normalized, 'floor');

    // Re-skaliere
    const standardized = Math.floor(closestValue * decade);

    // Konvertiere zurück zu BigInt
    const standardizedBigInt = BigInt(standardized);

    // Tracking des Rundungsfehlers
    if (domain) {
      this.trackRoundingError(domain, amount, standardizedBigInt);
    }

    return standardizedBigInt;
  }

  /**
   * Findet nächsten E24-Wert
   *
   * @param {number} value - Normalisierter Wert (1.0 - 10.0)
   * @param {string} mode - 'floor' (abrunden) oder 'nearest' (nächster)
   * @returns {number} E24-Wert
   */
  findClosestE24Value(value, mode = 'floor') {
    if (value <= this.e24Series[0]) {
      return this.e24Series[0];
    }

    if (value >= this.e24Series[this.e24Series.length - 1]) {
      return this.e24Series[this.e24Series.length - 1];
    }

    if (mode === 'floor') {
      // Finde größten E24-Wert der <= value ist
      for (let i = this.e24Series.length - 1; i >= 0; i--) {
        if (this.e24Series[i] <= value) {
          return this.e24Series[i];
        }
      }
      return this.e24Series[0];
    } else {
      // Finde nächsten E24-Wert
      let closest = this.e24Series[0];
      let minDiff = Math.abs(value - closest);

      for (const e24Value of this.e24Series) {
        const diff = Math.abs(value - e24Value);
        if (diff < minDiff) {
          minDiff = diff;
          closest = e24Value;
        }
      }

      return closest;
    }
  }

  /**
   * Trackt Rundungsfehler pro Domain
   */
  trackRoundingError(domain, original, standardized) {
    const error = original - standardized;

    if (!this.roundingErrors.has(domain)) {
      this.roundingErrors.set(domain, 0n);
    }

    const currentError = this.roundingErrors.get(domain);
    this.roundingErrors.set(domain, currentError + error);
  }

  /**
   * Holt akkumulierten Rundungsfehler für Domain
   */
  getRoundingError(domain) {
    return this.roundingErrors.get(domain) || 0n;
  }

  /**
   * Prüft ob Rundungsfehler groß genug für Korrektur ist
   * Schwellwert: Mindest-Transaktions-Betrag
   */
  shouldCorrectRoundingError(domain, minTransactionAmount = 1000n) {
    const error = this.getRoundingError(domain);
    return error >= minTransactionAmount;
  }

  /**
   * Erstellt Rundungsfehler-Korrektur Transaktion
   */
  createCorrectionTransaction(domain) {
    const error = this.getRoundingError(domain);

    if (error === 0n) {
      return null;
    }

    // Standardisiere Korrektur-Betrag ebenfalls
    const correctionAmount = this.standardizeAmount(error, null);

    if (correctionAmount === 0n) {
      return null;
    }

    // Reduziere Fehler
    this.roundingErrors.set(domain, error - correctionAmount);

    return {
      domain: domain,
      tokens: correctionAmount,
      type: 'rounding_correction',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Setzt Rundungsfehler zurück (z.B. nach Monatsende)
   */
  resetRoundingErrors() {
    this.roundingErrors.clear();
  }

  /**
   * Exportiert Rundungsfehler (für Persistierung)
   */
  exportRoundingErrors() {
    const errors = {};
    for (const [domain, error] of this.roundingErrors.entries()) {
      errors[domain] = error.toString();
    }
    return errors;
  }

  /**
   * Importiert Rundungsfehler (von Storage)
   */
  importRoundingErrors(errors) {
    this.roundingErrors.clear();
    for (const [domain, errorStr] of Object.entries(errors)) {
      this.roundingErrors.set(domain, BigInt(errorStr));
    }
  }

  /**
   * Berechnet Privacy-Score (wie viele einzigartige Werte möglich)
   * Mehr einzigartige Werte = schlechter für Privacy
   */
  calculatePrivacyScore(tokenAmounts) {
    const uniqueValues = new Set();

    for (const amount of tokenAmounts) {
      const standardized = this.standardizeAmount(amount);
      uniqueValues.add(standardized.toString());
    }

    // Privacy-Score: 1.0 = perfect (nur 1 Wert), 0.0 = schlecht (viele Werte)
    const maxPossibleUnique = tokenAmounts.length;
    const actualUnique = uniqueValues.size;

    return 1.0 - (actualUnique / maxPossibleUnique);
  }

  /**
   * Beispiel-Reihe generieren für Debugging
   */
  static generateE24Series(startDecade = 1, endDecade = 10000) {
    const base = [
      1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0,
      2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3,
      4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1
    ];

    const series = [];
    let decade = startDecade;

    while (decade <= endDecade) {
      for (const value of base) {
        series.push(value * decade);
      }
      decade *= 10;
    }

    return series;
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.E24Rounding = E24Rounding;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = E24Rounding;
}
