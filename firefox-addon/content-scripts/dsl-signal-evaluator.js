/**
 * DSL Signal Evaluator — Content Script (v2)
 *
 * v1 reported a snapshot of `signalValues` and let the background-side
 * `DSLScoringEngine` compute a single weighted score. v2 has no scoring
 * block at all: each signal carries its own `recipients[]` and `weight`,
 * and the addon's job is to log **events** (state transitions, clicks)
 * during the tab's lifetime.
 *
 * Per event we capture:
 *   { signalId, count, resolvedRefs }
 *
 * `resolvedRefs[recipientIdx]` is the value extracted for any
 * `page_selector` / `closest_selector` recipient ref — those need DOM
 * access, so they MUST be resolved here in the content script (the
 * background-side aggregator does not touch the DOM).
 *
 * Background-side `DSLRecipientAggregator.aggregate()` consumes the
 * buffered events at tab-close and produces the recipient list that
 * becomes `Rating.distribution.beneficiaries[]`.
 *
 * Triggers:
 *   - boolean signal with `observe: true`  → emit on each false→true transition
 *   - click_observed signal                → emit on each click
 *   - numeric signal                       → emit when value transitions from 0 to >0
 *                                            (refinement for true delta-counting is
 *                                             a v2 follow-up)
 *   - HTTP-source signal                   → emit once when the value first arrives
 */

(function () {
  'use strict';

  const EVALUATOR_ID = 'revolution-dsl-evaluator';

  // Prevent double-injection
  if (window[EVALUATOR_ID]) return;
  window[EVALUATOR_ID] = true;

  let expression = null;
  let previousValues = {};   // signalId → last observed value (for transition detection)
  let observers = [];
  let clickListeners = new Map();
  let httpRequested = new Set();
  let passiveCleanups = []; // [{cleanup: fn, signalId?}] for passive/event-driven signals
  let dwellState = null;    // shared by dwell_active + read_completed
  let scrollState = null;   // shared by scroll_depth + read_completed

  // Passive / event-driven extract methods. These do NOT poll the DOM;
  // they install listeners and emit signal events when their threshold is
  // crossed. evaluateAll() skips them, setupObservers() routes them through
  // setupPassiveSignal(), and cleanupObservers() unwinds them.
  const PASSIVE_METHODS = new Set([
    'page_visit', 'addon_state',
    'dwell_active', 'scroll_depth', 'read_completed',
    'media_play', 'media_progress', 'media_completed',
    'text_selection', 'copy', 'submit_observed',
    'keypress_in', 'print', 'link_hover',
  ]);

  function isPassiveMethod(method) {
    return PASSIVE_METHODS.has(method);
  }

  // ===== EXTRACTION METHODS =====

  function extractAttr(el, def) {
    const val = el.getAttribute(def.name);
    if (def.equals !== undefined) {
      return val === def.equals;
    }
    if (val == null) return null;
    if (def.parseAs === 'integer') return parseInt(val, 10) || 0;
    if (def.parseAs === 'float') return parseFloat(val) || 0;
    if (def.parseAs === 'compact') return parseCompactNumber(val);
    return val;
  }

  function extractText(el, def) {
    let text = el.textContent || '';
    if (def.regex) {
      const match = text.match(new RegExp(def.regex));
      text = match ? match[1] : null;
    }
    if (text === null) return 0;
    if (def.parseAs === 'integer') {
      return parseInt(text.replace(/[,.\s]/g, ''), 10) || 0;
    }
    if (def.parseAs === 'float') {
      return parseFloat(text.replace(/[,\s]/g, '').replace(/,/, '.')) || 0;
    }
    return text;
  }

  function extractClassContains(el, def) {
    return el.classList.contains(def.name);
  }

  // Locale-aware "compact number" parser.
  // Handles: "1,234,567" / "1.234.567" / "1,2 Mio." / "1.2M" / "847K".
  const COMPACT_MULTIPLIERS = {
    K: 1e3, k: 1e3, Tsd: 1e3, tsd: 1e3,
    M: 1e6, Mio: 1e6, mio: 1e6, Mn: 1e6,
    B: 1e9, Mrd: 1e9, mrd: 1e9, Bn: 1e9,
    T: 1e12, Bio: 1e12, bio: 1e12,
  };

  function parseCompactNumber(raw) {
    if (raw == null) return 0;
    const str = String(raw).trim();
    if (!str) return 0;

    const m = str.match(/([\d]+(?:[.,\s\u00A0][\d]+)*)\s*(Mrd|Mio|Tsd|Bio|million|billion|trillion|thousand|[KMBTkmbt])?/);
    if (!m) return 0;

    let numPart = m[1];
    const suffix = m[2];

    let value;
    if (suffix && /^(K|k|M|B|T|Mio|Mrd|Tsd|Bio|million|billion|trillion|thousand|Mn|Bn)$/.test(suffix)) {
      const lastDot = numPart.lastIndexOf('.');
      const lastComma = numPart.lastIndexOf(',');
      const decimalIdx = Math.max(lastDot, lastComma);
      if (decimalIdx >= 0) {
        const intPart = numPart.slice(0, decimalIdx).replace(/[.,\s\u00A0]/g, '');
        const decPart = numPart.slice(decimalIdx + 1).replace(/[^\d]/g, '');
        value = parseFloat(`${intPart}.${decPart}`);
      } else {
        value = parseFloat(numPart.replace(/[.,\s\u00A0]/g, ''));
      }
      const key = /^million$/i.test(suffix) ? 'M'
                : /^billion$/i.test(suffix) ? 'B'
                : /^trillion$/i.test(suffix) ? 'T'
                : /^thousand$/i.test(suffix) ? 'K'
                : suffix;
      const mult = COMPACT_MULTIPLIERS[key] || 1;
      value = value * mult;
    } else {
      value = parseFloat(numPart.replace(/[.,\s\u00A0]/g, ''));
    }

    return isFinite(value) ? value : 0;
  }

  function extractTextNumber(el) {
    const text = (el.textContent || '').trim();
    return parseCompactNumber(text);
  }

  function extractMetaContent(def) {
    const name = def.name;
    if (!name) return null;
    const el = document.querySelector(
      `meta[itemprop="${name}"], meta[name="${name}"], meta[property="${name}"]`
    );
    if (!el) return null;
    const content = el.getAttribute('content');
    if (content == null) return null;
    if (def.parseAs === 'integer') return parseInt(content, 10) || 0;
    if (def.parseAs === 'float') return parseFloat(content) || 0;
    if (def.parseAs === 'compact') return parseCompactNumber(content);
    if (def.parseAs === 'iso_duration') return parseIsoDuration(content);
    return content;
  }

  function parseIsoDuration(iso) {
    if (!iso) return 0;
    const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseFloat(m[3] || '0');
    return h * 3600 + min * 60 + s;
  }

  function jsonPath(obj, path) {
    if (!obj || !path) return null;
    let p = path.replace(/^\$/, '');
    if (p.startsWith('..')) {
      const key = p.slice(2).split(/[.\[]/)[0];
      const rest = p.slice(2 + key.length);
      const found = findFirstKey(obj, key);
      if (found == null) return null;
      return rest ? jsonPath(found, rest) : found;
    }
    if (p.startsWith('.')) p = p.slice(1);
    const tokens = p.match(/[^.\[\]]+/g) || [];
    let cur = obj;
    for (const t of tokens) {
      if (cur == null) return null;
      const idx = /^\d+$/.test(t) ? parseInt(t, 10) : t;
      cur = cur[idx];
    }
    return cur == null ? null : cur;
  }

  function findFirstKey(obj, key) {
    if (obj == null || typeof obj !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = findFirstKey(item, key);
        if (r != null) return r;
      }
    } else {
      for (const k of Object.keys(obj)) {
        const r = findFirstKey(obj[k], key);
        if (r != null) return r;
      }
    }
    return null;
  }

  function extractJsonLd(def) {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (def.typeEquals && item['@type'] !== def.typeEquals) continue;
        const v = jsonPath(item, def.path || '$');
        if (v != null) {
          if (def.parseAs === 'integer') return parseInt(v, 10) || 0;
          if (def.parseAs === 'float') return parseFloat(v) || 0;
          if (def.parseAs === 'compact') return parseCompactNumber(v);
          if (def.parseAs === 'iso_duration') return parseIsoDuration(v);
          return v;
        }
      }
    }
    return null;
  }

  function extractUrlParam(def) {
    try {
      const url = new URL(window.location.href);
      const val = url.searchParams.get(def.name);
      if (val == null) return null;
      if (def.parseAs === 'integer') return parseInt(val, 10) || 0;
      return val;
    } catch {
      return null;
    }
  }

  function extractAgeFromIso(el, def) {
    let iso;
    if (def.attr) {
      iso = el.getAttribute(def.attr);
    } else if (def.meta) {
      const m = document.querySelector(
        `meta[itemprop="${def.meta}"], meta[name="${def.meta}"], meta[property="${def.meta}"]`
      );
      iso = m ? m.getAttribute('content') : null;
    } else {
      iso = (el.textContent || '').trim();
    }
    if (!iso) return 0;
    const t = Date.parse(iso);
    if (isNaN(t)) return 0;
    const ageMs = Date.now() - t;
    return Math.max(0, Math.floor(ageMs / 86400000));
  }

  // ===== SIGNAL EVALUATION =====

  function resolveHttpInput(inputDef) {
    if (!inputDef) return null;
    switch (inputDef.from) {
      case 'url_param': {
        try {
          return new URL(window.location.href).searchParams.get(inputDef.name);
        } catch { return null; }
      }
      case 'url_regex': {
        const m = window.location.href.match(new RegExp(inputDef.pattern));
        return m ? (m[1] ?? m[0]) : null;
      }
      case 'dom_attr': {
        const el = document.querySelector(inputDef.css);
        return el ? el.getAttribute(inputDef.attr) : null;
      }
      case 'dom_text': {
        const el = document.querySelector(inputDef.css);
        return el ? (el.textContent || '').trim() : null;
      }
      default:
        return null;
    }
  }

  function requestHttpSignal(signalDef) {
    if (httpRequested.has(signalDef.id)) {
      return previousValues[signalDef.id] ?? null;
    }
    const input = resolveHttpInput(signalDef.input);
    if (input == null || input === '') return null;

    const tpl = signalDef.request?.url;
    if (!tpl) return null;
    const resolvedUrl = tpl.replace(/\{input\}/g, encodeURIComponent(input));

    httpRequested.add(signalDef.id);
    browser.runtime.sendMessage({
      type: 'DSL_HTTP_REQUEST',
      signalId: signalDef.id,
      provider: signalDef.provider,
      resolvedUrl,
      method: signalDef.request?.method || 'GET',
      timeoutMs: signalDef.request?.timeoutMs || 3000,
      cacheMs: signalDef.cacheMs || 3600000,
      extract: signalDef.extract || null,
    }).catch(() => {
      httpRequested.delete(signalDef.id);
    });
    return signalDef.type === 'numeric' ? 0 : null;
  }

  /**
   * Evaluate a signal against the current DOM. Returns the raw value AND
   * the matched element (so callers can resolve closest_selector recipients
   * relative to the trigger origin).
   */
  function evaluateSignal(signalDef) {
    if (signalDef.source === 'http') {
      return { value: requestHttpSignal(signalDef), element: null };
    }

    const method = signalDef.extract?.method;

    if (method === 'meta_content') {
      return { value: extractMetaContent(signalDef.extract), element: null };
    }
    if (method === 'json_ld') {
      return { value: extractJsonLd(signalDef.extract), element: null };
    }
    if (method === 'url_param') {
      return { value: extractUrlParam(signalDef.extract), element: null };
    }

    const selector = signalDef.selector?.css;
    if (!selector) return { value: null, element: null };

    if (method === 'count') {
      return { value: document.querySelectorAll(selector).length, element: null };
    }

    if (method === 'exists') {
      const el = document.querySelector(selector);
      return { value: el !== null, element: el };
    }

    if (method === 'click_observed') {
      // Click events drive their own trigger path via setupClickObserver;
      // here we just report the latched state.
      const state = clickListeners.get(signalDef.id);
      return { value: state?.clicked || false, element: null };
    }

    let element = document.querySelector(selector);
    if (!element && signalDef.selector.fallback) {
      element = document.querySelector(signalDef.selector.fallback);
    }
    if (!element) {
      return { value: signalDef.type === 'boolean' ? false : 0, element: null };
    }

    let value;
    switch (method) {
      case 'attr':           value = extractAttr(element, signalDef.extract); break;
      case 'text':           value = extractText(element, signalDef.extract); break;
      case 'text_number':    value = extractTextNumber(element); break;
      case 'class_contains': value = extractClassContains(element, signalDef.extract); break;
      case 'age_from_iso':   value = extractAgeFromIso(element, signalDef.extract); break;
      default:               value = null;
    }
    return { value, element };
  }

  // ===== RECIPIENT REF RESOLUTION (DOM-side) =====

  /**
   * Resolve any page_selector / closest_selector recipient refs against the DOM
   * at trigger time. Returns a sparse map { recipientIdx: extractedValue } that
   * the background aggregator consumes.
   */
  function resolveDomRecipientRefs(signalDef, originElement) {
    if (!Array.isArray(signalDef.recipients)) return null;
    const out = {};
    let any = false;
    signalDef.recipients.forEach((recipient, idx) => {
      const ref = recipient?.ref;
      if (!ref) return;
      if (ref.from === 'page_selector') {
        const sel = ref.selector?.css;
        if (!sel) return;
        const el = document.querySelector(sel);
        if (!el) return;
        const v = extractRefValue(el, ref.extract);
        if (v != null && v !== '') { out[idx] = v; any = true; }
      } else if (ref.from === 'closest_selector') {
        if (!originElement) return;
        const sel = ref.selector?.css;
        if (!sel) return;
        const el = originElement.closest(sel);
        if (!el) return;
        const v = extractRefValue(el, ref.extract);
        if (v != null && v !== '') { out[idx] = v; any = true; }
      }
    });
    return any ? out : null;
  }

  function extractRefValue(el, extract) {
    if (!extract) return el.textContent?.trim() || null;
    switch (extract.method) {
      case 'attr': return el.getAttribute(extract.name);
      case 'text': return (el.textContent || '').trim();
      case 'text_number': return extractTextNumber(el);
      default: return el.textContent?.trim() || null;
    }
  }

  // ===== EVENT EMISSION =====

  function emitEvent(signalDef, count, originElement) {
    const resolvedRefs = resolveDomRecipientRefs(signalDef, originElement);
    browser.runtime.sendMessage({
      type: 'DSL_SIGNAL_EVENT',
      signalId: signalDef.id,
      count,
      resolvedRefs: resolvedRefs || undefined,
      domain: expression?.domain || window.location.hostname,
      pageUrl: window.location.href,
    });
  }

  /**
   * Decide whether a signal value transition counts as a trigger event.
   * Returns the event count to emit (0 = no event).
   */
  function detectTrigger(signalDef, prev, current) {
    if (signalDef.type === 'boolean') {
      // false → true transition
      if (current === true && prev !== true) return 1;
      return 0;
    }
    if (signalDef.type === 'numeric') {
      const prevNum = typeof prev === 'number' ? prev : 0;
      const curNum = typeof current === 'number' ? current : 0;
      // Treat first non-zero observation as a single event. A v2 follow-up
      // can refine this to true delta counting.
      if (curNum > 0 && prevNum <= 0) return 1;
      return 0;
    }
    return 0;
  }

  function evaluateAll() {
    if (!expression?.signals) return;

    for (const signalDef of expression.signals) {
      // click_observed and all passive methods are event-driven; their
      // listeners emit events directly. evaluateAll() only handles
      // poll-style methods (count/exists/attr/text/...).
      const m = signalDef.extract?.method;
      if (m === 'click_observed' || isPassiveMethod(m)) continue;

      const { value, element } = evaluateSignal(signalDef);
      const prev = previousValues[signalDef.id];

      const triggerCount = detectTrigger(signalDef, prev, value);
      if (triggerCount > 0) {
        emitEvent(signalDef, triggerCount, element);
      }

      previousValues[signalDef.id] = value;
    }
  }

  // ===== OBSERVERS =====

  function setupObservers() {
    cleanupObservers();

    if (!expression?.signals) return;

    const observableSignals = expression.signals.filter(s => s.observe);
    if (observableSignals.length > 0) {
      const observer = new MutationObserver(() => {
        evaluateAll();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-pressed', 'class', 'data-active', 'aria-label'],
      });
      observers.push(observer);
    }

    for (const signalDef of expression.signals) {
      const m = signalDef.extract?.method;
      if (m === 'click_observed') {
        setupClickObserver(signalDef);
      } else if (isPassiveMethod(m)) {
        setupPassiveSignal(signalDef);
      }
    }
  }

  function setupClickObserver(signalDef) {
    const selector = signalDef.selector?.css;
    if (!selector) return;

    const state = { clicked: false };
    clickListeners.set(signalDef.id, state);

    const handler = (event) => {
      const target = event.target.closest(selector);
      if (target) {
        state.clicked = true;
        // Each click is one event — origin element drives closest_selector resolution.
        emitEvent(signalDef, 1, target);
      }
    };

    document.addEventListener('click', handler, true);
    state._handler = handler;
  }

  // ===== PASSIVE / EVENT-DRIVEN SIGNAL OBSERVERS (v3) =====
  //
  // Passive signals capture engagement that doesn't involve a deliberate
  // click on a tracked element: dwell time, scroll depth, video play,
  // text selection, etc. Reader-only sites (blogs, news, docs) had no
  // way to attribute revenue under v2 because every signal was a click.
  //
  // Each passive method type lives in its own setupX function. They all:
  //   1. Install DOM listeners / timers
  //   2. Track per-signal state (already-emitted, accumulators)
  //   3. Call emitEvent(signalDef, count, originElement) when threshold met
  //   4. Push a cleanup fn into passiveCleanups[] for tab-close teardown
  //
  // Threshold-style methods (dwell_active, scroll_depth, read_completed,
  // media_progress, keypress_in, link_hover) emit ONCE per page load —
  // multiple thresholds = multiple signals in the DSL expression.
  // Repeating-event methods (media_play, media_completed, copy, submit,
  // text_selection, print) emit each occurrence.

  function setupPassiveSignal(signalDef) {
    switch (signalDef.extract?.method) {
      case 'page_visit':      return setupPageVisit(signalDef);
      case 'addon_state':     return setupAddonState(signalDef);
      case 'dwell_active':    return setupDwellActive(signalDef);
      case 'scroll_depth':    return setupScrollDepth(signalDef);
      case 'read_completed':  return setupReadCompleted(signalDef);
      case 'media_play':      return setupMediaPlay(signalDef);
      case 'media_progress':  return setupMediaProgress(signalDef);
      case 'media_completed': return setupMediaCompleted(signalDef);
      case 'text_selection':  return setupTextSelection(signalDef);
      case 'copy':            return setupCopy(signalDef);
      case 'submit_observed': return setupSubmitObserved(signalDef);
      case 'keypress_in':     return setupKeypressIn(signalDef);
      case 'print':           return setupPrint(signalDef);
      case 'link_hover':      return setupLinkHover(signalDef);
    }
  }

  // --- page_visit: fires immediately on page load ---
  function setupPageVisit(signalDef) {
    emitEvent(signalDef, 1, null);
    passiveCleanups.push({ cleanup: () => {}, signalId: signalDef.id });
  }

  // --- addon_state: queries background for addon-internal metrics ---
  // Emits once after the background responds. For boolean keys (e.g.
  // "active") the count is 1; for numeric keys (e.g. "adsBlocked",
  // "trackersBlocked") the count is the returned value.
  function setupAddonState(signalDef) {
    const key = signalDef.extract?.key;
    if (!key) return;
    browser.runtime.sendMessage({ type: 'DSL_QUERY_ADDON_STATE', key })
      .then(response => {
        if (response == null) return;
        const value = response.value;
        if (value === true) {
          emitEvent(signalDef, 1, null);
        } else if (typeof value === 'number' && value > 0) {
          emitEvent(signalDef, value, null);
        }
      })
      .catch(() => { /* background not ready or tab closing — ignore */ });
    passiveCleanups.push({ cleanup: () => {}, signalId: signalDef.id });
  }

  // --- Shared dwell accumulator (Page Visibility API + focus/blur) ---
  // Counts only "active" time: tab visible AND window focused. Anything
  // else (background tab, minimised window, switched-away tab) pauses.
  function ensureDwellState() {
    if (dwellState) return dwellState;
    dwellState = {
      activeMs: 0,
      lastTickAt: null,
      isActive: !document.hidden && document.hasFocus(),
    };

    function tick() {
      if (dwellState && dwellState.lastTickAt != null && dwellState.isActive) {
        dwellState.activeMs += Date.now() - dwellState.lastTickAt;
      }
      if (dwellState) dwellState.lastTickAt = Date.now();
    }
    function onVisChange() {
      tick();
      if (!dwellState) return;
      dwellState.isActive = !document.hidden && document.hasFocus();
      dwellState.lastTickAt = Date.now();
    }
    function onFocus() {
      tick();
      if (!dwellState) return;
      dwellState.isActive = !document.hidden;
      dwellState.lastTickAt = Date.now();
    }
    function onBlur() {
      tick();
      if (!dwellState) return;
      dwellState.isActive = false;
      dwellState.lastTickAt = Date.now();
    }

    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    if (dwellState.isActive) dwellState.lastTickAt = Date.now();
    // Periodic tick so accumulator advances even without focus/visibility events.
    const intervalId = setInterval(tick, 1000);

    passiveCleanups.push({ cleanup: () => {
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      clearInterval(intervalId);
    } });

    return dwellState;
  }

  // --- Shared scroll accumulator (rAF-throttled max-depth tracker) ---
  function ensureScrollState() {
    if (scrollState) return scrollState;
    scrollState = { maxPercent: 0 };

    function compute() {
      const docH = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
      );
      const winH = window.innerHeight || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const scrollable = Math.max(1, docH - winH);
      const pct = Math.min(100, Math.max(0, (scrollY / scrollable) * 100));
      if (scrollState && pct > scrollState.maxPercent) {
        scrollState.maxPercent = pct;
      }
    }

    let raf = null;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; compute(); });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    compute();

    passiveCleanups.push({ cleanup: () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    } });

    return scrollState;
  }

  // --- dwell_active --- extract: { method, minSeconds: 30 } — emit once.
  function setupDwellActive(signalDef) {
    const minSec = Math.max(1, parseInt(signalDef.extract?.minSeconds, 10) || 30);
    ensureDwellState();
    let emitted = false;
    const id = setInterval(() => {
      if (emitted || !dwellState) return;
      if (dwellState.activeMs >= minSec * 1000) {
        emitted = true;
        emitEvent(signalDef, 1, document.body);
      }
    }, 500);
    passiveCleanups.push({ cleanup: () => clearInterval(id), signalId: signalDef.id });
  }

  // --- scroll_depth --- extract: { method, minPercent: 75 } — emit once.
  function setupScrollDepth(signalDef) {
    const minPct = Math.max(1, Math.min(100, parseFloat(signalDef.extract?.minPercent) || 75));
    ensureScrollState();
    let emitted = false;
    const id = setInterval(() => {
      if (emitted || !scrollState) return;
      if (scrollState.maxPercent >= minPct) {
        emitted = true;
        emitEvent(signalDef, 1, document.body);
      }
    }, 500);
    passiveCleanups.push({ cleanup: () => clearInterval(id), signalId: signalDef.id });
  }

  // --- read_completed --- extract: { method, minPercent: 85, minSeconds: 20 }
  // Strong "actually read it" signal: BOTH scroll-depth AND dwell met.
  function setupReadCompleted(signalDef) {
    const minPct = Math.max(1, Math.min(100, parseFloat(signalDef.extract?.minPercent) || 85));
    const minSec = Math.max(1, parseInt(signalDef.extract?.minSeconds, 10) || 20);
    ensureDwellState();
    ensureScrollState();
    let emitted = false;
    const id = setInterval(() => {
      if (emitted || !dwellState || !scrollState) return;
      if (scrollState.maxPercent >= minPct && dwellState.activeMs >= minSec * 1000) {
        emitted = true;
        emitEvent(signalDef, 1, document.body);
      }
    }, 500);
    passiveCleanups.push({ cleanup: () => clearInterval(id), signalId: signalDef.id });
  }

  // --- media_play --- extract: { method, css?: 'video' } — emit per play.
  function setupMediaPlay(signalDef) {
    const sel = signalDef.selector?.css || signalDef.extract?.css || 'video,audio';
    const handler = (event) => {
      const t = event.target;
      if (t && typeof t.matches === 'function' && t.matches(sel)) {
        emitEvent(signalDef, 1, t);
      }
    };
    document.addEventListener('play', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('play', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- media_progress --- extract: { method, minPercent: 50 } — once per element.
  function setupMediaProgress(signalDef) {
    const sel = signalDef.selector?.css || signalDef.extract?.css || 'video,audio';
    const minPct = Math.max(1, Math.min(100, parseFloat(signalDef.extract?.minPercent) || 50));
    const tracked = new WeakSet();
    const handler = (event) => {
      const el = event.target;
      if (!el || typeof el.matches !== 'function' || !el.matches(sel)) return;
      if (tracked.has(el)) return;
      const dur = el.duration;
      if (!dur || isNaN(dur) || dur <= 0) return;
      if ((el.currentTime / dur) * 100 >= minPct) {
        tracked.add(el);
        emitEvent(signalDef, 1, el);
      }
    };
    document.addEventListener('timeupdate', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('timeupdate', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- media_completed --- extract: { method } — emit per `ended` event.
  function setupMediaCompleted(signalDef) {
    const sel = signalDef.selector?.css || signalDef.extract?.css || 'video,audio';
    const handler = (event) => {
      const t = event.target;
      if (t && typeof t.matches === 'function' && t.matches(sel)) {
        emitEvent(signalDef, 1, t);
      }
    };
    document.addEventListener('ended', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('ended', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- text_selection --- extract: { method, minChars: 20 } — debounced.
  function setupTextSelection(signalDef) {
    const minChars = Math.max(1, parseInt(signalDef.extract?.minChars, 10) || 20);
    let armedForSelection = true;
    let debounceTimer = null;
    const handler = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          armedForSelection = true; // re-arm when user clears selection
          return;
        }
        if (!armedForSelection) return;
        const text = sel.toString();
        if (text.length >= minChars) {
          armedForSelection = false;
          const anchor = sel.anchorNode;
          const originEl = (anchor && anchor.nodeType === 1)
            ? anchor
            : (anchor && anchor.parentElement) || document.body;
          emitEvent(signalDef, 1, originEl);
        }
      }, 300);
    };
    document.addEventListener('selectionchange', handler);
    passiveCleanups.push({
      cleanup: () => {
        document.removeEventListener('selectionchange', handler);
        if (debounceTimer) clearTimeout(debounceTimer);
      },
      signalId: signalDef.id,
    });
  }

  // --- copy --- extract: { method } — emit per copy.
  function setupCopy(signalDef) {
    const handler = (event) => {
      const sel = window.getSelection();
      const anchor = sel ? sel.anchorNode : null;
      const originEl = (anchor && anchor.nodeType === 1)
        ? anchor
        : (anchor && anchor.parentElement) || event.target || document.body;
      emitEvent(signalDef, 1, originEl);
    };
    document.addEventListener('copy', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('copy', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- submit_observed --- selector pinpoints which form(s) to track.
  function setupSubmitObserved(signalDef) {
    const sel = signalDef.selector?.css || 'form';
    const handler = (event) => {
      const f = event.target;
      if (f && typeof f.matches === 'function' && f.matches(sel)) {
        emitEvent(signalDef, 1, f);
      }
    };
    document.addEventListener('submit', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('submit', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- keypress_in --- extract: { method, minKeys: 5 } — typing-intent.
  function setupKeypressIn(signalDef) {
    const sel = signalDef.selector?.css || 'input,textarea,[contenteditable="true"]';
    const minKeys = Math.max(1, parseInt(signalDef.extract?.minKeys, 10) || 5);
    const counts = new WeakMap();
    const handler = (event) => {
      const target = event.target;
      if (!target || typeof target.matches !== 'function' || !target.matches(sel)) return;
      const cur = (counts.get(target) || 0) + 1;
      counts.set(target, cur);
      if (cur === minKeys) {
        emitEvent(signalDef, 1, target);
      }
    };
    document.addEventListener('keydown', handler, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('keydown', handler, true),
      signalId: signalDef.id,
    });
  }

  // --- print --- emit per beforeprint.
  function setupPrint(signalDef) {
    const handler = () => emitEvent(signalDef, 1, document.body);
    window.addEventListener('beforeprint', handler);
    passiveCleanups.push({
      cleanup: () => window.removeEventListener('beforeprint', handler),
      signalId: signalDef.id,
    });
  }

  // --- link_hover --- extract: { method, minMs: 800 } — once per link.
  function setupLinkHover(signalDef) {
    const sel = signalDef.selector?.css || 'a';
    const minMs = Math.max(50, parseInt(signalDef.extract?.minMs, 10) || 800);
    const fired = new WeakSet();
    const onEnter = (event) => {
      const target = event.target.closest && event.target.closest(sel);
      if (!target || fired.has(target)) return;
      const timer = setTimeout(() => {
        if (!fired.has(target)) {
          fired.add(target);
          emitEvent(signalDef, 1, target);
        }
      }, minMs);
      const onLeave = () => {
        clearTimeout(timer);
        target.removeEventListener('pointerleave', onLeave);
      };
      target.addEventListener('pointerleave', onLeave);
    };
    document.addEventListener('pointerenter', onEnter, true);
    passiveCleanups.push({
      cleanup: () => document.removeEventListener('pointerenter', onEnter, true),
      signalId: signalDef.id,
    });
  }

  function cleanupObservers() {
    for (const obs of observers) {
      obs.disconnect();
    }
    observers = [];

    for (const [, state] of clickListeners) {
      if (state._handler) {
        document.removeEventListener('click', state._handler, true);
      }
    }
    clickListeners.clear();

    // Tear down all passive signal listeners (dwell, scroll, media,
    // selection, copy, ...). Each registered a cleanup function.
    for (const entry of passiveCleanups) {
      try { entry.cleanup(); } catch (e) { /* swallow — best effort */ }
    }
    passiveCleanups = [];
    dwellState = null;
    scrollState = null;
  }

  // ===== COMMUNICATION =====

  // Listen for expression from background
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DSL_LOAD_EXPRESSION') {
      expression = msg.expression;
      previousValues = {};
      httpRequested = new Set();
      evaluateAll();
      setupObservers();

      // Re-evaluate after a short delay for dynamically loaded content
      setTimeout(evaluateAll, 1000);
      setTimeout(evaluateAll, 3000);
    }

    if (msg.type === 'DSL_HTTP_RESPONSE') {
      if (msg.skipped) return;
      if (msg.signalId && msg.value !== undefined) {
        // Treat the HTTP response as a one-shot event (numeric or boolean).
        const signalDef = expression?.signals?.find(s => s.id === msg.signalId);
        if (!signalDef) return;
        const prev = previousValues[msg.signalId];
        const triggerCount = detectTrigger(signalDef, prev, msg.value);
        if (triggerCount > 0) {
          emitEvent(signalDef, triggerCount, null);
        }
        previousValues[msg.signalId] = msg.value;
      }
    }

    if (msg.type === 'DSL_REQUEST_FLUSH') {
      // Final evaluation pass before tab-close aggregation runs in the background.
      evaluateAll();
    }

    if (msg.type === 'DSL_CLEANUP') {
      cleanupObservers();
      expression = null;
      previousValues = {};
      httpRequested = new Set();
    }
  });

})();
