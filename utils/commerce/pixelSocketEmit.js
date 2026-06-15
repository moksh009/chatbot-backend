'use strict';

const { invalidateRecoveryMetricsCache } = require('./cartRecoveryMetricsCache');

/**
 * Real-time cart capture events for dashboard invalidation (Phase 2 sync contract).
 */
function emitCartContactCaptured(clientId, payload = {}) {
  if (!global.io || !clientId) return;
  invalidateRecoveryMetricsCache(clientId);
  global.io.to(`client_${clientId}`).emit('cart:contact-captured', {
    clientId,
    ...payload,
    capturedAt: payload.capturedAt || new Date().toISOString(),
  });
}

function emitCartPromoted(clientId, payload = {}) {
  if (!global.io || !clientId) return;
  invalidateRecoveryMetricsCache(clientId);
  global.io.to(`client_${clientId}`).emit('cart:promoted', {
    clientId,
    ...payload,
    promotedAt: payload.promotedAt || new Date().toISOString(),
  });
}

function emitCartRecovered(clientId, payload = {}) {
  if (!global.io || !clientId) return;
  invalidateRecoveryMetricsCache(clientId);
  global.io.to(`client_${clientId}`).emit('cart:recovered', {
    clientId,
    ...payload,
    recoveredAt: payload.recoveredAt || new Date().toISOString(),
  });
}

function emitCartRecoverySent(clientId, payload = {}) {
  if (!global.io || !clientId) return;
  invalidateRecoveryMetricsCache(clientId);
  global.io.to(`client_${clientId}`).emit('cart:recovery-sent', {
    clientId,
    ...payload,
    sentAt: payload.sentAt || new Date().toISOString(),
  });
}

module.exports = {
  emitCartContactCaptured,
  emitCartPromoted,
  emitCartRecovered,
  emitCartRecoverySent,
};
