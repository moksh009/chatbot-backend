const SuppressionList = require('../../../models/SuppressionList');

async function checkSuppression({ redis, clientId, channel, contact }) {
  const keyTarget = channel === 'email' ? (contact?.email || '') : (contact?.phoneNumber || '');
  if (!keyTarget) return { pass: false, blockedBy: 'suppression', reason: 'contact_target_missing' };
  const cacheKey = `envelope:suppress:${clientId}:${channel}:${keyTarget}`;
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached === '1') return { pass: false, blockedBy: 'suppression', reason: 'suppressed' };
  }
  const query = {
    clientId,
    phone: channel === 'email' ? keyTarget : String(keyTarget).replace(/\D/g, ''),
    channel: { $in: [channel, 'all'] },
  };
  const found = await SuppressionList.findOne(query).lean();
  if (!found) return { pass: true };
  if (redis) await redis.set(cacheKey, '1', 'EX', 60);
  return { pass: false, blockedBy: 'suppression', reason: found.reason || 'suppressed' };
}

module.exports = { checkSuppression };
