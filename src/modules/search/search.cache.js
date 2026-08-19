/**
 * search.cache.js
 * * Production-grade client-side caching layer for the Knowledge Platform.
 * Implements an LRU (Least Recently Used) cache backed by a TTL (Time-To-Live) 
 * mechanism to prevent memory bloating while ensuring instant command palette responses.
 */

class SearchCacheEngine {
  /**
   * @param {Object} options
   * @param {number} options.maxSize - Maximum number of unique query strings to cache.
   * @param {number} options.ttlMs - Cache expiration duration in milliseconds (Default: 5 minutes).
   */
  constructor({ maxSize = 100, ttlMs = 5 * 60 * 1000 } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    // Map preserves insertion order, allowing clean LRU eviction via keys().next()
    this.cache = new Map();
  }

  /**
   * Generates a deterministic cache key by normalizing and trimming the query string.
   * @param {string} query 
   * @param {Object} filters 
   * @returns {string}
   * @private
   */
  _buildKey(query, filters = {}) {
    const normalizedQuery = String(query).trim().toLowerCase();
    const serializedFilters = Object.keys(filters)
      .sort()
      .map(key => `${key}:${String(filters[key]).toLowerCase()}`)
      .join('|');
    
    return serializedFilters ? `${normalizedQuery}::[${serializedFilters}]` : normalizedQuery;
  }

  /**
   * Retrieves a entry from the cache. If the item exists but is expired, 
   * it purges it immediately and returns null.
   * @param {string} query 
   * @param {Object} [filters]
   * @returns {any | null} Cached data payload or null if missed/expired.
   */
  get(query, filters = {}) {
    const key = this._buildKey(query, filters);
    
    if (!this.cache.has(key)) {
      return null;
    }

    const entry = this.cache.get(key);
    const now = Date.now();

    // Check if the cache entry has outlived its TTL
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Refresh position in Map to mark it as Most Recently Used
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.payload;
  }

  /**
   * Stores a search or suggestion payload in the cache.
   * Triggers LRU eviction if cache constraints are breached.
   * @param {string} query 
   * @param {any} payload - Transformed/Mapped UI dataset.
   * @param {Object} [filters]
   */
  set(query, payload, filters = {}) {
    const key = this._buildKey(query, filters);

    // If key already exists, delete it first to reset its freshness position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } 
    // Evict the oldest entry (Least Recently Used) if max size limit is met
    else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      payload,
      timestamp: Date.now()
    });
  }

  /**
   * Explicitly evicts a specific query from the cache layer.
   * Useful if content is updated mid-session.
   */
  invalidate(query, filters = {}) {
    const key = this._buildKey(query, filters);
    return this.cache.delete(key);
  }

  /**
   * Clears out all entries. Call this during global application events 
   * like user logout or manual sync triggers.
   */
  clearAll() {
    this.cache.clear();
  }

  /**
   * Returns metadata snapshot for telemetry, debugging, or logging performance.
   */
  getMetrics() {
    return {
      currentCacheSize: this.cache.size,
      maxConfiguredSize: this.maxSize,
      configuredTtlMs: this.ttlMs
    };
  }
}

const searchCache = new SearchCacheEngine({
  maxSize: 150,       // Track up to 150 unique command palette keystroke variations
  ttlMs: 3 * 60 * 1000 // Cache values stay fresh for 3 minutes before hitting the network again
});

module.exports = {
  SearchCacheEngine,
  searchCache
};