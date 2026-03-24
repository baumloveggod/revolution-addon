/**
 * Node.js In-Memory Storage Adapter
 *
 * Implements the browser.storage.local interface for use in Node.js environments.
 * Useful for tests, scripts, and server-side usage.
 *
 * For production Node.js usage, replace with a persistent backend
 * (e.g., SQLite, Redis, or file-based storage).
 *
 * Interface: { get(keys), set(items), remove(keys) }
 */

class NodeMemoryStorage {
  constructor() {
    this._data = {};
  }

  /**
   * Get items by key(s)
   *
   * @param {string|string[]} keys - Key or array of keys
   * @returns {Promise<Object>} Object with matching key-value pairs
   */
  async get(keys) {
    const result = {};
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) {
      if (key in this._data) {
        result[key] = this._data[key];
      }
    }
    return result;
  }

  /**
   * Set items
   *
   * @param {Object} items - Key-value pairs to store
   * @returns {Promise<void>}
   */
  async set(items) {
    Object.assign(this._data, items);
  }

  /**
   * Remove items by key(s)
   *
   * @param {string|string[]} keys - Key or array of keys to remove
   * @returns {Promise<void>}
   */
  async remove(keys) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) {
      delete this._data[key];
    }
  }

  /**
   * Clear all stored data
   *
   * @returns {Promise<void>}
   */
  async clear() {
    this._data = {};
  }
}

export { NodeMemoryStorage };
export default NodeMemoryStorage;
