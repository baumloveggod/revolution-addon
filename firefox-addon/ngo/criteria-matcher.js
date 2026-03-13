/**
 * NGO Criteria Matcher
 *
 * Prüft ob Domains User-Kriterien erfüllen
 * Leitet Geld an NGOs (OR-Wallets) wenn Kriterien nicht erfüllt
 *
 * Logik:
 * - Alle Kriterien erfüllt → DS-Wallet (Domain)
 * - Nicht erfüllt → OR-Wallet (NGO), gewichtet nach Priorität
 *
 * OR-Wallet Mechanik:
 * - Separates OR-Wallet pro (Kriterium × Domain)
 * - Haltezeit (z.B. 180 Tage)
 * - Nach Haltezeit: Fulfillment% an DS, Rest an CT (Charity Fallback)
 */

class CriteriaMatcher {
  constructor(config) {
    this.config = config;
    this.criteriaDatabase = new Map(); // criterion -> OR-Wallet config
  }

  /**
   * Hauptfunktion: Bestimmt Geldfluss-Ziel
   *
   * @param {string} domain - Ziel-Domain
   * @param {BigInt} tokenAmount - Token-Menge
   * @param {Array} userPreferences - User-Kriterien
   * @param {Object} domainData - Domain-Metadaten (Erfüllungs-Status)
   * @returns {Object} Geldfluss-Verteilung
   */
  determineWalletTarget(domain, tokenAmount, userPreferences, domainData = {}) {
    // Keine Präferenzen → direkt an DS
    if (!userPreferences || userPreferences.length === 0) {
      return this.createDirectDSPayment(domain, tokenAmount);
    }

    // Prüfe jedes Kriterium
    const unmetCriteria = [];

    for (const pref of userPreferences) {
      const isFulfilled = this.checkCriterionFulfillment(
        domain,
        pref.criterion,
        domainData
      );

      if (!isFulfilled) {
        unmetCriteria.push(pref);
      }
    }

    // Alle Kriterien erfüllt → DS
    if (unmetCriteria.length === 0) {
      return this.createDirectDSPayment(domain, tokenAmount);
    }

    // Nicht erfüllt → Gewichtete OR-Verteilung
    return this.createORDistribution(domain, tokenAmount, unmetCriteria);
  }

  /**
   * Prüft ob Domain Kriterium erfüllt
   */
  checkCriterionFulfillment(domain, criterion, domainData) {
    // Check in domainData ob Kriterium erfüllt ist
    if (domainData.criteria && domainData.criteria[criterion] !== undefined) {
      return domainData.criteria[criterion] === true;
    }

    // Default: Nicht erfüllt (konservativ)
    return false;
  }

  /**
   * Erstellt direkte DS-Zahlung (alle Kriterien erfüllt)
   */
  createDirectDSPayment(domain, tokenAmount) {
    return {
      dsPayment: {
        wallet: this.formatDSWallet(domain),
        amount: tokenAmount,
        domain: domain
      },
      orPayments: []
    };
  }

  /**
   * Erstellt gewichtete OR-Verteilung
   */
  createORDistribution(domain, tokenAmount, unmetCriteria) {
    // Berechne Gesamt-Gewicht
    const totalWeight = unmetCriteria.reduce((sum, c) => sum + c.weight, 0);

    if (totalWeight === 0) {
      // Fallback: Gleichverteilung
      return this.createEqualORDistribution(domain, tokenAmount, unmetCriteria);
    }

    // Gewichtete Verteilung
    const orPayments = [];

    for (const criterion of unmetCriteria) {
      const share = (criterion.weight / totalWeight);
      const amount = BigInt(Math.floor(Number(tokenAmount) * share));

      if (amount > 0n) {
        orPayments.push({
          wallet: this.formatORWallet(criterion.criterion, domain),
          amount: amount,
          criterion: criterion.criterion,
          priority: criterion.priority,
          weight: criterion.weight,
          domain: domain
        });
      }
    }

    return {
      dsPayment: null,
      orPayments: orPayments
    };
  }

  /**
   * Erstellt gleichverteilte OR-Payments (Fallback)
   */
  createEqualORDistribution(domain, tokenAmount, unmetCriteria) {
    const share = tokenAmount / BigInt(unmetCriteria.length);
    const orPayments = [];

    for (const criterion of unmetCriteria) {
      orPayments.push({
        wallet: this.formatORWallet(criterion.criterion, domain),
        amount: share,
        criterion: criterion.criterion,
        priority: criterion.priority,
        domain: domain
      });
    }

    return {
      dsPayment: null,
      orPayments: orPayments
    };
  }

  /**
   * Formatiert DS-Wallet Adresse
   * Format: DS::<domain-hash>
   */
  formatDSWallet(domain) {
    // In Production: Echte Wallet-Adresse vom Backend holen
    // Für jetzt: Placeholder
    const domainHash = this.hashDomain(domain);
    return `DS::${domainHash}`;
  }

  /**
   * Formatiert OR-Wallet Adresse
   * Format: OR::<criterion>-<domain-hash>
   */
  formatORWallet(criterion, domain) {
    const domainHash = this.hashDomain(domain);
    const criterionSlug = this.slugifyCriterion(criterion);
    return `OR::${criterionSlug}-${domainHash}`;
  }

  /**
   * Hash-Funktion für Domains
   */
  hashDomain(domain) {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      const char = domain.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).substring(0, 8);
  }

  /**
   * Slugify Criterion
   */
  slugifyCriterion(criterion) {
    return criterion
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 20);
  }

  /**
   * Registriert OR-Wallet Config für Kriterium
   */
  registerCriterion(criterion, orConfig) {
    this.criteriaDatabase.set(criterion, {
      criterion: criterion,
      primaryWallet: orConfig.primaryWallet, // NGO Hauptwallet
      fallbackWallet: orConfig.fallbackWallet, // Charity Fallback (CT)
      expiryDays: orConfig.expiryDays || 180, // Default 180 Tage
      fulfillment: orConfig.fulfillment || { num: 100, den: 100 }, // Default 100%
      metadata: orConfig.metadata || {}
    });
  }

  /**
   * Holt OR-Config für Kriterium
   */
  getORConfig(criterion) {
    return this.criteriaDatabase.get(criterion);
  }

  /**
   * Lädt Kriterien-Database aus Storage
   */
  async loadCriteriaDatabase(storage = browser.storage.local) {
    const data = await storage.get(['rev_ngo_criteria']);
    const criteria = data.rev_ngo_criteria || {};

    this.criteriaDatabase.clear();

    for (const [criterion, config] of Object.entries(criteria)) {
      this.criteriaDatabase.set(criterion, config);
    }
  }

  /**
   * Speichert Kriterien-Database
   */
  async saveCriteriaDatabase(storage = browser.storage.local) {
    const criteria = {};

    for (const [criterion, config] of this.criteriaDatabase.entries()) {
      criteria[criterion] = config;
    }

    await storage.set({
      'rev_ngo_criteria': criteria
    });
  }

  /**
   * Beispiel User-Präferenzen
   */
  static getExamplePreferences() {
    return [
      {
        criterion: 'Ökostrom',
        priority: 1,
        weight: 0.70,
        description: 'Server läuft mit 100% erneuerbarer Energie'
      },
      {
        criterion: 'Keine Werbung',
        priority: 2,
        weight: 0.50,
        description: 'Keine kommerzielle Werbung auf der Seite'
      },
      {
        criterion: 'Open Source',
        priority: 3,
        weight: 0.30,
        description: 'Code ist öffentlich verfügbar'
      }
    ];
  }

  /**
   * Beispiel Domain-Daten
   */
  static getExampleDomainData(domain) {
    // In Production: Von Backend/API geholt
    return {
      domain: domain,
      criteria: {
        'Ökostrom': false,        // Nicht erfüllt
        'Keine Werbung': true,    // Erfüllt
        'Open Source': false      // Nicht erfüllt
      },
      lastChecked: new Date().toISOString()
    };
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.CriteriaMatcher = CriteriaMatcher;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CriteriaMatcher;
}
