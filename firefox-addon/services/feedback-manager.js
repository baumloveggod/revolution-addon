/**
 * Feedback Manager
 *
 * Processes user feedback on ratings and adjusts future scoring:
 * 1. Validates feedback message
 * 2. Calculates score adjustment delta
 * 3. If delta exceeds threshold: queues a correction transaction
 * 4. Updates per-domain preference multiplier (applied to future ratings)
 *
 * Storage keys:
 *   domain_preferences  - { [domain]: { adjustmentFactor, feedbackCount, totalAdjustment, lastUpdated } }
 *   feedback_history    - Array of processed feedback records
 *   pending_corrections - Array of correction transactions awaiting processing
 *
 * Platform compatibility:
 *   Accepts any StorageAdapter (browser.storage.local wrapper, electron-store, AsyncStorage).
 *   The adapter must implement:
 *     get(key)          → Promise<value | null>
 *     set(key, value)   → Promise<void>
 *   Falls back to browser.storage.local directly if no adapter is provided.
 */

class FeedbackManager {
  /**
   * @param {Object} [storageAdapter] - Optional StorageAdapter (platform-independent).
   *   If omitted, uses browser.storage.local wrapped to match the adapter interface.
   */
  constructor(storageAdapter) {
    this.storage = storageAdapter || FeedbackManager._makeBrowserStorageAdapter();

    // Score delta → token threshold to trigger a correction transaction
    this.CORRECTION_THRESHOLD_TOKENS = 1000;

    // Exponential moving average learning rate for domain preferences
    this.ALPHA = 0.3;

    // Clamp adjustment factor to [0.5x, 2.0x]
    this.MIN_FACTOR = 0.5;
    this.MAX_FACTOR = 2.0;

    // Base score deltas per feedback type (scaled by original score later)
    this.BASE_DELTAS = {
      stars_1:     -750,
      stars_2:     -375,
      stars_3:        0,
      stars_4:     +375,
      stars_5:     +750,
      thumbs_up:   +200,
      thumbs_down: -200,
      too_high:    -300,
      too_low:     +300,
      correct:        0,
    };

    this.VALID_FEEDBACK_TYPES = new Set(Object.keys(this.BASE_DELTAS));
  }

  /**
   * Wraps browser.storage.local to match the StorageAdapter interface:
   *   get(key) → Promise<value | null>
   *   set(key, value) → Promise<void>
   *
   * This keeps FeedbackManager decoupled from the browser API directly
   * and ready for extraction into the platform-independent core module.
   */
  static _makeBrowserStorageAdapter() {
    return {
      async get(key) {
        const result = await browser.storage.local.get(key);
        return result[key] !== undefined ? result[key] : null;
      },
      async set(key, value) {
        await browser.storage.local.set({ [key]: value });
      },
    };
  }

  /**
   * Main entry point: process a decrypted feedback object.
   *
   * @param {Object} feedback
   * @param {string} feedback.rating_ref
   * @param {string} feedback.feedback_type
   * @param {string} feedback.domain
   * @param {string} [feedback.submitted_at]
   * @returns {Promise<{ correction: Object|null, preference_updated: boolean }>}
   */
  async processFeedback(feedback) {
    this._validate(feedback);

    const { rating_ref, feedback_type, domain } = feedback;

    // Load original rating to get its score for scaling the delta
    const originalRating = await this._loadRating(rating_ref);
    const originalScore = originalRating
      ? (originalRating.score || originalRating.final_score || 5000)
      : 5000;

    const adjustmentDelta = this._calculateDelta(feedback_type, originalScore);

    // Update domain preference regardless of threshold
    await this._updateDomainPreference(domain, adjustmentDelta);

    // Only queue a correction transaction when the delta is significant
    let correction = null;
    if (Math.abs(adjustmentDelta) >= this.CORRECTION_THRESHOLD_TOKENS
        && originalRating && originalRating.transaction_ref) {
      correction = await this._queueCorrection({
        original_transaction_ref: originalRating.transaction_ref,
        adjustment_tokens: adjustmentDelta,
        feedback_type,
        domain,
      });
    }

    await this._storeFeedbackRecord({
      id: `feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      rating_ref,
      feedback_type,
      adjustment_delta: adjustmentDelta,
      domain,
      correction_created: !!correction,
      correction_ref: correction ? correction.correction_ref : null,
      submitted_at: feedback.submitted_at || new Date().toISOString(),
      processed_at: new Date().toISOString(),
    });

    return { correction, preference_updated: true };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  _validate(feedback) {
    if (!feedback || typeof feedback !== 'object') {
      throw new Error('feedback must be an object');
    }
    if (!feedback.rating_ref || typeof feedback.rating_ref !== 'string') {
      throw new Error('feedback.rating_ref is required');
    }
    if (!feedback.feedback_type || !this.VALID_FEEDBACK_TYPES.has(feedback.feedback_type)) {
      throw new Error(
        `feedback.feedback_type must be one of: ${[...this.VALID_FEEDBACK_TYPES].join(', ')}`
      );
    }
    if (!feedback.domain || typeof feedback.domain !== 'string') {
      throw new Error('feedback.domain is required');
    }
  }

  _calculateDelta(feedbackType, originalScore) {
    const base = this.BASE_DELTAS[feedbackType] || 0;
    // Scale proportionally to original score (normalised around 5000)
    return Math.round(base * (originalScore / 5000));
  }

  async _loadRating(ratingRef) {
    try {
      const history = (await this.storage.get('rating_history')) || [];
      return history.find(
        (r) => r.transaction_ref === ratingRef || r.id === ratingRef
      ) || null;
    } catch (_) {
      return null;
    }
  }

  async _updateDomainPreference(domain, adjustmentDelta) {
    const prefs = (await this.storage.get('domain_preferences')) || {};

    if (!prefs[domain]) {
      prefs[domain] = {
        adjustmentFactor: 1.0,
        feedbackCount: 0,
        totalAdjustment: 0,
        lastUpdated: Date.now(),
      };
    }

    const newFactor = 1.0 + adjustmentDelta / 5000;
    prefs[domain].adjustmentFactor =
      this.ALPHA * newFactor + (1 - this.ALPHA) * prefs[domain].adjustmentFactor;

    prefs[domain].adjustmentFactor = Math.max(
      this.MIN_FACTOR,
      Math.min(this.MAX_FACTOR, prefs[domain].adjustmentFactor)
    );
    prefs[domain].feedbackCount += 1;
    prefs[domain].totalAdjustment += adjustmentDelta;
    prefs[domain].lastUpdated = Date.now();

    await this.storage.set('domain_preferences', prefs);
  }

  async _queueCorrection({ original_transaction_ref, adjustment_tokens, feedback_type, domain }) {
    const correction_ref =
      `correction-feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const correction = {
      type: 'correction_feedback',
      correction_ref,
      original_ref: original_transaction_ref,
      domain,
      tokens: adjustment_tokens,
      reason: feedback_type,
      occurred_at: new Date().toISOString(),
    };

    const queue = (await this.storage.get('pending_corrections')) || [];
    queue.push(correction);
    await this.storage.set('pending_corrections', queue);

    return correction;
  }

  async _storeFeedbackRecord(record) {
    const history = (await this.storage.get('feedback_history')) || [];
    history.push(record);

    // Keep last 500 records to avoid unbounded storage growth
    if (history.length > 500) {
      history.splice(0, history.length - 500);
    }

    await this.storage.set('feedback_history', history);
  }
}

// Expose as global for non-module addon context
if (typeof window !== 'undefined') {
  window.FeedbackManager = FeedbackManager;
}
