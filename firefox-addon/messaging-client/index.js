/**
 * Messaging Client Library
 * E2E encrypted messaging for browser addons
 *
 * @example
 * import { MessagingClient } from 'messaging-client';
 *
 * const client = new MessagingClient({
 *   serviceUrl: 'https://msg.lenkenhoff.de',
 *   pollInterval: 5000,
 *   authToken: 'your-jwt-token'
 * });
 *
 * await client.initialize();
 * await client.register('group-id');
 *
 * client.onMessage = (message) => {
 *   console.log('New message:', message);
 * };
 *
 * client.startPolling();
 *
 * await client.sendMessage({ type: 'event', data: { ... } });
 */

export { MessagingClient } from './client.js';
export * as crypto from './crypto.js';
export * as storage from './storage.js';

export default { MessagingClient };
