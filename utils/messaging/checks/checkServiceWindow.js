function checkServiceWindow({ channel, intent, payload, contact }) {
  if (channel !== 'whatsapp') return { pass: true };
  if (payload?.templateName) return { pass: true };
  if (intent !== 'service') return { pass: true };
  const lastInbound = contact?.lastInboundAt ? new Date(contact.lastInboundAt).getTime() : 0;
  const ageMs = Date.now() - lastInbound;
  const open = lastInbound > 0 && ageMs <= 24 * 60 * 60 * 1000;
  if (!open) return { pass: false, blockedBy: 'window_closed', reason: 'service_window_closed' };
  return { pass: true };
}

module.exports = { checkServiceWindow };
