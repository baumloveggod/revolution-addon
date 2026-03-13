/**
 * Libsodium loader for Firefox Addon
 * Loads libsodium from CDN and makes it available globally
 */

// Load libsodium from CDN
(function() {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/browsers/libsodium-wrappers.min.js';
  script.onload = function() {
    console.log('[libsodium-loader] Libsodium loaded successfully');
    // Wait for sodium to be ready
    if (typeof sodium !== 'undefined') {
      sodium.ready.then(() => {
        console.log('[libsodium-loader] Libsodium ready');
        window.sodiumReady = true;
      });
    }
  };
  script.onerror = function() {
    console.error('[libsodium-loader] Failed to load libsodium from CDN');
  };
  document.head.appendChild(script);
})();
