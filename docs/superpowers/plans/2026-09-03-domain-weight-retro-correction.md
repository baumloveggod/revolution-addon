# Domain-Weight Retro-Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user changes a domain's weight on the analytics dashboard, retroactively recompute that domain's already-created ratings' scores (up or down) in the addon, mint a correction transaction only when the recompute implies underpayment (never a clawback), and tell the website about every score change via a new batched E2E message.

**Architecture:** Extract the existing inline domain-weight formula (`revolution-scoring.js`) into a small shared module reused by both live scoring and the new retro-correction path. Add a `processDomainWeightChange` method to the existing `RetroPayoutService` that reuses its existing token-math helpers (`calculateSollTokens`, `createCorrectionTransaction`). Wire it from the existing `PREFERENCES_UPDATE` handler. Two pre-existing bugs block this work and are fixed first (Tasks 1-2).

**Tech Stack:** Vanilla JS (ES modules in `revolution-wallet/src/`, classic scripts in the Firefox addon background page). No bundler. Tests via Node's built-in `node:test` + `node:assert/strict` (Node ≥18, matches `revolution-wallet`'s `engines` field) — no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-03-domain-weight-retro-correction-design.md`

## Global Constraints

- Two separate git repos are involved: `revolution-wallet` (canonical source of the ES-module classes) and `revolution-addon` (the Firefox extension, which vendors a **manual, unbundled copy** of `revolution-wallet/src/*.js` into `firefox-addon/vendor/revolution-client/*.js` — see `firefox-addon/build-source.sh:15-26`). Every task that touches a shared file edits it in `revolution-wallet/src/` first, then copies the exact same file verbatim into `revolution-addon/firefox-addon/vendor/revolution-client/` (`cp <wallet-file> <vendor-file>`). Commit each repo separately.
- A rating (`score`) is mutable and can be corrected up or down at any time. A transaction (minted tokens) is immutable once created — never reversed, never negative. Retro-correction always updates `score`; it only ever *adds* a correction transaction, never subtracts one.
- `RetroPayoutService`, `TranslationFactorTracker`, `DistributionEngine` are ES modules (`export class`), loaded into the addon via `vendor/revolution-client/wallet-globals.js` (`<script type="module">`, loaded first in `background.html`) which attaches them to `window.*`.
- `revolution-scoring.js`, `background.js`, `messaging-integration.js` are classic scripts (`<script defer>` in `background.html`, loaded after the module script) — they read the `window.*` globals set above and use the `browser` WebExtension API directly. They have no existing test harness in this codebase (no mocking of `window`/`browser` exists anywhere for them) — tasks that touch only these files are verified manually (documented per-task), consistent with existing project practice.
- Run wallet-repo tests with: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/<file>.test.js`

---

## File Structure

- `revolution-wallet/src/domain-weight.js` — **new**. Pure `applyDomainWeight` + `computeDomainScoreFloor`, shared by live scoring and retro-correction.
- `revolution-wallet/src/translation-factor-tracker.js` — **modify**. `addRating` gets a 5th `preDomainWeightScore` param.
- `revolution-wallet/src/distribution-engine.js` — **modify**. Passes `scoringResult.metadata.preDomainWeightScore` through to `addRating`.
- `revolution-wallet/src/retro-payout-service.js` — **modify**. Fix `rating.date` bug; `createCorrectionTransaction` gets optional `reason` param; new `processDomainWeightChange` method.
- `revolution-wallet/test/domain-weight.test.js`, `translation-factor-tracker.test.js`, `distribution-engine.test.js`, `retro-payout-service.test.js` — **new**.
- `revolution-addon/firefox-addon/vendor/revolution-client/{domain-weight.js, translation-factor-tracker.js, distribution-engine.js, retro-payout-service.js}` — **new/modify**, verbatim copies of the above.
- `revolution-addon/firefox-addon/vendor/revolution-client/wallet-globals.js` — **modify**. Import + expose `applyDomainWeight`/`computeDomainScoreFloor` on `window`.
- `revolution-addon/firefox-addon/scoring/revolution-scoring.js` — **modify**. Always compute/store `preDomainWeightScore`; delegate to the shared helpers; remove the now-dead `_computeDomainScoreFloor` method.
- `revolution-addon/firefox-addon/background.js` — **modify**. Fix `RetroPayoutService` constructor call; add `sendDomainCorrectionBatchToWebsite`; drain `pending_domain_weight_changes`.
- `revolution-addon/firefox-addon/messaging-integration.js` — **modify**. `handlePreferencesUpdate` calls `processDomainWeightChange` per changed domain and sends the result to the website.

---

### Task 1: Fix RetroPayoutService constructor call (missing `storage` arg)

**Files:**
- Modify: `revolution-addon/firefox-addon/background.js:1176-1180`

**Interfaces:**
- Consumes: `RetroPayoutService` constructor `(distributionEngine, translationFactorTracker, messagingClient, storage)` — `storage` already required by the class (`revolution-wallet/src/retro-payout-service.js:22-25`), just never passed at this call site.
- Produces: nothing new — this makes the *existing* `retroPayoutService` global (and everything gated on it: `rating_correction` handling, the 6h background job) actually initialize instead of silently throwing every time.

- [ ] **Step 1: Read the current call site to confirm exact text**

Run: `sed -n '1176,1180p' /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/background.js`
Expected output:
```js
      retroPayoutService = new RetroPayoutService(
        window.revolution.distributionEngine,
        window.revolution.distributionEngine.translationFactorTracker,
        messagingClient
      );
```

- [ ] **Step 2: Add the missing 4th argument**

Edit `revolution-addon/firefox-addon/background.js:1176-1180` to:
```js
      retroPayoutService = new RetroPayoutService(
        window.revolution.distributionEngine,
        window.revolution.distributionEngine.translationFactorTracker,
        messagingClient,
        browser.storage.local
      );
```

- [ ] **Step 3: Manual verification (no existing test harness for background.js)**

Load the addon unpacked in Firefox (`about:debugging` → "This Firefox" → "Load Temporary Add-on" → pick `revolution-addon/firefox-addon/manifest.json`), open its background page console, and confirm the line `[background.js] ❌ Failed to start RetroPayoutService:` no longer appears within the first ~10s after load. `window.retroPayoutService` (typed in the background console) should now be a `RetroPayoutService` instance, not `null`.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/background.js
git commit -m "$(cat <<'EOF'
Fix RetroPayoutService constructor call missing storage argument

The class has required a 4th storage argument since it was added, but this
call site only ever passed 3. The resulting constructor throw was silently
caught and logged, so retroPayoutService/window.retroPayoutService stayed
null forever — the manual rating-correction path and the 6h background job
never actually ran.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Fix `calculateSollTokens` reading `rating.timestamp` instead of `rating.date`

**Files:**
- Modify: `revolution-wallet/src/retro-payout-service.js:207`
- Test: `revolution-wallet/test/retro-payout-service.test.js` (new file — this task creates it with one test; Task 8 adds more to the same file)
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js`

**Interfaces:**
- Consumes: `TranslationFactorTracker` rating entries have shape `{ date, score, domain, ratingRef, preDomainWeightScore }` (see `translation-factor-tracker.js:44-49`; `preDomainWeightScore` field added in Task 4) — there is no `timestamp` field, only `date`.
- Produces: `calculateSollTokens(rating, currentFactor, prognosisSF, userData)` now correctly computes `daysSinceRating` from `rating.date`. No signature change — same callers (`checkRatingForRetroPayment`, `processCorrection`, and Task 8's `processDomainWeightChange`) keep working, but now actually produce a finite number instead of `NaN` (which previously made `BigInt(Math.floor(NaN))` throw `RangeError`, silently swallowed by every caller's try/catch — this path has never worked).

- [ ] **Step 1: Write the failing test**

Create `revolution-wallet/test/retro-payout-service.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetroPayoutService } from '../src/retro-payout-service.js';
import { TranslationFactorTracker } from '../src/translation-factor-tracker.js';
import { NodeMemoryStorage } from '../src/node-storage-adapter.js';

function makeService(overrides = {}) {
  const storage = overrides.storage || new NodeMemoryStorage();
  const tracker = overrides.tracker || new TranslationFactorTracker(storage);
  const distributionEngine = overrides.distributionEngine || {
    calibrationManager: { calculateSafetyFactor: () => 0 }
  };
  const service = new RetroPayoutService(distributionEngine, tracker, null, storage);
  return { service, storage, tracker, distributionEngine };
}

test('calculateSollTokens reads rating.date, not rating.timestamp', async () => {
  const { service, distributionEngine } = makeService({
    distributionEngine: {
      calibrationManager: {
        calculateSafetyFactor(daysSinceRating) {
          assert.ok(
            Number.isFinite(daysSinceRating),
            `daysSinceRating must be finite (rating.date must be used, not rating.timestamp), got ${daysSinceRating}`
          );
          return 0;
        }
      }
    }
  });

  const rating = { score: 1000, date: Date.now(), domain: 'example.com', ratingRef: 'r1' };
  const sollTokens = await service.calculateSollTokens(rating, 10n ** 13n, 1.0, {});

  assert.strictEqual(typeof sollTokens, 'bigint');
  assert.ok(sollTokens > 0n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: FAIL — the `calculateSafetyFactor` assertion throws `daysSinceRating must be finite ... got NaN`.

- [ ] **Step 3: Fix the bug**

Edit `revolution-wallet/src/retro-payout-service.js:207` from:
```js
    const daysSinceRating = Math.floor((Date.now() - rating.timestamp) / (24 * 60 * 60 * 1000));
```
to:
```js
    const daysSinceRating = Math.floor((Date.now() - rating.date) / (24 * 60 * 60 * 1000));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: PASS

- [ ] **Step 5: Copy the fixed file into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/retro-payout-service.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js
```

- [ ] **Step 6: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/retro-payout-service.js test/retro-payout-service.test.js
git commit -m "$(cat <<'EOF'
Fix calculateSollTokens reading rating.timestamp instead of rating.date

TranslationFactorTracker rating entries only ever have a `date` field, never
`timestamp`. daysSinceRating silently computed as NaN, which BigInt(Math.floor(NaN))
turns into a thrown RangeError — swallowed by every caller's try/catch, so
retro-payout correction has never actually produced a payout.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/retro-payout-service.js
git commit -m "$(cat <<'EOF'
Sync retro-payout-service.js: fix rating.date/timestamp bug

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Shared `applyDomainWeight` / `computeDomainScoreFloor` module

**Files:**
- Create: `revolution-wallet/src/domain-weight.js`
- Test: `revolution-wallet/test/domain-weight.test.js`
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/domain-weight.js`
- Modify: `revolution-addon/firefox-addon/vendor/revolution-client/wallet-globals.js`

**Interfaces:**
- Produces:
  - `applyDomainWeight(preDomainWeightScore: number, domainWeight: number, floorScore: number): { finalScore: number, backCalculated: boolean, cappedAt100Percent: boolean }`
  - `computeDomainScoreFloor(tracker: TranslationFactorTracker, storage: {get(keys): Promise<object>}, domain: string, preDomainWeightScore: number): Promise<number>`
- Consumed by: Task 6 (`revolution-scoring.js`, via `window.applyDomainWeight`/`window.computeDomainScoreFloor`) and Task 8 (`RetroPayoutService.processDomainWeightChange`, via direct ES import).

- [ ] **Step 1: Write the failing tests**

Create `revolution-wallet/test/domain-weight.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDomainWeight, computeDomainScoreFloor } from '../src/domain-weight.js';
import { TranslationFactorTracker } from '../src/translation-factor-tracker.js';
import { NodeMemoryStorage } from '../src/node-storage-adapter.js';

test('applyDomainWeight: weight 1.0, no floor -> unchanged score', () => {
  const result = applyDomainWeight(1000, 1.0, 0);
  assert.strictEqual(result.finalScore, 1000);
  assert.strictEqual(result.backCalculated, false);
  assert.strictEqual(result.cappedAt100Percent, false);
});

test('applyDomainWeight: weight below 1.0 reduces score, no floor', () => {
  const result = applyDomainWeight(1000, 0.5, 0);
  assert.strictEqual(result.finalScore, 500);
  assert.strictEqual(result.backCalculated, false);
});

test('applyDomainWeight: weight above 1.0 is capped at preDomainWeightScore (natural share)', () => {
  const result = applyDomainWeight(1000, 2.0, 0);
  assert.strictEqual(result.finalScore, 1000);
  assert.strictEqual(result.cappedAt100Percent, false);
});

test('applyDomainWeight: floor raises a low naive score, still capped at preDomainWeightScore', () => {
  const result = applyDomainWeight(1000, 0.2, 700);
  assert.strictEqual(result.finalScore, 700);
  assert.strictEqual(result.backCalculated, true);
  assert.strictEqual(result.cappedAt100Percent, false);
});

test('applyDomainWeight: floor above preDomainWeightScore is capped, cappedAt100Percent true', () => {
  const result = applyDomainWeight(1000, 0.2, 1500);
  assert.strictEqual(result.finalScore, 1000);
  assert.strictEqual(result.backCalculated, true);
  assert.strictEqual(result.cappedAt100Percent, true);
});

test('computeDomainScoreFloor: no tracker -> 0', async () => {
  const floor = await computeDomainScoreFloor(null, new NodeMemoryStorage(), 'example.com', 1000);
  assert.strictEqual(floor, 0);
});

test('computeDomainScoreFloor: no rev_paid_amounts -> 0', async () => {
  const storage = new NodeMemoryStorage();
  const tracker = new TranslationFactorTracker(storage);
  const floor = await computeDomainScoreFloor(tracker, storage, 'example.com', 1000);
  assert.strictEqual(floor, 0);
});

test('computeDomainScoreFloor: already-paid amount raises the floor above zero', async () => {
  const storage = new NodeMemoryStorage();
  const tracker = new TranslationFactorTracker(storage);
  await tracker.addRating(300, 'example.com', 'r1', Date.now());
  await tracker.addRating(700, 'other.com', 'r2', Date.now());
  await storage.set({ rev_paid_amounts: { 'example.com': 4000000000000000 } }); // 4e15, half of BUDGET_TOKENS (1e16)

  const floor = await computeDomainScoreFloor(tracker, storage, 'example.com', 300);
  // requiredTotalDomainScore = (alreadyPaid * othersScore) / (BUDGET - alreadyPaid)
  //                          = (4e15 * 700) / (1e16 - 4e15) = 2.8e18 / 6e15 = 466.67
  // requiredThisEventScore = 466.67 - 300(domainWindowScore, includes r1 itself) = 166.67
  assert.ok(floor > 0, `expected floor > 0, got ${floor}`);
  assert.ok(Math.abs(floor - 166.666) < 1, `expected floor ~166.67, got ${floor}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/domain-weight.test.js`
Expected: FAIL with "Cannot find module '../src/domain-weight.js'"

- [ ] **Step 3: Write the implementation**

Create `revolution-wallet/src/domain-weight.js`:
```js
/**
 * Domain-weight application and its back-calculated floor.
 *
 * Shared by live scoring (revolution-scoring.js, via window.* globals in the
 * addon) and retro-correction (RetroPayoutService.processDomainWeightChange)
 * so the two paths can never drift apart. See
 * docs/superpowers/specs/2026-09-03-domain-weight-retro-correction-design.md.
 */

/**
 * Applies a user-chosen domain weight to a pre-weight score, respecting the
 * back-calculated floor (the minimum contribution needed so the domain's
 * projected tokens don't fall below what's already been paid for it).
 *
 * The floor may only make up for underpayment — it must never boost the
 * result ABOVE preDomainWeightScore (the "natural", unweighted 100% share).
 *
 * @param {number} preDomainWeightScore - score after content-type multiplier, before domain weight
 * @param {number} domainWeight - user-chosen weight (0-2.0, default 1.0)
 * @param {number} floorScore - back-calculated floor (0 if no adjustment needed)
 * @returns {{ finalScore: number, backCalculated: boolean, cappedAt100Percent: boolean }}
 */
export function applyDomainWeight(preDomainWeightScore, domainWeight, floorScore) {
  const naiveWeightedScore = preDomainWeightScore * domainWeight;
  const raised = Math.max(naiveWeightedScore, floorScore);
  const finalScore = Math.min(preDomainWeightScore, raised);
  return {
    finalScore,
    backCalculated: finalScore > naiveWeightedScore + 0.0001,
    cappedAt100Percent: raised > preDomainWeightScore + 0.0001
  };
}

/**
 * Back-calculates the minimum score a domain needs (in the 30-day sliding
 * window) so its projected tokens don't fall below what's already been paid
 * out for it.
 *
 * @param {Object|null} tracker - TranslationFactorTracker instance (getRatingsLast30Days, BUDGET_TOKENS)
 * @param {{get(keys): Promise<object>}} storage - storage adapter (rev_paid_amounts)
 * @param {string} domain
 * @param {number} preDomainWeightScore - score for the event being evaluated, before domain weight
 * @returns {Promise<number>} floor score (0 if no adjustment is needed)
 */
export async function computeDomainScoreFloor(tracker, storage, domain, preDomainWeightScore) {
  if (!tracker) return 0;

  const paidStored = await storage.get(['rev_paid_amounts']);
  const alreadyPaid = Number((paidStored.rev_paid_amounts || {})[domain] || 0n);
  if (alreadyPaid <= 0) return 0;

  const ratings = await tracker.getRatingsLast30Days();
  let domainWindowScore = 0;
  let totalWindowScore = 0;
  for (const r of ratings) {
    totalWindowScore += r.score || 0;
    if (r.domain === domain) domainWindowScore += r.score || 0;
  }
  const othersScore = totalWindowScore - domainWindowScore;

  const budgetTokens = Number(tracker.BUDGET_TOKENS);
  const denominator = budgetTokens - alreadyPaid;
  if (denominator <= 0) {
    // Already-paid amount alone consumes the entire sliding-window budget -
    // no finite floor exists. Fall back to not reducing this event's contribution.
    return preDomainWeightScore;
  }

  const requiredTotalDomainScore = (alreadyPaid * othersScore) / denominator;
  const requiredThisEventScore = requiredTotalDomainScore - domainWindowScore;
  return Math.max(0, requiredThisEventScore);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/domain-weight.test.js`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Copy into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/domain-weight.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/domain-weight.js
```

- [ ] **Step 6: Wire into wallet-globals.js**

Edit `revolution-addon/firefox-addon/vendor/revolution-client/wallet-globals.js`. Add the import next to the other Distribution imports:
```js
// --- Distribution ---
import { TranslationFactorTracker } from './translation-factor-tracker.js';
import { DistributionEngine } from './distribution-engine.js';
import { CalibrationManager } from './calibration-manager.js';
import { PrognosisModel } from './prognosis-model.js';
import { applyDomainWeight, computeDomainScoreFloor } from './domain-weight.js';
```
And the `window.*` assignment next to the other Distribution assignments:
```js
// Distribution
window.TranslationFactorTracker = TranslationFactorTracker;
window.DistributionEngine = DistributionEngine;
window.CalibrationManager = CalibrationManager;
window.PrognosisModel = PrognosisModel;
window.applyDomainWeight = applyDomainWeight;
window.computeDomainScoreFloor = computeDomainScoreFloor;
```

- [ ] **Step 7: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/domain-weight.js test/domain-weight.test.js
git commit -m "$(cat <<'EOF'
Add shared applyDomainWeight/computeDomainScoreFloor module

Extracted from the inline logic in the addon's revolution-scoring.js so
live scoring and the upcoming retro-correction path share one formula
instead of two copies that can drift apart.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/domain-weight.js firefox-addon/vendor/revolution-client/wallet-globals.js
git commit -m "$(cat <<'EOF'
Add domain-weight.js to vendor sync and expose on window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `TranslationFactorTracker.addRating` gets `preDomainWeightScore`

**Files:**
- Modify: `revolution-wallet/src/translation-factor-tracker.js:39-61`
- Test: `revolution-wallet/test/translation-factor-tracker.test.js` (new)
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/translation-factor-tracker.js`

**Interfaces:**
- Produces: `addRating(score, domain, ratingRef, timestamp = Date.now(), preDomainWeightScore = null)`. History entries now carry `{ date, score, domain, ratingRef, preDomainWeightScore }`.
- Consumed by: Task 5 (`distribution-engine.js` passes the 5th arg through) and Task 8 (`RetroPayoutService.processDomainWeightChange` reads `rating.preDomainWeightScore`, skipping entries where it's `null`).

- [ ] **Step 1: Write the failing test**

Create `revolution-wallet/test/translation-factor-tracker.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationFactorTracker } from '../src/translation-factor-tracker.js';
import { NodeMemoryStorage } from '../src/node-storage-adapter.js';

test('addRating stores preDomainWeightScore when provided', async () => {
  const tracker = new TranslationFactorTracker(new NodeMemoryStorage());
  await tracker.addRating(500, 'example.com', 'r1', Date.now(), 1000);

  const ratings = await tracker.getRatingsLast30Days();
  assert.strictEqual(ratings.length, 1);
  assert.strictEqual(ratings[0].score, 500);
  assert.strictEqual(ratings[0].preDomainWeightScore, 1000);
});

test('addRating defaults preDomainWeightScore to null when omitted (back-compat)', async () => {
  const tracker = new TranslationFactorTracker(new NodeMemoryStorage());
  await tracker.addRating(500, 'example.com', 'r1', Date.now());

  const ratings = await tracker.getRatingsLast30Days();
  assert.strictEqual(ratings[0].preDomainWeightScore, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/translation-factor-tracker.test.js`
Expected: FAIL — `ratings[0].preDomainWeightScore` is `undefined`, not `1000`.

- [ ] **Step 3: Implement**

Edit `revolution-wallet/src/translation-factor-tracker.js:39-49` from:
```js
  async addRating(score, domain, ratingRef, timestamp = Date.now()) {
    const data = await this.storage.get(['rev_rating_history_30d']);
    let history = data.rev_rating_history_30d || [];

    // Neues Rating hinzufügen
    history.push({
      date: timestamp,
      score: score,
      domain: domain,
      ratingRef: ratingRef
    });
```
to:
```js
  async addRating(score, domain, ratingRef, timestamp = Date.now(), preDomainWeightScore = null) {
    const data = await this.storage.get(['rev_rating_history_30d']);
    let history = data.rev_rating_history_30d || [];

    // Neues Rating hinzufügen
    history.push({
      date: timestamp,
      score: score,
      domain: domain,
      ratingRef: ratingRef,
      preDomainWeightScore: preDomainWeightScore
    });
```
Also update the storage-keys doc comment at the top of the file (`translation-factor-tracker.js:11`):
```js
 * - rev_rating_history_30d: [{date, score, domain, ratingRef, preDomainWeightScore}, ...]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/translation-factor-tracker.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Copy into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/translation-factor-tracker.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/translation-factor-tracker.js
```

- [ ] **Step 6: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/translation-factor-tracker.js test/translation-factor-tracker.test.js
git commit -m "$(cat <<'EOF'
Store preDomainWeightScore on rating history entries

Needed so a future domain-weight change can recompute a rating's score
correctly. The final (post-weight) score alone isn't enough to back out the
pre-weight base once floor-correction has been applied to it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/translation-factor-tracker.js
git commit -m "$(cat <<'EOF'
Sync translation-factor-tracker.js: preDomainWeightScore field

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `distribution-engine.js` passes `preDomainWeightScore` through

**Files:**
- Modify: `revolution-wallet/src/distribution-engine.js:119-125`
- Test: `revolution-wallet/test/distribution-engine.test.js` (new)
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/distribution-engine.js`

**Interfaces:**
- Consumes: `TranslationFactorTracker.addRating(score, domain, ratingRef, timestamp, preDomainWeightScore)` (Task 4).
- Produces: `processSessionWithSafetyFactor` reads `scoringResult.metadata.preDomainWeightScore` (set by Task 6) and passes it through. No change to the method's own signature or return value.

- [ ] **Step 1: Write the failing test**

Create `revolution-wallet/test/distribution-engine.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DistributionEngine } from '../src/distribution-engine.js';
import { NodeMemoryStorage } from '../src/node-storage-adapter.js';

test('processSessionWithSafetyFactor passes preDomainWeightScore through to addRating', async () => {
  const addRatingCalls = [];
  const fakeTracker = {
    async addRating(...args) {
      addRatingCalls.push(args);
    },
    async calculateCurrentFactor() {
      throw new Error('ABORT_TEST'); // stop the pipeline right after addRating
    }
  };
  const fakePrognosisModel = {
    calculatePrognosis() { return {}; }
  };

  const engine = new DistributionEngine(
    {},                  // config
    fakePrognosisModel,
    {},                  // calibrationManager (unused before the abort)
    {},                  // privacyLayer (unused before the abort)
    null,                // entityResolver
    fakeTracker,
    null,                // fluctuationSF
    new NodeMemoryStorage()
  );

  const scoringResult = {
    score: 42,
    metadata: { domain: 'example.com', ratingRef: 'r1', preDomainWeightScore: 50 }
  };
  const userData = {
    historicalScores: [], totalDaysTracked: 10, currentDayOfMonth: 5, firstTrackingDate: new Date()
  };

  await assert.rejects(
    () => engine.processSessionWithSafetyFactor(scoringResult, userData, 0.5, 0.5, 10),
    /ABORT_TEST/
  );

  assert.strictEqual(addRatingCalls.length, 1);
  const [score, domain, ratingRef, timestamp, preDomainWeightScore] = addRatingCalls[0];
  assert.strictEqual(score, 42);
  assert.strictEqual(domain, 'example.com');
  assert.strictEqual(ratingRef, 'r1');
  assert.strictEqual(typeof timestamp, 'number');
  assert.strictEqual(preDomainWeightScore, 50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/distribution-engine.test.js`
Expected: FAIL — `addRatingCalls[0]` has only 4 elements, `preDomainWeightScore` is `undefined`, not `50`.

- [ ] **Step 3: Implement**

Edit `revolution-wallet/src/distribution-engine.js:119-125` from:
```js
    if (this.translationFactorTracker) {
      await this.translationFactorTracker.addRating(
        scoringResult.score,
        domain,
        ratingRef,
        Date.now()
      );
    } else {
```
to:
```js
    if (this.translationFactorTracker) {
      await this.translationFactorTracker.addRating(
        scoringResult.score,
        domain,
        ratingRef,
        Date.now(),
        scoringResult.metadata?.preDomainWeightScore ?? null
      );
    } else {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/distribution-engine.test.js`
Expected: PASS

- [ ] **Step 5: Copy into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/distribution-engine.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/distribution-engine.js
```

- [ ] **Step 6: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/distribution-engine.js test/distribution-engine.test.js
git commit -m "$(cat <<'EOF'
Pass preDomainWeightScore through to TranslationFactorTracker.addRating

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/distribution-engine.js
git commit -m "$(cat <<'EOF'
Sync distribution-engine.js: preDomainWeightScore pass-through

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `revolution-scoring.js` — always store `preDomainWeightScore`, delegate to shared helpers

**Files:**
- Modify: `revolution-addon/firefox-addon/scoring/revolution-scoring.js:211-298` (section "1c"), and delete the now-dead `_computeDomainScoreFloor` method at lines 1184-1211.

**Interfaces:**
- Consumes: `window.applyDomainWeight`, `window.computeDomainScoreFloor` (Task 3, available on `window` by the time this classic script runs — `wallet-globals.js` is a `type="module"` script loaded before it in `background.html`).
- Produces: `scoringResult.metadata.preDomainWeightScore` is now **always** set when `domain && scoringResult.score > 0` (previously only set inside `if (userPrefs)`, so it was missing whenever the user had no `rev_user_preferences` yet). Feeds Task 5's `addRating` call.

This task has no existing test harness available (see Global Constraints) — verified manually in Step 3.

- [ ] **Step 1: Confirm current content before editing**

Run: `sed -n '211,298p' /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/scoring/revolution-scoring.js`
Expected: matches the block quoted in the design doc's "Data model change" section (starts `// 1c. Apply user rating preferences...`, ends with the closing `}` of the `try`/`catch` at line 298).

- [ ] **Step 2: Replace the block**

Edit `revolution-addon/firefox-addon/scoring/revolution-scoring.js`, replacing lines 211-298 with:
```js
    // 1c. Apply user rating preferences from website settings sync
    if (domain && scoringResult.score > 0) {
      try {
        const prefStored = await browser.storage.local.get('rev_user_preferences');
        const userPrefs = prefStored.rev_user_preferences;
        const breakdown = scoringResult.breakdown || {};

        let prefMultiplier = 1.0;
        if (userPrefs && userPrefs.contentTypeMultipliers && breakdown.contentType) {
          const ctType = breakdown.contentType.type || '';
          const category = this._contentTypeToCategory(ctType);
          const ctMult = userPrefs.contentTypeMultipliers[category];
          if (ctMult != null && ctMult !== 1.0) {
            prefMultiplier *= ctMult;
          }
        }

        // Content-type-adjusted score, before the domain-target weight is applied.
        // This is the baseline the domain weight (and its back-calculated floor,
        // see below) multiplies against. Always computed and stored on metadata
        // (even with no userPrefs / no domainWeights) so
        // RetroPayoutService.processDomainWeightChange can recompute this
        // rating's score later if the domain weight changes (see
        // docs/superpowers/specs/2026-09-03-domain-weight-retro-correction-design.md).
        const preDomainWeightScore = scoringResult.score * prefMultiplier;
        scoringResult.metadata.preDomainWeightScore = preDomainWeightScore;

        // Domain weight from user preferences (dashboard slider, 0-2.0, default 1.0).
        // The user is explicitly allowed to set a target below what has already
        // been paid out for this domain - that's not capped/overridden here (see
        // Umsetzungsplan Domain-Ziel-Faktor). Instead, the score actually used for
        // the scoring sum (30-day sliding window) and shown in breakdown is the
        // higher of (a) the naive target-weighted score and (b) a back-calculated
        // score: the minimum contribution this rating needs to make so the domain's
        // projected tokens don't fall below what's already been paid.
        //
        // NOTE: a separate 'correction' transaction (via a second
        // processSessionWithSafetyFactor call) was tried and reverted - it would
        // mint/spend real tokens through TransactionQueue.executeTransaction but
        // never get its own sendRatingMessageToWebsite/RATING_FULL call (that only
        // fires once per processSession(), for the top-level result), so it would
        // move real money with no corresponding entry in the Verlauf. Folding the
        // back-calculation into this rating's own score keeps it inside the single
        // RATING_FULL message that already gets sent - correct and visible
        // (breakdown.userPreferences.backCalculated, see analytics-rating-transactions.js).
        //
        // A later, separate domain-weight CHANGE is handled retroactively by
        // RetroPayoutService.processDomainWeightChange using the same
        // applyDomainWeight/computeDomainScoreFloor helpers - see the retro-
        // correction design doc referenced above.
        let domainWeight = null;
        let finalScore = preDomainWeightScore;
        let backCalculated = false;
        let cappedAt100Percent = false;
        if (userPrefs && userPrefs.domainWeights && userPrefs.domainWeights[domain] != null) {
          domainWeight = userPrefs.domainWeights[domain];
          const floorScore = await window.computeDomainScoreFloor(
            this.translationFactorTracker,
            browser.storage.local,
            domain,
            preDomainWeightScore
          );
          ({ finalScore, backCalculated, cappedAt100Percent } =
            window.applyDomainWeight(preDomainWeightScore, domainWeight, floorScore));
        }

        if (finalScore !== scoringResult.score) {
          const adjusted = Math.max(0, Math.min(
            this.scoringEngine.config.scores.MAX_SCORE,
            Math.floor(finalScore)
          ));
          scoringResult.breakdown = scoringResult.breakdown || {};
          scoringResult.breakdown.userPreferences = {
            applied: true,
            contentTypeMultiplier: prefMultiplier,
            domainWeight: domainWeight,
            backCalculated: backCalculated,
            cappedAt100Percent: cappedAt100Percent,
            originalScore: scoringResult.score,
            adjustedScore: adjusted
          };
          scoringResult.score = adjusted;
        }
      } catch (_) {
        // Non-critical: proceed without user preference adjustment
      }
    }
```

- [ ] **Step 3: Delete the now-dead `_computeDomainScoreFloor` method**

Run: `grep -n "_computeDomainScoreFloor" /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/scoring/revolution-scoring.js`
Expected: only the JSDoc + method definition remain (no more call sites, since Step 2 replaced the only caller with `window.computeDomainScoreFloor`).

Delete the whole method (JSDoc comment block + method body, originally lines 1171-1211 — re-locate by the `_computeDomainScoreFloor` grep match after Step 2's edit, since line numbers shift):
```js
  /**
   * Back-calculates the minimum score this rating needs to contribute so the
   * domain's projected tokens (30-day sliding window, see TranslationFactorTracker)
   * don't fall below what has already been paid out for that domain.
   *
   * Lets the user set a target weight below the already-paid amount (they may
   * genuinely want to reduce a domain's share going forward) without silently
   * shortchanging money that's already been sent - see Umsetzungsplan Domain-Ziel-Faktor.
   *
   * @param {string} domain
   * @param {number} preDomainWeightScore - score for this event before the domain weight is applied
   * @returns {Promise<number>} floor score (0 if no adjustment is needed)
   */
  async _computeDomainScoreFloor(domain, preDomainWeightScore) {
    if (!this.translationFactorTracker) return 0;

    const paidStored = await browser.storage.local.get('rev_paid_amounts');
    const alreadyPaid = Number((paidStored.rev_paid_amounts || {})[domain] || 0n);
    if (alreadyPaid <= 0) return 0;

    const ratings = await this.translationFactorTracker.getRatingsLast30Days();
    let domainWindowScore = 0;
    let totalWindowScore = 0;
    for (const r of ratings) {
      totalWindowScore += r.score || 0;
      if (r.domain === domain) domainWindowScore += r.score || 0;
    }
    const othersScore = totalWindowScore - domainWindowScore;

    const budgetTokens = Number(this.translationFactorTracker.BUDGET_TOKENS);
    const denominator = budgetTokens - alreadyPaid;
    if (denominator <= 0) {
      // Already-paid amount alone consumes the entire sliding-window budget -
      // no finite floor exists. Fall back to not reducing this event's contribution.
      return preDomainWeightScore;
    }

    const requiredTotalDomainScore = (alreadyPaid * othersScore) / denominator;
    const requiredThisEventScore = requiredTotalDomainScore - domainWindowScore;
    return Math.max(0, requiredThisEventScore);
  }

```
Delete this whole block (leave the surrounding methods — `saveHistoricalScore` before it and `loadState` after it — untouched).

- [ ] **Step 4: Manual verification**

Load the addon unpacked (see Task 1 Step 3). Trigger a scoring event on `https://api.lenkenhoff.de` with `rev_user_preferences` unset (fresh profile) — confirm no console errors, and in the background console run:
```js
browser.storage.local.get('rev_rating_history_30d').then(d => console.log(d.rev_rating_history_30d.at(-1)))
```
Confirm the newest entry has a non-null `preDomainWeightScore` field. Then set a `domainWeights` value for that domain via the dashboard slider + Speichern, trigger another scoring event, and confirm `breakdown.userPreferences.domainWeight` on the resulting `RATING_FULL` message (visible in the background console network/message log) matches, with no thrown errors.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/scoring/revolution-scoring.js
git commit -m "$(cat <<'EOF'
Always store preDomainWeightScore; delegate domain-weight math to shared module

preDomainWeightScore was previously only set on scoringResult.metadata when
rev_user_preferences already existed, so ratings created before a user's
first preferences sync had no way to be retroactively recomputed later.
Also removes the now-duplicated _computeDomainScoreFloor in favor of the
shared computeDomainScoreFloor/applyDomainWeight helpers used by
RetroPayoutService.processDomainWeightChange.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `createCorrectionTransaction` gets an optional `reason` param

**Files:**
- Modify: `revolution-wallet/src/retro-payout-service.js` (method `createCorrectionTransaction`, and its two existing call sites)
- Test: `revolution-wallet/test/retro-payout-service.test.js` (append)
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js`

**Interfaces:**
- Produces: `createCorrectionTransaction(rating, existingTxs, sollTokens, istTokensSum, differenz, currentFactor, prognosisSF, reason = 'retro_payout_3x_rule')`. Existing callers (`checkRatingForRetroPayment`, `processCorrection`) omit the new param and keep their current `'retro_payout_3x_rule'` reason. Task 8's `processDomainWeightChange` passes `'domain_weight_change'`.

- [ ] **Step 1: Write the failing test**

Append to `revolution-wallet/test/retro-payout-service.test.js`:
```js
test('createCorrectionTransaction records a custom reason when provided', async () => {
  const storage = new NodeMemoryStorage();
  const tracker = new TranslationFactorTracker(storage);
  const distributionEngine = {
    privacyLayer: {
      e24Rounding: { standardizeAmount: (amount) => amount },
      queueTransaction: async () => {}
    },
    _resolveWalletWithMeta: async () => ({ address: 'fake-addr', isNewWallet: false })
  };
  const service = new RetroPayoutService(distributionEngine, tracker, null, storage);

  const rating = { ratingRef: 'r1', domain: 'example.com', score: 1000 };
  const tx = await service.createCorrectionTransaction(
    rating, [], 5000n, 1000n, 4000n, 10n ** 13n, 1.0, 'domain_weight_change'
  );

  assert.strictEqual(tx.reason, 'domain_weight_change');

  const stored = await service.getStoredTransactions();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].reason, 'domain_weight_change');
});

test('createCorrectionTransaction defaults reason to retro_payout_3x_rule', async () => {
  const storage = new NodeMemoryStorage();
  const tracker = new TranslationFactorTracker(storage);
  const distributionEngine = {
    privacyLayer: {
      e24Rounding: { standardizeAmount: (amount) => amount },
      queueTransaction: async () => {}
    },
    _resolveWalletWithMeta: async () => ({ address: 'fake-addr', isNewWallet: false })
  };
  const service = new RetroPayoutService(distributionEngine, tracker, null, storage);

  const rating = { ratingRef: 'r2', domain: 'example.com', score: 1000 };
  const tx = await service.createCorrectionTransaction(
    rating, [], 5000n, 1000n, 4000n, 10n ** 13n, 1.0
  );

  assert.strictEqual(tx.reason, 'retro_payout_3x_rule');
});
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: the `'domain_weight_change'` test FAILS (`tx.reason` is `'retro_payout_3x_rule'`, not `'domain_weight_change'` — the param is ignored); the default-reason test PASSES already.

- [ ] **Step 3: Implement**

In `revolution-wallet/src/retro-payout-service.js`, change the method signature and both `reason:` occurrences inside it:
```js
  async createCorrectionTransaction(rating, existingTxs, sollTokens, istTokensSum, differenz, currentFactor, prognosisSF, reason = 'retro_payout_3x_rule') {
```
Replace both hardcoded `reason: 'retro_payout_3x_rule'` occurrences inside the method body (one in the `correctionTx` object, one in the `queueTransaction(...)` metadata) with `reason: reason,` / `reason: reason` respectively. Leave the two existing call sites (`checkRatingForRetroPayment` and `processCorrection`) unchanged — they'll keep using the new default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Copy into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/retro-payout-service.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js
```

- [ ] **Step 6: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/retro-payout-service.js test/retro-payout-service.test.js
git commit -m "$(cat <<'EOF'
Add optional reason param to createCorrectionTransaction

Existing callers keep the 'retro_payout_3x_rule' default. The upcoming
processDomainWeightChange passes 'domain_weight_change' so correction
transactions are labeled by what actually triggered them.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/retro-payout-service.js
git commit -m "$(cat <<'EOF'
Sync retro-payout-service.js: createCorrectionTransaction reason param

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `RetroPayoutService.processDomainWeightChange`

**Files:**
- Modify: `revolution-wallet/src/retro-payout-service.js` (new method)
- Test: `revolution-wallet/test/retro-payout-service.test.js` (append)
- Copy: `revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js`

**Interfaces:**
- Consumes: `applyDomainWeight`, `computeDomainScoreFloor` (Task 3, ES import), `this.tracker.getRatingsLast30Days()` / `.updateRating()` (existing), `this.calculateSollTokens()` / `this.createCorrectionTransaction()` / `this.getStoredTransactions()` (existing, latter two from Tasks 2 and 7).
- Produces: `processDomainWeightChange(domain: string, newWeight: number): Promise<{ domain: string, newWeight: number, corrections: Array<{ ratingRef: string, oldScore: number, newScore: number, correctionTx: object|null }> }>`. Consumed by Task 10 (`messaging-integration.js`) and Task 9 (the object shape it sends to the website).

- [ ] **Step 1: Write the failing tests**

Append to `revolution-wallet/test/retro-payout-service.test.js`:
```js
function makeFullService() {
  const storage = new NodeMemoryStorage();
  const tracker = new TranslationFactorTracker(storage);
  const queuedTransactions = [];
  const distributionEngine = {
    calibrationManager: { calculateSafetyFactor: () => 0 },
    prognosisModel: { calculatePrognosisSF: () => 1.0 },
    getUserData: async () => ({}),
    privacyLayer: {
      e24Rounding: { standardizeAmount: (amount) => amount },
      queueTransaction: async (tx) => { queuedTransactions.push(tx); }
    },
    _resolveWalletWithMeta: async () => ({ address: 'fake-addr', isNewWallet: false })
  };
  const service = new RetroPayoutService(distributionEngine, tracker, null, storage);
  return { service, storage, tracker, queuedTransactions };
}

async function seedOldBaToCLTimestamp(tracker) {
  // 100 days ago, in seconds -> timeMultiplier caps at 1.0 (undamped factor)
  await tracker.recordFirstBaToCLTransfer(Math.floor(Date.now() / 1000) - 100 * 24 * 60 * 60);
}

test('processDomainWeightChange: increase raises score and mints a correction', async () => {
  const { service, storage, tracker, queuedTransactions } = makeFullService();
  await seedOldBaToCLTimestamp(tracker);

  // Rating was originally created under domainWeight 0.5 (score 500, preDomainWeightScore 1000).
  await tracker.addRating(500, 'example.com', 'r1', Date.now(), 1000);
  // Original mint for this rating was small, so any recomputed sollTokens easily clears MIN_PAYOUT_TOKENS.
  await storage.set({ rev_stored_transactions: [
    { ratingRef: 'r1', domain: 'example.com', istTokens: '100', type: 'rating' }
  ] });

  const result = await service.processDomainWeightChange('example.com', 1.5);

  assert.strictEqual(result.corrections.length, 1);
  const correction = result.corrections[0];
  assert.strictEqual(correction.ratingRef, 'r1');
  assert.strictEqual(correction.oldScore, 500);
  // naiveWeightedScore = 1000 * 1.5 = 1500, capped at preDomainWeightScore = 1000
  assert.strictEqual(correction.newScore, 1000);
  assert.ok(correction.correctionTx, 'expected a correction transaction to be minted');
  assert.strictEqual(correction.correctionTx.reason, 'domain_weight_change');
  assert.strictEqual(queuedTransactions.length, 1);

  const ratings = await tracker.getRatingsLast30Days();
  assert.strictEqual(ratings[0].score, 1000);
});

test('processDomainWeightChange: decrease lowers score, never mints, never claws back', async () => {
  const { service, storage, tracker, queuedTransactions } = makeFullService();
  await seedOldBaToCLTimestamp(tracker);

  // Rating created under domainWeight 1.0 (score == preDomainWeightScore == 1000).
  await tracker.addRating(1000, 'example.com', 'r1', Date.now(), 1000);
  // Pre-populate an already-large payout so any recomputed (lower) sollTokens is guaranteed
  // below it regardless of floating-point noise in the surrounding token math.
  await storage.set({ rev_stored_transactions: [
    { ratingRef: 'r1', domain: 'example.com', istTokens: '99999999999999999999', type: 'rating' }
  ] });

  const result = await service.processDomainWeightChange('example.com', 0.5);

  assert.strictEqual(result.corrections.length, 1);
  const correction = result.corrections[0];
  assert.strictEqual(correction.oldScore, 1000);
  assert.strictEqual(correction.newScore, 500); // 1000 * 0.5, no floor
  assert.strictEqual(correction.correctionTx, null);
  assert.strictEqual(queuedTransactions.length, 0);

  const ratings = await tracker.getRatingsLast30Days();
  assert.strictEqual(ratings[0].score, 500);

  const stored = await service.getStoredTransactions();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].istTokens, '99999999999999999999'); // untouched
});

test('processDomainWeightChange: ratings without preDomainWeightScore are skipped', async () => {
  const { service, tracker } = makeFullService();
  await seedOldBaToCLTimestamp(tracker);

  // Pre-migration entry: no preDomainWeightScore.
  await tracker.addRating(500, 'example.com', 'r-old', Date.now());

  const result = await service.processDomainWeightChange('example.com', 1.5);

  assert.strictEqual(result.corrections.length, 0);
  const ratings = await tracker.getRatingsLast30Days();
  assert.strictEqual(ratings[0].score, 500); // unchanged
});

test('processDomainWeightChange: no ratings for domain -> empty corrections', async () => {
  const { service } = makeFullService();
  const result = await service.processDomainWeightChange('nowhere.com', 1.5);
  assert.deepStrictEqual(result.corrections, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: FAIL with "service.processDomainWeightChange is not a function" (except the last "no ratings" test, which may also fail the same way).

- [ ] **Step 3: Implement**

Add to `revolution-wallet/src/retro-payout-service.js`. First, add the import at the top of the file, next to the class-less top-level comments (before `export class RetroPayoutService`):
```js
import { applyDomainWeight, computeDomainScoreFloor } from './domain-weight.js';
```
Then add the new method, placed after `processCorrection` (i.e., right before `getStats`):
```js
  /**
   * Retroactively recomputes every local rating for `domain` in the last 30
   * days under a new domain weight. Always updates the rating's score (up or
   * down). Only ever ADDS a correction transaction (never a clawback) - see
   * docs/superpowers/specs/2026-09-03-domain-weight-retro-correction-design.md.
   *
   * Ratings without a stored preDomainWeightScore (created before this field
   * existed) are skipped, not corrected - they age out of the 30-day window
   * on their own.
   *
   * @param {string} domain
   * @param {number} newWeight - new domain weight (0-2.0)
   * @returns {Promise<{ domain: string, newWeight: number, corrections: Array<{ratingRef: string, oldScore: number, newScore: number, correctionTx: object|null}> }>}
   */
  async processDomainWeightChange(domain, newWeight) {
    if (!domain || typeof newWeight !== 'number' || !Number.isFinite(newWeight)) {
      return { domain, newWeight, corrections: [] };
    }

    const allRatings = await this.tracker.getRatingsLast30Days();
    const ratings = allRatings.filter(r => r.domain === domain && r.preDomainWeightScore != null);

    if (ratings.length === 0) {
      return { domain, newWeight, corrections: [] };
    }

    const currentFactor = await this.tracker.calculateCurrentFactor();
    const userData = await this.distributionEngine.getUserData(this.storage);
    const factorHistory = await this.tracker.getFactorHistory(90);
    const prognosisSF = this.distributionEngine.prognosisModel.calculatePrognosisSF(factorHistory);

    const corrections = [];

    for (const rating of ratings) {
      const floorScore = await computeDomainScoreFloor(this.tracker, this.storage, domain, rating.preDomainWeightScore);
      const { finalScore } = applyDomainWeight(rating.preDomainWeightScore, newWeight, floorScore);
      const newScore = Math.max(0, Math.floor(finalScore));
      const oldScore = rating.score;

      if (newScore !== oldScore) {
        await this.tracker.updateRating(rating.ratingRef, { score: newScore });
      }

      const storedTransactions = await this.getStoredTransactions();
      const ratingTxs = storedTransactions.filter(tx => tx.ratingRef === rating.ratingRef);
      const istTokensSum = ratingTxs.reduce((sum, tx) => {
        try { return sum + BigInt(tx.istTokens || '0'); } catch (_) { return sum; }
      }, 0n);

      const updatedRating = { ...rating, score: newScore };
      const sollTokens = await this.calculateSollTokens(updatedRating, currentFactor, prognosisSF, userData);
      const differenz = sollTokens - istTokensSum;

      let correctionTx = null;
      if (differenz >= this.MIN_PAYOUT_TOKENS) {
        correctionTx = await this.createCorrectionTransaction(
          updatedRating,
          ratingTxs,
          sollTokens,
          istTokensSum,
          differenz,
          currentFactor,
          prognosisSF,
          'domain_weight_change'
        );
      }

      if (newScore !== oldScore || correctionTx) {
        corrections.push({ ratingRef: rating.ratingRef, oldScore, newScore, correctionTx });
      }
    }

    return { domain, newWeight, corrections };
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/1tb-dev/revolution/revolution-wallet && node --test test/retro-payout-service.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Copy into the addon vendor directory**

```bash
cp /Volumes/1tb-dev/revolution/revolution-wallet/src/retro-payout-service.js \
   /Volumes/1tb-dev/revolution/revolution-addon/firefox-addon/vendor/revolution-client/retro-payout-service.js
```

- [ ] **Step 6: Commit both repos**

```bash
cd /Volumes/1tb-dev/revolution/revolution-wallet
git add src/retro-payout-service.js test/retro-payout-service.test.js
git commit -m "$(cat <<'EOF'
Add RetroPayoutService.processDomainWeightChange

Retroactively recomputes a domain's ratings in the 30-day window when its
weight changes: score always updates (up or down), a correction transaction
is only minted when the recompute implies underpayment - a decrease never
claws back an existing transaction.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"

cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/vendor/revolution-client/retro-payout-service.js
git commit -m "$(cat <<'EOF'
Sync retro-payout-service.js: processDomainWeightChange

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `sendDomainCorrectionBatchToWebsite` in `background.js`

**Files:**
- Modify: `revolution-addon/firefox-addon/background.js` (new function, placed after `sendRatingMessageToWebsite`, i.e. after line ~4225)

**Interfaces:**
- Consumes: `getWebsiteMessagingPublicKey()`, `sendToWebsiteOnly(messagingClient, payload, websitePublicKey)` (both existing, same file), `window.FingerprintSeedManager`, `window.SealedBox.encrypt`.
- Produces: `sendDomainCorrectionBatchToWebsite(domain, newWeight, corrections, messagingClient): Promise<void>` — global function (classic script), consumed by Task 10. Sends one Sealed-Box `RATING_CORRECTION_BATCH` message to the website per call, batching all of `domain`'s corrections from one `processDomainWeightChange` result into a single E2E message (avoids the messaging-service burst limit noted in `analytics-settings-sync.js:76-78`).

No existing test harness for this file (see Global Constraints) — verified manually.

- [ ] **Step 1: Add the function**

Edit `revolution-addon/firefox-addon/background.js`, inserting after the closing brace of `sendRatingMessageToWebsite` (after line 4225, before the `/**\n * Send RATING_SUMMARY to all devices EXCEPT website` comment at line 4227):
```js

/**
 * Send a batch of domain-weight-change corrections to the website in one
 * Sealed-Box message, so the Verlauf/analytics UI can display the updated
 * scores (and any minted correction transaction) without one HTTP round
 * trip per rating. See RetroPayoutService.processDomainWeightChange and
 * docs/superpowers/specs/2026-09-03-domain-weight-retro-correction-design.md.
 *
 * @param {string} domain
 * @param {number} newWeight
 * @param {Array<{ratingRef: string, oldScore: number, newScore: number, correctionTx: object|null}>} corrections
 * @param {Object} messagingClient
 */
async function sendDomainCorrectionBatchToWebsite(domain, newWeight, corrections, messagingClient) {
  try {
    if (!corrections || corrections.length === 0) {
      return;
    }

    const websitePublicKey = await getWebsiteMessagingPublicKey();
    if (!websitePublicKey) {
      throw new Error('Website messaging public key not available');
    }

    const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });

    const convertBigIntsToStrings = (obj) => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'bigint') return obj.toString();
      if (Array.isArray(obj)) return obj.map(convertBigIntsToStrings);
      if (typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = convertBigIntsToStrings(value);
        }
        return result;
      }
      return obj;
    };

    const enrichedCorrections = [];
    for (const correction of corrections) {
      const seedObj = await seedManager.getSeeds(correction.ratingRef);
      if (!seedObj) {
        console.warn('[revolution-addon] ⚠️ No seeds found for corrected ratingRef, skipping:', correction.ratingRef);
        continue;
      }
      enrichedCorrections.push(convertBigIntsToStrings({
        ratingRef: correction.ratingRef,
        oldScore: correction.oldScore,
        newScore: correction.newScore,
        seedCLtoSH: seedObj.seedCLtoSH,
        seedSHtoDS: seedObj.seedSHtoDS,
        correctionTx: correction.correctionTx
      }));
    }

    if (enrichedCorrections.length === 0) {
      return;
    }

    const batchPayload = {
      domain,
      reason: 'domain_weight_change',
      newWeight,
      corrections: enrichedCorrections,
      timestamp: Date.now()
    };

    const storage = await browser.storage.local.get(['website_keys']);
    const actualWebsitePublicKey = (storage.website_keys && storage.website_keys.encryption_key) || websitePublicKey;

    const encrypted = await window.SealedBox.encrypt(batchPayload, actualWebsitePublicKey);

    const encryptedMessage = {
      type: 'RATING_CORRECTION_BATCH',
      encryptedPayload: encrypted.ciphertext,
      algorithm: encrypted.algorithm
    };

    await sendToWebsiteOnly(messagingClient, encryptedMessage, actualWebsitePublicKey);
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to send domain correction batch to website:', error);
  }
}
```

- [ ] **Step 2: Manual verification**

In the loaded addon's background console (see Task 1 Step 3), after Task 10 is wired up, trigger a domain-weight change from the dashboard and confirm (in the background console) that `sendDomainCorrectionBatchToWebsite` runs without throwing and that a `RATING_CORRECTION_BATCH` sealed-box message is visible going out (log via the existing messaging-client send logging, or a temporary `console.log(encryptedMessage)` while testing). Full end-to-end confirmation (website actually displaying it) is out of scope here — the website receiver is a separate, not-yet-built piece (see spec's "Explicitly out of scope").

- [ ] **Step 3: Commit**

```bash
cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/background.js
git commit -m "$(cat <<'EOF'
Add sendDomainCorrectionBatchToWebsite

Sends one batched Sealed-Box RATING_CORRECTION_BATCH message per domain-
weight change, carrying every corrected rating's old/new score and (if
minted) its correction transaction. One message per domain instead of one
per rating avoids the messaging-service burst limit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Wire `handlePreferencesUpdate` to trigger and send corrections

**Files:**
- Modify: `revolution-addon/firefox-addon/messaging-integration.js:462-472`
- Modify: `revolution-addon/firefox-addon/background.js` (drain logic, next to the existing `pending_rating_corrections` drain at lines 1190-1208)

**Interfaces:**
- Consumes: `window.retroPayoutService.processDomainWeightChange` (Task 8), `window.sendDomainCorrectionBatchToWebsite` (Task 9), `window.MessagingIntegration.getClient()` (existing).
- Produces: end-to-end wiring — a `PREFERENCES_UPDATE` message with `changes.domainWeights` now actually triggers retro-correction and notifies the website, instead of only logging.

No existing test harness for these files (see Global Constraints) — verified manually.

- [ ] **Step 1: Replace the debug-only block in `handlePreferencesUpdate`**

Edit `revolution-addon/firefox-addon/messaging-integration.js:462-472` from:
```js
    // Log changes for debugging
    if (data.changes) {
      const changeKeys = Object.keys(data.changes);
      RevLog.debug('[MessagingIntegration] Changes:', changeKeys.join(', '));

      // Domain weight changes — log affected domains
      if (data.changes.domainWeights) {
        const domains = Object.keys(data.changes.domainWeights);
        RevLog.debug(`[MessagingIntegration] Domain weight changes: ${domains.length} domains`);
      }
    }
```
to:
```js
    // Log changes for debugging
    if (data.changes) {
      const changeKeys = Object.keys(data.changes);
      RevLog.debug('[MessagingIntegration] Changes:', changeKeys.join(', '));

      // Domain weight changes — retroactively recompute affected ratings
      // and tell the website about every score/correction that resulted.
      if (data.changes.domainWeights) {
        await applyDomainWeightChanges(data.changes.domainWeights);
      }
    }
```

- [ ] **Step 2: Add `applyDomainWeightChanges`**

Add this function to `revolution-addon/firefox-addon/messaging-integration.js`, right after `handlePreferencesUpdate` (before the `handleDeviceRegistered` function):
```js
/**
 * Applies one or more domain-weight changes (from a PREFERENCES_UPDATE
 * message's `changes.domainWeights`) via RetroPayoutService, then notifies
 * the website of every resulting score/correction change.
 *
 * If retroPayoutService isn't ready yet, changes are queued in
 * pending_domain_weight_changes and drained by background.js once the
 * service starts — mirrors the existing pending_rating_corrections fallback.
 *
 * @param {Object} domainWeightChanges - { [domain]: { from: number, to: number } }
 */
async function applyDomainWeightChanges(domainWeightChanges) {
  const domains = Object.keys(domainWeightChanges);
  RevLog.debug(`[MessagingIntegration] Domain weight changes: ${domains.length} domains`);

  const service = window.retroPayoutService;
  if (!service || typeof service.processDomainWeightChange !== 'function') {
    RevLog.warn('[MessagingIntegration] ⚠️ retroPayoutService not ready — domain weight change(s) queued');
    const stored = await browser.storage.local.get('pending_domain_weight_changes');
    const pending = stored.pending_domain_weight_changes || [];
    for (const domain of domains) {
      pending.push({ domain, newWeight: domainWeightChanges[domain].to });
    }
    await browser.storage.local.set({ pending_domain_weight_changes: pending });
    return;
  }

  for (const domain of domains) {
    const newWeight = domainWeightChanges[domain].to;
    try {
      const result = await service.processDomainWeightChange(domain, newWeight);
      if (result.corrections && result.corrections.length > 0 && typeof window.sendDomainCorrectionBatchToWebsite === 'function') {
        const messagingClient = window.MessagingIntegration?.getClient();
        if (messagingClient) {
          await window.sendDomainCorrectionBatchToWebsite(domain, newWeight, result.corrections, messagingClient);
        } else {
          RevLog.warn('[MessagingIntegration] ⚠️ No messaging client — domain correction computed locally but not sent to website');
        }
      }
    } catch (error) {
      RevLog.error(`[MessagingIntegration] ❌ Domain weight retro-correction failed for ${domain}:`, error.message);
    }
  }
}
```

- [ ] **Step 3: Drain `pending_domain_weight_changes` in `background.js`**

Edit `revolution-addon/firefox-addon/background.js`, adding right after the existing pending-corrections drain block (after line 1208's closing, i.e. right after the `} catch (drainErr) { console.error('[background.js] Failed to drain pending corrections:', drainErr); }` that closes the `pending_rating_corrections` drain, and before the outer `} catch (error) { console.error('[background.js] ❌ Failed to start RetroPayoutService:', error); }`):
```js

      // Drain any domain-weight-change messages that arrived before the
      // service was ready (handler stored them in pending_domain_weight_changes).
      try {
        const storedDW = await browser.storage.local.get('pending_domain_weight_changes');
        const pendingDW = storedDW.pending_domain_weight_changes || [];
        if (pendingDW.length > 0) {
          console.log(`[background.js] Draining ${pendingDW.length} pending domain_weight_change(s)`);
          for (const change of pendingDW) {
            try {
              const result = await retroPayoutService.processDomainWeightChange(change.domain, change.newWeight);
              if (result.corrections && result.corrections.length > 0) {
                const messagingClient = window.MessagingIntegration?.getClient();
                if (messagingClient) {
                  await sendDomainCorrectionBatchToWebsite(change.domain, change.newWeight, result.corrections, messagingClient);
                }
              }
            } catch (drainErr) {
              console.error('[background.js] Failed to drain pending domain weight change:', drainErr);
            }
          }
          await browser.storage.local.set({ pending_domain_weight_changes: [] });
        }
      } catch (drainErr) {
        console.error('[background.js] Failed to drain pending domain weight changes:', drainErr);
      }
```

- [ ] **Step 4: Manual verification (full local loop)**

Load the addon unpacked (Task 1 Step 3). On `api.lenkenhoff.de/analytics.html`, change a domain's weight on the dashboard slider and click Speichern. In the addon's background console, confirm:
1. `[MessagingIntegration] Received PREFERENCES_UPDATE` logs.
2. `applyDomainWeightChanges` runs without throwing.
3. `browser.storage.local.get('rev_rating_history_30d')` shows the affected domain's ratings with updated `score` values.
4. If the change was an increase past what's already been paid, `browser.storage.local.get('rev_stored_transactions')` shows a new entry with `reason: 'domain_weight_change'`.
5. `sendDomainCorrectionBatchToWebsite` runs (per Task 9 Step 2).

Then: disable the network briefly (or otherwise make `retroPayoutService` unavailable at message-receipt time, e.g. by triggering the message before the addon's 5s startup delay elapses) and confirm the change lands in `pending_domain_weight_changes` and is drained on the next addon reload.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/1tb-dev/revolution/revolution-addon
git add firefox-addon/messaging-integration.js firefox-addon/background.js
git commit -m "$(cat <<'EOF'
Wire PREFERENCES_UPDATE domain-weight changes to retro-correction

handlePreferencesUpdate now calls RetroPayoutService.processDomainWeightChange
per changed domain and sends the result to the website via
sendDomainCorrectionBatchToWebsite, instead of only logging the change.
Not-yet-ready retroPayoutService is handled the same way as the existing
rating_correction path: queued in pending_domain_weight_changes and drained
once the service starts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Data model change → Task 4. Shared weighting formula → Task 3. `processDomainWeightChange` → Task 8. Wiring → Task 10. Outbound message contract → Task 9. Idempotency (re-processing is a no-op the second time; ratings without `preDomainWeightScore` are skipped) → covered by Task 8's design (pure recompute from current stored state) and its "skipped" test. Explicitly-out-of-scope items (clawback, website receiver, 3x-rule, backfill) → none of the tasks implement them, consistent with the spec.
- **Prerequisite bugs:** Tasks 1-2 fix two bugs discovered while reading the existing `RetroPayoutService`/`background.js` code (missing constructor arg; wrong field name) that would otherwise silently break this entire feature (and the pre-existing manual-correction feature) — approved by the user as in-scope prerequisites.
- **Type/name consistency check:** `applyDomainWeight`/`computeDomainScoreFloor` signatures match between Task 3's definition, Task 6's `window.*` call sites, and Task 8's direct import. `processDomainWeightChange`'s return shape (`{ domain, newWeight, corrections }`, each correction `{ ratingRef, oldScore, newScore, correctionTx }`) matches what Task 9's `sendDomainCorrectionBatchToWebsite` and Task 10's `applyDomainWeightChanges` consume. `createCorrectionTransaction`'s new `reason` param (Task 7) is used with the literal `'domain_weight_change'` consistently in Task 8 and Task 9's outbound message `reason` field.
