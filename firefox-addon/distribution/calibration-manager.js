/**
 * Calibration Manager
 *
 * Verwaltet die 30-Tage Kalibrations-Phase
 *
 * Phase 1 (Tag 1-30):
 * - Kontinuierliches Tracking
 * - KEINE Transaktionen
 * - Tag 30: Perfekte Normalisierung + Bulk-Auszahlung
 *
 * Output: Baseline-Ratio für Phase 2
 */

class CalibrationManager {
  constructor(config, prognosisModel) {
    this.config = config;
    this.prognosisModel = prognosisModel;
  }

  /**
   * Prüft ob User in Kalibrations-Phase ist
   *
   * @param {Date} firstTrackingDate - Datum des ersten Trackings
   * @param {Date} currentDate - Aktuelles Datum
   * @returns {Object} Kalibrations-Status
   */
  getCalibrationStatus(firstTrackingDate, currentDate = new Date()) {
    const daysSinceStart = this.calculateDaysSince(firstTrackingDate, currentDate);

    const isInCalibration = daysSinceStart < this.config.time.CALIBRATION_DAYS;
    const isCalibrationComplete = daysSinceStart >= this.config.time.CALIBRATION_DAYS;

    return {
      isInCalibration,
      isCalibrationComplete,
      daysSinceStart,
      daysRemaining: Math.max(0, this.config.time.CALIBRATION_DAYS - daysSinceStart),
      calibrationDay: Math.min(daysSinceStart, this.config.time.CALIBRATION_DAYS)
    };
  }

  /**
   * Berechnet Tage zwischen zwei Daten (deterministisch)
   */
  calculateDaysSince(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Setze auf Mitternacht UTC für deterministische Berechnung
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(0, 0, 0, 0);

    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.floor(diffMs / this.config.time.MS_PER_DAY);

    return diffDays;
  }

  /**
   * Führt Kalibrations-Abschluss durch (Tag 30)
   *
   * Berechnet:
   * 1. Totale Scores über alle 30 Tage
   * 2. Perfekte Normalisierung (Σ Budget = 10€)
   * 3. Baseline-Ratio für Phase 2
   * 4. Bulk-Auszahlungen pro Domain
   *
   * @param {Array} calibrationScores - Alle Scores aus Kalibrations-Phase
   * @returns {Object} Kalibrations-Ergebnis
   */
  executeCalibrationSettlement(calibrationScores) {
    // 1. Aggregate nach Domain
    const domainScores = this.aggregateByDomain(calibrationScores);

    // 2. Totaler Score
    const totalScore = domainScores.reduce((sum, d) => sum + d.totalScore, 0);

    if (totalScore === 0) {
      return this.createEmptySettlement();
    }

    // 3. Perfekte Ratio berechnen
    const budget = this.config.tokens.MONTHLY_BUDGET_TOKENS; // 10^16 Tokens
    const perfectRatio = budget / BigInt(Math.floor(totalScore));

    // 4. Pro Domain: Token-Menge berechnen
    const domainPayments = [];

    for (const domain of domainScores) {
      const scoreBigInt = BigInt(Math.floor(domain.totalScore));
      const tokenAmount = scoreBigInt * perfectRatio;

      domainPayments.push({
        domain: domain.domain,
        score: domain.totalScore,
        tokens: tokenAmount,
        sessionCount: domain.sessionCount
      });
    }

    return {
      totalScore: totalScore,
      perfectRatio: perfectRatio,
      baselineRatio: perfectRatio, // Für Phase 2
      domainPayments: domainPayments,
      budget: budget,
      metadata: {
        calibrationComplete: true,
        settlementDate: new Date().toISOString(),
        domainCount: domainScores.length,
        sessionCount: calibrationScores.length
      }
    };
  }

  /**
   * Aggregiert Scores nach Domain
   */
  aggregateByDomain(scores) {
    const domainMap = new Map();

    for (const score of scores) {
      const domain = score.domain || score.metadata?.domain || 'unknown';

      if (!domainMap.has(domain)) {
        domainMap.set(domain, {
          domain: domain,
          totalScore: 0,
          sessionCount: 0,
          firstVisit: score.timestamp || score.metadata?.timestamp,
          lastVisit: score.timestamp || score.metadata?.timestamp
        });
      }

      const domainData = domainMap.get(domain);
      domainData.totalScore += score.score || 0;
      domainData.sessionCount += 1;
      domainData.lastVisit = score.timestamp || score.metadata?.timestamp;
    }

    return Array.from(domainMap.values());
  }

  /**
   * Erstellt leeres Settlement (Fallback)
   */
  createEmptySettlement() {
    return {
      totalScore: 0,
      perfectRatio: 0n,
      baselineRatio: 0n,
      domainPayments: [],
      budget: this.config.tokens.MONTHLY_BUDGET_TOKENS,
      metadata: {
        calibrationComplete: true,
        settlementDate: new Date().toISOString(),
        domainCount: 0,
        sessionCount: 0
      }
    };
  }

  /**
   * Speichert Kalibrations-Ergebnis lokal
   */
  async saveCalibrationResult(result, storage = browser.storage.local) {
    await storage.set({
      'rev_calibration_result': result,
      'rev_calibration_completed': true,
      'rev_calibration_date': new Date().toISOString()
    });
  }

  /**
   * Lädt Kalibrations-Ergebnis
   */
  async loadCalibrationResult(storage = browser.storage.local) {
    const data = await storage.get([
      'rev_calibration_result',
      'rev_calibration_completed',
      'rev_calibration_date'
    ]);

    if (!data.rev_calibration_completed) {
      return null;
    }

    return data.rev_calibration_result;
  }

  /**
   * Prüft ob Kalibrations-Settlement fällig ist
   */
  shouldExecuteSettlement(firstTrackingDate, currentDate = new Date()) {
    const status = this.getCalibrationStatus(firstTrackingDate, currentDate);

    // Settlement am Tag 30 (genau)
    return status.daysSinceStart === this.config.time.CALIBRATION_DAYS;
  }

  /**
   * Berechnet welche Domains Payment erhalten sollen
   * Berücksichtigt User-Präferenzen (NGO-System)
   */
  calculateDomainPayments(domainScores, userPreferences = []) {
    const payments = [];

    for (const domain of domainScores) {
      const scoreBigInt = BigInt(Math.floor(domain.totalScore));
      const baseTokens = scoreBigInt * domain.ratio;

      // NGO-Förderung prüfen (wird später implementiert)
      const { dsPayment, orPayments } = this.applyNGOLogic(
        domain.domain,
        baseTokens,
        userPreferences
      );

      payments.push({
        domain: domain.domain,
        score: domain.totalScore,
        dsPayment: dsPayment,
        orPayments: orPayments,
        totalTokens: baseTokens
      });
    }

    return payments;
  }

  /**
   * NGO-Logik (Stub - wird in ngo/criteria-matcher.js implementiert)
   */
  applyNGOLogic(domain, tokens, userPreferences) {
    // Default: Alles geht an DS (Domain-Wallet)
    // NGO-System wird später erweitert

    return {
      dsPayment: {
        wallet: `DS::${domain}`, // Placeholder
        amount: tokens
      },
      orPayments: [] // Leer für jetzt
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.CalibrationManager = CalibrationManager;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CalibrationManager;
}
