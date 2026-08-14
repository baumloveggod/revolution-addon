/**
 * Debug Logger für Firefox Addon
 *
 * Sendet strukturierte Log-Events an den zentralen Logging-Service
 * für die Überwachung und das Debugging der Messaging-Kommunikation
 */

(function() {
  'use strict';

  const LOGGING_SERVICE_URL = 'https://log.lenkenhoff.de';
  const COMPONENT_NAME = 'browser-addon';
  const LOG_QUEUE = [];
  const MAX_QUEUE_SIZE = 50;
  const FLUSH_INTERVAL = 2000; // Sende Logs alle 2 Sekunden
  const ENABLED = true; // Feature Flag

  // Log-Level System: 'debug' | 'info' | 'warn' | 'error'
  // In production only 'warn' and 'error' appear in console.
  // All levels are always sent to the remote logging service.
  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let CONSOLE_LOG_LEVEL = 'info'; // default, can be set via setLogLevel()

  /**
   * Check if a given level should appear in console output
   */
  function shouldLogToConsole(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[CONSOLE_LOG_LEVEL];
  }

  let flushTimer = null;
  let healthCheckInterval = null;
  let isOnline = true;

  /**
   * Prüft ob der Logging-Service verfügbar ist
   */
  async function checkServiceHealth() {
    try {
      const response = await fetch(`${LOGGING_SERVICE_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000) // 1 Sekunde Timeout
      });
      isOnline = response.ok;
      return isOnline;
    } catch (error) {
      isOnline = false;
      return false;
    }
  }

  /**
   * Sendet einen Log-Eintrag an den Logging-Service
   */
  async function sendLogEntry(entry) {
    if (!ENABLED || !isOnline) {
      return;
    }

    try {
      const response = await fetch(`${LOGGING_SERVICE_URL}/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(2000) // 2 Sekunden Timeout
      });

      if (!response.ok) {
        console.warn('[DebugLogger] Failed to send log:', response.status);
        isOnline = false;
      }
    } catch (error) {
      // Stiller Fehler - wir wollen nicht die Hauptanwendung stören
      if (error.name !== 'AbortError') {
        isOnline = false;
      }
    }
  }

  /**
   * Fügt einen Log-Eintrag zur Queue hinzu
   */
  function queueLog(level, event, message, data = null) {
    if (!ENABLED) {
      return;
    }

    const entry = {
      component: COMPONENT_NAME,
      level,
      event,
      message,
      data,
      timestamp: new Date().toISOString()
    };

    LOG_QUEUE.push(entry);

    // Limitiere Queue-Größe
    if (LOG_QUEUE.length > MAX_QUEUE_SIZE) {
      LOG_QUEUE.shift();
    }

    // Starte Flush-Timer falls nicht aktiv
    if (!flushTimer) {
      flushTimer = setTimeout(flushQueue, FLUSH_INTERVAL);
    }
  }

  /**
   * Sendet alle gepufferten Logs
   */
  async function flushQueue() {
    clearTimeout(flushTimer);
    flushTimer = null;

    if (LOG_QUEUE.length === 0) {
      return;
    }

    // Kopiere Queue und leere Original
    const logsToSend = [...LOG_QUEUE];
    LOG_QUEUE.length = 0;

    // Sende alle Logs (nicht-blockierend)
    for (const entry of logsToSend) {
      sendLogEntry(entry); // Kein await - fire and forget
    }
  }

  /**
   * Öffentliche API
   */
  const DebugLogger = {
    /**
     * Initialisiert den Logger und prüft Service-Verfügbarkeit
     */
    async init() {
      if (!ENABLED) {
        console.log('[DebugLogger] Disabled via feature flag');
        return;
      }

      const healthy = await checkServiceHealth();

      if (healthy) {
        console.log('[DebugLogger] Connected to logging service at', LOGGING_SERVICE_URL);
        this.info('logger_init', 'Debug Logger initialized');
      } else {
        console.warn('[DebugLogger] Logging service not available at', LOGGING_SERVICE_URL);
        console.warn('[DebugLogger] Start service with: node logging-service/server.js');
      }

      // Periodisch Health-Check durchführen (alle 30 Sekunden)
      if (!healthCheckInterval) {
        healthCheckInterval = setInterval(() => {
          checkServiceHealth();
        }, 30000);
      }
    },

    /**
     * Cleanup - stops all timers to prevent memory leaks
     */
    destroy() {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        console.log('[DebugLogger] Health check interval stopped');
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Flush remaining logs before shutdown
      flushQueue();
    },

    /**
     * Sets the minimum console log level.
     * Logs below this level are still sent to the remote service but hidden from console.
     * @param {'debug'|'info'|'warn'|'error'} level
     */
    setLogLevel(level) {
      if (LOG_LEVELS[level] !== undefined) {
        CONSOLE_LOG_LEVEL = level;
      }
    },

    /**
     * Returns the current console log level
     */
    getLogLevel() {
      return CONSOLE_LOG_LEVEL;
    },

    /**
     * Loggt ein Debug-Event (nur in Console bei debug-Level)
     */
    debug(event, message, data = null) {
      if (shouldLogToConsole('debug')) {
        console.log(`[DebugLogger] [${event}]`, message, data || '');
      }
      queueLog('debug', event, message, data);
    },

    /**
     * Loggt ein Info-Event
     */
    info(event, message, data = null) {
      if (shouldLogToConsole('info')) {
        console.log(`[DebugLogger] 🔵 [${event}]`, message, data || '');
      }
      queueLog('info', event, message, data);
    },

    /**
     * Loggt ein Success-Event
     */
    success(event, message, data = null) {
      if (shouldLogToConsole('info')) {
        console.log(`[DebugLogger] ✅ [${event}]`, message, data || '');
      }
      queueLog('success', event, message, data);
    },

    /**
     * Loggt ein Warning-Event
     */
    warning(event, message, data = null) {
      if (shouldLogToConsole('warn')) {
        console.warn(`[DebugLogger] ⚠️ [${event}]`, message, data || '');
      }
      queueLog('warning', event, message, data);
    },

    /**
     * Loggt ein Error-Event
     */
    error(event, message, data = null) {
      if (shouldLogToConsole('error')) {
        console.error(`[DebugLogger] ❌ [${event}]`, message, data || '');
      }
      queueLog('error', event, message, data);
    },

    /**
     * Session-spezifische Logs
     */
    session: {
      started(sessionId, url, tabId) {
        DebugLogger.info('session_started', 'Session started', {
          sessionId: sessionId?.substring(0, 8),
          url: url?.substring(0, 60),
          tabId
        });
      },

      ended(sessionId, summary) {
        DebugLogger.info('session_ended', 'Session ended', {
          sessionId: sessionId?.substring(0, 8),
          url: summary.url?.substring(0, 60),
          activeTimeSeconds: summary.metrics?.activeTime?.valueSeconds,
          totalTimeSeconds: summary.totalTimeSeconds
        });
      },

      processing(sessionId, domain) {
        DebugLogger.info('session_processing', 'Processing session through RevolutionScoring', {
          sessionId: sessionId?.substring(0, 8),
          domain
        });
      },

      scored(sessionId, score, metadata) {
        DebugLogger.success('session_scored', 'Session scored successfully', {
          sessionId: sessionId?.substring(0, 8),
          Rating: score,
          sicherheitsFaktor: metadata?.safetyFactor || 0
        });
      },

      failed(sessionId, error) {
        DebugLogger.error('session_failed', 'Session processing failed', {
          sessionId: sessionId?.substring(0, 8),
          error: error?.message || String(error)
        });
      }
    },

    /**
     * Messaging-spezifische Logs
     */
    messaging: {
      init(fingerprint, groupId) {
        DebugLogger.info('messaging_init', 'Messaging client initialized', {
          fingerprint: fingerprint?.substring(0, 16) + '...',
          groupId
        });
      },

      messageSent(messageId, type, recipientCount) {
        DebugLogger.success('message_sent', 'Message sent to group', {
          messageId: messageId?.substring(0, 8),
          type,
          recipientCount
        });
      },

      messageReceived(messageId, type, sender) {
        DebugLogger.info('message_received', 'Message received from group', {
          messageId: messageId?.substring(0, 8),
          type,
          sender: sender?.substring(0, 16) + '...'
        });
      },

      keyUpdate(action, keyCount, reason) {
        DebugLogger.info('key_update', 'Group keys updated', {
          action,
          keyCount,
          reason
        });
      },

      error(event, error) {
        DebugLogger.error('messaging_error', `Messaging error: ${event}`, {
          error: error?.message || String(error)
        });
      }
    },

    /**
     * Tracking-spezifische Logs
     */
    tracking: {
      tabActivated(tabId, url) {
        DebugLogger.info('tab_activated', 'Tab activated', {
          tabId,
          url: url?.substring(0, 60)
        });
      },

      tabClosed(tabId) {
        DebugLogger.info('tab_closed', 'Tab closed (session ending)', {
          tabId
        });
      },

      tabUrlChanged(tabId, newUrl) {
        DebugLogger.info('tab_url_changed', 'Tab URL changed (new session)', {
          tabId,
          newUrl: newUrl?.substring(0, 60)
        });
      }
    },

    /**
     * Manuelles Flushen der Queue
     */
    async flush() {
      await flushQueue();
    },

    /**
     * Prüft ob der Service online ist
     */
    isServiceOnline() {
      return isOnline;
    }
  };

  /**
   * RevLog — lightweight console wrapper respecting the global log level.
   * Usage: RevLog.debug('[Component]', 'message', data);
   *        RevLog.info(...)  RevLog.warn(...)  RevLog.error(...)
   */
  const RevLog = {
    debug(...args) { if (shouldLogToConsole('debug')) console.log(...args); },
    info(...args)  { if (shouldLogToConsole('info'))  console.log(...args); },
    warn(...args)  { if (shouldLogToConsole('warn'))  console.warn(...args); },
    error(...args) { if (shouldLogToConsole('error')) console.error(...args); }
  };

  // Exportiere als globales Objekt
  if (typeof window !== 'undefined') {
    window.DebugLogger = DebugLogger;
    window.RevLog = RevLog;
  }

  // Browser Extension Context
  if (typeof self !== 'undefined' && typeof self.browser !== 'undefined') {
    self.DebugLogger = DebugLogger;
    self.RevLog = RevLog;
  }

  // Flush beim Beenden
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      flushQueue();
    });
  }

  // Module loaded log only in debug mode
  if (shouldLogToConsole('debug')) {
    console.log('[DebugLogger] Module loaded');
  }
})();
