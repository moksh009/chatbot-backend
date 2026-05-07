"use strict";

function normalizeChannel(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'ig' || c === 'instagram') return 'instagram';
  if (c === 'wa' || c === 'whatsapp') return 'whatsapp';
  if (c === 'mail' || c === 'email') return 'email';
  return c || 'unknown';
}

function buildEventEnvelope({
  channel,
  eventType,
  clientId,
  userId,
  message,
  payload = {},
  meta = {},
  traceId
}) {
  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    channel: normalizeChannel(channel),
    eventType: String(eventType || 'unknown'),
    clientId: clientId ? String(clientId) : undefined,
    userId: userId ? String(userId) : undefined,
    message: message || {},
    payload,
    meta,
    trace: {
      traceId: traceId || `trace_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    }
  };
}

module.exports = {
  buildEventEnvelope,
  normalizeChannel
};

