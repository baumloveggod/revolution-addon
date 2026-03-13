/**
 * Entity Resolver Service
 *
 * Kommuniziert mit server-api /entity/resolve endpoint
 * um Wallet-Adressen für Domains zu holen
 */

class EntityResolver {
  constructor(serverApiUrl = 'http://192.168.178.130:3000') {
    this.serverApiUrl = serverApiUrl;
  }

  /**
   * Holt Wallet-Adresse für eine Domain vom Entity Name Service
   *
   * @param {string} domain - Die Domain (z.B. "music.lenkenhoff.de")
   * @param {string} userToken - User-Token für Authentifizierung
   * @returns {Promise<Object>} Entity-Daten mit walletAddress
   */
  async resolveEntity(domain, userToken) {
    if (!domain) {
      throw new Error('Domain is required');
    }

    if (!userToken) {
      throw new Error('User token is required for entity resolution');
    }

    try {
      const url = `${this.serverApiUrl}/entity/resolve?domain=${encodeURIComponent(domain)}`;

      console.log('[EntityResolver] 📤 Resolving entity for domain:', { domain, url });

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('[EntityResolver] ❌ API returned error:', {
          status: response.status,
          statusText: response.statusText,
          error: error,
          domain: domain,
          url: url
        });
        throw new Error(`Entity resolution failed: ${error.error || response.statusText}`);
      }

      const data = await response.json();

      console.log('[EntityResolver] ✅ Entity resolved:', {
        domain,
        kind: data.kind,
        wallet_address: data.wallet_address?.substring(0, 10) + '...',
        hasTrackingRules: !!data.tracking_rules
      });

      return data;
    } catch (error) {
      console.error('[EntityResolver] ❌ Failed to resolve entity:', error.message);
      throw error;
    }
  }

  /**
   * Holt Wallet-Adresse für Domain und speichert sie
   *
   * @param {string} domain - Die Domain
   * @param {string} userToken - User-Token
   * @param {Object} storage - Browser storage (default: browser.storage.local)
   * @returns {Promise<string>} Wallet-Adresse (Flow-tagged: DS::0x... or OR::0x...)
   */
  async getAndCacheWalletAddress(domain, userToken, storage = browser.storage.local) {
    // Prüfe ob bereits gecacht
    const data = await storage.get(['rev_domain_wallets']);
    const domainWallets = data.rev_domain_wallets || {};

    if (domainWallets[domain]) {
      console.log('[EntityResolver] 💾 Using cached wallet address for:', domain);
      return domainWallets[domain];
    }

    // Nicht gecacht → von API holen
    console.log('[EntityResolver] 🌐 Fetching wallet address from API for:', domain);

    const entity = await this.resolveEntity(domain, userToken);

    if (!entity.wallet_flow_address) {
      console.error('[EntityResolver] ❌ No wallet_flow_address in response:', {
        domain: domain,
        responseKeys: Object.keys(entity),
        entity: entity
      });
      throw new Error(`No wallet_flow_address returned for domain: ${domain}`);
    }

    // In Cache speichern (Flow-tagged format: DS::0x... or OR::0x...)
    const walletFlowAddress = entity.wallet_flow_address;
    domainWallets[domain] = walletFlowAddress;
    await storage.set({ rev_domain_wallets: domainWallets });

    console.log('[EntityResolver] 💾 Wallet address cached for:', domain);

    return walletFlowAddress;
  }

  /**
   * Lädt alle gecachten Wallet-Adressen
   *
   * @param {Object} storage - Browser storage
   * @returns {Promise<Object>} Domain → Wallet Mapping
   */
  async getCachedWallets(storage = browser.storage.local) {
    const data = await storage.get(['rev_domain_wallets']);
    return data.rev_domain_wallets || {};
  }

  /**
   * Löscht Cache für eine Domain
   *
   * @param {string} domain - Die Domain
   * @param {Object} storage - Browser storage
   */
  async clearCacheForDomain(domain, storage = browser.storage.local) {
    const data = await storage.get(['rev_domain_wallets']);
    const domainWallets = data.rev_domain_wallets || {};

    delete domainWallets[domain];

    await storage.set({ rev_domain_wallets: domainWallets });

    console.log('[EntityResolver] 🗑️ Cache cleared for:', domain);
  }

  /**
   * Löscht gesamten Wallet-Cache
   *
   * @param {Object} storage - Browser storage
   */
  async clearAllCache(storage = browser.storage.local) {
    await storage.set({ rev_domain_wallets: {} });
    console.log('[EntityResolver] 🗑️ All wallet cache cleared');
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.EntityResolver = EntityResolver;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EntityResolver;
}
