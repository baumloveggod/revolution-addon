/**
 * Crypto utilities for browser clients
 * Uses libsodium (loaded globally from sodium.js)
 * Non-module version for Firefox addon background scripts
 */

// Wrap in IIFE to avoid global variable conflicts
(function() {
  if (typeof window.MessagingCrypto === 'undefined') {
    window.MessagingCrypto = {};
  }

  // Debug logging helper - only logs errors and warnings
  function debugLog(operation, data) {
    // Only log errors and warnings
    if (operation.includes('❌') || operation.includes('⚠️')) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] [MessagingCrypto] ${operation}`, data);

      // Send to logging service if available
      if (typeof window.LogClient !== 'undefined' && window.LogClient.sendLog) {
        const level = operation.includes('❌') ? 'error' : 'warning';
        window.LogClient.sendLog('browser-addon', 'crypto_operation', operation, data, level);
      }
    }
  }

  // Ensure sodium is ready before use (local scope)
  let sodiumReady = false;
  window.MessagingCrypto.ensureSodiumReady = async function ensureSodiumReady() {
    if (!sodiumReady) {
      if (typeof sodium === 'undefined') {
        const error = new Error('Sodium not loaded. Make sure sodium.js is loaded first.');
        debugLog('❌ ensureSodiumReady FAILED', { error: error.message });
        throw error;
      }
      await sodium.ready;
      sodiumReady = true;
    }
  };

  /**
   * Generate a new X25519 keypair for encryption
   */
  window.MessagingCrypto.generateKeyPair = async function generateKeyPair() {
    await window.MessagingCrypto.ensureSodiumReady();

    const keyPair = sodium.crypto_box_keypair();
    return {
      publicKey: sodium.to_base64(keyPair.publicKey),
      privateKey: sodium.to_base64(keyPair.privateKey)
    };
  };

  /**
   * Generate a new Ed25519 keypair for signing
   */
  window.MessagingCrypto.generateSigningKeyPair = async function generateSigningKeyPair() {
    await window.MessagingCrypto.ensureSodiumReady();

    const keyPair = sodium.crypto_sign_keypair();
    return {
      publicKey: sodium.to_base64(keyPair.publicKey),
      privateKey: sodium.to_base64(keyPair.privateKey)
    };
  };

  /**
   * Encrypt a message for a recipient
   */
  window.MessagingCrypto.encryptMessage = async function encryptMessage(message, recipientPublicKey, senderPrivateKey) {
    await window.MessagingCrypto.ensureSodiumReady();

    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const messageBytes = sodium.from_string(message);
    const recipientPubKey = sodium.from_base64(recipientPublicKey);
    const senderPrivKey = sodium.from_base64(senderPrivateKey);

    const ciphertext = sodium.crypto_box_easy(
      messageBytes,
      nonce,
      recipientPubKey,
      senderPrivKey
    );

    return {
      ciphertext: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce)
    };
  };

  /**
   * Decrypt a message from a sender
   */
  window.MessagingCrypto.decryptMessage = async function decryptMessage(ciphertext, nonce, senderPublicKey, recipientPrivateKey) {
    await window.MessagingCrypto.ensureSodiumReady();

    try {
      const ciphertextBytes = sodium.from_base64(ciphertext);
      const nonceBytes = sodium.from_base64(nonce);
      const senderPubKey = sodium.from_base64(senderPublicKey);
      const recipientPrivKey = sodium.from_base64(recipientPrivateKey);

      const decrypted = sodium.crypto_box_open_easy(
        ciphertextBytes,
        nonceBytes,
        senderPubKey,
        recipientPrivKey
      );

      return sodium.to_string(decrypted);
    } catch (error) {
      debugLog('❌ decryptMessage FAILED', { error: error.message, stack: error.stack });
      throw new Error('Decryption failed: ' + error.message);
    }
  };

  /**
   * Sign a message with Ed25519
   */
  window.MessagingCrypto.signMessage = async function signMessage(message, privateKey) {
    await window.MessagingCrypto.ensureSodiumReady();

    const messageBytes = sodium.from_string(message);
    const privKey = sodium.from_base64(privateKey);

    const signature = sodium.crypto_sign_detached(messageBytes, privKey);
    return sodium.to_base64(signature);
  };

  /**
   * Verify a message signature
   * @param {string} message - The message that was signed
   * @param {string} signature - The base64-encoded signature
   * @param {string} publicKey - The base64-encoded public key
   * @param {number} variant - Optional base64 variant (defaults to ORIGINAL for backward compatibility)
   */
  window.MessagingCrypto.verifySignature = async function verifySignature(message, signature, publicKey, variant) {
    await window.MessagingCrypto.ensureSodiumReady();

    try {
      // Default to ORIGINAL variant for backward compatibility with regular messages
      // Use URLSAFE_NO_PADDING for KEY_UPDATE admin signatures
      const base64Variant = variant !== undefined ? variant : sodium.base64_variants.ORIGINAL;

      const messageBytes = sodium.from_string(message);
      const signatureBytes = sodium.from_base64(signature, base64Variant);
      const pubKey = sodium.from_base64(publicKey, base64Variant);

      return sodium.crypto_sign_verify_detached(signatureBytes, messageBytes, pubKey);
    } catch (error) {
      debugLog('❌ verifySignature FAILED', { error: error.message });
      return false;
    }
  };

  /**
   * Generate a fingerprint from a public key
   */
  window.MessagingCrypto.generateFingerprint = async function generateFingerprint(publicKey) {
    await window.MessagingCrypto.ensureSodiumReady();

    const pubKeyBytes = sodium.from_base64(publicKey);
    const hash = sodium.crypto_generichash(32, pubKeyBytes);
    return sodium.to_base64(hash);
  };

  /**
   * Generate a cryptographically secure random nonce
   */
  window.MessagingCrypto.generateNonce = async function generateNonce() {
    await window.MessagingCrypto.ensureSodiumReady();

    const nonce = sodium.randombytes_buf(24);
    return sodium.to_base64(nonce);
  };

})();
