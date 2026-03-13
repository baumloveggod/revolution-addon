/**
 * Revolution Satisfaction Metrics Collector
 *
 * Sammelt Verhaltensindikatoren für Nutzerzufriedenheit:
 * - Leseverhalten (Scroll-Muster, Tiefe, Rückscrollen)
 * - Frustration (Rage Clicks, Dead Clicks, Errors)
 * - Aufmerksamkeit (Mouse Coverage, Idle Time, Tab Switches)
 *
 * Version: 2.0.0
 */

/**
 * Leseverhalten-Metrik
 * Basiert auf Information Foraging Theory (Pirolli & Card, 1999)
 */
class ReadingBehaviorMetric {
  constructor() {
    this.scrollEvents = [];
    this.lastScrollPos = 0;
    this.lastScrollTime = Date.now();
    this.direction = null;
    this.maxScrollDepth = 0;

    this.setupScrollListener();
  }

  setupScrollListener() {
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this.trackScroll(window.scrollY, Date.now());
      }, 100); // Debounced 100ms
    }, { passive: true });
  }

  trackScroll(position, timestamp) {
    const direction = position > this.lastScrollPos ? 'down' : 'up';
    const delta = Math.abs(position - this.lastScrollPos);
    const timeDelta = timestamp - this.lastScrollTime;
    const velocity = timeDelta > 0 ? delta / timeDelta : 0; // pixels per ms

    this.scrollEvents.push({
      position,
      direction,
      velocity,
      timestamp,
      delta
    });

    // Track max depth
    const documentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const viewportHeight = window.innerHeight;
    const scrollDepth = (position + viewportHeight) / documentHeight;
    this.maxScrollDepth = Math.max(this.maxScrollDepth, scrollDepth);

    this.lastScrollPos = position;
    this.lastScrollTime = timestamp;
    this.direction = direction;
  }

  calculateMetrics() {
    if (this.scrollEvents.length === 0) {
      return {
        smoothScrollRatio: 0,
        backtrackCount: 0,
        maxDepth: 0,
        avgScrollVelocity: 0
      };
    }

    // 1. Smooth Scrolling Ratio (reading vs. scanning)
    // Smooth = velocity < 500 pixels/ms
    const smoothScrolls = this.scrollEvents.filter(e => e.velocity < 500).length;
    const smoothScrollRatio = smoothScrolls / this.scrollEvents.length;

    // 2. Backtrack Count (re-reading sections)
    let backtrackCount = 0;
    for (let i = 1; i < this.scrollEvents.length; i++) {
      if (this.scrollEvents[i].direction !== this.scrollEvents[i - 1].direction) {
        backtrackCount++;
      }
    }

    // 3. Max Depth (content exploration)
    const maxDepth = this.maxScrollDepth;

    // 4. Average Scroll Velocity
    const totalVelocity = this.scrollEvents.reduce((sum, e) => sum + e.velocity, 0);
    const avgScrollVelocity = totalVelocity / this.scrollEvents.length;

    return {
      smoothScrollRatio,
      backtrackCount,
      maxDepth,
      avgScrollVelocity
    };
  }

  serialize() {
    return {
      type: 'readingBehavior',
      ...this.calculateMetrics()
    };
  }
}

/**
 * Frustrations-Metrik
 * Basiert auf UX Frustration Research (Ceaparu et al., 2004)
 */
class FrustrationMetric {
  constructor() {
    this.rageClicks = 0;
    this.deadClicks = 0;
    this.errorEncounters = 0;
    this.tabThrashing = 0;

    this.clickHistory = new Map(); // elementId -> [timestamps]

    this.setupListeners();
  }

  setupListeners() {
    // Click tracking
    document.addEventListener('click', (e) => {
      this.trackClick(e.target, Date.now());
    }, true);

    // Error tracking
    window.addEventListener('error', () => {
      this.errorEncounters++;
    }, true);

    // Visibility change for tab thrashing
    let lastVisibilityChange = Date.now();
    document.addEventListener('visibilitychange', () => {
      const now = Date.now();
      if (!document.hidden) {
        // Tab became visible again
        const timeSinceHidden = now - lastVisibilityChange;
        if (timeSinceHidden < 5000) { // Switched back within 5 seconds
          this.tabThrashing++;
        }
      }
      lastVisibilityChange = now;
    });
  }

  trackClick(element, timestamp) {
    const elementId = this.getElementId(element);

    // Track click history
    if (!this.clickHistory.has(elementId)) {
      this.clickHistory.set(elementId, []);
    }
    this.clickHistory.get(elementId).push(timestamp);

    // Detect rage click: 3+ clicks within 1 second
    const recentClicks = this.clickHistory.get(elementId).filter(
      t => timestamp - t < 1000
    );
    if (recentClicks.length >= 3) {
      this.rageClicks++;
      console.warn('[Revolution] Rage click detected on', element);
    }

    // Detect dead click: click on non-interactive element
    if (this.isDeadClick(element)) {
      this.deadClicks++;
    }
  }

  isDeadClick(element) {
    // Check if element is interactive
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
    const isInteractive =
      interactiveTags.includes(element.tagName) ||
      element.onclick ||
      element.getAttribute('onclick') ||
      element.getAttribute('role') === 'button' ||
      element.classList.contains('clickable') ||
      element.style.cursor === 'pointer';

    return !isInteractive;
  }

  getElementId(element) {
    // Create stable identifier for element
    if (element.id) return element.id;
    if (element.className) return element.className;

    // Fallback: tag + index in parent
    const parent = element.parentNode;
    if (parent) {
      const index = Array.from(parent.children).indexOf(element);
      return `${element.tagName}-${index}`;
    }

    return element.tagName;
  }

  getFrustrationScore() {
    // Weighted sum of frustration signals
    return (this.rageClicks * 10) +
           (this.deadClicks * 5) +
           (this.errorEncounters * 15) +
           (this.tabThrashing * 3);
  }

  serialize() {
    return {
      type: 'frustration',
      rageClicks: this.rageClicks,
      deadClicks: this.deadClicks,
      errorEncounters: this.errorEncounters,
      tabThrashing: this.tabThrashing,
      frustrationScore: this.getFrustrationScore()
    };
  }
}

/**
 * Aufmerksamkeits-Qualität Metrik
 * Basiert auf Flow Theory (Csikszentmihalyi) und Attention Residue (Leroy, 2009)
 */
class AttentionQualityMetric {
  constructor() {
    this.mouseMovements = [];
    this.mouseGrid = new Set(); // Grid cells covered
    this.lastMouseTime = Date.now();
    this.idleTime = 0;
    this.tabSwitches = 0;
    this.startTime = Date.now();
    this.visibleTime = 0;
    this.hiddenTime = 0;
    this.lastVisibilityChange = Date.now();
    this.isVisible = !document.hidden;

    this.setupListeners();
  }

  setupListeners() {
    // Mouse movement tracking (sampled every 500ms)
    let lastSample = 0;
    document.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (now - lastSample > 500) {
        this.trackMouseMovement(e.clientX, e.clientY, now);
        lastSample = now;
      }
    }, { passive: true });

    // Visibility change tracking
    document.addEventListener('visibilitychange', () => {
      this.trackVisibilityChange();
    });

    // Track idle time
    setInterval(() => {
      this.checkIdleTime();
    }, 5000); // Check every 5 seconds
  }

  trackMouseMovement(x, y, timestamp) {
    this.mouseMovements.push({ x, y, timestamp });

    // Map to 100x100 grid
    const gridX = Math.floor((x / window.innerWidth) * 100);
    const gridY = Math.floor((y / window.innerHeight) * 100);
    this.mouseGrid.add(`${gridX},${gridY}`);

    this.lastMouseTime = timestamp;
  }

  trackVisibilityChange() {
    const now = Date.now();
    const duration = now - this.lastVisibilityChange;

    if (this.isVisible) {
      this.visibleTime += duration;
    } else {
      this.hiddenTime += duration;
      this.tabSwitches++;
    }

    this.isVisible = !document.hidden;
    this.lastVisibilityChange = now;
  }

  checkIdleTime() {
    const now = Date.now();
    const timeSinceLastMove = now - this.lastMouseTime;

    if (timeSinceLastMove > 30000) { // > 30 seconds idle
      this.idleTime += 5000; // Add 5 seconds to idle time
    }
  }

  calculateMetrics() {
    // Finalize visibility tracking
    const now = Date.now();
    if (this.isVisible) {
      this.visibleTime += (now - this.lastVisibilityChange);
    } else {
      this.hiddenTime += (now - this.lastVisibilityChange);
    }

    const totalTime = this.visibleTime + this.hiddenTime;

    // 1. Active Percentage
    const activePercentage = totalTime > 0 ? this.visibleTime / totalTime : 0;

    // 2. Focus Percentage (penalize tab switches)
    const focusLoss = this.tabSwitches * 5000; // 5s penalty per switch
    const focusPercentage = Math.max(0, 1 - (focusLoss / totalTime));

    // 3. Mouse Engagement (grid coverage)
    const totalGridCells = 100 * 100; // 10,000 cells
    const mouseEngagement = this.mouseGrid.size / totalGridCells;

    // 4. Combined Attention Quality
    const attentionQuality =
      (activePercentage * 0.4) +
      (focusPercentage * 0.4) +
      (mouseEngagement * 0.2);

    return {
      activePercentage,
      focusPercentage,
      mouseEngagement,
      attentionQuality,
      tabSwitches: this.tabSwitches,
      idleTimeSeconds: Math.floor(this.idleTime / 1000)
    };
  }

  serialize() {
    return {
      type: 'attentionQuality',
      ...this.calculateMetrics()
    };
  }
}

/**
 * Haupt-Collector für alle Satisfaction Metrics
 */
class SatisfactionDataCollector {
  constructor() {
    this.sessionStart = Date.now();
    this.metrics = {
      reading: new ReadingBehaviorMetric(),
      frustration: new FrustrationMetric(),
      attention: new AttentionQualityMetric()
    };

    console.log('[Revolution] Satisfaction metrics collector initialized');
  }

  /**
   * Gibt vollständige Zusammenfassung aller Metriken zurück
   */
  getSummary() {
    return {
      sessionDuration: Date.now() - this.sessionStart,
      readingBehavior: this.metrics.reading.serialize(),
      frustration: this.metrics.frustration.serialize(),
      attentionQuality: this.metrics.attention.serialize(),
      timestamp: Date.now()
    };
  }
}

// Initialize collector when page loads
let satisfactionCollector = null;

function initSatisfactionCollector() {
  if (!satisfactionCollector) {
    satisfactionCollector = new SatisfactionDataCollector();
  }
  return satisfactionCollector;
}

// Auto-initialize on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSatisfactionCollector);
} else {
  initSatisfactionCollector();
}

// Export for background script communication
if (typeof window !== 'undefined') {
  window.SatisfactionDataCollector = SatisfactionDataCollector;
  window.satisfactionCollector = satisfactionCollector;
}

// Send data to background on page unload
window.addEventListener('beforeunload', () => {
  if (satisfactionCollector) {
    const summary = satisfactionCollector.getSummary();

    // Send via sendMessage (non-blocking)
    try {
      browser.runtime.sendMessage({
        type: 'SATISFACTION_DATA',
        data: summary,
        url: window.location.href,
        timestamp: Date.now()
      }).catch(err => {
        console.warn('[Revolution] Failed to send satisfaction data:', err);
      });
    } catch (error) {
      console.warn('[Revolution] Error sending satisfaction data:', error);
    }
  }
});

console.log('[Revolution] Satisfaction collector script loaded');
