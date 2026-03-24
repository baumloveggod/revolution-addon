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

export { WalletManager };
export default WalletManager;
