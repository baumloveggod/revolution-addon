/**
 * Revolution Scoring System - Versionierte Konfiguration
 *
 * KRITISCH: Diese Config ist VERSIONIERT und DETERMINISTISCH
 * Alle Clients müssen identische Config-Version verwenden für konsistente Berechnungen
 *
 * Änderungen erfordern neue Version und Migration-Path
 */

const SCORING_CONFIG_VERSION = '2.0.0';

/**
 * Token-Konstanten (wie im central-ledger)
 */
const TOKENS_PER_EURO = 10n ** 15n; // 1 EUR = 10^15 Tokens
const MONTHLY_BUDGET_EUR = 10n; // 10 EUR pro Monat
const MONTHLY_BUDGET_TOKENS = MONTHLY_BUDGET_EUR * TOKENS_PER_EURO; // 10^16 Tokens

/**
 * Zeitkonstanten (in Millisekunden)
 */
const TIME_CONSTANTS = Object.freeze({
  CALIBRATION_DAYS: 30,              // Tage für initiale Kalibration
  PROGNOSIS_HISTORY_DAYS: 90,        // Sliding window für Prognose
  BATCH_WINDOW_MS: 6 * 60 * 60 * 1000, // 6 Stunden für Transaction-Batching
  SNAPSHOT_INTERVAL_MS: 12 * 60 * 60 * 1000, // 12h für deterministische Snapshots
  SECONDS_PER_DAY: 86400,
  MS_PER_DAY: 86400000
});

/**
 * Content-Typ Multipliers (deterministisch, fixe Werte)
 */
const CONTENT_TYPE_MULTIPLIERS = Object.freeze({
  // Artikel/Text-Content
  ARTICLE: 1.0,
  BLOG_POST: 1.0,
  TUTORIAL: 1.2,        // Tutorials höher gewichtet (Lernwert)
  DOCUMENTATION: 1.15,

  // Media
  VIDEO: 0.9,           // Video weniger gewichtet (passive consumption)
  PODCAST: 0.85,
  IMAGE_GALLERY: 0.6,   // Bilder niedrig (passive viewing)

  // Interaktive Inhalte
  TOOL: 1.3,            // Tools/Apps höher gewichtet
  PLAYGROUND: 1.25,
  INTERACTIVE: 1.2,

  // Code/Open-Source
  CODE_REPOSITORY: 1.4, // Repositories sehr hoch gewichtet
  CODE_SNIPPET: 1.1,

  // Social/Forum
  DISCUSSION: 0.8,
  SOCIAL_FEED: 0.5,     // Social Feeds niedrig (Doomscrolling)

  // Default/Unknown
  UNKNOWN: 1.0
});

/**
 * Interaktions-Gewichtungen (Basis-Punkte)
 */
const INTERACTION_WEIGHTS = Object.freeze({
  // Basis-Zeit (pro Sekunde aktive Zeit)
  ACTIVE_TIME_PER_SECOND: 1.0,
  PASSIVE_TIME_PER_SECOND: 0.3,

  // Explizite Aktionen (additive Bonuspunkte)
  SCROLL_BONUS: 10,           // Pro signifikanten Scroll (>25% Seite)
  CLICK_BONUS: 5,             // Pro Klick auf relevanten Content
  TEXT_SELECTION: 20,         // Text kopiert
  CODE_COPY: 50,              // Code kopiert (extrem wertvoll!)
  DOWNLOAD: 100,              // File-Download
  BOOKMARK: 150,              // Bookmark/Save
  SHARE: 200,                 // Explizites Teilen

  // Wiederholte Besuche (multiplikativ)
  REPEAT_VISIT_MULTIPLIER: 1.1, // +10% pro wiederholtem Besuch (max 5x)
  MAX_REPEAT_BONUS: 5
});

/**
 * Technische Qualitätsfaktoren (multiplikativ, 0.0 - 1.0+)
 */
const QUALITY_FACTORS = Object.freeze({
  // Tracker Penalty
  TRACKER_PENALTY_PER_TRACKER: 0.05, // -5% pro Tracker
  MAX_TRACKER_PENALTY: 0.5,          // Maximal -50%

  // Performance
  FAST_LOAD_BONUS: 0.1,              // +10% für <1s Ladezeit
  SLOW_LOAD_PENALTY: 0.1,            // -10% für >5s Ladezeit

  // Accessibility
  ACCESSIBILITY_BONUS: 0.05,         // +5% für gute a11y

  // Ads
  AD_PENALTY_PER_AD: 0.02,           // -2% pro Ad
  MAX_AD_PENALTY: 0.3,               // Maximal -30%
  EXCESSIVE_ADS_THRESHOLD: 5,        // >5 Ads = aggressive

  // Cookie Banner
  AGGRESSIVE_COOKIE_BANNER_PENALTY: 0.1 // -10% für aggressive Banners
});

/**
 * Open-Source Bonus (multiplikativ)
 * WICHTIG: Höher als andere Faktoren!
 */
const OSS_BONUS = Object.freeze({
  GITHUB_REPOSITORY: 0.3,      // +30% für GitHub Repos
  GITLAB_REPOSITORY: 0.3,      // +30% für GitLab Repos
  NPM_PACKAGE: 0.25,           // +25% für NPM Packages
  OSS_DOCUMENTATION: 0.2,      // +20% für OSS Docs
  OSS_PROJECT_LINK: 0.15,      // +15% für Links zu OSS

  MAX_OSS_BONUS: 0.5           // Maximal +50% (kumulativ)
});

/**
 * Satisfaction Weights (NEU in v2.0.0)
 * Gewichtungen für Nutzerzufriedenheits-Indikatoren
 */
const SATISFACTION_WEIGHTS = Object.freeze({
  // Reading Behavior
  SMOOTH_SCROLL_BONUS: 50,      // Bonus für fokussiertes Lesen
  CONTENT_DEPTH_BONUS: 30,      // Bonus für Content-Exploration
  BACKTRACK_BONUS: 10,          // Bonus pro Rückscrollen (max 5x)
  MAX_BACKTRACK_COUNT: 5,

  // Attention Quality
  ACTIVE_PCT_WEIGHT: 0.4,       // Gewichtung für Active Time %
  FOCUS_PCT_WEIGHT: 0.4,        // Gewichtung für Focus Persistence
  MOUSE_ENGAGEMENT_WEIGHT: 0.2, // Gewichtung für Mouse Coverage

  // Frustration Penalties
  RAGE_CLICK_PENALTY: 10,       // Penalty pro Rage Click
  DEAD_CLICK_PENALTY: 5,        // Penalty pro Dead Click
  ERROR_PENALTY: 15,            // Penalty pro Error
  TAB_THRASH_PENALTY: 3,        // Penalty pro Tab Thrash
  MAX_FRUSTRATION_PENALTY: 0.3, // Maximal -30% Experience Factor

  // Explicit Rating Bonuses
  RATING_BONUSES: Object.freeze({
    1: -500,  // 1 Stern / Dislike / Downvote
    2: -200,  // 2 Sterne
    3: 0,     // 3 Sterne (neutral)
    4: 500,   // 4 Sterne
    5: 1000   // 5 Sterne / Like / Upvote / Star
  }),

  // Pattern Detection Bonuses
  FLOW_STATE_BONUS: 200,        // Bonus für Flow State (>5min, <10% passiv)
  UTILITY_BONUS: 100,           // Bonus für Utility Pattern (30s-5min, gefunden)

  // Flow State Thresholds
  FLOW_STATE_MIN_TIME: 300,           // 5 Minuten in Sekunden
  FLOW_STATE_MAX_PASSIVE_RATIO: 0.1,  // Max 10% passive Zeit
  FLOW_STATE_MIN_INTERACTION_DENSITY: 3, // Min 3 Interaktionen/Minute

  // Utility Pattern Thresholds
  UTILITY_MIN_TIME: 30,         // 30 Sekunden
  UTILITY_MAX_TIME: 300,        // 5 Minuten
  UTILITY_MIN_SCROLL_DEPTH: 0.25, // Min 25% Scroll-Tiefe
  BOUNCE_THRESHOLD: 10          // < 10s = Bounce
});

/**
 * E48-Reihe für Betrags-Standardisierung (Privacy)
 * Elektronik-Standard: ~5% Abstand zwischen Werten (48 Werte pro Dekade)
 *
 * WICHTIG: E48 statt E24 für höhere Präzision bei Nachzahlungen
 * - E24 = ~10% Schritte (zu grob)
 * - E48 = ~5% Schritte (ideal für 5%-Regel nach Tag 30)
 */
const E48_SERIES = Object.freeze([
  1.00, 1.05, 1.10, 1.15, 1.21, 1.27, 1.33, 1.40,
  1.47, 1.54, 1.62, 1.69, 1.78, 1.87, 1.96, 2.05,
  2.15, 2.26, 2.37, 2.49, 2.61, 2.74, 2.87, 3.01,
  3.16, 3.32, 3.48, 3.65, 3.83, 4.02, 4.22, 4.42,
  4.64, 4.87, 5.11, 5.36, 5.62, 5.90, 6.19, 6.49,
  6.81, 7.15, 7.50, 7.87, 8.25, 8.66, 9.09, 9.53, 10.0
]);

// Legacy compatibility (falls alter Code noch E24_SERIES verwendet)
const E24_SERIES = E48_SERIES;

/**
 * Prognose-Modell Gewichte (deterministisch!)
 * Gewichteter Durchschnitt der letzten 4 Wochen
 */
const PROGNOSIS_WEIGHTS = Object.freeze({
  WEEK_1_LATEST: 0.5,   // 50% Gewichtung für letzte Woche
  WEEK_2: 0.3,          // 30% für vorletzte Woche
  WEEK_3: 0.15,         // 15% für 3 Wochen zurück
  WEEK_4: 0.05          // 5% für 4 Wochen zurück
});

/**
 * Konservativitätsfaktor für Live-Auszahlungen
 * Linear: Tag 0 → 0%, Tag 90 → 98%
 */
const CONSERVATIVITY_CONFIG = Object.freeze({
  MIN_DAYS: 0,           // Start
  MAX_DAYS: 90,          // Volle Prognose-Genauigkeit
  MIN_FACTOR: 0.00,      // 0% am Tag 0 (keine Auszahlung ohne Daten!)
  MAX_FACTOR: 0.98,      // 98% ab Tag 90 (2% Puffer)

  // Linear interpolation: factor = (MAX_FACTOR / MAX_DAYS) * days
  SLOPE: 0.98 / 90       // ~0.0109 pro Tag
});

/**
 * Snapshot-Zeitpunkte (UTC) für deterministische Updates
 * Alle Clients müssen zu identischen Zeiten aktualisieren
 */
const SNAPSHOT_TIMES_UTC = Object.freeze([
  { hour: 0, minute: 0 },   // 00:00 UTC (Mitternacht)
  { hour: 12, minute: 0 }   // 12:00 UTC (Mittag)
]);

/**
 * Score-Normalisierung (Basis-Punkte)
 */
const SCORE_NORMALIZATION = Object.freeze({
  MIN_SCORE: 0,
  MAX_SCORE: 10000,         // Maximum 10.000 Basis-Punkte
  DEFAULT_SCORE: 0
});

/**
 * Export gesamte Config als immutable Object
 */
const CONFIG = Object.freeze({
  version: SCORING_CONFIG_VERSION,

  tokens: {
    TOKENS_PER_EURO,
    MONTHLY_BUDGET_EUR,
    MONTHLY_BUDGET_TOKENS
  },

  time: TIME_CONSTANTS,
  contentTypes: CONTENT_TYPE_MULTIPLIERS,
  interactions: INTERACTION_WEIGHTS,
  quality: QUALITY_FACTORS,
  oss: OSS_BONUS,
  satisfaction: SATISFACTION_WEIGHTS, // NEU in v2.0.0
  e24: E24_SERIES,  // Legacy compatibility (jetzt E48)
  e48: E48_SERIES,  // Aktuelle Reihe (~5% Schritte)
  prognosis: PROGNOSIS_WEIGHTS,
  conservativity: CONSERVATIVITY_CONFIG,
  snapshots: SNAPSHOT_TIMES_UTC,
  scores: SCORE_NORMALIZATION
});

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.ScoringConfig = CONFIG;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
