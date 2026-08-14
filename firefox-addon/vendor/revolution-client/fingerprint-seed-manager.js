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

export { FingerprintSeedManager };
export default FingerprintSeedManager;
