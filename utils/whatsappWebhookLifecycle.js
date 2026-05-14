const Client = require('../models/Client');

function hasWhatsAppWebhookPayload(body) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes;
    if (!Array.isArray(changes)) return false;
    for (const ch of changes) {
      const v = ch?.value;
      if (v?.messages?.length || v?.statuses?.length) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function touchMetaWebhookVerified(clientId) {
  if (!clientId) return Promise.resolve();
  return Client.updateOne(
    { clientId: String(clientId).trim() },
    { $set: { 'platformVars.whatsappWebhookMetaVerifiedAt': new Date() } }
  ).exec();
}

function touchInboundWebhook(clientId) {
  if (!clientId) return Promise.resolve();
  return Client.updateOne(
    { clientId: String(clientId).trim() },
    { $set: { 'platformVars.whatsappLastInboundWebhookAt': new Date() } }
  ).exec();
}

/**
 * Human-readable webhook setup status for the dashboard (Meta + inbound activity).
 * @param {Record<string, unknown>} platformVars
 * @param {string} phoneNumberId
 */
function buildWebhookDashboardStatus(platformVars = {}, phoneNumberId) {
  const pid = String(phoneNumberId || '').trim();
  const now = Date.now();
  const MS_DAY = 86400000;
  const metaV = platformVars.whatsappWebhookMetaVerifiedAt;
  const lastIn = platformVars.whatsappLastInboundWebhookAt;
  const userAck = platformVars.whatsappWebhookSetupAckAt;

  const metaOk = metaV && now - new Date(metaV).getTime() < 90 * MS_DAY;
  const inboundOk = lastIn && now - new Date(lastIn).getTime() < 14 * MS_DAY;
  const ackOk = userAck && now - new Date(userAck).getTime() < 30 * MS_DAY;

  const base = {
    webhookMetaVerifiedAt: metaV || null,
    webhookLastInboundAt: lastIn || null,
    webhookSetupAckAt: userAck || null,
  };

  if (!pid) {
    return {
      ...base,
      webhookStatus: 'needs_whatsapp',
      webhookStatusLabel: 'Save WhatsApp credentials',
      webhookStatusDetail:
        'Add Phone Number ID and access token in this screen first. Then copy your workspace webhook URL into Meta.',
    };
  }
  if (inboundOk) {
    return {
      ...base,
      webhookStatus: 'live',
      webhookStatusLabel: 'Receiving webhooks',
      webhookStatusDetail: `Last inbound event ${formatAgo(lastIn)}.`,
    };
  }
  if (metaOk) {
    return {
      ...base,
      webhookStatus: 'verified',
      webhookStatusLabel: 'Meta verified',
      webhookStatusDetail:
        'Meta successfully reached your callback URL. Send a test message to your WhatsApp Business number to confirm inbound delivery.',
    };
  }
  if (ackOk) {
    return {
      ...base,
      webhookStatus: 'acknowledged',
      webhookStatusLabel: 'You marked as done',
      webhookStatusDetail:
        'Waiting for the first webhook event from Meta. If nothing arrives, double-check the Callback URL and field subscriptions in Meta.',
    };
  }
  return {
    ...base,
    webhookStatus: 'action_required',
    webhookStatusLabel: 'Finish setup in Meta',
    webhookStatusDetail:
      'Paste your workspace Callback URL and verify token in Meta → WhatsApp → Configuration, click Verify and save, then subscribe to “messages”.',
  };
}

function formatAgo(isoOrDate) {
  try {
    const t = new Date(isoOrDate).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 120) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  } catch (_) {
    return '';
  }
}

module.exports = {
  hasWhatsAppWebhookPayload,
  touchMetaWebhookVerified,
  touchInboundWebhook,
  buildWebhookDashboardStatus,
};
