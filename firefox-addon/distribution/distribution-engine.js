/**
 * Distribution Engine
 *
 * Haupt-Engine für Token-Verteilung
 *
 * System: Kontinuierliche Safety/Payout-Funktion
 * - Tag 1-30: 99% Safety (1% Payout)
 * - Tag 30-90: Linear von 99% → 0% Safety (1% → 100% Payout)
 * - Ab Tag 90: 0% Safety (100% Payout)
 *
 * WICHTIG:
 * - Deterministisch
 * - Privacy-aware (E24-Standardisierung)
 * - Fairness (Monatsende garantiert 10€)
 * - Keine expliziten Phasen, nur mathematische Funktion
 */

class DistributionEngine {
  constructor(config, prognosisModel, calibrationManager, privacyLayer, entityResolver = null) {
    this.config = config;
    this.prognosisModel = prognosisModel;
    this.calibrationManager = calibrationManager;
    this.privacyLayer = privacyLayer; // Wird später initialisiert
    this.entityResolver = entityResolver || (typeof window !== 'undefined' && window.EntityResolver ? new window.EntityResolver() : null);

    // NEU: Translation Factor Tracker
    this.translationFactorTracker = typeof window !== 'undefined' && window.TranslationFactorTracker
      ? new window.TranslationFactorTracker()
      : null;

    // NEU: Fluctuation Safety Factor (aktiviert ab Tag 10)
    this.fluctuationSF = typeof window !== 'undefined' && window.FluctuationSafetyFactor
      ? new window.FluctuationSafetyFactor()
      : null;

  }

  /**
   * Berechnet Sicherheitsfaktor basierend auf verstrichenen Tagen
   *
   * Kontinuierliche Funktion ohne explizite Phasen:
   * - t < 30: safetyFactor = 0.99 (99% Puffer, 1% Auszahlung)
   * - 30 ≤ t < 90: safetyFactor = 0.99 - ((t - 30) / 60) * 0.99 (linear fallend)
   * - t ≥ 90: safetyFactor = 0.0 (0% Puffer, 100% Auszahlung)
   *
   * Der payoutFactor ist einfach: payoutFactor = 1.0 - safetyFactor
   *
   * @param {number} daysSinceStart - Tage seit erstem Tracking
   * @returns {number} Sicherheitsfaktor (0.0 - 0.99)
   */
  calculateSafetyFactor(daysSinceStart) {
    if (daysSinceStart < 30) {
      // Erste 30 Tage: 99% Puffer (1% Auszahlung)
      return 0.99;
    } else if (daysSinceStart < 90) {
      // Tag 30-90: Linear von 99% → 0%
      // Formel: 0.99 - ((daysSinceStart - 30) / 60) * 0.99
      const progress = (daysSinceStart - 30) / 60; // 0.0 bis 1.0
      return 0.99 - (progress * 0.99);
    } else {
      // Ab Tag 90: 0% Puffer (100% Auszahlung)
      return 0.0;
    }
  }

  /**
   * Hauptfunktion: Verarbeitet neue Session
   *
   * IMMER Token berechnen, dann Sicherheitsfaktor anwenden
   *
   * @param {Object} scoringResult - Scoring-Ergebnis
   * @param {Object} userData - User-Daten (firstTrackingDate, historicalScores)
   * @returns {Object} Distribution-Ergebnis
   */
  async processSession(scoringResult, userData) {
    const firstTrackingDate = new Date(userData.firstTrackingDate);
    const now = Date.now();
    const daysSinceStart = Math.floor((now - firstTrackingDate.getTime()) / (24 * 60 * 60 * 1000));

    // Berechne Sicherheitsfaktor
    const safetyFactor = this.calculateSafetyFactor(daysSinceStart);
    const payoutFactor = 1.0 - safetyFactor; // Umgekehrt: je höher Sicherheit, desto weniger Auszahlung

    return await this.processSessionWithSafetyFactor(
      scoringResult,
      userData,
      safetyFactor,
      payoutFactor,
      daysSinceStart
    );
  }

  /**
   * Verarbeitet Session mit Sicherheitsfaktor
   *
   * Berechnet IMMER Token, wendet dann Sicherheitsfaktor an
   */
  async processSessionWithSafetyFactor(scoringResult, userData, safetyFactor, payoutFactor, daysSinceStart) {
    const { historicalScores, totalDaysTracked, currentDayOfMonth, firstTrackingDate } = userData;

    // 1. Prognose berechnen
    const prognosis = this.prognosisModel.calculatePrognosis(
      historicalScores,
      currentDayOfMonth,
      totalDaysTracked,
      firstTrackingDate
    );

    // WICHTIG: Rating ZUERST zur Historie hinzufügen, BEVOR Translation Factor berechnet wird!
    // So wird das aktuelle Rating in den Faktor mit einbezogen
    const domain = scoringResult.metadata.domain;
    const ratingRef = scoringResult.metadata?.ratingRef || `rating-${Date.now()}`;

    if (this.translationFactorTracker) {
      await this.translationFactorTracker.addRating(
        scoringResult.score,
        domain,
        ratingRef,
        Date.now()
      );
    } else {
      console.warn('[DistributionEngine] Cannot add rating - TranslationFactorTracker is null!');
    }

    // NEU 2a: Translation Factor berechnen (NACH dem Rating speichern!)
    let translationFactor = 0n;
    let prognosisSafetyFactor = 1.0;
    let fluctuationSafetyFactor = 1.0;

    if (this.translationFactorTracker) {
      translationFactor = await this.translationFactorTracker.calculateCurrentFactor();

      // NEU 2b: Prognose-Sicherheits-Faktor basierend auf Faktor-Verlauf
      const factorHistory = await this.translationFactorTracker.getFactorHistory(90);
      prognosisSafetyFactor = this.prognosisModel.calculatePrognosisSF(factorHistory);

      // NEU 2c: Fluctuation-SF (aktiviert ab Tag 10)
      if (this.fluctuationSF) {
        fluctuationSafetyFactor = this.fluctuationSF.calculateFluctuationSF(factorHistory, daysSinceStart);
      }

    } else {
      console.warn('[DistributionEngine] TranslationFactorTracker not available, using fallback');
      // Fallback: Alte Logik (mit Prognosis Ratio)
      translationFactor = prognosis.predictedRatio;
      prognosisSafetyFactor = 0.9; // Konservativ
      fluctuationSafetyFactor = 1.0; // Kein Einfluss
    }

    // 2. Token-Berechnung mit neuem Faktor
    // rawTokens = Score × TranslationFactor
    const scoreBigInt = BigInt(Math.floor(scoringResult.score));
    const rawTokens = scoreBigInt * translationFactor;

    if (rawTokens === 0n) {
      return this.createZeroPaymentResult(scoringResult, prognosis, daysSinceStart, safetyFactor);
    }

    // 3. ALLE DREI Sicherheitsfaktoren anwenden
    // combinedSF = startSafetyFactor × prognosisSafetyFactor × fluctuationSafetyFactor
    // payoutFactor = 1.0 - safetyFactor (Start-SF)
    const combinedPayoutFactor = payoutFactor * prognosisSafetyFactor * fluctuationSafetyFactor;

    const payoutTokens = BigInt(Math.floor(Number(rawTokens) * combinedPayoutFactor));
    const bufferedTokens = rawTokens - payoutTokens;

    // 4. E24-Standardisierung (Privacy!) - nur auf Auszahlung
    const standardizedTokens = this.privacyLayer && payoutTokens > 0n
      ? this.privacyLayer.standardizeTokenAmount(payoutTokens)
      : payoutTokens;

    // 5. Hole Wallet-Adresse für die Domain
    // domain wurde bereits oben deklariert (Zeile 142)
    const { address: walletAddress, isNewWallet } = await this._resolveWalletWithMeta(domain);

    // 5b. Warnung wenn keine gültige Wallet-Adresse
    if (walletAddress.startsWith('pending:')) {
      console.error('[DistributionEngine] ❌ CRITICAL: No valid wallet address for domain:', domain);
      console.error('[DistributionEngine] Transaction will likely fail at execution time!');
    }

    // 6. Transaktion erstellen (IMMER, auch bei Zero-Tokens!)
    // Zero-Token-Transaktionen sind wichtig für Nachzahlungen (Retro Payout Service)
    const transactions = [];

    // WICHTIG: Erstelle Transaktion IMMER (auch wenn istTokens = 0)
    // Der RetroPayoutService wird später Nachzahlungen erstellen
    {
      const transaction = {
        walletAddress: walletAddress,
        isNewWallet: isNewWallet,
        domain: domain,
        score: scoringResult.score,
        tokens: standardizedTokens,
        timestamp: new Date().toISOString(),
        type: 'payment',
        safetyFactor: safetyFactor,
        payoutFactor: payoutFactor,
        rawTokens: rawTokens,
        bufferedTokens: bufferedTokens,
        daysSinceStart: daysSinceStart,

        // === FINGERPRINT SEEDS (NEU) ===
        // Rating-Tracking mit ZWEI Seeds
        ratingRef: scoringResult.metadata?.ratingRef || `rating-${Date.now()}`,
        seedCLtoSH: scoringResult.metadata?.seedCLtoSH || null,
        seedSHtoDS: scoringResult.metadata?.seedSHtoDS || null,
        pairIndex: 0,  // Erstes Transaktionspaar (initial)

        // === FULL SCORING & DISTRIBUTION DATA (für Rating-Nachrichten) ===
        // Diese Daten werden verwendet, um vollständige Rating-Nachrichten zu senden
        _scoringResult: scoringResult,
        _distributionMetadata: {
          rawTokens: rawTokens.toString(),
          payoutTokens: payoutTokens.toString(),
          bufferedTokens: bufferedTokens.toString(),
          standardizedTokens: standardizedTokens.toString(),
          safetyFactor: safetyFactor,
          payoutFactor: payoutFactor,
          prognosisSafetyFactor: prognosisSafetyFactor, // NEU
          fluctuationSafetyFactor: fluctuationSafetyFactor, // NEU
          combinedPayoutFactor: combinedPayoutFactor, // NEU
          translationFactor: translationFactor.toString(), // NEU
          daysSinceStart: daysSinceStart,
          prognosis: prognosis,
          totalDaysTracked: totalDaysTracked,
          currentDayOfMonth: currentDayOfMonth
        }
      };

      // In Queue einreihen (IMMER, auch bei Zero-Tokens!)
      if (this.privacyLayer) {
        await this.privacyLayer.queueTransaction(transaction);
      }

      transactions.push(transaction);
    }

    return {
      score: scoringResult.score,
      tokens: standardizedTokens,
      transactions: transactions,
      prognosis: prognosis,
      metadata: {
        daysSinceStart: daysSinceStart,
        safetyFactor: safetyFactor,
        payoutFactor: payoutFactor,
        prognosisSafetyFactor: prognosisSafetyFactor, // NEU
        combinedPayoutFactor: combinedPayoutFactor, // NEU
        translationFactor: translationFactor.toString(), // NEU
        totalDaysTracked: totalDaysTracked,
        conservativityFactor: this.prognosisModel.calculateConservativityFactor(totalDaysTracked),
        rawTokens: rawTokens.toString(),
        payoutTokens: payoutTokens.toString(),
        bufferedTokens: bufferedTokens.toString(),
        standardizedTokens: standardizedTokens.toString(),
        onChainStatus: 'pending' // NEU: Immer 'pending' beim Scoring
      }
    };
  }

  /**
   * Führt Kalibrations-Settlement aus (Tag 30)
   */
  async executeCalibrationSettlement(calibrationScores, userPreferences = []) {
    const result = this.calibrationManager.executeCalibrationSettlement(
      calibrationScores
    );

    // Bulk-Transaktionen erstellen
    const transactions = [];

    for (const payment of result.domainPayments) {
      // E24-Standardisierung
      const standardizedTokens = this.privacyLayer
        ? this.privacyLayer.standardizeTokenAmount(payment.tokens)
        : payment.tokens;

      // Hole Wallet-Adresse
      const { address: walletAddress, isNewWallet } = await this._resolveWalletWithMeta(payment.domain);

      transactions.push({
        walletAddress: walletAddress, // On-Chain Ziel-Adresse
        isNewWallet: isNewWallet,
        domain: payment.domain, // Für Analytics
        score: payment.score,
        tokens: standardizedTokens,
        type: 'calibration_settlement',
        timestamp: new Date().toISOString()
      });
    }

    // Alle Transaktionen in Queue (mit Batching)
    if (this.privacyLayer) {
      for (const tx of transactions) {
        await this.privacyLayer.queueTransaction(tx);
      }
    }

    return {
      ...result,
      transactions: transactions
    };
  }

  /**
   * Monatsende-Korrektur (GARANTIERT 10€)
   */
  async executeMonthEndSettlement(monthData, userPreferences = []) {
    const { scores, paidAmounts } = monthData;

    // 1. Aggregate nach Domain
    const domainScores = this.aggregateByDomain(scores);

    // 2. Totaler Score
    const totalScore = domainScores.reduce((sum, d) => sum + d.totalScore, 0);

    if (totalScore === 0) {
      return this.createEmptyMonthEndResult();
    }

    // 3. Perfekte Ratio
    const budget = this.config.tokens.MONTHLY_BUDGET_TOKENS;
    const perfectRatio = budget / BigInt(Math.floor(totalScore));

    // 4. Pro Domain: Soll vs. Ist
    const settlements = [];

    for (const domain of domainScores) {
      const scoreBigInt = BigInt(Math.floor(domain.totalScore));
      const shouldGet = scoreBigInt * perfectRatio;
      const alreadyPaid = paidAmounts[domain.domain] || 0n;

      const deficit = shouldGet - BigInt(alreadyPaid);

      if (deficit > 0n) {
        // Nachzahlung nötig
        const standardizedDeficit = this.privacyLayer
          ? this.privacyLayer.standardizeTokenAmount(deficit)
          : deficit;

        settlements.push({
          domain: domain.domain,
          shouldGet: shouldGet,
          alreadyPaid: alreadyPaid,
          deficit: standardizedDeficit,
          type: 'month_end_correction'
        });
      }
    }

    // 5. Nachzahlungen in Queue
    if (this.privacyLayer) {
      for (const settlement of settlements) {
        // Hole Wallet-Adresse
        const { address: walletAddress, isNewWallet } = await this._resolveWalletWithMeta(settlement.domain);

        await this.privacyLayer.queueTransaction({
          walletAddress: walletAddress, // On-Chain Ziel-Adresse
          isNewWallet: isNewWallet,
          domain: settlement.domain, // Für Analytics
          tokens: settlement.deficit,
          type: 'month_end_correction',
          timestamp: new Date().toISOString()
        });
      }
    }

    return {
      totalScore: totalScore,
      perfectRatio: perfectRatio,
      settlements: settlements,
      metadata: {
        domainCount: domainScores.length,
        settlementDate: new Date().toISOString(),
        totalDeficit: settlements.reduce((sum, s) => sum + s.deficit, 0n).toString()
      }
    };
  }

  /**
   * Aggregiert Scores nach Domain
   */
  aggregateByDomain(scores) {
    const domainMap = new Map();

    for (const score of scores) {
      const domain = score.domain || score.metadata?.domain || 'unknown';

      if (!domainMap.has(domain)) {
        domainMap.set(domain, {
          domain: domain,
          totalScore: 0,
          sessionCount: 0
        });
      }

      const domainData = domainMap.get(domain);
      domainData.totalScore += score.score || 0;
      domainData.sessionCount += 1;
    }

    return Array.from(domainMap.values());
  }

  /**
   * Holt Wallet-Adresse für eine Domain
   *
   * 1. Prüft lokalen Cache
   * 2. Falls nicht gecacht: Holt von server-api /entity/resolve
   * 3. Speichert in Cache für zukünftige Verwendung
   */
  async getWalletAddressForDomain(domain, storage = browser.storage.local) {
    const result = await this._resolveWalletWithMeta(domain, storage);
    return result.address;
  }

  /**
   * Holt Wallet-Adresse mit Metadaten (inkl. is_new_wallet Flag)
   * Wird für queueTransaction-Aufrufe verwendet um Timing-Angriffe zu verhindern
   * @returns {Promise<{address: string, isNewWallet: boolean}>}
   */
  async _resolveWalletWithMeta(domain, storage = browser.storage.local) {
    const data = await storage.get(['rev_domain_wallets', 'rev_user_token', 'rev_new_wallets']);
    const domainWallets = data.rev_domain_wallets || {};
    const newWallets = data.rev_new_wallets || {};
    const userToken = data.rev_user_token;

    // 1. Prüfe Cache
    const cachedAddress = domainWallets[domain];

    if (cachedAddress) {
      const isNewWallet = this.entityResolver
        ? this.entityResolver._isWalletStillNew(newWallets[domain])
        : false;
      return { address: cachedAddress, isNewWallet };
    }

    // 2. Nicht gecacht → von API holen (wenn EntityResolver verfügbar)
    if (this.entityResolver && userToken) {
      try {
        const resolved = await this.entityResolver.getAndCacheWalletAddress(domain, userToken, storage);
        return resolved; // {address, isNewWallet}
      } catch (error) {
        console.error('[DistributionEngine] Failed to fetch wallet address from API:', error.message);
        // Fallback unten
      }
    } else {
      if (!this.entityResolver) {
        console.warn('[DistributionEngine] EntityResolver not available');
      }
      if (!userToken) {
        console.warn('[DistributionEngine] User token not available for entity resolution');
      }
    }

    // 3. Fallback: Verwende Domain als Platzhalter
    console.error('[DistributionEngine] ❌ FALLBACK: No wallet address available for domain:', {
      domain: domain,
      hasEntityResolver: !!this.entityResolver,
      hasUserToken: !!userToken,
      cachedDomains: Object.keys(domainWallets),
      hint: 'Domain muss über /entity/resolve registriert werden oder KEY_UPDATE Message empfangen'
    });
    return { address: `pending:${domain}`, isNewWallet: false };
  }

  /**
   * Speichert Wallet-Adresse für eine Domain
   * Wird vom MessagingIntegration aufgerufen wenn KEY_UPDATE empfangen wird
   */
  async saveWalletAddressForDomain(domain, walletAddress, storage = browser.storage.local) {
    const data = await storage.get(['rev_domain_wallets']);
    const domainWallets = data.rev_domain_wallets || {};

    domainWallets[domain] = walletAddress;

    await storage.set({ rev_domain_wallets: domainWallets });
  }

  /**
   * Erstellt Zero-Payment Ergebnis
   */
  createZeroPaymentResult(scoringResult, prognosis, daysSinceStart, safetyFactor) {
    const payoutFactor = 1.0 - safetyFactor;

    return {
      score: scoringResult.score,
      tokens: 0n,
      transactions: [],
      prognosis: prognosis,
      metadata: {
        daysSinceStart: daysSinceStart,
        safetyFactor: safetyFactor,
        payoutFactor: payoutFactor,
        rawTokens: '0',
        payoutTokens: '0',
        bufferedTokens: '0',
        standardizedTokens: '0',
        reason: 'conservativity_factor_too_low',
        message: 'Not enough historical data for payment'
      }
    };
  }

  /**
   * Erstellt leeres Monatsende-Ergebnis
   */
  createEmptyMonthEndResult() {
    return {
      totalScore: 0,
      perfectRatio: 0n,
      settlements: [],
      metadata: {
        domainCount: 0,
        settlementDate: new Date().toISOString(),
        totalDeficit: '0'
      }
    };
  }

  /**
   * Holt User-Daten für Distribution
   */
  async getUserData(storage = browser.storage.local) {
    const data = await storage.get([
      'rev_first_tracking_date',
      'rev_historical_scores',
      'rev_paid_amounts'
    ]);

    const firstTrackingDate = data.rev_first_tracking_date || new Date().toISOString();
    const historicalScores = data.rev_historical_scores || [];
    const paidAmounts = data.rev_paid_amounts || {};

    // Berechne totalDaysTracked
    const firstDate = new Date(firstTrackingDate);
    const totalDaysTracked = this.calibrationManager.calculateDaysSince(
      firstDate,
      new Date()
    );

    // Aktueller Tag im 30-Tage-Zyklus (1-30)
    // Zyklus startet bei firstTrackingDate und wiederholt sich alle 30 Tage
    const currentDayOfMonth = (totalDaysTracked % 30) + 1;

    return {
      firstTrackingDate,
      historicalScores,
      paidAmounts,
      totalDaysTracked,
      currentDayOfMonth
    };
  }

  /**
   * Speichert bezahlte Beträge
   */
  async savePaidAmount(domain, amount, storage = browser.storage.local) {
    const data = await storage.get(['rev_paid_amounts']);
    const paidAmounts = data.rev_paid_amounts || {};

    const currentAmount = paidAmounts[domain] || 0n;
    paidAmounts[domain] = currentAmount + amount;

    await storage.set({ rev_paid_amounts: paidAmounts });
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.DistributionEngine = DistributionEngine;
} else {
  console.warn('[DistributionEngine] ⚠️ window is undefined, cannot export');
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DistributionEngine;
}
