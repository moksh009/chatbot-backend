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

/** Shown in dashboard until users understand Meta’s “messages” subscription requirement. */
const MESSAGES_FIELD_REMINDER =
  'In Meta: open your app → WhatsApp → scroll to Webhooks → next to “WhatsApp Business Account” click Manage → turn ON the “messages” field (subscribe). If “messages” is off, Meta will not send customer replies to TopEdge — you will only see outbound traffic.';

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
    messagesFieldReminder: MESSAGES_FIELD_REMINDER,
  };

  if (!pid) {
    return {
      ...base,
      webhookStatus: 'needs_whatsapp',
      webhookStatusLabel: 'Save WhatsApp credentials',
      webhookStatusHeadline: null,
      webhookStatusDetail:
        'Add Phone Number ID and access token in this screen first. Then copy your workspace webhook URL into Meta.',
    };
  }
  if (inboundOk) {
    return {
      ...base,
      webhookStatus: 'live',
      webhookStatusLabel: 'Receiving customer messages',
      webhookStatusHeadline: 'WhatsApp is fully configured with TopEdge',
      webhookStatusDetail: `Meta is sending inbound traffic. Last message webhook: ${formatAgo(lastIn)}. Keep the “messages” field subscribed in Meta so this continues.`,
    };
  }
  if (metaOk) {
    return {
      ...base,
      webhookStatus: 'verified',
      webhookStatusLabel: 'Callback verified',
      webhookStatusHeadline: 'WhatsApp webhook successfully configured with TopEdge',
      webhookStatusDetail:
        'Meta successfully verified your Callback URL and verify token — our server is linked. Customer chats still need the “messages” webhook field enabled in Meta (see the important note below). Send a test “hi” from your phone to confirm once “messages” is on.',
    };
  }
  if (ackOk) {
    return {
      ...base,
      webhookStatus: 'acknowledged',
      webhookStatusLabel: 'You marked setup done',
      webhookStatusHeadline: null,
      webhookStatusDetail:
        'We are waiting for Meta to send the first webhook. If nothing arrives, re-check Callback URL, verify token, and that “messages” is subscribed under Webhooks → WhatsApp Business Account → Manage.',
    };
  }
  return {
    ...base,
    webhookStatus: 'action_required',
    webhookStatusLabel: 'Finish Meta setup',
    webhookStatusHeadline: null,
    webhookStatusDetail:
      'Paste your workspace Callback URL and verify token in Meta → WhatsApp → Configuration, then click Verify and save. Then subscribe to the “messages” field (see below) or inbound chats will not arrive.',
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
