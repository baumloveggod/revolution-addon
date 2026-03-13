(() => {
  const TOKEN_KEY = 'rev_token';
  let lastToken = null;
  let syncInterval = null; // Track interval to prevent leaks

  function readToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch (error) {
      return null;
    }
  }

  // PERFORMANCE FIX: Fire-and-forget - DO NOT await sendMessage
  // Awaiting causes content script to block waiting for background response
  function syncTokenIfChanged() {
    const token = readToken();
    if (token === lastToken) {
      return;
    }
    lastToken = token;
    // Fire and forget - don't wait for response
    browser.runtime.sendMessage({
      type: 'PAGE_TOKEN',
      token: token || null,
      url: window.location.href
    }).catch(() => {}); // Silent fail
  }

  function forceSyncToken() {
    const token = readToken();
    lastToken = token;
    // Fire and forget - don't wait for response
    browser.runtime.sendMessage({
      type: 'PAGE_TOKEN',
      token: token || null,
      url: window.location.href
    }).catch(() => {}); // Silent fail
  }

  // Message-Listener für aktive Token-Anfragen und localStorage-Operationen
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if registration handler is ready
    if (message && message.type === 'CHECK_REGISTRATION_HANDLER_READY') {
      const ready = document.body.getAttribute('data-device-handler-ready') === 'true';
      console.log('[contentScript] Registration handler ready check:', ready);
      sendResponse({ ready });
      return false;
    }

    // Device registration: Forward to website via postMessage
    if (message && message.type === 'DEVICE_REGISTRATION_REQUEST') {
      console.log('[contentScript] 📥 Received DEVICE_REGISTRATION_REQUEST from addon');
      console.log('[contentScript] 📤 Forwarding to website via postMessage...');
      window.postMessage(message, window.location.origin);
      console.log('[contentScript] ✅ Request forwarded to website');
      sendResponse({ ok: true });
      return false;
    }

    // Existing REQUEST_TOKEN handler
    if (message && message.type === 'REQUEST_TOKEN') {
      forceSyncToken();
      sendResponse({ ok: true });
      return false;
    }

    // NEW: WRITE_LOCALSTORAGE Handler
    if (message && message.type === 'WRITE_LOCALSTORAGE') {
      try {
        const { key, value } = message;

        if (!key || typeof key !== 'string') {
          sendResponse({ ok: false, error: 'Invalid key' });
          return false;
        }

        // Security: Only allow whitelisted keys
        const ALLOWED_KEYS = [
          'rev_messaging_public_key',
          'rev_messaging_fingerprint',
          'rev_key_exchange_offer'
        ];

        if (!ALLOWED_KEYS.includes(key)) {
          console.warn('[contentScript] Write rejected: key not whitelisted:', key);
          sendResponse({ ok: false, error: 'Key not whitelisted' });
          return false;
        }

        // Write to localStorage
        if (value === null || value === undefined) {
          window.localStorage.removeItem(key);
          console.log('[contentScript] Removed from localStorage:', key);
        } else {
          window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
          console.log('[contentScript] Wrote to localStorage:', key);
        }

        sendResponse({ ok: true });
      } catch (error) {
        console.error('[contentScript] localStorage write failed:', error);
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }

    // NEW: READ_LOCALSTORAGE Handler
    if (message && message.type === 'READ_LOCALSTORAGE') {
      try {
        const { key } = message;

        if (!key || typeof key !== 'string') {
          sendResponse({ ok: false, error: 'Invalid key' });
          return false;
        }

        const value = window.localStorage.getItem(key);
        sendResponse({ ok: true, value });
      } catch (error) {
        console.error('[contentScript] localStorage read failed:', error);
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }

    return undefined;
  });

  // Listen for messages from website (postMessage) and forward to background.js
  window.addEventListener('message', (event) => {
    // Only log Revolution-related postMessages (not from other extensions)
    // if (event.origin === window.location.origin && event.data && event.data.type?.startsWith('DEVICE_')) {
    //   console.log('[contentScript] 📬 postMessage:', event.data.type);
    // }

    // Only accept messages from same origin
    if (event.origin !== window.location.origin) {
      return;
    }

    // Handle device registration response from website
    if (event.data && event.data.type === 'DEVICE_REGISTRATION_RESPONSE') {
      console.log('[contentScript] 📥 RECEIVED DEVICE_REGISTRATION_RESPONSE! Status:', event.data.status);
      console.log('[contentScript] 📤 Forwarding to background.js...');
      browser.runtime.sendMessage(event.data).then(() => {
        console.log('[contentScript] ✅ Response forwarded to background.js successfully');
      }).catch(err => {
        console.error('[contentScript] ❌ Failed to forward response to background.js:', err);
      });
    }
  });

  // Erste Synchronisation nach dem Laden
  syncTokenIfChanged();

  // Sofortige Synchronisation nach kurzer Verzögerung (für SPA-Navigationen)
  setTimeout(() => {
    syncTokenIfChanged();
  }, 500);

  // Überprüfung alle 5 Sekunden (only start if not already running)
  if (!syncInterval) {
    syncInterval = setInterval(syncTokenIfChanged, 5000);
  }

  // Cleanup interval when page unloads to prevent memory leaks
  window.addEventListener('beforeunload', () => {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  });

  window.addEventListener('focus', () => {
    syncTokenIfChanged();
  });

  // Beobachte localStorage-Änderungen (funktioniert über Tabs hinweg)
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY || event.key === null) {
      syncTokenIfChanged();
    }
  });

  // PERFORMANCE FIX: MutationObserver disabled - causes massive performance issues
  // On pages with frequent DOM updates (analytics, tables, live updates), this observer
  // fires HUNDREDS of times per second, completely blocking the content process.
  //
  // URL changes are already detected by:
  // - browser.tabs.onUpdated in tracking.js (new page loads)
  // - storage event listener (cross-tab token changes)
  // - focus event listener (tab activation)
  // - 5s interval check (periodic sync)
  //
  // let lastUrl = window.location.href;
  // new MutationObserver(() => {
  //   const currentUrl = window.location.href;
  //   if (currentUrl !== lastUrl) {
  //     lastUrl = currentUrl;
  //     syncTokenIfChanged();
  //   }
  // }).observe(document, { subtree: true, childList: true });
})();
