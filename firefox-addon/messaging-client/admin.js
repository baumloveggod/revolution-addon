/**
 * Admin Library for Group Management
 * Functions for managing groups and key rotation
 */

import {
  generateKeyPair,
  generateSigningKeyPair,
  generateFingerprint,
  encryptMessage,
  signMessage,
  generateNonce
} from './crypto.js';

/**
 * Admin Client for managing messaging groups
 */
export class MessagingAdmin {
  constructor(options = {}) {
    this.serviceUrl = options.serviceUrl || 'http://192.168.178.130:4200';
    this.authToken = options.authToken || null;
    this.adminKeyPair = null;
    this.adminSigningKeyPair = null;
  }

  /**
   * Set auth token
   */
  setAuthToken(token) {
    this.authToken = token;
  }

  /**
   * Initialize admin client with existing or new keypair
   */
  async initialize(keyPair = null, signingKeyPair = null) {
    if (keyPair && signingKeyPair) {
      this.adminKeyPair = keyPair;
      this.adminSigningKeyPair = signingKeyPair;
    } else {
      // Generate new keypair for admin
      this.adminKeyPair = await generateKeyPair();
      this.adminSigningKeyPair = await generateSigningKeyPair();
    }

    return {
      publicKey: this.adminKeyPair.publicKey,
      signingPublicKey: this.adminSigningKeyPair.publicKey
    };
  }

  /**
   * Add a client to a group
   */
  async addClient(fingerprint, publicKey, signingPublicKey, groupId) {
    if (!this.authToken) {
      throw new Error('Auth token required');
    }

    try {
      const response = await fetch(`${this.serviceUrl}/admin/add-client`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify({
          fingerprint,
          publicKey,
          signingPublicKey,
          groupId
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Add client failed');
      }

      const data = await response.json();
      console.log('Client added:', data);
      return data;
    } catch (error) {
      console.error('Add client error:', error);
      throw error;
    }
  }

  /**
   * Remove a client from a group
   * Triggers automatic key rotation
   */
  async removeClient(fingerprint) {
    if (!this.authToken) {
      throw new Error('Auth token required');
    }

    try {
      const response = await fetch(`${this.serviceUrl}/admin/remove-client`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify({
          fingerprint
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Remove client failed');
      }

      const data = await response.json();
      console.log('Client removed:', data);
      return data;
    } catch (error) {
      console.error('Remove client error:', error);
      throw error;
    }
  }

  /**
   * Manually trigger key rotation for a group
   */
  async rotateKeys(groupId, newGroupSecret = null) {
    if (!this.authToken) {
      throw new Error('Auth token required');
    }

    try {
      const response = await fetch(`${this.serviceUrl}/admin/rotate-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify({
          groupId,
          newGroupSecret
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Key rotation failed');
      }

      const data = await response.json();
      console.log('Key rotation initiated:', data);
      return data;
    } catch (error) {
      console.error('Key rotation error:', error);
      throw error;
    }
  }

  /**
   * Get all public keys for a group
   */
  async getGroupKeys(groupId) {
    if (!this.authToken) {
      throw new Error('Auth token required');
    }

    try {
      const response = await fetch(`${this.serviceUrl}/keys?groupId=${groupId}`, {
        headers: {
          'Authorization': `Bearer ${this.authToken}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch group keys');
      }

      const data = await response.json();
      return data.keys;
    } catch (error) {
      console.error('Failed to fetch group keys:', error);
      throw error;
    }
  }

  /**
   * Generate invitation for a new client
   * Creates keypair and returns registration info
   */
  async generateClientInvitation() {
    const keyPair = await generateKeyPair();
    const signingKeyPair = await generateSigningKeyPair();
    const fingerprint = await generateFingerprint(keyPair.publicKey);

    return {
      keyPair,
      signingKeyPair,
      fingerprint,
      publicKey: keyPair.publicKey,
      signingPublicKey: signingKeyPair.publicKey
    };
  }

  /**
   * Send a key rotation message to all group members
   * Encrypts a new group secret for each member
   */
  async sendKeyRotationMessage(groupId, newGroupSecret, recipients) {
    if (!this.authToken) {
      throw new Error('Auth token required');
    }

    // Get all group keys
    const groupKeys = await this.getGroupKeys(groupId);

    // Encrypt the new group secret for each recipient
    const encryptedPayloads = {};
    const recipientFingerprints = [];

    for (const key of groupKeys) {
      if (recipients.includes(key.fingerprint)) {
        const encrypted = await encryptMessage(
          newGroupSecret,
          key.publicKey,
          this.adminKeyPair.privateKey
        );
        encryptedPayloads[key.fingerprint] = encrypted;
        recipientFingerprints.push(key.fingerprint);
      }
    }

    // Create key rotation message
    const adminFingerprint = await generateFingerprint(this.adminKeyPair.publicKey);
    const message = {
      id: crypto.randomUUID(),
      type: 'key_rotation',
      timestamp: Date.now(),
      nonce: await generateNonce(),
      sender: adminFingerprint,
      recipients: recipientFingerprints,
      payload: encryptedPayloads
    };

    // Sign the message
    const messageString = JSON.stringify(message);
    message.signature = await signMessage(messageString, this.adminSigningKeyPair.privateKey);

    // Send to server
    const response = await fetch(`${this.serviceUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({
        message,
        groupId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Key rotation message failed');
    }

    const data = await response.json();
    console.log('Key rotation message sent:', data);
    return data;
  }
}

export default MessagingAdmin;
