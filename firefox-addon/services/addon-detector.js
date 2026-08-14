/**
 * Addon Detector - Erkennt installierte Browser-Extensions
 *
 * Nutzt browser.management.getAll() um aktive Extensions zu erkennen
 * und als Beneficiaries fuer Multi-Beneficiary Ratings bereitzustellen.
 *
 * Die "management"-Permission wurde entfernt (Review-Freundlichkeit).
 * Ohne sie faellt getActiveAddons() automatisch auf "nur Revolution
 * selbst" zurueck (siehe catch-Block). Zum Reaktivieren der vollen
 * Erkennung wieder "management" in manifest.json aufnehmen.
 */

class AddonDetector {
  constructor() {
    // Eigene ID zur Laufzeit erfragen — der selbstgehostete Build laeuft unter
    // einer anderen Add-on-ID als der AMO-Build.
    this.SELF_ADDON_ID = (() => {
      try {
        return browser.runtime.id;
      } catch {
        return 'revolution@lenkenhoff.de';
      }
    })();
    this.SELF_BENEFICIARY_ID = 'addon:revolution';
    this._cachedAddons = null;
    this._cacheTimestamp = 0;
    this.CACHE_TTL_MS = 60 * 1000; // 1 Minute Cache
  }

  /**
   * Erkennt alle aktiven Extensions (cached).
   * @returns {Promise<Array<{id: string, name: string, beneficiaryId: string}>>}
   */
  async getActiveAddons() {
    const now = Date.now();
    if (this._cachedAddons && (now - this._cacheTimestamp) < this.CACHE_TTL_MS) {
      return this._cachedAddons;
    }

    try {
      const allExtensions = await browser.management.getAll();

      const addons = allExtensions
        .filter(ext => ext.type === 'extension' && ext.enabled)
        .map(ext => ({
          id: ext.id,
          name: ext.name,
          beneficiaryId: `addon:${this._slugify(ext.name)}`
        }));

      // Revolution-Addon immer inkludieren (falls nicht schon drin)
      const hasSelf = addons.some(a => a.id === this.SELF_ADDON_ID);
      if (!hasSelf) {
        addons.push({
          id: this.SELF_ADDON_ID,
          name: 'Revolution',
          beneficiaryId: this.SELF_BENEFICIARY_ID
        });
      }

      this._cachedAddons = addons;
      this._cacheTimestamp = now;

      console.log(`[AddonDetector] Found ${addons.length} active extensions:`,
        addons.map(a => a.beneficiaryId));

      return addons;
    } catch (err) {
      console.warn('[AddonDetector] browser.management not available:', err.message);
      // Fallback: nur Revolution selbst
      return [{
        id: this.SELF_ADDON_ID,
        name: 'Revolution',
        beneficiaryId: this.SELF_BENEFICIARY_ID
      }];
    }
  }

  /**
   * Erstellt eine slugified beneficiary_id aus dem Addon-Namen.
   * z.B. "uBlock Origin" -> "ublock-origin"
   */
  _slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Invalidiert den Cache (z.B. nach Addon-Installation/-Deinstallation)
   */
  invalidateCache() {
    this._cachedAddons = null;
    this._cacheTimestamp = 0;
  }

  /**
   * Reports discovered addons to the entity service's AddonCatalog.
   * Called periodically so that the crowd can vote on addon weights.
   * @param {string} entityServiceUrl - Entity service base URL
   * @param {string} apiKey - API key for entity service
   */
  async reportNewAddons(entityServiceUrl, apiKey) {
    if (!entityServiceUrl || !apiKey) return;

    const addons = await this.getActiveAddons();

    for (const addon of addons) {
      try {
        await fetch(`${entityServiceUrl}/addons/catalog`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
          },
          body: JSON.stringify({
            beneficiaryId: addon.beneficiaryId,
            displayName: addon.name,
          }),
        });
      } catch (err) {
        // Non-critical: catalog registration may fail silently
        console.warn(`[AddonDetector] Could not report ${addon.beneficiaryId}:`, err.message);
      }
    }
  }
}

// Global Instance
if (typeof window !== 'undefined') {
  window.AddonDetector = AddonDetector;
  window._addonDetector = new AddonDetector();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AddonDetector };
}
