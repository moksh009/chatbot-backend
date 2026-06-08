/**
 * Detect transient MongoDB / TLS failures (Atlas blips, pool contention, SSL MAC alerts).
 */
function isMongoTransientError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('bad record mac') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket') ||
    msg.includes('topology') ||
    msg.includes('timed out') ||
    msg.includes('not primary') ||
    msg.includes('interrupted') ||
    msg.includes('connection pool')
  );
}

/**
 * Retry a Mongo write/read once or twice on transient network/TLS errors.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, delayMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withMongoRetry(fn, { retries = 2, delayMs = 280 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isMongoTransientError(err) || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { isMongoTransientError, withMongoRetry };
