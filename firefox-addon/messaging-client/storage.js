/**
 * Keypair storage for browser addons
 * Uses browser.storage.local (WebExtension API)
 * Non-module version for Firefox addon background scripts
 */

// Wrap in IIFE to avoid global constant conflicts
(function() {
  if (typeof window.MessagingStorage === 'undefined') {
    window.MessagingStorage = {};
  }

  // Use local scope to avoid conflicts with other constants
  const STORAGE_KEY = 'messaging_keypair';
  const SIGNING_KEY = 'messaging_signing_keypair';
  const GROUP_KEY = 'messaging_group_id';
  const FINGERPRINT_KEY = 'messaging_fingerprint';

  /**
   * Check if browser.storage API is available
   */
  function hasStorageAPI() {
    return typeof browser !== 'undefined' && browser.storage;
  }

  /**
   * Save encryption keypair
   */
  window.MessagingStorage.saveKeyPair = async function saveKeyPair(keyPair) {
    if (hasStorageAPI()) {
      await browser.storage.local.set({ [STORAGE_KEY]: keyPair });
    } else {
      // Fallback to localStorage for non-addon environments
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keyPair));
    }
  };

  /**
   * Load encryption keypair
   */
  window.MessagingStorage.loadKeyPair = async function loadKeyPair() {
    if (hasStorageAPI()) {
      const result = await browser.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || null;
    } else {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    }
  };

  /**
   * Save signing keypair
   */
  window.MessagingStorage.saveSigningKeyPair = async function saveSigningKeyPair(keyPair) {
    if (hasStorageAPI()) {
      await browser.storage.local.set({ [SIGNING_KEY]: keyPair });
    } else {
      localStorage.setItem(SIGNING_KEY, JSON.stringify(keyPair));
    }
  };

  /**
   * Load signing keypair
   */
  window.MessagingStorage.loadSigningKeyPair = async function loadSigningKeyPair() {
    if (hasStorageAPI()) {
      const result = await browser.storage.local.get(SIGNING_KEY);
      return result[SIGNING_KEY] || null;
    } else {
      const stored = localStorage.getItem(SIGNING_KEY);
      return stored ? JSON.parse(stored) : null;
    }
  };

  /**
   * Save group ID
   */
  window.MessagingStorage.saveGroupId = async function saveGroupId(groupId) {
    if (hasStorageAPI()) {
      await browser.storage.local.set({ [GROUP_KEY]: groupId });
    } else {
      localStorage.setItem(GROUP_KEY, groupId);
    }
  };

  /**
   * Load group ID
   */
  window.MessagingStorage.loadGroupId = async function loadGroupId() {
    if (hasStorageAPI()) {
      const result = await browser.storage.local.get(GROUP_KEY);
      return result[GROUP_KEY] || null;
    } else {
      return localStorage.getItem(GROUP_KEY);
    }
  };

  /**
   * Save fingerprint
   */
  window.MessagingStorage.saveFingerprint = async function saveFingerprint(fingerprint) {
    if (hasStorageAPI()) {
      await browser.storage.local.set({ [FINGERPRINT_KEY]: fingerprint });
    } else {
      localStorage.setItem(FINGERPRINT_KEY, fingerprint);
    }
  };

  /**
   * Load fingerprint
   */
  window.MessagingStorage.loadFingerprint = async function loadFingerprint() {
    if (hasStorageAPI()) {
      const result = await browser.storage.local.get(FINGERPRINT_KEY);
      return result[FINGERPRINT_KEY] || null;
    } else {
      return localStorage.getItem(FINGERPRINT_KEY);
    }
  };

  /**
   * Clear all stored keys and data
   */
  window.MessagingStorage.clearAll = async function clearAll() {
    if (hasStorageAPI()) {
      await browser.storage.local.remove([STORAGE_KEY, SIGNING_KEY, GROUP_KEY, FINGERPRINT_KEY]);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SIGNING_KEY);
      localStorage.removeItem(GROUP_KEY);
      localStorage.removeItem(FINGERPRINT_KEY);
    }
  };
})();
