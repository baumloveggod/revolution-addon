/**
 * Bridge Detector - Erkennt ob ein lokaler Desktop Watcher laeuft
 *
 * Prueft den Bridge Server auf localhost:4250/status um zu erkennen
 * ob ein Desktop Watcher aktiv ist. Wird fuer Overlap-Handling genutzt:
 * Wenn ein Watcher laeuft, unterdrueckt das Addon Platform-Credits
 * (der Watcher trackt bereits app:firefox auf OS-Ebene).
 *
 * Ergebnis wird fuer 5 Minuten gecached. Bei Fehler/Timeout gilt der
 * Watcher als nicht aktiv (Standalone-Modus).
 */

class BridgeDetector {
  constructor() {
    this._cachedStatus = null;
    this._cacheTimestamp = 0;
    this.CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten Cache
    this.BRIDGE_URL = 'http://localhost:4250/status';
    this.FETCH_TIMEOUT_MS = 2000;
  }

  /**
   * Prueft den Bridge-Status (cached).
   * @returns {Promise<{watcher_active: boolean, tracks: string[]}>}
   */
  async checkBridgeStatus() {
    const now = Date.now();
    if (this._cachedStatus && (now - this._cacheTimestamp) < this.CACHE_TTL_MS) {
      return this._cachedStatus;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);

      const response = await fetch(this.BRIDGE_URL, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Bridge returned ${response.status}`);
      }

      const data = await response.json();
      this._cachedStatus = {
        watcher_active: !!data.watcher_active,
        watcher_registered: !!data.watcher_registered,
        tracks: Array.isArray(data.tracks) ? data.tracks : [],
      };
    } catch (_err) {
      // Bridge nicht erreichbar oder Timeout → Standalone-Modus
      this._cachedStatus = {
        watcher_active: false,
        watcher_registered: false,
        tracks: [],
      };
    }

    this._cacheTimestamp = Date.now();
    return this._cachedStatus;
  }

  /**
   * Gibt true zurueck wenn ein Desktop Watcher aktiv ist.
   * @returns {Promise<boolean>}
   */
  async isWatcherActive() {
    const status = await this.checkBridgeStatus();
    return status.watcher_active;
  }

  /**
   * Gibt die Tracks zurueck die der Watcher abdeckt (z.B. ['apps', 'platform']).
   * @returns {Promise<string[]>}
   */
  async getWatcherTracks() {
    const status = await this.checkBridgeStatus();
    return status.tracks;
  }

  /**
   * Prueft ob der Watcher einen bestimmten Track abdeckt.
   * @param {string} track - z.B. 'platform' oder 'apps'
   * @returns {Promise<boolean>}
   */
  async watcherCovers(track) {
    const tracks = await this.getWatcherTracks();
    return tracks.includes(track);
  }

  /** Cache invalidieren (z.B. nach Watcher-Start/-Stop). */
  invalidateCache() {
    this._cachedStatus = null;
    this._cacheTimestamp = 0;
  }
}

// Global verfuegbar machen (wie AddonDetector)
if (typeof window !== 'undefined') {
  window._bridgeDetector = new BridgeDetector();
}
