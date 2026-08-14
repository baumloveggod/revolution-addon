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

    // 6. Entity Resolver & Translation Factor Tracker
    this.entityResolver = new window.EntityResolver();
    this.translationFactorTracker = new window.TranslationFactorTracker(browser.storage.local);

    // 7. Distribution Engine
    this.distributionEngine = new window.DistributionEngine(
      this.config,
      this.prognosisModel,
      this.calibrationManager,
      this.privacyLayer,
      this.entityResolver,
      this.translationFactorTracker,
      null,  // fluctuationSF
      browser.storage.local
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

    // 1. Score berechnen.
    //    Primary source: DSL signal system (page_visit signal via n8n webhook).
    //    Fallback source: local watchtime formula, computed entirely from
    //    client-side active/passive time tracking (tracking.js), with no
    //    dependency on the DSL grammar/injection/n8n system. This keeps
    //    ratings flowing while the DSL device webhook is intentionally
    //    offline (AMO review compliance — see background.js DSL section).
    //    When DSL comes back online, sessionData.dslScore.score > 0 becomes
    //    true again and the primary branch below takes over automatically;
    //    no flag or toggle is needed to switch back.
    let scoringResult;
    if (sessionData.dslScore && sessionData.dslScore.score > 0) {
      scoringResult = {
        score: sessionData.dslScore.score,
        breakdown: sessionData.dslScore.breakdown,
        metadata: {
          domain: sessionData.domain,
          pageUrl: sessionData.url || sessionData.pageUrl || null,
          source: 'dsl',
        },
      };
    } else {
      // v1 fallback: score = watchtime * per-second weight, clamped to
      // [0, MAX_SCORE]. Reuses the same weight constants and clamping
      // pattern already applied to domain/user-preference adjustments
      // below (lines 148-149, 194-197), rather than hardcoding new values.
      // This is intentionally minimal — no content-type multiplier, no
      // quality analyzer, no interaction bonuses (scroll/click/share/etc).
      // A fuller v2 could route through ScoringEngine.scoreSession()
      // (vendor/revolution-client/scoring-engine.js), which already
      // implements those, but that is out of scope for this fallback and
      // should be wired in separately.
      const activeSeconds = sessionData.metrics?.activeTime?.valueSeconds || 0;
      const passiveSeconds = sessionData.metrics?.passiveTime?.valueSeconds || 0;
      const activeWeight = this.scoringEngine.config.interactions.ACTIVE_TIME_PER_SECOND;
      const passiveWeight = this.scoringEngine.config.interactions.PASSIVE_TIME_PER_SECOND;
      const rawScore = activeSeconds * activeWeight + passiveSeconds * passiveWeight;
      const watchtimeScore = Math.max(0, Math.min(
        this.scoringEngine.config.scores.MAX_SCORE,
        Math.floor(rawScore)
      ));

      console.log('[RevolutionScoring] No DSL score — using local watchtime fallback. Domain:', sessionData.domain);
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.info('watchtime_fallback_score', 'DSL score unavailable — scored via local watchtime fallback', {
          domain: sessionData.domain,
          activeSeconds,
          passiveSeconds,
          score: watchtimeScore,
        });
      }

      scoringResult = {
        score: watchtimeScore,
        breakdown: {
          formula: 'watchtime',
          activeSeconds,
          passiveSeconds,
          activeWeight,
          passiveWeight,
        },
        metadata: {
          domain: sessionData.domain,
          pageUrl: sessionData.url || sessionData.pageUrl || null,
          source: 'local-watchtime',
        },
      };
    }

    // v2: stash the per-recipient DSL distribution on the scoring metadata so
    // the downstream payload builders (sendRatingToWebsite,
    // sendRatingWithoutTransaction) can lift it into `distribution.beneficiaries[]`.
    // This is the addon's encrypted, full per-entity contribution list — the
    // existing content_creator/addon/platform split below is independent and
    // continues to feed the deterministic on-chain payout.
    if (sessionData.dslDistribution) {
      scoringResult.metadata = scoringResult.metadata || {};
      scoringResult.metadata.dslDistribution = sessionData.dslDistribution;
    }
    if (sessionData.dslSignals) {
      scoringResult.metadata = scoringResult.metadata || {};
      scoringResult.metadata.dslSignals = sessionData.dslSignals;
    }

    // 1b. Apply per-domain feedback preference (if any)
    const domain = scoringResult.metadata && scoringResult.metadata.domain;
    if (domain && scoringResult.score > 0) {
      try {
        // Use browser.storage.local directly here (firefox-addon context).
        // When extracted to the core module, replace with StorageAdapter.get().
        const stored = await browser.storage.local.get('domain_preferences');
        const prefs = stored['domain_preferences'] || {};
        scoringResult.breakdown = scoringResult.breakdown || {};
        if (prefs[domain]) {
          const factor = prefs[domain].adjustmentFactor;
          const adjusted = Math.max(0, Math.min(this.scoringEngine.config.scores.MAX_SCORE,
            Math.floor(scoringResult.score * factor)));
          scoringResult.breakdown.domainPreference = {
            domain,
            adjustmentFactor: factor,
            feedbackCount: prefs[domain].feedbackCount,
            totalAdjustment: prefs[domain].totalAdjustment || 0,
            lastUpdated: prefs[domain].lastUpdated || null,
            applied: true,
          };
          scoringResult.score = adjusted;
        } else {
          scoringResult.breakdown.domainPreference = { domain, applied: false };
        }
      } catch (_) {
        // Non-critical: proceed without domain adjustment
      }
    }

    // 1c. Apply user rating preferences from website settings sync
    if (domain && scoringResult.score > 0) {
      try {
        const prefStored = await browser.storage.local.get('rev_user_preferences');
        const userPrefs = prefStored.rev_user_preferences;
        if (userPrefs) {
          let prefMultiplier = 1.0;
          const breakdown = scoringResult.breakdown || {};

          // Content-Type multiplier from user preferences
          if (userPrefs.contentTypeMultipliers && breakdown.contentType) {
            const ctType = breakdown.contentType.type || '';
            const category = this._contentTypeToCategory(ctType);
            const ctMult = userPrefs.contentTypeMultipliers[category];
            if (ctMult != null && ctMult !== 1.0) {
              prefMultiplier *= ctMult;
            }
          }

          // Domain weight from user preferences
          if (userPrefs.domainWeights && userPrefs.domainWeights[domain] != null) {
            const dw = userPrefs.domainWeights[domain];
            prefMultiplier *= dw;
          }

          // Apply combined preference multiplier
          if (prefMultiplier !== 1.0) {
            const adjusted = Math.max(0, Math.min(
              this.scoringEngine.config.scores.MAX_SCORE,
              Math.floor(scoringResult.score * prefMultiplier)
            ));
            scoringResult.breakdown = scoringResult.breakdown || {};
            scoringResult.breakdown.userPreferences = {
              applied: true,
              multiplier: prefMultiplier,
              originalScore: scoringResult.score,
              adjustedScore: adjusted
            };
            scoringResult.score = adjusted;
          }
        }
      } catch (_) {
        // Non-critical: proceed without user preference adjustment
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
          // Wallet noch nicht bereit (ADDRESS_UPDATE ausstehend) → Rating in Queue halten, nicht verwerfen
          console.warn('[RevolutionScoring] ⏳ Wallet not ready yet, queuing rating for later');
          return { walletNotReady: true };
        } else {
          // Kein BA→CL Transfer gefunden → Rating verwerfen
          console.warn('[RevolutionScoring] ❌ Rating discarded - No BA→CL transfer found yet');
          console.warn('[RevolutionScoring] User must wait for first BA interval transfer before ratings are created');
          return null;
        }
      }

    } else if (!walletManager) {
      // WalletManager noch nicht initialisiert → Rating in Queue halten
      console.warn('[RevolutionScoring] ⏳ WalletManager not ready yet, queuing rating for later');
      return { walletNotReady: true };
    } else {
      console.warn('[RevolutionScoring] ⚠️ Cannot check BA→CL transfer - TranslationFactorTracker not available');
    }

    // 4. Distribution berechnen (fuer Gesamt-Score, vor Beneficiary-Split)
    const ratingGroupId = `rg-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });

    // Legacy: Generiere primaere ratingRef und Seeds fuer content_creator (Hauptempfaenger)
    const primaryRatingRef = `rating-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const primarySeedObj = await seedManager.generateRatingSeeds(
      primaryRatingRef,
      scoringResult.metadata.domain,
      scoringResult.metadata.url
    );

    // Seeds in metadata setzen (fuer Distribution/TransactionQueue Kompatibilitaet)
    scoringResult.metadata.ratingRef = primaryRatingRef;
    scoringResult.metadata.ratingGroupId = ratingGroupId;
    scoringResult.metadata.seedCLtoSH = primarySeedObj.seedCLtoSH;
    scoringResult.metadata.seedSHtoDS = primarySeedObj.seedSHtoDS;

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

    // 7. Multi-Beneficiary: Beneficiaries ermitteln und Score aufteilen
    const beneficiaryRatings = await this.buildBeneficiaryRatings(
      scoringResult, distributionResult, ratingGroupId, seedManager
    );

    // 8. Sende als Bundle oder einzeln
    if (distributionResult.transactions.length === 0) {
      // Keine Ledger-Transaktionen -> Ratings direkt als Bundle senden
      await this.sendRatingBundle(beneficiaryRatings, ratingGroupId);
    }
    // Mit Transaktionen: primaeres Rating wird ueber TransactionQueue gesendet (Legacy-Flow)
    // Beneficiary-Ratings werden zusaetzlich als Bundle gesendet

    return {
      scoring: scoringResult,
      distribution: distributionResult,
      beneficiaryRatings
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

        // v2: per-recipient DSL contributions (content / addon / browser /
        // os / domain-specific). The addon's local aggregator produces this
        // from the buffered signal events; each entity carries its own
        // DS-contract on the server side.
        beneficiaries: scoringResult.metadata?.dslDistribution || null,

        // v2: per-DSL-signal breakdown (which signal triggered, how often,
        // with which weight, distributed across which recipients). Used by
        // the analytics dashboard's "Wie wird berechnet?" view to render
        // the scoring rationale directly from the encrypted vault payload.
        signals: scoringResult.metadata?.dslSignals || null,

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

    // Validate against grammar (non-blocking)
    if (typeof window.ScoringGrammarValidator === 'function') {
      const result = new window.ScoringGrammarValidator().validateRatingMessage(serializedPayload);
      if (!result.valid) {
        console.warn('[RevolutionScoring] Rating grammar validation errors:', result.errors);
      }
    }

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

        // v2: per-recipient DSL contributions (content / addon / browser /
        // os / domain-specific). See sendRatingToWebsite() for the same
        // injection on the transaction-bundle path.
        beneficiaries: scoringResult.metadata?.dslDistribution || null,

        // v2: per-DSL-signal breakdown (see sendRatingToWebsite()).
        signals: scoringResult.metadata?.dslSignals || null,

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

      // Validate against grammar (non-blocking)
      if (typeof window.ScoringGrammarValidator === 'function') {
        const result = new window.ScoringGrammarValidator().validateRatingMessage(serializedPayload);
        if (!result.valid) {
          console.warn('[RevolutionScoring] Rating grammar validation errors:', result.errors);
        }
      }

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

  // ===== MULTI-BENEFICIARY RATING SYSTEM =====

  /**
   * Default allocation weights fuer Beneficiary-Typen.
   * Spaeter ueberschreibbar durch Crowd-Voting oder User-Settings.
   */
  /** Standalone-Modus: Addon deckt alles ab (kein Desktop Watcher aktiv). */
  static BENEFICIARY_WEIGHTS_STANDALONE = {
    content_creator: 0.60,
    addon: 0.15,
    platform: 0.15,
    service_provider: 0.10
  };

  /** Combined-Modus: Desktop Watcher trackt Platform → Addon unterdrueckt Platform-Credit. */
  static BENEFICIARY_WEIGHTS_WITH_WATCHER = {
    content_creator: 0.75,
    addon: 0.15,
    service_provider: 0.10
  };

  /** @deprecated Use BENEFICIARY_WEIGHTS_STANDALONE instead */
  static BENEFICIARY_WEIGHTS = RevolutionScoring.BENEFICIARY_WEIGHTS_STANDALONE;

  /**
   * Ermittelt die Plattform (Browser/OS) als beneficiary_id.
   * @returns {string} z.B. "platform:firefox", "platform:chrome"
   */
  _detectPlatform() {
    const ua = navigator.userAgent || '';
    if (ua.includes('Firefox')) return 'platform:firefox';
    if (ua.includes('Chrome')) return 'platform:chrome';
    if (ua.includes('Safari')) return 'platform:safari';
    if (ua.includes('Edge')) return 'platform:edge';
    return 'platform:unknown-browser';
  }

  /**
   * Baut die Liste aller Beneficiaries fuer ein Rating-Event.
   * Jeder bekommt einen gewichteten Anteil vom Gesamt-Score und eigene Seeds.
   *
   * @param {Object} scoringResult - Scoring-Ergebnis (Gesamt-Score)
   * @param {Object} distributionResult - Distribution-Ergebnis (Tokens)
   * @param {string} ratingGroupId - Gemeinsame Group-ID
   * @param {FingerprintSeedManager} seedManager
   * @returns {Promise<Array>} Array von Beneficiary-Rating-Payloads
   */
  async buildBeneficiaryRatings(scoringResult, distributionResult, ratingGroupId, seedManager) {
    const totalScore = scoringResult.score;
    const totalTokens = distributionResult.tokens ? BigInt(distributionResult.tokens) : 0n;
    const domain = scoringResult.metadata.domain;

    // 0. Overlap-Detection: Pruefe ob Desktop Watcher Platform-Credits uebernimmt
    let watcherCoversPlatform = false;
    try {
      const bridgeDetector = window._bridgeDetector || new BridgeDetector();
      watcherCoversPlatform = await bridgeDetector.watcherCovers('platform');
    } catch (err) {
      console.warn('[RevolutionScoring] Bridge detection failed, assuming standalone:', err.message);
    }

    // 1. Beneficiary-Liste zusammenstellen
    const beneficiaries = [];

    // Content Creator (die Domain) - nutzt bereits generierte primaere Seeds
    beneficiaries.push({
      type: 'content_creator',
      beneficiaryId: domain,
      ratingRef: scoringResult.metadata.ratingRef,
      seedCLtoSH: scoringResult.metadata.seedCLtoSH,
      seedSHtoDS: scoringResult.metadata.seedSHtoDS,
      seedsPreGenerated: true
    });

    // Aktive Addons
    try {
      const detector = window._addonDetector || new AddonDetector();
      const addons = await detector.getActiveAddons();
      for (const addon of addons) {
        beneficiaries.push({
          type: 'addon',
          beneficiaryId: addon.beneficiaryId
        });
      }
    } catch (err) {
      console.warn('[RevolutionScoring] Addon detection failed:', err.message);
    }

    // Plattform — nur im Standalone-Modus (kein Watcher aktiv)
    if (!watcherCoversPlatform) {
      beneficiaries.push({
        type: 'platform',
        beneficiaryId: this._detectPlatform()
      });
    } else {
      console.log('[RevolutionScoring] Platform credit suppressed — desktop watcher covers platform tracking');
    }

    // 2. Weights berechnen (Entity Service Weights haben Vorrang vor Defaults)
    let entityWeights = null;
    try {
      if (this.distributionEngine && this.distributionEngine.getBeneficiaryWeightsForDomain) {
        entityWeights = await this.distributionEngine.getBeneficiaryWeightsForDomain(domain);
      }
    } catch (err) {
      console.warn('[RevolutionScoring] Could not fetch entity weights, using defaults:', err.message);
    }
    const weights = this._calculateBeneficiaryWeights(beneficiaries, entityWeights);

    // 3. Fuer jeden Beneficiary ein Rating-Payload erstellen
    const ratings = [];
    for (let i = 0; i < beneficiaries.length; i++) {
      const b = beneficiaries[i];
      const weight = weights[i];

      if (weight <= 0) continue;

      const beneficiaryScore = Math.round(totalScore * weight);
      const beneficiaryTokens = (totalTokens * BigInt(Math.round(weight * 10000))) / 10000n;

      // Seeds generieren (oder vorhandene nutzen fuer content_creator)
      let ratingRef = b.ratingRef;
      let seedCLtoSH = b.seedCLtoSH;
      let seedSHtoDS = b.seedSHtoDS;

      if (!b.seedsPreGenerated) {
        ratingRef = `rating-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
        const seedObj = await seedManager.generateRatingSeeds(ratingRef, b.beneficiaryId);
        seedCLtoSH = seedObj.seedCLtoSH;
        seedSHtoDS = seedObj.seedSHtoDS;
      }

      // Wallet-Adresse vom Entity Service holen
      let walletAddress = null;
      try {
        walletAddress = await this.distributionEngine.getWalletAddressForDomain(b.beneficiaryId);
      } catch (err) {
        console.warn(`[RevolutionScoring] Could not resolve wallet for ${b.beneficiaryId}:`, err.message);
      }

      ratings.push({
        transaction_ref: ratingRef,
        rating_group_id: ratingGroupId,
        beneficiary_type: b.type,
        beneficiary_id: b.beneficiaryId,
        score: beneficiaryScore,
        tokens: beneficiaryTokens.toString(),
        wallet_address: walletAddress,
        seedCLtoSH,
        seedSHtoDS,
        allocation: {
          source_score: totalScore,
          weight,
          method: 'default'
        },
        domain: scoringResult.metadata.domain,
        occurred_at: new Date().toISOString()
      });
    }

    console.log(`[RevolutionScoring] Built ${ratings.length} beneficiary ratings for group ${ratingGroupId}:`,
      ratings.map(r => `${r.beneficiary_type}:${r.beneficiary_id} (w=${r.allocation.weight})`));

    return ratings;
  }

  /**
   * Berechnet die Weights fuer eine Beneficiary-Liste.
   * Addon-Weight wird gleichmaessig auf alle Addons aufgeteilt.
   *
   * @param {Array} beneficiaries - Liste mit {type, beneficiaryId}
   * @returns {Array<number>} Weights (gleiche Reihenfolge)
   */
  /**
   * Berechnet die Weights fuer eine Beneficiary-Liste.
   *
   * Prioritaet:
   * 1. entityWeights (vom Entity Service, pro Domain) — wenn vorhanden
   * 2. Hardcoded Defaults (STANDALONE vs WITH_WATCHER)
   *
   * @param {Array} beneficiaries - Liste mit {type, beneficiaryId}
   * @param {Object|null} entityWeights - Weights vom Entity Service, z.B. { content_creator: 0.60, ... }
   * @returns {Array<number>} Weights (gleiche Reihenfolge wie beneficiaries)
   */
  _calculateBeneficiaryWeights(beneficiaries, entityWeights = null) {
    const addonCount = beneficiaries.filter(b => b.type === 'addon').length;
    const hasPlatform = beneficiaries.some(b => b.type === 'platform');

    // === 1. Base weights: Crowd-sourced > Entity Service > Hardcoded Defaults ===
    let baseWeights;
    const crowdSplits = this._getCrowdSplitWeights();
    if (crowdSplits) {
      baseWeights = crowdSplits;
    } else if (entityWeights && Object.keys(entityWeights).length > 0) {
      baseWeights = entityWeights;
    } else {
      baseWeights = hasPlatform
        ? RevolutionScoring.BENEFICIARY_WEIGHTS_STANDALONE
        : RevolutionScoring.BENEFICIARY_WEIGHTS_WITH_WATCHER;
    }

    // Wenn Platform im Entity-Service-Weight vorhanden aber Watcher uebernimmt:
    // Platform-Weight auf content_creator umverteilen
    if (!hasPlatform && baseWeights.platform) {
      baseWeights = { ...baseWeights };
      baseWeights.content_creator = (baseWeights.content_creator || 0) + (baseWeights.platform || 0);
      delete baseWeights.platform;
    }

    // === 2. Per-addon crowd weights (statt equal split) ===
    const addonCrowdWeights = this._getAddonCrowdWeights();
    const userAddonOverrides = this._getUserAddonOverrides();

    return beneficiaries.map(b => {
      if (b.type === 'addon' && addonCount > 0) {
        const totalAddonBudget = baseWeights.addon || 0;

        // Try crowd-weighted distribution
        if (addonCrowdWeights || userAddonOverrides) {
          const addonBeneficiaries = beneficiaries.filter(x => x.type === 'addon');
          const rawWeights = addonBeneficiaries.map(a => {
            const overrideKey = `addon-rating:${a.beneficiaryId}`;
            if (userAddonOverrides && userAddonOverrides[overrideKey] != null) {
              return userAddonOverrides[overrideKey];
            }
            if (addonCrowdWeights && addonCrowdWeights[a.beneficiaryId] != null) {
              return addonCrowdWeights[a.beneficiaryId];
            }
            return 5000; // default: neutral weight
          });

          const rawSum = rawWeights.reduce((s, w) => s + w, 0);
          if (rawSum > 0) {
            const myIndex = addonBeneficiaries.findIndex(a => a.beneficiaryId === b.beneficiaryId);
            if (myIndex >= 0) {
              return totalAddonBudget * (rawWeights[myIndex] / rawSum);
            }
          }
        }

        // Fallback: equal split
        return totalAddonBudget / addonCount;
      }
      return baseWeights[b.type] || 0;
    });
  }

  /**
   * Load crowd-sourced beneficiary split weights from cache.
   * Returns { content_creator, addon, platform, service_provider } normalized to sum=1.0,
   * or null if not available.
   */
  _getCrowdSplitWeights() {
    try {
      const cached = this._crowdSplitCache;
      if (!cached) return null;

      const map = {
        'split:beneficiary:content_creator:weight': 'content_creator',
        'split:beneficiary:addon:weight': 'addon',
        'split:beneficiary:platform:weight': 'platform',
        'split:beneficiary:service:weight': 'service_provider',
      };

      const weights = {};
      let total = 0;
      for (const [scope, key] of Object.entries(map)) {
        const val = cached[scope];
        if (val == null) return null; // all or nothing
        weights[key] = val;
        total += val;
      }

      if (total <= 0) return null;

      // Normalize to sum = 1.0
      for (const key of Object.keys(weights)) {
        weights[key] = weights[key] / total;
      }

      return weights;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get per-addon crowd weights from cache.
   * Returns { 'addon:ublock-origin': 7000, ... } or null.
   */
  _getAddonCrowdWeights() {
    try {
      return this._addonCrowdWeightsCache || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get per-user addon weight overrides from preferences.
   * Returns { 'addon-rating:addon:ublock-origin': 8000, ... } or null.
   */
  _getUserAddonOverrides() {
    try {
      return this._userAddonOverrides || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Update crowd weight caches. Called by background.js after fetching from entity service.
   * @param {Object} splitWeights - { 'split:beneficiary:addon:weight': autoValue, ... }
   * @param {Object} addonWeights - { 'addon:ublock-origin': autoValue, ... }
   */
  updateCrowdWeightCaches(splitWeights, addonWeights) {
    this._crowdSplitCache = splitWeights || null;
    this._addonCrowdWeightsCache = addonWeights || null;
  }

  /**
   * Update user addon overrides. Called when preferences are received.
   * @param {Object} overrides - { 'addon-rating:addon:ublock-origin': 8000, ... }
   */
  updateUserAddonOverrides(overrides) {
    this._userAddonOverrides = overrides || null;
  }

  /**
   * Sendet alle Beneficiary-Ratings als Bundle ueber Messaging.
   *
   * @param {Array} beneficiaryRatings - Array von Rating-Payloads
   * @param {string} ratingGroupId - Gemeinsame Group-ID
   */
  async sendRatingBundle(beneficiaryRatings, ratingGroupId) {
    const messagingClient = window.MessagingIntegration?.getClient();

    if (!messagingClient) {
      console.error('[RevolutionScoring] Messaging client not available for rating bundle');
      return;
    }

    const bundlePayload = {
      type: 'rating_bundle',
      rating_group_id: ratingGroupId,
      ratings: beneficiaryRatings.map(r => this.convertBigIntsToStrings(r)),
      total_score: beneficiaryRatings.reduce((sum, r) => sum + r.score, 0),
      beneficiary_count: beneficiaryRatings.length,
      occurred_at: new Date().toISOString()
    };

    try {
      await messagingClient.sendMessage(bundlePayload, 'rating_bundle');

      console.log(`[RevolutionScoring] Rating bundle sent: ${ratingGroupId} (${beneficiaryRatings.length} beneficiaries)`);

      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.success('rating_bundle_sent', 'Rating bundle sent', {
          ratingGroupId,
          beneficiaryCount: beneficiaryRatings.length,
          beneficiaries: beneficiaryRatings.map(r => r.beneficiary_id)
        });
      }
    } catch (error) {
      console.error('[RevolutionScoring] Failed to send rating bundle:', error);

      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.error('rating_bundle_failed', 'Failed to send rating bundle', {
          error: error.message,
          ratingGroupId
        });
      }
    }
  }

  /**
   * Maps scoring content-type constants to user preference categories.
   * Mirrors TYPE_TO_CATEGORY from analytics-settings.js.
   */
  _contentTypeToCategory(type) {
    const map = {
      ARTICLE: 'learning', BLOG_POST: 'learning', TUTORIAL: 'learning', DOCUMENTATION: 'learning',
      VIDEO: 'media', PODCAST: 'media', IMAGE_GALLERY: 'media',
      TOOL: 'tools', PLAYGROUND: 'tools', INTERACTIVE: 'tools',
      CODE_REPOSITORY: 'code', CODE_SNIPPET: 'code',
      DISCUSSION: 'social', SOCIAL_FEED: 'social',
      UNKNOWN: 'learning'
    };
    return map[type] || 'learning';
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
