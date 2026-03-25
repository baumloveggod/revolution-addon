// Tracking-Modul wird automatisch durch manifest.json geladen

const STORAGE_KEY = 'rev_connector_state';
const SITE_ORIGINS = ['https://api.lenkenhoff.de'];
const INSTALL_REDIRECT_PATH = '/account.html?addon=firefox';
const LOGIN_PATH = '/login.html';
const manifest = typeof browser !== 'undefined' && browser.runtime && browser.runtime.getManifest
  ? browser.runtime.getManifest()
  : { version: 'dev', manifest_version: 2 };
const ADDON_VERSION = (manifest && manifest.version) || 'dev';
const DEVICE_NAME = `Firefox Add-on${ADDON_VERSION ? ` v${ADDON_VERSION}` : ''}`;
const DEVICE_TYPE = 'browser_addon';
const DEVICE_METADATA = Object.freeze({
  device_type: DEVICE_TYPE,
  addon: 'firefox',
  addon_version: ADDON_VERSION,
  manifest_version: (manifest && manifest.manifest_version) || 2,
  autonomous: true,  // Device arbeitet vollständig autonom
  platform: typeof navigator !== 'undefined' ? navigator.userAgent : null
});

/**
 * Shows a browser notification to the user
 */
function notifyUser(title, message, type = 'basic') {
  if (typeof browser !== 'undefined' && browser.notifications) {
    browser.notifications.create({
      type: type,
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: title,
      message: message
    });
  }
}

let cachedState = null;
let lastOriginHint = null;
let linkingPromise = null;
let linkingUserId = null;  // Track which user the linkingPromise is for
let linkingInProgress = false;  // Synchronous flag to prevent race conditions
let lastProcessedToken = null;

function createState(overrides = {}) {
  return {
    userToken: null,
    profile: null,
    origin: null,
    syncedAt: null,
    pendingSwitch: null,
    device: null,
    deviceStatus: 'idle',
    deviceError: null,
    deviceErrorDetails: null,  // { code, message, timestamp, retryable, httpStatus }
    deviceLinkingStartTime: null,
    deviceErrorTime: null,
    ...overrides
  };
}

async function loadState() {
  if (cachedState) {
    // Check if userToken is expired
    if (cachedState.userToken && isTokenExpired(cachedState.userToken)) {
      console.warn('[loadState] ⚠️ userToken expired, clearing profile and CL wallet');
      cachedState = {
        ...cachedState,
        userToken: null,
        profile: null
      };
      await persistState(cachedState);
    }
    return cachedState;
  }
  const stored = await browser.storage.local.get(STORAGE_KEY);
  let loadedState = stored[STORAGE_KEY] || null;

  // Check if userToken is expired when loading from storage
  if (loadedState && loadedState.userToken && isTokenExpired(loadedState.userToken)) {
    console.warn('[loadState] ⚠️ userToken expired (from storage), clearing profile and CL wallet');
    loadedState = {
      ...loadedState,
      userToken: null,
      profile: null
    };
    await persistState(loadedState);
  }

  cachedState = loadedState;
  if (cachedState && cachedState.origin) {
    lastOriginHint = cachedState.origin;
  }

  // ZERO-KNOWLEDGE: Expose state globally for transaction guard checks
  window._revolutionState = cachedState;

  return cachedState;
}

/**
 * Initialize wallet dependencies globally
 * CRITICAL: Required for TransactionQueue to execute transactions
 */
async function initializeWalletDependencies() {
  if (typeof WalletManager === 'undefined' || typeof AnonTransactionClient === 'undefined') {
    console.error('[initWallets] Wallet classes not loaded! Check manifest.json');
    return false;
  }

  if (!window._walletManager) {
    window._walletManager = new WalletManager({
      clApiUrl:     'https://ledger.lenkenhoff.de',
      clReadApiUrl: 'https://read.lenkenhoff.de',
      storage:      browser.storage.local,
      fetch:        window.fetchWithVersion
    });
  }

  if (!window._anonClient) {
    window._anonClient = new AnonTransactionClient({
      anonApiUrl:   'https://ledger.lenkenhoff.de/anon',
      clApiUrl:     'https://ledger.lenkenhoff.de',
      clReadApiUrl: 'https://read.lenkenhoff.de',
      fetch:        window.fetchWithVersion,
      sodium:       window.sodium
    });
  }

  return true;
}

async function persistState(newState) {
  cachedState = newState || null;

  // ZERO-KNOWLEDGE: Expose state globally for transaction guard checks
  window._revolutionState = cachedState;

  if (!newState) {
    await browser.storage.local.remove(STORAGE_KEY);
    return;
  }
  await browser.storage.local.set({ [STORAGE_KEY]: newState });
}

// Expose persistState and loadState globally for messaging-integration.js
window.persistState = persistState;
window.loadState = loadState;

// Global reference to RetroPayoutService
let retroPayoutService = null;

// Initialize addon on load
(async function initAddon() {
  // Initialize wallet dependencies IMMEDIATELY
  const walletsReady = await initializeWalletDependencies();
  if (!walletsReady) {
    console.error('[background.js] ❌ Failed to initialize wallets!');
  }

  // Process pending queue if device linked
  const state = await loadState();
  if (state?.device && state.deviceStatus === 'linked' && walletsReady) {
    setTimeout(() => {
      if (window.transactionQueue) {
        window.transactionQueue.processPendingQueue();
      }
    }, 1000);
  }

  // START: Retro Payout Service (Background Job)
  // Starts after 5 seconds to avoid blocking addon initialization
  setTimeout(async () => {
    try {
      if (typeof RetroPayoutService === 'undefined') {
        console.warn('[background.js] RetroPayoutService not loaded');
        return;
      }

      // Wait for revolution scoring to be initialized
      if (!window.revolution) {
        console.warn('[background.js] Revolution scoring not initialized yet, deferring RetroPayoutService start');
        return;
      }

      const messagingClient = window.MessagingIntegration?.getClient();
      if (!messagingClient) {
        console.warn('[background.js] Messaging client not available, deferring RetroPayoutService start');
        return;
      }

      retroPayoutService = new RetroPayoutService(
        window.revolution.distributionEngine,
        window.revolution.distributionEngine.translationFactorTracker,
        messagingClient
      );

      retroPayoutService.start();

    } catch (error) {
      console.error('[background.js] ❌ Failed to start RetroPayoutService:', error);
    }
  }, 5000);  // 5 seconds delay
})();

function resolveOrigin(rawUrl) {
  if (!rawUrl) return null;
  try {
    const origin = new URL(rawUrl).origin;
    if (SITE_ORIGINS.includes(origin)) {
      lastOriginHint = origin;
      return origin;
    }
    return null;
  } catch (err) {
    console.warn('[revolution-addon] Ungültige URL erhalten', err);
    return null;
  }
}

function decodeJwtPayload(token) {
  if (!token) return null;
  const segments = token.split('.');
  if (segments.length < 2) return null;
  const payload = segments[1];
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = atob(normalized + padding);
    return JSON.parse(decoded);
  } catch (err) {
    console.warn('[revolution-addon] JWT konnte nicht dekodiert werden', err);
    return null;
  }
}

function buildProfileFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const userId = payload.userId ?? payload.user_id ?? payload.sub ?? payload.id ?? null;
  return {
    userId,
    username: payload.username ?? payload.name ?? payload.user ?? null,
    role: payload.role ?? null,
    accountType: payload.accountType ?? payload.account_type ?? null,
    clientWallet: payload.clientWallet ?? null,
    // SECURITY: Private/Public Keys NICHT mehr aus JWT
    // Addon generiert eigene Wallet-Keys lokal oder via Device-Onboarding
    // clientWalletPrivateKey: payload.clientWalletPrivateKey ?? null,  // REMOVED
    // clientWalletPublicKey: payload.clientWalletPublicKey ?? null,    // REMOVED
    exp: payload.exp ?? null,
    issuedAt: payload.iat ?? null
  };
}

function computeExpiryIso(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) {
    return null;
  }
  const millis = Number(payload.exp) * 1000;
  if (!Number.isFinite(millis)) {
    return null;
  }
  return new Date(millis).toISOString();
}

function isTokenExpired(token) {
  if (!token) {
    return true;
  }
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) {
    return true;
  }
  const expMillis = Number(payload.exp) * 1000;
  if (!Number.isFinite(expMillis)) {
    return true;
  }
  const nowMillis = Date.now();
  return nowMillis >= expMillis;
}

function isClientSessionValid(client) {
  if (!client || !client.sessionToken) {
    return false;
  }
  if (!client.sessionExpiresAt) {
    return true;
  }
  const ts = Date.parse(client.sessionExpiresAt);
  if (Number.isNaN(ts)) {
    return true;
  }
  const remaining = ts - Date.now();
  return remaining > 60 * 1000; // at least 60s Restlaufzeit
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (!response.ok) {
    const errorMessage = data && data.error ? data.error : `Request fehlgeschlagen (${response.status})`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.data = data;

    // Auto-logout: User existiert nicht mehr in der DB
    const isAuthenticatedRequest = options.headers && (
      options.headers['Authorization'] || options.headers['authorization']
    );
    const isUserGone = response.status === 401 && data?.error === 'account_not_found';
    if (isAuthenticatedRequest && isUserGone) {
      console.warn('[revolution-addon] account_not_found → auto-logout');
      persistState(createState({})).catch(() => {});
    }

    throw error;
  }
  return data;
}

function buildAuthHeaders(token, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${token}`
  };
}

function ensureJsonHeaders(headers = {}) {
  return {
    'Content-Type': 'application/json',
    ...headers
  };
}

async function createInvite(origin, userToken, profile) {
  const desiredName = profile && profile.username ? `${DEVICE_NAME} (${profile.username})` : DEVICE_NAME;
  const body = {
    type: 'browser_addon',
    desiredName,
    expires_minutes: 10,
    metadata: {
      ...DEVICE_METADATA,
      issued_at: new Date().toISOString()
    }
  };
  return fetchJson(`${origin}/devices/invite`, {
    method: 'POST',
    headers: buildAuthHeaders(userToken, ensureJsonHeaders()),
    body: JSON.stringify(body)
  });
}

async function claimInvite(origin, inviteToken, userToken) {
  // Log claim start
  if (typeof window.LogClient !== 'undefined') {
    window.LogClient.sendLog('browser-addon', 'claim_start', 'Starting client claim', {
      origin,
      hasInviteToken: !!inviteToken,
      hasUserToken: !!userToken
    }, 'info');
  }

  // Initialize messaging client ALWAYS before claim with the userToken
  // This generates keys locally even if messaging server is offline
  let messagingKeys = null;
  try {
    await window.MessagingIntegration.initMessaging(userToken, origin);

    const info = window.MessagingIntegration.getMessagingInfo();
    // Binary Model: messagingAddress = signingPublicKey, encryptionKey = publicKey
    if (info && info.encryptionPublicKey && info.signingPublicKey && info.messagingAddress) {
      messagingKeys = {
        messaging_address: info.messagingAddress,              // = signingPublicKey
        messaging_encryption_key: info.encryptionPublicKey     // = publicKey
      };

      // Log successful key generation
      if (typeof window.LogClient !== 'undefined') {
        window.LogClient.sendLog('browser-addon', 'keys_ready_for_claim', 'Messaging keys generated and ready for claim', {
          encryptionKeyLength: info.encryptionPublicKey.length,
          messagingAddress: info.messagingAddress.substring(0, 20) + '...'
        }, 'success');
      }
    }
  } catch (error) {
    // Log error but continue - messaging is optional
    if (typeof window.LogClient !== 'undefined') {
      window.LogClient.sendLog('browser-addon', 'keys_init_failed', 'Messaging initialization failed: ' + error.message, {
        errorMessage: error.message
      }, 'warning');
    }
  }

  // NEW: postMessage-based registration (Website orchestrator pattern)
  // Send registration request to website via content script

  if (!messagingKeys) {
    throw new Error('Messaging keys are required for device registration');
  }

  const registrationRequest = {
    type: 'DEVICE_REGISTRATION_REQUEST',
    inviteToken: inviteToken,
    deviceName: DEVICE_NAME,
    deviceType: 'browser_addon',
    metadata: {
      ...DEVICE_METADATA,
      claimed_at: new Date().toISOString()
    },
    // Binary Model: messagingAddress = signingPublicKey, encryptionKey = publicKey
    messagingAddress: messagingKeys.messaging_address,
    encryptionKey: messagingKeys.messaging_encryption_key,
    timestamp: Date.now()
  };

  if (typeof window.LogClient !== 'undefined') {
    window.LogClient.sendLog('browser-addon', 'registration_request_sent', 'Device registration request sent to website', {
      messagingAddress: messagingKeys.messaging_address.substring(0, 20) + '...'
    }, 'info');
  }

  // Get website tab (must be api.lenkenhoff.de or configured origin)
  const allTabs = await browser.tabs.query({});
  const websiteTab = allTabs.find(tab =>
    tab.url && (
      tab.url.startsWith('https://api.lenkenhoff.de') ||
      tab.url.startsWith(origin)
    )
  );

  if (!websiteTab) {
    throw new Error('Website tab not found - please open the website at ' + origin);
  }

  const tabId = websiteTab.id;
  const tabUrl = websiteTab.url;

  // Check if website registration handler is ready
  let handlerReady = false;
  const maxReadyAttempts = 10; // Try for up to 10 seconds

  for (let attempt = 0; attempt < maxReadyAttempts; attempt++) {
    try {
      const readyCheck = await browser.tabs.sendMessage(tabId, {
        type: 'CHECK_REGISTRATION_HANDLER_READY'
      });

      if (readyCheck && readyCheck.ready) {
        handlerReady = true;
        break;
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      }
    } catch (err) {
      console.warn(`[claimInvite] ⚠️ Ready check failed (attempt ${attempt + 1}):`, err.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  if (!handlerReady) {
    throw new Error('Website registration handler not ready - please reload the website page and try again');
  }

  // Send to content script, which will forward to website via postMessage
  try {
    await browser.tabs.sendMessage(tabId, registrationRequest);
  } catch (err) {
    console.error('[claimInvite] ❌ Failed to send to content script:', err.message);
    throw new Error('Cannot communicate with website tab - please reload the page and try again');
  }

  // Wait for response from website
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.runtime.onMessage.removeListener(responseHandler);
      reject(new Error('Device registration timeout - website did not respond within 30 seconds'));
    }, 30000); // 30 second timeout

    // Listen for response from content script
    const responseHandler = (message, sender) => {
      if (message.type === 'DEVICE_REGISTRATION_RESPONSE' &&
          message.messagingAddress === messagingKeys.messaging_address) {

        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(responseHandler);

        if (message.status === 'success') {
          if (typeof window.LogClient !== 'undefined') {
            window.LogClient.sendLog('browser-addon', 'registration_success', 'Device registered successfully by website', {
              messagingAddress: messagingKeys.messaging_address,
              hasWallet: !!(message.data.wallet_address && message.data.wallet_key)
            }, 'success');
          }
          // Device is now registered with messaging service — NOT_REGISTERED from here on = real revocation
          if (message.data.messaging_registered) {
            window.MessagingIntegration?.setLinked?.();
          }
          resolve(message.data);
        } else {
          console.error('[claimInvite] ❌ Registration failed:', message.error);
          reject(new Error(message.error || 'Device registration failed'));
        }
      }
    };

    browser.runtime.onMessage.addListener(responseHandler);
  });
}

async function obtainClientSession(origin, clientToken) {
  return fetchJson(`${origin}/auth/device-session`, {
    method: 'POST',
    headers: ensureJsonHeaders(),
    body: JSON.stringify({ client_token: clientToken })
  });
}

async function createClientContext(state) {
  if (!state || !state.userToken) {
    throw new Error('user_token_missing');
  }
  const origin = state.origin || pickKnownOrigin();

  try {
    if (typeof window.LogClient !== 'undefined') {
      window.LogClient.sendLog('browser-addon', 'client_linking_start', 'Starting client linking process', {
        userId: state.profile?.userId
      }, 'info');
    }

    const invite = await createInvite(origin, state.userToken, state.profile);

    if (!invite || !invite.invite_token) {
      throw new Error('invite_failed');
    }

    const claim = await claimInvite(origin, invite.invite_token, state.userToken);

    if (!claim || !claim.client_token) {
      throw new Error('claim_failed');
    }

    // Load bootstrap keys into messaging client if provided
    if (claim.groupKeys && Array.isArray(claim.groupKeys)) {
      try {
        const messagingClient = window.MessagingIntegration.getClient();

        if (!messagingClient) {
          console.error('[revolution-addon] ❌ MessagingClient not available for bootstrap keys!');

          if (typeof window.LogClient !== 'undefined') {
            window.LogClient.sendLog('browser-addon', 'bootstrap_keys_no_client',
              'MessagingClient not available for bootstrap keys', {
                keyCount: claim.groupKeys.length
              }, 'error');
          }
          throw new Error('MessagingClient not initialized');
        }

        // Clear existing keys (defensive)
        messagingClient.groupKeys = {};

        // Load all bootstrap keys with validation
        let loadedCount = 0;
        for (const key of claim.groupKeys) {
          if (!key.fingerprint || !key.publicKey || !key.signingPublicKey) {
            console.warn('[revolution-addon] ⚠️ Skipping invalid key', {
              hasFingerprint: !!key.fingerprint,
              hasPublicKey: !!key.publicKey,
              hasSigningKey: !!key.signingPublicKey
            });
            continue;
          }

          messagingClient.groupKeys[key.fingerprint] = {
            publicKey: key.publicKey,
            signingPublicKey: key.signingPublicKey
          };
          loadedCount++;
        }

        // Verify keys actually loaded
        if (loadedCount === 0) {
          console.error('[revolution-addon] ❌ No valid keys loaded from bootstrap!');
          throw new Error('No valid bootstrap keys');
        }

        // Start polling
        messagingClient.startPolling();

        // CRITICAL: Poll immediately to receive ADDRESS_UPDATE sent by website during registration
        // Without this, the addon would wait up to 30 seconds for the first poll
        setTimeout(async () => {
          try {
            await messagingClient.poll();
          } catch (error) {
            console.error('[revolution-addon] ⚠️ Initial poll failed:', error.message);
          }
        }, 1000); // Wait 1 second to ensure website has sent ADDRESS_UPDATE

        if (typeof window.LogClient !== 'undefined') {
          window.LogClient.sendLog('browser-addon', 'bootstrap_keys_loaded',
            'Bootstrap keys loaded successfully', {
              keyCount: loadedCount
            }, 'success');
        }
      } catch (error) {
        console.error('[revolution-addon] ❌ Failed to load bootstrap keys:', error.message);

        if (typeof window.LogClient !== 'undefined') {
          window.LogClient.sendLog('browser-addon', 'bootstrap_keys_failed',
            'Failed to load bootstrap keys: ' + error.message, {
              errorMessage: error.message,
              stackTrace: error.stack
            }, 'error');
        }
        // Don't throw - continue with claim even if bootstrap keys fail
      }
    } else {
      console.warn('[revolution-addon] ⚠️ No bootstrap keys in claim response', {
        hasGroupKeys: 'groupKeys' in claim,
        groupKeysIsArray: Array.isArray(claim.groupKeys),
        groupKeysType: typeof claim.groupKeys
      });

      if (typeof window.LogClient !== 'undefined') {
        window.LogClient.sendLog('browser-addon', 'bootstrap_keys_missing',
          'No bootstrap keys in claim response', {}, 'warning');
      }
    }

    // Server now returns only snake_case
    const clientId = claim.client_id;
    const walletAddress = claim.wallet_address;

    if (typeof window.LogClient !== 'undefined') {
      window.LogClient.sendLog('browser-addon', 'client_linked', 'Client successfully linked (Zero-Knowledge)', {
        userId: state.profile?.userId,
        clientId: clientId,
        hasWallet: !!walletAddress
      }, 'success');
    }

    // Create initial device context
    const deviceContext = {
      userId: (state.profile && state.profile.userId) || null,
      clientId: clientId,
      clientToken: claim.client_token,
      sessionToken: null, // Will be set by refreshClientSession
      sessionExpiresAt: null,
      linkedAt: new Date().toISOString(),
      walletAddress: walletAddress
    };

    // Get proper device session token (includes deviceId in JWT)
    return await refreshClientSession(origin, deviceContext);
  } catch (error) {
    console.error('[revolution-addon] Client context creation failed:', error.message);
    if (typeof window.LogClient !== 'undefined') {
      window.LogClient.sendLog('browser-addon', 'client_linking_failed', 'Client linking failed: ' + error.message, {
        errorMessage: error.message,
        userId: state.profile?.userId
      }, 'error');
    }
    throw error;
  }
}

async function refreshClientSession(origin, clientContext) {
  if (!clientContext || !clientContext.clientToken) {
    const err = new Error('client_token_missing');
    err.code = 'client_token_missing';
    throw err;
  }
  const session = await obtainClientSession(origin, clientContext.clientToken);
  if (!session || !session.token) {
    const err = new Error('client_session_missing');
    err.code = 'client_session_missing';
    throw err;
  }
  return {
    ...clientContext,
    sessionToken: session.token,
    sessionExpiresAt: computeExpiryIso(session.token),
    lastSessionRefresh: new Date().toISOString()
  };
}

async function ensureClientContext(state, persistFn = async () => {}) {
  if (!state || !state.userToken || state.pendingSwitch) {
    return state;
  }

  // Detect stuck linking state (linking for more than 30 seconds)
  if (state.deviceStatus === 'linking' && state.clientLinkingStartTime) {
    const linkingDuration = Date.now() - state.clientLinkingStartTime;
    if (linkingDuration > 30000) {
      console.warn('[ensureClientContext] Linking stuck for', linkingDuration, 'ms - resetting to idle and retrying');
      // Reset stuck linking state
      const resetState = {
        ...state,
        deviceStatus: 'idle',
        deviceError: null,
        deviceErrorDetails: null,
        clientLinkingStartTime: null
      };
      // Clear stuck linkingPromise
      linkingPromise = null;
      linkingUserId = null;
      linkingInProgress = false;
      // Retry with reset state
      return ensureClientContext(resetState, persistFn);
    }
  }
  const origin = state.origin || pickKnownOrigin();
  const userId = (state.profile && state.profile.userId) || null;
  const existingClient = state.device;

  if (existingClient && existingClient.userId === userId) {
    if (isClientSessionValid(existingClient)) {
      return {
        ...state,
        deviceStatus: 'linked',
        deviceError: null
      };
    }
    try {
      const refreshed = await refreshClientSession(origin, existingClient);
      return {
        ...state,
        device: refreshed,
        deviceStatus: 'linked',
        deviceError: null
      };
    } catch (error) {
      if (error.status === 404 || error.code === 'client_session_missing') {
        const cleared = {
          ...state,
          device: null,
          deviceStatus: 'idle',
          deviceError: null
        };
        return ensureClientContext(cleared, persistFn);
      }
      return {
        ...state,
        deviceStatus: 'error',
        deviceError: (error && (error.message || error.code)) || 'session_refresh_failed'
      };
    }
  }

  // Old error-handling logic removed - we now use deviceErrorDetails below (line 565-583)

  if (linkingPromise && linkingUserId === userId) {
    // Only wait for linkingPromise if it's for the SAME user
    try {
      const resultState = await linkingPromise;
      if (resultState && resultState.profile && resultState.profile.userId === userId) {
        return resultState;
      }
    } catch (errorState) {
      if (errorState && errorState.clientStatus === 'error') {
        return errorState;
      }
    }
  } else if (linkingPromise && linkingUserId !== userId) {
    // Different user - cancel old linkingPromise and start fresh
    linkingPromise = null;
    linkingUserId = null;
    linkingInProgress = false;
  }

  // Handle error state with auto-retry
  if (state.deviceStatus === 'error' && state.deviceErrorDetails) {
    const timeSinceError = Date.now() - (state.deviceErrorTime || 0);

    // NEVER auto-retry rate limit errors (429) - user must wait or manually retry
    const isRateLimitError = state.deviceErrorDetails.httpStatus === 429 ||
                            state.deviceError?.includes('Zu viele Versuche');

    // Retry only if error is retryable AND cooldown has passed AND not a rate limit error
    const shouldRetry = state.deviceErrorDetails.retryable &&
                       !isRateLimitError &&
                       timeSinceError > 10000; // Wait at least 10 seconds

    if (shouldRetry) {
      // Clear error and try again
      const clearedState = {
        ...state,
        deviceStatus: 'idle',
        deviceError: null,
        deviceErrorDetails: null,
        deviceErrorTime: null
      };
      return ensureClientContext(clearedState, persistFn);
    }

    return state;
  }

  // CRITICAL: Check synchronous flag to prevent race conditions
  if (linkingInProgress) {
    // Return state with 'linking' status so TransactionQueue knows to wait
    const linkingStateForWait = {
      ...state,
      deviceStatus: 'linking',
      deviceError: null
    };
    // Persist immediately so window._revolutionState is updated
    await persistFn(linkingStateForWait);
    return linkingStateForWait;
  }

  // Set synchronous flag IMMEDIATELY to prevent concurrent linking attempts
  linkingInProgress = true;

  const linkingState = {
    ...state,
    deviceStatus: 'linking',
    deviceError: null,
    clientLinkingStartTime: Date.now()
  };
  await persistFn(linkingState);
  linkingUserId = userId;  // Track which user we're linking for
  linkingPromise = (async () => {
    try {
      const context = await createClientContext(linkingState);
      const finalState = {
        ...linkingState,
        device: context,
        deviceStatus: 'linked',
        deviceError: null
      };
      await persistFn(finalState);

      // NEW: Publish Messaging Keys to Website-localStorage after successful linking
      setTimeout(() => {
        publishMessagingKeysToWebsite().catch(err => {
          console.warn('[ensureClientContext] Failed to publish keys:', err);
        });
      }, 1000); // Wait 1s until tab is fully loaded

      return finalState;
    } catch (error) {
      console.error('[revolution-addon] ❌ Linking failed:', error.message);

      // Structure error details
      const errorDetails = {
        code: error.code || error.name || 'LINK_FAILED',
        message: error.message || 'Unbekannter Fehler',
        timestamp: Date.now(),
        retryable: !['FORBIDDEN', 'UNAUTHORIZED'].includes(error.status),
        httpStatus: error.status || null,
        stack: error.stack // For debugging
      };

      const failedState = {
        ...linkingState,
        deviceStatus: 'error',
        deviceError: errorDetails.message,
        deviceErrorDetails: errorDetails,
        deviceErrorTime: Date.now()
      };

      await persistFn(failedState);

      // Log detailed error
      if (typeof window.LogClient !== 'undefined') {
        window.LogClient.sendLog('browser-addon', 'client_linking_failed',
          'Client linking failed: ' + errorDetails.message,
          errorDetails, 'error');
      }

      throw failedState;
    }
  })();
  try {
    const resolvedState = await linkingPromise;
    return resolvedState;
  } catch (stateAfterError) {
    return stateAfterError;
  } finally {
    linkingPromise = null;
    linkingUserId = null;
    linkingInProgress = false;  // Clear synchronous flag
  }
}

async function handlePageTokenMessage(message, sender) {
  const senderUrl = sender && sender.url;
  const senderTabUrl = sender && sender.tab ? sender.tab.url : null;
  const sourceUrl = (message && message.url) || senderUrl || senderTabUrl;
  const origin = resolveOrigin(sourceUrl);

  if (!origin) {
    return { ok: false, reason: 'origin_not_allowed' };
  }
  const token = message && message.token;
  if (!token) {
    // Clear state when website logs out
    const existingState = await loadState();
    if (existingState && existingState.userToken) {
      const clearedState = createState({
        origin: existingState.origin
      });
      await persistState(clearedState);
      return { ok: true, status: 'logged_out_state_cleared' };
    }
    return { ok: true, status: 'no_token_no_state' };
  }

  // CRITICAL: Prevent concurrent linking attempts
  if (linkingPromise) {
    return { ok: true, status: 'linking_in_progress_skipped' };
  }

  // Check if we need to process (skip debouncing if client not linked)
  const existingState = await loadState();
  const needsLinking = !existingState || !existingState.device || existingState.deviceStatus === 'error';

  // Enhanced debouncing: Skip if token unchanged AND client is already linked
  // OR if we have a valid existing state with the same token AND client is already linked
  if ((token === lastProcessedToken && !needsLinking) ||
      (existingState && existingState.userToken === token && existingState.device &&
       existingState.deviceStatus === 'linked' && isClientSessionValid(existingState.device))) {
    return { ok: true, status: 'token_unchanged_skipped' };
  }

  // Mark token as processed (even if we're processing due to needsLinking)
  lastProcessedToken = token;

  // VALIDATE TOKEN BY DECODING IT
  const payload = decodeJwtPayload(token);

  if (!payload || !payload.userId) {
    console.warn('[handlePageTokenMessage] Token validation failed: Invalid payload');
    notifyUser(
      '⚠️ Invalid Token',
      'The token from the website is invalid. Please try logging in again.'
    );
    return { ok: false, status: 'token_validation_failed', reason: 'invalid_payload' };
  }

  const profile = buildProfileFromPayload(payload);

  const nowIso = new Date().toISOString();

  const persistIntermediate = async (state) => persistState(state);

  if (!existingState || !existingState.userToken) {
    let newState = createState({
      userToken: token,
      profile,
      origin,
      syncedAt: nowIso
    });
    newState = await ensureClientContext(newState, persistIntermediate);
    await persistState(newState);
    await retryWalletInitIfNeeded();
    return { ok: true, status: 'linked', profile: newState.profile };
  }

  if (existingState.userToken === token) {
    let updated = {
      ...existingState,
      profile: profile || existingState.profile,
      origin,
      syncedAt: nowIso,
      pendingSwitch: null
    };
    updated = await ensureClientContext(updated, persistIntermediate);
    await persistState(updated);
    await retryWalletInitIfNeeded();
    return { ok: true, status: 'unchanged', profile: updated.profile };
  }

  const sameUser =
    existingState.profile &&
    existingState.profile.userId &&
    profile &&
    profile.userId &&
    existingState.profile.userId === profile.userId;

  if (sameUser) {
    let refreshed = {
      ...existingState,
      userToken: token,
      profile: profile || existingState.profile,
      origin,
      syncedAt: nowIso,
      pendingSwitch: null
    };
    refreshed = await ensureClientContext(refreshed, persistIntermediate);
    await persistState(refreshed);
    await retryWalletInitIfNeeded();
    return { ok: true, status: 'refreshed', profile: refreshed.profile };
  }

  // Neuer User erkannt - prüfe ob alter Client noch gültig ist
  const hasValidClient = existingState.device && isClientSessionValid(existingState.device);

  if (!hasValidClient) {
    // Alter Client ist ungültig/nicht vorhanden → direkt einloggen mit neuem User
    let newState = createState({
      userToken: token,
      profile,
      origin,
      syncedAt: nowIso
    });
    newState = await ensureClientContext(newState, persistIntermediate);
    await persistState(newState);
    await retryWalletInitIfNeeded();
    return { ok: true, status: 'switched_to_new_user', profile: newState.profile };
  }

  // Alter Client ist noch aktiv → zeige "Profil wechseln" Button
  const updated = {
    ...existingState,
    pendingSwitch: {
      token,
      profile,
      origin,
      receivedAt: nowIso
    }
  };
  await persistState(updated);
  return { ok: true, status: 'pending_switch', profile: existingState.profile, pendingProfile: profile };
}

async function provideStatus() {
  // ZERO-KNOWLEDGE: checkClientStatus() disabled - not needed with user tokens
  // await checkClientStatus().catch(() => {});

  const state = await loadState();
  if (!state) {
    return {
      loggedIn: false,
      origin: lastOriginHint || null
    };
  }
  return {
    loggedIn: !!state.userToken,
    profile: state.profile,
    origin: state.origin,
    syncedAt: state.syncedAt,
    pending_profile: (state.pendingSwitch && state.pendingSwitch.profile) || null,
    pending_origin: (state.pendingSwitch && state.pendingSwitch.origin) || null,
    pending_received_at: (state.pendingSwitch && state.pendingSwitch.receivedAt) || null,
    client_linked: !!state.device,
    client_id: (state.device && state.device.clientId) || null,
    client_status: state.deviceStatus || (state.device ? 'linked' : 'idle'),
    client_error: state.deviceError || null,
    client_error_details: state.deviceErrorDetails || null,  // NEW: detailed error info
    client_session_valid: isClientSessionValid(state.device),
    client_last_linked_at: (state.device && state.device.linkedAt) || null
  };
}

function pickKnownOrigin(preferredOrigin) {
  if (preferredOrigin && SITE_ORIGINS.includes(preferredOrigin)) {
    return preferredOrigin;
  }
  if (lastOriginHint && SITE_ORIGINS.includes(lastOriginHint)) {
    return lastOriginHint;
  }
  if (cachedState && cachedState.pendingSwitch && SITE_ORIGINS.includes(cachedState.pendingSwitch.origin)) {
    return cachedState.pendingSwitch.origin;
  }
  if (cachedState && cachedState.origin && SITE_ORIGINS.includes(cachedState.origin)) {
    return cachedState.origin;
  }
  return SITE_ORIGINS[0];
}

async function openSite(path, preferredOrigin) {
  const origin = pickKnownOrigin(preferredOrigin);
  const url = `${origin}${path}`;
  await browser.tabs.create({ url });
}

async function applyPendingProfile() {
  const state = await loadState();
  if (!state || !state.pendingSwitch) {
    return { ok: false, error: 'no_pending' };
  }

  // Send disconnect message for old profile before switching
  if (state.device) {
    try {
      const messagingClient = window.MessagingIntegration?.getClient();
      if (messagingClient && typeof window.MessagingIntegration?.sendMessage === 'function') {
        // IMPORTANT: Capture old groupId BEFORE any state changes
        const oldGroupId = messagingClient.groupId;
        const oldMessagingAddress = messagingClient.messagingAddress;

        const disconnectPayload = {
          reason: 'profile_switch',
          clientId: state.device?.clientId,
          messagingAddress: oldMessagingAddress,
          oldUserId: state.profile?.userId,
          newUserId: state.pendingSwitch.profile?.userId,
          timestamp: Date.now()
        };

        await window.MessagingIntegration.sendMessage(disconnectPayload, 'client_disconnected');

        // Give message some time to be delivered
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Send device handoff BEFORE stopping messaging so queue + mintBuffer reach the website
      try {
        const revolution = typeof window.getRevolutionScoring === 'function'
          ? window.getRevolutionScoring() : null;
        const tq = revolution?.privacyLayer?.transactionQueue;
        if (tq && typeof tq.sendDeviceHandoff === 'function') {
          await tq.sendDeviceHandoff();
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (handoffError) {
        console.error('[revolution-addon] ❌ Failed to send device handoff on profile switch:', handoffError);
        // Non-fatal: continue
      }

      // Stop messaging for old profile
      if (typeof window.MessagingIntegration?.stopMessaging === 'function') {
        window.MessagingIntegration.stopMessaging();
      }
    } catch (error) {
      console.error('[revolution-addon] ❌ Failed to send disconnect message during profile switch:', error);
      // Continue with profile switch even if disconnect message fails
    }
  }

  const nowIso = new Date().toISOString();
  let nextState = createState({
    userToken: state.pendingSwitch.token,
    profile: state.pendingSwitch.profile,
    origin: state.pendingSwitch.origin || state.origin || lastOriginHint || SITE_ORIGINS[0],
    syncedAt: nowIso
  });

  // CRITICAL: Delete user-specific data on profile switch to start fresh with new profile
  await browser.storage.local.remove([
    // Messaging keys (must regenerate for new fingerprint)
    'rev_messaging_keypair',
    'rev_messaging_signing_keypair',
    'rev_messaging_group_id',
    'rev_client_token',

    // Wallet & Transaction Data (user-specific)
    'rev_cl_wallet',
    'rev_domain_wallets',
    'rev_or_wallets',
    'rev_transaction_queue',
    'rev_stored_transactions',

    // Tracking & Distribution Data (user-specific)
    'rev_first_tracking_date',
    'rev_historical_scores',
    'rev_paid_amounts',
    'rev_rating_history_30d',
    'rev_translation_factor_history',
    'rev_first_ba_to_cl_timestamp',
    'rev_calibration_result',
    'rev_calibration_completed',
    'rev_calibration_date',

    // Privacy & Rating Data (user-specific)
    'rev_privacy_rounding_errors',
    'rev_rating_seeds',
    'rev_rating_summaries',

    // NGO & Criteria Data (user-specific)
    'rev_ngo_criteria'
  ]);

  if (typeof window.LogClient !== 'undefined') {
    window.LogClient.sendLog('browser-addon', 'user_login', 'User logged in', {
      userId: nextState.profile?.userId,
      username: nextState.profile?.username
    }, 'success');
  }

  const persistIntermediate = async (s) => persistState(s);
  nextState = await ensureClientContext(nextState, persistIntermediate);
  await persistState(nextState);
  return { ok: true, profile: nextState.profile };
}

async function handleLogout() {
  const state = await loadState();
  if (!state || !state.device) {
    await persistState(createState({}));
    return { ok: true };
  }

  if (typeof window.LogClient !== 'undefined') {
    window.LogClient.sendLog('browser-addon', 'user_logout', 'User logged out', {
      userId: state.profile?.userId,
      clientId: state.device?.clientId
    }, 'info');
  }

  const origin = state.origin || pickKnownOrigin();

  // Send disconnect message to messaging group before logout
  try {
    const messagingClient = window.MessagingIntegration?.getClient();
    if (messagingClient && typeof window.MessagingIntegration?.sendMessage === 'function') {
      const disconnectPayload = {
        reason: 'logout',
        clientId: state.device?.clientId,
        messagingAddress: messagingClient.messagingAddress,
        timestamp: Date.now()
      };

      // Send device handoff BEFORE client_disconnected so website can receive it first
      try {
        const revolution = typeof window.getRevolutionScoring === 'function'
          ? window.getRevolutionScoring() : null;
        const tq = revolution?.privacyLayer?.transactionQueue;
        if (tq && typeof tq.sendDeviceHandoff === 'function') {
          await tq.sendDeviceHandoff();
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (handoffError) {
        console.error('[revolution-addon] ❌ Failed to send device handoff on logout:', handoffError);
        // Non-fatal: continue with logout
      }

      await window.MessagingIntegration.sendMessage(disconnectPayload, 'client_disconnected');

      // Give message some time to be delivered before stopping polling
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to send disconnect message:', error);
    // Continue with logout even if disconnect message fails
  }

  // Stop messaging polling
  try {
    if (typeof window.MessagingIntegration?.stopMessaging === 'function') {
      window.MessagingIntegration.stopMessaging();
    }
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to stop messaging:', error);
  }

  // Versuche Device auf dem Server zu widerrufen
  try {
    const revokeResponse = await fetch(`${origin}/devices/current/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.device.sessionToken}`
      }
    });
    if (!revokeResponse.ok) {
      console.warn('[revolution-addon] ⚠️ Device revocation returned', revokeResponse.status);
    }
  } catch (error) {
    console.warn('[revolution-addon] ⚠️ Device revocation failed (server unreachable):', error.message);
  }

  // Lösche lokale Daten unabhängig vom Server-Ergebnis
  await persistState(createState({}));

  // CRITICAL: Delete ALL user-specific data to force clean state on next login
  try {
    // Delete messaging keys from storage
    await browser.storage.local.remove([
      // Messaging & Authentication
      'rev_messaging_keypair',
      'rev_messaging_signing_keypair',
      'rev_messaging_group_id',
      'rev_client_token',
      'rev_user_token',

      // Wallet & Transaction Data
      'rev_cl_wallet',
      'rev_domain_wallets',
      'rev_or_wallets',
      'rev_transaction_queue',
      'rev_stored_transactions',

      // Tracking & Distribution Data
      'rev_first_tracking_date',
      'rev_historical_scores',
      'rev_paid_amounts',
      'rev_rating_history_30d',
      'rev_translation_factor_history',
      'rev_first_ba_to_cl_timestamp',
      'rev_calibration_result',
      'rev_calibration_completed',
      'rev_calibration_date',

      // Privacy & Rating Data
      'rev_privacy_rounding_errors',
      'rev_rating_seeds',
      'rev_rating_summaries',

      // NGO & Criteria Data
      'rev_ngo_criteria',

      // Binary Model keys (device/website addresses from ADDRESS_UPDATE)
      'known_devices',
      'website_keys',
      'last_address_update',
      'rating_sum'
    ]);

    // Clear messaging client state
    if (window.MessagingIntegration?.clearAllData) {
      await window.MessagingIntegration.clearAllData();
    }

  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to delete user data:', error);
  }

  return { ok: true };
}

// Expose for messaging-integration.js (account_deleted system message)
window.performLogout = handleLogout;

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Fresh install: wipe any leftover data from a previous installation
    try {
      await browser.storage.local.clear();
    } catch (error) {
      console.error('[revolution-addon] ❌ Failed to clear storage on install:', error);
    }
  }
});

// Cleanup satisfaction data when tabs are closed (v2.0.0)
browser.tabs.onRemoved.addListener((tabId) => {
  cleanupSatisfactionData(tabId);
});

browser.runtime.onStartup.addListener(async () => {
  // Revoke old client to force re-registration with new messaging keys
  // This is necessary because messaging keys are regenerated on each addon reload
  try {
    const state = await loadState();
    if (state && state.device && state.device.sessionToken) {
      const origin = state.origin || pickKnownOrigin();

      try {
        await fetch(`${origin}/devices/current/revoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.device.sessionToken}`
          }
        });
      } catch (error) {
        console.warn('[revolution-addon] Failed to revoke old client (server may be unreachable):', error.message);
      }

      // Clear client context to force new claim
      const clearedState = {
        ...state,
        device: null,
        deviceStatus: 'idle',
        deviceError: null
      };
      await persistState(clearedState);
    }
  } catch (error) {
    console.error('[revolution-addon] Error during startup client revocation:', error);
  }

  // Now request token from active tabs (will trigger new claim with new messaging keys)
  setTimeout(() => {
    requestTokenFromActiveTabs().catch(() => {});
  }, 500);
});

// REMOVED: Redundant polling mechanisms to prevent rate limiting
// - Periodic polling (60s interval) - REMOVED
// - Window focus listener - REMOVED
// - Tab activation listener - REMOVED
// PERFORMANCE FIX: Disabled automatic content script injection on tab update
// Content script should be injected via manifest.json content_scripts
// Manual injection on EVERY tab update causes massive performance issues
//
// browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
//   if (changeInfo.status === 'complete' && tab.url) {
//     const origin = resolveOrigin(tab.url);
//     if (origin) {
//       browser.tabs.executeScript(tabId, {
//         file: 'contentScript.js',
//         runAt: 'document_start'
//       }).then(() => {
//         setTimeout(() => {
//           browser.tabs.sendMessage(tabId, { type: 'REQUEST_TOKEN' }).catch(() => {});
//         }, 500);
//       }).catch(() => {});
//     }
//   }
// });

/**
 * Retries wallet initialization if it previously failed
 * Called after profile updates that might include a new wallet address
 */
async function retryWalletInitIfNeeded() {
  if (window._walletInitialized) {
    return;
  }

  try {
    const state = await loadState();

    // Check if user is logged in (has valid userToken)
    if (!state || !state.userToken) {
      return;
    }

    // IMPORTANT: Check browser storage for wallet (from device registration)
    // Private keys are NO LONGER in JWT profile for security reasons
    const storageData = await browser.storage.local.get(['rev_cl_wallet']);
    const storedWallet = storageData.rev_cl_wallet;

    if (!storedWallet || !storedWallet.address || !storedWallet.privateKey) {
      window._walletInitFailed = true;
      window._walletInitError = 'No wallet with private key in storage';
      return;
    }

    // Use wallet from browser storage (device registration)
    const clWalletAddress = storedWallet.address;
    const privateKey = storedWallet.privateKey;
    const publicKey = storedWallet.publicKey;

    // Clear error flags
    window._walletInitFailed = false;
    window._walletInitError = null;

    await initializeWalletSystem(clWalletAddress, privateKey, publicKey);

    notifyUser('✅ Wallet Ready', 'Wallet system is now available.');

  } catch (error) {
    console.error('[revolution-addon] ❌ Wallet retry failed:', error.message);
  }
}
window.retryWalletInitIfNeeded = retryWalletInitIfNeeded;

/**
 * Initialisiert Wallet System für anonyme Transaktionen
 * - WalletManager: CL Wallet Management
 * - AnonTransactionClient: Blind Signature Protocol
 * - Injiziert Dependencies in TransactionQueue
 *
 * @param {string|null} clWalletAddress - CL Wallet Adresse (aus JWT-Token Profile)
 * @param {string|null} privateKey - Private Key (Base64-encoded, optional)
 * @param {string|null} publicKey - Public Key (Base64-encoded, optional)
 */
async function initializeWalletSystem(clWalletAddress = null, privateKey = null, publicKey = null) {
  try {

    // 1. Prüfe ob CL-Wallet verfügbar ist
    if (!clWalletAddress) {
      const errorMsg = 'No CL wallet address available. Please ensure you are logged in and your profile includes a wallet address.';
      console.error('[revolution-addon] ❌', errorMsg);

      notifyUser('⚠️ Wallet Initialization Failed', errorMsg);

      window._walletInitError = 'no_cl_wallet_address';
      window._walletInitFailed = true;

      return;
    }

    // 2. Prüfe ob WalletManager verfügbar ist
    if (typeof window.WalletManager === 'undefined') {
      const errorMsg = 'WalletManager not loaded';
      console.error('[revolution-addon] ❌', errorMsg);

      notifyUser('⚠️ Wallet System Error', errorMsg);

      window._walletInitError = 'wallet_manager_missing';
      window._walletInitFailed = true;

      return;
    }

    if (typeof window.AnonTransactionClient === 'undefined') {
      const errorMsg = 'AnonTransactionClient not loaded';
      console.error('[revolution-addon] ❌', errorMsg);

      notifyUser('⚠️ Wallet System Error', errorMsg);

      window._walletInitError = 'anon_client_missing';
      window._walletInitFailed = true;

      return;
    }

    // 3. Initialisiere WalletManager
    const walletManager = new window.WalletManager({
      clApiUrl:     'https://ledger.lenkenhoff.de',
      clReadApiUrl: 'https://read.lenkenhoff.de',
      storage:      browser.storage.local,
      fetch:        window.fetchWithVersion
    });

    // 4. Initialisiere Wallet mit CL-Adresse aus Profile
    const wallet = await walletManager.initializeWallet(clWalletAddress, privateKey, publicKey);

    // 5. Initialisiere AnonTransactionClient
    const anonClient = new window.AnonTransactionClient({
      anonApiUrl:   'https://ledger.lenkenhoff.de/anon',
      clApiUrl:     'https://ledger.lenkenhoff.de',
      clReadApiUrl: 'https://read.lenkenhoff.de',
      fetch:        window.fetchWithVersion,
      sodium:       window.sodium
    });

    // 6. Hole Messaging Client (falls verfügbar)
    const messagingClient = window.MessagingIntegration?.getClient();

    // 7. Injiziere Dependencies in alle PrivacyLayer Instanzen
    // (wird vom RevolutionScoring verwendet)
    if (typeof window.injectWalletDependencies === 'function') {
      // Hole translationFactorTracker und distributionEngine vom RevolutionScoring (falls verfügbar)
      let translationFactorTracker = null;
      let distributionEngine = null;
      if (typeof window.getRevolutionScoring === 'function') {
        const revolution = window.getRevolutionScoring();
        translationFactorTracker = revolution?.distributionEngine?.translationFactorTracker || null;
        distributionEngine = revolution?.distributionEngine || null;
      }

      window.injectWalletDependencies({
        walletManager,
        anonClient,
        messagingClient,
        translationFactorTracker,
        distributionEngine
      });
    }

    // 8. Initialisiere FingerprintSeedManager
    const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });

    // Starte Cleanup-Job (täglich um 3 Uhr nachts)
    const now = new Date();
    const tomorrow3AM = new Date(now);
    tomorrow3AM.setHours(27, 0, 0, 0); // 3 Uhr morgen
    const msUntil3AM = tomorrow3AM - now;

    setTimeout(async () => {
      // Erste Ausführung
      await seedManager.cleanupOldSeeds(90);

      // Danach täglich
      setInterval(async () => {
        await seedManager.cleanupOldSeeds(90);
      }, 24 * 60 * 60 * 1000); // 24 Stunden
    }, msUntil3AM);

    // 9. Hole TranslationFactorTracker vom RevolutionScoring (falls bereits initialisiert)
    let translationFactorTracker = null;
    if (typeof window.getRevolutionScoring === 'function') {
      const revolution = window.getRevolutionScoring();
      if (revolution?.distributionEngine?.translationFactorTracker) {
        translationFactorTracker = revolution.distributionEngine.translationFactorTracker;
      }
    }

    // 10. Speichere global für Zugriff in anderen Modulen
    window._walletManager = walletManager;
    window._anonClient = anonClient;
    window._messagingClient = messagingClient;
    window._seedManager = seedManager;
    window._translationFactorTracker = translationFactorTracker;
    window._walletInitialized = true;

    console.log('[revolution-addon] ✅ Wallet System initialized');

    // 9. Process any pending transactions that were queued before wallet was ready
    if (typeof window.getRevolutionScoring === 'function') {
      const revolution = window.getRevolutionScoring();
      if (revolution?.privacyLayer?.transactionQueue) {
        await revolution.privacyLayer.transactionQueue.processPendingQueue();
      }
    }

    // 10. Process ratings that were queued because wallet was not ready
    await processPendingRatings();

  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to initialize Wallet System:', error);

    const errorMsg = `Wallet initialization failed: ${error.message}`;
    notifyUser('⚠️ Wallet System Error', errorMsg);

    window._walletInitError = error.message;
    window._walletInitFailed = true;

    throw error;
  }
}

async function initializeBackgroundScript() {
  try {
    // 1. Initialisiere Debug Logger
    if (typeof DebugLogger !== 'undefined') {
      await DebugLogger.init();
    }

    const state = await loadState();

    // 1.5 REVOLUTION SCORING - Initialize IMMEDIATELY (no delay!)
    try {
      if (typeof window.getRevolutionScoring === 'function') {
        const scoring = window.getRevolutionScoring();
        if (scoring) {
          // CRITICAL: Must call initialize() to set initialized = true!
          await scoring.initialize();
        } else {
          console.warn('[revolution-addon] ⚠️ Revolution Scoring returned null');
        }
      } else {
        console.warn('[revolution-addon] ⚠️ getRevolutionScoring not available');
      }
    } catch (error) {
      console.error('[revolution-addon] ❌ Revolution Scoring init failed:', error.message, error.stack);
    }

    // 2. Client-Context - DELAYED START to avoid blocking page load
    // Wait 3 seconds before making HTTP requests
    if (state && state.userToken) {
      setTimeout(() => {
        const persistIntermediate = async (s) => persistState(s);
        ensureClientContext(state, persistIntermediate)
          .then(async (updatedState) => {
            await persistState(updatedState);
          })
          .catch(error => {
            console.warn('[revolution-addon] ⚠️ Client context check failed:', error.message);
          });
      }, 3000); // 3 second delay
    }
  } catch (error) {
    console.error('[revolution-addon] Init failed:', error.message);
    notifyUser('⚠️ Initialization Error', 'Addon initialization failed: ' + error.message);
  }

  // 3. MESSAGING - RE-ENABLED (delayed start to avoid blocking)
  setTimeout(async () => {
    try {
      const state = await loadState();
      const userToken = state?.userToken;

      if (userToken) {
        // If device is already linked, mark as linked before messaging init
        // so that NOT_REGISTERED errors are correctly treated as revocation
        if (state?.deviceStatus === 'linked') {
          window.MessagingIntegration?.setLinked?.();
        }
        initializeMessaging()
          .catch(error => {
            console.error('[revolution-addon] ❌ Messaging init failed:', error.message);
          });
      }
    } catch (error) {
      console.error('[revolution-addon] ❌ Messaging init failed:', error.message);
    }
  }, 4000); // 4 second delay to avoid blocking page loads

  // 4. WALLET SYSTEM - RE-ENABLED
  // Initialize wallet system if we have a stored wallet (from device registration)
  setTimeout(async () => {
    try {
      const storageData = await browser.storage.local.get(['rev_cl_wallet']);
      const storedWallet = storageData.rev_cl_wallet;

      if (storedWallet && storedWallet.address && storedWallet.privateKey) {
        await initializeWalletSystem(storedWallet.address, storedWallet.privateKey, storedWallet.publicKey);
      } else {
        // If device is linked but wallet is missing, request ADDRESS_UPDATE from website
        // This handles the case where the initial ADDRESS_UPDATE was missed (race condition)
        const state = await loadState();
        if (state && state.device && state.deviceStatus === 'linked') {
          // Retry sending request_address_update every 30s until wallet arrives
          async function tryRequestAddressUpdate() {
            const currentData = await browser.storage.local.get(['rev_cl_wallet']);
            if (currentData.rev_cl_wallet) return; // Wallet arrived, stop retrying
            try {
              const messagingClient = window.MessagingIntegration?.getClient();
              if (messagingClient && typeof window.MessagingIntegration?.sendMessage === 'function') {
                await window.MessagingIntegration.sendMessage({ reason: 'wallet_missing' }, 'request_address_update');
              }
            } catch (err) {
              console.warn('[revolution-addon] ⚠️ Failed to request ADDRESS_UPDATE:', err.message);
            }
            // Schedule next retry in 30s (website may not be open yet)
            setTimeout(tryRequestAddressUpdate, 30000);
          }
          // First attempt after messaging init (4s total from startup)
          setTimeout(tryRequestAddressUpdate, 3000);
        }
      }
    } catch (error) {
      console.error('[revolution-addon] ❌ Wallet System init failed:', error.message);
    }
  }, 2000); // Wait 2s for other systems to initialize first

  // 6. Tracking System - RE-ENABLED
  tracker.initialize()
    .then(() => {
      tracker.onSessionCompleted = (sessionSummary) => {
        handleSessionCompleted(sessionSummary).catch(error => {
          console.error('[revolution-addon] Session processing failed:', error);
        });
      };
    })
    .catch(error => {
      console.error('[revolution-addon] Tracking init failed:', error.message);
      notifyUser('⚠️ Tracking Error', 'Tracking system failed: ' + error.message);
    });

  // 7. Token requests
  setTimeout(() => {
    requestTokenFromActiveTabs().catch(() => {});
  }, 500);

  // 8. Group key refresh
  setTimeout(async () => {
    try {
      const messagingClient = window.MessagingIntegration?.getClient();
      if (messagingClient && messagingClient.authToken) {
        await messagingClient.fetchGroupKeys();
      }
    } catch (error) {
      // Non-critical: group keys may not be available yet
    }
  }, 2000);
}

/**
 * Writes a value to the localStorage of the active website
 * @param {string} key - localStorage key
 * @param {string|null} value - Value (or null to remove)
 * @param {string|null} targetOrigin - Optional: specific origin (default: active tab)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function writeToWebsiteLocalStorage(key, value, targetOrigin = null) {
  try {
    // Find tab with matching origin
    const tabs = await browser.tabs.query({});

    let targetTab = null;
    if (targetOrigin) {
      targetTab = tabs.find(tab => {
        const origin = resolveOrigin(tab.url);
        return origin === targetOrigin;
      });
    } else {
      // Use active tab
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length > 0) {
        const origin = resolveOrigin(activeTabs[0].url);
        if (origin) {
          targetTab = activeTabs[0];
        }
      }
    }

    if (!targetTab) {
      return { ok: false, error: 'No valid tab found' };
    }

    // Send message to contentScript
    const response = await browser.tabs.sendMessage(targetTab.id, {
      type: 'WRITE_LOCALSTORAGE',
      key,
      value
    });

    return response;
  } catch (error) {
    console.error('[writeToWebsiteLocalStorage] Failed:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Reads a value from the localStorage of the website
 * @param {string} key - localStorage key
 * @param {string|null} targetOrigin - Optional: specific origin
 * @returns {Promise<{ok: boolean, value?: string, error?: string}>}
 */
async function readFromWebsiteLocalStorage(key, targetOrigin = null) {
  try {
    const tabs = await browser.tabs.query({});

    let targetTab = null;
    if (targetOrigin) {
      targetTab = tabs.find(tab => {
        const origin = resolveOrigin(tab.url);
        return origin === targetOrigin;
      });
    } else {
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length > 0) {
        const origin = resolveOrigin(activeTabs[0].url);
        if (origin) {
          targetTab = activeTabs[0];
        }
      }
    }

    if (!targetTab) {
      return { ok: false, error: 'No valid tab found' };
    }

    const response = await browser.tabs.sendMessage(targetTab.id, {
      type: 'READ_LOCALSTORAGE',
      key
    });

    return response;
  } catch (error) {
    console.error('[readFromWebsiteLocalStorage] Failed:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Writes Messaging Public Keys to Website-localStorage
 * Enables key-exchange between Addon and Website
 */
async function publishMessagingKeysToWebsite() {
  try {
    const messagingInfo = window.MessagingIntegration?.getMessagingInfo();

    if (!messagingInfo || !messagingInfo.encryptionPublicKey) {
      console.warn('[publishMessagingKeysToWebsite] No messaging keys available');
      return { ok: false, error: 'No keys available' };
    }

    const state = await loadState();
    const origin = state?.origin || pickKnownOrigin();

    // Write Public Key to localStorage
    const keyData = {
      publicKey: messagingInfo.encryptionPublicKey,
      signingPublicKey: messagingInfo.signingPublicKey,
      fingerprint: messagingInfo.fingerprint,
      publishedAt: new Date().toISOString()
    };

    const result = await writeToWebsiteLocalStorage(
      'rev_messaging_public_key',
      JSON.stringify(keyData),
      origin
    );

    if (!result.ok) {
      console.warn('[publishMessagingKeysToWebsite] Failed:', result.error);
    }

    return result;
  } catch (error) {
    console.error('[publishMessagingKeysToWebsite] Error:', error);
    return { ok: false, error: error.message };
  }
}

initializeBackgroundScript();

async function requestTokenFromActiveTabs() {
  try {
    const tabs = await browser.tabs.query({});
    const relevantTabs = tabs.filter((tab) => {
      if (!tab.url) return false;
      const origin = resolveOrigin(tab.url);
      return !!origin;
    });

    for (const tab of relevantTabs) {
      try {
        // Erst Content-Script injizieren
        await browser.tabs.executeScript(tab.id, {
          file: 'contentScript.js',
          runAt: 'document_start'
        }).catch(() => {});

        // Dann Token anfordern
        await new Promise((resolve) => setTimeout(resolve, 300));
        await browser.tabs.sendMessage(tab.id, { type: 'REQUEST_TOKEN' });
      } catch (error) {
        // Silent fail
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'request_failed' };
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) {
    return undefined;
  }
  if (message.type === 'PAGE_TOKEN') {
    // PERFORMANCE FIX: Handle PAGE_TOKEN asynchronously without blocking
    // Run in background and return immediately to avoid blocking content script
    handlePageTokenMessage(message, sender).catch(error => {
      console.error('[revolution-addon] PAGE_TOKEN handler failed:', error);
    });
    return Promise.resolve({ ok: true, status: 'processing' });
  }
  if (message.type === 'POPUP_STATUS') {
    return provideStatus();
  }
  if (message.type === 'REQUEST_SITE_LOGIN') {
    return openSite(LOGIN_PATH, message.origin)
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: (error && error.message) || 'open_failed' }));
  }
  if (message.type === 'APPLY_PENDING_PROFILE') {
    return applyPendingProfile();
  }
  if (message.type === 'REQUEST_ACTIVE_TOKEN') {
    return requestTokenFromActiveTabs();
  }
  if (message.type === 'LOGOUT') {
    return handleLogout();
  }
  if (message.type === 'GET_INIT_STATUS') {
    return Promise.resolve({
      walletInitialized: window._walletInitialized || false,
      walletInitError: window._walletInitError || null,
      walletInitFailed: window._walletInitFailed || false,
      hasWalletManager: !!window._walletManager,
      hasAnonClient: !!window._anonClient,
      hasMessagingClient: !!window._messagingClient,
      messagingInitialized: window.MessagingIntegration?.isMessagingInitialized() || false,
      clWalletAddress: window._walletManager ? 'set' : 'not_set'
    });
  }
  if (message.type === 'DEBUG_WALLET') {
    return browser.storage.local.get(['rev_cl_wallet']).then(data => {
      const wallet = data.rev_cl_wallet;
      return {
        hasWallet: !!wallet,
        hasAddress: !!wallet?.address,
        hasPrivateKey: !!wallet?.privateKey,
        addressPreview: wallet?.address ? wallet.address.substring(0, 20) + '...' : null,
        receivedAt: wallet?.receivedAt,
        walletInitialized: window._walletInitialized || false,
        walletInitFailed: window._walletInitFailed || false,
        walletInitError: window._walletInitError || null,
        hasWalletManager: !!window._walletManager,
        hasAnonClient: !!window._anonClient
      };
    });
  }
  if (message.type === 'FETCH_AND_STORE_WALLET') {
    return loadState().then(async state => {
      if (!state || !state.userToken) {
        throw new Error('Not logged in - no user token');
      }
      const origin = state.origin || pickKnownOrigin();

      try {
        // Fetch wallet from server
        const response = await fetch(`${origin}/account/wallets/cl-full`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${state.userToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'unknown' }));
          throw new Error(error.error || `HTTP ${response.status}`);
        }

        const walletData = await response.json();

        // Store wallet in browser storage
        await browser.storage.local.set({
          'rev_cl_wallet': {
            address: walletData.address,
            privateKey: walletData.privateKey,
            receivedAt: Date.now()
          }
        });

        return {
          success: true,
          message: 'Wallet fetched and stored successfully. Please reload the addon to initialize wallet system.',
          address: walletData.address
        };
      } catch (error) {
        console.error('[FETCH_AND_STORE_WALLET] ❌ Error:', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
  }
  if (message.type === 'DEBUG_STORAGE') {
    return loadState().then(state => {
      // Decode tokens
      const userPayload = state?.userToken ? decodeJwtPayload(state.userToken) : null;
      const sessionPayload = state?.client?.sessionToken ? decodeJwtPayload(state.device.sessionToken) : null;

      return {
        hasUserToken: !!state?.userToken,
        userTokenPreview: state?.userToken ? state.userToken.substring(0, 50) + '...' : null,
        userTokenPayload: userPayload,
        hasProfile: !!state?.profile,
        profile: state?.profile,
        hasClient: !!state?.client,
        hasSessionToken: !!state?.client?.sessionToken,
        sessionTokenPreview: state?.client?.sessionToken ? state.device.sessionToken.substring(0, 50) + '...' : null,
        sessionTokenPayload: sessionPayload,
        deviceStatus: state?.clientStatus,
        deviceError: state?.clientError,
        origin: state?.origin
      };
    });
  }
  if (message.type === 'GET_EXPORT_DATA') {
    return (async () => {
      try {
        const state = await loadState();
        const [
          walletData,
          seedsData,
          historyData,
          summariesData,
          transactionsData,
          messagingLogData,
          websiteKeysData,
          keypairData,
          addressData,
          devicesData
        ] = await Promise.all([
          browser.storage.local.get(['rev_cl_wallet']),
          browser.storage.local.get(['rev_rating_seeds']),
          browser.storage.local.get(['rev_rating_history_30d']),
          browser.storage.local.get(['rev_rating_summaries']),
          browser.storage.local.get(['rev_stored_transactions']),
          browser.storage.local.get(['messaging_log']),
          browser.storage.local.get(['website_keys']),
          browser.storage.local.get(['rev_messaging_keypair']),
          browser.storage.local.get(['rev_messaging_address']),
          browser.storage.local.get(['known_devices'])
        ]);

        // rev_rating_seeds ist ein Object { ratingRef: seedObj }, in Array umwandeln
        const seedsRaw = seedsData.rev_rating_seeds || {};
        const seedsArray = Array.isArray(seedsRaw) ? seedsRaw : Object.values(seedsRaw);

        // known_devices enthält alle Devices des Users (von ADDRESS_UPDATE)
        const knownDevices = devicesData.known_devices || [];

        return {
          ok: true,
          profile: state?.profile || null,
          wallet: {
            address: walletData.rev_cl_wallet?.address || null,
            receivedAt: walletData.rev_cl_wallet?.receivedAt || null
          },
          messagingKeys: {
            myAddress: addressData.rev_messaging_address || null,
            myPublicKey: keypairData.rev_messaging_keypair?.publicKey || null,
            websiteAddress: websiteKeysData.website_keys?.messaging_address || null,
            websitePublicKey: websiteKeysData.website_keys?.encryption_key || null
          },
          knownDevices: knownDevices,
          ratingSeeds: seedsArray,
          ratingHistory: historyData.rev_rating_history_30d || [],
          ratingSummaries: summariesData.rev_rating_summaries || [],
          storedTransactions: transactionsData.rev_stored_transactions || [],
          messagingLog: messagingLogData.messaging_log || []
        };
      } catch (error) {
        console.error('[GET_EXPORT_DATA] ❌ Fehler:', error);
        return { ok: false, error: error.message };
      }
    })();
  }
  if (message.type === 'SIMULATE_TAB_CLOSE') {
    return handleSimulateTabClose(message.tabId);
  }
  // Tracking-bezogene Message-Handler
  if (message.type === 'GET_TRACKING_SESSIONS') {
    return Promise.resolve({
      activeSessions: tracker.getActiveSessions(),
      completedSessions: tracker.getCompletedSessions()
    });
  }

  // Satisfaction Data Handler (NEU in v2.0.0)
  if (message.type === 'SATISFACTION_DATA') {
    return handleSatisfactionData(message, sender);
  }

  // Native Rating Handler (NEU in v2.0.0)
  if (message.type === 'NATIVE_RATING_DETECTED') {
    return handleNativeRating(message, sender);
  }
  if (message.type === 'CLEAR_COMPLETED_SESSIONS') {
    return tracker.clearCompletedSessions()
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: (error && error.message) || 'clear_failed' }));
  }

  // Handle device registration response from website
  if (message.type === 'DEVICE_REGISTRATION_RESPONSE') {
    // IMPORTANT: Return undefined (not a Promise) so that the responseHandler
    // in claimInvite() can also receive and process this message
    // Multiple listeners need to handle this message
    return undefined;
  }

  return undefined;
});

// Regelmäßige Client-Status-Überprüfung
async function checkClientStatus() {
  const state = await loadState();
  if (!state || !state.device || !state.device.sessionToken) {
    return;
  }

  const origin = state.origin || pickKnownOrigin();

  try {
    const response = await fetch(`${origin}/devices/current`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${state.device.sessionToken}`
      }
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      // Device wurde auf dem Server widerrufen
      await persistState(createState({}));
      return;
    }

    if (!response.ok) {
      // Bei anderen Fehlern auch State löschen
      if (response.status >= 400 && response.status < 500) {
        await persistState(createState({}));
      }
      return;
    }

    const data = await response.json();

    // Falls sich Wallet geändert hat, aktualisieren
    if (data.wallet_address && state.profile && data.wallet_address !== state.profile.clientWallet) {
      const updatedState = {
        ...state,
        profile: {
          ...state.profile,
          clientWallet: data.wallet_address
        }
      };
      await persistState(updatedState);
    }
  } catch (error) {
    // Silent fail
  }
}

// ZERO-KNOWLEDGE: Client status check disabled - not compatible with user-token architecture
// In ZK architecture, we use user tokens directly without separate client tokens,
// so /devices/current endpoint doesn't work (returns 404 because token has no deviceId).
// This is intentional - device validity is checked via server-side deduplication instead.

// Starte regelmäßige Überprüfung
// const CHECK_INTERVAL = 300000; // 5 Minuten
// setInterval(() => {
//   checkClientStatus().catch(() => {});
// }, CHECK_INTERVAL);

// Initiale Überprüfung nach 2 Sekunden
// setTimeout(() => {
//   checkClientStatus().catch(() => {});
// }, 2000);

const PENDING_RATINGS_KEY = 'rev_pending_ratings';
const MAX_PENDING_RATINGS = 50; // Limit um Storage nicht zu überfluten

async function enqueuePendingRating(sessionData, pageData, satisfactionData) {
  try {
    const stored = await browser.storage.local.get([PENDING_RATINGS_KEY]);
    const queue = stored[PENDING_RATINGS_KEY] || [];
    if (queue.length >= MAX_PENDING_RATINGS) {
      // Ältestes Rating entfernen (FIFO)
      queue.shift();
    }
    queue.push({ sessionData, pageData, satisfactionData, enqueuedAt: Date.now() });
    await browser.storage.local.set({ [PENDING_RATINGS_KEY]: queue });
    console.log(`[revolution-addon] ⏳ Rating queued for later (queue size: ${queue.length})`);
  } catch (err) {
    console.error('[revolution-addon] ❌ Failed to enqueue pending rating:', err);
  }
}

async function processPendingRatings() {
  try {
    const stored = await browser.storage.local.get([PENDING_RATINGS_KEY]);
    const queue = stored[PENDING_RATINGS_KEY] || [];
    if (queue.length === 0) return;

    const revolution = window.getRevolutionScoring && window.getRevolutionScoring();
    if (!revolution || !revolution.initialized) return;

    console.log(`[revolution-addon] 🔄 Processing ${queue.length} pending rating(s)...`);
    await browser.storage.local.remove(PENDING_RATINGS_KEY);

    for (const pending of queue) {
      try {
        const result = await revolution.processSession(
          pending.sessionData,
          pending.pageData,
          pending.satisfactionData
        );
        if (result && result.walletNotReady) {
          // Wallet immer noch nicht bereit — wieder einreihen
          await enqueuePendingRating(pending.sessionData, pending.pageData, pending.satisfactionData);
        } else if (result !== null) {
          console.log(`[revolution-addon] ✅ Pending rating processed: ${pending.sessionData.sessionId}`);
        }
      } catch (err) {
        console.error('[revolution-addon] ❌ Failed to process pending rating:', err);
      }
    }
  } catch (err) {
    console.error('[revolution-addon] ❌ Failed to process pending ratings queue:', err);
  }
}

/**
 * Handler für abgeschlossene Tracking-Sessions
 */
async function handleSessionCompleted(sessionSummary) {
  try {
    // KEIN FILTER: Jede Session wird bewertet - auch Redirects bieten einen Dienst!
    // Mit 10^16 Tokens/Monat können auch Kleinstbeträge verteilt werden.
    // Der Score wird durch die Scoring-Engine entsprechend berechnet.
    // #TODO: Redirect-Services speziell analysieren und eigenes Rating-Schema entwickeln
    // Log session ended
    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.session.ended(sessionSummary.sessionId, sessionSummary);
    }

    // Prüfe ob RevolutionScoring verfügbar ist
    if (typeof window.getRevolutionScoring !== 'function') {
      console.warn('[revolution-addon] RevolutionScoring not available, using fallback evaluation');
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.warning('scoring_unavailable', 'RevolutionScoring not available, using fallback');
      }
      evaluateSession(sessionSummary);
      return;
    }

    // Hole RevolutionScoring Instanz
    const revolution = window.getRevolutionScoring();
    if (!revolution || !revolution.initialized) {
      console.warn('[revolution-addon] RevolutionScoring not initialized, skipping session processing');
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.warning('scoring_not_initialized', 'RevolutionScoring not initialized');
      }
      return;
    }

    // Extrahiere Domain aus URL
    const domain = extractDomain(sessionSummary.url);
    if (!domain) {
      console.warn('[revolution-addon] No valid domain found, skipping session');
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.warning('no_valid_domain', 'No valid domain found for session', {
          url: sessionSummary.url
        });
      }
      return;
    }

    // Log session processing start
    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.session.processing(sessionSummary.sessionId, domain);
    }

    // Konvertiere Session-Daten in erwartetes Format
    const sessionData = {
      sessionId: sessionSummary.sessionId,
      domain: domain,
      url: sessionSummary.url,
      startTime: sessionSummary.startTime,
      endTime: sessionSummary.endTime,
      totalTimeSeconds: sessionSummary.totalTimeSeconds,
      metrics: {
        activeTime: sessionSummary.metrics.activeTime,
        passiveTime: sessionSummary.metrics.passiveTime
      },
      customMetrics: sessionSummary.customMetrics || {}
    };

    // Dummy pageData (wird später durch Content-Detection erweitert)
    const pageData = {
      domain: domain,
      url: sessionSummary.url
    };

    // Hole Satisfaction Data für diese Session (NEU in v2.0.0)
    const satisfactionData = getSatisfactionData(sessionSummary.tabId);

    // Verarbeite Session durch RevolutionScoring
    const result = await revolution.processSession(sessionData, pageData, satisfactionData);

    // Wallet noch nicht bereit → Rating in Queue speichern für spätere Verarbeitung
    if (result && result.walletNotReady) {
      await enqueuePendingRating(sessionData, pageData, satisfactionData);
      return;
    }

    // Rating wurde verworfen (kein BA→CL Transfer oder Score 0)
    if (result === null) {
      return;
    }

    // Log successful scoring
    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.session.scored(
        sessionSummary.sessionId,
        result.scoring?.score,
        result.scoring?.metadata
      );
    }

    // IMPORTANT: Send Rating Message IMMEDIATELY after scoring (independent of transaction)
    // This ensures the website receives rating data even if the transaction fails or is delayed
    try {
      const messagingClient = window.MessagingIntegration?.getClient();
      const ratingRef = result.scoring?.metadata?.ratingRef; // ratingRef is in scoring.metadata, not distribution

      if (messagingClient && ratingRef) {
        await sendRatingMessageToWebsite(result, sessionSummary, messagingClient, ratingRef);
      } else {
        console.warn('[revolution-addon] ⚠️ Cannot send rating message: missing messagingClient or ratingRef');
      }
    } catch (error) {
      console.error('[revolution-addon] ❌ Failed to send rating message:', error);
      // Non-fatal - transaction can still proceed
    }

    // NOTE: TransactionCorrector is disabled - replaced by RetroPayoutService (background job)
    // The old corrector ran on EVERY session end, causing performance issues.
    // RetroPayoutService runs periodically (every 6 hours) instead.

  } catch (error) {
    // Unterscheide zwischen Pause (retry später) und echtem Fehler
    if (error.message && error.message.includes('Rating paused')) {
      console.warn('[revolution-addon] ⏸️ Rating paused due to Central Ledger unavailability:', error.message);
      console.warn('[revolution-addon] Will retry on next BA→CL check');
      // Kein DebugLogger.failed() - das ist kein permanenter Fehler
    } else {
      console.error('[revolution-addon] ❌ Failed to process session:', error.message, error.stack);

      // Log error
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.session.failed(sessionSummary.sessionId, error);
      }
    }
  }
}

/**
 * Extrahiert Domain aus URL
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (error) {
    return null;
  }
}

/**
 * Berechnet eine Bewertung für eine Session
 * Diese Funktion kann erweitert werden für komplexere Bewertungslogik
 */
function evaluateSession(sessionSummary) {
  const activeTime = sessionSummary.metrics.activeTime.valueSeconds;
  const passiveTime = sessionSummary.metrics.passiveTime.valueSeconds;
  const totalTime = sessionSummary.totalTimeSeconds;

  // Basis-Bewertung: Aktive Zeit wird höher gewichtet als passive Zeit
  const activeWeight = 1.0;
  const passiveWeight = 0.3;

  const baseScore = (activeTime * activeWeight) + (passiveTime * passiveWeight);

  // Qualitätsfaktor: Je höher der Anteil aktiver Zeit, desto höher die Qualität
  const activeRatio = totalTime > 0 ? activeTime / totalTime : 0;
  const qualityFactor = 0.5 + (activeRatio * 0.5); // 0.5 bis 1.0

  const finalScore = baseScore * qualityFactor;

  return {
    baseScore: Math.round(baseScore),
    qualityFactor: Math.round(qualityFactor * 100) / 100,
    finalScore: Math.round(finalScore),
    activeRatio: Math.round(activeRatio * 100) / 100,
    metrics: {
      activeTimeSeconds: activeTime,
      passiveTimeSeconds: passiveTime,
      totalTimeSeconds: totalTime
    }
  };
}

/**
 * Optional: Sendet Session-Daten an den Server
 */
async function uploadSessionToServer(sessionSummary, sessionToken) {
  // TODO: Implementierung für Server-Upload
}

// ============================================================================
// SATISFACTION DATA HANDLERS (v2.0.0)
// ============================================================================

/**
 * Speichert Satisfaction Data für eine Session
 * Diese Daten werden später beim Scoring verwendet
 */
const satisfactionDataStore = new Map(); // tabId -> satisfactionData

async function handleSatisfactionData(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    console.warn('[revolution-addon] ⚠️ No tab ID in satisfaction data message');
    return Promise.resolve({ ok: false, error: 'no_tab_id' });
  }

  // Speichere Satisfaction Data für diese Session
  satisfactionDataStore.set(tabId, {
    ...message.data,
    url: message.url,
    timestamp: message.timestamp || Date.now()
  });

  // Log zu Debug Logger
  if (typeof DebugLogger !== 'undefined') {
    try {
      DebugLogger.tracking.sessionEvent('satisfaction_data_received', {
        tabId,
        sessionDuration: message.data?.sessionDuration,
        frustrationScore: message.data?.frustration?.frustrationScore,
        attentionQuality: message.data?.attentionQuality?.attentionQuality
      });
    } catch (error) {
      console.warn('[revolution-addon] ⚠️ Failed to log satisfaction data:', error);
    }
  }

  return Promise.resolve({ ok: true });
}

/**
 * Speichert Native Rating für eine Session
 */
const nativeRatingsStore = new Map(); // tabId -> rating

async function handleNativeRating(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    console.warn('[revolution-addon] ⚠️ No tab ID in native rating message');
    return Promise.resolve({ ok: false, error: 'no_tab_id' });
  }

  // Speichere Rating
  nativeRatingsStore.set(tabId, {
    rating: message.rating,
    domain: message.domain,
    url: message.url,
    timestamp: message.timestamp || Date.now()
  });

  // Auch zu Satisfaction Data hinzufügen
  const existingData = satisfactionDataStore.get(tabId) || {};
  satisfactionDataStore.set(tabId, {
    ...existingData,
    explicitFeedback: {
      rating: message.rating,
      source: 'native',
      domain: message.domain
    }
  });

  // Log zu Debug Logger
  if (typeof DebugLogger !== 'undefined') {
    try {
      DebugLogger.tracking.sessionEvent('native_rating_detected', {
        tabId,
        rating: message.rating,
        domain: message.domain
      });
    } catch (error) {
      console.warn('[revolution-addon] ⚠️ Failed to log native rating:', error);
    }
  }

  return Promise.resolve({ ok: true });
}

/**
 * Holt Satisfaction Data für einen Tab und löscht sie
 */
function getSatisfactionData(tabId) {
  const data = satisfactionDataStore.get(tabId);
  if (data) {
    satisfactionDataStore.delete(tabId);
  }
  return data || null;
}

/**
 * Cleanup bei Tab-Schließung
 */
function cleanupSatisfactionData(tabId) {
  satisfactionDataStore.delete(tabId);
  nativeRatingsStore.delete(tabId);
}

// ============================================================================
// MESSAGING INTEGRATION
// ============================================================================

async function handleSimulateTabClose(tabId) {
  // Log simulation start
  if (typeof DebugLogger !== 'undefined') {
    DebugLogger.tracking.tabClosed(tabId);
  }

  try {
    if (!tracker) {
      console.error('[revolution-addon] ❌ Tracker not available!');
      if (typeof DebugLogger !== 'undefined') {
        DebugLogger.error('tracker_unavailable', 'Tracker not available for tab close simulation', { tabId });
      }
      throw new Error('Tracker not initialized');
    }

    tracker.handleTabClosed(tabId);

    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.success('tab_close_simulated', 'Tab close simulated successfully', { tabId });
    }

    return { ok: true };
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to simulate tab close:', error.message, error.stack);

    if (typeof DebugLogger !== 'undefined') {
      DebugLogger.error('tab_close_simulation_failed', 'Failed to simulate tab close', {
        tabId,
        error: error.message
      });
    }

    return { ok: false, error: error.message };
  }
}

async function initializeMessaging() {
  try {
    if (typeof window.MessagingIntegration === 'undefined') {
      console.error('[revolution-addon] ❌ MessagingIntegration not available!');
      return;
    }

    const state = await loadState();
    const userToken = state && state.userToken ? state.userToken : null;

    await window.MessagingIntegration.initMessaging(userToken);
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to initialize messaging:', error.message, error.stack);
  }
}

async function initializeRevolutionScoring() {
  try {
    if (typeof window.getRevolutionScoring !== 'function') {
      console.error('[revolution-addon] ❌ RevolutionScoring not loaded!');
      return;
    }

    const revolution = window.getRevolutionScoring();
    await revolution.initialize();
  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to initialize Revolution Scoring:', error.message, error.stack);
  }
}

// NOTE: Messaging and Revolution Scoring are now initialized in initializeBackgroundScript()
// in the correct order. No need for separate setTimeout calls here.

// Re-initialize messaging when state changes
const originalPersistState = persistState;
persistState = async (newState) => {
  await originalPersistState(newState);

  // Store user token separately for EntityResolver and other services
  if (newState && newState.userToken) {
    await browser.storage.local.set({ rev_user_token: newState.userToken });

    if (!window.MessagingIntegration.isMessagingInitialized()) {
      try {
        await window.MessagingIntegration.initMessaging(newState.userToken);
      } catch (error) {
        // Silent fail
      }
    }
  } else if (!newState || !newState.userToken) {
    // User logged out, stop messaging and clear token
    await browser.storage.local.remove('rev_user_token');

    if (window.MessagingIntegration.isMessagingInitialized()) {
      window.MessagingIntegration.stopMessaging();
    }
  }
};

// Add messaging info to popup status
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getMessagingInfo') {
    const info = window.MessagingIntegration.getMessagingInfo();
    sendResponse({ info });
    return false;
  }

  if (message.action === 'sendMessagingMessage') {
    window.MessagingIntegration.sendMessage(message.payload, message.type || 'rating')
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // async response
  }
});

// ============================================================================
// RATING MESSAGE SENDER (Independent of Transaction Execution)
// ============================================================================

/**
 * Sends rating message to website immediately after scoring
 * This is independent of transaction execution to ensure rating data
 * arrives even if transaction fails or is delayed
 *
 * @param {Object} result - Result from RevolutionScoring.processSession()
 * @param {Object} sessionSummary - Session summary data
 * @param {Object} messagingClient - Messaging client instance
 * @param {string} ratingRef - Rating reference ID
 */
async function sendRatingMessageToWebsite(result, sessionSummary, messagingClient, ratingRef) {
  try {
    if (!ratingRef) {
      throw new Error('No ratingRef provided');
    }

    // Load seeds from FingerprintSeedManager
    const seedManager = new FingerprintSeedManager({ storage: browser.storage.local });
    const seedObj = await seedManager.getSeeds(ratingRef);

    if (!seedObj) {
      throw new Error(`Seeds not found for ratingRef: ${ratingRef}`);
    }

    // Get website messaging public key
    const websitePublicKey = await getWebsiteMessagingPublicKey();
    if (!websitePublicKey) {
      throw new Error('Website messaging public key not available');
    }

    // Helper: Convert BigInt values to strings recursively
    const convertBigIntsToStrings = (obj) => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'bigint') return obj.toString();
      if (Array.isArray(obj)) return obj.map(convertBigIntsToStrings);
      if (typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = convertBigIntsToStrings(value);
        }
        return result;
      }
      return obj;
    };

    // Build RATING_FULL payload (full metadata for website)
    const fullPayload = convertBigIntsToStrings({
      ratingRef: ratingRef,

      // BOTH seeds for website
      seedCLtoSH: seedObj.seedCLtoSH,
      seedSHtoDS: seedObj.seedSHtoDS,

      // All transaction pairs
      transactionPairs: seedObj.transactionPairs,

      // Full metadata (SENSITIVE! Only visible to website)
      sessionId: sessionSummary.sessionId,
      score: result.scoring?.score, // Gesamt-Rating - PFLICHTFELD (kein Fallback)
      tokens: result.distribution?.tokens?.toString() || '0',
      timestamp: Date.now(),
      paymentType: 'anonymous',
      url: sessionSummary.url || null,
      domain: result.distribution?.domain || extractDomain(sessionSummary.url),
      metadata: result.distribution?.metadata || {}
    });

    // Validierung: Score ist Pflichtfeld (ganze, positive Zahl)
    if (typeof fullPayload.score !== 'number' || !Number.isInteger(fullPayload.score) || fullPayload.score <= 0) {
      console.error('[revolution-addon] ❌ Invalid rating - score must be positive integer:', fullPayload.score);
      throw new Error('Rating message requires valid score field (positive integer)');
    }

    // Get current website encryption key from ADDRESS_UPDATE (not hardcoded config)
    const storage = await browser.storage.local.get(['website_keys']);
    let actualWebsitePublicKey = websitePublicKey; // Fallback to config key

    if (storage.website_keys && storage.website_keys.encryption_key) {
      actualWebsitePublicKey = storage.website_keys.encryption_key;
    } else {
      console.warn('[revolution-addon] ⚠️ No website_keys in storage, using fallback config key');
    }

    // Encrypt with Sealed Box using CURRENT website public key
    const encrypted = await window.SealedBox.encrypt(fullPayload, actualWebsitePublicKey);

    const encryptedMessage = {
      type: 'RATING_FULL',
      encryptedPayload: encrypted.ciphertext,
      algorithm: encrypted.algorithm
    };

    // Send to website via messaging service
    await sendToWebsiteOnly(messagingClient, encryptedMessage, actualWebsitePublicKey);

    // Send RATING_SUMMARY to other devices
    try {
      await sendRatingSummaryToOtherDevices(messagingClient, seedObj, result);
    } catch (summaryError) {
      console.error('[revolution-addon] ❌ Failed to send RATING_SUMMARY:', summaryError);
      // Non-blocking: continue even if RATING_SUMMARY fails
    }

  } catch (error) {
    console.error('[revolution-addon] ❌ Failed to send rating message:', error);
    throw error;
  }
}

/**
 * Send RATING_SUMMARY to all devices EXCEPT website
 * Privacy: Only contains seedCLtoSH + indices + amounts (NO domain/URL)
 *
 * @param {Object} messagingClient - Messaging client instance
 * @param {Object} seedObj - Seed object with seedCLtoSH, seedSHtoDS, transactionPairs
 * @param {Object} scoringResult - Result from RevolutionScoring.processSession()
 */
async function sendRatingSummaryToOtherDevices(messagingClient, seedObj, scoringResult) {
  const distributionMetadata = scoringResult.distribution?.metadata;
  const transaction = {
    ratingRef: scoringResult.scoring?.metadata?.ratingRef,
    tokens: BigInt(scoringResult.distribution?.tokens || 0)
  };

  // Extract amounts from distributionMetadata
  const amounts = seedObj.transactionPairs.map((_, idx) => {
    const standardized = distributionMetadata?.standardizedTokens || distributionMetadata?.payoutTokens;

    if (standardized) {
      if (idx === 0) {
        return standardized.toString();
      } else {
        return '0'; // Placeholder for future referrer splits
      }
    }

    return (transaction.tokens / BigInt(seedObj.transactionPairs.length)).toString();
  });

  const summaryPayload = {
    type: 'RATING_SUMMARY',
    data: {
      ratingRef: transaction.ratingRef,
      seedCLtoSH: seedObj.seedCLtoSH,
      transactionIndices: seedObj.transactionPairs.map(pair => pair.index),
      amounts: amounts,
      timestamp: Date.now()
    }
  };

  // Get website fingerprint to exclude
  const storage = await browser.storage.local.get(['website_keys']);
  const websiteMessagingAddress = storage.website_keys?.messaging_address;

  // Get all group keys
  const groupKeys = messagingClient.groupKeys || {};
  const selfFingerprint = messagingClient.messagingAddress || messagingClient.fingerprint;

  // Filter recipients: all devices EXCEPT self and website
  const recipients = Object.keys(groupKeys).filter(
    fp => fp !== selfFingerprint && fp !== websiteMessagingAddress
  );

  if (recipients.length === 0) {
    return { success: true, skipped: true };
  }

  // Send using messagingClient.sendMessage (handles encryption, signing, etc.)
  // Use 'rating' type for messaging-service validation (rating_summary is internal payload type)
  await messagingClient.sendMessage(summaryPayload, 'rating', recipients);

  return { success: true, recipientCount: recipients.length };
}

/**
 * Get website messaging public key from RevolutionConfig
 */
async function getWebsiteMessagingPublicKey() {
  if (typeof RevolutionConfig === 'undefined' || !RevolutionConfig.WEBSITE_MESSAGING_PUBLIC_KEY) {
    console.error('[revolution-addon] ⚠️ Website messaging public key not configured');
    return null;
  }
  return RevolutionConfig.WEBSITE_MESSAGING_PUBLIC_KEY;
}

/**
 * Send message to website only (not broadcast to all devices)
 *
 * Binary Sender/Receiver Model:
 * - First try to get website keys from browser.storage (website_keys from ADDRESS_UPDATE)
 * - Fallback to groupKeys lookup (legacy)
 */
async function sendToWebsiteOnly(messagingClient, payload, websitePublicKey) {
  // Binary Model: Try to get website keys from browser.storage first
  let websiteMessagingAddress = null;

  try {
    const storage = await browser.storage.local.get(['website_keys']);
    if (storage.website_keys && storage.website_keys.messaging_address) {
      websiteMessagingAddress = storage.website_keys.messaging_address;
    }
  } catch (e) {
    console.warn('[revolution-addon] ⚠️ Could not load website_keys from storage:', e.message);
  }

  // Fallback: Calculate fingerprint from websitePublicKey (legacy approach)
  if (!websiteMessagingAddress && websitePublicKey) {
    const websitePublicKeyBytes = sodium.from_base64(
      websitePublicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING
    );
    const hash = sodium.crypto_generichash(32, websitePublicKeyBytes);
    const websiteFingerprint = sodium.to_base64(hash, sodium.base64_variants.URLSAFE_NO_PADDING);

    // Check if website is in groupKeys
    if (messagingClient.groupKeys[websiteFingerprint]) {
      websiteMessagingAddress = websiteFingerprint;
    }
  }

  if (!websiteMessagingAddress) {
    throw new Error('Website keys not available - waiting for ADDRESS_UPDATE message');
  }

  // Send message to messaging service with website as recipient
  // The sendMessage function will look up the encryption key from browser.storage
  await messagingClient.sendMessage(payload, 'rating', [websiteMessagingAddress]);
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  if (!url) return 'unknown';
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (error) {
    return 'unknown';
  }
}
