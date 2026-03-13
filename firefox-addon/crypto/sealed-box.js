/**
 * Sealed Box Encryption (anonymous encryption)
 * Addon verschlüsselt für Website ohne eigenen Private Key zu offenbaren
 *
 * Sealed Box nutzt libsodium's crypto_box_seal:
 * - Sender muss KEINEN Private Key offenbaren
 * - Nur Recipient Public Key wird benötigt
 * - Empfänger kann mit seinem Key-Pair entschlüsseln
 * - Sender bleibt anonym (kein Sender-Fingerprint in Message)
 */

console.log('[SealedBox] Script loading...');

(function() {
  if (typeof window.SealedBox === 'undefined') {
    window.SealedBox = {};
  }

  // Debug logging helper - only logs errors and warnings
  function debugLog(operation, data) {
    if (operation.includes('❌') || operation.includes('⚠️')) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [SealedBox] ${operation}`, data);

      // Send to logging service if available
      if (typeof window.LogClient !== 'undefined' && window.LogClient.sendLog) {
        const level = operation.includes('❌') ? 'error' : 'warning';
        window.LogClient.sendLog('browser-addon', 'sealed_box', operation, data, level);
      }
    }
  }

  /**
   * Encrypt a message for a recipient (anonymous encryption)
   * @param {Object|string} message - The message to encrypt (will be JSON.stringify'd if object)
   * @param {string} recipientPublicKey - Base64-encoded recipient public key (X25519)
   * @returns {Promise<{ciphertext: string, algorithm: string}>}
   */
  window.SealedBox.encrypt = async function sealedBoxEncrypt(message, recipientPublicKey) {
    // Ensure sodium is ready
    if (typeof window.MessagingCrypto === 'undefined' || !window.MessagingCrypto.ensureSodiumReady) {
      const error = new Error('MessagingCrypto not available. Load messaging-client/crypto.js first.');
      debugLog('❌ encrypt FAILED', { error: error.message });
      throw error;
    }

    await window.MessagingCrypto.ensureSodiumReady();

    try {
      // Convert message to string if object
      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      const messageBytes = sodium.from_string(messageStr);
      const recipientPubKey = sodium.from_base64(recipientPublicKey);

      // Sealed box: Empfänger kann entschlüsseln, aber Sender bleibt anonym
      // crypto_box_seal generiert ephemeral keypair intern (nicht exponiert)
      const ciphertext = sodium.crypto_box_seal(messageBytes, recipientPubKey);

      return {
        ciphertext: sodium.to_base64(ciphertext),
        algorithm: 'sealed_box'
      };
    } catch (error) {
      debugLog('❌ encrypt FAILED', {
        error: error.message,
        stack: error.stack,
        recipientKeyLength: recipientPublicKey?.length
      });
      throw new Error('Sealed Box encryption failed: ' + error.message);
    }
  };

  /**
   * Decrypt a sealed box message
   * @param {string} ciphertext - Base64-encoded ciphertext
   * @param {string} publicKey - Base64-encoded recipient public key (X25519)
   * @param {string} privateKey - Base64-encoded recipient private key (X25519)
   * @returns {Promise<Object|string>} - Decrypted message (auto-parsed as JSON if possible)
   */
  window.SealedBox.decrypt = async function sealedBoxDecrypt(ciphertext, publicKey, privateKey) {
    // Ensure sodium is ready
    if (typeof window.MessagingCrypto === 'undefined' || !window.MessagingCrypto.ensureSodiumReady) {
      const error = new Error('MessagingCrypto not available. Load messaging-client/crypto.js first.');
      debugLog('❌ decrypt FAILED', { error: error.message });
      throw error;
    }

    await window.MessagingCrypto.ensureSodiumReady();

    try {
      const ciphertextBytes = sodium.from_base64(ciphertext);
      const pubKey = sodium.from_base64(publicKey);
      const privKey = sodium.from_base64(privateKey);

      // crypto_box_seal_open benötigt beide Keys (public + private) des Empfängers
      const decrypted = sodium.crypto_box_seal_open(
        ciphertextBytes,
        pubKey,
        privKey
      );

      const decryptedStr = sodium.to_string(decrypted);

      // Try to parse as JSON, otherwise return string
      try {
        return JSON.parse(decryptedStr);
      } catch (e) {
        // Not JSON, return as string
        return decryptedStr;
      }
    } catch (error) {
      debugLog('❌ decrypt FAILED', {
        error: error.message,
        stack: error.stack,
        ciphertextLength: ciphertext?.length
      });
      throw new Error('Sealed Box decryption failed: ' + error.message);
    }
  };

  console.log('[SealedBox] ✅ Script loaded successfully');
})();
