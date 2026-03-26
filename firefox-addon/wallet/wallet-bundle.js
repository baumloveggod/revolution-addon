(function () {
  'use strict';

  /**
   * Wallet Manager
   *
   * Verwaltet Wallet-Adressen für das Revolution-System:
   *
   * CL-Wallet (Client):
   *   - Wird bei Login/Registrierung über JWT-Token übergeben
   *   - Format: CL::0x<40 hex chars>
   *
   * DS/OR-Wallets (Distribution/Oracle):
   *   - Werden vom EntityNameService bereitgestellt
   *   - EntityNameService generiert diese bei Bedarf
   *
   * Storage Keys:
   * - rev_cl_wallet: {address, createdAt}
   *
   * WICHTIG: Wallets werden NICHT vom Addon generiert!
   *
   * @param {Object} config
   * @param {string} [config.clApiUrl='https://192.168.178.130:4100'] - Write-server URL
   * @param {string} [config.clReadApiUrl='https://192.168.178.130:4101'] - Read-server URL
   * @param {Object} config.storage - Storage backend implementing browser.storage.local interface
   * @param {Function} [config.fetch] - Fetch function (defaults to globalThis.fetch).
   *                                    Pass window.fetchWithVersion in the Firefox addon.
   */

  class WalletManager {
    constructor(config = {}) {
      // Write-server (mutations): port 4100
      this.clApiUrl = config.clApiUrl || 'https://192.168.178.130:4100';
      // Read-server (balance, transactions, health): port 4101
      this.clReadApiUrl = config.clReadApiUrl || 'https://192.168.178.130:4101';

      if (!config.storage) {
        throw new Error('[WalletManager] storage is required in config');
      }
      this.storage = config.storage;
      this.fetch = config.fetch || globalThis.fetch.bind(globalThis);

      this.lastHealthCheck = null;
      this.healthCheckInterval = 60000; // 1 Minute
      this.isHealthy = null; // null = unbekannt, true = healthy, false = down

      // PERFORMANCE: Balance cache to reduce API calls
      this.balanceCache = new Map(); // address -> {balance, timestamp}
      this.balanceCacheTimeout = 30000; // 30 seconds
    }


    /**
     * Speichert Wallet lokal im Browser Storage
     * Wallet wird NICHT verschlüsselt gespeichert (Browser Storage ist bereits sicher)
     *
     * @param {Object} wallet - Wallet-Objekt
     */
    async storeWalletLocally(wallet) {
      await this.storage.set({ rev_cl_wallet: wallet });

      console.log('[WalletManager] Wallet stored locally:', {
        address: wallet.address.substring(0, 20) + '...'
      });
    }

    /**
     * Holt Wallet aus lokalem Browser Storage
     *
     * @returns {Promise<Object|null>} Wallet oder null falls nicht vorhanden
     */
    async getLocalWallet() {
      const data = await this.storage.get(['rev_cl_wallet']);
      return data.rev_cl_wallet || null;
    }


    /**
     * Prüft ob der Central Ledger API erreichbar ist
     *
     * @returns {Promise<boolean>} true wenn API erreichbar ist
     */
    async checkHealth() {
      // Cached Health Check (max 1 Minute alt)
      const now = Date.now();
      if (this.lastHealthCheck && (now - this.lastHealthCheck) < this.healthCheckInterval) {
        return this.isHealthy;
      }

      try {
        const response = await this.fetch(`${this.clReadApiUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000) // 5 Sekunden Timeout
        });

        this.isHealthy = response.ok;
        this.lastHealthCheck = now;

        if (!this.isHealthy) {
          console.warn('[WalletManager] Central Ledger API returned non-OK status:', response.status);
        }

        return this.isHealthy;

      } catch (error) {
        console.error('[WalletManager] Central Ledger API health check failed:', error.message);
        this.isHealthy = false;
        this.lastHealthCheck = now;
        return false;
      }
    }

    /**
     * Holt CL Balance für Wallet Address vom Central Ledger
     *
     * @param {string} address - Wallet Address (z.B. "CL::...")
     * @returns {Promise<bigint>} Balance in Token (kleinste Einheit)
     * @throws {Error} Wenn Central Ledger API nicht erreichbar ist
     */
    async getBalance(address) {
      // PERFORMANCE: Check cache first
      const cached = this.balanceCache.get(address);
      if (cached && (Date.now() - cached.timestamp) < this.balanceCacheTimeout) {
        console.log('[WalletManager] Balance from cache:', {
          address: address.substring(0, 20) + '...',
          balance: cached.balance.toString(),
          age: Math.floor((Date.now() - cached.timestamp) / 1000) + 's'
        });
        return cached.balance;
      }

      // WICHTIG: Health Check vor der Balance-Abfrage
      const isHealthy = await this.checkHealth();

      if (!isHealthy) {
        // If API is down but we have cached data (even if stale), return it
        if (cached) {
          console.warn('[WalletManager] API down, using stale cache:', {
            address: address.substring(0, 20) + '...',
            age: Math.floor((Date.now() - cached.timestamp) / 1000) + 's'
          });
          return cached.balance;
        }

        const error = new Error(
          `Central Ledger API is not reachable at ${this.clApiUrl}. ` +
          `Please ensure the service is running (cd central-ledger && npm start).`
        );
        error.code = 'CL_API_UNREACHABLE';
        console.error('[WalletManager] getBalance failed:', error.message);
        throw error;
      }

      try {
        const response = await this.fetch(`${this.clReadApiUrl}/wallets/${encodeURIComponent(address)}/balance`);

        if (!response.ok) {
          throw new Error(`Balance query failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const balance = BigInt(data.balance_tokens || 0);

        // Cache the result
        this.balanceCache.set(address, {
          balance,
          timestamp: Date.now()
        });

        console.log('[WalletManager] Balance fetched:', {
          address: address.substring(0, 20) + '...',
          balance: balance.toString(),
          registered: data.registered
        });

        return balance;

      } catch (error) {
        console.error('[WalletManager] Failed to fetch balance:', error);

        // Unterscheide zwischen verschiedenen Fehlerarten
        if (error.message.includes('fetch failed') || error.name === 'TypeError') {
          // Netzwerkfehler - API ist down
          this.isHealthy = false;
          const apiError = new Error(
            `Failed to connect to Central Ledger API at ${this.clApiUrl}. ` +
            `Service may be down.`
          );
          apiError.code = 'CL_API_CONNECTION_FAILED';
          apiError.originalError = error;
          throw apiError;
        }

        // Andere Fehler (z.B. 404, 400) weiterwerfen
        throw error;
      }
    }

    /**
     * Initialisiert Wallet mit CL-Adresse aus dem User-Profile
     * Die CL-Wallet-Adresse wird bei Login über JWT-Token übergeben
     *
     * @param {string} clWalletAddress - CL-Wallet-Adresse (Format: CL::0x...)
     * @param {string} privateKey - Private Key (Base64-encoded, optional)
     * @param {string} publicKey - Public Key (Base64-encoded, optional)
     * @returns {Promise<Object>} Wallet
     */
    async initializeWallet(clWalletAddress, privateKey = null, publicKey = null) {
      if (!clWalletAddress) {
        const errorMsg = 'CL wallet address required (provided by server via JWT). Your profile may not have a wallet assigned yet.';
        console.error('[WalletManager]', errorMsg);
        console.error('[WalletManager] Received:', {
          value: clWalletAddress,
          type: typeof clWalletAddress,
          isNull: clWalletAddress === null,
          isUndefined: clWalletAddress === undefined
        });
        throw new Error(errorMsg);
      }

      // Validiere Format
      if (!clWalletAddress.startsWith('CL::0x')) {
        console.error('[WalletManager] Invalid CL wallet format:', clWalletAddress);
        console.error('[WalletManager] Expected format: CL::0x followed by 40 hex characters');
        throw new Error('Invalid CL wallet format (expected CL::0x...)');
      }

      // 1. Prüfe ob bereits gecached
      const cached = await this.getLocalWallet();
      if (cached && cached.address === clWalletAddress) {
        // Update keys if provided and not already set
        if ((privateKey && !cached.privateKey) || (publicKey && !cached.publicKey)) {
          console.log('[WalletManager] Updating cached wallet with keys');
          cached.privateKey = privateKey || cached.privateKey;
          cached.publicKey = publicKey || cached.publicKey;
          await this.storeWalletLocally(cached);
        } else {
          console.log('[WalletManager] Using cached wallet');
        }
        return cached;
      }

      // 2. Erstelle Wallet-Objekt
      const wallet = {
        address: clWalletAddress,
        privateKey: privateKey,
        publicKey: publicKey,
        createdAt: new Date().toISOString()
      };

      // 3. Speichere lokal
      await this.storeWalletLocally(wallet);

      console.log('[WalletManager] Wallet initialized:', {
        address: wallet.address.substring(0, 20) + '...',
        hasPrivateKey: !!wallet.privateKey,
        hasPublicKey: !!wallet.publicKey
      });

      return wallet;
    }

    /**
     * Holt Transaktionen für eine Wallet-Adresse vom Central Ledger
     *
     * @param {string} address - Wallet Address (z.B. "CL::...")
     * @returns {Promise<Array>} Transaktionen
     */
    async getTransactions(address) {
      try {
        const response = await this.fetch(`${this.clReadApiUrl}/wallets/${encodeURIComponent(address)}/transactions`);

        if (!response.ok) {
          throw new Error(`Transaction query failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.transactions || [];

      } catch (error) {
        console.error('[WalletManager] Failed to fetch transactions:', error);
        throw error;
      }
    }

    /**
     * Prüft ob es einen BA→CL Transfer gibt und setzt den Timestamp für die Zeit-Dämpfung
     *
     * Diese Funktion sollte regelmäßig aufgerufen werden (z.B. beim Balance-Check)
     * um den ersten BA→CL Transfer zu erkennen.
     *
     * @param {string} address - CL Wallet Address
     * @param {Object} translationFactorTracker - TranslationFactorTracker Instanz
     * @returns {Promise<boolean>} true wenn BA→CL Transfer gefunden und Timestamp gesetzt wurde
     */
    async detectAndRecordFirstBaTransfer(address, translationFactorTracker) {
      try {
        console.log('[WalletManager] detectAndRecordFirstBaTransfer called:', {
          address: address?.substring(0, 20) + '...',
          hasTracker: !!translationFactorTracker
        });

        // 1. Prüfe ob Timestamp bereits gesetzt ist
        const existingTimestamp = await translationFactorTracker.getFirstBaToCLTimestamp();
        console.log('[WalletManager] Existing timestamp:', existingTimestamp);

        if (existingTimestamp !== null) {
          // Bereits gesetzt, nichts zu tun
          console.log('[WalletManager] Timestamp already set, skipping detection');
          return false;
        }

        // 2. Hole Transaktionen für diese Wallet
        console.log('[WalletManager] Fetching transactions for:', address);
        const transactions = await this.getTransactions(address);
        console.log('[WalletManager] Found transactions:', transactions.length);

        // 3. Finde ersten BA→CL Transfer (direction: "in", counterparty ist BA-Wallet)
        const firstBaTransfer = transactions.find(tx =>
          tx.direction === 'in' &&
          tx.counterparty && tx.counterparty.startsWith('BA::')
        );

        if (!firstBaTransfer) {
          // Noch kein BA→CL Transfer
          console.log('[WalletManager] No BA→CL transfer found yet');
          return false;
        }

        // 4. Setze Timestamp (in Sekunden, vom BA Transfer, nicht jetzt!)
        const transferTimestamp = Math.floor(Date.parse(firstBaTransfer.at) / 1000);
        await translationFactorTracker.recordFirstBaToCLTransfer(transferTimestamp);

        console.log('[WalletManager] First BA→CL transfer detected and recorded:', {
          transferDate: firstBaTransfer.at,
          timestamp: transferTimestamp,
          amount: firstBaTransfer.amount?.tokens || 'unknown'
        });

        return true;

      } catch (error) {
        console.error('[WalletManager] Failed to detect BA transfer:', error);
        // Fehler nicht weiterwerfen, da dies optional ist
        return false;
      }
    }

    /**
     * Löscht Wallet aus lokalem Storage (für Testing/Debugging)
     */
    async clearLocalWallet() {
      await this.storage.remove(['rev_cl_wallet']);
      console.log('[WalletManager] Local wallet cleared');
    }
  }

  /**
   * Anonymous Transaction Client
   *
   * Implementiert Chaum Blind Signature Protocol für anonyme Zahlungen:
   * - CL → SH (Mint): Blinde Signatur vom Stealth-Hop
   * - SH → DS (Spend): Anonyme Ausgabe mit unblinded Signatur
   *
   * Flow:
   * 1. mintAnonNote(clWallet, amount) → {serial, signature}
   *    - Generiere random serial
   *    - Blind message
   *    - Transfer CL→SH mit blind signature request
   *    - Unblind signature
   *
   * 2. spendAnonNote(serial, signature, amount, dsAddress) → {txHash, fingerprint}
   *    - Spend SH→DS mit signature
   *    - Generate fingerprint für Matching
   *
   * @param {Object} config
   * @param {string} [config.anonApiUrl='https://ledger.lenkenhoff.de/anon'] - Anon API URL
   * @param {string} [config.clApiUrl='https://ledger.lenkenhoff.de'] - Write-server URL
   * @param {string} [config.clReadApiUrl='https://read.lenkenhoff.de'] - Read-server URL
   * @param {Function} [config.fetch] - Fetch function (defaults to globalThis.fetch).
   *                                    Pass window.fetchWithVersion in the Firefox addon.
   * @param {Object} [config.sodium] - libsodium instance. Required for mintAnonNote().
   *                                   Pass window.sodium in browser or require('libsodium-wrappers') in Node.js.
   */

  class AnonTransactionClient {
    constructor(config = {}) {
      // Write-server (POST /anon/mint)
      this.anonApiUrl   = config.anonApiUrl   || 'https://192.168.178.130:4100/anon';
      this.clApiUrl     = config.clApiUrl     || 'https://192.168.178.130:4100';
      // Read-server (GET /anon/blocks/*, GET /wallets/*/registration)
      this.clReadApiUrl = config.clReadApiUrl || 'https://192.168.178.130:4101';
      this.fetch        = config.fetch || globalThis.fetch.bind(globalThis);
      this.sodium       = config.sodium || null;
    }

    /**
     * Mint Anonymous Note (CL → SH)
     *
     * @param {Object} clWallet - CL Wallet {address, publicKey, privateKey}
     * @param {bigint} amount - Token amount
     * @param {string} fingerprint - Required fingerprint linking this mint to a rating
     * @returns {Promise<Object>} {serial, signature, amount}
     */
    async mintAnonNote(clWallet, amount, fingerprint) {
      if (!fingerprint) throw new Error('fingerprint_required: mintAnonNote requires a fingerprintCLtoSH');
      try {
        console.log('[AnonTxClient] Minting anonymous note:', {
          amount: amount.toString(),
          clWallet: clWallet.address.substring(0, 20) + '...'
        });

        // 1. Fetch RSA public key vom Stealth-Hop
        const { n, e } = await this.fetchPublicKey();

        // 2. Generate random serial
        const serial = await this.generateRandomSerial();

        // 3. Derive message: hash(CONTEXT | serial | amount) % n
        const message = await this.deriveAnonMessage(serial, amount, n);

        // 4. Blind message
        const { blindedMessage, blindingFactor } = this.blindMessage(message, e, n);

        // 5. POST /anon/mint (CL→SH transfer + blind signature)
        const mintResponse = await this.transferCLtoSH(
          clWallet,
          amount,
          blindedMessage,
          fingerprint
        );

        // 6. Unblind signature (now uses O(log n) Extended Euclidean Algorithm)
        console.log('[AnonTxClient] 📍 Step 6: Unblinding signature...');
        const signature = this.unblindSignature(mintResponse.blindSignature, blindingFactor, n);

        console.log('[AnonTxClient] ✅ Anonymous note minted:', {
          serial: serial.substring(0, 16) + '...',
          signature: signature.substring(0, 16) + '...',
          blockId: mintResponse.blockId,
          blockStatus: mintResponse.blockStatus
        });

        return {
          serial,
          signature,
          amount,
          blockId: mintResponse.blockId,
          blockStatus: mintResponse.blockStatus,
          nextBlockId: mintResponse.nextBlockId
        };

      } catch (error) {
        console.error('[AnonTxClient] Mint failed:', error);
        throw error;
      }
    }

    /**
     * Spend Anonymous Note (SH → DS)
     *
     * NOTE: Fingerprint generation is now handled externally by FingerprintSeedManager
     *
     * @param {string} serial - Serial number (hex string)
     * @param {string} signature - Unblinded signature (hex string)
     * @param {bigint} amount - Token amount
     * @param {string} destinationAddress - DS wallet address
     * @param {string} fingerprint - Required fingerprint linking this spend to a rating
     * @param {string} blockId - Block ID from mint (optional for backwards compatibility)
     * @returns {Promise<Object>} {txHash}
     */
    async spendAnonNote(serial, signature, amount, destinationAddress, fingerprint, blockId = null) {
      if (!fingerprint) throw new Error('fingerprint_required: spendAnonNote requires a fingerprintSHtoDS');
      try {
        console.log('[AnonTxClient] 📍 spendAnonNote: Starting SH → DS spend...', {
          serial: serial.substring(0, 16) + '...',
          destination: destinationAddress,
          amount: amount.toString(),
          isValidDestination: destinationAddress?.startsWith('DS::') || destinationAddress?.startsWith('OR::')
        });

        // Validate destination address
        if (!destinationAddress || destinationAddress.startsWith('pending:')) {
          console.error('[AnonTxClient] ❌ spendAnonNote: Invalid destination address!', {
            destinationAddress: destinationAddress
          });
          throw new Error(`Invalid destination address: ${destinationAddress}`);
        }

        console.log('[AnonTxClient] 📍 spendAnonNote: Calling POST /anon/spend...', {
          endpoint: `${this.anonApiUrl}/spend`
        });

        // POST /anon/spend
        const payload = {
          serial: serial,
          signature: signature,
          amount: amount.toString(),
          to: destinationAddress,
          fingerprint
        };

        // NOTE: blockId is intentionally NOT sent — sending it would link mint to spend
        // and break anonymity. The server resolves the sealed block by amount itself.
        // blockId is only used locally above for waitForBlockSeal() polling.

        const response = await this.fetch(`${this.anonApiUrl}/spend`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(`Spend failed: ${error.error || response.statusText}`);
        }

        const spendResult = await response.json();
        const txHash = spendResult.id != null ? String(spendResult.id) : spendResult.txHash || null;

        console.log('[AnonTxClient] Anonymous note spent:', {
          txHash
        });

        return { txHash };

      } catch (error) {
        console.error('[AnonTxClient] Spend failed:', error);
        throw error;
      }
    }

    /**
     * Check block seal status
     *
     * @param {string} blockId - Block ID
     * @returns {Promise<Object>} {blockId, status, mintCount, sealedAt, canSpend}
     */
    async checkBlockStatus(blockId) {
      try {
        console.log('[AnonTxClient] 📍 checkBlockStatus:', { blockId });

        const response = await this.fetch(`${this.clReadApiUrl}/anon/blocks/${encodeURIComponent(blockId)}/status`);

        if (response.status === 404) {
          console.log('[AnonTxClient] Block not found:', blockId);
          return { blockId, status: 'not_found', canSpend: false };
        }

        if (!response.ok) {
          throw new Error(`Block status check failed: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('[AnonTxClient] ✅ Block status check:', data);

        return data;
      } catch (error) {
        console.error('[AnonTxClient] ❌ checkBlockStatus failed:', error.message);
        throw error;
      }
    }

    /**
     * Wait for block to be sealed (polling)
     *
     * @param {string} blockId - Block ID
     * @param {number} maxWaitMs - Maximum wait time in milliseconds (default: 60 seconds)
     * @param {number} pollIntervalMs - Polling interval (default: 2 seconds)
     * @returns {Promise<boolean>} true if block sealed, false if timeout
     */
    async waitForBlockSeal(blockId, maxWaitMs = 60000, pollIntervalMs = 2000) {
      console.log('[AnonTxClient] 📍 waitForBlockSeal:', { blockId, maxWaitMs });

      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        try {
          const { canSpend, status } = await this.checkBlockStatus(blockId);

          if (canSpend) {
            console.log('[AnonTxClient] ✅ Block sealed!', { blockId, status });
            return true;
          }

          console.log('[AnonTxClient] Block not yet sealed, waiting...', { blockId, status });
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        } catch (error) {
          console.error('[AnonTxClient] ❌ Error checking block status:', error);
          // Continue polling despite errors
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }

      console.warn('[AnonTxClient] ⚠️ Timeout waiting for block seal:', { blockId, maxWaitMs });
      return false; // Timeout
    }

    /**
     * Check if a wallet is registered in Central Ledger
     * Used for pre-validation before minting to prevent tokens stuck in SH pool
     *
     * @param {string} walletAddress - The wallet address to check (e.g., "DS::0x...")
     * @returns {Promise<Object>} {registered: boolean, role: string|null}
     */
    async checkWalletRegistration(walletAddress) {
      try {
        console.log('[AnonTxClient] 📍 checkWalletRegistration:', { walletAddress });

        const response = await this.fetch(`${this.clReadApiUrl}/wallets/${encodeURIComponent(walletAddress)}/registration`);

        if (response.status === 404) {
          console.log('[AnonTxClient] Wallet not registered:', walletAddress);
          return { registered: false, role: null };
        }

        if (!response.ok) {
          throw new Error(`Registration check failed: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('[AnonTxClient] ✅ Wallet registration check:', {
          walletAddress,
          registered: true,
          role: data.registration?.role
        });

        return {
          registered: true,
          role: data.registration?.role || null
        };
      } catch (error) {
        console.error('[AnonTxClient] ❌ checkWalletRegistration failed:', error.message);
        throw error;
      }
    }

    /**
     * Fetch RSA public key from Stealth-Hop
     *
     * @returns {Promise<Object>} {n, e} (BigInt strings)
     */
    async fetchPublicKey() {
      const response = await this.fetch(`${this.anonApiUrl}/pubkey`);

      if (!response.ok) {
        throw new Error(`Failed to fetch public key: ${response.statusText}`);
      }

      const data = await response.json();

      // Convert JWK format (Base64URL) to BigInt
      // JWK uses Base64URL encoding without padding
      const nBigInt = this.base64urlToBigInt(data.n);
      const eBigInt = this.base64urlToBigInt(data.e);

      return { n: nBigInt, e: eBigInt };
    }

    /**
     * Convert Base64URL to BigInt
     *
     * @param {string} base64url - Base64URL encoded string
     * @returns {bigint} BigInt value
     */
    base64urlToBigInt(base64url) {
      // Base64URL to Base64: replace - with +, _ with /, add padding
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const padding = (4 - (base64.length % 4)) % 4;
      const padded = base64 + '='.repeat(padding);

      // Decode Base64 to binary string
      const binaryString = atob(padded);

      // Convert binary string to hex
      let hex = '';
      for (let i = 0; i < binaryString.length; i++) {
        hex += ('0' + binaryString.charCodeAt(i).toString(16)).slice(-2);
      }

      // Convert hex to BigInt
      return BigInt('0x' + hex);
    }

    /**
     * Generate random serial number
     *
     * @returns {Promise<string>} Hex string (64 characters = 32 bytes)
     */
    async generateRandomSerial() {
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);

      return Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Generate random nonce for X-Tx-Nonce header (16 bytes = 32 hex chars)
     * @returns {string}
     */
    async _generateNonce() {
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      return Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Derive anonymous message from serial and amount
     *
     * MUST match server's deriveAnonMessage exactly!
     * Format: SHA-256("REV-ANON-NOTE-V1|serial|encodedAmount") % n
     *
     * @param {string} serial - Serial (hex string)
     * @param {bigint} amount - Amount
     * @param {bigint} n - RSA modulus
     * @returns {Promise<bigint>} Message
     */
    async deriveAnonMessage(serial, amount, n) {
      // MUST match server's ANON_NOTE_CONTEXT
      const context = "REV-ANON-NOTE-V1";

      // Encode amount in server's token format
      const encodedAmount = this.encodeTokenAmount(amount);

      // MUST match server's format with | separators
      const data = `${context}|${serial}|${encodedAmount}`;

      console.log('[AnonTxClient] deriveAnonMessage:', {
        context,
        serialPrefix: serial.substring(0, 16) + '...',
        encodedAmount,
        dataPreview: data.substring(0, 50) + '...'
      });

      // SHA-256 Hash
      const hash = await this.sha256Hash(data);

      // Convert hex hash → BigInt
      const hashBigInt = BigInt('0x' + hash);

      // message = hash % n
      const message = hashBigInt % n;

      return message;
    }

    /**
     * Encode token amount in server's format
     *
     * MUST match server's ensureEncodedToken/encodeTokenAmount exactly!
     * Format: header (2 chars) + hex value
     * Headers: "00"=uint16, "01"=uint32, "10"=uint64, "11"=uint128
     *
     * @param {bigint} value - Token amount
     * @returns {string} Encoded token (e.g., "100001877C2DC780")
     */
    encodeTokenAmount(value) {
      const v = BigInt(value);
      if (v < 0n) throw new Error('Token amounts must be unsigned');

      // Type table matching server's TYPE_TABLE
      const typeTable = [
        { header: '00', bytes: 2, max: (1n << 16n) - 1n },   // uint16
        { header: '01', bytes: 4, max: (1n << 32n) - 1n },   // uint32
        { header: '10', bytes: 8, max: (1n << 64n) - 1n },   // uint64
        { header: '11', bytes: 16, max: (1n << 128n) - 1n }  // uint128
      ];

      // Find smallest type that fits
      let type = null;
      for (const entry of typeTable) {
        if (v <= entry.max) {
          type = entry;
          break;
        }
      }

      if (!type) {
        throw new Error('Value exceeds uint128 capacity');
      }

      // Convert to hex and pad to correct length
      const hex = v.toString(16).padStart(type.bytes * 2, '0').toUpperCase();
      return `${type.header}${hex}`;
    }

    /**
     * Blind message with RSA blinding
     *
     * blinded = (message × r^e) mod n
     *
     * @param {bigint} message - Message
     * @param {bigint} e - RSA public exponent
     * @param {bigint} n - RSA modulus
     * @returns {Object} {blindedMessage, blindingFactor}
     */
    blindMessage(message, e, n) {
      // Generate random blinding factor: 1 < r < n
      const r = this.generateRandomBigInt(n);

      // Compute r^e mod n
      const r_e = this.modExp(r, e, n);

      // Blind: blinded = (message × r^e) mod n
      const blindedMessage = (message * r_e) % n;

      return {
        blindedMessage: blindedMessage,
        blindingFactor: r
      };
    }

    /**
     * Unblind signature
     *
     * signature = (blindSignature × r^-1) mod n
     *
     * @param {bigint} blindSignature - Blind signature from server
     * @param {bigint} r - Blinding factor
     * @param {bigint} n - RSA modulus
     * @returns {string} Signature (hex string)
     */
    unblindSignature(blindSignature, r, n) {
      console.log('[AnonTxClient] 📍 unblindSignature: Starting...');
      const startTime = Date.now();

      // Compute r^-1 mod n using Extended Euclidean Algorithm (O(log n))
      console.log('[AnonTxClient] 📍 unblindSignature: Computing modular inverse...');
      const r_inv = this.modInverse(r, n);
      console.log('[AnonTxClient] 📍 unblindSignature: modInverse completed in', Date.now() - startTime, 'ms');

      // Unblind: signature = (blindSignature × r^-1) mod n
      const signature = (blindSignature * r_inv) % n;

      console.log('[AnonTxClient] ✅ unblindSignature: Completed in', Date.now() - startTime, 'ms');

      // Convert to hex string
      return signature.toString(16);
    }

    /**
     * Transfer CL→SH with blind signature request
     *
     * @param {Object} clWallet - CL Wallet
     * @param {bigint} amount - Amount
     * @param {bigint} blindedMessage - Blinded message
     * @param {string} fingerprint - Required fingerprint for transaction tracking
     * @returns {Promise<bigint>} Blind signature
     */
    async transferCLtoSH(clWallet, amount, blindedMessage, fingerprint) {
      console.log('[AnonTxClient] 📍 transferCLtoSH: Starting CL → SH transfer...', {
        clWalletAddress: clWallet.address,
        amount: amount.toString(),
        anonApiUrl: this.anonApiUrl
      });

      const sodium = this.sodium;
      if (!sodium) {
        throw new Error(
          '[AnonTransactionClient] sodium is required for mintAnonNote. ' +
          'Pass { sodium: window.sodium } in browser or { sodium: require("libsodium-wrappers") } in Node.js.'
        );
      }
      await sodium.ready;

      if (!clWallet.privateKey) {
        console.error('[AnonTxClient] ❌ transferCLtoSH: Private key missing!');
        throw new Error(
          'CL wallet does not have a private key. ' +
          'Please log out and log back in to refresh your wallet credentials.'
        );
      }

      // Ensure address is in flow format (CL::0x...)
      const fromAddress = clWallet.address.startsWith('CL::')
        ? clWallet.address
        : `CL::${clWallet.address}`;

      const timestamp = Date.now();
      const payload = {
        from: fromAddress,
        amount: amount.toString(),
        blindedNote: blindedMessage.toString(16),  // BigInt → hex string
        timestamp: timestamp,
        fingerprint
      };

      // POST /anon/mint
      console.log('[AnonTxClient] 📍 transferCLtoSH: Calling POST /anon/mint...', {
        endpoint: `${this.anonApiUrl}/mint`,
        from: fromAddress,
        amount: amount.toString()
      });

      // Build X-Tx-* signature headers (Ed25519, canonical format)
      // Message: METHOD|PATH|NONCE|TIMESTAMP|SHA256(rawBody)
      const path        = '/anon/mint';
      const nonce       = await this._generateNonce();
      const txTimestamp = Date.now();
      const bodyStr     = JSON.stringify(payload);
      const bodyHash    = await this.sha256Hash(bodyStr);
      const sigMessage  = `POST|${path}|${nonce}|${txTimestamp}|${bodyHash}`;

      // Derive Ed25519 keypair from 32-byte seed (private key stored as hex)
      const seedUint8 = sodium.from_hex(clWallet.privateKey);
      const keypair   = sodium.crypto_sign_seed_keypair(seedUint8);

      // Sign the canonical message
      const msgUint8  = sodium.from_string(sigMessage);
      const sigBytes  = sodium.crypto_sign_detached(msgUint8, keypair.privateKey);

      // Public key hex (32 bytes = 64 hex chars)
      const pubkeyHex = Array.from(keypair.publicKey, b => b.toString(16).padStart(2, '0')).join('');
      const sigHex    = Array.from(sigBytes, b => b.toString(16).padStart(2, '0')).join('');

      const response = await this.fetch(`${this.anonApiUrl}/mint`, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Tx-Pubkey':     pubkeyHex,
          'X-Tx-Nonce':      nonce,
          'X-Tx-Timestamp':  String(txTimestamp),
          'X-Tx-Signature':  sigHex
        },
        body: bodyStr
      });

      if (!response.ok) {
        let errorDetails;
        try {
          errorDetails = await response.json();
        } catch (e) {
          errorDetails = { error: response.statusText };
        }
        console.error('[AnonTxClient] ❌ Mint request failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorDetails,
          endpoint: `${this.anonApiUrl}/mint`
        });
        throw new Error(`Mint failed: ${errorDetails.error || response.statusText}`);
      }

      const mintResponse = await response.json();
      console.log('[AnonTxClient] ✅ transferCLtoSH: Mint successful, received blind signature and block info');

      // Convert hex string to BigInt
      return {
        blindSignature: BigInt('0x' + mintResponse.signature),
        blockId: mintResponse.blockId || null,
        blockStatus: mintResponse.blockStatus || null,
        nextBlockId: mintResponse.nextBlockId || null
      };
    }

    /**
     * LEGACY: Generate fingerprint (NON-SEED-BASED)
     *
     * @deprecated Use FingerprintSeedManager for seed-based fingerprint generation
     *
     * fingerprint = SHA-256(serial : signature : amount : timestamp : nonce)
     *
     * @param {string} serial - Serial
     * @param {string} signature - Signature
     * @param {bigint} amount - Amount
     * @returns {Promise<string>} Fingerprint (hex string, 64 chars)
     */
    async generateLegacyFingerprint(serial, signature, amount) {
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);

      const nonceHex = Array.from(nonce, b => b.toString(16).padStart(2, '0')).join('');
      const data = `${serial}:${signature}:${amount.toString()}:${Date.now()}:${nonceHex}`;

      return await this.sha256Hash(data);
    }

    /**
     * SHA-256 Hash using Web Crypto API
     *
     * @param {string} data - Input data
     * @returns {Promise<string>} Hex hash (64 characters)
     */
    async sha256Hash(data) {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex;
    }

    /**
     * Modular Exponentiation: base^exp mod modulus
     *
     * @param {bigint} base
     * @param {bigint} exp
     * @param {bigint} modulus
     * @returns {bigint}
     */
    modExp(base, exp, modulus) {
      if (modulus === 1n) return 0n;

      let result = 1n;
      base = base % modulus;

      while (exp > 0n) {
        if (exp % 2n === 1n) {
          result = (result * base) % modulus;
        }
        exp = exp / 2n;
        base = (base * base) % modulus;
      }

      return result;
    }

    /**
     * Modular Inverse: a^-1 mod m (Extended Euclidean Algorithm)
     *
     * Uses the Extended Euclidean Algorithm which runs in O(log m) time.
     * The naive brute-force approach would be O(m) which is impossible for
     * 2048-bit RSA modulus (would take billions of years).
     *
     * @param {bigint} a
     * @param {bigint} m
     * @returns {bigint}
     */
    modInverse(a, m) {
      // Ensure a is positive and less than m
      a = ((a % m) + m) % m;

      if (a === 0n) {
        throw new Error('Modular inverse does not exist for 0');
      }

      // Extended Euclidean Algorithm
      let [old_r, r] = [a, m];
      let [old_s, s] = [1n, 0n];

      while (r !== 0n) {
        const quotient = old_r / r;
        [old_r, r] = [r, old_r - quotient * r];
        [old_s, s] = [s, old_s - quotient * s];
      }

      // GCD must be 1 for inverse to exist
      if (old_r !== 1n) {
        throw new Error('Modular inverse does not exist (GCD != 1)');
      }

      // Ensure result is positive
      return ((old_s % m) + m) % m;
    }

    /**
     * Generate random BigInt: 1 < r < max
     *
     * @param {bigint} max
     * @returns {bigint}
     */
    generateRandomBigInt(max) {
      // Simple random generation (NOT cryptographically secure for production!)
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);

      let r = 0n;
      for (let i = 0; i < randomBytes.length; i++) {
        r = (r << 8n) + BigInt(randomBytes[i]);
      }

      // Ensure 1 < r < max
      r = (r % (max - 2n)) + 2n;

      return r;
    }
  }

  /**
   * Fingerprint Seed Manager
   *
   * Manages seed-based fingerprint generation for anonymous transactions.
   * Each rating gets TWO unique 256-bit seeds, from which all transaction
   * fingerprints are deterministically derived:
   *
   * - seedCLtoSH: For CL→SH transactions (shared with other devices)
   * - seedSHtoDS: For SH→DS transactions (private, only website)
   *
   * Transaction Pairs:
   * Each rating can have multiple transaction pairs (initial + corrections).
   * Each pair consists of:
   * - CL→SH transaction (publicly visible)
   * - SH→DS transaction (anonymous, privacy-preserved)
   *
   * Privacy Model:
   * - Other devices receive seedCLtoSH (can generate CL→SH fingerprints)
   * - Other devices DO NOT receive seedSHtoDS (SH→DS stays private)
   *
   * @param {Object} config
   * @param {Object} config.storage - Storage backend implementing browser.storage.local interface
   *                                   ({ get(keys), set(items), remove(keys) })
   *                                   Use NodeMemoryStorage for Node.js.
   */

  class FingerprintSeedManager {
    constructor(config = {}) {
      if (!config.storage) {
        throw new Error(
          '[FingerprintSeedManager] storage is required. ' +
          'Pass { storage: browser.storage.local } in browser or a NodeMemoryStorage instance in Node.js.'
        );
      }
      this.storage = config.storage;
      this.STORAGE_KEY = 'rev_rating_seeds';
      this.RETENTION_DAYS = 90;
    }

    /**
     * Generate TWO seeds for a rating
     *
     * @param {string} ratingRef - Unique rating reference
     * @param {string} domain - Domain name
     * @param {string} url - Full URL (optional)
     * @returns {Promise<Object>} Seed object with both seeds
     */
    async generateRatingSeeds(ratingRef, domain, url = null) {
      // Seed für CL→SH Transaktionen (geteilt mit anderen Devices)
      const seedCLtoSHBytes = new Uint8Array(32);  // 256-bit
      crypto.getRandomValues(seedCLtoSHBytes);
      const seedCLtoSH = Array.from(seedCLtoSHBytes, b => b.toString(16).padStart(2, '0')).join('');

      // Seed für SH→DS Transaktionen (nur Webseite)
      const seedSHtoDSBytes = new Uint8Array(32);  // 256-bit
      crypto.getRandomValues(seedSHtoDSBytes);
      const seedSHtoDS = Array.from(seedSHtoDSBytes, b => b.toString(16).padStart(2, '0')).join('');

      const seedObj = {
        ratingRef,
        seedCLtoSH,
        seedSHtoDS,
        createdAt: Date.now(),
        domain,
        url,
        transactionPairs: [],  // Array von Paaren
        status: 'pending',
        completedAt: null
      };

      await this.saveSeeds(seedObj);

      console.log('[FingerprintSeedManager] Seeds generated:', {
        ratingRef,
        domain,
        seedCLtoSHPreview: seedCLtoSH.substring(0, 16) + '...',
        seedSHtoDSPreview: seedSHtoDS.substring(0, 16) + '...'
      });

      return seedObj;
    }

    /**
     * Derive fingerprint from seed using HMAC-SHA256
     *
     * @param {string} seed - Hex seed (64 chars)
     * @param {string} transactionType - 'CL_TO_SH' | 'SH_TO_DS'
     * @param {number} pairIndex - Index for transaction pairs
     * @returns {Promise<string>} Fingerprint (hex, 64 chars)
     */
    async deriveFingerprintFromSeed(seed, transactionType, pairIndex) {
      // Context: "FP_V1:TYPE:PAIR_INDEX"
      const context = `FP_V1:${transactionType}:${pairIndex}`;

      // Convert hex seed to Uint8Array
      const keyData = this.hexToUint8Array(seed);

      // Encode context
      const encoder = new TextEncoder();
      const msgData = encoder.encode(context);

      // Import key for HMAC-SHA256
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );

      // Compute HMAC
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);

      // Convert to hex
      const hashArray = Array.from(new Uint8Array(signature));
      const fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      return fingerprint;
    }

    /**
     * Generate fingerprints for a transaction pair
     *
     * @param {string} ratingRef - Rating reference
     * @param {number} pairIndex - Index of the transaction pair
     * @returns {Promise<Object>} { fingerprintCLtoSH, fingerprintSHtoDS }
     */
    async generateTransactionPairFingerprints(ratingRef, pairIndex) {
      const seedObj = await this.getSeeds(ratingRef);
      if (!seedObj) {
        throw new Error(`Seeds not found for ratingRef: ${ratingRef}`);
      }

      // Generiere beide Fingerprints für dieses Paar
      const fingerprintCLtoSH = await this.deriveFingerprintFromSeed(
        seedObj.seedCLtoSH, 'CL_TO_SH', pairIndex
      );

      const fingerprintSHtoDS = await this.deriveFingerprintFromSeed(
        seedObj.seedSHtoDS, 'SH_TO_DS', pairIndex
      );

      console.log('[FingerprintSeedManager] Pair fingerprints generated:', {
        ratingRef,
        pairIndex,
        fpCLtoSH: fingerprintCLtoSH.substring(0, 16) + '...',
        fpSHtoDS: fingerprintSHtoDS.substring(0, 16) + '...'
      });

      return { fingerprintCLtoSH, fingerprintSHtoDS };
    }

    /**
     * Add a transaction pair to the seed object
     *
     * @param {string} ratingRef - Rating reference
     * @param {number} pairIndex - Index of this pair
     * @param {string} clTxHash - CL→SH transaction hash
     * @param {string} dsTxHash - SH→DS transaction hash
     * @param {string} reason - 'initial' | 'correction'
     * @returns {Promise<Object>} The added pair
     */
    async addTransactionPair(ratingRef, pairIndex, clTxHash, dsTxHash, reason = 'initial') {
      const seedObj = await this.getSeeds(ratingRef);
      if (!seedObj) {
        throw new Error(`Seeds not found for ratingRef: ${ratingRef}`);
      }

      // Generiere Fingerprints für dieses Paar
      const { fingerprintCLtoSH, fingerprintSHtoDS } =
        await this.generateTransactionPairFingerprints(ratingRef, pairIndex);

      // Füge Paar hinzu
      const pair = {
        index: pairIndex,
        fingerprintCLtoSH,
        fingerprintSHtoDS,
        clTxHash,
        dsTxHash,
        status: 'completed',
        reason,
        createdAt: Date.now()
      };

      seedObj.transactionPairs.push(pair);
      await this.saveSeeds(seedObj);

      console.log('[FingerprintSeedManager] Transaction pair added:', {
        ratingRef,
        pairIndex,
        reason,
        fpCLtoSH: fingerprintCLtoSH.substring(0, 16) + '...',
        fpSHtoDS: fingerprintSHtoDS.substring(0, 16) + '...'
      });

      return pair;
    }

    /**
     * Save seeds to storage
     *
     * @param {Object} seedObj - Seed object
     */
    async saveSeeds(seedObj) {
      const data = await this.storage.get([this.STORAGE_KEY]);
      const seeds = data[this.STORAGE_KEY] || {};

      seeds[seedObj.ratingRef] = seedObj;

      await this.storage.set({ [this.STORAGE_KEY]: seeds });
    }

    /**
     * Get seeds by ratingRef
     *
     * @param {string} ratingRef - Rating reference
     * @returns {Promise<Object|null>} Seed object or null
     */
    async getSeeds(ratingRef) {
      const data = await this.storage.get([this.STORAGE_KEY]);
      const seeds = data[this.STORAGE_KEY] || {};
      return seeds[ratingRef] || null;
    }

    /**
     * Mark seeds as completed
     *
     * @param {string} ratingRef - Rating reference
     */
    async markCompleted(ratingRef) {
      const seedObj = await this.getSeeds(ratingRef);
      if (seedObj) {
        seedObj.status = 'completed';
        seedObj.completedAt = Date.now();
        await this.saveSeeds(seedObj);

        console.log('[FingerprintSeedManager] Seeds marked completed:', {
          ratingRef
        });
      }
    }

    /**
     * Clean up old seeds (retention policy)
     *
     * @param {number} maxAgeDays - Maximum age in days
     * @returns {Promise<number>} Number of deleted seeds
     */
    async cleanupOldSeeds(maxAgeDays = this.RETENTION_DAYS) {
      const data = await this.storage.get([this.STORAGE_KEY]);
      const seeds = data[this.STORAGE_KEY] || {};

      const now = Date.now();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

      let deletedCount = 0;
      for (const [ratingRef, seedObj] of Object.entries(seeds)) {
        const age = now - seedObj.createdAt;
        if (age > maxAgeMs) {
          delete seeds[ratingRef];
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        await this.storage.set({ [this.STORAGE_KEY]: seeds });
        console.log(`[FingerprintSeedManager] Cleaned up ${deletedCount} old seeds (>${maxAgeDays} days)`);
      }

      return deletedCount;
    }

    /**
     * Get all seeds (for debugging)
     *
     * @returns {Promise<Object>} All seeds
     */
    async getAllSeeds() {
      const data = await this.storage.get([this.STORAGE_KEY]);
      return data[this.STORAGE_KEY] || {};
    }

    /**
     * Clear all seeds (for testing/reset)
     */
    async clearAllSeeds() {
      await this.storage.remove([this.STORAGE_KEY]);
      console.log('[FingerprintSeedManager] All seeds cleared');
    }

    /**
     * Helper: Convert hex string to Uint8Array
     *
     * @param {string} hex - Hex string
     * @returns {Uint8Array} Byte array
     */
    hexToUint8Array(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return bytes;
    }

    /**
     * Get storage size info
     *
     * @returns {Promise<Object>} { seedCount, estimatedBytes }
     */
    async getStorageInfo() {
      const seeds = await this.getAllSeeds();
      const seedCount = Object.keys(seeds).length;

      // Rough estimate: Each seed ~500 bytes (2x 64-char seeds + metadata)
      const estimatedBytes = seedCount * 500;

      return { seedCount, estimatedBytes };
    }
  }

  // Rollup entry point for the Firefox addon wallet bundle.
  // Imports the three wallet classes from the revolution-wallet npm package
  // and exposes them as globals on window so that background.js and other
  // addon scripts can use them without ESM.


  if (typeof window !== 'undefined') {
    window.WalletManager = WalletManager;
    window.AnonTransactionClient = AnonTransactionClient;
    window.FingerprintSeedManager = FingerprintSeedManager;
  }

})();
