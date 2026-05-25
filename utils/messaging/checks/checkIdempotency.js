async function checkIdempotency({ redis, key, ttlSec }) {
  if (!redis) return { pass: true };
  const ok = await redis.set(`envelope:idem:${key}`, '1', 'NX', 'EX', ttlSec);
  if (!ok) return { pass: false, blockedBy: 'idempotency', reason: 'duplicate_message' };
  return { pass: true };
}

module.exports = { checkIdempotency };
