const AuditLog = require('../../models/AuditLog');

/**
 * New audit writes use `actor`. Legacy `user_id` is populated only for dashboard users.
 */
async function writeAuditLog({
  clientId,
  action_type,
  target_resource,
  actor,
  payload,
  ip_address,
  userAgent,
}) {
  const category = payload?.category || 'general';
  const severity = payload?.severity || 'info';

  const doc = {
    clientId,
    category,
    severity,
    action_type,
    target_resource: target_resource || '',
    payload: payload || {},
    ip_address: ip_address || actor?.ip || '',
    userAgent: userAgent || actor?.userAgent || '',
    actor: actor || { type: 'system', source: 'unknown' },
  };

  if (actor?.type === 'user' && actor.userId) {
    doc.user_id = actor.userId;
  } else if (actor?.type === 'super_admin' && actor.userId) {
    doc.user_id = actor.userId;
  }

  return AuditLog.create(doc);
}

module.exports = { writeAuditLog };
