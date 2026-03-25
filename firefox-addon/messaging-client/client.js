/**
 * Messaging Client
 * E2E encrypted messaging client for browser addons
 * Non-module version for Firefox addon background scripts
 */

/**
 * MessagingClient Class (as constructor function)
 */
window.MessagingClient = function MessagingClient(options) {
  options = options || {};

  // Debug logging helper - only logs errors and important lifecycle events
  this.debugLog = function(operation, data) {
    // Only log errors, warnings, and important lifecycle events (init, register)
    const isError = operation.includes('❌');
    const isWarning = operation.includes('⚠️');
    const isImportant = operation.includes('initialize SUCCESS') ||
                       operation.includes('register SUCCESS') ||
                       operation.includes('poll FAILED') ||
                       operation.includes('NOT_REGISTERED');

    if (isError || isWarning || isImportant) {
      const timestamp = new Date().toISOString();
      console.warn(`[${timestamp}] [MessagingClient] ${operation}`, data);
    }
  };

  this.serviceUrl = options.serviceUrl || 'https://msg.lenkenhoff.de';
  this.pollInterval = options.pollInterval || 5000; // 5 seconds
  this.authToken = options.authToken || null;

  this.keyPair = null;
  this.signingKeyPair = null;
  this.groupId = null;
  this.messagingAddress = null;  // = signingKeyPair.publicKey (Binary Model)
  this.groupKeys = {}; // Map of messagingAddress -> {publicKey, signingPublicKey}

  this.pollTimer = null;
  this.isPolling = false;

  // Event handlers
  this.onMessage = null;
  this.onError = null;
  this.onRegistered = null;

};

/**
 * Initialize the client
 * Loads existing keypair from storage or generates new ones
 */
window.MessagingClient.prototype.initialize = async function() {
  try {
    // Try to load existing keys from storage first
    const stored = await browser.storage.local.get(['rev_messaging_keypair', 'rev_messaging_signing_keypair']);

    if (stored.rev_messaging_keypair && stored.rev_messaging_signing_keypair) {
      // Use existing keys
      this.keyPair = stored.rev_messaging_keypair;
      this.signingKeyPair = stored.rev_messaging_signing_keypair;
      // messagingAddress = signingPublicKey (Binary Model)
      this.messagingAddress = this.signingKeyPair.publicKey;

      this.debugLog('✅ initialize SUCCESS with EXISTING keys', {
        messagingAddress: this.messagingAddress.substring(0, 20) + '...',
        encryptionPublicKey: this.keyPair.publicKey.substring(0, 16) + '...'
      });
    } else {
      // Generate new encryption and signing keypairs
      this.keyPair = await window.MessagingCrypto.generateKeyPair();
      this.signingKeyPair = await window.MessagingCrypto.generateSigningKeyPair();
      // messagingAddress = signingPublicKey (Binary Model)
      this.messagingAddress = this.signingKeyPair.publicKey;

      // Store keys persistently
      await browser.storage.local.set({
        rev_messaging_keypair: this.keyPair,
        rev_messaging_signing_keypair: this.signingKeyPair,
        rev_messaging_address: this.messagingAddress
      });

      this.debugLog('✅ initialize SUCCESS with NEW keys (saved to storage)', {
        messagingAddress: this.messagingAddress.substring(0, 20) + '...',
        encryptionPublicKey: this.keyPair.publicKey.substring(0, 16) + '...'
      });
    }

    return true;
  } catch (error) {
    this.debugLog('❌ initialize FAILED', { error: error.message, stack: error.stack });
    if (this.onError) this.onError(error);
    return false;
  }
};

/**
 * Register with the messaging service
 */
window.MessagingClient.prototype.register = async function(groupId, authToken) {
  if (authToken) {
    this.authToken = authToken;
  }

  if (!this.authToken) {
    const error = new Error('Auth token required for registration');
    this.debugLog('❌ register FAILED - no auth token', {});
    throw error;
  }

  try {
    const requestBody = {
      publicKey: this.keyPair.publicKey,
      signingPublicKey: this.signingKeyPair.publicKey,
      groupId
    };

    const response = await window.fetchWithVersion(`${this.serviceUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json();
      this.debugLog('❌ Registration request failed', { status: response.status, error });
      throw new Error(error.error || 'Registration failed');
    }

    const data = await response.json();

    // Save group ID
    this.groupId = groupId;
    await window.MessagingStorage.saveGroupId(groupId);

    // Use bootstrap keys if provided in registration response, otherwise fetch
    if (data.groupKeys && Array.isArray(data.groupKeys) && data.groupKeys.length > 0) {
      this.groupKeys = {};
      for (const key of data.groupKeys) {
        // Use fingerprint field as key (= messagingAddress in Binary Model)
        const keyId = key.messaging_address || key.fingerprint;
        this.groupKeys[keyId] = {
          publicKey: key.publicKey,
          signingPublicKey: key.signingPublicKey
        };
      }
    } else {
      await this.fetchGroupKeys();
    }

    this.debugLog('✅ register SUCCESS', data);
    if (this.onRegistered) this.onRegistered(data);

    return data;
  } catch (error) {
    this.debugLog('❌ register FAILED', { error: error.message, stack: error.stack });
    if (this.onError) this.onError(error);
    throw error;
  }
};

/**
 * Fetch all public keys for the group from messaging service
 */
window.MessagingClient.prototype.fetchGroupKeys = async function() {
  try {
    // DEBUG: Check if fetchWithVersion is available
    if (!window.fetchWithVersion) {
      throw new Error('CRITICAL: window.fetchWithVersion is not defined! Check that api-client.js is loaded before messaging-client.');
    }

    const response = await window.fetchWithVersion(`${this.serviceUrl}/keys?groupId=${this.groupId}`, {
      headers: {
        'Authorization': `Bearer ${this.authToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch keys: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // Store keys by messagingAddress (= fingerprint field in server response)
    this.groupKeys = {};
    for (const key of data.keys || []) {
      const keyId = key.messaging_address || key.fingerprint;
      this.groupKeys[keyId] = {
        publicKey: key.publicKey,
        signingPublicKey: key.signingPublicKey
      };
    }

    return this.groupKeys;
  } catch (error) {
    this.debugLog('❌ fetchGroupKeys FAILED', { error: error.message });
    throw error;
  }
};

/**
 * Send a message to the group or specific recipients
 *
 * Binary Sender/Receiver Model Support:
 * - If recipientAddresses is provided, send only to those specific addresses
 * - Keys are looked up from: groupKeys, website_keys, known_devices (browser.storage)
 *
 * @param {Object} payload - Message payload
 * @param {string} type - Message type (default: 'data')
 * @param {string[]} recipientAddresses - Optional explicit recipient addresses (messagingAddresses)
 */
window.MessagingClient.prototype.sendMessage = async function(payload, type, recipientAddresses) {
  type = type || 'data';

  if (!this.authToken || !this.groupId) {
    const error = new Error('Not registered yet');
    this.debugLog('❌ sendMessage FAILED - not registered', {
      hasAuthToken: !!this.authToken,
      hasGroupId: !!this.groupId
    });
    throw error;
  }

  // Binary Model: Load keys from browser.storage if available
  let websiteKeys = null;
  let knownDevices = [];
  try {
    const storage = await browser.storage.local.get(['website_keys', 'known_devices']);
    websiteKeys = storage.website_keys || null;
    knownDevices = storage.known_devices || [];
  } catch (e) {
    this.debugLog('⚠️ Could not load keys from browser.storage', { error: e.message });
  }

  // Check if we have any keys (either groupKeys or Binary Model keys)
  const hasGroupKeys = Object.keys(this.groupKeys).length > 0;
  const hasBinaryKeys = websiteKeys || knownDevices.length > 0;

  if (!hasGroupKeys && !hasBinaryKeys) {
    const error = new Error('No keys available - waiting for ADDRESS_UPDATE message from website');
    this.debugLog('❌ sendMessage FAILED - no keys', {
      note: 'The website will send an ADDRESS_UPDATE message with all keys. Please wait...'
    });
    throw error;
  }

  try {
    // Determine recipients:
    // - If explicit addresses provided, use those
    // - Otherwise, use groupKeys (traditional mode)
    let recipients;
    if (recipientAddresses && recipientAddresses.length > 0) {
      // Binary Model: explicit recipients
      recipients = recipientAddresses;
      this.debugLog('📤 Sending to explicit recipients', {
        recipientCount: recipients.length
      });
    } else {
      // Broadcast to all group members (exclude self)
      recipients = Object.keys(this.groupKeys).filter(addr => addr !== this.messagingAddress);
    }

    // Check if we have any recipients
    if (recipients.length === 0) {
      this.debugLog('⚠️ No recipients available', {
        groupKeyCount: Object.keys(this.groupKeys).length,
        messageType: type
      });

      // Don't throw error for system messages that might be sent when solo
      const typeNormalized = type.toLowerCase();
      if (typeNormalized === 'rating' || typeNormalized === 'event') {
        return { success: true, skipped: true, reason: 'No other group members' };
      }

      // For other message types, throw error
      throw new Error('No recipients available - waiting for other group members to register');
    }

    const encryptedPayloads = {};
    const payloadString = JSON.stringify(payload);

    for (const recipientAddress of recipients) {
      // Look up recipient key - try multiple sources:
      // 1. groupKeys (bootstrap keys from server)
      // 2. website_keys (from ADDRESS_UPDATE)
      // 3. known_devices (from ADDRESS_UPDATE)
      let recipientKey = this.groupKeys[recipientAddress];

      // If not found by address, search groupKeys by signingPublicKey
      if (!recipientKey) {
        for (const [fp, keyData] of Object.entries(this.groupKeys)) {
          if (keyData.signingPublicKey === recipientAddress || keyData.messagingAddress === recipientAddress) {
            recipientKey = keyData;
            break;
          }
        }
      }

      // Try website_keys (Binary Model)
      if (!recipientKey && websiteKeys && websiteKeys.messaging_address === recipientAddress) {
        recipientKey = {
          publicKey: websiteKeys.encryption_key,
          signingPublicKey: websiteKeys.messaging_address
        };
        this.debugLog('🔑 Using website_keys from browser.storage', {});
      }

      // Try known_devices (Binary Model)
      if (!recipientKey && knownDevices.length > 0) {
        const device = knownDevices.find(d => d.messaging_address === recipientAddress);
        if (device) {
          recipientKey = {
            publicKey: device.encryption_key,
            signingPublicKey: device.messaging_address
          };
          this.debugLog('🔑 Using known_device from browser.storage', {
            deviceName: device.name || recipientAddress.substring(0, 16)
          });
        }
      }

      if (!recipientKey) {
        this.debugLog('⚠️ Recipient not found in any key source', {
          recipientAddress: recipientAddress.substring(0, 16) + '...'
        });
        continue;
      }

      const encrypted = await window.MessagingCrypto.encryptMessage(
        payloadString,
        recipientKey.publicKey,
        this.keyPair.privateKey
      );
      encryptedPayloads[recipientAddress] = encrypted;
    }

    // Create message structure
    const messageId = crypto.randomUUID();
    const message = {
      id: messageId,
      type: type,
      timestamp: Date.now(),
      nonce: await window.MessagingCrypto.generateNonce(),
      sender: this.messagingAddress,
      recipients: recipients,
      payload: encryptedPayloads
    };

    // Sign the message
    const messageString = JSON.stringify(message);
    message.signature = await window.MessagingCrypto.signMessage(messageString, this.signingKeyPair.privateKey);

    // Send to server
    const requestBody = {
      message: message,
      groupId: this.groupId
    };

    const response = await window.fetchWithVersion(`${this.serviceUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json();
      this.debugLog('❌ Send request failed', { status: response.status, error });
      throw new Error(error.error || 'Send failed');
    }

    const data = await response.json();
    return data;
  } catch (error) {
    this.debugLog('❌ sendMessage FAILED', { error: error.message, stack: error.stack });
    if (this.onError) this.onError(error);
    throw error;
  }
};

/**
 * Poll for new messages (signed request proves ownership of messagingAddress)
 */
window.MessagingClient.prototype.poll = async function() {
  if (!this.authToken) {
    this.debugLog('⚠️ Cannot poll: not authenticated', {});
    return [];
  }

  if (!this.messagingAddress || !this.signingKeyPair?.privateKey) {
    this.debugLog('⚠️ Cannot poll: missing messagingAddress or signing key', {});
    return [];
  }

  try {
    const timestamp = Date.now();
    const nonce = await window.MessagingCrypto.generateNonce();

    const requestData = {
      messagingAddress: this.messagingAddress,
      timestamp: timestamp,
      nonce: nonce
    };

    // Sign the request (proves ownership of messagingAddress)
    const dataToSign = JSON.stringify({
      messagingAddress: this.messagingAddress,
      timestamp: timestamp,
      nonce: nonce
    });
    const signature = await window.MessagingCrypto.signMessage(dataToSign, this.signingKeyPair.privateKey);
    requestData.signature = signature;

    const response = await window.fetchWithVersion(`${this.serviceUrl}/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify(requestData)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      // Check if client is not registered (403 NOT_REGISTERED)
      if (response.status === 403 && errorData.error === 'NOT_REGISTERED') {
        const notRegisteredError = new Error('Client not registered with messaging service. Please re-register.');
        notRegisteredError.code = 'NOT_REGISTERED';
        // Let onError decide whether to stop polling (linked device = revoked → stop,
        // unlinked device = waiting for registration → keep polling)
        if (this.onError) this.onError(notRegisteredError);
        // Only stop polling if onError didn't handle it as a "still registering" case
        // i.e. if the error handler calls stopPolling() itself
        throw notRegisteredError;
      }

      this.debugLog('❌ poll FAILED', { status: response.status, error: errorData });
      throw new Error('Poll failed');
    }

    const data = await response.json();

    if (data.messages && data.messages.length > 0) {
      for (const message of data.messages) {
        await this.processMessage(message);
      }
    }

    return data.messages;
  } catch (error) {
    this.debugLog('❌ poll FAILED', { error: error.message, stack: error.stack });
    if (this.onError) this.onError(error);
    return [];
  }
};

/**
 * Process a received message
 */
window.MessagingClient.prototype.processMessage = async function(message) {
  try {
    // Get encrypted payload for this client (by messagingAddress)
    const encryptedPayload = message.payload[this.messagingAddress];

    if (!encryptedPayload) {
      this.debugLog('⚠️ No payload for this client', {
        messageId: message.id,
        myAddress: this.messagingAddress?.substring(0, 16) + '...',
        availableKeys: Object.keys(message.payload).map(k => k.substring(0, 16) + '...')
      });
      return;
    }

    // Get sender's public key
    let senderKey = this.groupKeys[message.sender];

    // For key_rotation/address_update messages, we need to accept messages from unknown senders
    // because this is how we get the initial group keys (bootstrap problem)
    if (!senderKey && (message.type === 'key_rotation' || message.type === 'address_update')) {
      this.debugLog('⚠️ Unknown sender for address_update - fetching sender key from messaging service', {
        sender: message.sender?.substring(0, 16) + '...'
      });

      // Fetch all keys from messaging service to get the sender's public key
      try {
        const response = await window.fetchWithVersion(`${this.serviceUrl}/keys?groupId=${this.groupId}`, {
          headers: {
            'Authorization': `Bearer ${this.authToken}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          // Look up by messagingAddress (= fingerprint field in response)
          const senderKeyData = data.keys?.find(k =>
            (k.messaging_address || k.fingerprint) === message.sender
          );

          if (senderKeyData) {
            senderKey = {
              publicKey: senderKeyData.publicKey,
              signingPublicKey: senderKeyData.signingPublicKey
            };
          } else {
            this.debugLog('❌ Sender key not found in messaging service', {
              sender: message.sender?.substring(0, 16) + '...'
            });
            return;
          }
        } else {
          this.debugLog('❌ Failed to fetch keys from messaging service', {
            status: response.status
          });
          return;
        }
      } catch (error) {
        this.debugLog('❌ Error fetching sender key', { error: error.message });
        return;
      }
    } else if (!senderKey) {
      // Fallback: search known_devices and website_keys from browser.storage
      // (same sources sendMessage uses for recipients)
      try {
        const storage = await browser.storage.local.get(['website_keys', 'known_devices']);
        const websiteKeys = storage.website_keys || null;
        const knownDevices = storage.known_devices || [];

        if (websiteKeys && websiteKeys.messaging_address === message.sender) {
          senderKey = {
            publicKey: websiteKeys.encryption_key,
            signingPublicKey: websiteKeys.messaging_address
          };
        } else {
          const device = knownDevices.find(d => d.messaging_address === message.sender);
          if (device) {
            senderKey = {
              publicKey: device.encryption_key,
              signingPublicKey: device.messaging_address
            };
          }
        }
      } catch (e) {
        this.debugLog('⚠️ Could not load keys from browser.storage for sender lookup', { error: e.message });
      }

      if (!senderKey) {
        this.debugLog('⚠️ Unknown sender', {
          sender: message.sender?.substring(0, 16) + '...',
          knownAddresses: Object.keys(this.groupKeys).map(k => k.substring(0, 16) + '...')
        });
        return;
      }
    }

    // Decrypt
    const decrypted = await window.MessagingCrypto.decryptMessage(
      encryptedPayload.ciphertext,
      encryptedPayload.nonce,
      senderKey.publicKey,
      this.keyPair.privateKey
    );

    const payload = JSON.parse(decrypted);

    // Acknowledge receipt
    await this.acknowledgeMessage(message.id);

    // Trigger event handler
    if (this.onMessage) {
      this.onMessage({
        id: message.id,
        type: message.type,
        timestamp: message.timestamp,
        sender: message.sender,
        payload: payload
      });
    }
  } catch (error) {
    this.debugLog('❌ processMessage FAILED', {
      messageId: message.id,
      error: error.message,
      stack: error.stack
    });
    if (this.onError) this.onError(error);
  }
};

/**
 * Acknowledge message receipt
 */
window.MessagingClient.prototype.acknowledgeMessage = async function(messageId) {
  try {
    const response = await window.fetchWithVersion(`${this.serviceUrl}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({
        messageId: messageId,
        messagingAddress: this.messagingAddress
      })
    });

    if (!response.ok) {
      this.debugLog('⚠️ acknowledgeMessage failed but continuing', {
        messageId,
        status: response.status
      });
    }
  } catch (error) {
    this.debugLog('❌ acknowledgeMessage ERROR', {
      messageId,
      error: error.message
    });
  }
};

/**
 * Start polling for messages
 */
window.MessagingClient.prototype.startPolling = function() {
  if (this.isPolling) {
    this.debugLog('⚠️ Polling already active', { pollInterval: this.pollInterval });
    return;
  }

  this.isPolling = true;

  const self = this;
  const doPoll = async function() {
    if (!self.isPolling) {
      return;
    }
    await self.poll();
    self.pollTimer = setTimeout(doPoll, self.pollInterval);
  };

  doPoll();
};

/**
 * Stop polling
 */
window.MessagingClient.prototype.stopPolling = function() {
  this.isPolling = false;
  if (this.pollTimer) {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
};

/**
 * Set auth token
 */
window.MessagingClient.prototype.setAuthToken = function(token) {
  this.authToken = token;
};

/**
 * Get client info
 */
window.MessagingClient.prototype.getInfo = function() {
  return {
    messagingAddress: this.messagingAddress,
    encryptionPublicKey: this.keyPair ? this.keyPair.publicKey : null,
    signingPublicKey: this.signingKeyPair ? this.signingKeyPair.publicKey : null,
    groupId: this.groupId,
    groupMemberCount: Object.keys(this.groupKeys).length
  };
};

/**
 * Zero-Knowledge Local Key Lookup
 * Gets encryption key for a messaging_address from local storage
 * (No server lookup - all keys come via ADDRESS_UPDATE)
 *
 * @param {string} messagingAddress - The target's messaging_address (= signingPublicKey)
 * @returns {Promise<string|null>} The encryption_key or null if not found
 */
window.MessagingClient.prototype.getEncryptionKeyForAddress = async function(messagingAddress) {
  try {
    const stored = await browser.storage.local.get(['website_keys', 'known_devices']);

    // Check website
    if (stored.website_keys && stored.website_keys.messaging_address === messagingAddress) {
      return stored.website_keys.encryption_key;
    }

    // Check devices
    if (stored.known_devices && Array.isArray(stored.known_devices)) {
      const device = stored.known_devices.find(d => d.messaging_address === messagingAddress);
      if (device && device.encryption_key) {
        return device.encryption_key;
      }
    }

    // Check groupKeys (for backward compatibility with bootstrap)
    if (this.groupKeys[messagingAddress]?.publicKey) {
      return this.groupKeys[messagingAddress].publicKey;
    }

    this.debugLog('⚠️ No encryption key found for address', {
      address: messagingAddress.substring(0, 16) + '...'
    });
    return null;
  } catch (error) {
    this.debugLog('❌ Error looking up encryption key', { error: error.message });
    return null;
  }
};

/**
 * Get all known recipients from local storage (Zero-Knowledge)
 * @returns {Promise<Array<{messaging_address: string, encryption_key: string, name?: string}>>}
 */
window.MessagingClient.prototype.getKnownRecipients = async function() {
  try {
    const stored = await browser.storage.local.get(['website_keys', 'known_devices']);
    const recipients = [];

    // Add website
    if (stored.website_keys && stored.website_keys.messaging_address && stored.website_keys.encryption_key) {
      recipients.push({
        messaging_address: stored.website_keys.messaging_address,
        encryption_key: stored.website_keys.encryption_key,
        name: 'Website',
        type: 'website'
      });
    }

    // Add devices (excluding self)
    if (stored.known_devices && Array.isArray(stored.known_devices)) {
      for (const device of stored.known_devices) {
        if (device.messaging_address && device.encryption_key && device.messaging_address !== this.messagingAddress) {
          recipients.push({
            messaging_address: device.messaging_address,
            encryption_key: device.encryption_key,
            name: device.name || 'Unknown Device',
            type: 'device'
          });
        }
      }
    }

    return recipients;
  } catch (error) {
    this.debugLog('❌ Error loading known recipients', { error: error.message });
    return [];
  }
};

/**
 * Send message using local key lookup (Zero-Knowledge)
 * Uses stored keys from ADDRESS_UPDATE instead of server lookup
 *
 * @param {Object} payload - The message payload
 * @param {string} type - Message type
 * @param {string[]} [targetAddresses] - Specific addresses to send to (optional, defaults to all)
 */
window.MessagingClient.prototype.sendMessageZeroKnowledge = async function(payload, type, targetAddresses = null) {
  type = type || 'data';

  if (!this.authToken || !this.groupId) {
    throw new Error('Not registered yet');
  }

  try {
    // Get recipients from local storage (Zero-Knowledge)
    let recipients = await this.getKnownRecipients();

    // Filter if specific addresses requested
    if (targetAddresses && targetAddresses.length > 0) {
      recipients = recipients.filter(r => targetAddresses.includes(r.messaging_address));
    }

    if (recipients.length === 0) {
      // Don't throw error for rating messages
      const typeNormalized = type.toLowerCase();
      if (typeNormalized === 'rating' || typeNormalized === 'event') {
        return { success: true, skipped: true, reason: 'No known recipients' };
      }
      throw new Error('No known recipients - waiting for ADDRESS_UPDATE');
    }

    const encryptedPayloads = {};
    const payloadString = JSON.stringify(payload);
    const recipientAddresses = [];

    for (const recipient of recipients) {
      try {
        const encrypted = await window.MessagingCrypto.encryptMessage(
          payloadString,
          recipient.encryption_key,
          this.keyPair.privateKey
        );
        encryptedPayloads[recipient.messaging_address] = encrypted;
        recipientAddresses.push(recipient.messaging_address);
      } catch (encryptError) {
        this.debugLog('⚠️ Failed to encrypt for recipient', {
          address: recipient.messaging_address.substring(0, 16) + '...',
          error: encryptError.message
        });
      }
    }

    if (recipientAddresses.length === 0) {
      throw new Error('Failed to encrypt for any recipients');
    }

    // Create message structure
    const messageId = crypto.randomUUID();
    const message = {
      id: messageId,
      type: type,
      timestamp: Date.now(),
      nonce: await window.MessagingCrypto.generateNonce(),
      sender: this.messagingAddress,
      recipients: recipientAddresses,
      payload: encryptedPayloads
    };

    // Sign the message
    const messageForSigning = { ...message };
    delete messageForSigning.signature;
    const messageString = JSON.stringify(messageForSigning);
    message.signature = await window.MessagingCrypto.signMessage(messageString, this.signingKeyPair.privateKey);

    // Send to messaging service
    const response = await window.fetchWithVersion(`${this.serviceUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({
        groupId: this.groupId,
        message: message
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    this.debugLog('❌ sendMessageZeroKnowledge FAILED', { error: error.message });
    if (this.onError) this.onError(error);
    throw error;
  }
};

