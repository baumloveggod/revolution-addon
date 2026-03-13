/**
 * Client library for sending logs to the logging service
 * Can be used from Node.js (server-api, messaging-service) or browser (addon, website)
 */

const LOGGING_SERVICE_URL = typeof process !== 'undefined' && process.env
  ? (process.env.LOGGING_SERVICE_URL || 'http://192.168.178.130:4301')
  : 'http://192.168.178.130:4301';

/**
 * Send a log to the logging service
 * @param {string} component - Component name ('browser-addon', 'website', 'server-api', 'messaging-service')
 * @param {string} event - Event name (e.g. 'key_generated', 'registration_attempt')
 * @param {string} message - Log message
 * @param {object} data - Additional data (optional)
 * @param {string} level - Log level ('info', 'warning', 'error', 'success')
 */
async function sendLog(component, event, message, data = null, level = 'info') {
  try {
    const logEntry = {
      component,
      event,
      message,
      data,
      level,
      timestamp: new Date().toISOString()
    };

    // Try to send to logging service (non-blocking, fire-and-forget)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout

    fetch(`${LOGGING_SERVICE_URL}/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(logEntry),
      signal: controller.signal
    }).then(() => {
      clearTimeout(timeoutId);
    }).catch(err => {
      // Silently fail - logging should never break the application
      if (err.name !== 'AbortError') {
        console.warn('[LogClient] Failed to send log:', err.message);
      }
    });
  } catch (error) {
    // Silently fail - logging should never break the application
    console.warn('[LogClient] Error in sendLog:', error.message);
  }
}

/**
 * Create a logger for a specific component
 */
function createLogger(component) {
  return {
    info: (event, message, data) => sendLog(component, event, message, data, 'info'),
    warning: (event, message, data) => sendLog(component, event, message, data, 'warning'),
    error: (event, message, data) => sendLog(component, event, message, data, 'error'),
    success: (event, message, data) => sendLog(component, event, message, data, 'success')
  };
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sendLog,
    createLogger,
    LOGGING_SERVICE_URL
  };
}

// Export for browser (global window object)
if (typeof window !== 'undefined') {
  window.LogClient = {
    sendLog,
    createLogger,
    LOGGING_SERVICE_URL
  };
}
