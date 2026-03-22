/**
 * Fluctuation Safety Factor
 *
 * Zusätzlicher Sicherheits-Faktor basierend auf Übersetzungs-Faktor-Schwankungen.
 *
 * WICHTIG:
 * - Wird erst nach 10 Tagen aktiviert
 * - Nimmt den UNTEREN Rand der Schwankungen an (pessimistisch)
 * - Kombiniert mit bestehenden SFs (Start-SF × Prognose-SF × Fluctuation-SF)
 *
 * Logik:
 * 1. Berechne Min/Max des Translation Factors über letzte 30 Tage
 * 2. Berechne Schwankungsbreite: (Max - Min) / Mean
 * 3. SF = 1.0 - (Schwankungsbreite × Konservativitäts-Faktor)
 * 4. Mindestens 0.5 (50%), Maximum 1.0 (100%)
 */

class FluctuationSafetyFactor {
  constructor(config = {}) {
    // Konfiguration
    this.ACTIVATION_DAY = config.activationDay || 10;  // Erst ab Tag 10
    this.CONSERVATIVITY_FACTOR = config.conservativityFactor || 0.5;  // 50% der Schwankungsbreite
    this.MIN_SAFETY_FACTOR = config.minSafetyFactor || 0.5;  // Minimum 50%
    this.MAX_SAFETY_FACTOR = config.maxSafetyFactor || 1.0;  // Maximum 100%
    this.MIN_DATA_POINTS = config.minDataPoints || 5;  // Minimum Datenpunkte
  }

  /**
   * Berechnet Fluctuation-SF basierend auf Translation Factor Historie
   *
   * @param {Array} factorHistory - [{timestamp, factor, totalScore}, ...]
   * @param {number} daysSinceStart - Tage seit BA→CL Transfer
   * @returns {number} Safety Factor (0.5 - 1.0)
   */
  calculateFluctuationSF(factorHistory, daysSinceStart) {
    // Regel 1: Erst ab Tag 10 aktiv
    if (daysSinceStart < this.ACTIVATION_DAY) {
      return 1.0;  // Kein Einfluss vor Tag 10
    }

    // Regel 2: Genug Datenpunkte?
    if (!factorHistory || factorHistory.length < this.MIN_DATA_POINTS) {
      console.warn('[FluctuationSF] Insufficient data:', {
        dataPoints: factorHistory?.length || 0,
        required: this.MIN_DATA_POINTS
      });
      return this.MIN_SAFETY_FACTOR;  // Sehr konservativ
    }

    // Extrahiere numerische Faktoren
    const factors = factorHistory.map(h => {
      // Convert BigInt to Number (safe für Translation Factors)
      const factor = typeof h.factor === 'bigint' ? Number(h.factor) : parseFloat(h.factor);
      return factor;
    }).filter(f => !isNaN(f) && f > 0);

    if (factors.length < this.MIN_DATA_POINTS) {
      console.warn('[FluctuationSF] Not enough valid factors:', factors.length);
      return this.MIN_SAFETY_FACTOR;
    }

    // Berechne Min, Max, Mean
    const min = Math.min(...factors);
    const max = Math.max(...factors);
    const sum = factors.reduce((acc, f) => acc + f, 0);
    const mean = sum / factors.length;

    // Schwankungsbreite (relativ zum Mittelwert)
    const range = max - min;
    const fluctuationRatio = mean > 0 ? range / mean : 0;

    // Berechne Safety Factor
    // Je höher die Schwankung, desto niedriger der SF
    const penalty = fluctuationRatio * this.CONSERVATIVITY_FACTOR;
    let safetyFactor = 1.0 - penalty;

    // Begrenzen auf MIN/MAX
    safetyFactor = Math.max(this.MIN_SAFETY_FACTOR, Math.min(this.MAX_SAFETY_FACTOR, safetyFactor));

    return safetyFactor;
  }

  /**
   * Pessimistische Prognose: Verwendet den UNTEREN Rand
   *
   * Diese Methode gibt die pessimistische Prognose zurück
   * (niedrigster Wert der letzten Periode)
   *
   * @param {Array} factorHistory - Faktor-Historie
   * @param {number} lookbackDays - Tage zurückschauen (default: 7)
   * @returns {number} Pessimistischer Translation Factor
   */
  getPessimisticFactor(factorHistory, lookbackDays = 7) {
    if (!factorHistory || factorHistory.length === 0) {
      return 0;
    }

    // Filter auf letzte N Tage
    const cutoffTime = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
    const recentHistory = factorHistory.filter(h => h.timestamp >= cutoffTime);

    if (recentHistory.length === 0) {
      // Falls keine aktuellen Daten, nimm älteste Daten
      const factors = factorHistory.map(h =>
        typeof h.factor === 'bigint' ? Number(h.factor) : parseFloat(h.factor)
      ).filter(f => !isNaN(f) && f > 0);

      return Math.min(...factors);
    }

    // Nimm den NIEDRIGSTEN Wert (pessimistisch)
    const factors = recentHistory.map(h =>
      typeof h.factor === 'bigint' ? Number(h.factor) : parseFloat(h.factor)
    ).filter(f => !isNaN(f) && f > 0);

    const pessimisticFactor = Math.min(...factors);

    return pessimisticFactor;
  }

  /**
   * Detaillierte Analyse (für Debugging)
   */
  getFluctuationDetails(factorHistory, daysSinceStart) {
    if (daysSinceStart < this.ACTIVATION_DAY) {
      return {
        active: false,
        reason: `Not active before day ${this.ACTIVATION_DAY}`,
        daysSinceStart,
        safetyFactor: 1.0
      };
    }

    if (!factorHistory || factorHistory.length < this.MIN_DATA_POINTS) {
      return {
        active: false,
        reason: 'Insufficient data',
        dataPoints: factorHistory?.length || 0,
        required: this.MIN_DATA_POINTS,
        safetyFactor: this.MIN_SAFETY_FACTOR
      };
    }

    const factors = factorHistory.map(h =>
      typeof h.factor === 'bigint' ? Number(h.factor) : parseFloat(h.factor)
    ).filter(f => !isNaN(f) && f > 0);

    const min = Math.min(...factors);
    const max = Math.max(...factors);
    const sum = factors.reduce((acc, f) => acc + f, 0);
    const mean = sum / factors.length;
    const range = max - min;
    const fluctuationRatio = mean > 0 ? range / mean : 0;
    const penalty = fluctuationRatio * this.CONSERVATIVITY_FACTOR;
    const safetyFactor = Math.max(
      this.MIN_SAFETY_FACTOR,
      Math.min(this.MAX_SAFETY_FACTOR, 1.0 - penalty)
    );

    return {
      active: true,
      daysSinceStart,
      dataPoints: factors.length,
      statistics: {
        min,
        max,
        mean,
        range,
        fluctuationRatio: (fluctuationRatio * 100).toFixed(2) + '%'
      },
      calculation: {
        penalty: (penalty * 100).toFixed(2) + '%',
        rawSF: (1.0 - penalty).toFixed(4),
        clampedSF: safetyFactor.toFixed(4)
      },
      safetyFactor
    };
  }
}

// Export für background.js
if (typeof window !== 'undefined') {
  window.FluctuationSafetyFactor = FluctuationSafetyFactor;
}
