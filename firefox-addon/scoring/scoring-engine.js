/**
 * Revolution Scoring Engine
 *
 * Haupt-Bewertungslogik die alle Komponenten zusammenführt:
 * - Content-Typ Erkennung
 * - Interaktions-Bewertung
 * - Technische Qualität
 * - Open-Source Bonus
 *
 * Output: Session-Score in Basis-Punkten (0-10000)
 *
 * WICHTIG: Deterministisch - gleiche Inputs → gleicher Score
 */

class ScoringEngine {
  constructor(config, contentDetector, interactionScorer, qualityAnalyzer, satisfactionScorer = null) {
    this.config = config;
    this.contentDetector = contentDetector;
    this.interactionScorer = interactionScorer;
    this.qualityAnalyzer = qualityAnalyzer;
    this.satisfactionScorer = satisfactionScorer; // NEW: v2.0.0
  }

  /**
   * Hauptfunktion: Bewertet eine komplette Session
   *
   * @param {Object} sessionData - Session-Daten vom Tracker
   * @param {Object} pageData - Seiten-Metadaten (DOM, Performance, etc.)
   * @param {Object} additionalData - Zusätzliche Daten (OSS-Links, Visits, satisfaction data, etc.)
   * @returns {Object} Scoring-Ergebnis mit Score + Breakdown
   */
  scoreSession(sessionData, pageData, additionalData = {}) {
    // Validierung
    if (!this.interactionScorer.isValidSession(sessionData, additionalData)) {
      return this.createInvalidSessionResult(sessionData, pageData);
    }

    // Check if we have satisfaction data and scorer (v2.0.0)
    const hasSatisfactionData = additionalData && (
      additionalData.readingBehavior ||
      additionalData.frustration ||
      additionalData.attentionQuality ||
      additionalData.explicitFeedback
    );
    const useSatisfactionScoring = this.satisfactionScorer && hasSatisfactionData;

    if (useSatisfactionScoring) {
      console.log('[ScoringEngine] Using v2.0.0 Enhanced Satisfaction Scoring');
      return this.scoreSessionWithSatisfaction(sessionData, pageData, additionalData);
    }

    // Fallback to v1.0.0 scoring (without satisfaction metrics)
    console.log('[ScoringEngine] Using v1.0.0 Classic Scoring (no satisfaction data)');

    // 1. Content-Typ Erkennung
    const contentType = this.contentDetector.detectContentType(pageData);
    const contentTypeMultiplier = this.contentDetector.getMultiplier(contentType);

    // 2. Interaktions-Score (Basis-Punkte)
    const interactionData = this.interactionScorer.collectInteractionData(
      sessionData,
      additionalData
    );
    const baseScore = this.interactionScorer.calculateInteractionScore(
      sessionData,
      interactionData
    );

    // 3. Technische Qualität (multiplikativ)
    const qualityFactor = this.qualityAnalyzer.calculateQualityFactor(pageData);

    // 4. Open-Source Bonus (multiplikativ)
    const ossBonus = this.calculateOSSBonus(pageData, additionalData);

    // 5. Kombiniere alles
    let finalScore = baseScore;

    // Multipliziere mit Content-Typ
    finalScore *= contentTypeMultiplier;

    // Multipliziere mit Qualität (1 - trackerPenalty)
    finalScore *= qualityFactor;

    // Multipliziere mit OSS-Bonus (1 + bonus)
    finalScore *= (1 + ossBonus);

    // Clamp: 0 - 10000
    finalScore = Math.max(0, Math.min(this.config.scores.MAX_SCORE, Math.floor(finalScore)));

    // Erstelle detailliertes Ergebnis
    return this.createScoringResult({
      sessionData,
      pageData,
      contentType,
      contentTypeMultiplier,
      baseScore,
      qualityFactor,
      ossBonus,
      finalScore,
      interactionData
    });
  }

  /**
   * v2.0.0: Enhanced Scoring mit Satisfaction Metrics
   */
  scoreSessionWithSatisfaction(sessionData, pageData, satisfactionData) {
    // 1. OSS Data
    const ossData = {
      bonus: this.calculateOSSBonus(pageData, satisfactionData)
    };

    // 2. Use SatisfactionScorer for enhanced scoring
    const scoringResult = this.satisfactionScorer.scoreSessionWithSatisfaction(
      sessionData,
      pageData,
      satisfactionData,
      this.interactionScorer,
      this.qualityAnalyzer,
      this.contentDetector,
      ossData
    );

    // 3. Build full result object with breakdown
    return {
      score: scoringResult.score,
      breakdown: {
        ...scoringResult.breakdown,
        oss: {
          bonus: ossData.bonus,
          multiplier: scoringResult.breakdown.ossMultiplier
        }
      },
      metadata: {
        url: pageData.url,
        domain: this.extractDomain(pageData.url),
        timestamp: sessionData.endTime || new Date().toISOString(),
        sessionId: sessionData.sessionId,
        configVersion: this.config.version
      },
      syncData: {
        score: scoringResult.score,
        timestamp: sessionData.endTime || new Date().toISOString()
      }
    };
  }

  /**
   * Berechnet Open-Source Bonus
   * WICHTIG: Höher gewichtet als andere Faktoren!
   */
  calculateOSSBonus(pageData, additionalData) {
    // Handle null additionalData
    const data = additionalData || {};

    let bonus = 0;

    const url = pageData.url || '';
    const urlLower = url.toLowerCase();

    // GitHub Repository
    if (urlLower.includes('github.com')) {
      bonus += this.config.oss.GITHUB_REPOSITORY;
    }

    // GitLab Repository
    if (urlLower.includes('gitlab.com')) {
      bonus += this.config.oss.GITLAB_REPOSITORY;
    }

    // NPM Package
    if (urlLower.includes('npmjs.com') || urlLower.includes('npm.io')) {
      bonus += this.config.oss.NPM_PACKAGE;
    }

    // OSS Documentation (ReadTheDocs, etc.)
    if (this.isOSSDocumentation(pageData)) {
      bonus += this.config.oss.OSS_DOCUMENTATION;
    }

    // OSS Project Links im Content (aus Content Script)
    if (data.ossLinksCount > 0) {
      bonus += this.config.oss.OSS_PROJECT_LINK;
    }

    // Clamp: Maximal MAX_OSS_BONUS
    return Math.min(bonus, this.config.oss.MAX_OSS_BONUS);
  }

  /**
   * Prüft ob Seite OSS-Documentation ist
   */
  isOSSDocumentation(pageData) {
    const url = pageData.url || '';
    const urlLower = url.toLowerCase();

    const ossDocsDomains = [
      'readthedocs.io',
      'docs.rs',        // Rust docs
      'kotlinlang.org/docs',
      'golang.org/doc',
      'python.org/3/library',
      'developer.mozilla.org' // MDN
    ];

    return ossDocsDomains.some(domain => urlLower.includes(domain));
  }

  /**
   * Erstellt Scoring-Ergebnis Objekt
   */
  createScoringResult(data) {
    const {
      sessionData,
      pageData,
      contentType,
      contentTypeMultiplier,
      baseScore,
      qualityFactor,
      ossBonus,
      finalScore,
      interactionData
    } = data;

    return {
      // Final Score
      score: finalScore,

      // Breakdown für Transparenz
      breakdown: {
        contentType: {
          type: contentType,
          multiplier: contentTypeMultiplier
        },
        interaction: {
          baseScore: baseScore,
          activeTime: this.interactionScorer.getActiveTime(sessionData),
          passiveTime: this.interactionScorer.getPassiveTime(sessionData),
          bonuses: this.extractInteractionBonuses(interactionData)
        },
        quality: {
          factor: qualityFactor,
          trackers: pageData.trackers?.length || 0,
          ads: pageData.ads?.count || 0,
          performance: pageData.performance?.loadTime || 0
        },
        oss: {
          bonus: ossBonus,
          multiplier: 1 + ossBonus
        }
      },

      // Metadata
      metadata: {
        url: pageData.url,
        domain: this.extractDomain(pageData.url),
        timestamp: sessionData.endTime || new Date().toISOString(),
        sessionId: sessionData.sessionId,
        configVersion: this.config.version
      },

      // Für Privacy: Nur Score wird synchronisiert
      syncData: {
        score: finalScore,
        timestamp: sessionData.endTime || new Date().toISOString(),
        // KEINE URL!
      }
    };
  }

  /**
   * Erstellt Ergebnis für ungültige Session
   */
  createInvalidSessionResult(sessionData, pageData = {}) {
    return {
      score: 0,
      breakdown: {
        reason: 'invalid_session',
        contentType: { type: 'UNKNOWN', multiplier: 1.0 },
        interaction: { baseScore: 0 },
        quality: { factor: 1.0 },
        oss: { bonus: 0 }
      },
      metadata: {
        url: pageData.url || sessionData.url || null,
        domain: this.extractDomain(pageData.url || sessionData.url),
        timestamp: sessionData.endTime || new Date().toISOString(),
        sessionId: sessionData.sessionId,
        configVersion: this.config.version
      },
      syncData: {
        score: 0,
        timestamp: sessionData.endTime || new Date().toISOString()
      }
    };
  }

  /**
   * Extrahiert Interaktions-Bonusse für Breakdown
   */
  extractInteractionBonuses(interactionData) {
    return {
      scrolls: interactionData.significantScrolls || 0,
      clicks: interactionData.clicks || 0,
      textCopied: interactionData.textCopied || false,
      codeCopied: interactionData.codeCopied || false,
      downloads: interactionData.downloads || 0,
      bookmarked: interactionData.bookmarked || false,
      shared: interactionData.shared || false,
      repeatVisits: interactionData.visitCount || 1
    };
  }

  /**
   * Extrahiert Domain aus URL
   */
  extractDomain(url) {
    if (!url) return 'unknown';

    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Berechnet Domain-aggregierte Scores
   * (Für spätere Aufteilungs-Logik)
   */
  aggregateScoresByDomain(scoringResults) {
    const domainScores = new Map();

    for (const result of scoringResults) {
      const domain = result.metadata.domain;

      if (!domainScores.has(domain)) {
        domainScores.set(domain, {
          domain: domain,
          totalScore: 0,
          sessionCount: 0,
          firstVisit: result.metadata.timestamp,
          lastVisit: result.metadata.timestamp
        });
      }

      const domainData = domainScores.get(domain);
      domainData.totalScore += result.score;
      domainData.sessionCount += 1;
      domainData.lastVisit = result.metadata.timestamp;
    }

    return Array.from(domainScores.values());
  }
}

// Factory Function für einfache Initialisierung
function createScoringEngine(config) {
  const contentDetector = new window.ContentDetector(config);
  const interactionScorer = new window.InteractionScorer(config);
  const qualityAnalyzer = new window.QualityAnalyzer(config);

  // v2.0.0: Instantiate SatisfactionScorer if available
  const satisfactionScorer = window.SatisfactionScorer
    ? new window.SatisfactionScorer(config)
    : null;

  return new ScoringEngine(
    config,
    contentDetector,
    interactionScorer,
    qualityAnalyzer,
    satisfactionScorer
  );
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.ScoringEngine = ScoringEngine;
  window.createScoringEngine = createScoringEngine;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ScoringEngine,
    createScoringEngine
  };
}
