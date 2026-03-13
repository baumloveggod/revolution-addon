/**
 * Update Checker Service
 *
 * Periodically checks server for version compatibility and
 * notifies users about available updates.
 */

class UpdateChecker {
  constructor() {
    this.checkInterval = 24 * 60 * 60 * 1000; // 24 hours
    this.serverApiUrl = 'http://192.168.178.130:3000'; // Will be set from state
  }

  /**
   * Start the update checker
   */
  async start() {
    // Get server URL from state
    const state = await browser.storage.local.get('server_api_url');
    if (state.server_api_url) {
      this.serverApiUrl = state.server_api_url;
    }

    // Check immediately on startup
    await this.checkServerVersion();

    // Then check every 24 hours
    setInterval(() => this.checkServerVersion(), this.checkInterval);

    console.log('[UpdateChecker] Started (checking every 24 hours)');
  }

  /**
   * Check server version compatibility
   */
  async checkServerVersion() {
    try {
      const response = await fetch(`${this.serverApiUrl}/api/version/info`, {
        headers: {
          'X-Client-API-Version': window.RevolutionConfig.version.apiVersion
        }
      });

      // Check for version warnings in response
      if (response.ok) {
        const data = await response.json();
        if (data._version_warning) {
          await this.handleVersionWarning(data._version_warning);
        }
      }
    } catch (error) {
      console.error('[UpdateChecker] Failed:', error);
    }
  }

  /**
   * Handle version warning from server
   * @param {object} warning - Version warning object
   */
  async handleVersionWarning(warning) {
    if (warning.type === 'server_newer') {
      // Server has newer version, client should upgrade
      await this.showUpgradeNotification(warning);
    } else if (warning.type === 'client_newer') {
      // Client has newer version, should downgrade (rare)
      await this.showDowngradeNotification(warning);
    }
  }

  /**
   * Show upgrade notification
   * @param {object} warning - Version warning
   */
  async showUpgradeNotification(warning) {
    await browser.notifications.create('version-upgrade-available', {
      type: 'basic',
      title: 'Revolution Update verfügbar',
      message: warning.message,
      iconUrl: 'icon.png',
      buttons: [
        { title: 'Jetzt aktualisieren' }
      ]
    });

    // Store warning
    await browser.storage.local.set({
      versionWarning: warning,
      lastVersionCheck: Date.now()
    });
  }

  /**
   * Show downgrade notification
   * @param {object} warning - Version warning
   */
  async showDowngradeNotification(warning) {
    await browser.notifications.create('version-downgrade-required', {
      type: 'basic',
      title: 'Revolution Version-Konflikt',
      message: warning.message,
      iconUrl: 'icon.png'
    });
  }
}

// Initialize on addon startup
const updateChecker = new UpdateChecker();
updateChecker.start();
