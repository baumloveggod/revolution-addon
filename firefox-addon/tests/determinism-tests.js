/**
 * Determinismus-Tests
 *
 * Prüft dass alle Berechnungen deterministisch sind:
 * - Gleiche Eingaben → Gleiche Ausgaben
 * - Über mehrere Durchläufe
 * - Unabhängig von Ausführungsreihenfolge
 *
 * KRITISCH für Multi-Client Konsens!
 */

// Test-Framework (einfach)
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('═'.repeat(60));
    console.log('REVOLUTION SCORING - DETERMINISM TESTS');
    console.log('═'.repeat(60));
    console.log('');

    for (const test of this.tests) {
      try {
        await test.fn();
        this.passed++;
        console.log(`✅ PASS: ${test.name}`);
      } catch (error) {
        this.failed++;
        console.error(`❌ FAIL: ${test.name}`);
        console.error(`   Error: ${error.message}`);
      }
    }

    console.log('');
    console.log('═'.repeat(60));
    console.log(`Results: ${this.passed} passed, ${this.failed} failed`);
    console.log('═'.repeat(60));

    return this.failed === 0;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${expected}, got ${actual}`
    );
  }
}

// Test Suite
const runner = new TestRunner();

// ====================
// E24 Rounding Tests
// ====================

runner.test('E24: Same input produces same output', () => {
  const config = window.ScoringConfig;
  const e24 = new window.E24Rounding(config);

  const input = 12345n;

  const result1 = e24.standardizeAmount(input);
  const result2 = e24.standardizeAmount(input);
  const result3 = e24.standardizeAmount(input);

  assertEquals(result1, result2, 'First and second must match');
  assertEquals(result2, result3, 'Second and third must match');
});

runner.test('E24: Conservative rounding (floor)', () => {
  const config = window.ScoringConfig;
  const e24 = new window.E24Rounding(config);

  const input = 8750n;
  const result = e24.standardizeAmount(input);

  // Should round DOWN to nearest E24 value
  assert(result <= input, 'Must round down (conservative)');

  // Result should be E24-standardized
  const resultNum = Number(result);
  const magnitude = Math.floor(Math.log10(resultNum));
  const decade = Math.pow(10, magnitude);
  const normalized = resultNum / decade;

  const isE24 = config.e24.includes(normalized);
  assert(isE24, `Result ${normalized} must be E24 value`);
});

runner.test('E24: Zero handling', () => {
  const config = window.ScoringConfig;
  const e24 = new window.E24Rounding(config);

  const result = e24.standardizeAmount(0n);
  assertEquals(result, 0n, 'Zero must stay zero');
});

// ====================
// Prognosis Model Tests
// ====================

runner.test('Prognosis: Deterministic calculation', () => {
  const config = window.ScoringConfig;
  const model = new window.PrognosisModel(config);

  const historicalScores = [
    { score: 100, timestamp: '2025-01-01T00:00:00Z' },
    { score: 120, timestamp: '2025-01-02T00:00:00Z' },
    { score: 110, timestamp: '2025-01-03T00:00:00Z' }
  ];

  const day = 15;

  const result1 = model.calculatePrognosis(historicalScores, day);
  const result2 = model.calculatePrognosis(historicalScores, day);

  assertEquals(
    result1.predictedMonthlyScore,
    result2.predictedMonthlyScore,
    'Prognosis must be deterministic'
  );

  assertEquals(
    result1.predictedRatio,
    result2.predictedRatio,
    'Ratio must be deterministic'
  );
});

runner.test('Prognosis: Weighted average consistency', () => {
  const config = window.ScoringConfig;
  const model = new window.PrognosisModel(config);

  const weeklyScores = [100, 110, 120, 130]; // 4 weeks

  const avg1 = model.calculateWeightedAverage(weeklyScores);
  const avg2 = model.calculateWeightedAverage(weeklyScores);

  assertEquals(avg1, avg2, 'Weighted average must be deterministic');

  // Should favor recent weeks (weights: 0.5, 0.3, 0.15, 0.05)
  const expected =
    (130 * 0.5) + (120 * 0.3) + (110 * 0.15) + (100 * 0.05);

  assertEquals(avg1, expected, 'Weighted average must match expected value');
});

runner.test('Prognosis: Conservativity factor linear', () => {
  const config = window.ScoringConfig;
  const model = new window.PrognosisModel(config);

  const factor0 = model.calculateConservativityFactor(0);
  const factor30 = model.calculateConservativityFactor(30);
  const factor90 = model.calculateConservativityFactor(90);
  const factor120 = model.calculateConservativityFactor(120);

  assertEquals(factor0, 0.0, 'Day 0 must be 0%');
  assert(factor30 > 0 && factor30 < 0.98, 'Day 30 must be between 0-98%');
  assertEquals(factor90, 0.98, 'Day 90 must be 98%');
  assertEquals(factor120, 0.98, 'Day 120+ must be 98%');

  // Linear check
  const slope = config.conservativity.SLOPE;
  const expected30 = slope * 30;
  assertEquals(factor30, expected30, 'Must follow linear slope');
});

// ====================
// Scoring Engine Tests
// ====================

runner.test('Scoring: Same session produces same score', () => {
  const config = window.ScoringConfig;
  const engine = window.createScoringEngine(config);

  const sessionData = {
    sessionId: 'test-1',
    endTime: '2025-01-01T00:00:00Z',
    metrics: {
      activeTime: { valueSeconds: 300 },
      passiveTime: { valueSeconds: 100 }
    }
  };

  const pageData = {
    url: 'https://github.com/user/repo',
    dom: {},
    meta: {}
  };

  const result1 = engine.scoreSession(sessionData, pageData);
  const result2 = engine.scoreSession(sessionData, pageData);

  assertEquals(result1.score, result2.score, 'Score must be deterministic');
});

runner.test('Scoring: Content-type detection deterministic', () => {
  const config = window.ScoringConfig;
  const detector = new window.ContentDetector(config);

  const pageData = {
    url: 'https://github.com/user/repo',
    dom: {},
    meta: {}
  };

  const type1 = detector.detectContentType(pageData);
  const type2 = detector.detectContentType(pageData);
  const type3 = detector.detectContentType(pageData);

  assertEquals(type1, type2, 'Content-type must be deterministic (1-2)');
  assertEquals(type2, type3, 'Content-type must be deterministic (2-3)');
});

// ====================
// Distribution Tests
// ====================

runner.test('Distribution: Token calculation deterministic', () => {
  const config = window.ScoringConfig;
  const model = new window.PrognosisModel(config);

  const score = 1000;
  const totalDaysTracked = 45;
  const prognosis = {
    predictedRatio: 1000000n,
    predictedMonthlyScore: 50000
  };

  const tokens1 = model.calculateConservativeTokens(
    score,
    totalDaysTracked,
    prognosis
  );

  const tokens2 = model.calculateConservativeTokens(
    score,
    totalDaysTracked,
    prognosis
  );

  assertEquals(tokens1, tokens2, 'Token calculation must be deterministic');
});

// ====================
// NGO System Tests
// ====================

runner.test('NGO: Wallet target determination deterministic', () => {
  const config = window.ScoringConfig;
  const matcher = new window.CriteriaMatcher(config);

  const domain = 'example.com';
  const tokens = 10000n;
  const preferences = [
    { criterion: 'Ökostrom', priority: 1, weight: 0.7 },
    { criterion: 'Keine Werbung', priority: 2, weight: 0.3 }
  ];

  const domainData = {
    criteria: {
      'Ökostrom': false,
      'Keine Werbung': true
    }
  };

  const result1 = matcher.determineWalletTarget(
    domain,
    tokens,
    preferences,
    domainData
  );

  const result2 = matcher.determineWalletTarget(
    domain,
    tokens,
    preferences,
    domainData
  );

  // Should have same number of OR payments
  assertEquals(
    result1.orPayments.length,
    result2.orPayments.length,
    'OR payment count must match'
  );

  // First OR payment should match
  if (result1.orPayments.length > 0) {
    assertEquals(
      result1.orPayments[0].amount,
      result2.orPayments[0].amount,
      'OR payment amount must be deterministic'
    );
  }
});

// ====================
// Integration Test
// ====================

runner.test('Integration: Full flow deterministic', async () => {
  const config = window.ScoringConfig;

  // Mock browser.storage für Test
  const mockStorage = {
    data: {},
    get(keys) {
      const result = {};
      keys.forEach(key => {
        if (this.data[key]) {
          result[key] = this.data[key];
        }
      });
      return Promise.resolve(result);
    },
    set(data) {
      Object.assign(this.data, data);
      return Promise.resolve();
    }
  };

  // Override browser.storage.local
  const originalStorage = browser.storage.local;
  browser.storage.local = mockStorage;

  try {
    const revolution1 = new window.RevolutionScoring(config);
    await revolution1.initialize();

    const sessionData = {
      sessionId: 'test-integration',
      endTime: '2025-01-01T12:00:00Z',
      metrics: {
        activeTime: { valueSeconds: 180 },
        passiveTime: { valueSeconds: 60 }
      }
    };

    const pageData = {
      url: 'https://github.com/test/repo',
      dom: {},
      meta: {},
      trackers: [],
      ads: { count: 0 }
    };

    const result1 = await revolution1.processSession(sessionData, pageData);

    // Reset und zweiter Durchlauf
    const revolution2 = new window.RevolutionScoring(config);
    await revolution2.initialize();

    const result2 = await revolution2.processSession(sessionData, pageData);

    assertEquals(
      result1.scoring.score,
      result2.scoring.score,
      'Full integration must be deterministic'
    );

  } finally {
    // Restore
    browser.storage.local = originalStorage;
  }
});

// Run Tests
if (typeof window !== 'undefined') {
  window.runDeterminismTests = () => runner.run();

  console.log('Determinism tests loaded. Run with: runDeterminismTests()');
}

// Export für Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runner };
}
