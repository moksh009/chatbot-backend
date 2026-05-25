async function consumeTokenBucket(redis, { key, capacity, refillPerSec, cost = 1 }) {
  if (!redis) return { pass: true };
  const now = Date.now();
  const bucketKey = `envelope:bucket:${key}`;
  const stateRaw = await redis.get(bucketKey);
  const state = stateRaw ? JSON.parse(stateRaw) : { tokens: capacity, ts: now };
  const elapsedSec = Math.max(0, (now - Number(state.ts || now)) / 1000);
  const refilled = Math.min(capacity, Number(state.tokens || 0) + elapsedSec * refillPerSec);
  if (refilled < cost) {
    const needed = cost - refilled;
    const retryAfter = Math.max(1, Math.ceil(needed / refillPerSec));
    await redis.set(bucketKey, JSON.stringify({ tokens: refilled, ts: now }), 'EX', 120);
    return { pass: false, retryAfter };
  }
  const remaining = refilled - cost;
  await redis.set(bucketKey, JSON.stringify({ tokens: remaining, ts: now }), 'EX', 120);
  return { pass: true };
}

module.exports = {
  consumeTokenBucket,
};
