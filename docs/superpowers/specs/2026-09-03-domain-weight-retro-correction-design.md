# Domain-Weight Retro-Correction — Design

Date: 2026-09-03
Scope: Firefox addon only (`revolution-addon/firefox-addon/`). Website-side
receiving logic is explicitly out of scope — see "Website contract" below,
which the website implements separately.

## Problem

The dashboard donut slider on `api.lenkenhoff.de/analytics.html` lets the
user set a per-domain weight (0–2.0x, default 1.0 "Normal"). Saving syncs the
new `domainWeights` to the addon via an E2E `PREFERENCES_UPDATE` message
(`messaging-integration.js:handlePreferencesUpdate`). Today that handler only
stores the new weight and applies it to *future* ratings
(`revolution-scoring.js:253-274`) — nothing happens to ratings already
created before the change.

`messaging-integration.js`'s docstring already claims "Also triggers
retroactive correction for domain weight changes (Phase 3)" — this was never
implemented; only a debug log exists (`messaging-integration.js:462-471`).

A closely related, structurally similar mechanism already exists for a
different trigger (manual single-rating edit on the website, via
`rating-edit-ui.js` → `rating_correction` message →
`RetroPayoutService.processCorrection`). This design reuses that
infrastructure rather than inventing a parallel one.

## Terminology (user-clarified)

- **Rating (score)**: mutable. Can be corrected up or down at any time.
  Retroactive domain-weight correction always updates it, in both
  directions.
- **Transaction (minted tokens)**: immutable once created. Never reversed,
  never negative. A domain-weight decrease that would imply "too many tokens
  already paid" does **not** claw anything back — the existing transaction(s)
  stand. A domain-weight increase that implies underpayment **does** mint an
  additional correction transaction for the difference.

## Data model change

`rev_rating_history_30d` entries currently store only the final
(post-domain-weight) score (`distribution-engine.js:119-125` passes
`scoringResult.score` into `TranslationFactorTracker.addRating`). That is not
enough to recompute a rating under a *new* weight, because:

- The stored score may already include a floor-correction bump
  (`_computeDomainScoreFloor`), so `storedScore / oldWeight` does not recover
  the true pre-weight base.
- The content-type multiplier is baked in before the domain weight is
  applied and isn't separately recoverable either.

**Change:** persist `preDomainWeightScore` (score after content-type
multiplier, before domain weight) alongside `score` on each history entry.

- `TranslationFactorTracker.addRating(score, domain, ratingRef, timestamp, preDomainWeightScore)`
  — new optional 5th param, stored on the entry. `undefined` for
  pre-existing entries (before this change ships) — those are simply not
  eligible for retro-correction (see Idempotency/Compatibility below).
- `distribution-engine.js:119-125` passes `scoringResult.metadata.preDomainWeightScore`
  through.
- `revolution-scoring.js` stores `preDomainWeightScore` (already computed at
  line 233) onto `scoringResult.metadata` so it reaches `addRating`.

## Shared weighting formula

Extract the block at `revolution-scoring.js:257-274` into a pure helper:

```js
// scoring/domain-weight.js
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
```

Both the live-scoring path (`revolution-scoring.js`) and the new retro-path
(`RetroPayoutService`) call this — no duplicated math.

## `RetroPayoutService.processDomainWeightChange(domain, newWeight)`

New method, same file as the existing `processCorrection`:

1. `ratings = (await this.tracker.getRatingsLast30Days()).filter(r => r.domain === domain && r.preDomainWeightScore != null)`.
   Entries without `preDomainWeightScore` (created before this ships, or
   missing for any other reason) are skipped — logged, not corrected. No
   retroactive backfill of old entries.
2. For each rating:
   - `floorScore = await this._computeDomainScoreFloor(domain, rating.preDomainWeightScore)`
     (existing method, reused as-is).
   - `{ finalScore } = applyDomainWeight(rating.preDomainWeightScore, newWeight, floorScore)`.
   - `newScore = finalScore` rounded the same way live scoring rounds
     (`Math.floor`, clamped to `MAX_SCORE`).
   - If `newScore !== rating.score`: `await this.tracker.updateRating(rating.ratingRef, { score: newScore })`.
   - Compute `sollTokens` (existing `calculateSollTokens`, using `newScore`)
     vs `istTokensSum` (existing per-`ratingRef` transaction sum, as in
     `processCorrection`).
   - `differenz = sollTokens - istTokensSum`. If `differenz >= MIN_PAYOUT_TOKENS`:
     call the existing `createCorrectionTransaction(...)` (mints the delta,
     queues it via `privacyLayer.queueTransaction`, same as today). No 3x-rule
     gate — this is an explicit user action, same reasoning as
     `processCorrection`.
   - If `differenz < MIN_PAYOUT_TOKENS`: no transaction. This includes the
     "score went down" case — by construction `differenz` will be ≤ 0 there
     (lower score ⇒ lower or equal `sollTokens`), so it always falls into
     this branch. No new "negative" code path is needed.
   - Record `{ ratingRef, oldScore: rating.score, newScore, correctionTx: <created tx or null> }`.
3. Returns the list of per-rating results; caller (see Wiring) turns that
   into the outbound website message.

Reuses `calculateSollTokens`, `createCorrectionTransaction`,
`_computeDomainScoreFloor`, `getStoredTransactions` as-is — no changes to
those.

## Wiring: `handlePreferencesUpdate`

In `messaging-integration.js`, where `data.changes.domainWeights` is
currently only logged (lines 467-471): for each `[domain, { to }]` in
`data.changes.domainWeights`, call
`retroPayoutService.processDomainWeightChange(domain, to)`. Same
not-ready-yet fallback as the existing `rating_correction` path
(`pending_rating_corrections` queue / drain-on-init in `background.js:1190-1204`)
— add a parallel `pending_domain_weight_changes` queue for this case, drained
the same way when `retroPayoutService` becomes available.

After each `processDomainWeightChange` call, if the result list is
non-empty, send it to the website (see below).

## Outbound message to the website

One batched, Sealed-Box-encrypted message per domain change (not one per
rating — avoids the messaging-service burst limit noted in
`analytics-settings-sync.js:76-78`), mirroring the existing
`sendRatingMessageToWebsite` pattern (`background.js:4109-4225`:
`SealedBox.encrypt` + `sendToWebsiteOnly`):

```js
{
  type: 'RATING_CORRECTION_BATCH',
  domain: string,
  reason: 'domain_weight_change',
  newWeight: number,
  corrections: [
    {
      ratingRef: string,
      oldScore: number,
      newScore: number,
      correctionTx: null | {
        transaction_ref: string,
        tokens: string,           // minted delta, BigInt-as-string
        pairIndex: number,
        translationFactor: string,
        seedCLtoSH: string,       // reused from the rating's existing seed pair
        seedSHtoDS: string
      }
    },
    ...
  ],
  timestamp: number
}
```

This is the contract the website side implements against (out of scope
here). Sending logic lives next to `sendRatingMessageToWebsite` in
`background.js`, reusing `getWebsiteMessagingPublicKey` /
`sendToWebsiteOnly`.

## Idempotency / compatibility

- Re-processing the same `PREFERENCES_UPDATE` (e.g. redelivered message) is
  safe: `processDomainWeightChange` is a pure function of current stored
  state and the target weight — running it twice with the same weight
  produces `newScore === rating.score` the second time (no-op update) and
  `differenz` already accounted for by the first run's minted transaction
  (`istTokensSum` includes it), so no duplicate mint.
- Ratings without `preDomainWeightScore` (pre-migration data) are skipped,
  not corrected. This is a one-time gap that ages out after 30 days.
- No change to `processCorrection` (manual single-rating edit path) or to
  the live-scoring formula beyond extracting it into the shared helper.

## Explicitly out of scope

- Clawback / negative transactions.
- Website receiving handler for `RATING_CORRECTION_BATCH`.
- Changing the 30-day window or the `MIN_PAYOUT_TOKENS` threshold.
- Backfilling `preDomainWeightScore` for existing history entries.
