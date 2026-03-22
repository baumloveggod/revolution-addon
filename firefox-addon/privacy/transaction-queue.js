/**
 * Transaction Queue mit Privacy-Features
 *
 * Features:
 * - Batch-Queue (sammelt Transaktionen)
 * - Random Delays (zeitliche Verschleierung)
 * - Shuffle (Reihenfolge randomisieren)
 * - E24-Integration
 *
 * Privacy-Modelle:
 * 1. Fixed Interval: Alle X Stunden
 * 2. Dynamic Batch: Mindestens N Transaktionen
 * 3. Hybrid: X Stunden ODER N Transaktionen
 */

class TransactionQueue {
  constructor(config, e24Rounding) {
    this.config = config;
    this.e24Rounding = e24Rounding;
    this.queue = [];
    this.pendingQueue = []; // NEW: Queue for transactions waiting for wallet
    this.mintBuffer = [];   // Phase-1 buffer: minted notes waiting for period end before spend
    this.spendTimer = null; // Single timer for the next batch of due spends
    this.batchTimer = null;
    this.onExecute = null; // Callback für Transaktion-Ausführung

    // NEU: Dependencies für anonyme Transaktionen
    this.walletManager = null;
    this.anonClient = null;
    this.messagingClient = null;
    this.translationFactorTracker = null;

    // Retry configuration for CL wallet initialization
    this.retryConfig = {
      maxRetries: 5,           // Maximum number of retry attempts
      initialDelayMs: 500,     // Initial delay in ms (exponential backoff)
      backoffMultiplier: 2     // Multiply delay by this factor each retry
    };

    // NEW: Watchdog timer for stuck transactions
    this.watchdogTimer = setInterval(() => {
      this._checkPendingQueue();
    }, 30000); // Check every 30 seconds
  }

  /**
   * Fügt Transaktion zur Queue hinzu
   *
   * @param {Object} transaction - Transaktion
   * @param {string} transaction.domain - Ziel-Domain
   * @param {BigInt} transaction.tokens - Token-Menge
   * @param {string} transaction.type - Transaktions-Typ
   */
  async queueTransaction(transaction) {
    // E24-Standardisierung (falls noch nicht geschehen)
    if (!transaction.standardized) {
      const standardizedTokens = this.e24Rounding.standardizeAmount(
        transaction.tokens,
        transaction.domain
      );

      transaction = {
        ...transaction,
        tokens: standardizedTokens,
        originalTokens: transaction.tokens,
        standardized: true,
        queuedAt: Date.now()
      };
    }

    // In Queue einfügen
    this.queue.push(transaction);

    // Batch-Logik triggern
    this.triggerBatchIfNeeded();
  }

  /**
   * Triggert Batch-Ausführung — Mint (Phase 1) wird sofort ausgeführt.
   * Die Privacy liegt in Phase 2: Spend erst nach Block-Versiegelung.
   */
  triggerBatchIfNeeded() {
    // Sofort ausführen (im nächsten Event Loop Tick für Async-Safety)
    setTimeout(() => {
      this.executeBatch();
    }, 0);
  }

  /**
   * Führt Batch aus
   */
  async executeBatch() {
    if (this.queue.length === 0) {
      return;
    }

    // 1. Kopiere Queue
    const batch = [...this.queue];

    // 2. Leere Queue
    this.queue = [];

    // 3. Shuffle für zusätzliche Privacy
    this.shuffleArray(batch);

    // 4. Führe Transaktionen aus
    for (const transaction of batch) {
      await this.executeTransaction(transaction);
    }
  }

  /**
   * Führt anonyme Blockchain-Transaktion aus (CL → SH → DS)
   *
   * Flow:
   * 1. Holt CL Wallet
   * 2. Prüft Balance
   * 3. Mint Anonymous Note (CL → SH)
   * 4. Spend Anonymous Note (SH → DS)
   * 5. Sendet Rating Message mit Fingerprint
   *
   * @param {Object} transaction - Transaction from queue
   */
  async executeTransaction(transaction) {
    try {
      // ZERO-KNOWLEDGE GUARD: Check if device is properly linked before executing transaction
      if (!this._isDeviceLinked()) {
        console.warn('[TransactionQueue] ⚠️ Device not linked - transaction blocked', {
          domain: transaction.domain,
          tokens: transaction.tokens.toString()
        });
        this._queuePendingTransaction(transaction);
        return;
      }

      // NEW: Check for dependencies (including auto-injection from global scope)
      if (!this._checkDependencies()) {
        this._queuePendingTransaction(transaction);
        return;
      }

      // Fallback: Callback-System (if still no dependencies after check)
      if (!this.walletManager || !this.anonClient) {
        if (this.onExecute) {
          await this.onExecute(transaction);
          return;
        } else {
          console.warn('[TransactionQueue] No wallet dependencies or callback set');
          return;
        }
      }

      // 1. Get CL Wallet with retry mechanism
      const clWallet = await this._getClWalletWithRetry();

      if (!clWallet) {
        const errorContext = {
          storageKey: 'rev_cl_wallet',
          possibleCauses: [
            'ADDRESS_UPDATE message not received from website',
            'Website failed to register with messaging service',
            'Device not fully initialized or linked',
            'Messaging service connection issues'
          ],
          debugSteps: [
            'Check browser console for ADDRESS_UPDATE message receipt',
            'Verify website keys were registered (check server-api logs)',
            'Check messaging service health (port 4200)',
            'Verify device is linked and has valid session'
          ],
          storageCheck: 'Run: browser.storage.local.get("rev_cl_wallet") to verify',
          retriesAttempted: this.retryConfig.maxRetries
        };
        console.error('[TransactionQueue] ❌ Step 1 FAILED: CL wallet not found after all retries');
        console.error('[TransactionQueue] 🔍 Diagnostic info:', errorContext);
        throw new Error(`CL wallet not initialized after ${this.retryConfig.maxRetries} retries. Possible causes: ${errorContext.possibleCauses.join(', ')}. Check console for diagnostic info.`);
      }

      // 2. Check Balance
      let balance;
      try {
        balance = await this.walletManager.getBalance(clWallet.address);
      } catch (error) {
        // Central Ledger API ist nicht erreichbar
        if (error.code === 'CL_API_UNREACHABLE' || error.code === 'CL_API_CONNECTION_FAILED') {
          console.error('[TransactionQueue] Central Ledger API is down, cannot check balance');
          throw new Error(
            `Cannot execute transaction: Central Ledger API is not reachable. ` +
            `Please ensure the service is running.`
          );
        }
        // Andere Fehler weiterwerfen
        throw error;
      }

      // 2b. Prüfe und setze ersten BA→CL Transfer Timestamp (für Zeit-Dämpfung)
      if (this.translationFactorTracker && this.walletManager) {
        try {
          await this.walletManager.detectAndRecordFirstBaTransfer(
            clWallet.address,
            this.translationFactorTracker
          );
        } catch (error) {
          // Fehler nicht weiterwerfen, nur loggen
          console.warn('[TransactionQueue] Failed to detect BA transfer:', error.message);
        }
      } else {
        console.warn('[TransactionQueue] Cannot detect BA transfer - missing dependencies:', {
          hasTranslationFactorTracker: !!this.translationFactorTracker,
          hasWalletManager: !!this.walletManager
        });
      }

      const tokensNeeded = BigInt(transaction.tokens);

      if (balance < tokensNeeded) {
        throw new Error(`Insufficient balance: ${balance.toString()} < ${tokensNeeded.toString()} - clWallet.address : ${clWallet.address}`);
      }

      // 3. PRE-VALIDATION: Check if SH→DS spend will be possible BEFORE minting
      // This prevents tokens from getting stuck in SH pool

      // 3a. Check for pending wallet address (local validation)
      if (transaction.walletAddress?.startsWith('pending:')) {
        console.error('[TransactionQueue] ❌ Step 3 BLOCKED: Cannot spend to pending wallet address!');
        throw new Error(`Invalid destination wallet: ${transaction.walletAddress} - Domain not registered. Mint aborted to prevent tokens stuck in SH pool.`);
      }

      // 3b. Check destination format
      const isValidDestinationFormat = transaction.walletAddress?.startsWith('DS::') || transaction.walletAddress?.startsWith('OR::');
      if (!isValidDestinationFormat) {
        console.error('[TransactionQueue] ❌ Step 3 BLOCKED: Invalid destination format!');
        throw new Error(`Invalid destination format: ${transaction.walletAddress} - Must be DS:: or OR:: wallet. Mint aborted.`);
      }

      // 3c. Verify DS wallet is registered in Central Ledger (remote validation)
      // Retry once after 600ms to handle race condition where wallet was just registered
      // and the read store hasn't replicated it yet.
      try {
        let registrationCheck = await this.anonClient.checkWalletRegistration(transaction.walletAddress);
        if (!registrationCheck.registered) {
          await new Promise(resolve => setTimeout(resolve, 600));
          registrationCheck = await this.anonClient.checkWalletRegistration(transaction.walletAddress);
        }
        if (!registrationCheck.registered) {
          console.error('[TransactionQueue] ❌ Step 3c BLOCKED: DS wallet not registered in Central Ledger!', {
            walletAddress: transaction.walletAddress
          });
          throw new Error(`DS wallet not registered in Central Ledger: ${transaction.walletAddress}. Mint aborted to prevent tokens stuck in SH pool.`);
        }
      } catch (error) {
        // If it's our own error, re-throw it
        if (error.message.includes('not registered')) {
          throw error;
        }
        // For network errors, log warning but continue (allow graceful degradation)
        console.warn('[TransactionQueue] ⚠️ Step 3c: Could not verify DS wallet registration (network issue?):', error.message);
      }

      // 3.5. Generiere Fingerprints für dieses Transaktionspaar VOR dem Mint
      const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });
      const { fingerprintCLtoSH, fingerprintSHtoDS } =
        await seedManager.generateTransactionPairFingerprints(
          transaction.ratingRef,
          transaction.pairIndex
        );

      // 3.7. New-wallet timing protection: delay mint to break DS registration correlation
      if (transaction.isNewWallet) {
        const minDelayMs = 2 * 60 * 1000;   // 2 minutes
        const maxDelayMs = 15 * 60 * 1000;  // 15 minutes
        const delayMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
        await this._sleep(delayMs);
      }

      // 4. Mint Anonymous Note (CL → SH) — Phase 1
      const { serial, signature, amount, blockId } = await this.anonClient.mintAnonNote(
        clWallet,
        tokensNeeded,
        fingerprintCLtoSH
      );

      // 5. Buffer the spend — it will be executed in Phase 2 after block is sealed
      const mintEntry = {
        serial,
        signature,
        amount,
        destination: transaction.walletAddress,
        fingerprintSHtoDS,
        blockId, // Block must be sealed before spend
        // metadata for post-spend bookkeeping
        _seedManager: seedManager,
        _ratingRef: transaction.ratingRef,
        _pairIndex: transaction.pairIndex,
        _fingerprintCLtoSH: fingerprintCLtoSH
      };
      this.mintBuffer.push(mintEntry);

      // 5a. Continuously stream mint entry to website for device-loss recovery
      this._streamMintEntryToWebsite(mintEntry).catch(err => {
        console.warn('[TransactionQueue] ⚠️ Failed to stream mint entry to website (non-blocking):', err.message);
      });

      this._startBlockPollingIfNeeded();

    } catch (error) {
      console.error('[TransactionQueue] Transaction execution failed:', error);

      // Retry Logic
      transaction.attempts = (transaction.attempts || 0) + 1;
      transaction.error = error.message;

      if (transaction.attempts < 3) {
        // Retry mit Exponential Backoff
        const baseDelay = 5 * 60 * 1000; // 5 minutes
        const backoffMultiplier = Math.pow(2, transaction.attempts - 1);
        const delay = baseDelay * backoffMultiplier;

        // Re-queue transaction
        transaction.queuedAt = Date.now() + delay;
        this.queue.push(transaction);

      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Block-based spend scheduling & batched execution
  // ---------------------------------------------------------------------------

  /**
   * Starts the block polling interval if not already running.
   * Polls every 10 minutes to check if any blocks in mintBuffer are sealed.
   */
  _startBlockPollingIfNeeded() {
    if (this.mintBuffer.length === 0) return;
    if (this.spendTimer) return; // already polling

    const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

    this.spendTimer = setInterval(() => {
      this._pollSealedBlocks();
    }, POLL_INTERVAL_MS);

    // Also check immediately in case block was already sealed during mint
    this._pollSealedBlocks();
  }

  /**
   * Polls all unique blockIds in mintBuffer.
   * Executes a shuffled spend batch for each sealed block.
   */
  async _pollSealedBlocks() {
    if (this.mintBuffer.length === 0) {
      this._stopBlockPolling();
      return;
    }

    // Collect unique blockIds
    const blockIds = [...new Set(this.mintBuffer.map(e => e.blockId).filter(Boolean))];

    for (const blockId of blockIds) {
      try {
        const { canSpend, status } = await this.anonClient.checkBlockStatus(blockId);

        if (canSpend) {
          // Extract all entries for this block
          const due = this.mintBuffer.filter(e => e.blockId === blockId);
          this.mintBuffer = this.mintBuffer.filter(e => e.blockId !== blockId);

          await this._executeSealedBlockSpends(due, blockId);
        }
      } catch (error) {
        console.error('[TransactionQueue] ❌ Block status poll failed:', error.message, { blockId });
      }
    }

    // Stop polling if nothing left to spend
    if (this.mintBuffer.length === 0) {
      this._stopBlockPolling();
    }
  }

  /**
   * Stops the block polling interval.
   */
  _stopBlockPolling() {
    if (this.spendTimer) {
      clearInterval(this.spendTimer);
      this.spendTimer = null;
    }
  }

  /**
   * Executes a shuffled spend batch for a sealed block.
   * Failed entries are re-buffered and polling continues.
   */
  async _executeSealedBlockSpends(due, blockId) {
    if (due.length === 0) return;

    // Shuffle — core privacy property: server sees N spends arrive together
    // in random order, unlinked from the earlier N mints.
    this.shuffleArray(due);

    for (const entry of due) {
      try {
        const { txHash: clTxHash } = await this.anonClient.spendAnonNote(
          entry.serial,
          entry.signature,
          entry.amount,
          entry.destination,
          entry.fingerprintSHtoDS
        );

        // Post-spend bookkeeping
        const dsTxHash = clTxHash;
        await entry._seedManager.addTransactionPair(
          entry._ratingRef,
          entry._pairIndex,
          clTxHash,
          dsTxHash,
          entry._pairIndex === 0 ? 'initial' : 'correction'
        );
      } catch (error) {
        console.error('[TransactionQueue] ❌ Phase 2: Spend failed, re-buffering for retry:', error.message, {
          destination: entry.destination,
          blockId: entry.blockId
        });
        // Re-buffer — block is already sealed so next poll will retry immediately
        this.mintBuffer.push(entry);
        this._startBlockPollingIfNeeded();
      }
    }

  }

  // DEPRECATED: sendRatingMessage() has been moved to background.js
  // Rating messages are now sent immediately after scoring, independent of transaction execution
  // This ensures rating data arrives at website even if transaction fails or is delayed

  /**
   * DEPRECATED: Moved to background.js
   * Sendet seed-basierte Rating Messages (RATING_FULL + RATING_SUMMARY)
   *
   * @param {Object} transaction - Transaction object
   * @param {Object} seedObj - Seed object mit beiden Seeds
   * @deprecated Rating messages are now sent immediately after scoring in background.js
   */
  async sendSeedBasedRatingMessages() {
    // Deprecated: rating messages are now sent in background.js
  }

  /**
   * Get website messaging public key from group keys
   * @returns {string|null} Website public key (base64) or null if not found
   * @private
   */
  async _getWebsiteMessagingPublicKey() {
    if (!this.messagingClient || !this.messagingClient.groupKeys) {
      return null;
    }

    const groupKeys = this.messagingClient.groupKeys;
    const selfFingerprint = this.messagingClient.fingerprint;

    // ROLE-BASED: Suche nach Key mit role="admin" (Website)
    for (const [fingerprint, keyData] of Object.entries(groupKeys)) {
      if (fingerprint !== selfFingerprint && keyData.role === 'admin') {
        return keyData.publicKey;
      }
    }

    // Fallback: Erstes Gruppenmitglied außer Self (für Backward Compatibility)
    const fingerprints = Object.keys(groupKeys).filter(fp => fp !== selfFingerprint);
    if (fingerprints.length > 0) {
      const fallbackKey = groupKeys[fingerprints[0]];
      console.warn('[TransactionQueue] ⚠️ No admin key found, using fallback:', fingerprints[0].substring(0, 16) + '...');
      return fallbackKey?.publicKey || null;
    }

    return null;
  }

  /**
   * Get website fingerprint from group keys
   * @returns {string|null} Website fingerprint or null if not found
   * @private
   */
  async _getWebsiteFingerprint() {
    if (!this.messagingClient || !this.messagingClient.groupKeys) {
      return null;
    }

    const groupKeys = this.messagingClient.groupKeys;
    const selfFingerprint = this.messagingClient.fingerprint;

    // ROLE-BASED: Suche nach Key mit role="admin" (Website)
    for (const [fingerprint, keyData] of Object.entries(groupKeys)) {
      if (fingerprint !== selfFingerprint && keyData.role === 'admin') {
        return fingerprint;
      }
    }

    // Fallback: Erstes Gruppenmitglied außer Self (für Backward Compatibility)
    const fingerprints = Object.keys(groupKeys).filter(fp => fp !== selfFingerprint);
    if (fingerprints.length > 0) {
      console.warn('[TransactionQueue] ⚠️ No admin fingerprint found, using fallback:', fingerprints[0].substring(0, 16) + '...');
      return fingerprints[0];
    }

    return null;
  }

  /**
   * Send message ONLY to website (Sealed Box encrypted)
   * @param {Object} message - Message to send
   * @param {string} websitePublicKey - Website public key
   * @private
   */
  async _sendToWebsiteOnly(message, websitePublicKey) {
    const websiteFingerprint = await this._getWebsiteFingerprint();

    if (!websiteFingerprint) {
      throw new Error('Website fingerprint not found');
    }

    // Nutze den normalen sendMessage, aber mit spezifischem Empfänger
    // Der messaging-client sendet dann nur an die Website
    const encryptedForWebsite = await window.MessagingCrypto.encryptMessage(
      JSON.stringify(message),
      websitePublicKey,
      this.messagingClient.keyPair.privateKey
    );

    const messageId = crypto.randomUUID();
    const messageToSend = {
      id: messageId,
      type: 'rating',
      timestamp: Date.now(),
      nonce: await window.MessagingCrypto.generateNonce(),
      sender: this.messagingClient.fingerprint,
      recipients: [websiteFingerprint],
      payload: {
        [websiteFingerprint]: encryptedForWebsite
      }
    };

    // Sign the message
    const messageString = JSON.stringify(messageToSend);
    messageToSend.signature = await window.MessagingCrypto.signMessage(
      messageString,
      this.messagingClient.signingKeyPair.privateKey
    );

    // Send to messaging service
    const response = await fetch(`${this.messagingClient.serviceUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.messagingClient.authToken}`
      },
      body: JSON.stringify({
        message: messageToSend,
        groupId: this.messagingClient.groupId
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to send to website: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Send message to all devices EXCEPT website
   * @param {Object} message - Message to send
   * @private
   */
  async _sendToOtherDevices(message) {
    const websiteFingerprint = await this._getWebsiteFingerprint();
    const groupKeys = this.messagingClient.groupKeys;
    const selfFingerprint = this.messagingClient.fingerprint;

    // Get all recipients EXCEPT self and website
    const recipients = Object.keys(groupKeys).filter(
      fp => fp !== selfFingerprint && fp !== websiteFingerprint
    );

    if (recipients.length === 0) {
      return { success: true, skipped: true, reason: 'No other devices' };
    }

    // Encrypt for each recipient
    const encryptedPayloads = {};
    const payloadString = JSON.stringify(message);

    for (const recipientFingerprint of recipients) {
      const recipientKey = groupKeys[recipientFingerprint];
      const encrypted = await window.MessagingCrypto.encryptMessage(
        payloadString,
        recipientKey.publicKey,
        this.messagingClient.keyPair.privateKey
      );
      encryptedPayloads[recipientFingerprint] = encrypted;
    }

    // Create message structure
    const messageId = crypto.randomUUID();
    const messageToSend = {
      id: messageId,
      type: 'rating_summary',  // Fixed: was 'rating', should be 'rating_summary' for handler
      timestamp: Date.now(),
      nonce: await window.MessagingCrypto.generateNonce(),
      sender: selfFingerprint,
      recipients: recipients,
      payload: encryptedPayloads
    };

    // Sign the message
    const messageString = JSON.stringify(messageToSend);
    messageToSend.signature = await window.MessagingCrypto.signMessage(
      messageString,
      this.messagingClient.signingKeyPair.privateKey
    );

    // Send to messaging service
    const response = await fetch(`${this.messagingClient.serviceUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.messagingClient.authToken}`
      },
      body: JSON.stringify({
        message: messageToSend,
        groupId: this.messagingClient.groupId
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to send to other devices: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Retrieves CL wallet with retry mechanism for race condition handling
   *
   * Race condition: Device may be linked before ADDRESS_UPDATE message arrives
   * This function retries with exponential backoff to wait for the message
   *
   * @returns {Promise<Object|null>} CL wallet or null after all retries failed
   * @private
   */
  async _getClWalletWithRetry() {
    const { maxRetries, initialDelayMs, backoffMultiplier } = this.retryConfig;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const clWallet = await this.walletManager.getLocalWallet();

      if (clWallet) {
        return clWallet;
      }

      // If this is not the last attempt, wait before retrying
      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        await this._sleep(delayMs);
      }
    }

    // All retries exhausted
    return null;
  }

  /**
   * Sleep helper for retry mechanism
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   * @private
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Checks if device is properly linked before allowing transactions
   * Zero-Knowledge Architecture: Device must be linked with signed registration
   * @returns {boolean} True if device is linked and ready for transactions
   * @private
   */
  _isDeviceLinked() {
    // Access background.js state via global scope
    if (!window._revolutionState) {
      console.warn('[TransactionQueue] ⚠️ Revolution state not available');
      return false;
    }

    const state = window._revolutionState;

    // Check 1: If device is currently linking, consider it as "not yet ready" (not an error)
    if (state.deviceStatus === 'linking') {
      return false;
    }

    // Check 2: Device must exist
    if (!state.device) {
      return false;
    }

    // Check 3: Device status must be 'linked'
    if (state.deviceStatus !== 'linked') {
      return false;
    }

    // Check 4: Must have wallet address (from website-signed registration)
    const walletAddress = state.device.walletAddress;
    if (!walletAddress) {
      return false;
    }

    return true;
  }

  /**
   * Checks if wallet dependencies are available (auto-inject from global scope if needed)
   * @returns {boolean} True if dependencies are available
   */
  _checkDependencies() {
    // If already set, nothing to do
    if (this.walletManager && this.anonClient) {
      return true;
    }

    // Try to get from global scope
    if (window._walletManager && window._anonClient) {
      this.walletManager = window._walletManager;
      this.anonClient = window._anonClient;
      this.messagingClient = window.MessagingIntegration?.getClient();
      return true;
    }

    return false;
  }

  /**
   * Queues a transaction for later execution when wallet/device becomes available
   * @param {Object} transaction - Transaction to queue
   */
  _queuePendingTransaction(transaction) {
    // Determine pending reason
    if (!this._isDeviceLinked()) {
      transaction.pendingReason = 'device_not_linked';
    } else if (!this._checkDependencies()) {
      transaction.pendingReason = 'wallet_not_ready';
    } else {
      transaction.pendingReason = 'unknown';
    }

    transaction.pendingSince = Date.now();
    this.pendingQueue.push(transaction);
  }

  /**
   * Processes all pending transactions that were waiting for wallet
   */
  async processPendingQueue() {
    if (this.pendingQueue.length === 0) {
      return;
    }

    const pending = [...this.pendingQueue];
    this.pendingQueue = [];

    for (const transaction of pending) {
      // CRITICAL FIX: Re-resolve wallet addresses for pending:domain transactions
      // This fixes race condition where transactions were queued before EntityResolver was ready
      if (transaction.walletAddress?.startsWith('pending:') && this.distributionEngine) {
        const domain = transaction.domain || transaction.walletAddress.replace('pending:', '');
        try {
          const resolvedAddress = await this.distributionEngine.getWalletAddressForDomain(domain);

          if (!resolvedAddress.startsWith('pending:')) {
            transaction.walletAddress = resolvedAddress;
          } else {
            console.warn('[TransactionQueue] ⚠️ Wallet address still pending, will retry later:', {
              domain: domain,
              address: resolvedAddress
            });
            // Re-add to pending queue for next watchdog cycle
            transaction.retryCount = (transaction.retryCount || 0) + 1;
            if (transaction.retryCount < 10) { // Max 10 retries
              this.pendingQueue.push(transaction);
              continue; // Skip execution for this transaction
            } else {
              console.error('[TransactionQueue] ❌ Max retries reached, dropping transaction:', {
                domain: domain,
                retryCount: transaction.retryCount
              });
              continue; // Drop transaction after max retries
            }
          }
        } catch (error) {
          console.error('[TransactionQueue] ❌ Failed to re-resolve wallet address:', error.message);
          // Re-add to pending queue for next watchdog cycle
          transaction.retryCount = (transaction.retryCount || 0) + 1;
          if (transaction.retryCount < 10) {
            this.pendingQueue.push(transaction);
            continue;
          }
          continue; // Drop after max retries
        }
      }

      await this.executeTransaction(transaction);
    }
  }

  /**
   * Watchdog method - periodically checks for stuck transactions
   */
  _checkPendingQueue() {
    if (this.pendingQueue.length > 0) {
      if (this._isDeviceLinked() && this._checkDependencies()) {
        this.processPendingQueue();
      }
    }
  }

  /**
   * Sets dependencies (called from background.js)
   *
   * @param {Object} deps - {walletManager, anonClient, messagingClient, translationFactorTracker, distributionEngine}
   */
  setDependencies(deps) {
    this.walletManager = deps.walletManager;
    this.anonClient = deps.anonClient;
    this.messagingClient = deps.messagingClient;
    this.translationFactorTracker = deps.translationFactorTracker;
    this.distributionEngine = deps.distributionEngine;

    // NEW: Process any pending transactions
    if (this.pendingQueue.length > 0) {
      this.processPendingQueue();
    }
  }

  /**
   * Streams a mint buffer entry to the website immediately after Phase 1.
   * The website stores serial+signature+destination encrypted, so it can execute
   * the SH→DS spend if this device is lost before Phase 2 completes.
   *
   * Non-blocking — caller must catch errors.
   *
   * @param {Object} entry - mintBuffer entry (serial, signature, amount, destination, ...)
   * @private
   */
  async _streamMintEntryToWebsite(entry) {
    if (!this.messagingClient) {
      console.warn('[TransactionQueue] Cannot stream mint entry: no messagingClient');
      return;
    }

    const websitePublicKey = await this._getWebsiteMessagingPublicKey();
    if (!websitePublicKey) {
      console.warn('[TransactionQueue] Cannot stream mint entry: website public key not found');
      return;
    }

    // Only transmit what the website needs to execute the spend.
    // Do NOT include _seedManager (non-serializable) or internal metadata.
    const payload = {
      serial: entry.serial,
      signature: entry.signature,
      amount: entry.amount?.toString(),
      destination: entry.destination,
      fingerprintSHtoDS: entry.fingerprintSHtoDS,
      blockId: entry.blockId,
      ratingRef: entry._ratingRef,
      pairIndex: entry._pairIndex,
      sentAt: Date.now()
    };

    await this._sendToWebsiteOnly({ type: 'mint_buffer_entry', ...payload }, websitePublicKey);
  }

  /**
   * Sends DEVICE_HANDOFF message to website: remaining queue + any leftover mintBuffer.
   * Called on graceful device exit so website takes over immediately.
   */
  async sendDeviceHandoff() {
    if (!this.messagingClient) {
      console.warn('[TransactionQueue] Cannot send handoff: no messagingClient');
      return;
    }

    const websitePublicKey = await this._getWebsiteMessagingPublicKey();
    if (!websitePublicKey) {
      console.warn('[TransactionQueue] Cannot send handoff: website public key not found');
      return;
    }

    const queueSnapshot = this.queue.map(tx => ({
      ...tx,
      tokens: tx.tokens?.toString(),
      originalTokens: tx.originalTokens?.toString()
    }));

    const mintBufferSnapshot = this.mintBuffer.map(entry => ({
      serial: entry.serial,
      signature: entry.signature,
      amount: entry.amount?.toString(),
      destination: entry.destination,
      fingerprintSHtoDS: entry.fingerprintSHtoDS,
      blockId: entry.blockId,
      ratingRef: entry._ratingRef,
      pairIndex: entry._pairIndex
    }));

    const payload = {
      type: 'device_handoff',
      queue: queueSnapshot,
      mintBuffer: mintBufferSnapshot,
      sentAt: Date.now()
    };

    await this._sendToWebsiteOnly(payload, websitePublicKey);

  }

  /**
   * Fisher-Yates Shuffle (deterministisch wenn mit Seed)
   */
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Setzt Callback für Transaktion-Ausführung
   */
  setExecutionCallback(callback) {
    this.onExecute = callback;
  }

  /**
   * Holt aktuelle Queue-Größe
   */
  getQueueSize() {
    return this.queue.length;
  }

  /**
   * Holt Queue-Inhalt (für Debugging)
   */
  getQueue() {
    return [...this.queue];
  }

  /**
   * Cleanup method - stops watchdog timer to prevent memory leaks
   */
  destroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.spendTimer) {
      clearInterval(this.spendTimer);
      this.spendTimer = null;
    }
  }

  /**
   * Forciert sofortige Batch-Ausführung
   */
  async forceExecute() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    await this.executeBatch();
  }

  /**
   * Leert Queue ohne Ausführung
   */
  clearQueue() {
    this.queue = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Persistiert Queue in Storage
   */
  async saveQueue(storage = browser.storage.local) {
    const queueData = this.queue.map(tx => ({
      ...tx,
      tokens: tx.tokens.toString(),
      originalTokens: tx.originalTokens?.toString()
    }));

    await storage.set({
      'rev_transaction_queue': queueData
    });
  }

  /**
   * Lädt Queue aus Storage
   */
  async loadQueue(storage = browser.storage.local) {
    const data = await storage.get(['rev_transaction_queue']);
    const queueData = data.rev_transaction_queue || [];

    this.queue = queueData.map(tx => ({
      ...tx,
      tokens: BigInt(tx.tokens),
      originalTokens: tx.originalTokens ? BigInt(tx.originalTokens) : undefined
    }));

    // Trigger Batch falls Queue gefüllt ist
    if (this.queue.length > 0) {
      this.triggerBatchIfNeeded();
    }
  }

  /**
   * Aggregiert Queue-Statistiken
   */
  getStatistics() {
    const totalTokens = this.queue.reduce((sum, tx) => sum + tx.tokens, 0n);
    const domains = new Set(this.queue.map(tx => tx.domain));

    return {
      queueSize: this.queue.length,
      totalTokens: totalTokens.toString(),
      uniqueDomains: domains.size,
      oldestTransaction: this.queue.length > 0 ? this.queue[0].queuedAt : null,
      newestTransaction: this.queue.length > 0
        ? this.queue[this.queue.length - 1].queuedAt
        : null
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.TransactionQueue = TransactionQueue;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TransactionQueue;
}
