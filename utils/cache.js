import NodeCache from 'node-cache';

/**
 * Node.js In-Memory Cache (No Redis dependency)
 * Standard TTL: 24 hours (86400 seconds)
 * Check period: 10 minutes (600 seconds)
 */
export const memoryCache = new NodeCache({
  stdTTL: 86400, // 24 hours
  checkperiod: 600, // check for expired keys every 10 mins
  useClones: false, // performance optimization
});

/**
 * Get item from cache
 */
export function getCache(key) {
  return memoryCache.get(key) || null;
}

/**
 * Set item in cache with TTL in seconds
 * @param {string} key
 * @param {*} value
 * @param {number} ttlSeconds Default: 24 hours (86400s)
 */
export function setCache(key, value, ttlSeconds = 86400) {
  return memoryCache.set(key, value, ttlSeconds);
}

/**
 * Delete key from cache
 */
export function delCache(key) {
  return memoryCache.del(key);
}

/**
 * Clear entire cache
 */
export function flushCache() {
  return memoryCache.flushAll();
}

export default {
  getCache,
  setCache,
  delCache,
  flushCache,
  memoryCache,
};
