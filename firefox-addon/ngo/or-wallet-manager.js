/**
 * OR-Wallet Manager
 *
 * Verwaltet OR-Wallets (Oracle/NGO Wallets)
 *
 * OR-Wallet Lifecycle:
 * 1. Einzahlung (SH → OR)
 * 2. Haltezeit (z.B. 180 Tage)
 * 3. Fulfillment-Prüfung
 * 4. Auszahlung:
 *    - Fulfillment% → DS (Domain)
 *    - Rest → CT (Charity Fallback)
 *
 * Beispiel:
 * - Kriterium: "Ökostrom"
 * - Fulfillment: 50% (Domain nutzt 50% Ökostrom)
 * - Buffer: 1000 Tokens
 * - Auszahlung: 500 → DS, 500 → CT
 */

class ORWalletManager {
  constructor(config, criteriaMatcher) {
    this.config = config;
    this.criteriaMatcher = criteriaMatcher;
    this.wallets = new Map(); // walletAddress -> OR-Wallet State
  }

  /**
   * Erstellt neues OR-Wallet
   */
  createORWallet(criterion, domain, orConfig) {
    const walletAddress = this.criteriaMatcher.formatORWallet(criterion, domain);

    const wallet = {
      address: walletAddress,
      criterion: criterion,
      domain: domain,
      buffer: 0n, // Akkumulierte Tokens
      primaryWallet: orConfig.primaryWallet,
      fallbackWallet: orConfig.fallbackWallet,
      expiryDays: orConfig.expiryDays,
      fulfillment: orConfig.fulfillment,
      firstDepositAt: null,
      lastDepositAt: null,
      depositCount: 0,
      metadata: orConfig.metadata || {}
    };

    this.wallets.set(walletAddress, wallet);

    return wallet;
  }

  /**
   * Fügt Deposit zu OR-Wallet hinzu
   */
  addDeposit(walletAddress, amount) {
    let wallet = this.wallets.get(walletAddress);

    if (!wallet) {
      // Auto-create (falls OR-Config existiert)
      // TODO: Holen von Criterion + Domain aus walletAddress
      throw new Error(`OR-Wallet not found: ${walletAddress}`);
    }

    // Update Buffer
    wallet.buffer += amount;

    // Update Timestamps
    if (!wallet.firstDepositAt) {
      wallet.firstDepositAt = new Date().toISOString();
    }
    wallet.lastDepositAt = new Date().toISOString();
    wallet.depositCount += 1;

    this.wallets.set(walletAddress, wallet);

    return wallet;
  }

  /**
   * Prüft ob OR-Wallet reif für Auszahlung ist
   */
  isWalletMature(walletAddress, currentDate = new Date()) {
    const wallet = this.wallets.get(walletAddress);

    if (!wallet || !wallet.firstDepositAt) {
      return false;
    }

    const firstDeposit = new Date(wallet.firstDepositAt);
    const expiryDate = new Date(firstDeposit);
    expiryDate.setDate(expiryDate.getDate() + wallet.expiryDays);

    return currentDate >= expiryDate;
  }

  /**
   * Berechnet Fulfillment-Grad
   * Returns: 0.0 - 1.0
   */
  calculateFulfillmentRatio(wallet) {
    const { num, den } = wallet.fulfillment;

    if (den === 0) {
      return 0;
    }

    return num / den;
  }

  /**
   * Führt OR-Wallet Payout aus
   */
  executeORPayout(walletAddress, currentDate = new Date()) {
    const wallet = this.wallets.get(walletAddress);

    if (!wallet) {
      throw new Error(`OR-Wallet not found: ${walletAddress}`);
    }

    if (!this.isWalletMature(walletAddress, currentDate)) {
      throw new Error(`OR-Wallet not mature yet: ${walletAddress}`);
    }

    if (wallet.buffer === 0n) {
      return {
        primaryPayment: null,
        fallbackPayment: null,
        totalPaid: 0n
      };
    }

    // Fulfillment-Ratio
    const fulfillmentRatio = this.calculateFulfillmentRatio(wallet);

    // Aufteilung
    const primaryAmount = BigInt(Math.floor(Number(wallet.buffer) * fulfillmentRatio));
    const fallbackAmount = wallet.buffer - primaryAmount;

    const primaryPayment = primaryAmount > 0n ? {
      wallet: wallet.primaryWallet, // DS-Wallet der Domain
      amount: primaryAmount,
      type: 'or_primary_payout'
    } : null;

    const fallbackPayment = fallbackAmount > 0n ? {
      wallet: wallet.fallbackWallet, // CT-Wallet (Charity)
      amount: fallbackAmount,
      type: 'or_fallback_payout'
    } : null;

    // Reset Buffer
    wallet.buffer = 0n;
    this.wallets.set(walletAddress, wallet);

    return {
      walletAddress: walletAddress,
      criterion: wallet.criterion,
      domain: wallet.domain,
      fulfillmentRatio: fulfillmentRatio,
      primaryPayment: primaryPayment,
      fallbackPayment: fallbackPayment,
      totalPaid: primaryAmount + fallbackAmount
    };
  }

  /**
   * Prüft alle OR-Wallets auf fällige Payouts
   */
  checkAllWalletsForPayout(currentDate = new Date()) {
    const matureWallets = [];

    for (const [walletAddress, wallet] of this.wallets.entries()) {
      if (this.isWalletMature(walletAddress, currentDate) && wallet.buffer > 0n) {
        matureWallets.push(walletAddress);
      }
    }

    return matureWallets;
  }

  /**
   * Führt alle fälligen Payouts aus
   */
  async executeAllMaturePayouts(currentDate = new Date()) {
    const matureWallets = this.checkAllWalletsForPayout(currentDate);
    const payouts = [];

    for (const walletAddress of matureWallets) {
      try {
        const payout = this.executeORPayout(walletAddress, currentDate);
        payouts.push(payout);
      } catch (error) {
        console.error(`[ORWalletManager] Payout failed for ${walletAddress}:`, error);
      }
    }

    return payouts;
  }

  /**
   * Aktualisiert Fulfillment-Grad für Wallet
   * (Wird von NGO aktualisiert)
   */
  updateFulfillment(walletAddress, newFulfillment) {
    const wallet = this.wallets.get(walletAddress);

    if (!wallet) {
      throw new Error(`OR-Wallet not found: ${walletAddress}`);
    }

    wallet.fulfillment = newFulfillment;
    this.wallets.set(walletAddress, wallet);

    return wallet;
  }

  /**
   * Holt OR-Wallet State
   */
  getWallet(walletAddress) {
    return this.wallets.get(walletAddress);
  }

  /**
   * Holt alle OR-Wallets
   */
  getAllWallets() {
    return Array.from(this.wallets.values());
  }

  /**
   * Holt OR-Wallets für Domain
   */
  getWalletsForDomain(domain) {
    const wallets = [];

    for (const wallet of this.wallets.values()) {
      if (wallet.domain === domain) {
        wallets.push(wallet);
      }
    }

    return wallets;
  }

  /**
   * Persistiert OR-Wallets
   */
  async saveWallets(storage = browser.storage.local) {
    const walletsData = {};

    for (const [address, wallet] of this.wallets.entries()) {
      walletsData[address] = {
        ...wallet,
        buffer: wallet.buffer.toString()
      };
    }

    await storage.set({
      'rev_or_wallets': walletsData
    });
  }

  /**
   * Lädt OR-Wallets
   */
  async loadWallets(storage = browser.storage.local) {
    const data = await storage.get(['rev_or_wallets']);
    const walletsData = data.rev_or_wallets || {};

    this.wallets.clear();

    for (const [address, wallet] of Object.entries(walletsData)) {
      this.wallets.set(address, {
        ...wallet,
        buffer: BigInt(wallet.buffer)
      });
    }
  }

  /**
   * Statistiken
   */
  getStatistics() {
    const totalWallets = this.wallets.size;
    let totalBuffer = 0n;
    let matureWallets = 0;

    for (const wallet of this.wallets.values()) {
      totalBuffer += wallet.buffer;
      if (this.isWalletMature(wallet.address)) {
        matureWallets += 1;
      }
    }

    return {
      totalWallets: totalWallets,
      totalBuffer: totalBuffer.toString(),
      matureWallets: matureWallets,
      pendingWallets: totalWallets - matureWallets
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.ORWalletManager = ORWalletManager;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ORWalletManager;
}
