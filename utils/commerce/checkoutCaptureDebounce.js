'use strict';

const { getAppRedis } = require('../core/redisFactory');

const CAPTURE_DEBOUNCE_SEC = 5;

/**
 * Skip identical checkout capture payloads within a short window (live typing / webhook spam).
 */
async function shouldSkipDuplicateCheckoutCapture(clientId, payload = {}) {
  const { checkoutToken, phoneE164, cartTotal, itemCount, source } = payload;
  const redis = getAppRedis();
  if (!redis || !clientId) return false;

  const anchor = checkoutToken || phoneE164;
  if (!anchor) return false;

  const signature = [
    String(phoneE164 || ''),
    String(cartTotal ?? ''),
    String(itemCount ?? ''),
    String(source || ''),
  ].join('|');

  const key = `checkout_cap_debounce:${clientId}:${String(anchor).slice(0, 120)}`;
  try {
    const prev = await redis.get(key);
    if (prev === signature) return true;
    await redis.set(key, signature, 'EX', CAPTURE_DEBOUNCE_SEC);
  } catch {
    return false;
  }
  return false;
}

module.exports = {
  shouldSkipDuplicateCheckoutCapture,
  CAPTURE_DEBOUNCE_SEC,
};
