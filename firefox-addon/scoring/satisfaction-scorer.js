/**
 * Satisfaction Scorer
 *
 * Enhanced Scoring mit Nutzerzufriedenheits-Indikatoren:
 * - Attention-gewichteter Interaction Score
 * - Experience Factor (Frustration-basiert)
 * - Explicit Rating Bonus
 * - Flow State & Utility Pattern Detection
 *
 * Version: 2.0.0
 */

class SatisfactionScorer {
  constructor(config) {
    this.config = config;
  }

  /**
   * Berechnet Enhanced Interaction Score
   * Time Score wird mit Attention Quality gewichtet
   */
  calculateEnhancedInteractionScore(sessionData, satisfactionData) {
    let score = 0;

    // 1. Attention Quality aus Satisfaction Data
    const attentionQuality = satisfactionData?.attentionQuality?.attentionQuality || 1.0;

    // 2. Zeit-Score mit Attention-Gewichtung
    const activeTimeSeconds = this.getActiveTime(sessionData);
    const passiveTimeSeconds = this.getPassiveTime(sessionData);

    const timeScore =
      (activeTimeSeconds * this.config.satisfaction.ACTIVE_PCT_WEIGHT * attentionQuality) +
      (passiveTimeSeconds * this.config.interactions.PASSIVE_TIME_PER_SECOND * attentionQuality);

    score += timeScore;

    // 3. Reading Behavior Bonus (NEU)
    if (satisfactionData?.readingBehavior) {
      const reading = satisfactionData.readingBehavior;

      // Smooth scrolling bonus
      score += (reading.smoothScrollRatio || 0) * this.config.satisfaction.SMOOTH_SCROLL_BONUS;

      // Content depth bonus
      score += (reading.maxDepth || 0) * this.config.satisfaction.CONTENT_DEPTH_BONUS;

      // Backtrack bonus (capped at 5)
      const backtracks = Math.min(
        reading.backtrackCount || 0,
        this.config.satisfaction.MAX_BACKTRACK_COUNT
      );
      score += backtracks * this.config.satisfaction.BACKTRACK_BONUS;
    }

    // 4. Bestehende Interaktions-Boni (aus sessionData.customMetrics)
    const scrollBonus = (sessionData.customMetrics?.scrollDepth?.value || 0) *
                       this.config.interactions.SCROLL_BONUS;
    const clickBonus = (sessionData.customMetrics?.clicks?.value || 0) *
                      this.config.interactions.CLICK_BONUS;

    score += scrollBonus + clickBonus;

    // 5. Pattern Detection Bonuses (NEU)
    if (this.detectFlowState(sessionData, satisfactionData)) {
      score += this.config.satisfaction.FLOW_STATE_BONUS;
    }

    if (this.detectUtilityPattern(sessionData, satisfactionData)) {
      score += this.config.satisfaction.UTILITY_BONUS;
    }

    return Math.floor(score);
  }

  /**
   * Berechnet Experience Factor basierend auf Frustration
   * Range: 0.7 - 1.0
   */
  calculateExperienceFactor(satisfactionData) {
    if (!satisfactionData?.frustration) {
      return 1.0;
    }

    const frustration = satisfactionData.frustration;

    // Frustration Score berechnen
    const frustrationScore =
      (frustration.rageClicks * this.config.satisfaction.RAGE_CLICK_PENALTY) +
      (frustration.deadClicks * this.config.satisfaction.DEAD_CLICK_PENALTY) +
      (frustration.errorEncounters * this.config.satisfaction.ERROR_PENALTY) +
      (frustration.tabThrashing * this.config.satisfaction.TAB_THRASH_PENALTY);

    // Penalty berechnen (max 30%)
    const penalty = Math.min(
      frustrationScore * 0.01,
      this.config.satisfaction.MAX_FRUSTRATION_PENALTY
    );

    // Experience Factor: 1.0 - penalty
    const factor = 1.0 - penalty;

    return Math.max(0.7, Math.min(1.0, factor)); // Clamp to 0.7 - 1.0
  }

  /**
   * Berechnet Explicit Rating Bonus
   * -500 bis +1000 Punkte
   */
  calculateExplicitBonus(explicitFeedback) {
    if (!explicitFeedback || !explicitFeedback.rating) {
      return 0;
    }

    const rating = explicitFeedback.rating;
    return this.config.satisfaction.RATING_BONUSES[rating] || 0;
  }

  /**
   * Detectet Flow State
   * Kriterien:
   * - > 5 Min aktive Zeit
   * - < 10% passive Zeit Ratio
   * - > 3 Interaktionen pro Minute
   */
  detectFlowState(sessionData, satisfactionData) {
    const activeTime = this.getActiveTime(sessionData);
    const passiveTime = this.getPassiveTime(sessionData);
    const totalTime = activeTime + passiveTime;

    if (totalTime === 0) return false;

    // Kriterium 1: > 5 Minuten aktiv
    if (activeTime < this.config.satisfaction.FLOW_STATE_MIN_TIME) {
      return false;
    }

    // Kriterium 2: < 10% passive Zeit Ratio
    const passiveRatio = passiveTime / totalTime;
    if (passiveRatio > this.config.satisfaction.FLOW_STATE_MAX_PASSIVE_RATIO) {
      return false;
    }

    // Kriterium 3: > 3 Interaktionen/Minute
    const interactionCount =
      (sessionData.customMetrics?.scrollDepth?.value || 0) +
      (sessionData.customMetrics?.clicks?.value || 0);
    const interactionDensity = interactionCount / (activeTime / 60);

    if (interactionDensity < this.config.satisfaction.FLOW_STATE_MIN_INTERACTION_DENSITY) {
      return false;
    }

    return true;
  }

  /**
   * Detectet Utility Pattern
   * Kriterien:
   * - 30s - 5min total time
   * - Nicht gebounced (> 10s, > 25% Scroll)
   * - > 25% Scroll-Tiefe
   */
  detectUtilityPattern(sessionData, satisfactionData) {
    const activeTime = this.getActiveTime(sessionData);
    const passiveTime = this.getPassiveTime(sessionData);
    const totalTime = activeTime + passiveTime;

    // Kriterium 1: 30s - 5min
    if (totalTime < this.config.satisfaction.UTILITY_MIN_TIME ||
        totalTime > this.config.satisfaction.UTILITY_MAX_TIME) {
      return false;
    }

    // Kriterium 2: Nicht gebounced
    const bounced = totalTime < this.config.satisfaction.BOUNCE_THRESHOLD;
    if (bounced) {
      return false;
    }

    // Kriterium 3: > 25% Scroll-Tiefe
    const scrollDepth = satisfactionData?.readingBehavior?.maxDepth || 0;
    if (scrollDepth < this.config.satisfaction.UTILITY_MIN_SCROLL_DEPTH) {
      return false;
    }

    return true;
  }

  /**
   * Helper: Holt aktive Zeit aus Session-Daten
   */
  getActiveTime(sessionData) {
    if (!sessionData || !sessionData.metrics) {
      return 0;
    }

    const activeTime = sessionData.metrics.activeTime;
    if (!activeTime) {
      return 0;
    }

    if (activeTime.valueSeconds !== undefined) {
      return activeTime.valueSeconds;
    }

    if (activeTime.value !== undefined) {
      return Math.floor(activeTime.value / 1000);
    }

    return 0;
  }

  /**
   * Helper: Holt passive Zeit aus Session-Daten
   */
  getPassiveTime(sessionData) {
    if (!sessionData || !sessionData.metrics) {
      return 0;
    }

    const passiveTime = sessionData.metrics.passiveTime;
    if (!passiveTime) {
      return 0;
    }

    if (passiveTime.valueSeconds !== undefined) {
      return passiveTime.valueSeconds;
    }

    if (passiveTime.value !== undefined) {
      return Math.floor(passiveTime.value / 1000);
    }

    return 0;
  }

  /**
   * Hauptfunktion: Komplettes Enhanced Scoring
   *
   * Formula:
   * Final Score = (Enhanced Base Score × Content × Quality × Experience × OSS) + Explicit Bonus
   */
  scoreSessionWithSatisfaction(
    sessionData,
    pageData,
    satisfactionData,
    interactionScorer,
    qualityAnalyzer,
    contentDetector,
    ossData
  ) {
    // 1. Enhanced Base Interaction Score (mit Attention Quality)
    const baseScore = this.calculateEnhancedInteractionScore(sessionData, satisfactionData);

    // 2. Content Type Multiplier (bestehend)
    const contentType = contentDetector?.detectContentType(pageData) || 'UNKNOWN';
    const contentMultiplier = this.config.contentTypes[contentType] || 1.0;

    // 3. Quality Factor (bestehend)
    const qualityFactor = qualityAnalyzer?.calculateQualityFactor(pageData) || 1.0;

    // 4. Experience Factor (NEU)
    const experienceFactor = this.calculateExperienceFactor(satisfactionData);

    // 5. OSS Multiplier (bestehend)
    const ossBonus = ossData?.bonus || 0;
    const ossMultiplier = 1 + ossBonus;

    // 6. Multiplicative Score
    let finalScore = baseScore * contentMultiplier * qualityFactor *
                    experienceFactor * ossMultiplier;

    // 7. Explicit Rating Bonus (NEU)
    const explicitBonus = this.calculateExplicitBonus(satisfactionData?.explicitFeedback);
    finalScore += explicitBonus;

    // 8. Clamp to 0 - 10000
    finalScore = Math.max(0, Math.min(10000, Math.floor(finalScore)));

    return {
      score: finalScore,
      breakdown: {
        baseScore,
        contentType,
        contentMultiplier,
        qualityFactor,
        experienceFactor,
        ossMultiplier,
        explicitBonus,

        // Satisfaction Details
        satisfaction: {
          utility: this.detectUtilityPattern(sessionData, satisfactionData),
          engagement: this.detectFlowState(sessionData, satisfactionData),
          quality: qualityFactor,
          experience: experienceFactor,
          explicit: satisfactionData?.explicitFeedback?.rating || null
        }
      }
    };
  }
}

// Export für Browser-Extension
if (typeof window !== 'undefined') {
  window.SatisfactionScorer = SatisfactionScorer;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SatisfactionScorer;
}
