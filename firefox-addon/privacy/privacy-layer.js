/**
 * Privacy Layer - Integration
 *
 * Kombiniert:
 * - E24-Standardisierung
 * - Transaction-Queue mit Batching
 * - Random Delays
 * - Rundungsfehler-Tracking
 *
 * WICHTIG: URLs werden NIEMALS übertragen!
 * Nur Scores werden synchronisiert (verschlüsselt via messaging-service)
 */

class PrivacyLayer {
  constructor(config, e24Rounding, transactionQueue) {
    this.config = config;
    this.e24Rounding = e24Rounding;
    this.transactionQueue = transactionQueue;
  }

  /**
   * Standardisiert Token-Menge (E24)
   */
  standardizeTokenAmount(amount, domain = null) {
    return this.e24Rounding.standardizeAmount(amount, domain);
  }

  /**
   * Fügt Transaktion zur Queue hinzu
   */
  async queueTransaction(transaction) {
    await this.transactionQueue.queueTransaction(transaction);
  }

  /**
   * Prüft ob Rundungsfehler-Korrektur nötig ist
   */
  checkRoundingErrorCorrections() {
    const corrections = [];

    for (const [domain, error] of this.e24Rounding.roundingErrors.entries()) {
      if (this.e24Rounding.shouldCorrectRoundingError(domain)) {
        const correction = this.e24Rounding.createCorrectionTransaction(domain);
        if (correction) {
          corrections.push(correction);
        }
      }
    }

    return corrections;
  }

  /**
   * Führt Rundungsfehler-Korrekturen aus
   */
  async executeRoundingErrorCorrections() {
    const corrections = this.checkRoundingErrorCorrections();

    for (const correction of corrections) {
      await this.queueTransaction(correction);
    }

    return corrections.length;
  }

  /**
   * Erstellt Privacy-sicheres Sync-Objekt
   * KEINE URLs! Nur Scores!
   */
  createSyncData(scoringResult) {
    return {
      score: scoringResult.score,
      timestamp: scoringResult.metadata.timestamp,
      domain: this.hashDomain(scoringResult.metadata.domain), // Gehashed!
      configVersion: this.config.version
    };
  }

  /**
   * Hash-Funktion für Domains (Privacy)
   * Verhindert dass Domain-Namen übertragen werden
   */
  hashDomain(domain) {
    // Einfacher Hash (für Production: kryptographischer Hash!)
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      const char = domain.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `domain_${Math.abs(hash).toString(16)}`;
  }

  /**
   * Setzt Execution-Callback für Queue
   */
  setTransactionExecutor(executor) {
    this.transactionQueue.setExecutionCallback(executor);
  }

  /**
   * Forciert sofortige Batch-Ausführung
   */
  async forceExecuteBatch() {
    await this.transactionQueue.forceExecute();
  }

  /**
   * Holt Privacy-Statistiken
   */
  getPrivacyStatistics() {
    const queueStats = this.transactionQueue.getStatistics();
    const roundingErrors = this.e24Rounding.exportRoundingErrors();

    return {
      queue: queueStats,
      roundingErrors: roundingErrors,
      e24Enabled: true,
      batchingEnabled: true
    };
  }

  /**
   * Persistiert Privacy-State
   */
  async saveState(storage = browser.storage.local) {
    const roundingErrors = this.e24Rounding.exportRoundingErrors();

    await storage.set({
      'rev_privacy_rounding_errors': roundingErrors
    });

    await this.transactionQueue.saveQueue(storage);
  }

  /**
   * Lädt Privacy-State
   */
  async loadState(storage = browser.storage.local) {
    const data = await storage.get(['rev_privacy_rounding_errors']);

    if (data.rev_privacy_rounding_errors) {
      this.e24Rounding.importRoundingErrors(data.rev_privacy_rounding_errors);
    }

    await this.transactionQueue.loadQueue(storage);
  }

  /**
   * Monatsende: Reset Rundungsfehler
   */
  resetMonthly() {
    this.e24Rounding.resetRoundingErrors();
  }
}

// Factory Function
function createPrivacyLayer(config) {
  const e24Rounding = new window.E24Rounding(config);
  const transactionQueue = new window.TransactionQueue(config, e24Rounding);

  // NEU: Auto-inject wallet dependencies wenn verfügbar
  if (window._walletManager && window._anonClient) {
    const messagingClient = window.MessagingIntegration?.getClient();
    const translationFactorTracker = window._translationFactorTracker || null;
    const distributionEngine = window._distributionEngine || null;
    transactionQueue.setDependencies({
      walletManager: window._walletManager,
      anonClient: window._anonClient,
      messagingClient: messagingClient,
      translationFactorTracker: translationFactorTracker,
      distributionEngine: distributionEngine
    });
  }

  return new PrivacyLayer(config, e24Rounding, transactionQueue);
}

/**
 * Helper function to inject wallet dependencies globally
 * Called from background.js after wallet initialization
 */
function injectWalletDependencies(deps) {
  window._walletDependencies = deps;

  // Inject into existing PrivacyLayer instances (via RevolutionScoring)
  if (typeof window.getRevolutionScoring === 'function') {
    const revolution = window.getRevolutionScoring();
    if (revolution && revolution.privacyLayer) {
      // Füge translationFactorTracker und distributionEngine hinzu (falls nicht schon in deps)
      const depsWithTracker = {
        ...deps,
        translationFactorTracker: deps.translationFactorTracker || window._translationFactorTracker || null,
        distributionEngine: deps.distributionEngine || revolution.distributionEngine || null
      };
      revolution.privacyLayer.transactionQueue.setDependencies(depsWithTracker);
    }
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.PrivacyLayer = PrivacyLayer;
  window.createPrivacyLayer = createPrivacyLayer;
  window.injectWalletDependencies = injectWalletDependencies;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PrivacyLayer,
    createPrivacyLayer
  };
}
