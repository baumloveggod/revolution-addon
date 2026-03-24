/**
 * revolution-wallet
 *
 * Wallet classes for the Revolution platform.
 *
 * Usage in Node.js:
 *   import { WalletManager, AnonTransactionClient, FingerprintSeedManager, NodeMemoryStorage } from 'revolution-wallet';
 *   import sodium from 'libsodium-wrappers';
 *
 *   const storage = new NodeMemoryStorage();
 *
 *   const wallet = new WalletManager({ clApiUrl, clReadApiUrl, storage });
 *   const anon   = new AnonTransactionClient({ anonApiUrl, clApiUrl, clReadApiUrl, sodium });
 *   const seeds  = new FingerprintSeedManager({ storage });
 *
 * Usage in Firefox addon background context (pass dependencies explicitly):
 *   const wallet = new WalletManager({
 *     clApiUrl, clReadApiUrl,
 *     storage: browser.storage.local,
 *     fetch: window.fetchWithVersion
 *   });
 *   const anon = new AnonTransactionClient({
 *     anonApiUrl, clApiUrl, clReadApiUrl,
 *     fetch: window.fetchWithVersion,
 *     sodium: window.sodium
 *   });
 */

export { WalletManager }          from './src/wallet-manager.js';
export { AnonTransactionClient }  from './src/anon-transaction-client.js';
export { FingerprintSeedManager } from './src/fingerprint-seed-manager.js';
export { NodeMemoryStorage }      from './src/node-storage-adapter.js';
