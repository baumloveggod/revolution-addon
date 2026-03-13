const SITE_ORIGINS = ['http://192.168.178.130:3000'];
const statusTextEl = document.getElementById('statusText');
const statusMetaEl = document.getElementById('statusMeta');
const clientStateEl = document.getElementById('clientState');
const pendingContainer = document.getElementById('pendingContainer');
const pendingTextEl = document.getElementById('pendingText');
const switchProfileButton = document.getElementById('switchProfileButton');
const loginButton = document.getElementById('loginButton');
const logoutButton = document.getElementById('logoutButton');
const debugLogsEl = document.getElementById('debugLogs');
const messagingSection = document.getElementById('messagingSection');
const simulateCloseButton = document.getElementById('simulateCloseButton');
const messagesListEl = document.getElementById('messagesList');
const exportSection = document.getElementById('exportSection');
const exportCSVButton = document.getElementById('exportCSVButton');
const exportJSONButton = document.getElementById('exportJSONButton');
let currentOrigin = null;
let messageLog = [];

function addDebugLog(message, data = null) {
  const timestamp = new Date().toLocaleTimeString('de-DE');
  const logLine = document.createElement('div');
  logLine.style.marginBottom = '4px';
  logLine.style.borderBottom = '1px solid #ddd';
  logLine.style.paddingBottom = '4px';

  let logText = `[${timestamp}] ${message}`;
  if (data) {
    logText += '\n' + JSON.stringify(data, null, 2);
  }

  logLine.textContent = logText;
  debugLogsEl.insertBefore(logLine, debugLogsEl.firstChild);

  console.log('[popup]', message, data || '');
}

function formatDate(dateIso) {
  if (!dateIso) return '';
  try {
    return new Date(dateIso).toLocaleString('de-DE');
  } catch (_) {
    return dateIso;
  }
}

function resolveOriginFromUrl(url) {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return SITE_ORIGINS.includes(origin) ? origin : null;
  } catch (_) {
    return null;
  }
}

async function detectActiveOrigin() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) return null;
    return resolveOriginFromUrl(tabs[0].url);
  } catch (_) {
    return null;
  }
}

function setLoginButtonMode(mode) {
  loginButton.hidden = false;
  loginButton.disabled = false;
  if (mode === 'switch') {
    loginButton.textContent = 'Webseite aufrufen';
    return;
  }
  loginButton.textContent = 'Über Webseite einloggen';
}

function describeProfile(profile) {
  if (!profile) {
    return 'Unbekanntes Profil';
  }
  if (profile.username) {
    return `${profile.username}${profile.role ? ` (${profile.role})` : ''}`;
  }
  if (profile.userId) {
    return `Nutzer #${profile.userId}`;
  }
  return 'Unbekanntes Profil';
}

function renderMessages() {
  // Clear existing content
  messagesListEl.textContent = '';

  if (messageLog.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-messages';
    emptyDiv.textContent = 'Noch keine Nachrichten empfangen';
    messagesListEl.appendChild(emptyDiv);
    return;
  }

  messageLog.forEach((msg, index) => {
    // Determine source from payload
    const source = msg.payload?.source || 'unknown';
    const sourceLabel = source === 'addon' ? '📱 Addon' : source === 'website' ? '🌐 Website' : '❓ Unbekannt';

    // Create message card
    const card = document.createElement('div');
    card.className = `message-card ${index === 0 ? 'new' : ''}`;

    // Create header
    const header = document.createElement('div');
    header.className = 'message-header';

    const badgeContainer = document.createElement('div');
    badgeContainer.style.display = 'flex';
    badgeContainer.style.gap = '4px';

    const typeBadge = document.createElement('span');
    typeBadge.className = `message-badge type-${msg.type}`;
    typeBadge.textContent = msg.type;
    badgeContainer.appendChild(typeBadge);

    if (source !== 'unknown') {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = `message-badge source-${source}`;
      sourceBadge.textContent = sourceLabel;
      badgeContainer.appendChild(sourceBadge);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = new Date(msg.timestamp).toLocaleTimeString('de-DE');

    header.appendChild(badgeContainer);
    header.appendChild(timeSpan);

    // Create sender
    const senderDiv = document.createElement('div');
    senderDiv.className = 'message-sender';
    const senderLabel = document.createElement('strong');
    senderLabel.textContent = 'Von:';
    senderDiv.appendChild(senderLabel);
    senderDiv.appendChild(document.createTextNode(' ' + (msg.sender ? msg.sender.substring(0, 12) + '...' : 'unbekannt')));

    // Create payload
    const payloadDiv = document.createElement('div');
    payloadDiv.className = 'message-payload';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(msg.payload, null, 2);
    payloadDiv.appendChild(pre);

    // Assemble card
    card.appendChild(header);
    card.appendChild(senderDiv);
    card.appendChild(payloadDiv);

    messagesListEl.appendChild(card);
  });
}

async function loadMessages() {
  try {
    const { messaging_log = [] } = await browser.storage.local.get('messaging_log');
    messageLog = messaging_log.slice(0, 10); // Nur die letzten 10 Nachrichten
    renderMessages();
  } catch (error) {
    addDebugLog('Fehler beim Laden von Nachrichten', { error: error.message });
  }
}

async function simulateTabClose() {
  addDebugLog('Simuliere Tab-Schließen...');
  simulateCloseButton.disabled = true;
  simulateCloseButton.textContent = 'Simuliere...';

  try {
    // Get current active tab
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error('Kein aktiver Tab gefunden');
    }

    const currentTabId = tabs[0].id;
    addDebugLog('Aktueller Tab gefunden', { tabId: currentTabId, url: tabs[0].url });

    // Call background script to simulate tab close
    addDebugLog('Sende SIMULATE_TAB_CLOSE an background.js...');
    const result = await browser.runtime.sendMessage({
      type: 'SIMULATE_TAB_CLOSE',
      tabId: currentTabId
    });

    addDebugLog('Antwort von background.js erhalten', { result });

    if (result && result.ok) {
      addDebugLog('Tab-Schließen erfolgreich simuliert', { tabId: currentTabId });
      alert(`✅ Tab-Schließen simuliert!\nBewertung wurde gestartet für Tab #${currentTabId}`);
    } else {
      addDebugLog('Fehler-Response', { result });
      throw new Error(result?.error || 'Unbekannter Fehler');
    }
  } catch (error) {
    addDebugLog('Fehler beim Simulieren des Tab-Schließens', { error: error.message });
    alert('❌ Fehler beim Simulieren: ' + error.message);
  } finally {
    simulateCloseButton.disabled = false;
    simulateCloseButton.textContent = '🔄 Tab-Schließen simulieren (Bewertung starten)';
  }
}

async function refreshStatus() {
  addDebugLog('refreshStatus aufgerufen');
  try {
    const response = await browser.runtime.sendMessage({ type: 'POPUP_STATUS' });
    addDebugLog('Status-Antwort erhalten', {
      loggedIn: response?.loggedIn,
      client_linked: response?.client_linked,
      client_status: response?.client_status,
      client_error: response?.client_error,
      hasProfile: !!response?.profile,
      profileUserId: response?.profile?.userId,
      profileUsername: response?.profile?.username,
      hasPending: !!response?.pending_profile,
      pendingUserId: response?.pending_profile?.userId,
      pendingUsername: response?.pending_profile?.username,
      origin: response?.origin
    });

    let resolvedOrigin = (response && response.origin) || null;
    if (!resolvedOrigin) {
      resolvedOrigin = await detectActiveOrigin();
      addDebugLog('Origin vom aktiven Tab erkannt', { origin: resolvedOrigin });
    }
    currentOrigin = resolvedOrigin;
    const hasPending = !!(response && response.pending_profile);
    const isLinked = !!(response && response.client_linked);
    const clientStatus = (response && response.client_status) || (isLinked ? 'linked' : 'idle');
    const loggedIn = !!(response && response.loggedIn);

    addDebugLog('Status verarbeitet', {
      loggedIn,
      isLinked,
      clientStatus,
      hasPending
    });
    if (isLinked) {
      const originHost = response.origin ? new URL(response.origin).host : 'Revolution';
      statusTextEl.textContent = `Eingeloggt bei ${originHost}`;
      const parts = [];
      if (response && response.profile && response.profile.username) {
        parts.push(`Nutzer: ${response.profile.username} (ID: ${response.profile.userId})`);
      }
      if (response && response.profile && response.profile.clientWallet) {
        parts.push(`Wallet: ${response.profile.clientWallet.substring(0, 10)}...`);
      }
      if (response && response.profile && response.profile.role) {
        parts.push(`Rolle: ${response.profile.role}`);
      }
      if (response && response.client_id) {
        parts.push(`Client #${response.client_id}`);
      }
      if (response && response.syncedAt) {
        parts.push(`Synced: ${formatDate(response.syncedAt)}`);
      }
      statusMetaEl.textContent = parts.join(' · ');
      setLoginButtonMode('switch');
      logoutButton.hidden = false;
      logoutButton.disabled = false;

      // Show messaging and export sections when logged in
      messagingSection.hidden = false;
      exportSection.hidden = false;
      loadMessages();
    } else if (clientStatus === 'error' && response && response.client_error) {
      statusTextEl.textContent = 'Verknüpfung fehlgeschlagen';

      const errorDetails = response.client_error_details;
      let errorMessage = response.client_error;

      // Add helpful details based on error type
      if (errorDetails) {
        if (errorDetails.httpStatus === 401 || errorDetails.httpStatus === 403) {
          errorMessage += ' (Authentifizierung fehlgeschlagen - bitte erneut anmelden)';
        } else if (errorDetails.httpStatus === 429) {
          errorMessage += ' (Zu viele Versuche - bitte später erneut versuchen)';
        } else if (errorDetails.httpStatus >= 500) {
          errorMessage += ' (Server-Problem - bitte später erneut versuchen)';
        }

        // Show retry countdown if auto-retry enabled
        if (errorDetails.retryable) {
          const timeSinceError = Date.now() - errorDetails.timestamp;
          const retryInSeconds = Math.max(0, Math.ceil((60000 - timeSinceError) / 1000));
          if (retryInSeconds > 0) {
            errorMessage += ` (Retry in ${retryInSeconds}s)`;
          }
        }
      }

      statusMetaEl.textContent = errorMessage;

      // Show retry button (if retryable)
      const existingRetryContainer = document.getElementById('retry-button-container');
      if (existingRetryContainer) {
        existingRetryContainer.remove();
      }

      if (errorDetails && errorDetails.retryable) {
        const retryButton = document.createElement('button');
        retryButton.textContent = 'Jetzt erneut versuchen';
        retryButton.style.marginTop = '12px';
        retryButton.style.padding = '8px 16px';
        retryButton.style.cursor = 'pointer';
        retryButton.onclick = async () => {
          retryButton.disabled = true;
          retryButton.textContent = 'Versuche erneut...';

          // Trigger retry by requesting active token (which triggers linking)
          await browser.runtime.sendMessage({ type: 'REQUEST_ACTIVE_TOKEN' });

          setTimeout(() => refreshStatus(), 1000);
        };

        const container = document.createElement('div');
        container.id = 'retry-button-container';
        container.style.marginTop = '8px';
        container.appendChild(retryButton);
        statusMetaEl.parentNode.insertBefore(container, statusMetaEl.nextSibling);
      }

      setLoginButtonMode('login');
      logoutButton.hidden = true;
    } else if (clientStatus === 'linking' || (loggedIn && !isLinked)) {
      // Beide Zustände zeigen die gleiche Nachricht
      statusTextEl.textContent = 'Verknüpfe Add-on…';
      statusMetaEl.textContent = 'Aktuelle Web-Sitzung wird übernommen.';
      setLoginButtonMode('switch');
      logoutButton.hidden = true;
    } else if (hasPending) {
      statusTextEl.textContent = 'Neues Profil erkannt';
      statusMetaEl.textContent = 'Klicke „Profil wechseln“, um das Add-on mit dem aktuellen Webseiten-Login zu koppeln.';
      setLoginButtonMode('login');
    } else {
      statusTextEl.textContent = 'Nicht verbunden';
      statusMetaEl.textContent = 'Melde dich auf der Webseite an, um das Add-on zu koppeln.';
      setLoginButtonMode('login');
      logoutButton.hidden = true;
      messagingSection.hidden = true;
      exportSection.hidden = true;
    }
    if (clientStatus === 'linking') {
      clientStateEl.textContent = 'Client-Verknüpfung läuft…';
    } else if (isLinked && response && response.client_session_valid === false) {
      clientStateEl.textContent = 'Session wird erneuert…';
    } else if (isLinked) {
      clientStateEl.textContent = 'Client-Session aktiv.';
    } else {
      clientStateEl.textContent = '';
    }
    if (hasPending) {
      pendingContainer.hidden = false;
      pendingTextEl.textContent = `Neues Profil erkannt: ${describeProfile(response.pending_profile)}.`;
      switchProfileButton.hidden = false;
      switchProfileButton.disabled = false;
      switchProfileButton.textContent = 'Profil wechseln';
    } else {
      pendingContainer.hidden = true;
      switchProfileButton.hidden = true;
    }
  } catch (error) {
    statusTextEl.textContent = 'Status konnte nicht geladen werden';
    const message = error && error.message ? error.message : 'Bitte später erneut versuchen.';
    statusMetaEl.textContent = message;
    clientStateEl.textContent = '';
    setLoginButtonMode('login');
    pendingContainer.hidden = true;
    switchProfileButton.hidden = true;
    logoutButton.hidden = true;
  }
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function collectAddonData() {
  const data = await browser.runtime.sendMessage({ type: 'GET_EXPORT_DATA' });
  if (!data) throw new Error('Keine Antwort vom Background-Script – bitte Addon neu laden');
  if (data.ok === false) throw new Error('Background-Fehler: ' + (data.error || 'unbekannt'));
  return data;
}

function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportAddonCSV() {
  exportCSVButton.disabled = true;
  exportCSVButton.textContent = 'Wird exportiert…';
  try {
    const data = await collectAddonData();
    const rows = [];

    // --- Profil & Wallet ---
    rows.push(['=== Profil & Wallet ===']);
    rows.push(['Feld', 'Wert']);
    rows.push(['Username', data.profile?.username || '']);
    rows.push(['User ID', data.profile?.userId || '']);
    rows.push(['Rolle', data.profile?.role || '']);
    rows.push(['CL Wallet Adresse', data.wallet?.address || '']);
    rows.push(['Wallet Empfangen', data.wallet?.receivedAt ? new Date(data.wallet.receivedAt).toISOString() : '']);
    rows.push([]);

    // --- Messaging Keys ---
    rows.push(['=== Messaging Keys ===']);
    rows.push(['Feld', 'Wert']);
    rows.push(['Meine Messaging-Adresse', data.messagingKeys?.myAddress || '']);
    rows.push(['Mein Public Key', data.messagingKeys?.myPublicKey || '']);
    rows.push(['Website Messaging-Adresse', data.messagingKeys?.websiteAddress || '']);
    rows.push(['Website Public Key', data.messagingKeys?.websitePublicKey || '']);
    rows.push([]);

    // --- Andere Devices des Users ---
    rows.push(['=== Bekannte Devices ===']);
    rows.push(['Messaging-Adresse', 'Public Key', 'Typ']);
    for (const d of (data.knownDevices || [])) {
      rows.push([d.messaging_address || '', d.encryption_key || '', d.type || '']);
    }
    rows.push([]);

    // --- Rating History (letzte 30 Tage) ---
    rows.push(['=== Rating History (letzte 30 Tage) ===']);
    rows.push(['Rating Ref', 'Domain', 'Score', 'Zeitpunkt']);
    for (const r of (data.ratingHistory || [])) {
      rows.push([r.ratingRef || '', r.domain || '', r.score ?? '', r.date ? new Date(r.date).toISOString() : '']);
    }
    rows.push([]);

    // --- Rating Seeds ---
    rows.push(['=== Rating Seeds ===']);
    rows.push(['Rating Ref', 'Domain', 'seedCLtoSH', 'seedSHtoDS', 'Status', 'Erstellt']);
    for (const s of (data.ratingSeeds || [])) {
      rows.push([s.ratingRef || '', s.domain || '', s.seedCLtoSH || '', s.seedSHtoDS || '', s.status || '', s.createdAt ? new Date(s.createdAt).toISOString() : '']);
    }
    rows.push([]);

    // --- Stored Transactions ---
    rows.push(['=== Stored Transactions ===']);
    rows.push(['Rating Ref', 'Typ', 'Fingerprint', 'Betrag', 'Status', 'Zeitpunkt']);
    for (const t of (data.storedTransactions || [])) {
      rows.push([t.ratingRef || '', t.type || '', t.fingerprint || '', t.amount ?? '', t.status || '', t.timestamp ? new Date(t.timestamp).toISOString() : '']);
    }
    rows.push([]);

    // --- Messaging Log ---
    rows.push(['=== Messaging Log ===']);
    rows.push(['Typ', 'Zeitpunkt', 'Payload']);
    for (const m of (data.messagingLog || [])) {
      rows.push([m.type || '', m.timestamp ? new Date(m.timestamp).toISOString() : '', JSON.stringify(m.payload || {})]);
    }

    const csvContent = rows.map(row => row.map(escapeCSVField).join(',')).join('\n');
    triggerDownload(`addon-export-${Date.now()}.csv`, new Blob([csvContent], { type: 'text/csv; charset=utf-8' }));
    addDebugLog('CSV-Export erfolgreich');
  } catch (error) {
    addDebugLog('CSV-Export fehlgeschlagen', { error: error.message });
    alert('CSV-Export fehlgeschlagen: ' + error.message);
  } finally {
    exportCSVButton.disabled = false;
    exportCSVButton.textContent = '📊 CSV';
  }
}

async function exportAddonJSON() {
  exportJSONButton.disabled = true;
  exportJSONButton.textContent = 'Wird exportiert…';
  try {
    const data = await collectAddonData();
    const exportData = {
      exported_at: new Date().toISOString(),
      source: 'firefox-addon-local-storage',
      profile: data.profile,
      wallet: data.wallet,
      messagingKeys: data.messagingKeys,
      knownDevices: data.knownDevices || [],
      ratingHistory: (data.ratingHistory || []).map(r => ({
        ratingRef: r.ratingRef,
        domain: r.domain,
        score: r.score,
        timestamp: r.date ? new Date(r.date).toISOString() : null
      })),
      ratingSeeds: (data.ratingSeeds || []).map(s => ({
        ratingRef: s.ratingRef,
        domain: s.domain,
        url: s.url,
        seedCLtoSH: s.seedCLtoSH,
        seedSHtoDS: s.seedSHtoDS,
        status: s.status,
        createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null,
        transactionPairs: s.transactionPairs || []
      })),
      ratingSummaries: data.ratingSummaries || [],
      storedTransactions: data.storedTransactions || [],
      messagingLog: (data.messagingLog || []).map(m => ({
        type: m.type,
        timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        payload: m.payload
      }))
    };

    triggerDownload(`addon-export-${Date.now()}.json`, new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json; charset=utf-8' }));
    addDebugLog('JSON-Export erfolgreich');
  } catch (error) {
    addDebugLog('JSON-Export fehlgeschlagen', { error: error.message });
    alert('JSON-Export fehlgeschlagen: ' + error.message);
  } finally {
    exportJSONButton.disabled = false;
    exportJSONButton.textContent = '📋 JSON';
  }
}

exportCSVButton.addEventListener('click', exportAddonCSV);
exportJSONButton.addEventListener('click', exportAddonJSON);

loginButton.addEventListener('click', async () => {
  loginButton.disabled = true;
  loginButton.textContent = 'Weiterleiten…';
  try {
    let preferredOrigin = currentOrigin;
    if (!preferredOrigin) {
      preferredOrigin = await detectActiveOrigin();
    }
    await browser.runtime.sendMessage({
      type: 'REQUEST_SITE_LOGIN',
      origin: preferredOrigin
    });
    window.close();
  } catch (error) {
    loginButton.disabled = false;
    loginButton.textContent = 'Über Webseite einloggen';
    statusMetaEl.textContent = 'Weiterleitung fehlgeschlagen, bitte erneut versuchen.';
  }
});

switchProfileButton.addEventListener('click', async () => {
  switchProfileButton.disabled = true;
  switchProfileButton.textContent = 'Wechsel läuft…';
  try {
    const result = await browser.runtime.sendMessage({ type: 'APPLY_PENDING_PROFILE' });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'pending_failed');
    }
    await refreshStatus();
  } catch (error) {
    pendingTextEl.textContent = 'Profilwechsel fehlgeschlagen. Bitte erneut versuchen.';
    switchProfileButton.disabled = false;
    switchProfileButton.textContent = 'Profil wechseln';
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  logoutButton.textContent = 'Abmelden…';
  addDebugLog('Logout angefordert');
  try {
    const result = await browser.runtime.sendMessage({ type: 'LOGOUT' });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'logout_failed');
    }
    addDebugLog('Logout erfolgreich');
    await refreshStatus();
  } catch (error) {
    addDebugLog('Logout fehlgeschlagen', { error: error.message });
    statusMetaEl.textContent = 'Abmeldung fehlgeschlagen. Bitte erneut versuchen.';
    logoutButton.disabled = false;
    logoutButton.textContent = 'Abmelden';
  }
});

// Simulate tab close button
simulateCloseButton.addEventListener('click', simulateTabClose);

addDebugLog('Popup geladen, fordere Token an');
browser.runtime.sendMessage({ type: 'REQUEST_ACTIVE_TOKEN' }).catch((err) => {
  addDebugLog('Fehler beim Anfordern von Token', { error: err.message });
});

refreshStatus();

// Regelmäßige Status-Updates alle 3 Sekunden
const refreshInterval = setInterval(refreshStatus, 3000);

// Regelmäßige Nachrichten-Updates alle 5 Sekunden
const messagesRefreshInterval = setInterval(loadMessages, 5000);

// Cleanup beim Schließen des Popups
window.addEventListener('unload', () => {
  clearInterval(refreshInterval);
  clearInterval(messagesRefreshInterval);
});
