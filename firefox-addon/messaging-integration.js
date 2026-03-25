/**
 * Messaging Integration for Firefox Addon
 * Handles E2E encrypted messaging between addon and website
 * Non-module version for Firefox addon background scripts
 */

// Wrap in IIFE to avoid global variable conflicts
(function() {
  if (typeof window.MessagingIntegration === 'undefined') {
    window.MessagingIntegration = {};
  }

  // Check dependencies immediately (only log errors)
  if (typeof sodium === 'undefined' || typeof window.MessagingCrypto === 'undefined' || typeof window.MessagingClient === 'undefined') {
    console.error('[MessagingIntegration] Missing dependencies!');
  }

  let messagingClient = null;
  let isInitialized = false;
  let isInitializing = false; // Track if initialization is in progress
  let registrationCheckInterval = null;
  let initializationPromise = null; // Track the initialization promise to avoid busy-wait
  let isLinked = false; // True once device has been confirmed registered with messaging service

  /**
   * Start polling for messages
   * NOTE: Device registration happens during /devices/claim flow via server-api
   * This function just starts polling - no need to call /register endpoint
   *
   * Binary Sender/Receiver Model:
   * - Device can poll immediately after initialization (has messagingAddress)
   * - Device will receive ADDRESS_UPDATE message with website_keys and known_devices
   * - No groupKeys check needed - device uses local keys from ADDRESS_UPDATE
   */
  async function startPollingWithRetry(client, groupId, authToken) {
    // Clear any existing check interval
    if (registrationCheckInterval) {
      clearInterval(registrationCheckInterval);
      registrationCheckInterval = null;
    }

    try {
      // Binary Model: Device can poll as long as it has a messagingAddress (= signingPublicKey)
      // No need to wait for groupKeys - ADDRESS_UPDATE will be received via polling
      if (!client.fingerprint && !client.messagingAddress) {
        return;
      }

      // Start polling immediately
      client.startPolling();
      return;
    } catch (error) {
      console.error('[MessagingIntegration] ❌ Failed to start polling:', error.message);
      // Retry after 30 seconds
      setTimeout(() => startPollingWithRetry(client, groupId, authToken), 30000);
    }
  }

  /**
   * Get messaging service URL from server config
   *
   * #FIXME: localhost handling
   * Currently treating localhost the same as any public domain, but localhost is not globally unique.
   * Public domains are globally unique, but localhost can refer to different machines in different contexts.
   * This could cause issues in multi-environment setups or when the addon communicates with different
   * local server instances. Need to implement proper environment detection or configuration mechanism.
   */
  async function getMessagingServiceUrl(origin) {
    try {
      const response = await fetch(`${origin}/auth/config`);
      if (response.ok) {
        const config = await response.json();
        return config.messagingServiceUrl || 'https://msg.lenkenhoff.de';
      }
    } catch (error) {
      console.warn('[MessagingIntegration] ⚠️ Failed to get config, using default', error.message);
    }
    return 'https://msg.lenkenhoff.de';
  }

  /**
   * Initialize messaging (generates keypairs even without token)
   */
  window.MessagingIntegration.initMessaging = async function(userToken, origin = 'https://api.lenkenhoff.de') {
    // Skip if initialization is in progress - return existing promise instead of busy-wait
    if (isInitializing && initializationPromise) {
      return await initializationPromise;
    }

    // If already initialized, just update token if needed and return
    if (isInitialized && messagingClient) {
      // Update token if provided and different
      if (userToken && userToken !== messagingClient.authToken) {
        messagingClient.authToken = userToken;

        // Update groupId
        try {
          const tokenPayload = JSON.parse(atob(userToken.split('.')[1]));
          const userId = tokenPayload.userId || tokenPayload.id;
          const groupId = `group-user-${userId}`;

          // Check if groupId changed - if so, clear old group keys and restart
          const oldGroupId = messagingClient.groupId;
          const groupIdChanged = oldGroupId && oldGroupId !== groupId;

          if (groupIdChanged) {
            // Clear group keys
            messagingClient.groupKeys = {};

            // Clear website public key (user-specific!)
            localStorage.removeItem('rev_messaging_public_key');

            // Stop polling old group
            messagingClient.stopPolling();
          }

          messagingClient.groupId = groupId;
          await window.MessagingStorage.saveGroupId(groupId);

          // Start polling if not already polling OR if group changed
          if (!messagingClient.isPolling || groupIdChanged) {
            startPollingWithRetry(messagingClient, groupId, userToken);
          }
        } catch (error) {
          console.error('[MessagingIntegration] ❌ Failed to update token:', error.message);
        }
      }

      return messagingClient;
    }

    // Mark as initializing and create promise
    isInitializing = true;
    initializationPromise = (async () => {
      try {
        // Extract userId from token for groupId (if token available)
        let groupId = null;
        let userId = null;

      if (userToken) {
        try {
          const tokenPayload = JSON.parse(atob(userToken.split('.')[1]));
          userId = tokenPayload.userId || tokenPayload.id;
          groupId = `group-user-${userId}`;
        } catch (error) {
          console.error('[MessagingIntegration] ❌ Could not parse token:', error.message);
        }
      }

      // Get messaging service URL from server
      const messagingServiceUrl = await getMessagingServiceUrl(origin);

      // Initialize client
      messagingClient = new window.MessagingClient({
        serviceUrl: messagingServiceUrl,
        pollInterval: 60000, // 60 seconds
        authToken: userToken || null
      });

      await messagingClient.initialize();

      // Set groupId and authToken if we have them
      if (groupId && userToken) {
        messagingClient.groupId = groupId;
        messagingClient.authToken = userToken;

        // Save groupId to storage
        await window.MessagingStorage.saveGroupId(groupId);
      }

      // Set up message handler
      messagingClient.onMessage = (message) => {
        handleMessage(message);
      };

      messagingClient.onError = (error) => {
        console.error('[MessagingIntegration] ❌ onError triggered:', error.message);
        // NOT_REGISTERED means the server no longer knows this client.
        // Only treat as account_deleted if we know this device was previously linked —
        // meaning it was registered and got revoked server-side.
        // If isLinked is false, the device is still in the registration flow and
        // NOT_REGISTERED just means the server hasn't processed the registration yet.
        if (error.code === 'NOT_REGISTERED') {
          if (isLinked) {
            handleAccountDeleted();
          } else {
            console.warn('[MessagingIntegration] ⚠️ NOT_REGISTERED but device not yet linked — ignoring');
          }
        }
      };

      // Start polling (client already registered during claim flow)
      if (groupId && userToken) {
        startPollingWithRetry(messagingClient, groupId, userToken);
      }

        isInitialized = true;
        isInitializing = false;
        initializationPromise = null;

        console.log('[MessagingIntegration] ✅ initMessaging SUCCESS', {
          fingerprint: messagingClient.fingerprint?.substring(0, 16) + '...'
        });

        return messagingClient;

      } catch (error) {
        console.error('[MessagingIntegration] ❌ Initialization failed:', error.message, error.stack);
        isInitialized = false;
        isInitializing = false;
        initializationPromise = null;
        return null;
      }
    })();

    return await initializationPromise;
  };

/**
 * Helper to safely show browser notifications
 */
function showNotification(title, message) {
  if (typeof browser !== 'undefined' && browser.notifications) {
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title,
      message
    });
  }
}

/**
 * Handle received message
 */
function handleMessage(message) {
  // Show browser notification
  showNotification('Neue Nachricht', `Typ: ${message.type}`);

  // Handle different message types
  switch (message.type) {
    case 'rating':
      // Check if payload contains RATING_SUMMARY or RATING_FULL
      if (message.payload && typeof message.payload === 'object') {
        if (message.payload.type === 'RATING_SUMMARY') {
          handleRatingSummaryMessage(message.payload.data);
        } else if (message.payload.type === 'RATING_FULL') {
          handleRatingFullMessage(message.payload);
        } else {
          // Legacy rating message
          handleRatingMessage(message.payload);
        }
      } else {
        handleRatingMessage(message.payload);
      }
      break;
    case 'rating_full':  // NEU: Für Webseite (fallback for direct type)
      handleRatingFullMessage(message.payload);
      break;
    case 'rating_summary':  // NEU: Für andere Devices (fallback for direct type)
      handleRatingSummaryMessage(message.payload);
      break;
    case 'address_update':
      handleAddressUpdate(message.payload);
      break;
    case 'key_rotation':
      handleKeyRotation(message.payload);
      break;
    case 'client_disconnected':
      handleClientDisconnect(message.payload);
      break;
    case 'device_registered':
    case 'device_registration':
      handleDeviceRegistered(message.payload);
      break;
    case 'feedback':
      handleFeedbackMessage(message.payload);
      break;
    case 'account_deleted':
      handleAccountDeleted();
      break;
    default:
      console.warn('[MessagingIntegration] ⚠️ Unknown message type:', message.type);
  }
}

/**
 * Handle feedback message from website.
 *
 * The MessagingClient already E2E-decrypts the message before calling onMessage,
 * so message.payload here is the plain feedback object — no additional decryption needed.
 *
 * Expected payload shape (matches what the website sends via /vault/feedback → DeviceMessage):
 *   { rating_ref, feedback_type, domain, submitted_at }
 */
async function handleFeedbackMessage(payload) {
  try {
    // Parse payload if it arrived as a JSON string
    let feedbackData = payload;
    if (typeof payload === 'string') {
      try { feedbackData = JSON.parse(payload); } catch (_) { feedbackData = payload; }
    }

    if (!feedbackData || !feedbackData.rating_ref || !feedbackData.feedback_type) {
      console.error('[MessagingIntegration] ❌ Invalid feedback payload:', feedbackData);
      return;
    }

    // Process via FeedbackManager
    if (typeof window.FeedbackManager === 'function') {
      const manager = new window.FeedbackManager();
      await manager.processFeedback(feedbackData);
    } else {
      console.warn('[MessagingIntegration] ⚠️ FeedbackManager not loaded, storing for later');
      const stored = await browser.storage.local.get('pending_feedback');
      const pending = stored.pending_feedback || [];
      pending.push(feedbackData);
      await browser.storage.local.set({ pending_feedback: pending });
    }
  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to handle feedback message:', error.message);
  }
}

/**
 * Handle device_registered message from website
 * Receives CL wallet and confirms device can start polling
 */
function handleDeviceRegistered(payload) {
  try {
    const { walletAddress, wallet_key, groupKeys, deviceId, userId } = payload;

    if (!walletAddress || !wallet_key) {
      console.error('[MessagingIntegration] ❌ Missing wallet data in registration confirmation');
      return;
    }

    // Ensure wallet address has CL:: prefix
    let normalizedWalletAddress = walletAddress;
    if (!normalizedWalletAddress.startsWith('CL::')) {
      normalizedWalletAddress = 'CL::' + normalizedWalletAddress;
    }

    // Store CL wallet in browser.storage.local
    browser.storage.local.set({
      'rev_cl_wallet': {
        address: normalizedWalletAddress,
        privateKey: wallet_key,
        receivedAt: Date.now()
      }
    }).catch(error => {
      console.error('[MessagingIntegration] ❌ Failed to store wallet:', error);
    });

    // Update group keys if provided
    if (groupKeys && groupKeys.length > 0 && messagingClient) {
      const groupKeyMap = {};
      groupKeys.forEach(key => {
        groupKeyMap[key.fingerprint] = {
          publicKey: key.publicKey,
          signingPublicKey: key.signingPublicKey
        };
      });

      messagingClient.groupKeys = groupKeyMap;
    }

    // Store message log
    storeMessageLog('device_registered', payload);

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Error handling device registration:', error);
  }
}

/**
 * Handle rating messages (LEGACY)
 */
function handleRatingMessage(payload) {
  storeMessageLog('rating', payload);
  // Rating messages are processed but don't require special handling
  // They are logged for debugging purposes
}

/**
 * Handle RATING_FULL messages (from executing device to website)
 */
function handleRatingFullMessage(payload) {
  storeMessageLog('rating_full', payload);
  // TODO: Store in local database for analytics
  // TODO: Send to website backend for matching
}

/**
 * Handle RATING_SUMMARY messages (from other devices)
 * SECURITY: Enthält NUR seedCLtoSH + transactionIndices + amounts
 * KEINE Domain, URL, oder andere sensiblen Daten
 */
async function handleRatingSummaryMessage(payload) {
  storeMessageLog('rating_summary', payload);

  try {
    // Validiere Payload
    if (!payload.seedCLtoSH || !payload.transactionIndices || !payload.amounts) {
      console.error('[MessagingIntegration] Invalid RATING_SUMMARY: missing required fields');
      return;
    }

    // Leite CL→SH Fingerprints aus Seed ab
    const fingerprints = [];
    const seedManager = new window.FingerprintSeedManager({ storage: browser.storage.local });

    for (let i = 0; i < payload.transactionIndices.length; i++) {
      const index = payload.transactionIndices[i];

      // Generiere CL→SH Fingerprint aus Seed
      const fingerprint = await seedManager.deriveFingerprintFromSeed(
        payload.seedCLtoSH,
        'CL_TO_SH',
        index
      );

      fingerprints.push({
        index: index,
        fingerprint: fingerprint,
        amount: payload.amounts[i],
        type: 'CL_TO_SH'
      });
    }

    // Speichere lokale Notification (OHNE Domain/URL)
    const notification = {
      ratingRef: payload.ratingRef,
      seedCLtoSH: payload.seedCLtoSH,
      fingerprints: fingerprints,
      totalTransactions: payload.transactionIndices.length,
      timestamp: payload.timestamp,
      receivedAt: Date.now(),
      source: 'other_device'
      // WICHTIG: Keine Domain, keine URL, keine Token-Summe
      // Device kennt NICHT welche Website besucht wurde
    };

    // Speichere in browser.storage für späteren Zugriff
    await storeRatingSummaryNotification(notification);

    // TODO: Display in UI (other device made a payment)
    // TODO: Optional: Query Central Ledger für Status der Fingerprints

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to process RATING_SUMMARY:', error);
  }
}

/**
 * Store RATING_SUMMARY notification in local storage
 * @param {Object} notification - Notification object
 */
async function storeRatingSummaryNotification(notification) {
  try {
    const data = await browser.storage.local.get(['rev_rating_summaries']);
    const summaries = data.rev_rating_summaries || [];

    // Füge neue Notification hinzu
    summaries.push(notification);

    // Behalte nur die letzten 100 Notifications
    const trimmedSummaries = summaries.slice(-100);

    await browser.storage.local.set({
      rev_rating_summaries: trimmedSummaries
    });

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to store notification:', error);
  }
}

/**
 * Handle ADDRESS_UPDATE message (Binary Sender/Receiver Model)
 *
 * ADDRESS_UPDATE enthält (Zero-Knowledge):
 * - CL wallet key (encrypted per recipient)
 * - Website's messaging_address + encryption_key
 * - All device messaging_addresses + encryption_keys
 * - Rating sum (last 30 days)
 */
async function handleAddressUpdate(payload) {
  try {
    // Verify signature from website (website.messaging_address = signingPublicKey)
    const { signature, cl_wallet_key, ...data } = payload;

    if (!signature) {
      console.error('[MessagingIntegration] ❌ No signature in ADDRESS_UPDATE message');
      return;
    }

    if (!data.website || !data.website.messaging_address) {
      console.error('[MessagingIntegration] ❌ No website info in ADDRESS_UPDATE message');
      return;
    }

    // Reconstruct the base payload that was signed (without signature and cl_wallet_key)
    const basePayload = {
      type: data.type,
      version: data.version,
      timestamp: data.timestamp,
      cl_wallet_address: data.cl_wallet_address,
      website: data.website,
      devices: data.devices,
      rating_sum: data.rating_sum,
      reason: data.reason
    };

    const dataString = JSON.stringify(basePayload);

    // Verify signature with website's messaging_address (= signingPublicKey)
    // Binary Model: messagingAddress = signingPublicKey directly
    const isValid = await window.MessagingCrypto.verifySignature(
      dataString,
      signature,
      data.website.messaging_address,
      sodium.base64_variants.URLSAFE_NO_PADDING
    );

    if (!isValid) {
      console.error('[MessagingIntegration] ❌ Invalid ADDRESS_UPDATE signature - ignoring!');
      showNotification('⚠️ Sicherheitswarnung', 'Ungültige ADDRESS_UPDATE Signatur erkannt!');
      return;
    }

    console.log('[MessagingIntegration] ✅ ADDRESS_UPDATE signature verified');

    // Decrypt CL wallet private key if present
    let clWalletPrivateKey = null;

    if (cl_wallet_key && cl_wallet_key.ciphertext && cl_wallet_key.nonce && messagingClient) {
      try {
        // Get our encryption private key
        const myEncryptionPrivateKey = messagingClient.keyPair.privateKey;
        const websiteEncryptionPublicKey = data.website.encryption_key;

        // Decrypt using X25519 box
        // ciphertext/nonce are URLSAFE_NO_PADDING (website-encoded)
        // websitePublicKey is URLSAFE_NO_PADDING (website-generated)
        // myPrivateKey is ORIGINAL base64 (addon-generated via sodium.to_base64 default)
        const ciphertextBytes = sodium.from_base64(cl_wallet_key.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        const nonceBytes = sodium.from_base64(cl_wallet_key.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
        const websitePublicKeyBytes = sodium.from_base64(websiteEncryptionPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        const myPrivateKeyBytes = sodium.from_base64(myEncryptionPrivateKey); // ORIGINAL variant (addon default)

        const decryptedBytes = sodium.crypto_box_open_easy(
          ciphertextBytes,
          nonceBytes,
          websitePublicKeyBytes,
          myPrivateKeyBytes
        );

        clWalletPrivateKey = new TextDecoder().decode(decryptedBytes);
      } catch (decryptError) {
        console.error('[MessagingIntegration] ❌ Failed to decrypt CL wallet key:', decryptError.message);
      }
    }

    // Store everything locally (Zero-Knowledge: all keys stored client-side, no server lookup)
    const storageData = {
      // Website keys
      'website_keys': {
        messaging_address: data.website.messaging_address,
        encryption_key: data.website.encryption_key
      },
      // All known devices (for message encryption without server lookup)
      'known_devices': data.devices || [],
      // Rating sum
      'rating_sum': data.rating_sum || '0',
      // Timestamp
      'last_address_update': Date.now()
    };

    // Store CL wallet if decrypted
    if (clWalletPrivateKey && data.cl_wallet_address) {
      // Ensure wallet address has CL:: prefix
      let normalizedWalletAddress = data.cl_wallet_address;
      if (!normalizedWalletAddress.startsWith('CL::')) {
        normalizedWalletAddress = 'CL::' + normalizedWalletAddress;
      }

      storageData['rev_cl_wallet'] = {
        address: normalizedWalletAddress,
        privateKey: clWalletPrivateKey,
        source: 'address_update'
      };

      console.log('[MessagingIntegration] 💾 CL Wallet stored from ADDRESS_UPDATE');
    } else {
      console.warn('[MessagingIntegration] ⚠️ CL Wallet NOT stored - missing private key or address');
    }

    // Save to browser storage
    await browser.storage.local.set(storageData);

    // Trigger wallet init if CL wallet was received
    if (clWalletPrivateKey) {
      // ALWAYS try to init/reload wallet when we receive an ADDRESS_UPDATE with wallet data
      // This ensures WalletManager is aware of the new wallet even if already initialized
      if (typeof window.retryWalletInitIfNeeded === 'function') {
        try {
          // If wallet is already initialized, we need to force a reload
          // by temporarily setting _walletInitialized to false
          const wasInitialized = window._walletInitialized;

          if (wasInitialized) {
            window._walletInitialized = false;
            window._walletInitFailed = false;
            window._walletInitError = null;
          }

          await window.retryWalletInitIfNeeded();
        } catch (error) {
          console.error('[MessagingIntegration] ❌ Failed to init wallets:', error);
        }
      } else {
        console.warn('[MessagingIntegration] ⚠️ retryWalletInitIfNeeded not yet available');
      }
    }

    // NEW: Set deviceStatus to 'linked' if we received wallet address
    // This allows transactions to work without DEVICE_REGISTRATION_RESPONSE

    // Get messaging address from storage if messagingClient not yet initialized
    let myMessagingAddress = messagingClient?.messagingAddress;
    if (!myMessagingAddress) {
      const stored = await browser.storage.local.get(['rev_messaging_address']);
      myMessagingAddress = stored.rev_messaging_address || null;
    }

    if (data.cl_wallet_address && myMessagingAddress) {
      // Find our own device in the devices list
      const myDevice = (data.devices || []).find(d => d.messaging_address === myMessagingAddress);

      // Load current state
      let currentState = {};
      if (typeof window.loadState === 'function') {
        currentState = await window.loadState() || {};
      } else {
        console.warn('[MessagingIntegration] ⚠️ loadState function not available, using empty state');
        currentState = window._revolutionState || {};
      }

      // Get encryption key from storage if client not yet initialized
      let encryptionKey = messagingClient?.keyPair?.publicKey;
      if (!encryptionKey) {
        const stored = await browser.storage.local.get(['rev_messaging_keypair']);
        encryptionKey = stored.rev_messaging_keypair?.publicKey || null;
      }

      // Create minimal device object for transaction queue
      const deviceObject = {
        walletAddress: data.cl_wallet_address,
        messagingAddress: myMessagingAddress,
        encryptionKey: encryptionKey,
        source: 'address_update',
        linkedAt: Date.now()
      };

      // Update state with linked status
      const updatedState = {
        ...currentState,
        device: deviceObject,
        deviceStatus: 'linked',
        deviceError: null
      };

      // Persist state using background.js persistState function
      if (typeof window.persistState === 'function') {
        await window.persistState(updatedState);
      } else {
        console.warn('[MessagingIntegration] ⚠️ persistState function not available');
      }
    }

    // Update messagingClient.groupKeys so TransactionQueue can find the website (role: "admin")
    if (messagingClient && data.website?.messaging_address) {
      messagingClient.groupKeys = messagingClient.groupKeys || {};

      // Website as admin
      messagingClient.groupKeys[data.website.messaging_address] = {
        publicKey: data.website.encryption_key,
        signingPublicKey: data.website.messaging_address,
        role: 'admin'
      };

      // Other devices (excluding self)
      const myAddr = messagingClient.messagingAddress;
      for (const device of (data.devices || [])) {
        if (device.messaging_address && device.messaging_address !== myAddr) {
          messagingClient.groupKeys[device.messaging_address] = {
            publicKey: device.encryption_key,
            signingPublicKey: device.messaging_address,
            role: 'device'
          };
        }
      }
    }

    // Show notification
    const hasWallet = clWalletPrivateKey ? ' (inkl. Wallet-Daten)' : '';
    showNotification('🔑 Adressbuch aktualisiert', `${(data.devices || []).length} Geräte empfangen${hasWallet}`);

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to handle ADDRESS_UPDATE:', error.message, error.stack);
  }
}

/**
 * Handle key rotation
 */
async function handleKeyRotation(payload) {
  if (!messagingClient) {
    console.error('[MessagingIntegration] ❌ No messaging client available');
    return;
  }

  try {
    // Find our encrypted payload
    const myFingerprint = messagingClient.fingerprint;
    const myPayload = payload[myFingerprint];

    if (!myPayload || !myPayload.ciphertext || !myPayload.nonce) {
      console.warn('[MessagingIntegration] ⚠️ No encrypted payload for our client in key_rotation');
      return;
    }

    // Decrypt the payload (it should contain the new group keys)
    const decrypted = await window.MessagingCrypto.decryptMessage(
      myPayload.ciphertext,
      myPayload.nonce,
      messagingClient.keyPair.publicKey,  // Our public key
      messagingClient.keyPair.privateKey   // Our private key (self-encrypted)
    );

    const groupKeys = JSON.parse(decrypted);

    // Update our group keys
    messagingClient.groupKeys = groupKeys;

    showNotification('Schlüssel-Rotation', `Gruppen-Schlüssel aktualisiert (${Object.keys(groupKeys).length} Mitglieder)`);

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to handle key_rotation:', error.message, error.stack);
    showNotification('⚠️ Fehler', 'Konnte Schlüssel-Rotation nicht verarbeiten');
  }
}

/**
 * Handle account_deleted system message from server.
 * Stops polling, clears all local state and storage — equivalent to a forced logout.
 */
async function handleAccountDeleted() {
  console.warn('[MessagingIntegration] 🗑️ account_deleted received — clearing addon state');

  // Stop polling immediately so no further requests go out
  if (messagingClient) {
    messagingClient.stopPolling();
  }

  showNotification('Konto gelöscht', 'Dein Konto wurde gelöscht. Du wirst abgemeldet.');

  try {
    // Delegate full logout to background.js if available
    if (typeof window.performLogout === 'function') {
      await window.performLogout();
    } else {
      // Fallback: clear state directly
      if (typeof window.persistState === 'function' && typeof window.createState === 'function') {
        await window.persistState(window.createState({}));
      }
      if (typeof window.MessagingIntegration?.clearAllData === 'function') {
        await window.MessagingIntegration.clearAllData();
      }
    }
  } catch (err) {
    console.error('[MessagingIntegration] ❌ handleAccountDeleted cleanup failed:', err.message);
  }
}

/**
 * Handle client disconnect
 * Removes disconnected client from local group keys
 */
function handleClientDisconnect(payload) {
  if (!payload || !payload.fingerprint) {
    console.error('[MessagingIntegration] ❌ Invalid client_disconnected message: missing fingerprint');
    return;
  }

  // Remove client from local groupKeys
  if (messagingClient && messagingClient.groupKeys) {
    if (messagingClient.groupKeys[payload.fingerprint]) {
      delete messagingClient.groupKeys[payload.fingerprint];

      // Show notification
      const reasonText = payload.reason === 'logout' ? 'abgemeldet' :
                        payload.reason === 'profile_switch' ? 'hat Profil gewechselt' :
                        'getrennt';
      showNotification('Client getrennt', `Ein Client wurde ${reasonText}`);
    }
  } else {
    console.warn('[MessagingIntegration] ⚠️ No messagingClient available for client disconnect');
  }
}

/**
 * Store message in local storage for debugging
 */
async function storeMessageLog(type, payload) {
  try {
    const { messaging_log = [] } = await browser.storage.local.get('messaging_log');

    const logEntry = {
      type,
      payload,
      timestamp: Date.now()
    };

    messaging_log.unshift(logEntry);

    // Keep only last 100 messages
    if (messaging_log.length > 100) {
      messaging_log.splice(100);
    }

    await browser.storage.local.set({ messaging_log });
  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to store message log:', error.message);
  }
}

/**
 * Send a message to the group
 */
window.MessagingIntegration.sendMessage = async function(payload, type) {
  type = type || 'rating';

  if (!messagingClient || !isInitialized) {
    throw new Error('Messaging not initialized');
  }

  return await messagingClient.sendMessage(payload, type);
};

/**
 * Stop messaging (cleanup)
 */
window.MessagingIntegration.stopMessaging = function() {
  if (messagingClient) {
    messagingClient.stopPolling();
    messagingClient = null;
    isInitialized = false;
  }
};

/**
 * Get messaging client instance
 */
window.MessagingIntegration.getClient = function() {
  if (!messagingClient || !isInitialized) {
    return null;
  }
  return messagingClient;
};

/**
 * Get messaging client info
 */
window.MessagingIntegration.getMessagingInfo = function() {
  if (!messagingClient) {
    return null;
  }

  return messagingClient.getInfo();
};

/**
 * Clear all messaging data (called on logout)
 */
window.MessagingIntegration.clearAllData = async function() {
  try {
    // Stop polling first
    if (messagingClient) {
      messagingClient.stopPolling();

      // Clear group keys
      messagingClient.groupKeys = {};
      messagingClient.groupId = null;
    }

    // Delete from storage
    if (window.MessagingStorage) {
      await window.MessagingStorage.clearAll();
    }

    // Reset state
    isInitialized = false;
    messagingClient = null;

  } catch (error) {
    console.error('[MessagingIntegration] ❌ Failed to clear messaging data:', error);
    throw error;
  }
};

  /**
   * Check if messaging is initialized
   */
  window.MessagingIntegration.isMessagingInitialized = function() {
    return isInitialized && messagingClient !== null;
  };

  // Call this once the device has been confirmed registered with the messaging service
  // (i.e. after DEVICE_REGISTRATION_RESPONSE with messaging_registered: true, or on
  // addon startup when state.deviceStatus === 'linked').
  // After this point, NOT_REGISTERED errors are treated as account deletion.
  window.MessagingIntegration.setLinked = function() {
    isLinked = true;
  };

})();
