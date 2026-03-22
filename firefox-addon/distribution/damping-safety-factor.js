/**
 * Damping Safety Factor (Dämpfungs-SF)
 *
 * Verhindert Gaming durch ungleichmäßige Rating-Verteilung innerhalb der ersten 30 Tage.
 *
 * PROBLEM:
 * - User nutzt Gerät nur 1x pro Woche für 2 Stunden (unregelmäßig)
 * - Ratings am Anfang der 2h bekommen mehr Tokens als am Ende (weil Translation Factor sinkt)
 * - Je nach Verteilung der Sitzungen: Gaming-Möglichkeit
 *
 * LÖSUNG:
 * - Prognostiziere Ratings für 30 Tage basierend auf aktueller Historie
 * - Dämpfe entsprechend: Tag 1 = 3.3%, Tag 15 = 50%, Tag 30 = 100%
 * - Nach Tag 30: Keine Dämpfung mehr (100%)
 *
 * FORMEL:
 * dampingSF = min(1.0, actualDays / 30)
 *
 * WICHTIG:
 * - Kombiniert mit Start-SF und Schwankung-SF
 * - Unabhängig von anderen Faktoren
 */

class DampingSafetyFactor {
  constructor(config = {}) {
    // Konfiguration
    this.RAMP_UP_DAYS = config.rampUpDays || 30;  // Volle Dämpfung nach 30 Tagen
    this.MIN_SAFETY_FACTOR = config.minSafetyFactor || 0.0;  // Minimum 0%
    this.MAX_SAFETY_FACTOR = config.maxSafetyFactor || 1.0;  // Maximum 100%
  }

  /**
   * Berechnet Dämpfungs-SF basierend auf verstrichenen Tagen
   *
   * @param {number} daysSinceFirstTransfer - Tage seit BA→CL Transfer
   * @returns {number} Damping Safety Factor (0.0 - 1.0)
   */
  calculateDampingSF(daysSinceFirstTransfer) {
    if (daysSinceFirstTransfer >= this.RAMP_UP_DAYS) {
      // Nach 30 Tagen: Keine Dämpfung mehr (100%)
      return this.MAX_SAFETY_FACTOR;
    }

    // Linear ansteigend: Tag 0 = 0%, Tag 30 = 100%
    // Formel: daysSinceFirstTransfer / RAMP_UP_DAYS
    const dampingSF = daysSinceFirstTransfer / this.RAMP_UP_DAYS;

    // Begrenzen auf MIN/MAX
    const clampedSF = Math.max(this.MIN_SAFETY_FACTOR, Math.min(this.MAX_SAFETY_FACTOR, dampingSF));

    return clampedSF;
  }

  /**
   * Prognostiziere Ratings für 30 Tage (optional, für erweiterte Logik)
   *
   * Diese Methode kann verwendet werden, um die Dämpfung basierend auf
   * prognostizierten Ratings anzupassen (zukünftige Erweiterung).
   *
   * @param {Array} ratingHistory - Rating-Historie
   * @returns {number} Prognostizierte Anzahl Ratings in 30 Tagen
   */
  predictRatingsIn30Days(ratingHistory) {
    if (!ratingHistory || ratingHistory.length === 0) {
      return 0;
    }

    // Berechne Durchschnitts-Rate (Ratings pro Tag)
    const daysCovered = this.getDaysCoveredByHistory(ratingHistory);
    if (daysCovered === 0) {
      return ratingHistory.length;
    }

    const ratingsPerDay = ratingHistory.length / daysCovered;
    const predictedRatings = ratingsPerDay * 30;

    return predictedRatings;
  }

  /**
   * Berechne abgedeckte Tage in Historie
   */
  getDaysCoveredByHistory(ratingHistory) {
    if (!ratingHistory || ratingHistory.length === 0) {
      return 0;
    }

    const timestamps = ratingHistory.map(r => r.timestamp);
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps);

    const daysCovered = Math.floor((latest - earliest) / (24 * 60 * 60 * 1000));
    return Math.max(1, daysCovered);
  }

  /**
   * Detaillierte Analyse (für Debugging)
   */
  getDampingDetails(daysSinceFirstTransfer, ratingHistory = null) {
    const dampingSF = this.calculateDampingSF(daysSinceFirstTransfer);

    const details = {
      daysSinceFirstTransfer,
      rampUpDays: this.RAMP_UP_DAYS,
      dampingSF,
      dampingPercentage: (dampingSF * 100).toFixed(1) + '%',
      isFullyRamped: daysSinceFirstTransfer >= this.RAMP_UP_DAYS
    };

    if (ratingHistory && ratingHistory.length > 0) {
      details.prediction = {
        predictedRatingsIn30Days: Math.round(this.predictRatingsIn30Days(ratingHistory)),
        actualRatings: ratingHistory.length,
        daysCovered: this.getDaysCoveredByHistory(ratingHistory)
      };
    }

    return details;
  }

  /**
   * Beispiel-Berechnung (für Testing)
   */
  static exampleCalculation() {
    // Example calculations for testing/debugging - no output
  }
}

// Export für background.js
if (typeof window !== 'undefined') {
  window.DampingSafetyFactor = DampingSafetyFactor;
}
