/**
 * Scoring Grammar Validator
 * Validates JSON message objects against the Revolution Rating DSL grammar.
 *
 * See scoring-grammar.ebnf for the formal specification.
 */

(function() {
  'use strict';

  const VALID_CONTENT_TYPES = [
    'CODE_REPOSITORY', 'TOOL', 'PLAYGROUND', 'TUTORIAL', 'DOCUMENTATION',
    'ARTICLE', 'BLOG_POST', 'VIDEO', 'PODCAST', 'DISCUSSION', 'NEWS',
    'SOCIAL_FEED', 'IMAGE_GALLERY', 'OTHER', 'UNKNOWN'
  ];

  const VALID_FEEDBACK_TYPES = [
    'stars_1', 'stars_2', 'stars_3', 'stars_4', 'stars_5',
    'thumbs_up', 'thumbs_down', 'too_high', 'too_low', 'correct'
  ];

  const VALID_RATING_TYPES = ['initial', 'correction'];

  class ScoringGrammarValidator {

    /**
     * Validate a rating message object.
     * @param {Object} msg
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateRatingMessage(msg) {
      const errors = [];
      if (!msg || typeof msg !== 'object') {
        return { valid: false, errors: ['Message must be a non-null object'] };
      }

      this._requireString(msg, 'transaction_ref', errors);
      this._requireString(msg, 'domain', errors);
      this._requireString(msg, 'tokens', errors);
      this._requireNumber(msg, 'score', errors);

      if (typeof msg.score === 'number' && (msg.score < 0 || msg.score > 10000)) {
        errors.push('score must be between 0 and 10000');
      }

      if (msg.type !== undefined && !VALID_RATING_TYPES.includes(msg.type)) {
        errors.push(`type must be one of: ${VALID_RATING_TYPES.join(', ')}`);
      }

      // Breakdown
      if (msg.breakdown !== undefined && msg.breakdown !== null) {
        this._validateBreakdown(msg.breakdown, errors);
      }

      // Distribution
      if (msg.distribution !== undefined && msg.distribution !== null) {
        this._validateDistribution(msg.distribution, errors);
      }

      // Metadata
      if (msg.metadata !== undefined && msg.metadata !== null) {
        if (typeof msg.metadata !== 'object') {
          errors.push('metadata must be an object');
        }
      }

      if (msg.occurred_at !== undefined && typeof msg.occurred_at !== 'string') {
        errors.push('occurred_at must be a string (ISO 8601 timestamp)');
      }

      return { valid: errors.length === 0, errors };
    }

    /**
     * Validate a feedback message object.
     * @param {Object} msg
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateFeedbackMessage(msg) {
      const errors = [];
      if (!msg || typeof msg !== 'object') {
        return { valid: false, errors: ['Message must be a non-null object'] };
      }

      this._requireString(msg, 'rating_ref', errors);
      this._requireString(msg, 'domain', errors);

      if (!msg.feedback_type || !VALID_FEEDBACK_TYPES.includes(msg.feedback_type)) {
        errors.push(`feedback_type must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}`);
      }

      if (msg.submitted_at !== undefined && typeof msg.submitted_at !== 'string') {
        errors.push('submitted_at must be a string (ISO 8601 timestamp)');
      }

      return { valid: errors.length === 0, errors };
    }

    /**
     * Validate a correction message object.
     * @param {Object} msg
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateCorrectionMessage(msg) {
      const errors = [];
      if (!msg || typeof msg !== 'object') {
        return { valid: false, errors: ['Message must be a non-null object'] };
      }

      this._requireString(msg, 'transaction_ref', errors);
      this._requireString(msg, 'original_ref', errors);
      this._requireString(msg, 'domain', errors);
      this._requireString(msg, 'tokens', errors);
      this._requireNumber(msg, 'score', errors);

      if (msg.type !== undefined && msg.type !== 'correction') {
        errors.push('type must be "correction"');
      }

      return { valid: errors.length === 0, errors };
    }

    // --- Internal helpers ---

    _validateBreakdown(bd, errors) {
      if (typeof bd !== 'object') {
        errors.push('breakdown must be an object');
        return;
      }

      // contentType
      if (bd.contentType) {
        if (bd.contentType.type && !VALID_CONTENT_TYPES.includes(bd.contentType.type)) {
          errors.push(`breakdown.contentType.type must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
        }
        if (bd.contentType.multiplier !== undefined && typeof bd.contentType.multiplier !== 'number') {
          errors.push('breakdown.contentType.multiplier must be a number');
        }
      }

      // interaction
      if (bd.interaction) {
        if (typeof bd.interaction !== 'object') {
          errors.push('breakdown.interaction must be an object');
        }
      }

      // quality
      if (bd.quality) {
        if (typeof bd.quality.factor === 'number' && (bd.quality.factor < 0 || bd.quality.factor > 2)) {
          errors.push('breakdown.quality.factor should be between 0 and 2');
        }
      }

      // oss
      if (bd.oss) {
        if (typeof bd.oss.bonus === 'number' && (bd.oss.bonus < 0 || bd.oss.bonus > 1)) {
          errors.push('breakdown.oss.bonus should be between 0 and 1');
        }
      }

      // domainPreference
      if (bd.domainPreference) {
        if (typeof bd.domainPreference.applied !== 'boolean') {
          errors.push('breakdown.domainPreference.applied must be a boolean');
        }
        if (bd.domainPreference.applied && typeof bd.domainPreference.adjustmentFactor !== 'number') {
          errors.push('breakdown.domainPreference.adjustmentFactor required when applied=true');
        }
      }
    }

    _validateDistribution(dist, errors) {
      if (typeof dist !== 'object') {
        errors.push('distribution must be an object');
        return;
      }

      if (typeof dist.safetyFactor === 'number' && (dist.safetyFactor < 0 || dist.safetyFactor > 1)) {
        errors.push('distribution.safetyFactor must be between 0 and 1');
      }
      if (typeof dist.payoutFactor === 'number' && (dist.payoutFactor < 0 || dist.payoutFactor > 1)) {
        errors.push('distribution.payoutFactor must be between 0 and 1');
      }
    }

    _requireString(obj, field, errors) {
      if (!obj[field] || typeof obj[field] !== 'string') {
        errors.push(`${field} is required and must be a string`);
      }
    }

    _requireNumber(obj, field, errors) {
      if (obj[field] === undefined || obj[field] === null || typeof obj[field] !== 'number') {
        errors.push(`${field} is required and must be a number`);
      }
    }
  }

  // Export
  window.ScoringGrammarValidator = ScoringGrammarValidator;

  console.log('[ScoringGrammarValidator] Loaded');
})();
