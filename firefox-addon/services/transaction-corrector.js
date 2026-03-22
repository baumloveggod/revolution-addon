/**
 * Transaction Corrector
 *
 * Überwacht Änderungen im Übersetzungs-Faktor und erstellt automatisch
 * Korrektur-Transaktionen wenn die Abweichung einen Threshold überschreitet.
 *
 * Trigger: Automatisch nach jedem neuen Rating
 * Bedingung: Abweichung > 5% zwischen Soll und Ist
 */

class TransactionCorrector {
  constructor(distributionEngine, translationFactorTracker, messagingClient, storage = browser.storage.local) {
    this.distributionEngine = distributionEngine;
    this.tracker = translationFactorTracker;
    this.messagingClient = messagingClient;
    this.storage = storage;

    // Konfiguration
    this.CORRECTION_THRESHOLD = 0.05; // 5% Abweichung triggert Korrektur
    this.MIN_CORRECTION_TOKENS = 1000n; // Minimum Tokens für Korrektur (Spam-Vermeidung)
  }

  /**
   * Hauptfunktion: Prüft alle Ratings und erstellt Korrekturen bei Bedarf
   */
  async checkAndCorrectTransactions() {
    try {
      // 1. Hole alle Ratings letzten 30 Tage
      const ratings = await this.tracker.getRatingsLast30Days();

      if (ratings.length === 0) {
        return { corrected: 0, skipped: 0 };
      }

      // 2. Hole gespeicherte Transaktionen (verschlüsselt)
      const storedTransactions = await this.getStoredTransactions();

      // 3. Aktueller Übersetzungs-Faktor
      const currentFactor = await this.tracker.calculateCurrentFactor();

      // 4. Hole aktuelle Prognose-Daten
      const userData = await this.distributionEngine.getUserData(this.storage);
      const factorHistory = await this.tracker.getFactorHistory(90);
      const prognosisSF = this.distributionEngine.prognosisModel.calculatePrognosisSF(factorHistory);

      // 5. Prüfe jedes Rating auf Korrekturbedarf
      let corrected = 0;
      let skipped = 0;

      for (const rating of ratings) {
        const needsCorrection = await this.checkRatingForCorrection(
          rating,
          storedTransactions,
          currentFactor,
          prognosisSF,
          userData
        );

        if (needsCorrection) {
          corrected++;
        } else {
          skipped++;
        }
      }

      return { corrected, skipped };
    } catch (error) {
      console.error('[TransactionCorrector] Error during correction check:', error);
      throw error;
    }
  }

  /**
   * Prüft ein einzelnes Rating auf Korrekturbedarf
   *
   * @returns {boolean} True wenn Korrektur erstellt wurde
   */
  async checkRatingForCorrection(rating, storedTransactions, currentFactor, prognosisSF, userData) {
    // Hole alle Transaktionen für dieses Rating
    const ratingTxs = storedTransactions.filter(tx => tx.ratingRef === rating.ratingRef);

    // Berechne Soll-Tokens (neu mit aktuellem Faktor)
    const sollTokens = await this.calculateSollTokens(rating, currentFactor, prognosisSF, userData);

    // Summe aller bisherigen Ist-Auszahlungen
    const istTokensSum = ratingTxs.reduce((sum, tx) => {
      const tokens = BigInt(tx.istTokens || '0');
      return sum + tokens;
    }, 0n);

    // Differenz
    const differenz = sollTokens - istTokensSum;
    const deviation = Number(differenz) / Number(sollTokens);

    // Prüfe ob Korrektur nötig ist
    if (Math.abs(deviation) > this.CORRECTION_THRESHOLD && differenz > this.MIN_CORRECTION_TOKENS) {
      await this.createCorrectionTransaction(
        rating,
        differenz,
        sollTokens,
        istTokensSum,
        currentFactor,
        prognosisSF
      );
      return true;
    }

    return false;
  }

  /**
   * Berechnet Soll-Tokens für ein Rating mit aktuellem Faktor
   */
  async calculateSollTokens(rating, translationFactor, prognosisSF, userData) {
    // Berechne Start-Sicherheits-Faktor basierend auf daysSinceStart
    const firstTrackingDate = new Date(userData.firstTrackingDate);
    const ratingDate = new Date(rating.date);
    const daysSinceStart = Math.floor((ratingDate.getTime() - firstTrackingDate.getTime()) / (24 * 60 * 60 * 1000));

    const startSF = this.distributionEngine.calculateSafetyFactor(daysSinceStart);
    const payoutFactor = 1.0 - startSF;

    // Kombinierter Payout-Faktor
    const combinedPayoutFactor = payoutFactor * prognosisSF;

    // Token-Berechnung
    const scoreBigInt = BigInt(Math.floor(rating.score));
    const rawTokens = scoreBigInt * translationFactor;
    const sollTokens = BigInt(Math.floor(Number(rawTokens) * combinedPayoutFactor));

    return sollTokens;
  }

  /**
   * Erstellt eine Korrektur-Transaktion
   */
  async createCorrectionTransaction(rating, differenz, sollTokens, istTokensSum, currentFactor, prognosisSF) {
    const transaction = {
      type: 'correction',
      ratingRef: rating.ratingRef,
      domain: rating.domain,
      score: rating.score,
      timestamp: new Date().toISOString(),
      sollTokens: sollTokens.toString(),
      istTokens: differenz.toString(), // Nur die Differenz auszahlen
      differenz: '0', // Nach dieser Tx ist Differenz 0
      cumulativeTokens: (istTokensSum + differenz).toString(),
      translationFactor: currentFactor.toString(),
      prognosisSafetyFactor: prognosisSF
    };

    // 1. Lokal speichern (verschlüsselt)
    await this.storeTransaction(transaction);

    // 2. Via Messaging senden (falls MessagingClient verfügbar)
    if (this.messagingClient) {
      try {
        // Send correction transaction as 'rating' type (corrections are special rating transactions)
        await this.messagingClient.sendMessage(transaction, 'rating');
      } catch (error) {
        console.warn('[TransactionCorrector] Failed to send correction via messaging:', error);
        // Nicht kritisch, Transaktion ist lokal gespeichert
      }
    }
  }

  /**
   * Holt gespeicherte Transaktionen aus Storage
   */
  async getStoredTransactions() {
    const data = await this.storage.get(['rev_stored_transactions']);
    return data.rev_stored_transactions || [];
  }

  /**
   * Speichert Transaktion lokal (verschlüsselt)
   */
  async storeTransaction(transaction) {
    const data = await this.storage.get(['rev_stored_transactions']);
    const transactions = data.rev_stored_transactions || [];

    // Füge neue Transaktion hinzu
    transactions.push(transaction);

    // Bereinige alte Transaktionen (>90 Tage)
    const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
    const cleaned = transactions.filter(tx => {
      const txDate = new Date(tx.timestamp).getTime();
      return txDate > cutoff;
    });

    await this.storage.set({ rev_stored_transactions: cleaned });
  }

  /**
   * Gibt Statistiken über Korrekturen zurück (für Debugging/UI)
   */
  async getCorrectionStats() {
    const transactions = await this.getStoredTransactions();

    const corrections = transactions.filter(tx => tx.type === 'correction');
    const initial = transactions.filter(tx => tx.type === 'payment' || tx.type === 'initial');

    const totalCorrections = corrections.reduce((sum, tx) => {
      return sum + BigInt(tx.istTokens || '0');
    }, 0n);

    return {
      totalTransactions: transactions.length,
      corrections: corrections.length,
      initial: initial.length,
      totalCorrectionTokens: totalCorrections.toString(),
      avgCorrectionTokens: corrections.length > 0
        ? (totalCorrections / BigInt(corrections.length)).toString()
        : '0'
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.TransactionCorrector = TransactionCorrector;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TransactionCorrector;
}
