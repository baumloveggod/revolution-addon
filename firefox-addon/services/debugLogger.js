/**
 * Debug Logger für Firefox Addon
 *
 * Sendet strukturierte Log-Events an den zentralen Logging-Service
 * für die Überwachung und das Debugging der Messaging-Kommunikation
 */

(function() {
  'use strict';

  const LOGGING_SERVICE_URL = 'http://192.168.178.130:4301';
  const COMPONENT_NAME = 'browser-addon';
  const LOG_QUEUE = [];
  const MAX_QUEUE_SIZE = 50;
  const FLUSH_INTERVAL = 2000; // Sende Logs alle 2 Sekunden
  const ENABLED = true; // Feature Flag

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
     * Loggt ein Info-Event
     */
    info(event, message, data = null) {
      console.log(`[DebugLogger] 🔵 [${event}]`, message, data || '');
      queueLog('info', event, message, data);
    },

    /**
     * Loggt ein Success-Event
     */
    success(event, message, data = null) {
      console.log(`[DebugLogger] ✅ [${event}]`, message, data || '');
      queueLog('success', event, message, data);
    },

    /**
     * Loggt ein Warning-Event
     */
    warning(event, message, data = null) {
      console.warn(`[DebugLogger] ⚠️ [${event}]`, message, data || '');
      queueLog('warning', event, message, data);
    },

    /**
     * Loggt ein Error-Event
     */
    error(event, message, data = null) {
      console.error(`[DebugLogger] ❌ [${event}]`, message, data || '');
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
          sicherheitsFaktor: metadata?.safetyFactor || 0,
          seedCLtoSH: metadata?.seedCLtoSH?.substring(0, 16) + '...' || 'N/A',
          seedSHtoDS: metadata?.seedSHtoDS?.substring(0, 16) + '...' || 'N/A'
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

  // Exportiere als globales Objekt
  if (typeof window !== 'undefined') {
    window.DebugLogger = DebugLogger;
  }

  // Browser Extension Context
  if (typeof self !== 'undefined' && typeof self.browser !== 'undefined') {
    self.DebugLogger = DebugLogger;
  }

  // Flush beim Beenden
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      flushQueue();
    });
  }

  console.log('[DebugLogger] Module loaded');
})();
