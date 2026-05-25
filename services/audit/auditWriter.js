'use strict';

const { writeAuditLog } = require('../../utils/messaging/writeAuditLog');

const BATCH_MS = 1000;
const queue = [];
let flushTimer = null;

function mapSeverity(severity) {
  return severity || 'info';
}

function flushQueue() {
  flushTimer = null;
  const batch = queue.splice(0, queue.length);
  for (const item of batch) {
    writeAuditLog({
      clientId: item.clientId || 'system',
      action_type: item.action,
      target_resource: item.target_resource || '',
      actor: item.actor || { type: 'system', source: 'auditWriter' },
      payload: {
        category: item.category,
        severity: mapSeverity(item.severity),
        details: item.details || {},
      },
      ip_address: item.actor?.ip || '',
      userAgent: item.actor?.userAgent || '',
    }).catch((e) => {
      process.stderr.write(`[auditWriter] persist failed: ${e.message}\n`);
    });
  }
}

/**
 * Non-blocking audit write (Phase 5 A7).
 */
function auditLog({
  category,
  action,
  actor,
  clientId,
  details,
  severity = 'info',
  target_resource,
  blocking = false,
}) {
  if (process.env.SKIP_AUDIT_PERSIST === 'true') {
    return Promise.resolve();
  }
  const item = {
    category,
    action,
    actor,
    clientId: clientId || actor?.clientId || 'system',
    details,
    severity,
    target_resource,
  };

  const run = () => {
    if (blocking || category === 'security' || category === 'pii') {
      return writeAuditLog({
        clientId: item.clientId,
        action_type: action,
        target_resource: target_resource || '',
        actor: actor || { type: 'system', source: 'auditWriter' },
        payload: { category, severity, details: details || {} },
        ip_address: actor?.ip || '',
        userAgent: actor?.userAgent || '',
      });
    }
    queue.push(item);
    if (!flushTimer) {
      flushTimer = setTimeout(flushQueue, BATCH_MS);
    }
    return Promise.resolve();
  };

  if (blocking) return run();
  setImmediate(() => {
    run().catch((e) => process.stderr.write(`[auditWriter] ${e.message}\n`));
  });
}

process.on('beforeExit', () => {
  if (queue.length) flushQueue();
});

module.exports = { auditLog, flushQueue };
