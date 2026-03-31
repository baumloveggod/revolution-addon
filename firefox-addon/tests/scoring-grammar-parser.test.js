/**
 * Tests for ScoringGrammarValidator
 *
 * Validates that rating, feedback, and correction messages are correctly
 * checked against the grammar rules defined in scoring-grammar.ebnf.
 */

class TestRunner {
  constructor() { this.tests = []; this.passed = 0; this.failed = 0; }
  test(name, fn) { this.tests.push({ name, fn }); }
  async run() {
    console.log('═'.repeat(60));
    console.log('SCORING GRAMMAR VALIDATOR - TESTS');
    console.log('═'.repeat(60));
    for (const t of this.tests) {
      try { await t.fn(); this.passed++; console.log(`✅ PASS: ${t.name}`); }
      catch (e) { this.failed++; console.error(`❌ FAIL: ${t.name}\n   ${e.message}`); }
    }
    console.log(`\nResults: ${this.passed} passed, ${this.failed} failed`);
    return this.failed === 0;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// --- Test Suite ---

const runner = new TestRunner();
const V = new ScoringGrammarValidator();

// ======== Rating Messages ========

runner.test('valid rating message passes', () => {
  const r = V.validateRatingMessage({
    transaction_ref: 'tx-123',
    wallet_address: '0xabc',
    domain: 'github.com',
    tokens: '1000000',
    score: 5000,
    type: 'initial',
    breakdown: {
      contentType: { type: 'CODE_REPOSITORY', multiplier: 1.4 },
      interaction: { baseScore: 3000, activeTime: 120, passiveTime: 30, bonuses: {} },
      quality: { factor: 0.9, trackers: 2, ads: 0, performance: 0.1 },
      oss: { bonus: 0.3, multiplier: 1.3 }
    },
    distribution: {
      rawTokens: '2000000', payoutTokens: '1000000', bufferedTokens: '1000000',
      standardizedTokens: '1000000', safetyFactor: 0.5, payoutFactor: 0.5, daysSinceStart: 45
    },
    metadata: { url: 'https://github.com/test', sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', configVersion: '2.0.0' },
    occurred_at: '2026-01-01T00:00:00Z'
  });
  assert(r.valid, 'Expected valid, got errors: ' + r.errors.join(', '));
});

runner.test('rating message missing transaction_ref fails', () => {
  const r = V.validateRatingMessage({ domain: 'x.com', tokens: '1', score: 100 });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('transaction_ref')));
});

runner.test('rating message with score out of range fails', () => {
  const r = V.validateRatingMessage({ transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 99999 });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('score')));
});

runner.test('rating message with invalid type fails', () => {
  const r = V.validateRatingMessage({ transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 100, type: 'bogus' });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('type')));
});

runner.test('rating with invalid content type fails', () => {
  const r = V.validateRatingMessage({
    transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 100,
    breakdown: { contentType: { type: 'INVALID', multiplier: 1.0 } }
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('contentType.type')));
});

runner.test('rating with domainPreference applied=true requires adjustmentFactor', () => {
  const r = V.validateRatingMessage({
    transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 100,
    breakdown: { domainPreference: { domain: 'x.com', applied: true } }
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('adjustmentFactor')));
});

runner.test('rating with domainPreference applied=false is ok without adjustmentFactor', () => {
  const r = V.validateRatingMessage({
    transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 100,
    breakdown: { domainPreference: { domain: 'x.com', applied: false } }
  });
  assert(r.valid, 'Expected valid, got: ' + r.errors.join(', '));
});

runner.test('null message fails', () => {
  const r = V.validateRatingMessage(null);
  assert(!r.valid);
});

// ======== Feedback Messages ========

runner.test('valid feedback message passes', () => {
  const r = V.validateFeedbackMessage({
    rating_ref: 'tx-abc', feedback_type: 'stars_5', domain: 'github.com',
    submitted_at: '2026-01-01T00:00:00Z'
  });
  assert(r.valid, 'Expected valid, got: ' + r.errors.join(', '));
});

runner.test('feedback with invalid type fails', () => {
  const r = V.validateFeedbackMessage({
    rating_ref: 'tx-abc', feedback_type: 'stars_99', domain: 'x.com'
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('feedback_type')));
});

runner.test('feedback missing rating_ref fails', () => {
  const r = V.validateFeedbackMessage({ feedback_type: 'thumbs_up', domain: 'x.com' });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('rating_ref')));
});

runner.test('all feedback types are accepted', () => {
  const types = ['stars_1','stars_2','stars_3','stars_4','stars_5','thumbs_up','thumbs_down','too_high','too_low','correct'];
  for (const ft of types) {
    const r = V.validateFeedbackMessage({ rating_ref: 'r1', feedback_type: ft, domain: 'd' });
    assert(r.valid, `Expected ${ft} to be valid, got: ${r.errors.join(', ')}`);
  }
});

// ======== Correction Messages ========

runner.test('valid correction message passes', () => {
  const r = V.validateCorrectionMessage({
    transaction_ref: 'corr-1', original_ref: 'tx-1', domain: 'x.com',
    tokens: '500', score: 100, type: 'correction'
  });
  assert(r.valid, 'Expected valid, got: ' + r.errors.join(', '));
});

runner.test('correction with wrong type fails', () => {
  const r = V.validateCorrectionMessage({
    transaction_ref: 'c1', original_ref: 'tx-1', domain: 'x.com',
    tokens: '500', score: 100, type: 'initial'
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('type')));
});

runner.test('correction missing original_ref fails', () => {
  const r = V.validateCorrectionMessage({
    transaction_ref: 'c1', domain: 'x.com', tokens: '500', score: 100
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('original_ref')));
});

// ======== Distribution Bounds ========

runner.test('distribution with safetyFactor out of range fails', () => {
  const r = V.validateRatingMessage({
    transaction_ref: 'tx-1', domain: 'x.com', tokens: '1', score: 100,
    distribution: { safetyFactor: 1.5, payoutFactor: 0.5, daysSinceStart: 1 }
  });
  assert(!r.valid);
  assert(r.errors.some(e => e.includes('safetyFactor')));
});

// Run
runner.run();
