/**
 * Interaktions-Scorer
 *
 * Bewertet User-Interaktionen mit der Seite:
 * - Zeit (aktiv/passiv)
 * - Scrolling
 * - Klicks
 * - Text-/Code-Kopieren
 * - Downloads
 * - Explizite Aktionen (Bookmark, Share)
 * - Wiederholte Besuche
 *
 * WICHTIG: Additive und multiplikative Faktoren kombiniert
 */

class InteractionScorer {
  constructor(config) {
    this.config = config;
  }

  /**
   * Berechnet Interaktions-Score
   *
   * @param {Object} sessionData - Session-Daten vom Tracker
   * @param {Object} interactionData - Zusätzliche Interaktions-Daten
   * @returns {number} Interaktions-Score (Basis-Punkte)
   */
  calculateInteractionScore(sessionData, interactionData = {}) {
    let score = 0;

    // 1. Basis-Zeit-Score (wichtigster Faktor)
    score += this.calculateTimeScore(sessionData);

    // 2. Additive Interaktions-Bonusse
    score += this.calculateInteractionBonuses(interactionData);

    // 3. Multiplikativer Repeat-Visit Bonus
    const repeatMultiplier = this.calculateRepeatVisitMultiplier(interactionData);
    score *= repeatMultiplier;

    return Math.floor(score); // Integer Basis-Punkte
  }

  /**
   * Zeit-basierter Score
   * Aktive Zeit höher gewichtet als passive Zeit
   */
  calculateTimeScore(sessionData) {
    const activeTimeSeconds = this.getActiveTime(sessionData);
    const passiveTimeSeconds = this.getPassiveTime(sessionData);

    const activeScore = activeTimeSeconds * this.config.interactions.ACTIVE_TIME_PER_SECOND;
    const passiveScore = passiveTimeSeconds * this.config.interactions.PASSIVE_TIME_PER_SECOND;

    return activeScore + passiveScore;
  }

  /**
   * Additive Interaktions-Bonusse
   */
  calculateInteractionBonuses(interactionData) {
    let bonus = 0;

    // Scrolling (nur signifikante Scrolls zählen)
    const significantScrolls = interactionData.significantScrolls || 0;
    bonus += significantScrolls * this.config.interactions.SCROLL_BONUS;

    // Klicks
    const clicks = interactionData.clicks || 0;
    bonus += clicks * this.config.interactions.CLICK_BONUS;

    // Text-Selektion/Kopieren
    if (interactionData.textCopied) {
      bonus += this.config.interactions.TEXT_SELECTION;
    }

    // Code kopiert (sehr wertvoll!)
    if (interactionData.codeCopied) {
      bonus += this.config.interactions.CODE_COPY;
    }

    // Downloads
    const downloads = interactionData.downloads || 0;
    bonus += downloads * this.config.interactions.DOWNLOAD;

    // Bookmark
    if (interactionData.bookmarked) {
      bonus += this.config.interactions.BOOKMARK;
    }

    // Share
    if (interactionData.shared) {
      bonus += this.config.interactions.SHARE;
    }

    return bonus;
  }

  /**
   * Multiplikativer Repeat-Visit Bonus
   * Wiederholte Besuche = positiv (gegen Doomscrolling-Algorithmen!)
   */
  calculateRepeatVisitMultiplier(interactionData) {
    const visitCount = interactionData.visitCount || 1;

    if (visitCount <= 1) {
      return 1.0; // Erster Besuch = kein Bonus
    }

    // +10% pro wiederholtem Besuch, max 5x
    const repeatVisits = Math.min(visitCount - 1, this.config.interactions.MAX_REPEAT_BONUS);
    const multiplier = Math.pow(
      this.config.interactions.REPEAT_VISIT_MULTIPLIER,
      repeatVisits
    );

    return multiplier;
  }

  /**
   * Holt aktive Zeit aus Session-Daten
   */
  getActiveTime(sessionData) {
    if (!sessionData || !sessionData.metrics) {
      return 0;
    }

    const activeTime = sessionData.metrics.activeTime;
    if (!activeTime) {
      return 0;
    }

    // Konvertiere zu Sekunden
    if (activeTime.valueSeconds !== undefined) {
      return activeTime.valueSeconds;
    }

    if (activeTime.value !== undefined) {
      // Value ist in Millisekunden
      return Math.floor(activeTime.value / 1000);
    }

    return 0;
  }

  /**
   * Holt passive Zeit aus Session-Daten
   */
  getPassiveTime(sessionData) {
    if (!sessionData || !sessionData.metrics) {
      return 0;
    }

    const passiveTime = sessionData.metrics.passiveTime;
    if (!passiveTime) {
      return 0;
    }

    // Konvertiere zu Sekunden
    if (passiveTime.valueSeconds !== undefined) {
      return passiveTime.valueSeconds;
    }

    if (passiveTime.value !== undefined) {
      // Value ist in Millisekunden
      return Math.floor(passiveTime.value / 1000);
    }

    return 0;
  }

  /**
   * Sammelt Interaktions-Daten aus Session
   * (Kann erweitert werden wenn mehr Daten tracked werden)
   */
  collectInteractionData(sessionData, additionalData = {}) {
    // Handle null additionalData (default parameter only works for undefined)
    const data = additionalData || {};

    return {
      // Aus Session Custom Metrics
      significantScrolls: sessionData.customMetrics?.scrollDepth?.value || 0,
      clicks: sessionData.customMetrics?.clicks?.value || 0,

      // Explizite Events (müssen von außen übergeben werden)
      textCopied: data.textCopied || false,
      codeCopied: data.codeCopied || false,
      downloads: data.downloads || 0,
      bookmarked: data.bookmarked || false,
      shared: data.shared || false,

      // Repeat-Visits (aus lokalem Storage)
      visitCount: data.visitCount || 1
    };
  }

  /**
   * Qualitäts-Check: Verhindert Gaming
   * Filtert verdächtige Sessions (z.B. nur passive Zeit, kein Scroll)
   *
   * HINWEIS: Während der Testphase akzeptieren wir alle Sessions (auch kurze)
   * um das System zu testen und zu debuggen.
   */
  isValidSession(sessionData, interactionData) {
    const activeTime = this.getActiveTime(sessionData);
    const passiveTime = this.getPassiveTime(sessionData);
    const totalTime = activeTime + passiveTime;

    // TESTPHASE: Alle Sessions sind gültig, auch kurze
    // In Produktion würden wir hier strikte Validierung haben:
    // - Mindestens 5 Sekunden
    // - Keine reinen Passive-Sessions ohne Interaktionen
    // - Keine unrealistisch langen Sessions

    // Nur komplett leere Sessions ablehnen (totalTime = 0)
    if (totalTime === 0) {
      return false;
    }

    // Unrealistisch lange passive Zeit ohne Unterbrechung
    if (passiveTime > 3600 && activeTime < 10) {
      // >1h passiv, <10s aktiv = suspekt
      return false;
    }

    return true;
  }

  /**
   * Berechnet Active Ratio (für Qualitäts-Faktor)
   */
  calculateActiveRatio(sessionData) {
    const activeTime = this.getActiveTime(sessionData);
    const passiveTime = this.getPassiveTime(sessionData);
    const totalTime = activeTime + passiveTime;

    if (totalTime === 0) {
      return 0;
    }

    return activeTime / totalTime;
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.InteractionScorer = InteractionScorer;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = InteractionScorer;
}
