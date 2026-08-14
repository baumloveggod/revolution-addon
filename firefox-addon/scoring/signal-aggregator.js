/**
 * Signal Aggregator — v3 DSL
 *
 * Replaces DSLRecipientAggregator for v3 signal expressions.
 *
 * Key differences from v2:
 *   - Recipients are NOT in the DSL. The standard split (content/addon/browser/os)
 *     is a client-side policy, applied uniformly to every signal.
 *   - Only `entities[]` (optional) declare extra, non-obvious recipients
 *     (e.g. comment author, SponsorBlock service).
 *   - `weight` is a plain number (the fallback). CrowdScope is auto-derived
 *     and looked up from the crowdWeights map by key.
 *   - Signal health tracking: records which selectors matched and which didn't.
 *
 * Output shape is backwards-compatible with the v2 rating payload
 * (beneficiaries[], signals[]) so the analytics UI can render both.
 */

window.SignalAggregator = class SignalAggregator {

  /**
   * @param {Object} runtime - Client-side entity identifiers
   *   { addonId, browser, os }
   * @param {Object} [policy] - Distribution policy (what share each recipient type gets)
   *   Default: all four standard types receive the full signal weight (1:1:1:1)
   */
  constructor(runtime = {}, policy = {}) {
    this.runtime = {
      addonId: runtime.addonId || 'addon:revolution',
      browser: runtime.browser || 'browser:unknown',
      os: runtime.os || 'os:unknown',
    };
    // Policy: which standard recipient types to include and their weight factor.
    // Default is all four at full weight (same as v2 behavior).
    this.policy = {
      content: policy.content ?? 1,
      addon: policy.addon ?? 1,
      browser: policy.browser ?? 1,
      os: policy.os ?? 1,
    };
  }

  /**
   * Resolve weight for a v3 signal.
   * v3: weight is a plain number. CrowdScope is derived externally.
   * v2 compat: weight can also be { crowdScope, fallback }.
   */
  resolveWeight(signal, crowdWeights) {
    // v3: weight is a number, crowdScope is a separate field
    if (typeof signal.weight === 'number') {
      const scope = signal.crowdScope;
      const dist = scope && crowdWeights ? crowdWeights[scope] : null;
      if (dist && typeof dist.autoValue === 'number' && dist.hitlScore !== 'CRITICAL') {
        return dist.autoValue;
      }
      return signal.weight;
    }
    // v2 fallback: weight is { crowdScope, fallback }
    if (signal.weight && typeof signal.weight === 'object') {
      const dist = signal.weight.crowdScope && crowdWeights
        ? crowdWeights[signal.weight.crowdScope] : null;
      if (dist && typeof dist.autoValue === 'number' && dist.hitlScore !== 'CRITICAL') {
        return dist.autoValue;
      }
      return typeof signal.weight.fallback === 'number' ? signal.weight.fallback : 0;
    }
    return 0;
  }

  /**
   * Resolve a v3 entity ref to a concrete entityId.
   * Mirrors the v2 resolveRecipient logic but for the entities[] array.
   */
  resolveEntity(entity, ctx, preResolvedValue) {
    if (!entity || !entity.ref) return null;
    const ref = entity.ref;
    let value = '';

    switch (ref.from) {
      case 'url':
        value = ctx?.pageUrl || '';
        break;
      case 'url_param': {
        if (!ctx?.pageUrl || !ref.name) break;
        try { value = new URL(ctx.pageUrl).searchParams.get(ref.name) || ''; } catch {}
        break;
      }
      case 'url_path': {
        if (!ctx?.pageUrl) break;
        try {
          const segs = new URL(ctx.pageUrl).pathname.split('/').filter(Boolean);
          value = segs[ref.index] || '';
        } catch {}
        break;
      }
      case 'constant':
        value = ref.value || '';
        break;
      case 'page_selector':
      case 'closest_selector':
        value = preResolvedValue || '';
        break;
      case 'runtime':
        value = '';
        break;
      default:
        return null;
    }

    if (!value) return null;

    if (ref.as) {
      value = ref.as.replace(/\{value\}/g, value).replace(/\{pageUrl\}/g, ctx?.pageUrl || '');
    }

    return { type: entity.type, entityId: value };
  }

  /**
   * Aggregate signal events into beneficiaries + signal breakdown.
   *
   * @param {Array} events - Each: { signal, count, resolvedRefs? }
   *   signal is a v3 signal object (or v2 with recipients[])
   * @param {Object} ctx - { pageUrl }
   * @param {Object} crowdWeights - { scope: { autoValue, hitlScore } }
   * @returns {{ beneficiaries: Array, signals: Array }}
   */
  aggregate(events, ctx, crowdWeights = {}) {
    const acc = new Map();       // key → weight
    const sigAcc = new Map();    // signalId → accumulator

    for (const event of events) {
      const sig = event.signal;
      if (!sig) continue;

      const count = event.count || 1;
      const baseWeight = this.resolveWeight(sig, crowdWeights);

      let sigEntry = sigAcc.get(sig.id);
      if (!sigEntry) {
        sigEntry = {
          signalId: sig.id || null,
          label: sig.display?.label || sig.id || null,
          icon: sig.display?.icon || null,
          short: sig.display?.short || null,
          crowdScope: sig.crowdScope || sig.weight?.crowdScope || null,
          count: 0,
          baseWeight,
          totalContribution: 0,
          _contribMap: new Map(),
        };
        sigAcc.set(sig.id, sigEntry);
      }
      sigEntry.count += count;

      // ── v2 path: if signal has recipients[], use those ──
      if (Array.isArray(sig.recipients) && sig.recipients.length > 0) {
        this._aggregateV2Recipients(sig, event, count, baseWeight, ctx, crowdWeights, acc, sigEntry);
        continue;
      }

      // ── v3 path: apply standard policy + entities[] ──
      const contribution = baseWeight * count;
      if (contribution === 0 && (!sig.entities || sig.entities.length === 0)) continue;

      // Standard recipients from policy
      for (const [type, factor] of Object.entries(this.policy)) {
        if (factor === 0) continue;
        const entityId = this._standardEntityId(type, ctx);
        if (!entityId) continue;
        const w = contribution * factor;
        if (w === 0) continue;
        const key = `${type}::${entityId}`;
        acc.set(key, (acc.get(key) || 0) + w);
        sigEntry._contribMap.set(key, (sigEntry._contribMap.get(key) || 0) + w);
        sigEntry.totalContribution += w;
      }

      // Extra entities from DSL
      if (Array.isArray(sig.entities)) {
        for (let i = 0; i < sig.entities.length; i++) {
          const preResolved = event.resolvedRefs ? event.resolvedRefs[i] : null;
          const resolved = this.resolveEntity(sig.entities[i], ctx, preResolved);
          if (!resolved) continue;
          const w = contribution;
          if (w === 0) continue;
          const key = `${resolved.type}::${resolved.entityId}`;
          acc.set(key, (acc.get(key) || 0) + w);
          sigEntry._contribMap.set(key, (sigEntry._contribMap.get(key) || 0) + w);
          sigEntry.totalContribution += w;
        }
      }
    }

    return this._buildResult(acc, sigAcc);
  }

  // ── private helpers ──

  _standardEntityId(type, ctx) {
    switch (type) {
      case 'content': return ctx?.pageUrl || '';
      case 'addon':   return this.runtime.addonId;
      case 'browser': return this.runtime.browser;
      case 'os':      return this.runtime.os;
      default:        return '';
    }
  }

  /** v2 backwards-compat: process recipients[] array */
  _aggregateV2Recipients(sig, event, count, baseWeight, ctx, crowdWeights, acc, sigEntry) {
    const resolvedRefs = event.resolvedRefs || {};
    for (let idx = 0; idx < sig.recipients.length; idx++) {
      const recipient = sig.recipients[idx];
      const preResolved = resolvedRefs[idx] || null;

      // Resolve entityId
      const ref = recipient.ref;
      let entityId = '';
      if (!ref) {
        entityId = this._standardEntityId(recipient.type, ctx);
      } else {
        const resolved = this.resolveEntity(
          { type: recipient.type, ref },
          ctx,
          preResolved
        );
        entityId = resolved?.entityId || '';
      }
      if (!entityId) continue;

      // Weight: per-recipient override or signal weight
      let w;
      if (recipient.weight) {
        const rSig = { weight: recipient.weight, crowdScope: recipient.weight.crowdScope };
        w = this.resolveWeight(rSig, crowdWeights) * count;
      } else {
        w = baseWeight * count;
      }
      if (w === 0) continue;

      const key = `${recipient.type}::${entityId}`;
      acc.set(key, (acc.get(key) || 0) + w);
      sigEntry._contribMap.set(key, (sigEntry._contribMap.get(key) || 0) + w);
      sigEntry.totalContribution += w;
    }
  }

  _buildResult(acc, sigAcc) {
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
        crowdScope: entry.crowdScope,
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
