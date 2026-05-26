'use strict';

const buckets = new Map();

/**
 * Simple per-tenant token bucket (~2 req/sec sustained for SP-API).
 */
async function acquireAmazonToken(clientId, { maxPerSecond = 2 } = {}) {
  const key = clientId || 'global';
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: maxPerSecond, lastRefill: Date.now() };
    buckets.set(key, bucket);
  }

  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(maxPerSecond, bucket.tokens + elapsed * maxPerSecond);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const waitMs = Math.ceil(((1 - bucket.tokens) / maxPerSecond) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    bucket.tokens = 0;
    bucket.lastRefill = Date.now();
    return;
  }
  bucket.tokens -= 1;
}

async function withAmazonRetry(fn, { maxAttempts = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.status !== 429 && !err.isRateLimit) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { acquireAmazonToken, withAmazonRetry };
