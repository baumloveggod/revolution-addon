/**
 * Revolution Addon - Erweiterbares Webseiten-Bewertungssystem
 *
 * Dieses Modul trackt verschiedene Metriken von Webseiten-Besuchen:
 * - Aktive Zeit (Tab ist fokussiert)
 * - Passive Zeit (Tab ist offen, aber nicht fokussiert)
 * - Erweiterbar für weitere Metriken (Scroll-Tiefe, Interaktionen, etc.)
 */

const TRACKING_STORAGE_KEY = 'rev_tracking_data';
const TRACKING_SESSION_KEY = 'rev_tracking_sessions';

/**
 * Basis-Klasse für Metriken
 * Kann erweitert werden für neue Metrik-Typen
 */
class MetricCollector {
  constructor(name) {
    this.name = name;
    this.value = 0;
  }

  /**
   * Startet die Erfassung
   */
  start() {
    // Wird von Unterklassen implementiert
  }

  /**
   * Pausiert die Erfassung
   */
  pause() {
    // Wird von Unterklassen implementiert
  }

  /**
   * Stoppt die Erfassung und gibt den finalen Wert zurück
   */
  stop() {
    this.pause();
    return this.getValue();
  }

  /**
   * Gibt den aktuellen Wert zurück
   */
  getValue() {
    return this.value;
  }

  /**
   * Serialisiert die Metrik für Storage
   */
  serialize() {
    return {
      name: this.name,
      value: this.value
    };
  }
}

/**
 * Zeit-Metrik für aktive und passive Zeit
 */
class TimeMetric extends MetricCollector {
  constructor(name, type = 'active') {
    super(name);
    this.type = type; // 'active' oder 'passive'
    this.startTime = null;
    this.isRunning = false;
  }

  start() {
    if (!this.isRunning) {
      this.startTime = Date.now();
      this.isRunning = true;
    }
  }

  pause() {
    if (this.isRunning && this.startTime) {
      const elapsed = Date.now() - this.startTime;
      this.value += elapsed;
      this.isRunning = false;
      this.startTime = null;
    }
  }

  getValue() {
    let currentValue = this.value;
    if (this.isRunning && this.startTime) {
      currentValue += Date.now() - this.startTime;
    }
    return Math.floor(currentValue); // in Millisekunden
  }

  getValueInSeconds() {
    return Math.floor(this.getValue() / 1000);
  }

  serialize() {
    return {
      ...super.serialize(),
      type: this.type,
      valueSeconds: this.getValueInSeconds()
    };
  }
}

/**
 * Zähler-Metrik für Events (erweiterbar)
 * Beispiele: Klicks, Scrolls, Interaktionen
 */
class CounterMetric extends MetricCollector {
  constructor(name) {
    super(name);
  }

  increment(amount = 1) {
    this.value += amount;
  }

  serialize() {
    return {
      ...super.serialize(),
      type: 'counter'
    };
  }
}

/**
 * Verwaltet eine einzelne Seiten-Besuch-Session
 */
class PageVisitSession {
  constructor(url, tabId, windowId) {
    this.url = url;
    this.tabId = tabId;
    this.windowId = windowId;
    this.sessionId = this.generateSessionId();
    this.startTime = new Date().toISOString();
    this.endTime = null;
    this.isActive = false;

    // Standard-Metriken
    this.metrics = {
      activeTime: new TimeMetric('activeTime', 'active'),
      passiveTime: new TimeMetric('passiveTime', 'passive')
    };

    // Container für zukünftige Metriken
    this.customMetrics = {};
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Fügt eine benutzerdefinierte Metrik hinzu (für Erweiterbarkeit)
   */
  addMetric(name, metric) {
    if (metric instanceof MetricCollector) {
      this.customMetrics[name] = metric;
    }
  }

  /**
   * Tab wird aktiv
   */
  activate() {
    if (!this.isActive) {
      this.isActive = true;
      this.metrics.passiveTime.pause();
      this.metrics.activeTime.start();

      // Starte alle custom metrics die bei Aktivierung laufen sollen
      Object.values(this.customMetrics).forEach(metric => {
        if (metric.onActivate) metric.onActivate();
      });
    }
  }

  /**
   * Tab wird inaktiv (aber bleibt offen)
   */
  deactivate() {
    if (this.isActive) {
      this.isActive = false;
      this.metrics.activeTime.pause();
      this.metrics.passiveTime.start();

      // Pausiere alle custom metrics die bei Deaktivierung pausieren sollen
      Object.values(this.customMetrics).forEach(metric => {
        if (metric.onDeactivate) metric.onDeactivate();
      });
    }
  }

  /**
   * Beendet die Session und gibt Zusammenfassung zurück
   */
  end() {
    this.endTime = new Date().toISOString();

    // Stoppe alle Metriken
    this.metrics.activeTime.stop();
    this.metrics.passiveTime.stop();

    Object.values(this.customMetrics).forEach(metric => {
      metric.stop();
    });

    return this.getSummary();
  }

  /**
   * Gibt eine Zusammenfassung der Session zurück
   */
  getSummary() {
    const summary = {
      sessionId: this.sessionId,
      url: this.url,
      tabId: this.tabId,
      windowId: this.windowId,
      startTime: this.startTime,
      endTime: this.endTime,
      metrics: {
        activeTime: this.metrics.activeTime.serialize(),
        passiveTime: this.metrics.passiveTime.serialize()
      },
      customMetrics: {}
    };

    // Füge custom metrics hinzu
    Object.entries(this.customMetrics).forEach(([name, metric]) => {
      summary.customMetrics[name] = metric.serialize();
    });

    // Berechne Gesamtwert
    summary.totalTimeSeconds =
      this.metrics.activeTime.getValueInSeconds() +
      this.metrics.passiveTime.getValueInSeconds();

    return summary;
  }

  /**
   * Serialisiert die Session für Storage
   */
  serialize() {
    return this.getSummary();
  }
}

/**
 * Haupt-Tracker für alle Seiten-Besuche
 */
class PageVisitTracker {
  constructor() {
    this.activeSessions = new Map(); // tabId -> PageVisitSession
    this.completedSessions = [];
    this.activeTabId = null;
    this.initialized = false;
  }

  /**
   * Initialisiert den Tracker
   */
  async initialize() {
    if (this.initialized) return;

    // Lade gespeicherte Sessions
    await this.loadSessions();

    // Setup Event Listeners
    this.setupEventListeners();

    this.initialized = true;
    console.log('[tracking] Tracker initialisiert');
  }

  /**
   * Setup der Browser-Event-Listeners
   */
  setupEventListeners() {
    // PERFORMANCE FIX: All event handlers must not block the main thread
    // Use setTimeout to defer execution immediately

    // Tab wird aktiviert
    browser.tabs.onActivated.addListener((activeInfo) => {
      setTimeout(() => {
        this.handleTabActivated(activeInfo.tabId, activeInfo.windowId).catch(err => {
          console.error('[tracking] handleTabActivated failed:', err);
        });
      }, 0);
    });

    // Tab wird geschlossen
    browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
      setTimeout(() => {
        this.handleTabClosed(tabId);
      }, 0);
    });

    // Tab URL ändert sich (Navigation)
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url) {
        // CRITICAL: Defer immediately to avoid blocking page navigation
        setTimeout(() => {
          this.handleTabUrlChanged(tabId, changeInfo.url, tab);
        }, 0);
      }
    });

    // Window-Fokus ändert sich
    if (browser.windows && browser.windows.onFocusChanged) {
      browser.windows.onFocusChanged.addListener((windowId) => {
        if (windowId === browser.windows.WINDOW_ID_NONE) {
          setTimeout(() => {
            this.deactivateCurrentSession();
          }, 0);
        }
      });
    }

    // Regelmäßiges Speichern alle 30 Sekunden
    setInterval(() => {
      this.saveSessions().catch(err => {
        console.error('[tracking] Periodic save failed:', err);
      });
    }, 30000);

    console.log('[tracking] Event Listeners registriert');
  }

  /**
   * Startet eine neue Session für einen Tab
   */
  startSession(tabId, url, windowId) {
    // Beende existierende Session für diesen Tab falls vorhanden
    if (this.activeSessions.has(tabId)) {
      // PERFORMANCE FIX: Don't wait for session to end, run async
      this.endSession(tabId).catch(err => {
        console.error('[tracking] Failed to end existing session:', err);
      });
    }

    const session = new PageVisitSession(url, tabId, windowId);
    this.activeSessions.set(tabId, session);

    console.log('[tracking] Neue Session gestartet:', {
      tabId,
      url: url.substring(0, 50),
      sessionId: session.sessionId
    });

    return session;
  }

  /**
   * Beendet eine Session und speichert die Daten
   */
  async endSession(tabId) {
    const session = this.activeSessions.get(tabId);
    if (!session) return null;

    const summary = session.end();
    this.completedSessions.push(summary);
    this.activeSessions.delete(tabId);

    console.log('[tracking] Session beendet:', {
      sessionId: summary.sessionId,
      activeTime: summary.metrics.activeTime.valueSeconds,
      passiveTime: summary.metrics.passiveTime.valueSeconds,
      totalTime: summary.totalTimeSeconds
    });

    // PERFORMANCE FIX: Save sessions asynchronously without blocking
    // This allows the function to return immediately
    this.saveSessions().catch(err => {
      console.error('[tracking] Failed to save sessions:', err);
    });

    // PERFORMANCE FIX: Run callback asynchronously to avoid blocking main thread
    // Callback triggers heavy operations (scoring, blockchain calls, etc.)
    if (this.onSessionCompleted) {
      // Use setTimeout to defer execution and unblock the main thread
      setTimeout(() => {
        try {
          const result = this.onSessionCompleted(summary);
          // Handle Promise if returned, otherwise ignore
          if (result && typeof result.catch === 'function') {
            result.catch(err => {
              console.error('[tracking] Session completion callback failed:', err);
            });
          }
        } catch (err) {
          console.error('[tracking] Session completion callback threw:', err);
        }
      }, 0);
    }

    return summary;
  }

  /**
   * Tab wurde aktiviert
   */
  async handleTabActivated(tabId, windowId) {
    // Deaktiviere vorherige aktive Session
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prevSession = this.activeSessions.get(this.activeTabId);
      if (prevSession) {
        prevSession.deactivate();
      }
    }

    this.activeTabId = tabId;

    // Aktiviere neue Session oder erstelle sie
    let session = this.activeSessions.get(tabId);
    if (!session) {
      // Hole Tab-Info und erstelle Session
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.url && !tab.url.startsWith('about:')) {
          session = this.startSession(tabId, tab.url, windowId);
        }
      } catch (error) {
        console.warn('[tracking] Fehler beim Abrufen der Tab-Info:', error);
        return;
      }
    }

    if (session) {
      session.activate();
      console.log('[tracking] Session aktiviert:', tabId);
    }
  }

  /**
   * Tab wurde geschlossen
   */
  handleTabClosed(tabId) {
    console.log('[tracking] Tab geschlossen:', tabId);

    // PERFORMANCE FIX: Don't wait for session to end, run async
    this.endSession(tabId).catch(err => {
      console.error('[tracking] Failed to end session on tab close:', err);
    });

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  /**
   * Tab URL hat sich geändert (Navigation)
   */
  handleTabUrlChanged(tabId, newUrl, tab) {
    // Ignoriere about: und chrome: URLs
    if (newUrl.startsWith('about:') || newUrl.startsWith('chrome:')) {
      return;
    }

    console.log('[tracking] Tab URL geändert:', { tabId, newUrl: newUrl.substring(0, 50) });

    // PERFORMANCE FIX: Don't await endSession to avoid blocking the main thread
    // The session completion callback will run asynchronously
    this.endSession(tabId).catch(err => {
      console.error('[tracking] Failed to end session:', err);
    });

    // Starte neue Session (immediately, don't wait for old session to finish)
    const session = this.startSession(tabId, newUrl, tab.windowId);

    // Aktiviere Session wenn Tab aktuell aktiv ist
    if (this.activeTabId === tabId) {
      session.activate();
    } else {
      // Ansonsten starte als passive Session
      session.metrics.passiveTime.start();
    }
  }

  /**
   * Deaktiviert die aktuell aktive Session
   */
  deactivateCurrentSession() {
    if (this.activeTabId) {
      const session = this.activeSessions.get(this.activeTabId);
      if (session) {
        session.deactivate();
      }
    }
  }

  /**
   * Lädt gespeicherte Sessions aus dem Storage
   */
  async loadSessions() {
    try {
      const stored = await browser.storage.local.get([TRACKING_SESSION_KEY]);
      if (stored[TRACKING_SESSION_KEY]) {
        this.completedSessions = stored[TRACKING_SESSION_KEY] || [];
        console.log('[tracking] Gespeicherte Sessions geladen:', this.completedSessions.length);
      }
    } catch (error) {
      console.error('[tracking] Fehler beim Laden der Sessions:', error);
    }
  }

  /**
   * Speichert Sessions im Storage
   */
  async saveSessions() {
    try {
      // Speichere nur abgeschlossene Sessions
      await browser.storage.local.set({
        [TRACKING_SESSION_KEY]: this.completedSessions
      });
      console.log('[tracking] Sessions gespeichert:', this.completedSessions.length);
    } catch (error) {
      console.error('[tracking] Fehler beim Speichern der Sessions:', error);
    }
  }

  /**
   * Gibt alle abgeschlossenen Sessions zurück
   */
  getCompletedSessions() {
    return [...this.completedSessions];
  }

  /**
   * Gibt alle aktiven Sessions zurück
   */
  getActiveSessions() {
    const sessions = [];
    this.activeSessions.forEach((session) => {
      sessions.push(session.getSummary());
    });
    return sessions;
  }

  /**
   * Löscht alle abgeschlossenen Sessions (z.B. nach Upload zum Server)
   */
  async clearCompletedSessions() {
    this.completedSessions = [];
    await this.saveSessions();
    console.log('[tracking] Abgeschlossene Sessions gelöscht');
  }

  /**
   * Beendet alle aktiven Sessions (z.B. beim Browser-Shutdown)
   */
  async endAllSessions() {
    const tabIds = Array.from(this.activeSessions.keys());
    for (const tabId of tabIds) {
      await this.endSession(tabId);
    }
  }
}

// Singleton-Instanz
const tracker = new PageVisitTracker();

// Export für background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tracker,
    PageVisitTracker,
    PageVisitSession,
    MetricCollector,
    TimeMetric,
    CounterMetric
  };
}
