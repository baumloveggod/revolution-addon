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
    cappedAt100Percent: floorScore > preDomainWeightScore + 0.0001
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
