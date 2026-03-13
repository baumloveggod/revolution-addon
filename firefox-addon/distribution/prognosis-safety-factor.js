/**
 * Prognosis Safety Factor
 *
 * Berechnet einen dynamischen Sicherheitsfaktor basierend auf dem historischen
 * Verlauf des Übersetzungs-Faktors. Verwendet EWMA (Exponential Weighted Moving Average)
 * mit Varianz-Analyse zur Risiko-Einschätzung.
 *
 * Ziel: Konservative Auszahlungen bei unsicheren/schwankenden Faktoren,
 *       höhere Auszahlungen bei stabilen Trends.
 */

class PrognosisSafetyFactor {
  constructor(config = {}) {
    // Algorithmus-Parameter (können kalibriert werden)
    this.EWMA_ALPHA = config.ewmaAlpha || 0.3; // Gewichtung neuerer Werte
    this.VARIANCE_THRESHOLD = config.varianceThreshold || 0.2; // 20% Schwankung
    this.TREND_THRESHOLD = config.trendThreshold || -0.1; // -10% Abfall
    this.SIGMA_BUFFER = config.sigmaBuffer || 1.5; // Konservativitäts-Puffer
    this.MIN_DATA_POINTS = config.minDataPoints || 7; // Minimum Datenpunkte
    this.MIN_SAFETY_FACTOR = config.minSafetyFactor || 0.7; // Minimum 70% Auszahlung
    this.MAX_SAFETY_FACTOR = config.maxSafetyFactor || 0.98; // Maximum 98% Auszahlung
  }

  /**
   * Berechnet Prognose-Sicherheits-Faktor basierend auf historischem Faktor-Verlauf
   *
   * Methode: EWMA + Varianz-Analyse + Trend-Erkennung
   *
   * @param {Array} factorHistory - [{timestamp, factor, totalScore}, ...]
   * @returns {number} Safety Factor (0.7 - 0.98)
   */
  calculatePrognosisSF(factorHistory) {
    // Validierung: Genug Datenpunkte?
    if (!factorHistory || factorHistory.length < this.MIN_DATA_POINTS) {
      console.warn('[PrognosisSF] Nicht genug Daten für Prognose:', {
        dataPoints: factorHistory?.length || 0,
        required: this.MIN_DATA_POINTS
      });
      return 0.5; // Sehr konservativ (50% Auszahlung)
    }

    // Extrahiere Faktoren aus Historie
    const factors = factorHistory.map(h => h.factor);

    // 1. EWMA-Berechnung (Exponential Weighted Moving Average)
    const ewma = this.calculateEWMA(factors);

    // 2. Statistik: Mean, Varianz, Standardabweichung
    const stats = this.calculateStatistics(factors);

    // 3. Trend-Analyse (steigend/fallend)
    const trend = this.calculateTrend(factors);

    // 4. Prognose mit konservativem Puffer
    const prognosis = ewma - (stats.stdDev * this.SIGMA_BUFFER);

    // 5. Sicherheits-Faktor basierend auf Unsicherheit
    let safetyFactor = 1.0;

    // Regel 1: Hohe Varianz → höherer Puffer
    const varianceRatio = stats.stdDev / stats.mean;
    if (varianceRatio > this.VARIANCE_THRESHOLD) {
      const variancePenalty = Math.min(0.2, varianceRatio - this.VARIANCE_THRESHOLD);
      safetyFactor *= (1.0 - variancePenalty);

      console.log('[PrognosisSF] High variance detected:', {
        varianceRatio: varianceRatio.toFixed(4),
        penalty: variancePenalty.toFixed(2),
        adjustedSF: safetyFactor.toFixed(2)
      });
    }

    // Regel 2: Fallender Trend → höherer Puffer
    if (trend < this.TREND_THRESHOLD) {
      const trendPenalty = Math.min(0.1, Math.abs(trend) - Math.abs(this.TREND_THRESHOLD));
      safetyFactor *= (1.0 - trendPenalty);

      console.log('[PrognosisSF] Falling trend detected:', {
        trend: (trend * 100).toFixed(1) + '%',
        penalty: trendPenalty.toFixed(2),
        adjustedSF: safetyFactor.toFixed(2)
      });
    }

    // Regel 3: Sehr geringe Datenmenge → konservativer
    if (factorHistory.length < this.MIN_DATA_POINTS * 2) {
      const dataPenalty = 0.05 * (1 - (factorHistory.length / (this.MIN_DATA_POINTS * 2)));
      safetyFactor *= (1.0 - dataPenalty);

      console.log('[PrognosisSF] Low data confidence:', {
        dataPoints: factorHistory.length,
        penalty: dataPenalty.toFixed(2),
        adjustedSF: safetyFactor.toFixed(2)
      });
    }

    // 6. Begrenzen auf MIN/MAX
    safetyFactor = Math.max(this.MIN_SAFETY_FACTOR, Math.min(this.MAX_SAFETY_FACTOR, safetyFactor));

    console.log('[PrognosisSF] Final calculation:', {
      ewma: ewma.toFixed(2),
      mean: stats.mean.toFixed(2),
      stdDev: stats.stdDev.toFixed(2),
      trend: (trend * 100).toFixed(1) + '%',
      prognosis: prognosis.toFixed(2),
      safetyFactor: safetyFactor.toFixed(4)
    });

    return safetyFactor;
  }

  /**
   * Berechnet Exponential Weighted Moving Average
   *
   * @param {Array<number>} values - Faktor-Werte
   * @returns {number} EWMA
   */
  calculateEWMA(values) {
    if (values.length === 0) return 0;

    let ewma = values[0];
    for (let i = 1; i < values.length; i++) {
      ewma = this.EWMA_ALPHA * values[i] + (1 - this.EWMA_ALPHA) * ewma;
    }

    return ewma;
  }

  /**
   * Berechnet statistische Kennzahlen
   *
   * @param {Array<number>} values - Faktor-Werte
   * @returns {Object} {mean, variance, stdDev, min, max}
   */
  calculateStatistics(values) {
    if (values.length === 0) {
      return { mean: 0, variance: 0, stdDev: 0, min: 0, max: 0 };
    }

    // Mean (Durchschnitt)
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

    // Varianz
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;

    // Standardabweichung
    const stdDev = Math.sqrt(variance);

    // Min/Max
    const min = Math.min(...values);
    const max = Math.max(...values);

    return { mean, variance, stdDev, min, max };
  }

  /**
   * Berechnet Trend-Richtung (steigend/fallend)
   *
   * Vergleicht durchschnittliche Werte der letzten 7 Tage vs. vorherige 7 Tage
   *
   * @param {Array<number>} values - Faktor-Werte
   * @returns {number} Trend (% Änderung, negativ = fallend)
   */
  calculateTrend(values) {
    if (values.length < 14) {
      // Zu wenig Daten für Trend-Analyse
      return 0;
    }

    // Letzte 7 Werte
    const recent7 = values.slice(-7);
    const recentMean = recent7.reduce((sum, v) => sum + v, 0) / 7;

    // Vorherige 7 Werte
    const prev7 = values.slice(-14, -7);
    const prevMean = prev7.reduce((sum, v) => sum + v, 0) / 7;

    // Prozentuale Änderung
    if (prevMean === 0) return 0;
    const trend = (recentMean - prevMean) / prevMean;

    return trend;
  }

  /**
   * Gibt detaillierte Prognose-Informationen zurück (für Debugging/UI)
   *
   * @param {Array} factorHistory - [{timestamp, factor, totalScore}, ...]
   * @returns {Object} Detaillierte Prognose
   */
  getPrognosisDetails(factorHistory) {
    if (!factorHistory || factorHistory.length < this.MIN_DATA_POINTS) {
      return {
        dataPoints: factorHistory?.length || 0,
        hasSufficientData: false,
        safetyFactor: 0.5,
        reason: 'Insufficient data'
      };
    }

    const factors = factorHistory.map(h => h.factor);
    const ewma = this.calculateEWMA(factors);
    const stats = this.calculateStatistics(factors);
    const trend = this.calculateTrend(factors);
    const safetyFactor = this.calculatePrognosisSF(factorHistory);

    return {
      dataPoints: factorHistory.length,
      hasSufficientData: true,
      safetyFactor: safetyFactor,
      ewma: ewma,
      statistics: {
        mean: stats.mean,
        stdDev: stats.stdDev,
        variance: stats.variance,
        min: stats.min,
        max: stats.max
      },
      trend: {
        value: trend,
        percentage: (trend * 100).toFixed(1) + '%',
        direction: trend > 0 ? 'rising' : trend < 0 ? 'falling' : 'stable'
      },
      prognosis: ewma - (stats.stdDev * this.SIGMA_BUFFER),
      confidence: this.calculateConfidence(factorHistory.length, stats.stdDev / stats.mean)
    };
  }

  /**
   * Berechnet Konfidenz-Score (0-100%)
   *
   * Basierend auf:
   * - Anzahl Datenpunkte
   * - Varianz (niedrige Varianz = höhere Konfidenz)
   *
   * @param {number} dataPoints - Anzahl Datenpunkte
   * @param {number} varianceRatio - Standardabweichung / Mean
   * @returns {number} Konfidenz (0-100)
   */
  calculateConfidence(dataPoints, varianceRatio) {
    // Datenpunkte-Score (0-50%)
    const dataScore = Math.min(50, (dataPoints / (this.MIN_DATA_POINTS * 2)) * 50);

    // Varianz-Score (0-50%)
    const varianceScore = Math.max(0, 50 * (1 - Math.min(1, varianceRatio / this.VARIANCE_THRESHOLD)));

    const confidence = dataScore + varianceScore;

    return Math.round(confidence);
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.PrognosisSafetyFactor = PrognosisSafetyFactor;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrognosisSafetyFactor;
}
