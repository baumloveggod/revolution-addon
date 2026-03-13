/**
 * Start Safety Factor (2-dimensional)
 *
 * Berechnet zeitbasierten Sicherheitsfaktor für Ratings.
 *
 * WICHTIG: 2-DIMENSIONALE FUNKTION!
 * - Dimension 1: Zeit seit BA→CL Transfer (User-Alter)
 * - Dimension 2: Zeit seit Rating-Erstellung (Rating-Alter)
 *
 * REGELN:
 * 1. User-Age basiertes SF:
 *    - Tag 0-30: SF = 99% (1% Auszahlung)
 *    - Tag 30-90: Linear 99% → 0% (1% → 100%)
 *    - Tag 90+: SF = 0% (100% Auszahlung)
 *
 * 2. Rating-Age basiertes SF:
 *    - Rating + 30 Tage ≤ aktuell: SF = 0% (100% Auszahlung)
 *    - Sonst: Linearer Übergang von User-Age-SF → 0%
 *
 * 3. Finales SF = min(userAgeSF, ratingAgeSF)
 *
 * BEISPIEL:
 * - User ist Tag 5, Rating ist Tag 0 alt:
 *   - userAgeSF = 0.99 (99%)
 *   - ratingAgeSF = 0.99 (kein Unterschied)
 *   - finalSF = 0.99
 *
 * - User ist Tag 35, Rating ist Tag 0 alt:
 *   - userAgeSF = 0.918 (Tag 30-90 linear)
 *   - ratingAgeSF = 0.918 (noch keine 30 Tage)
 *   - finalSF = 0.918
 *
 * - User ist Tag 35, Rating ist Tag 30 alt:
 *   - userAgeSF = 0.918
 *   - ratingAgeSF = 0.0 (Rating ist 30 Tage alt!)
 *   - finalSF = 0.0 (VOLLE AUSZAHLUNG!)
 *
 * NACHZAHLUNGS-EFFEKT:
 * - Ratings werden automatisch nach 30 Tagen voll ausgezahlt
 * - RetroPayoutService prüft alle 6h und zahlt nach (3x-Regel)
 */

class StartSafetyFactor {
  constructor(config = {}) {
    // Konfiguration
    this.USER_PHASE_1_DAYS = config.userPhase1Days || 30;   // Erste Phase: 99% SF
    this.USER_PHASE_2_DAYS = config.userPhase2Days || 90;   // Zweite Phase: linear 99% → 0%
    this.USER_PHASE_1_SF = config.userPhase1SF || 0.99;     // 99% SF in Phase 1
    this.USER_PHASE_2_SF = config.userPhase2SF || 0.0;      // 0% SF ab Tag 90

    this.RATING_MATURITY_DAYS = config.ratingMaturityDays || 30;  // Rating "reift" nach 30 Tagen
  }

  /**
   * Berechnet Start-SF (2-dimensional)
   *
   * @param {number} ratingTimestamp - Zeitpunkt der Rating-Erstellung (ms)
   * @param {number} currentTimestamp - Aktueller Zeitpunkt (ms)
   * @param {number} baTransferTimestamp - Zeitpunkt des BA→CL Transfers (ms)
   * @returns {number} Safety Factor (0.0 - 0.99)
   */
  calculateStartSF(ratingTimestamp, currentTimestamp, baTransferTimestamp) {
    // Dimension 1: User-Age (Zeit seit BA→CL Transfer)
    const userAgeDays = this.getDaysSince(baTransferTimestamp, ratingTimestamp);
    const userAgeSF = this.calculateUserAgeSF(userAgeDays);

    // Dimension 2: Rating-Age (Zeit seit Rating-Erstellung)
    const ratingAgeDays = this.getDaysSince(ratingTimestamp, currentTimestamp);
    const ratingAgeSF = this.calculateRatingAgeSF(ratingAgeDays, userAgeSF);

    // Finales SF = Minimum der beiden
    const finalSF = Math.min(userAgeSF, ratingAgeSF);

    console.log('[StartSF] Calculated (2D):', {
      userAgeDays: userAgeDays.toFixed(1),
      ratingAgeDays: ratingAgeDays.toFixed(1),
      userAgeSF: (userAgeSF * 100).toFixed(1) + '%',
      ratingAgeSF: (ratingAgeSF * 100).toFixed(1) + '%',
      finalSF: (finalSF * 100).toFixed(1) + '%',
      isRatingMature: ratingAgeDays >= this.RATING_MATURITY_DAYS
    });

    return finalSF;
  }

  /**
   * Dimension 1: User-Age basiertes SF
   *
   * @param {number} daysSinceBATransfer - Tage seit BA→CL Transfer
   * @returns {number} Safety Factor (0.0 - 0.99)
   */
  calculateUserAgeSF(daysSinceBATransfer) {
    if (daysSinceBATransfer < this.USER_PHASE_1_DAYS) {
      // Phase 1: Konstant 99%
      return this.USER_PHASE_1_SF;
    } else if (daysSinceBATransfer < this.USER_PHASE_2_DAYS) {
      // Phase 2: Linear 99% → 0%
      const progress = (daysSinceBATransfer - this.USER_PHASE_1_DAYS) /
                      (this.USER_PHASE_2_DAYS - this.USER_PHASE_1_DAYS);
      return this.USER_PHASE_1_SF - (progress * this.USER_PHASE_1_SF);
    } else {
      // Phase 3: 0% SF (100% Auszahlung)
      return this.USER_PHASE_2_SF;
    }
  }

  /**
   * Dimension 2: Rating-Age basiertes SF
   *
   * @param {number} daysSinceRating - Tage seit Rating-Erstellung
   * @param {number} userAgeSF - User-Age basiertes SF (Startpunkt)
   * @returns {number} Safety Factor (0.0 - userAgeSF)
   */
  calculateRatingAgeSF(daysSinceRating, userAgeSF) {
    if (daysSinceRating >= this.RATING_MATURITY_DAYS) {
      // Rating ist "reif" (30 Tage alt) → Volle Auszahlung
      return 0.0;
    }

    // Linear: Tag 0 = userAgeSF, Tag 30 = 0%
    const progress = daysSinceRating / this.RATING_MATURITY_DAYS;
    return userAgeSF * (1.0 - progress);
  }

  /**
   * Helper: Berechne Tage zwischen zwei Timestamps
   */
  getDaysSince(fromTimestamp, toTimestamp) {
    const ms = toTimestamp - fromTimestamp;
    return Math.max(0, ms / (24 * 60 * 60 * 1000));
  }

  /**
   * Berechne PayoutFactor (Umkehrung von SF)
   *
   * @param {number} safetyFactor - Safety Factor (0.0 - 0.99)
   * @returns {number} Payout Factor (0.01 - 1.0)
   */
  calculatePayoutFactor(safetyFactor) {
    return 1.0 - safetyFactor;
  }

  /**
   * Backward Compatibility: Alte 1D-Funktion
   * Verwendet nur User-Age, ignoriert Rating-Age
   *
   * @param {number} daysSinceBATransfer - Tage seit BA→CL Transfer
   * @returns {number} Safety Factor (0.0 - 0.99)
   */
  calculateSafetyFactor(daysSinceBATransfer) {
    return this.calculateUserAgeSF(daysSinceBATransfer);
  }

  /**
   * Detaillierte Analyse (für Debugging)
   */
  getStartSFDetails(ratingTimestamp, currentTimestamp, baTransferTimestamp) {
    const userAgeDays = this.getDaysSince(baTransferTimestamp, ratingTimestamp);
    const ratingAgeDays = this.getDaysSince(ratingTimestamp, currentTimestamp);
    const userAgeSF = this.calculateUserAgeSF(userAgeDays);
    const ratingAgeSF = this.calculateRatingAgeSF(ratingAgeDays, userAgeSF);
    const finalSF = Math.min(userAgeSF, ratingAgeSF);
    const payoutFactor = this.calculatePayoutFactor(finalSF);

    return {
      timestamps: {
        baTransfer: new Date(baTransferTimestamp).toISOString(),
        rating: new Date(ratingTimestamp).toISOString(),
        current: new Date(currentTimestamp).toISOString()
      },
      ages: {
        userAgeDays: userAgeDays.toFixed(2),
        ratingAgeDays: ratingAgeDays.toFixed(2)
      },
      safetyFactors: {
        userAgeSF: (userAgeSF * 100).toFixed(1) + '%',
        ratingAgeSF: (ratingAgeSF * 100).toFixed(1) + '%',
        finalSF: (finalSF * 100).toFixed(1) + '%'
      },
      payout: {
        payoutFactor: (payoutFactor * 100).toFixed(1) + '%',
        effectivePayoutPercentage: (payoutFactor * 100).toFixed(2) + '%'
      },
      phases: {
        userPhase: userAgeDays < this.USER_PHASE_1_DAYS ? 1 :
                   userAgeDays < this.USER_PHASE_2_DAYS ? 2 : 3,
        isRatingMature: ratingAgeDays >= this.RATING_MATURITY_DAYS
      }
    };
  }

  /**
   * Beispiel-Berechnungen (für Testing)
   */
  static exampleCalculations() {
    const startSF = new StartSafetyFactor();
    const baTransfer = Date.now() - (35 * 24 * 60 * 60 * 1000);  // 35 Tage her

    console.log('=== StartSF Examples (2D) ===\n');

    // Szenario 1: Frisches Rating
    const freshRating = Date.now();
    const sf1 = startSF.calculateStartSF(freshRating, Date.now(), baTransfer);
    console.log('Szenario 1: Frisches Rating (gerade erstellt)');
    console.log('  User-Age: 35 Tage, Rating-Age: 0 Tage');
    console.log('  SF:', (sf1 * 100).toFixed(1) + '%');
    console.log('  Payout:', ((1 - sf1) * 100).toFixed(1) + '%\n');

    // Szenario 2: Rating ist 15 Tage alt
    const rating15d = Date.now() - (15 * 24 * 60 * 60 * 1000);
    const sf2 = startSF.calculateStartSF(rating15d, Date.now(), baTransfer);
    console.log('Szenario 2: Rating ist 15 Tage alt');
    console.log('  User-Age: 20 Tage (bei Rating-Erstellung), Rating-Age: 15 Tage');
    console.log('  SF:', (sf2 * 100).toFixed(1) + '%');
    console.log('  Payout:', ((1 - sf2) * 100).toFixed(1) + '%\n');

    // Szenario 3: Rating ist 30 Tage alt (REIF!)
    const rating30d = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const sf3 = startSF.calculateStartSF(rating30d, Date.now(), baTransfer);
    console.log('Szenario 3: Rating ist 30 Tage alt (REIF!)');
    console.log('  User-Age: 5 Tage (bei Rating-Erstellung), Rating-Age: 30 Tage');
    console.log('  SF:', (sf3 * 100).toFixed(1) + '%', '← VOLLE AUSZAHLUNG!');
    console.log('  Payout:', ((1 - sf3) * 100).toFixed(1) + '%\n');

    // Szenario 4: Unregelmäßige Nutzung
    console.log('=== Unregelmäßige Nutzung (1x/Woche) ===');
    const weeklyRatings = [
      { day: 1, ratingAge: 0 },
      { day: 8, ratingAge: 0 },
      { day: 15, ratingAge: 0 },
      { day: 22, ratingAge: 0 },
      { day: 29, ratingAge: 0 },
      { day: 35, ratingAge: 0 },  // Neues Rating
      { day: 35, ratingAge: 34 }  // Erstes Rating ist jetzt 34 Tage alt!
    ];

    weeklyRatings.forEach(({ day, ratingAge }) => {
      const ratingTime = baTransfer + (day * 24 * 60 * 60 * 1000);
      const currentTime = ratingTime + (ratingAge * 24 * 60 * 60 * 1000);
      const sf = startSF.calculateStartSF(ratingTime, currentTime, baTransfer);
      console.log(`Tag ${day}, Rating-Age ${ratingAge}d: SF=${(sf * 100).toFixed(1)}%, Payout=${((1-sf)*100).toFixed(1)}%`);
    });
  }
}

// Export für background.js
if (typeof window !== 'undefined') {
  window.StartSafetyFactor = StartSafetyFactor;
}
