/**
 * Technische Qualitäts-Analyse
 *
 * Bewertet technische Aspekte einer Webseite:
 * - Tracker
 * - Performance
 * - Ads
 * - Accessibility
 * - Cookie-Banner
 *
 * WICHTIG: Alle Faktoren sind multiplikativ (0.0 - 2.0+)
 */

class QualityAnalyzer {
  constructor(config) {
    this.config = config;
  }

  /**
   * Berechnet Gesamt-Qualitätsfaktor
   *
   * @param {Object} pageData - Qualitäts-Daten über die Seite
   * @returns {number} Qualitätsfaktor (multiplikativ, 0.0 - 2.0+)
   */
  calculateQualityFactor(pageData) {
    let factor = 1.0;

    // Tracker Penalty
    factor *= this.calculateTrackerFactor(pageData.trackers || []);

    // Performance
    factor *= this.calculatePerformanceFactor(pageData.performance || {});

    // Ads
    factor *= this.calculateAdFactor(pageData.ads || {});

    // Accessibility
    factor *= this.calculateAccessibilityFactor(pageData.accessibility || {});

    // Cookie Banner
    factor *= this.calculateCookieBannerFactor(pageData.cookieBanner || {});

    // Clamp: Mindestens 0.1 (nie komplett auf 0)
    return Math.max(0.1, factor);
  }

  /**
   * Tracker Penalty
   * Mehr Tracker = niedrigerer Score
   */
  calculateTrackerFactor(trackers) {
    const trackerCount = Array.isArray(trackers) ? trackers.length : 0;

    const penalty = Math.min(
      trackerCount * this.config.quality.TRACKER_PENALTY_PER_TRACKER,
      this.config.quality.MAX_TRACKER_PENALTY
    );

    return 1.0 - penalty;
  }

  /**
   * Performance Factor
   * Schnelle Seiten = Bonus, langsame = Penalty
   */
  calculatePerformanceFactor(performance) {
    let factor = 1.0;

    const loadTime = performance.loadTime || performance.domContentLoaded || 0;

    if (loadTime > 0) {
      if (loadTime < 1000) {
        // Sehr schnell (< 1s) = +10%
        factor += this.config.quality.FAST_LOAD_BONUS;
      } else if (loadTime > 5000) {
        // Langsam (> 5s) = -10%
        factor -= this.config.quality.SLOW_LOAD_PENALTY;
      }
    }

    return factor;
  }

  /**
   * Ad Factor
   * Viele Ads = Penalty
   */
  calculateAdFactor(adData) {
    const adCount = adData.count || 0;

    if (adCount === 0) {
      // Keine Ads = neutral
      return 1.0;
    }

    const penalty = Math.min(
      adCount * this.config.quality.AD_PENALTY_PER_AD,
      this.config.quality.MAX_AD_PENALTY
    );

    // Extra Penalty für excessive Ads
    if (adCount > this.config.quality.EXCESSIVE_ADS_THRESHOLD) {
      return 1.0 - this.config.quality.MAX_AD_PENALTY;
    }

    return 1.0 - penalty;
  }

  /**
   * Accessibility Factor
   * Gute a11y = Bonus
   */
  calculateAccessibilityFactor(a11yData) {
    let factor = 1.0;

    // Heuristische Checks
    const hasAltText = a11yData.hasImageAltText || false;
    const hasAriaLabels = a11yData.hasAriaLabels || false;
    const hasGoodContrast = a11yData.hasGoodContrast || false;
    const hasKeyboardNav = a11yData.hasKeyboardNavigation || false;

    // Zähle erfüllte Kriterien
    const criteriaCount = [
      hasAltText,
      hasAriaLabels,
      hasGoodContrast,
      hasKeyboardNav
    ].filter(Boolean).length;

    // Bonus: +5% wenn mindestens 3/4 Kriterien erfüllt
    if (criteriaCount >= 3) {
      factor += this.config.quality.ACCESSIBILITY_BONUS;
    }

    return factor;
  }

  /**
   * Cookie Banner Factor
   * Aggressive Banners = Penalty
   */
  calculateCookieBannerFactor(cookieBannerData) {
    const isAggressive = cookieBannerData.isAggressive || false;

    if (isAggressive) {
      return 1.0 - this.config.quality.AGGRESSIVE_COOKIE_BANNER_PENALTY;
    }

    return 1.0;
  }

  /**
   * Tracker-Erkennung (kann aus Content Script kommen)
   * Sucht nach bekannten Tracker-Domains
   */
  detectTrackers(requests) {
    const knownTrackers = [
      'google-analytics.com',
      'googletagmanager.com',
      'facebook.net',
      'doubleclick.net',
      'scorecardresearch.com',
      'chartbeat.com',
      'hotjar.com',
      'mixpanel.com',
      'segment.com',
      'amplitude.com',
      'newrelic.com',
      'bugsnag.com',
      'sentry.io',
      'fullstory.com'
    ];

    if (!Array.isArray(requests)) {
      return [];
    }

    const trackers = [];

    for (const request of requests) {
      const url = request.url || request;
      const urlLower = url.toLowerCase();

      for (const tracker of knownTrackers) {
        if (urlLower.includes(tracker)) {
          trackers.push({
            domain: tracker,
            url: url
          });
          break; // Ein Tracker pro Request
        }
      }
    }

    return trackers;
  }

  /**
   * Ad-Erkennung (Heuristik basierend auf DOM)
   */
  detectAds(domData) {
    if (!domData) {
      return { count: 0, elements: [] };
    }

    let adCount = 0;
    const adElements = [];

    // Class-/ID-Namen die auf Ads hindeuten
    const adIndicators = [
      'ad-container',
      'advertisement',
      'ad-slot',
      'google-ad',
      'sponsored',
      'promo-box'
    ];

    // Zähle Ad-Indikatoren (aus Content Script)
    if (domData.adClassCount) {
      adCount += domData.adClassCount;
    }

    // Prüfe iFrames (häufig Ads)
    if (domData.iframeCount > 0) {
      // Konservativ: 50% der iFrames als Ads zählen
      adCount += Math.floor(domData.iframeCount * 0.5);
    }

    return {
      count: adCount,
      elements: adElements
    };
  }

  /**
   * Cookie-Banner Erkennung
   */
  detectCookieBanner(domData) {
    if (!domData) {
      return { exists: false, isAggressive: false };
    }

    const hasCookieBanner = domData.hasCookieBanner || false;

    // Aggressive: Banner mit forced interaction oder dark patterns
    const isAggressive = domData.cookieBannerBlocksContent || false;

    return {
      exists: hasCookieBanner,
      isAggressive: isAggressive
    };
  }

  /**
   * Accessibility Analyse (Basis-Checks)
   */
  analyzeAccessibility(domData) {
    if (!domData) {
      return {
        hasImageAltText: false,
        hasAriaLabels: false,
        hasGoodContrast: false,
        hasKeyboardNavigation: false
      };
    }

    return {
      hasImageAltText: domData.imagesWithAlt > 0,
      hasAriaLabels: domData.ariaLabelCount > 0,
      hasGoodContrast: domData.hasGoodContrast || false,
      hasKeyboardNavigation: domData.hasKeyboardNav || false
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.QualityAnalyzer = QualityAnalyzer;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QualityAnalyzer;
}
