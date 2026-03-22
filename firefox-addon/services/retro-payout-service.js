/**
 * Retro Payout Service
 *
 * Background-Job der alte Ratings neu berechnet und Nachzahlungen erstellt.
 *
 * TRIGGER: Alle 6 Stunden (oder manuell)
 * BEDINGUNG: 3 * istTokens < sollTokens (neu berechnet)
 *
 * WICHTIG:
 * - Nur Ratings der letzten 30 Tage werden geprüft
 * - Nachzahlung nur wenn Abweichung >= 3x (konservativ)
 * - Nutzt TransactionCorrector für eigentliche Ausführung
 */

class RetroPayoutService {
  constructor(distributionEngine, translationFactorTracker, messagingClient, storage = browser.storage.local) {
    this.distributionEngine = distributionEngine;
    this.tracker = translationFactorTracker;
    this.messagingClient = messagingClient;
    this.storage = storage;

    // Konfiguration
    this.CHECK_INTERVAL_HOURS = 6;  // Alle 6 Stunden
    this.PAYOUT_THRESHOLD_MULTIPLIER = 3;  // 3x Abweichung triggert Nachzahlung
    this.MIN_PAYOUT_TOKENS = 1000n;  // Minimum für Nachzahlung (Spam-Vermeidung)

    // State
    this.isRunning = false;
    this.intervalId = null;
    this.lastRunTimestamp = null;
  }

  /**
   * Startet den Background-Job
   */
  start() {
    if (this.intervalId) {
      return;
    }

    // Initiale Prüfung (nach 5 Minuten, um System-Start nicht zu blockieren)
    setTimeout(() => {
      this.checkAndCreatePayouts().catch(err => {
        console.error('[RetroPayoutService] Initial check failed:', err);
      });
    }, 5 * 60 * 1000);

    // Periodische Prüfung
    const intervalMs = this.CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.checkAndCreatePayouts().catch(err => {
        console.error('[RetroPayoutService] Periodic check failed:', err);
      });
    }, intervalMs);
  }

  /**
   * Stoppt den Background-Job
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Hauptfunktion: Prüft alle Ratings und erstellt Nachzahlungen
   *
   * @returns {Promise<Object>} Stats { checked, payoutsCreated, totalTokens }
   */
  async checkAndCreatePayouts() {
    if (this.isRunning) {
      return { checked: 0, payoutsCreated: 0, totalTokens: '0' };
    }

    this.isRunning = true;
    this.lastRunTimestamp = Date.now();

    try {
      // 1. Hole alle Ratings letzten 30 Tage
      const ratings = await this.tracker.getRatingsLast30Days();

      if (ratings.length === 0) {
        return { checked: 0, payoutsCreated: 0, totalTokens: '0' };
      }

      // 2. Hole gespeicherte Transaktionen
      const storedTransactions = await this.getStoredTransactions();

      // 3. Aktueller Übersetzungs-Faktor
      const currentFactor = await this.tracker.calculateCurrentFactor();

      // 4. Aktuelle Prognose-Daten
      const userData = await this.distributionEngine.getUserData(this.storage);
      const factorHistory = await this.tracker.getFactorHistory(90);
      const prognosisSF = this.distributionEngine.prognosisModel.calculatePrognosisSF(factorHistory);

      // 5. Prüfe jedes Rating auf Nachzahlungs-Bedarf
      let payoutsCreated = 0;
      let totalPayoutTokens = 0n;

      for (const rating of ratings) {
        const result = await this.checkRatingForRetroPayment(
          rating,
          storedTransactions,
          currentFactor,
          prognosisSF,
          userData
        );

        if (result.payoutCreated) {
          payoutsCreated++;
          totalPayoutTokens += BigInt(result.payoutTokens || '0');
        }
      }

      const stats = {
        checked: ratings.length,
        payoutsCreated,
        totalTokens: totalPayoutTokens.toString()
      };

      console.log('[RetroPayoutService] ✅ Check completed:', stats);

      // Log to DebugLogger
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.info('retro_payout_check', 'Retro payout check completed', stats);
      }

      return stats;

    } catch (error) {
      console.error('[RetroPayoutService] ❌ Error during retro payout check:', error);

      // Log error
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.error('retro_payout_error', 'Retro payout check failed', {
          errorMessage: error.message,
          errorStack: error.stack
        });
      }

      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Prüft ein einzelnes Rating auf Nachzahlungs-Bedarf
   *
   * BEDINGUNG: 3 * Σ(istTokens) < sollTokens (neu berechnet)
   *
   * @returns {Promise<Object>} { payoutCreated: boolean, payoutTokens: string }
   */
  async checkRatingForRetroPayment(rating, storedTransactions, currentFactor, prognosisSF, userData) {
    try {
      // 1. Hole alle Transaktionen für dieses Rating
      const ratingTxs = storedTransactions.filter(tx => tx.ratingRef === rating.ratingRef);

      // 2. Berechne neue Soll-Tokens (mit aktuellem Faktor)
      const sollTokens = await this.calculateSollTokens(rating, currentFactor, prognosisSF, userData);

      // 3. Summe aller bisherigen Ist-Auszahlungen
      const istTokensSum = ratingTxs.reduce((sum, tx) => {
        const tokens = BigInt(tx.istTokens || '0');
        return sum + tokens;
      }, 0n);

      // 4. Prüfe 3x-Regel: 3 * istTokensSum < sollTokens?
      const threshold = istTokensSum * BigInt(this.PAYOUT_THRESHOLD_MULTIPLIER);
      const needsRetroPayment = threshold < sollTokens;

      // 5. Differenz berechnen
      const differenz = sollTokens - istTokensSum;

      // 6. Erstelle Nachzahlung wenn Bedingungen erfüllt
      if (needsRetroPayment && differenz >= this.MIN_PAYOUT_TOKENS) {
        // Erstelle Korrektur-Transaktion über TransactionCorrector
        await this.createCorrectionTransaction(
          rating,
          ratingTxs,
          sollTokens,
          istTokensSum,
          differenz,
          currentFactor,
          prognosisSF
        );

        return { payoutCreated: true, payoutTokens: differenz.toString() };
      }

      return { payoutCreated: false, payoutTokens: '0' };

    } catch (error) {
      console.error('[RetroPayoutService] Error checking rating:', error);
      return { payoutCreated: false, payoutTokens: '0' };
    }
  }

  /**
   * Berechnet Soll-Tokens mit aktuellem Faktor und SFs
   */
  async calculateSollTokens(rating, currentFactor, prognosisSF, userData) {
    const score = BigInt(rating.score);

    // Raw Tokens = Score × Translation Factor
    const rawTokens = score * currentFactor;

    // Start Safety Factor (zeitbasiert)
    const daysSinceRating = Math.floor((Date.now() - rating.timestamp) / (24 * 60 * 60 * 1000));
    const startSF = this.distributionEngine.calibrationManager.calculateSafetyFactor(daysSinceRating);

    // Combined Payout Factor = (1 - startSF) × prognosisSF
    const payoutFactor = (1.0 - startSF) * prognosisSF;

    // Soll-Tokens
    const sollTokens = BigInt(Math.floor(Number(rawTokens) * payoutFactor));

    return sollTokens;
  }

  /**
   * Erstellt eine Korrektur-Transaktion (Nachzahlung)
   */
  async createCorrectionTransaction(rating, existingTxs, sollTokens, istTokensSum, differenz, currentFactor, prognosisSF) {
    // Pair Index = Anzahl bisheriger Transaktionen
    const pairIndex = existingTxs.length;

    // Nutze FingerprintSeedManager für Fingerprint-Generierung
    const seedManager = new window.FingerprintSeedManager(this.storage);
    const fingerprints = await seedManager.generateTransactionPairFingerprints(rating.ratingRef, pairIndex);

    // Standardisiere auf E24-Reihe (Privacy)
    const standardizedDifferenz = this.distributionEngine.privacyLayer.e24Rounding.standardizeAmount(
      differenz,
      rating.domain
    );

    // Erstelle Transaction-Objekt
    const correctionTx = {
      type: 'correction',
      ratingRef: rating.ratingRef,
      domain: rating.domain,
      score: rating.score,
      timestamp: Date.now(),
      pairIndex,

      // Fingerprints
      fingerprintCLtoSH: fingerprints.fingerprintCLtoSH,
      fingerprintSHtoDS: fingerprints.fingerprintSHtoDS,

      // Token-Beträge
      sollTokens: sollTokens.toString(),
      istTokens: standardizedDifferenz.toString(),  // Nur die Differenz wird ausgezahlt
      differenz: (sollTokens - istTokensSum - standardizedDifferenz).toString(),  // Rest-Differenz nach dieser Nachzahlung
      cumulativeTokens: (istTokensSum + standardizedDifferenz).toString(),  // Gesamt nach dieser Zahlung

      // Metadaten
      translationFactor: currentFactor.toString(),
      prognosisSafetyFactor: prognosisSF,
      reason: 'retro_payout_3x_rule'
    };

    // Speichere Transaktion
    await this.saveTransaction(correctionTx);

    // Füge zur Seed-Historie hinzu
    await seedManager.addTransactionPair(
      rating.ratingRef,
      pairIndex,
      fingerprints.fingerprintCLtoSH,  // CL→SH hash (wird erst nach Blockchain-Ausführung gesetzt)
      fingerprints.fingerprintSHtoDS,  // SH→DS hash
      'correction'
    );

    // Queue für Blockchain-Ausführung (via PrivacyLayer)
    if (standardizedDifferenz > 0n) {
      const { address: _walletAddr, isNewWallet: _isNewWallet } =
        await this.distributionEngine._resolveWalletWithMeta(rating.domain);
      await this.distributionEngine.privacyLayer.queueTransaction({
        walletAddress: _walletAddr,
        isNewWallet: _isNewWallet,
        domain: rating.domain,
        score: rating.score,
        tokens: standardizedDifferenz,
        fingerprintCLtoSH: fingerprints.fingerprintCLtoSH,
        fingerprintSHtoDS: fingerprints.fingerprintSHtoDS,
        ratingRef: rating.ratingRef,
        pairIndex,
        type: 'correction',
        metadata: {
          reason: 'retro_payout_3x_rule',
          sollTokens: sollTokens.toString(),
          previousIstSum: istTokensSum.toString()
        }
      });

    }

    return correctionTx;
  }

  /**
   * Hole gespeicherte Transaktionen aus Storage
   */
  async getStoredTransactions() {
    try {
      const data = await this.storage.get(['rev_stored_transactions']);
      return data.rev_stored_transactions || [];
    } catch (error) {
      console.error('[RetroPayoutService] Error loading transactions:', error);
      return [];
    }
  }

  /**
   * Speichere Transaktion in Storage
   */
  async saveTransaction(transaction) {
    try {
      const transactions = await this.getStoredTransactions();
      transactions.push(transaction);

      await this.storage.set({
        'rev_stored_transactions': transactions
      });

    } catch (error) {
      console.error('[RetroPayoutService] Error saving transaction:', error);
      throw error;
    }
  }

  /**
   * Manueller Trigger (für Testing/Debugging)
   */
  async triggerManualCheck() {
    return await this.checkAndCreatePayouts();
  }

  /**
   * Hole Stats über letzte Ausführung
   */
  async getStats() {
    return {
      isRunning: this.isRunning,
      checkIntervalHours: this.CHECK_INTERVAL_HOURS,
      payoutThresholdMultiplier: this.PAYOUT_THRESHOLD_MULTIPLIER,
      lastRunTimestamp: this.lastRunTimestamp,
      lastRunDate: this.lastRunTimestamp ? new Date(this.lastRunTimestamp).toISOString() : null
    };
  }
}

// Export für background.js
if (typeof window !== 'undefined') {
  window.RetroPayoutService = RetroPayoutService;
}
