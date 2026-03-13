/**
 * Deterministisches Prognose-Modell
 *
 * Berechnet Monatsende-Prognose basierend auf historischen Daten
 *
 * KRITISCH: VOLLSTÄNDIG DETERMINISTISCH
 * - Keine Random-Werte
 * - Fixe Gewichtungen
 * - Dezimal-Arithmetik (BigInt für Tokens)
 * - Identische Berechnungen über alle Clients
 *
 * Prognose-Logik:
 * 1. Sliding Window: Letzte 90 Tage
 * 2. Wöchentliche Aggregation
 * 3. Gewichteter Durchschnitt (hart-codiert)
 * 4. Linearer Trend
 * 5. Projektion auf Monatsende
 */

class PrognosisModel {
  constructor(config) {
    this.config = config;
    // NEU: Prognose-Sicherheits-Faktor (für Translation Factor Schwankungen)
    this.prognosisSF = typeof window !== 'undefined' && window.PrognosisSafetyFactor
      ? new window.PrognosisSafetyFactor()
      : null;
  }

  /**
   * Berechnet Prognose für Restmonat (30-Tage-Zyklus)
   *
   * @param {Array} historicalScores - Historische Score-Daten (90 Tage)
   * @param {number} currentDayOfMonth - Aktueller Tag im 30-Tage-Zyklus (1-30)
   * @param {number} totalDaysTracked - Tage seit firstTrackingDate
   * @param {string} firstTrackingDate - Start-Datum des ersten Zyklus
   * @returns {Object} Prognose mit predictedMonthlyScore und Ratio
   */
  calculatePrognosis(historicalScores, currentDayOfMonth, totalDaysTracked = null, firstTrackingDate = null) {
    // Validierung
    if (!Array.isArray(historicalScores) || historicalScores.length === 0) {
      return this.createEmptyPrognosis();
    }

    if (currentDayOfMonth < 1 || currentDayOfMonth > 30) {
      throw new Error(`Invalid day of month: ${currentDayOfMonth}`);
    }

    // 1. Sliding Window: Letzte 90 Tage
    const windowedScores = this.applySlidingWindow(historicalScores, 90);

    // 2. Wöchentliche Aggregation
    const weeklyScores = this.aggregateByWeek(windowedScores);

    if (weeklyScores.length === 0) {
      return this.createEmptyPrognosis();
    }

    // 3. Gewichteter Durchschnitt (hart-codiert!)
    const avgWeeklyScore = this.calculateWeightedAverage(weeklyScores);

    // 4. Trend-Analyse (lineare Regression)
    const trend = this.calculateLinearTrend(weeklyScores.slice(-4));

    // 5. Prognose für Restmonat
    const daysRemaining = 30 - currentDayOfMonth;
    const predictedDailyScore = (avgWeeklyScore / 7) * (1 + trend);
    const predictedRemainingScore = predictedDailyScore * daysRemaining;

    // Score bis heute (aktueller 30-Tage-Zyklus)
    const scoreToDate = this.getCurrentMonthScore(
      historicalScores,
      currentDayOfMonth,
      totalDaysTracked,
      firstTrackingDate
    );

    const predictedMonthlyScore = scoreToDate + predictedRemainingScore;

    // Token-Ratio berechnen
    const predictedRatio = this.calculateTokenRatio(predictedMonthlyScore);

    return {
      predictedMonthlyScore: Math.floor(predictedMonthlyScore),
      predictedRemainingScore: Math.floor(predictedRemainingScore),
      scoreToDate: Math.floor(scoreToDate),
      predictedRatio: predictedRatio,
      trend: trend,
      avgWeeklyScore: avgWeeklyScore,
      metadata: {
        currentDay: currentDayOfMonth,
        daysRemaining: daysRemaining,
        windowSize: windowedScores.length,
        weekCount: weeklyScores.length
      }
    };
  }

  /**
   * Sliding Window: Nimmt letzte N Tage
   */
  applySlidingWindow(scores, windowDays) {
    if (scores.length <= windowDays) {
      return scores;
    }

    return scores.slice(-windowDays);
  }

  /**
   * Aggregiert Scores nach Wochen
   * Deterministisch: Woche = 7-Tage-Blöcke von heute zurück
   */
  aggregateByWeek(scores) {
    const weeks = [];
    let currentWeek = [];

    for (let i = scores.length - 1; i >= 0; i--) {
      currentWeek.push(scores[i]);

      if (currentWeek.length === 7 || i === 0) {
        // Woche komplett oder letzte Einträge
        const weekScore = currentWeek.reduce((sum, s) => sum + s.score, 0);
        weeks.unshift(weekScore); // Am Anfang einfügen (chronologisch)
        currentWeek = [];
      }
    }

    return weeks;
  }

  /**
   * Gewichteter Durchschnitt der letzten 4 Wochen
   * KRITISCH: Hart-codierte Gewichte (deterministisch!)
   */
  calculateWeightedAverage(weeklyScores) {
    const weights = [
      this.config.prognosis.WEEK_1_LATEST,
      this.config.prognosis.WEEK_2,
      this.config.prognosis.WEEK_3,
      this.config.prognosis.WEEK_4
    ];

    const lastFourWeeks = weeklyScores.slice(-4);

    if (lastFourWeeks.length === 0) {
      return 0;
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < lastFourWeeks.length; i++) {
      const weight = weights[lastFourWeeks.length - 1 - i] || 0;
      weightedSum += lastFourWeeks[lastFourWeeks.length - 1 - i] * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) {
      return 0;
    }

    return weightedSum / totalWeight;
  }

  /**
   * Berechnet linearen Trend (Steigung)
   * Nutzt letzte 4 Wochen
   *
   * Formel: slope = Σ((x - x̄)(y - ȳ)) / Σ((x - x̄)²)
   * Returns: Trend-Faktor (-1.0 bis +1.0+)
   */
  calculateLinearTrend(weeklyScores) {
    if (weeklyScores.length < 2) {
      return 0; // Nicht genug Daten für Trend
    }

    const n = weeklyScores.length;
    const x = Array.from({ length: n }, (_, i) => i); // [0, 1, 2, 3]
    const y = weeklyScores;

    // Mittelwerte
    const xMean = x.reduce((sum, val) => sum + val, 0) / n;
    const yMean = y.reduce((sum, val) => sum + val, 0) / n;

    // Kovarianz und Varianz
    let covariance = 0;
    let variance = 0;

    for (let i = 0; i < n; i++) {
      const xDiff = x[i] - xMean;
      const yDiff = y[i] - yMean;
      covariance += xDiff * yDiff;
      variance += xDiff * xDiff;
    }

    if (variance === 0) {
      return 0; // Keine Varianz = kein Trend
    }

    const slope = covariance / variance;

    // Normalisiere Steigung zu relativen Trend-Faktor
    // slope ist absolute Änderung pro Woche
    // Konvertiere zu relativem Faktor
    if (yMean === 0) {
      return 0;
    }

    const trendFactor = slope / yMean;

    // Clamp: -50% bis +50% pro Woche ist Maximum
    return Math.max(-0.5, Math.min(0.5, trendFactor));
  }

  /**
   * Holt Score für aktuellen 30-Tage-Zyklus (bis heute)
   */
  getCurrentMonthScore(historicalScores, currentDayOfMonth, totalDaysTracked = null, firstTrackingDate = null) {
    // Fallback: Wenn keine Zyklus-Info verfügbar, nutze alle Scores
    if (totalDaysTracked === null || firstTrackingDate === null) {
      return historicalScores.reduce((sum, entry) => sum + entry.score, 0);
    }

    // Berechne Start des aktuellen 30-Tage-Zyklus
    const cycleNumber = Math.floor(totalDaysTracked / 30);
    const cycleStartDays = cycleNumber * 30;

    const firstDate = new Date(firstTrackingDate);
    const cycleStartDate = new Date(firstDate.getTime() + cycleStartDays * 24 * 60 * 60 * 1000);
    const cycleEndDate = new Date(cycleStartDate.getTime() + currentDayOfMonth * 24 * 60 * 60 * 1000);

    let monthScore = 0;

    for (const entry of historicalScores) {
      const entryDate = new Date(entry.timestamp);

      // Nur Scores aus dem aktuellen Zyklus (bis currentDayOfMonth)
      if (entryDate >= cycleStartDate && entryDate < cycleEndDate) {
        monthScore += entry.score;
      }
    }

    return monthScore;
  }

  /**
   * Berechnet Token-Ratio (Tokens pro Score-Punkt)
   * Budget: 10€ = 10^16 Tokens
   *
   * WICHTIG: Nutzt BigInt für Präzision!
   */
  calculateTokenRatio(predictedMonthlyScore) {
    if (predictedMonthlyScore <= 0) {
      return 0n; // BigInt Zero
    }

    const budget = this.config.tokens.MONTHLY_BUDGET_TOKENS; // 10^16 BigInt

    // Ratio = Budget / Score
    // WICHTIG: Score zu BigInt konvertieren
    const scoreBigInt = BigInt(Math.floor(predictedMonthlyScore));

    const ratio = budget / scoreBigInt;

    return ratio;
  }

  /**
   * Konservativitätsfaktor
   * Linear: Tag 0 → 0%, Tag 90 → 98%
   *
   * WICHTIG: Keine Auszahlung ohne Prognose-Grundlage!
   */
  calculateConservativityFactor(totalDaysTracked) {
    if (totalDaysTracked <= 0) {
      return 0.0; // Tag 0 = 0% (keine Auszahlung)
    }

    if (totalDaysTracked >= this.config.conservativity.MAX_DAYS) {
      return this.config.conservativity.MAX_FACTOR; // 0.98
    }

    // Lineare Interpolation
    const factor = this.config.conservativity.SLOPE * totalDaysTracked;

    return factor;
  }

  /**
   * Berechnet konservative Token-Menge für neue Session
   */
  calculateConservativeTokens(newSessionScore, totalDaysTracked, prognosis) {
    // Konservativitätsfaktor
    const conservativityFactor = this.calculateConservativityFactor(totalDaysTracked);

    if (conservativityFactor === 0) {
      return 0n; // Keine Auszahlung
    }

    // Konservative Ratio
    const baseRatio = prognosis.predictedRatio;

    // Multipliziere Ratio mit Konservativitätsfaktor
    // WICHTIG: BigInt Arithmetik!
    const conservativeFactor = Math.floor(conservativityFactor * 1000); // 0.98 → 980
    const conservativeRatio = (baseRatio * BigInt(conservativeFactor)) / 1000n;

    // Token-Menge = Score × Ratio
    const scoreBigInt = BigInt(Math.floor(newSessionScore));
    const tokens = scoreBigInt * conservativeRatio;

    return tokens;
  }

  /**
   * Erstellt leere Prognose (Fallback)
   */
  createEmptyPrognosis() {
    return {
      predictedMonthlyScore: 0,
      predictedRemainingScore: 0,
      scoreToDate: 0,
      predictedRatio: 0n,
      trend: 0,
      avgWeeklyScore: 0,
      metadata: {
        currentDay: 0,
        daysRemaining: 0,
        windowSize: 0,
        weekCount: 0
      }
    };
  }

  /**
   * NEU: Berechnet Prognose-Sicherheits-Faktor basierend auf Translation Factor Verlauf
   *
   * @param {Array} factorHistory - [{timestamp, factor, totalScore}, ...]
   * @returns {number} Prognose Safety Factor (0.7 - 0.98)
   */
  calculatePrognosisSF(factorHistory) {
    if (!this.prognosisSF) {
      console.warn('[PrognosisModel] PrognosisSafetyFactor not initialized');
      return 0.9; // Fallback: 90% Auszahlung
    }

    return this.prognosisSF.calculatePrognosisSF(factorHistory);
  }

  /**
   * Snapshot-Zeitpunkt-Check (deterministisch!)
   * Prüft ob aktueller Zeitpunkt ein Snapshot-Zeitpunkt ist
   */
  isSnapshotTime(date = new Date()) {
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();

    for (const snapshot of this.config.snapshots) {
      if (hour === snapshot.hour && minute === snapshot.minute) {
        return true;
      }
    }

    return false;
  }

  /**
   * Nächster Snapshot-Zeitpunkt
   */
  getNextSnapshotTime(date = new Date()) {
    const now = date.getTime();

    for (const snapshot of this.config.snapshots) {
      const snapshotDate = new Date(date);
      snapshotDate.setUTCHours(snapshot.hour, snapshot.minute, 0, 0);

      if (snapshotDate.getTime() > now) {
        return snapshotDate;
      }
    }

    // Nächster Tag, erster Snapshot
    const nextDay = new Date(date);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    nextDay.setUTCHours(
      this.config.snapshots[0].hour,
      this.config.snapshots[0].minute,
      0,
      0
    );

    return nextDay;
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.PrognosisModel = PrognosisModel;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrognosisModel;
}
