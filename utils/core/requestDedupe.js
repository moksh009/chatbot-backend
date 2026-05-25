/**
 * Coalesce concurrent identical async work (e.g. duplicate GET /api/analytics).
 */
const inFlight = new Map();

/**
 * @param {string} key
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function dedupeAsync(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

module.exports = { dedupeAsync };
