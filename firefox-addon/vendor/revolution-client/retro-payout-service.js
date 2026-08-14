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

export class RetroPayoutService {
  /**
   * @param {Object} distributionEngine - DistributionEngine instance
   * @param {Object} translationFactorTracker - TranslationFactorTracker instance
   * @param {Object} messagingClient - MessagingClient instance
   * @param {Object} storage - Storage adapter (required, no default)
   */
  constructor(distributionEngine, translationFactorTracker, messagingClient, storage) {
    if (!storage) {
      throw new Error('RetroPayoutService requires a storage adapter');
    }
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

      console.log('[RetroPayoutService] Check completed:', stats);

      return stats;

    } catch (error) {
      console.error('[RetroPayoutService] Error during retro payout check:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Prüft ein einzelnes Rating auf Nachzahlungs-Bedarf
   *
   * BEDINGUNG: 3 * Summe(istTokens) < sollTokens (neu berechnet)
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

    // Raw Tokens = Score x Translation Factor
    const rawTokens = score * currentFactor;

    // Start Safety Factor (zeitbasiert)
    const daysSinceRating = Math.floor((Date.now() - rating.timestamp) / (24 * 60 * 60 * 1000));
    const startSF = this.distributionEngine.calibrationManager.calculateSafetyFactor(daysSinceRating);

    // Combined Payout Factor = (1 - startSF) x prognosisSF
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
   * Verarbeitet eine eingehende manuelle Korrektur vom Dashboard.
   *
   * Wird aus messaging-integration.js handleMessage('rating_correction') aufgerufen,
   * nachdem rating-edit-ui.js submitCorrection() im Dashboard die Korrektur per
   * E2E-Messaging an alle Devices der Gruppe gesendet hat.
   *
   * Das ist KEIN neues Rating — wir aktualisieren den existierenden Eintrag in
   * rev_rating_history_30d und queuen anschließend den Delta-Mint. Im Gegensatz
   * zum 6h-Timer wird die 3×-Schwelle übersprungen, weil eine manuelle Korrektur
   * eine explizite User-Entscheidung ist und auch kleine Deltas ausgezahlt werden
   * sollen (nur MIN_PAYOUT_TOKENS bleibt als Untergrenze).
   *
   * Idempotenz: Wenn das Rating lokal nicht existiert (z. B. anderes Device),
   * wird die Nachricht ignoriert. Doppelt zugestellte Nachrichten erzeugen keine
   * Duplikate, weil pairIndex aus existingTxs.length abgeleitet wird und der
   * tatsächliche Mint im privacyLayer.queueTransaction über ratingRef+pairIndex
   * dedupliziert ist.
   *
   * @param {Object} payload - { rating_ref, new_score, new_safety_factor, ... }
   * @returns {Promise<Object>} { applied, payoutCreated, payoutTokens, reason? }
   */
  async processCorrection(payload) {
    if (!payload || !payload.rating_ref) {
      return { applied: false, payoutCreated: false, reason: 'invalid_payload' };
    }

    const ratingRef = payload.rating_ref;
    const newScore = Number(payload.new_score);
    if (!Number.isFinite(newScore) || newScore <= 0) {
      return { applied: false, payoutCreated: false, reason: 'invalid_score' };
    }

    // 1. Finde und update das lokale Rating. Wenn es hier nicht existiert,
    // gehört die Korrektur zu einem anderen Device — Nachricht ignorieren.
    const updated = await this.tracker.updateRating(ratingRef, { score: newScore });
    if (!updated) {
      console.log('[RetroPayoutService] processCorrection: rating not found locally, ignoring', { ratingRef });
      return { applied: false, payoutCreated: false, reason: 'rating_not_local' };
    }

    console.log('[RetroPayoutService] processCorrection: rating updated', {
      ratingRef,
      newScore,
      domain: updated.domain
    });

    // 2. Berechne Soll-Tokens mit aktuellem Faktor
    const storedTransactions = await this.getStoredTransactions();
    const ratingTxs = storedTransactions.filter(tx => tx.ratingRef === ratingRef);
    const currentFactor = await this.tracker.calculateCurrentFactor();
    const userData = await this.distributionEngine.getUserData(this.storage);
    const factorHistory = await this.tracker.getFactorHistory(90);
    const prognosisSF = this.distributionEngine.prognosisModel.calculatePrognosisSF(factorHistory);

    const sollTokens = await this.calculateSollTokens(updated, currentFactor, prognosisSF, userData);

    // 3. Summe aller bisherigen Auszahlungen für dieses Rating
    const istTokensSum = ratingTxs.reduce((sum, tx) => {
      try { return sum + BigInt(tx.istTokens || '0'); } catch (_) { return sum; }
    }, 0n);

    const differenz = sollTokens - istTokensSum;

    // 4. Manuelle Korrektur: 3×-Regel überspringen, nur MIN_PAYOUT_TOKENS
    // als Untergrenze. Negative Differenz (= bereits zu viel ausgezahlt)
    // erzeugt keine Rückforderung — die alte Auszahlung bleibt stehen.
    if (differenz < this.MIN_PAYOUT_TOKENS) {
      console.log('[RetroPayoutService] processCorrection: no payout needed', {
        ratingRef,
        sollTokens: sollTokens.toString(),
        istTokensSum: istTokensSum.toString(),
        differenz: differenz.toString()
      });
      return {
        applied: true,
        payoutCreated: false,
        payoutTokens: '0',
        reason: differenz < 0n ? 'already_overpaid' : 'below_min_payout'
      };
    }

    // 5. Erstelle Korrektur-Transaktion (Delta-Mint)
    await this.createCorrectionTransaction(
      updated,
      ratingTxs,
      sollTokens,
      istTokensSum,
      differenz,
      currentFactor,
      prognosisSF
    );

    return {
      applied: true,
      payoutCreated: true,
      payoutTokens: differenz.toString()
    };
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
