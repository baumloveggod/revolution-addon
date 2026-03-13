/**
 * API Client with Version Headers
 *
 * Centralized fetch wrapper that automatically adds version headers
 * to all requests and handles version warnings from server.
 */

/**
 * Fetch with automatic version headers
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>} - Fetch response
 */
async function fetchWithVersion(url, options = {}) {
  // CRITICAL: Ensure RevolutionConfig is loaded and has version info
  const apiVersion = window.RevolutionConfig?.version?.apiVersion || '1.0';

  if (!window.RevolutionConfig?.version?.apiVersion) {
    console.warn('[fetchWithVersion] RevolutionConfig.version.apiVersion is not set, using fallback: 1.0');
  }

  const headers = {
    ...options.headers,
    'X-Client-API-Version': apiVersion,
    'X-Client-Type': 'firefox-addon'
  };

  // DEBUG: Log headers being sent
  if (url.includes('192.168.178.130:4200')) {
    console.log('[fetchWithVersion] DEBUG: Sending request to messaging-service:', {
      url,
      headers,
      hasVersionHeader: !!headers['X-Client-API-Version']
    });
  }

  const response = await fetch(url, { ...options, headers });

  // Check for version warnings in response
  if (response.ok) {
    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (data._version_warning) {
          await handleVersionWarning(data._version_warning);
        }
      }
    } catch (e) {
      // Ignore JSON parse errors for non-JSON responses
    }
  }

  return response;
}

/**
 * Handle version warning from server
 * @param {object} warning - Version warning object from server
 */
async function handleVersionWarning(warning) {
  console.warn('[Version]', warning.message);

  // Store warning for UI display
  await browser.storage.local.set({
    lastVersionWarning: warning,
    lastVersionWarningTime: Date.now()
  });

  // Show notification (throttled to once per day)
  const lastNotification = await browser.storage.local.get('lastVersionNotification');
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);

  if (!lastNotification.lastVersionNotification || lastNotification.lastVersionNotification < dayAgo) {
    await browser.notifications.create({
      type: 'basic',
      title: 'Revolution Version-Hinweis',
      message: warning.message,
      iconUrl: 'icon.png'
    });

    await browser.storage.local.set({ lastVersionNotification: Date.now() });
  }
}

// Export for browser extension
if (typeof window !== 'undefined') {
  window.fetchWithVersion = fetchWithVersion;
}
