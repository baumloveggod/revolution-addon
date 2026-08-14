/**
 * DSL v2 — Recipient Aggregator
 *
 * v1's `computeScore` (weighted_sum / max_signal / first_match) is gone.
 * v2 has no `scoring` block — every signal carries its own `weight` and a
 * `recipients[]` list. The addon's job is:
 *
 *   1. Log signal events while the tab is open (DOM observers / click handlers)
 *   2. Resolve each event's recipients to concrete entityIds
 *   3. On tab close, sum contributions per (type, entityId) tuple
 *
 * `aggregate()` returns both the per-recipient roll-up that
 * `Rating.distribution.beneficiaries[]` consumes AND a per-signal breakdown
 * that lets the analytics dashboard show *which* DSL signal triggered with
 * which weight and how it was distributed across recipients:
 *   {
 *     beneficiaries: [
 *       { type: "content", entityId: "https://...",      weight: 4000 },
 *       { type: "addon",   entityId: "addon:revolution", weight: 4000 },
 *     ],
 *     signals: [
 *       {
 *         signalId: "like_pressed",
 *         label: "Like",
 *         icon: "thumbs-up",
 *         short: "<strong>Like</strong> auf das Video",
 *         count: 1,
 *         baseWeight: 4000,
 *         totalContribution: 16000,
 *         contributions: [
 *           { type: "content", entityId: "https://...",      weight: 4000 },
 *           { type: "addon",   entityId: "addon:revolution", weight: 4000 },
 *         ]
 *       },
 *     ]
 *   }
 *
 * This module is pure data: it does not touch the DOM or the network.
 * The DOM-side resolution (closest_selector, page_selector) lives in the
 * content script that captures events; this module just consumes the
 * already-resolved entityIds.
 */

window.DSLRecipientAggregator = class DSLRecipientAggregator {

  /**
   * @param {Object} runtime - Default identifiers for implicit recipient types
   *   { addonId, browser, os }
   *   - addonId: e.g. "addon:revolution"
   *   - browser: e.g. "browser:firefox"
   *   - os:      e.g. "os:macos"
   */
  constructor(runtime = {}) {
    this.runtime = {
      addonId: runtime.addonId || 'addon:revolution',
      browser: runtime.browser || 'browser:unknown',
      os: runtime.os || 'os:unknown',
    };
  }

  /**
   * Resolve a v2 weight object against a crowdWeights map.
   * Mirrors the server-side logic in analytics-scoring-dsl.js so the addon
   * and dashboard agree on the effective weight.
   *
   * @param {Object} weight - { crowdScope, fallback }
   * @param {Object} crowdWeights - { scope: { autoValue, hitlScore, ... } }
   * @returns {number}
   */
  resolveWeight(weight, crowdWeights) {
    if (!weight) return 0;
    const dist = weight.crowdScope && crowdWeights ? crowdWeights[weight.crowdScope] : null;
    if (dist && typeof dist.autoValue === 'number' && dist.hitlScore !== 'CRITICAL') {
      return dist.autoValue;
    }
    return typeof weight.fallback === 'number' ? weight.fallback : 0;
  }

  /**
   * Default entityId for an implicit recipient (no explicit ref).
   * For `content`, the caller passes the current pageUrl.
   */
  defaultEntityId(type, ctx) {
    switch (type) {
      case 'content': return ctx?.pageUrl || '';
      case 'addon':   return this.runtime.addonId;
      case 'browser': return this.runtime.browser;
      case 'os':      return this.runtime.os;
      default:        return '';
    }
  }

  /**
   * Resolve a single recipient pointer to a concrete entityId.
   *
   * For implicit types ({content, addon, browser, os}) without an explicit
   * ref, falls back to defaultEntityId.
   *
   * For explicit refs:
   *  - `url`           → ctx.pageUrl
   *  - `url_param`     → URL query parameter (ctx.pageUrl + ref.name)
   *  - `url_path`      → path segment at ref.index
   *  - `runtime`       → uses runtime defaults like implicit types
   *  - `constant`      → ref.value as-is
   *  - `page_selector` / `closest_selector`: caller must pre-resolve and pass
   *    the value via `eventEntityIds[recipientIdx]` — this module does not
   *    touch the DOM.
   *
   * After resolution, an optional `as` template is applied:
   *   {value} → resolved raw value
   *   {pageUrl} → ctx.pageUrl
   */
  resolveRecipient(recipient, ctx, preResolvedValue) {
    if (!recipient || !recipient.type) return null;

    const ref = recipient.ref;
    if (!ref) {
      const id = this.defaultEntityId(recipient.type, ctx);
      return id ? { type: recipient.type, entityId: id } : null;
    }

    let value = '';
    switch (ref.from) {
      case 'url':
        value = ctx?.pageUrl || '';
        break;
      case 'url_param': {
        if (!ctx?.pageUrl || !ref.name) break;
        try {
          const u = new URL(ctx.pageUrl);
          value = u.searchParams.get(ref.name) || '';
        } catch { /* ignore */ }
        break;
      }
      case 'url_path': {
        if (!ctx?.pageUrl) break;
        try {
          const u = new URL(ctx.pageUrl);
          const segs = u.pathname.split('/').filter(Boolean);
          value = segs[ref.index] || '';
        } catch { /* ignore */ }
        break;
      }
      case 'runtime':
        value = this.defaultEntityId(recipient.type, ctx);
        break;
      case 'constant':
        value = ref.value || '';
        break;
      case 'page_selector':
      case 'closest_selector':
        // Pre-resolved by the content-script DOM resolver.
        value = preResolvedValue || '';
        break;
      default:
        return null;
    }

    if (!value) return null;

    // Optional template application
    if (ref.as) {
      value = ref.as.replace(/\{value\}/g, value).replace(/\{pageUrl\}/g, ctx?.pageUrl || '');
    }

    return { type: recipient.type, entityId: value };
  }

  /**
   * Aggregate a buffer of signal events into a flat recipient list.
   *
   * @param {Array} events - Each event: {
   *     signal,           // the v2 signal object (resolved/expanded)
   *     count,            // how many times this signal triggered (default 1)
   *     resolvedRefs,     // map { recipientIndex: preResolvedValue } for
   *                       //   page_selector/closest_selector resolutions
   *   }
   * @param {Object} ctx - { pageUrl }
   * @param {Object} crowdWeights - { scope: { autoValue, hitlScore, ... } }
   *
   * @returns {{ beneficiaries: Array, signals: Array }}
   *   - beneficiaries: per (type, entityId) roll-up `[{type, entityId, weight}]`,
   *     sorted descending by `|weight|`.
   *   - signals: per signal id `[{signalId, label, icon, short, count, baseWeight,
   *     totalContribution, contributions: [{type, entityId, weight}]}]`,
   *     sorted descending by `|totalContribution|`.
   */
  aggregate(events, ctx, crowdWeights = {}) {
    const acc = new Map(); // key = `${type}::${entityId}` → number
    const sigAcc = new Map(); // key = signalId → signal accumulator

    for (const event of events) {
      const sig = event.signal;
      if (!sig || !Array.isArray(sig.recipients)) continue;
      const count = event.count || 1;
      const baseWeight = this.resolveWeight(sig.weight, crowdWeights);

      let sigEntry = sigAcc.get(sig.id);
      if (!sigEntry) {
        sigEntry = {
          signalId: sig.id || null,
          label: sig.display?.label || sig.id || null,
          icon: sig.display?.icon || null,
          short: sig.display?.short || null,
          crowdScope: sig.weight?.crowdScope || null,
          count: 0,
          baseWeight,
          totalContribution: 0,
          _contribMap: new Map(), // key → weight
        };
        sigAcc.set(sig.id, sigEntry);
      }
      sigEntry.count += count;

      sig.recipients.forEach((recipient, idx) => {
        const preResolved = event.resolvedRefs ? event.resolvedRefs[idx] : null;
        const resolved = this.resolveRecipient(recipient, ctx, preResolved);
        if (!resolved) return;

        // Per-recipient weight override takes precedence over the signal's.
        const w = recipient.weight
          ? this.resolveWeight(recipient.weight, crowdWeights)
          : baseWeight;
        const contribution = w * count;
        if (contribution === 0) return;

        const key = `${resolved.type}::${resolved.entityId}`;
        acc.set(key, (acc.get(key) || 0) + contribution);

        sigEntry._contribMap.set(key, (sigEntry._contribMap.get(key) || 0) + contribution);
        sigEntry.totalContribution += contribution;
      });
    }

    const beneficiaries = [];
    for (const [key, weight] of acc.entries()) {
      const sep = key.indexOf('::');
      beneficiaries.push({
        type: key.slice(0, sep),
        entityId: key.slice(sep + 2),
        weight,
      });
    }
    beneficiaries.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

    const signals = [];
    for (const entry of sigAcc.values()) {
      const contributions = [];
      for (const [key, weight] of entry._contribMap.entries()) {
        const sep = key.indexOf('::');
        contributions.push({
          type: key.slice(0, sep),
          entityId: key.slice(sep + 2),
          weight,
        });
      }
      contributions.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      signals.push({
        signalId: entry.signalId,
        label: entry.label,
        icon: entry.icon,
        short: entry.short,
        crowdScope: entry.crowdScope || null,
        count: entry.count,
        baseWeight: entry.baseWeight,
        totalContribution: entry.totalContribution,
        contributions,
      });
    }
    signals.sort((a, b) => Math.abs(b.totalContribution) - Math.abs(a.totalContribution));

    return { beneficiaries, signals };
  }
};
