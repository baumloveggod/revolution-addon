# Tracking System - Beispiele

## Grundlegende Verwendung

### 1. Tracking-Daten im Popup anzeigen

Füge folgenden Code zu `popup.js` hinzu:

```javascript
// Button zum Anzeigen der Tracking-Statistiken
const showTrackingButton = document.getElementById('showTracking');

showTrackingButton.addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'GET_TRACKING_SESSIONS'
    });

    console.log('Aktive Sessions:', response.activeSessions);
    console.log('Abgeschlossene Sessions:', response.completedSessions);

    // Berechne Statistiken
    const stats = calculateStats(response.completedSessions);
    displayStats(stats);
  } catch (error) {
    console.error('Fehler beim Abrufen der Tracking-Daten:', error);
  }
});

function calculateStats(sessions) {
  if (!sessions || sessions.length === 0) {
    return {
      totalSessions: 0,
      totalActiveTime: 0,
      totalPassiveTime: 0,
      averageActiveTime: 0,
      averagePassiveTime: 0
    };
  }

  const totalActiveTime = sessions.reduce((sum, s) =>
    sum + (s.metrics.activeTime.valueSeconds || 0), 0
  );

  const totalPassiveTime = sessions.reduce((sum, s) =>
    sum + (s.metrics.passiveTime.valueSeconds || 0), 0
  );

  return {
    totalSessions: sessions.length,
    totalActiveTime,
    totalPassiveTime,
    averageActiveTime: Math.round(totalActiveTime / sessions.length),
    averagePassiveTime: Math.round(totalPassiveTime / sessions.length),
    totalTime: totalActiveTime + totalPassiveTime
  };
}

function displayStats(stats) {
  const statsDiv = document.getElementById('trackingStats');
  statsDiv.innerHTML = `
    <h3>Tracking Statistiken</h3>
    <p>Gesamt Sessions: ${stats.totalSessions}</p>
    <p>Gesamt aktive Zeit: ${formatTime(stats.totalActiveTime)}</p>
    <p>Gesamt passive Zeit: ${formatTime(stats.totalPassiveTime)}</p>
    <p>Durchschnitt aktiv: ${formatTime(stats.averageActiveTime)}</p>
    <p>Durchschnitt passiv: ${formatTime(stats.averagePassiveTime)}</p>
    <p><strong>Gesamt Zeit: ${formatTime(stats.totalTime)}</strong></p>
  `;
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}
```

### 2. Session-Details anzeigen

```javascript
async function showSessionDetails() {
  const response = await browser.runtime.sendMessage({
    type: 'GET_TRACKING_SESSIONS'
  });

  const sessions = response.completedSessions;

  const tableHTML = `
    <table>
      <thead>
        <tr>
          <th>URL</th>
          <th>Aktive Zeit</th>
          <th>Passive Zeit</th>
          <th>Gesamt</th>
          <th>Start</th>
          <th>Ende</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.map(s => `
          <tr>
            <td>${truncateUrl(s.url)}</td>
            <td>${s.metrics.activeTime.valueSeconds}s</td>
            <td>${s.metrics.passiveTime.valueSeconds}s</td>
            <td>${s.totalTimeSeconds}s</td>
            <td>${formatDateTime(s.startTime)}</td>
            <td>${formatDateTime(s.endTime)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('sessionTable').innerHTML = tableHTML;
}

function truncateUrl(url, maxLength = 50) {
  return url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
}

function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });
}
```

### 3. Sessions löschen nach Upload

```javascript
async function uploadAndClearSessions() {
  try {
    // 1. Hole alle abgeschlossenen Sessions
    const response = await browser.runtime.sendMessage({
      type: 'GET_TRACKING_SESSIONS'
    });

    const sessions = response.completedSessions;

    if (sessions.length === 0) {
      console.log('Keine Sessions zum Upload vorhanden');
      return;
    }

    // 2. Upload an Server (Beispiel)
    await uploadToServer(sessions);

    // 3. Lösche lokale Sessions nach erfolgreichem Upload
    await browser.runtime.sendMessage({
      type: 'CLEAR_COMPLETED_SESSIONS'
    });

    console.log(`${sessions.length} Sessions erfolgreich hochgeladen und gelöscht`);
  } catch (error) {
    console.error('Fehler beim Upload:', error);
  }
}

async function uploadToServer(sessions) {
  // Beispiel für Server-Upload
  const state = await browser.runtime.sendMessage({ type: 'POPUP_STATUS' });

  if (!state.client_linked) {
    throw new Error('Nicht mit Server verbunden');
  }

  // Hier würde der tatsächliche API-Call stattfinden
  const response = await fetch('http://localhost:3000/api/tracking/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.client.sessionToken}`
    },
    body: JSON.stringify({ sessions })
  });

  if (!response.ok) {
    throw new Error(`Upload fehlgeschlagen: ${response.status}`);
  }

  return await response.json();
}
```

## Erweiterte Beispiele

### 4. Real-time Session Monitoring

```javascript
// Zeige aktuelle Session in Echtzeit
async function monitorCurrentSession() {
  const updateInterval = setInterval(async () => {
    const response = await browser.runtime.sendMessage({
      type: 'GET_TRACKING_SESSIONS'
    });

    const activeSessions = response.activeSessions;

    if (activeSessions.length > 0) {
      const current = activeSessions[0]; // Angenommen nur eine aktive

      document.getElementById('currentUrl').textContent = current.url;
      document.getElementById('currentActive').textContent =
        `${current.metrics.activeTime.valueSeconds}s`;
      document.getElementById('currentPassive').textContent =
        `${current.metrics.passiveTime.valueSeconds}s`;
      document.getElementById('currentTotal').textContent =
        `${current.totalTimeSeconds}s`;
    }
  }, 1000); // Update jede Sekunde

  // Cleanup beim Schließen
  window.addEventListener('unload', () => {
    clearInterval(updateInterval);
  });
}
```

### 5. Bewertungs-Dashboard

```javascript
async function showEvaluationDashboard() {
  const response = await browser.runtime.sendMessage({
    type: 'GET_TRACKING_SESSIONS'
  });

  const sessions = response.completedSessions;

  // Gruppiere nach Domain
  const byDomain = {};
  sessions.forEach(session => {
    try {
      const domain = new URL(session.url).hostname;
      if (!byDomain[domain]) {
        byDomain[domain] = {
          domain,
          sessions: [],
          totalActiveTime: 0,
          totalPassiveTime: 0,
          totalScore: 0
        };
      }

      byDomain[domain].sessions.push(session);
      byDomain[domain].totalActiveTime += session.metrics.activeTime.valueSeconds;
      byDomain[domain].totalPassiveTime += session.metrics.passiveTime.valueSeconds;

      // Berechne Score für diese Session
      const score = calculateSessionScore(session);
      byDomain[domain].totalScore += score;
    } catch (error) {
      console.warn('Ungültige URL:', session.url);
    }
  });

  // Sortiere nach Score
  const sortedDomains = Object.values(byDomain)
    .sort((a, b) => b.totalScore - a.totalScore);

  // Zeige Top 10
  const top10HTML = sortedDomains.slice(0, 10).map((domain, index) => `
    <div class="domain-card">
      <h4>${index + 1}. ${domain.domain}</h4>
      <p>Sessions: ${domain.sessions.length}</p>
      <p>Aktive Zeit: ${formatTime(domain.totalActiveTime)}</p>
      <p>Passive Zeit: ${formatTime(domain.totalPassiveTime)}</p>
      <p><strong>Score: ${Math.round(domain.totalScore)}</strong></p>
    </div>
  `).join('');

  document.getElementById('topDomains').innerHTML = top10HTML;
}

function calculateSessionScore(session) {
  const activeTime = session.metrics.activeTime.valueSeconds;
  const passiveTime = session.metrics.passiveTime.valueSeconds;
  const totalTime = session.totalTimeSeconds;

  const activeWeight = 1.0;
  const passiveWeight = 0.3;
  const baseScore = (activeTime * activeWeight) + (passiveTime * passiveWeight);

  const activeRatio = totalTime > 0 ? activeTime / totalTime : 0;
  const qualityFactor = 0.5 + (activeRatio * 0.5);

  return baseScore * qualityFactor;
}
```

### 6. Export als CSV

```javascript
async function exportSessionsAsCSV() {
  const response = await browser.runtime.sendMessage({
    type: 'GET_TRACKING_SESSIONS'
  });

  const sessions = response.completedSessions;

  // CSV Header
  let csv = 'Session ID,URL,Start Time,End Time,Active Time (s),Passive Time (s),Total Time (s),Score\n';

  // CSV Rows
  sessions.forEach(session => {
    const score = calculateSessionScore(session);
    csv += [
      session.sessionId,
      `"${session.url}"`,
      session.startTime,
      session.endTime,
      session.metrics.activeTime.valueSeconds,
      session.metrics.passiveTime.valueSeconds,
      session.totalTimeSeconds,
      Math.round(score)
    ].join(',') + '\n';
  });

  // Download
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tracking-sessions-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

### 7. Automatischer Upload im Hintergrund

```javascript
// In background.js hinzufügen

// Upload alle 5 Minuten
const UPLOAD_INTERVAL = 5 * 60 * 1000;

setInterval(async () => {
  await autoUploadSessions();
}, UPLOAD_INTERVAL);

async function autoUploadSessions() {
  const sessions = tracker.getCompletedSessions();

  if (sessions.length === 0) {
    console.log('[tracking] Keine Sessions zum Upload');
    return;
  }

  const state = await loadState();
  if (!state || !state.client || !state.client.sessionToken) {
    console.log('[tracking] Kein gültiger Client, Skip Upload');
    return;
  }

  try {
    const origin = state.origin || pickKnownOrigin();
    const response = await fetch(`${origin}/api/tracking/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.client.sessionToken}`
      },
      body: JSON.stringify({
        sessions,
        clientId: state.client.clientId,
        userId: state.profile.userId
      })
    });

    if (!response.ok) {
      throw new Error(`Upload fehlgeschlagen: ${response.status}`);
    }

    // Erfolgreich - lösche lokale Sessions
    await tracker.clearCompletedSessions();
    console.log(`[tracking] ${sessions.length} Sessions hochgeladen`);
  } catch (error) {
    console.error('[tracking] Auto-Upload fehlgeschlagen:', error);
  }
}
```

### 8. Benachrichtigungen bei Meilensteinen

```javascript
// Zeige Benachrichtigung bei Erreichen von Meilensteinen

tracker.onSessionCompleted = async (sessionSummary) => {
  await handleSessionCompleted(sessionSummary);

  // Check Milestones
  checkMilestones(sessionSummary);
};

async function checkMilestones(sessionSummary) {
  const allSessions = tracker.getCompletedSessions();

  // Meilenstein: 100 Sessions
  if (allSessions.length === 100) {
    showNotification('🎉 Meilenstein erreicht!', '100 Webseiten-Besuche getrackt!');
  }

  // Meilenstein: 10 Stunden aktive Zeit
  const totalActiveTime = allSessions.reduce((sum, s) =>
    sum + s.metrics.activeTime.valueSeconds, 0
  );

  if (totalActiveTime >= 36000) { // 10 Stunden
    showNotification('⏰ Zeit-Meilenstein!', '10 Stunden aktive Zeit erreicht!');
  }
}

function showNotification(title, message) {
  browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('icon.png'),
    title,
    message
  });
}
```

## Testing Szenarien

### Test 1: Basis-Tracking
1. Öffne einen neuen Tab
2. Navigiere zu einer Webseite
3. Bleibe 30 Sekunden auf der Seite (aktiv)
4. Wechsle zu einem anderen Tab (30 Sekunden passiv)
5. Schließe den Tab
6. Prüfe in der Console: `tracker.getCompletedSessions()`

### Test 2: URL-Wechsel
1. Öffne einen Tab
2. Navigiere zu Seite A (20 Sekunden)
3. Navigiere zu Seite B (20 Sekunden)
4. Prüfe: Zwei separate Sessions wurden erstellt

### Test 3: Multi-Tab
1. Öffne 3 Tabs gleichzeitig
2. Wechsle zwischen ihnen
3. Schließe alle Tabs
4. Prüfe: 3 Sessions mit korrekter aktiv/passiv Verteilung

### Test 4: Browser Neustart
1. Erstelle mehrere Sessions
2. Schließe Browser komplett
3. Öffne Browser wieder
4. Prüfe: Sessions wurden persistent gespeichert

## Performance Monitoring

```javascript
// Überwache Tracking Performance
const performanceMonitor = {
  sessionStarts: 0,
  sessionEnds: 0,
  averageProcessingTime: 0,

  logPerformance() {
    console.log('[tracking-performance]', {
      activeSessions: tracker.activeSessions.size,
      completedSessions: tracker.completedSessions.length,
      sessionStarts: this.sessionStarts,
      sessionEnds: this.sessionEnds,
      avgProcessingTime: this.averageProcessingTime
    });
  }
};

// Periodisch loggen
setInterval(() => {
  performanceMonitor.logPerformance();
}, 60000); // Jede Minute
```
