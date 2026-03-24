/**
 * Revolution Scoring System - Main Integration
 *
 * Bindet alle Komponenten zusammen:
 * - Scoring Engine
 * - Distribution Engine
 * - Privacy Layer
 * - NGO System
 *
 * Usage:
 * const revolution = new RevolutionScoring(config);
 * await revolution.initialize();
 * const result = await revolution.processSession(sessionData, pageData);
 */

class RevolutionScoring {
  constructor(config = window.ScoringConfig) {
    this.config = config;
    this.initialized = false;

    // Komponenten (werden in initialize() erstellt)
    this.scoringEngine = null;
    this.prognosisModel = null;
    this.calibrationManager = null;
    this.distributionEngine = null;
    this.privacyLayer = null;
    this.criteriaMatcher = null;
    this.orWalletManager = null;
  }

  /**
   * Initialisiert alle Komponenten
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    // 1. Scoring Engine
    this.scoringEngine = window.createScoringEngine(this.config);

    // 2. Prognosis Model
    this.prognosisModel = new window.PrognosisModel(this.config);

    // 3. Calibration Manager
    this.calibrationManager = new window.CalibrationManager(
      this.config,
      this.prognosisModel
    );

    // 4. Privacy Layer
    this.privacyLayer = window.createPrivacyLayer(this.config);

    // 5. NGO System
    this.criteriaMatcher = new window.CriteriaMatcher(this.config);
    this.orWalletManager = new window.ORWalletManager(
      this.config,
      this.criteriaMatcher
    );

    // 6. Distribution Engine
    this.distributionEngine = new window.DistributionEngine(
      this.config,
      this.prognosisModel,
      this.calibrationManager,
      this.privacyLayer
    );

    // CRITICAL: Make DistributionEngine available globally for TransactionQueue re-resolution
    window._distributionEngine = this.distributionEngine;

    // 7. Load State from Storage
    await this.loadState();

    // 8. Setup Transaction Executor
    this.setupTransactionExecutor();

    this.initialized = true;
  }

  /**
   * Verarbeitet neue Session (Haupt-Entry-Point)
   */
  async processSession(sessionData, pageData, additionalData = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // 1. Score berechnen
    const scoringResult = this.scoringEngine.scoreSession(
      sessionData,
      pageData,
      additionalData
    );

    // 1b. Apply per-domain feedback preference (if any)
    const domain = scoringResult.metadata && scoringResult.metadata.domain;
    if (domain && scoringResult.score > 0) {
      try {
        // Use browser.storage.local directly here (firefox-addon context).
        // When extracted to the core module, replace with StorageAdapter.get().
        const stored = await browser.storage.local.get('domain_preferences');
        const prefs = stored['domain_preferences'] || {};
        if (prefs[domain]) {
          const factor = prefs[domain].adjustmentFactor;
          const adjusted = Math.max(0, Math.min(this.scoringEngine.config.scores.MAX_SCORE,
            Math.floor(scoringResult.score * factor)));
          scoringResult.breakdown = scoringResult.breakdown || {};
          scoringResult.breakdown.domainPreference = {
            domain,
            adjustmentFactor: factor,
            feedbackCount: prefs[domain].feedbackCount,
            applied: true,
          };
          scoringResult.score = adjusted;
        }
      } catch (_) {
        // Non-critical: proceed without domain adjustment
      }
    }

    // 2. Speichere Score historisch
    await this.saveHistoricalScore(scoringResult);

    // 3. KRITISCH: Prüfe ob BA→CL Transfer existiert
    // - Kein Transfer: Rating verwerfen (return null)
    // - CL nicht erreichbar: Rating pausieren (throw error für retry)
    const walletManager = window._walletManager; // Global verfügbar
    const translationFactorTracker = this.distributionEngine.translationFactorTracker;

    if (translationFactorTracker && walletManager) {
      const transferCheck = await translationFactorTracker.checkBaToCLTransferExists(walletManager);

      if (!transferCheck.exists) {
        if (transferCheck.shouldPause) {
          // Central Ledger nicht erreichbar → Rating pausieren
          console.error('[RevolutionScoring] ⏸️ Rating paused - Central Ledger not reachable:', transferCheck.error);
          throw new Error(`Rating paused: ${transferCheck.error}`);
        } else if (transferCheck.error && transferCheck.error.includes('not initialized')) {
          // Wallet noch nicht bereit (ADDRESS_UPDATE ausstehend) → Rating überspringen, nicht verwerfen
          console.warn('[RevolutionScoring] ⏳ Wallet not ready yet, skipping rating entirely');
          return null;
        } else {
          // Kein BA→CL Transfer gefunden → Rating verwerfen
          console.warn('[RevolutionScoring] ❌ Rating discarded - No BA→CL transfer found yet');
          console.warn('[RevolutionScoring] User must wait for first BA interval transfer before ratings are created');
          return null;
        }
      }

    } else {
      console.warn('[RevolutionScoring] ⚠️ Cannot check BA→CL transfer - WalletManager or TranslationFactorTracker not available');
    }

    // 4. Generiere IMMER ratingRef und Fingerprint-Seeds (auch wenn Transaktionen vorhanden sind)
    // CRITICAL: Seeds müssen VOR Distribution generiert werden, damit sie in Transaktionen verfügbar sind
    const ratingRef = `rating-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });
    const seedObj = await seedManager.generateRatingSeeds(
      ratingRef,
      scoringResult.metadata.domain,
      scoringResult.metadata.url
    );

    // Füge Seeds zu metadata hinzu (verfügbar für Transaktionen)
    scoringResult.metadata.ratingRef = ratingRef;
    scoringResult.metadata.seedCLtoSH = seedObj.seedCLtoSH;
    scoringResult.metadata.seedSHtoDS = seedObj.seedSHtoDS;

    // 5. Distribution berechnen
    const userData = await this.distributionEngine.getUserData();
    const distributionResult = await this.distributionEngine.processSession(
      scoringResult,
      userData
    );

    // 6. Verwerfe Ratings mit Score 0 oder ohne Tokens (vor BA→CL Contract-Aktivierung)
    const hasValidScore = scoringResult.score > 0;
    const hasValidTokens = distributionResult.tokens && BigInt(distributionResult.tokens) > 0n;
    const hasValidPayoutFactor = distributionResult.metadata?.payoutFactor > 0.01; // payoutFactor > 1%

    if (!hasValidScore || !hasValidTokens || !hasValidPayoutFactor) {
      console.warn('[RevolutionScoring] ❌ Rating discarded - Invalid score, tokens, or payout factor:', {
        score: scoringResult.score,
        tokens: distributionResult.tokens?.toString() || '0',
        payoutFactor: distributionResult.metadata?.payoutFactor,
        daysSinceStart: distributionResult.metadata?.daysSinceStart,
        reason: !hasValidScore ? 'score_zero' : !hasValidTokens ? 'tokens_zero' : 'payout_factor_too_low'
      });
      return null; // Rating verwerfen
    }

    // 7. Wenn KEINE Transaktionen: Sende Rating direkt
    // Mit Transaktionen: Rating wird automatisch über TransactionQueue.sendRatingMessage gesendet
    if (distributionResult.transactions.length === 0) {
      // Keine Transaktion -> Sende Rating direkt
      await this.sendRatingWithoutTransaction(scoringResult, distributionResult);
    }

    return {
      scoring: scoringResult,
      distribution: distributionResult
    };
  }

  /**
   * Setup Transaction Executor (verbindet mit central-ledger)
   */
  setupTransactionExecutor() {
    this.privacyLayer.setTransactionExecutor(async (transaction) => {
      await this.executeTransaction(transaction);
    });
  }

  /**
   * Führt Transaktion aus (sendet Bewertungsdaten verschlüsselt an Website)
   */
  async executeTransaction(transaction) {
    try {
      // Sende Bewertungsdaten verschlüsselt über Messaging-Client an Website
      await this.sendRatingToWebsite(transaction);

      // Tracking: Speichere bezahlte Beträge
      await this.distributionEngine.savePaidAmount(
        transaction.domain,
        transaction.tokens
      );
    } catch (error) {
      console.error('[RevolutionScoring] Failed to send transaction rating:', error);
      throw error;
    }
  }

  /**
   * Sendet Bewertungsdaten verschlüsselt über Messaging-Client an Website
   */
  async sendRatingToWebsite(transaction) {
    // Hole Messaging-Client
    const messagingClient = window.MessagingIntegration?.getClient();

    if (!messagingClient) {
      console.warn('[RevolutionScoring] Messaging client not available, skipping rating transmission');
      return;
    }

    // Generiere eindeutige Transaction-Referenz
    const transactionRef = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    // Hole vollständige Scoring & Distribution Daten (falls verfügbar)
    const scoringResult = transaction._scoringResult || {};
    const distributionMetadata = transaction._distributionMetadata || {};

    // Erstelle Bewertungsdaten-Payload
    // DEVELOPMENT MODE: Sende ALLE Daten inkl. privater Details für Testing
    const ratingPayload = {
      transaction_ref: transactionRef,
      wallet_address: transaction.walletAddress, // On-Chain Ziel-Adresse
      domain: transaction.domain, // Für Analytics/Logging
      tokens: transaction.tokens.toString(),
      score: transaction.score,
      type: transaction.type,

      // === SCORING BREAKDOWN (Gewichte) ===
      breakdown: {
        // Content-Typ Multiplikator
        contentType: {
          type: scoringResult.breakdown?.contentType?.type || 'UNKNOWN',
          multiplier: scoringResult.breakdown?.contentType?.multiplier || 1.0
        },
        // Interaktions-Scoring
        interaction: {
          baseScore: scoringResult.breakdown?.interaction?.baseScore || 0,
          activeTime: scoringResult.breakdown?.interaction?.activeTime || 0,
          passiveTime: scoringResult.breakdown?.interaction?.passiveTime || 0,
          bonuses: scoringResult.breakdown?.interaction?.bonuses || {}
        },
        // Qualitäts-Faktor
        quality: {
          factor: scoringResult.breakdown?.quality?.factor || 1.0,
          trackers: scoringResult.breakdown?.quality?.trackers || 0,
          ads: scoringResult.breakdown?.quality?.ads || 0,
          performance: scoringResult.breakdown?.quality?.performance || 0
        },
        // Open-Source Bonus
        oss: {
          bonus: scoringResult.breakdown?.oss?.bonus || 0,
          multiplier: scoringResult.breakdown?.oss?.multiplier || 1.0
        }
      },

      // === TOKEN DISTRIBUTION DETAILS ===
      distribution: {
        rawTokens: distributionMetadata.rawTokens || transaction.rawTokens?.toString() || '0',
        payoutTokens: distributionMetadata.payoutTokens || transaction.tokens.toString(),
        bufferedTokens: distributionMetadata.bufferedTokens || transaction.bufferedTokens?.toString() || '0',
        standardizedTokens: distributionMetadata.standardizedTokens || transaction.tokens.toString(),
        safetyFactor: distributionMetadata.safetyFactor || transaction.safetyFactor || 1.0,
        payoutFactor: distributionMetadata.payoutFactor || transaction.payoutFactor || 0.0,
        daysSinceStart: distributionMetadata.daysSinceStart || transaction.daysSinceStart || 0,

        // Prognose-Daten
        prognosis: distributionMetadata.prognosis || null,
        totalDaysTracked: distributionMetadata.totalDaysTracked || 0,
        currentDayOfMonth: distributionMetadata.currentDayOfMonth || 0
      },

      // === LEGACY FIELDS (für Backwards Compatibility) ===
      factor: transaction.factor || null,
      watch_seconds: transaction.watchSeconds || null,
      ad_seconds: transaction.adSeconds || null,
      interactions: transaction.interactions || null,
      token_amount: transaction.tokens.toString(),
      payout_tokens: transaction.tokens.toString(),
      buffered_tokens: transaction.bufferedTokens?.toString() || '0',
      safety_factor: transaction.safetyFactor || 1.0,
      payout_factor: transaction.payoutFactor || 0.0,
      days_since_start: transaction.daysSinceStart || 0,
      normalized_compensation: transaction.normalizedCompensation || null,
      buffer_rate: transaction.bufferRate || null,
      pacing_rate: transaction.pacingRate || null,
      deviation: transaction.deviation || null,
      backpay: transaction.backpay || null,
      raw_weight: transaction.rawWeight || null,
      website_visits: transaction.websiteVisits || null,
      payout_calculation: transaction.payoutCalculation || null,
      splits: transaction.splits || null,

      // === METADATA ===
      metadata: {
        url: scoringResult.metadata?.url || null,
        sessionId: scoringResult.metadata?.sessionId || null,
        timestamp: scoringResult.metadata?.timestamp || new Date().toISOString(),
        configVersion: scoringResult.metadata?.configVersion || null
      },

      // === FULL OBJECTS (für Deep Inspection) ===
      _debug: {
        fullScoringResult: scoringResult,
        fullDistributionMetadata: distributionMetadata,
        fullTransaction: transaction
      },

      // Metadaten
      occurred_at: new Date().toISOString(),
      calibration_day: this.distributionEngine?.getCalibrationDay?.() || 0
    };

    // Konvertiere alle BigInt-Werte zu Strings für JSON-Serialisierung
    const serializedPayload = this.convertBigIntsToStrings(ratingPayload);

    // Sende verschlüsselte Nachricht an Website (type: 'rating' für rating messages)
    await messagingClient.sendMessage(serializedPayload, 'rating');
  }

  /**
   * Konvertiert BigInt-Werte zu Strings für JSON-Serialisierung
   */
  convertBigIntsToStrings(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.convertBigIntsToStrings(item));
    }

    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.convertBigIntsToStrings(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Sendet Bewertungsdaten OHNE Transaktion (wenn payoutFactor = 0 oder tokens = 0)
   */
  async sendRatingWithoutTransaction(scoringResult, distributionResult) {
    const messagingClient = window.MessagingIntegration?.getClient();

    if (!messagingClient) {
      console.error('[RevolutionScoring] ❌ Messaging client not available, cannot send rating!');
      console.error('[RevolutionScoring] MessagingIntegration:', typeof window.MessagingIntegration);
      console.error('[RevolutionScoring] getClient:', typeof window.MessagingIntegration?.getClient);

      // Debug logging
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.error('messaging_client_unavailable', 'Messaging client not available for rating', {
          domain: scoringResult.metadata.domain,
          score: scoringResult.score,
          hasMessagingIntegration: typeof window.MessagingIntegration !== 'undefined',
          hasGetClient: typeof window.MessagingIntegration?.getClient === 'function'
        });
      }
      return;
    }

    // Verwende existierende ratingRef und Seeds (wurden bereits in processSession generiert)
    const ratingRef = scoringResult.metadata.ratingRef;
    const seedCLtoSH = scoringResult.metadata.seedCLtoSH;
    const seedSHtoDS = scoringResult.metadata.seedSHtoDS;

    if (!ratingRef || !seedCLtoSH || !seedSHtoDS) {
      console.error('[RevolutionScoring] ❌ Missing ratingRef or seeds in metadata!');
      return;
    }

    // Hole Wallet-Adresse für die Domain (auch bei Zero-Token)
    const domain = scoringResult.metadata.domain;
    let walletAddress = null;
    try {
      walletAddress = await this.distributionEngine.getWalletAddressForDomain(domain);
    } catch (error) {
      console.error('[RevolutionScoring] Failed to fetch wallet address:', error.message);
      // Continue with null - non-blocking error
    }

    // Erstelle Bewertungsdaten (ohne Transaktion, aber mit berechneten Tokens)
    // DEVELOPMENT MODE: Sende ALLE Daten inkl. privater Details für Testing
    const ratingPayload = {
      transaction_ref: ratingRef,
      domain: scoringResult.metadata.domain,
      score: scoringResult.score,
      type: 'rating',

      // === SCORING BREAKDOWN (Gewichte) ===
      breakdown: {
        // Content-Typ Multiplikator
        contentType: {
          type: scoringResult.breakdown?.contentType?.type || 'UNKNOWN',
          multiplier: scoringResult.breakdown?.contentType?.multiplier || 1.0
        },
        // Interaktions-Scoring
        interaction: {
          baseScore: scoringResult.breakdown?.interaction?.baseScore || 0,
          activeTime: scoringResult.breakdown?.interaction?.activeTime || 0,
          passiveTime: scoringResult.breakdown?.interaction?.passiveTime || 0,
          bonuses: scoringResult.breakdown?.interaction?.bonuses || {}
        },
        // Qualitäts-Faktor
        quality: {
          factor: scoringResult.breakdown?.quality?.factor || 1.0,
          trackers: scoringResult.breakdown?.quality?.trackers || 0,
          ads: scoringResult.breakdown?.quality?.ads || 0,
          performance: scoringResult.breakdown?.quality?.performance || 0
        },
        // Open-Source Bonus
        oss: {
          bonus: scoringResult.breakdown?.oss?.bonus || 0,
          multiplier: scoringResult.breakdown?.oss?.multiplier || 1.0
        }
      },

      // === TOKEN DISTRIBUTION DETAILS ===
      distribution: {
        rawTokens: distributionResult.metadata?.rawTokens || '0',
        payoutTokens: distributionResult.metadata?.payoutTokens || '0',
        bufferedTokens: distributionResult.metadata?.bufferedTokens || '0',
        standardizedTokens: distributionResult.metadata?.standardizedTokens || '0',
        safetyFactor: distributionResult.metadata?.safetyFactor || 1.0,
        payoutFactor: distributionResult.metadata?.payoutFactor || 0.0,
        daysSinceStart: distributionResult.metadata?.daysSinceStart || 0,

        // Prognose-Daten
        prognosis: distributionResult.metadata?.prognosis || null,
        totalDaysTracked: distributionResult.metadata?.totalDaysTracked || 0,
        currentDayOfMonth: distributionResult.metadata?.currentDayOfMonth || 0
      },

      // === LEGACY FIELDS (für Backwards Compatibility) ===
      factor: scoringResult.factor || null,
      watch_seconds: scoringResult.watchSeconds || null,
      ad_seconds: scoringResult.adSeconds || null,
      interactions: scoringResult.interactions || null,
      tokens: distributionResult.metadata?.rawTokens || '0',
      token_amount: distributionResult.metadata?.payoutTokens || '0',
      payout_tokens: distributionResult.metadata?.payoutTokens || '0',
      buffered_tokens: distributionResult.metadata?.bufferedTokens || '0',
      wallet_address: walletAddress, // Flow-tagged format (DS::0x... or OR::0x...)
      safety_factor: distributionResult.metadata?.safetyFactor || 1.0,
      payout_factor: distributionResult.metadata?.payoutFactor || 0.0,
      days_since_start: distributionResult.metadata?.daysSinceStart || 0,

      // === METADATA ===
      metadata: {
        url: scoringResult.metadata?.url || null,
        sessionId: scoringResult.metadata?.sessionId || null,
        timestamp: scoringResult.metadata?.timestamp || new Date().toISOString(),
        configVersion: scoringResult.metadata?.configVersion || null
      },

      // === FINGERPRINT SEEDS (für Transaktion-Tracking) ===
      seedCLtoSH: seedCLtoSH,
      seedSHtoDS: seedSHtoDS,

      // === FULL OBJECTS (für Deep Inspection) ===
      _debug: {
        fullScoringResult: scoringResult,
        fullDistributionResult: distributionResult
      },

      // Metadaten
      occurred_at: new Date().toISOString()
    };

    // Debug logging
    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.info('rating_prepare', 'Preparing RATING message (no transaction)', {
        ratingRef,
        domain: scoringResult.metadata.domain,
        score: scoringResult.score,
        safetyFactor: distributionResult.metadata?.safetyFactor,
        payoutFactor: distributionResult.metadata?.payoutFactor
      });
    }

    try {
      // Konvertiere alle BigInt-Werte zu Strings für JSON-Serialisierung
      const serializedPayload = this.convertBigIntsToStrings(ratingPayload);

      await messagingClient.sendMessage(serializedPayload, 'rating');

      // Debug logging - SUCCESS
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.success('rating_sent', 'RATING message sent successfully', {
          ratingRef,
          domain: scoringResult.metadata.domain,
          score: scoringResult.score
        });
      }
    } catch (error) {
      console.error('[RevolutionScoring] Failed to send rating:', error);

      // Debug logging - ERROR
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.error('rating_send_failed', 'Failed to send RATING message', {
          error: error.message,
          ratingRef,
          domain: scoringResult.metadata.domain
        });
      }
    }
  }

  /**
   * Speichert Score historisch
   */
  async saveHistoricalScore(scoringResult) {
    const storage = browser.storage.local;
    const data = await storage.get(['rev_historical_scores']);
    const scores = data.rev_historical_scores || [];

    scores.push({
      score: scoringResult.score,
      domain: scoringResult.metadata.domain,
      timestamp: scoringResult.metadata.timestamp,
      sessionId: scoringResult.metadata.sessionId
    });

    // Behalte nur letzte 90 Tage
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    const recentScores = scores.filter(s =>
      new Date(s.timestamp).getTime() > ninetyDaysAgo
    );

    await storage.set({
      rev_historical_scores: recentScores
    });
  }

  /**
   * Lädt State aus Storage
   */
  async loadState() {
    await this.privacyLayer.loadState();
    await this.criteriaMatcher.loadCriteriaDatabase();
    await this.orWalletManager.loadWallets();

  }

  /**
   * Speichert State in Storage
   */
  async saveState() {
    await this.privacyLayer.saveState();
    await this.criteriaMatcher.saveCriteriaDatabase();
    await this.orWalletManager.saveWallets();

  }

  /**
   * Führt Kalibrations-Settlement aus (Tag 30)
   */
  async executeCalibrationSettlement() {
    const storage = browser.storage.local;
    const data = await storage.get(['rev_historical_scores']);
    const calibrationScores = data.rev_historical_scores || [];

    const userPreferences = []; // TODO: Load from user settings

    const result = await this.distributionEngine.executeCalibrationSettlement(
      calibrationScores,
      userPreferences
    );

    // Speichere Ergebnis
    await this.calibrationManager.saveCalibrationResult(result);

    return result;
  }

  /**
   * Führt Monatsende-Korrektur aus
   */
  async executeMonthEndSettlement() {
    const storage = browser.storage.local;
    const data = await storage.get([
      'rev_historical_scores',
      'rev_paid_amounts'
    ]);

    const monthData = {
      scores: data.rev_historical_scores || [],
      paidAmounts: data.rev_paid_amounts || {}
    };

    const userPreferences = []; // TODO: Load from user settings

    const result = await this.distributionEngine.executeMonthEndSettlement(
      monthData,
      userPreferences
    );

    return result;
  }

  /**
   * Holt Status-Informationen
   */
  async getStatus() {
    const storage = browser.storage.local;
    const data = await storage.get([
      'rev_first_tracking_date',
      'rev_historical_scores',
      'rev_calibration_completed'
    ]);

    const firstTrackingDate = data.rev_first_tracking_date
      ? new Date(data.rev_first_tracking_date)
      : null;

    const calibrationStatus = firstTrackingDate
      ? this.calibrationManager.getCalibrationStatus(firstTrackingDate)
      : null;

    const privacyStats = this.privacyLayer.getPrivacyStatistics();
    const orStats = this.orWalletManager.getStatistics();

    return {
      initialized: this.initialized,
      calibration: calibrationStatus,
      historicalScoresCount: (data.rev_historical_scores || []).length,
      privacy: privacyStats,
      orWallets: orStats,
      configVersion: this.config.version
    };
  }
}

// Global Instance
let revolutionScoring = null;

// Factory Function
function getRevolutionScoring() {
  if (!revolutionScoring) {
    revolutionScoring = new RevolutionScoring();
  }
  return revolutionScoring;
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.RevolutionScoring = RevolutionScoring;
  window.getRevolutionScoring = getRevolutionScoring;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RevolutionScoring,
    getRevolutionScoring
  };
}
