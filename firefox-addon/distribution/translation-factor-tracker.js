/**
 * Translation Factor Tracker
 *
 * Verwaltet die user-spezifische Übersetzungs-Faktor-Berechnung
 * und historische Tracking-Daten für Prognose-Algorithmen.
 *
 * Formel: Übersetzungs-Faktor = 10^16 / (Summe aller Ratings letzten 30 Tage)
 * Erste 30 Tage: Faktor × (secondsSinceBaToCL / (30 * 24 * 60 * 60))
 *
 * Storage Keys:
 * - rev_rating_history_30d: [{date, score, domain, ratingRef}, ...]
 * - rev_translation_factor_history: [{timestamp, factor, totalScore}, ...]
 * - rev_first_ba_to_cl_timestamp: Unix timestamp (seconds) of first BA→CL transfer
 */

class TranslationFactorTracker {
  constructor(storage = browser.storage.local) {
    this.storage = storage;
    this.BUDGET_TOKENS = 10n ** 16n; // 10^16 tokens per user per 30 days
    this.HISTORY_DAYS = 30;
    this.FACTOR_HISTORY_DAYS = 90; // Für Prognose-Algorithmus
  }

  /**
   * Fügt ein neues Rating zur Historie hinzu
   * Entfernt automatisch alte Ratings (>30 Tage)
   *
   * @param {number} score - Rating-Score
   * @param {string} domain - Domain
   * @param {string} ratingRef - Eindeutige Rating-Referenz
   * @param {number} timestamp - Zeitstempel (optional, default: jetzt)
   */
  async addRating(score, domain, ratingRef, timestamp = Date.now()) {
    const data = await this.storage.get(['rev_rating_history_30d']);
    let history = data.rev_rating_history_30d || [];

    // Neues Rating hinzufügen
    history.push({
      date: timestamp,
      score: score,
      domain: domain,
      ratingRef: ratingRef
    });

    // Alte Ratings entfernen (>30 Tage)
    const cutoff = timestamp - (this.HISTORY_DAYS * 24 * 60 * 60 * 1000);
    history = history.filter(r => r.date > cutoff);

    // Speichern
    await this.storage.set({ rev_rating_history_30d: history });

    // Faktor-Snapshot speichern (täglich)
    await this.saveDailyFactorSnapshot();

  }

  /**
   * Holt alle Ratings der letzten 30 Tage
   *
   * @returns {Promise<Array>} Ratings [{date, score, domain, ratingRef}, ...]
   */
  async getRatingsLast30Days() {
    const data = await this.storage.get(['rev_rating_history_30d']);
    const history = data.rev_rating_history_30d || [];

    // Sicherheitscheck: Nur Ratings letzten 30 Tage
    const cutoff = Date.now() - (this.HISTORY_DAYS * 24 * 60 * 60 * 1000);
    return history.filter(r => r.date > cutoff);
  }

  /**
   * Berechnet den aktuellen Übersetzungs-Faktor
   *
   * Formel: 10^16 / (Summe aller Ratings letzten 30 Tage)
   * Erste 30 Tage: baseFactor × (secondsSinceBaToCL / (30 * 24 * 60 * 60))
   *
   * @returns {Promise<bigint>} Translation Factor (BigInt)
   */
  async calculateCurrentFactor() {
    const ratings = await this.getRatingsLast30Days();

    // Summe aller Scores
    const totalScore = ratings.reduce((sum, r) => sum + (r.score || 0), 0);

    // Fallback: Keine Ratings → Faktor = 0 (keine Basis für Berechnung)
    if (totalScore === 0) {
      console.warn('[TranslationFactorTracker] No ratings in last 30 days, factor = 0');
      return 0n; // Kein Faktor ohne Ratings
    }

    // Berechne Basis-Faktor: 10^16 / totalScore
    const baseFactor = this.BUDGET_TOKENS / BigInt(Math.floor(totalScore));

    // Zeitbasierte Dämpfung für erste 30 Tage
    const firstTransferTimestamp = await this.getFirstBaToCLTimestamp();

    if (firstTransferTimestamp === null) {
      return 0n;
    }

    const now = Date.now(); // Millisekunden (konsistent mit Website)
    const millisSinceFirstTransfer = now - (firstTransferTimestamp * 1000); // firstTransferTimestamp ist in Sekunden
    const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000; // Millisekunden

    // timeMultiplier: 0.0 → 1.0 über 30 Tage
    const timeMultiplier = Math.min(1.0, millisSinceFirstTransfer / thirtyDaysInMillis);

    // Finaler Faktor mit Dämpfung
    const dampedFactor = BigInt(Math.floor(Number(baseFactor) * timeMultiplier));

    return dampedFactor;
  }

  /**
   * Speichert den Timestamp des ersten BA→CL Transfers
   * Wird nur einmal gesetzt (erste Transaktion)
   *
   * @param {number} timestamp - Unix timestamp in Sekunden
   */
  async recordFirstBaToCLTransfer(timestamp) {
    const existing = await this.getFirstBaToCLTimestamp();

    if (existing !== null) {
      // Bereits gesetzt, nicht überschreiben
      return;
    }

    await this.storage.set({ rev_first_ba_to_cl_timestamp: timestamp });
  }

  /**
   * Holt den Timestamp des ersten BA→CL Transfers
   *
   * @returns {Promise<number|null>} Unix timestamp in Sekunden, oder null falls nicht gesetzt
   */
  async getFirstBaToCLTimestamp() {
    const data = await this.storage.get(['rev_first_ba_to_cl_timestamp']);
    return data.rev_first_ba_to_cl_timestamp || null;
  }

  /**
   * Prüft ob ein BA→CL Transfer existiert
   * Unterscheidet zwischen:
   * - null: Kein Transfer vorhanden (Rating verwerfen)
   * - Error: Central Ledger nicht erreichbar (Rating pausieren)
   *
   * @param {Object} walletManager - WalletManager Instanz für CL-Abfrage
   * @returns {Promise<{exists: boolean, shouldPause: boolean, error: string|null}>}
   */
  async checkBaToCLTransferExists(walletManager) {
    try {
      // 1. Prüfe ob Timestamp bereits im Storage ist
      const existingTimestamp = await this.getFirstBaToCLTimestamp();
      if (existingTimestamp !== null) {
        return { exists: true, shouldPause: false, error: null };
      }

      // 2. Versuche Timestamp vom Central Ledger zu holen
      if (!walletManager) {
        // WalletManager not injected yet - this is a temporary state during initialization
        console.warn('[TranslationFactorTracker] WalletManager not available yet');
        return { exists: false, shouldPause: false, error: 'WalletManager not initialized yet' };
      }

      // 3. Hole CL-Wallet-Adresse
      const wallet = await walletManager.getLocalWallet();
      if (!wallet || !wallet.address) {
        // Wallet not initialized yet - this is a temporary state during startup
        // Don't pause scoring, just skip the BA→CL check for now
        console.warn('[TranslationFactorTracker] CL wallet not initialized yet');
        return { exists: false, shouldPause: false, error: 'CL wallet not initialized yet' };
      }

      const detected = await walletManager.detectAndRecordFirstBaTransfer(wallet.address, this);

      if (detected) {
        // Transfer gefunden und gesetzt
        return { exists: true, shouldPause: false, error: null };
      } else {
        // Kein Transfer gefunden (aber CL erreichbar)
        return { exists: false, shouldPause: false, error: 'No BA→CL transfer found' };
      }

    } catch (error) {
      // Central Ledger nicht erreichbar oder anderer Fehler
      console.error('[TranslationFactorTracker] Failed to check BA→CL transfer:', error);

      // Only pause if this is a real CL connectivity error, not a wallet initialization issue
      const isInitializationError = error.message.includes('not available') ||
                                     error.message.includes('not initialized');

      return {
        exists: false,
        shouldPause: !isInitializationError,
        error: `Central Ledger error: ${error.message}`
      };
    }
  }

  /**
   * Holt historische Faktor-Snapshots für Prognose-Algorithmus
   *
   * @param {number} days - Anzahl Tage zurück (default: 90)
   * @returns {Promise<Array>} Faktor-Historie [{timestamp, factor, totalScore}, ...]
   */
  async getFactorHistory(days = this.FACTOR_HISTORY_DAYS) {
    const data = await this.storage.get(['rev_translation_factor_history']);
    let history = data.rev_translation_factor_history || [];

    // Nur Snapshots der letzten X Tage
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    history = history.filter(h => h.timestamp > cutoff);

    // Sortiere chronologisch (älteste zuerst)
    history.sort((a, b) => a.timestamp - b.timestamp);

    return history;
  }

  /**
   * Speichert einen Faktor-Snapshot (täglich)
   * Verhindert Duplikate am selben Tag
   */
  async saveDailyFactorSnapshot() {
    const data = await this.storage.get(['rev_translation_factor_history']);
    let history = data.rev_translation_factor_history || [];

    const now = Date.now();
    const today = new Date(now).toDateString(); // "Mon Jan 01 2025"

    // Prüfe ob heute bereits ein Snapshot existiert
    const hasToday = history.some(h => new Date(h.timestamp).toDateString() === today);

    if (hasToday) {
      return; // Bereits vorhanden
    }

    // Berechne aktuellen Faktor
    const currentFactor = await this.calculateCurrentFactor();
    const ratings = await this.getRatingsLast30Days();
    const totalScore = ratings.reduce((sum, r) => sum + (r.score || 0), 0);

    // Neuer Snapshot
    history.push({
      timestamp: now,
      factor: Number(currentFactor), // Als Number für Prognose-Algorithmus
      totalScore: totalScore
    });

    // Alte Snapshots entfernen (>90 Tage)
    const cutoff = now - (this.FACTOR_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    history = history.filter(h => h.timestamp > cutoff);

    // Speichern
    await this.storage.set({ rev_translation_factor_history: history });
  }

  /**
   * Berechnet Statistiken über den Faktor-Verlauf
   * Nützlich für Debugging und UI
   *
   * @returns {Promise<Object>} Stats {current, min, max, avg, trend}
   */
  async getFactorStats() {
    const history = await this.getFactorHistory(30); // Letzte 30 Tage

    if (history.length === 0) {
      return {
        current: 0,
        min: 0,
        max: 0,
        avg: 0,
        trend: 0
      };
    }

    const factors = history.map(h => h.factor);
    const currentFactor = await this.calculateCurrentFactor();

    const stats = {
      current: Number(currentFactor),
      min: Math.min(...factors),
      max: Math.max(...factors),
      avg: factors.reduce((s, f) => s + f, 0) / factors.length,
      trend: 0
    };

    // Trend-Berechnung (Steigung letzten 7 Tage vs. vorherige 7 Tage)
    if (history.length >= 14) {
      const recent7 = factors.slice(-7);
      const prev7 = factors.slice(-14, -7);

      const recentAvg = recent7.reduce((s, f) => s + f, 0) / 7;
      const prevAvg = prev7.reduce((s, f) => s + f, 0) / 7;

      stats.trend = ((recentAvg - prevAvg) / prevAvg) * 100; // % Änderung
    }

    return stats;
  }

  /**
   * Bereinigt alte Daten (nützlich für Debugging)
   */
  async clearOldData() {
    await this.storage.remove(['rev_rating_history_30d', 'rev_translation_factor_history']);
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.TranslationFactorTracker = TranslationFactorTracker;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TranslationFactorTracker;
}
