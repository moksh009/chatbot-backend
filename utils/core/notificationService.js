"use strict";

const { normalizePhone } = require('./helpers');
const {
  sendSystemEmail,
  buildAdminEscalationEmailHtml,
  isSystemEmailReady,
} = require('./emailService');
const { getAppRedis } = require('./redisFactory');
const { indianPhoneSuffix, indianPhoneDigits } = require('./normalizeIndianPhone');
const log = require('./logger')('NotificationService');

const ADMIN_ALERT_DEDUP_SEC = Number(process.env.ADMIN_ALERT_DEDUP_SEC || 900);
const ADMIN_ALERT_MAX_RECIPIENTS = Number(process.env.ADMIN_ALERT_MAX_RECIPIENTS || 10);

function buildTakeoverLink({ baseUrl, conversationId, customerPhone }) {
  const base = String(baseUrl || process.env.DASHBOARD_URL || 'https://dash.topedgeai.com').replace(/\/$/, '');
  if (conversationId) {
    return `${base}/conversations/${conversationId}`;
  }
  const phone = encodeURIComponent(String(customerPhone || '').trim());
  return phone ? `${base}/conversations?phone=${phone}` : `${base}/conversations`;
}

function buildAdminAlertUrlSuffix({ conversationId, customerPhone }) {
  if (conversationId) {
    return String(conversationId).slice(0, 2000);
  }
  return indianPhoneDigits(customerPhone) || 'customer';
}

async function shouldSkipAdminAlertDedup(clientId, customerPhone, topic) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return false;
  const key = `admin_alert:${clientId}:${normalizePhone(customerPhone)}:${String(topic || 'alert').slice(0, 64)}`;
  try {
    const set = await redis.set(key, '1', 'EX', ADMIN_ALERT_DEDUP_SEC, 'NX');
    return set === null;
  } catch (_) {
    return false;
  }
}

async function loadRecentChatTranscript(clientId, customerPhone, conversationId, limit = 5) {
  try {
    const Conversation = require('../../models/Conversation');
    const Message = require('../../models/Message');
    let convoId = conversationId;
    if (!convoId && customerPhone) {
      const convo = await Conversation.findOne({
        clientId,
        phone: normalizePhone(customerPhone),
      })
        .select('_id')
        .lean();
      convoId = convo?._id;
    }
    if (!convoId) return { messages: [], conversationId: null };
    const rows = await Message.find({ conversationId: convoId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .select('direction content type timestamp from')
      .lean();
    return { messages: rows.reverse(), conversationId: convoId };
  } catch (_) {
    return { messages: [], conversationId: conversationId || null };
  }
}

async function loadRecentCustomerOrders(clientId, customerPhone, limit = 3) {
  try {
    const Order = require('../../models/Order');
    const suffix = indianPhoneSuffix(customerPhone);
    if (!suffix || suffix.length < 8) return [];

    const candidates = await Order.find({ clientId })
      .sort({ createdAt: -1 })
      .limit(80)
      .select('orderNumber orderId totalPrice financialStatus fulfillmentStatus status createdAt customerPhone phone customerName name')
      .lean();

    return candidates
      .filter((o) => {
        const p = o.customerPhone || o.phone || '';
        return indianPhoneSuffix(p) === suffix;
      })
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

async function resolveCustomerDisplayName({ clientId, customerPhone, conversationId, lead, customerQuery }) {
  const q = String(customerQuery || '').trim();
  if (q && !/^\+?\d[\d\s-]{8,}$/.test(q)) return q.slice(0, 256);

  if (lead?.name && String(lead.name).trim()) return String(lead.name).trim().slice(0, 256);

  try {
    const Contact = require('../../models/Contact');
    const phone = normalizePhone(customerPhone);
    if (phone) {
      const contact = await Contact.findOne({ clientId, phone }).select('name firstName').lean();
      const name = contact?.name || contact?.firstName;
      if (name) return String(name).trim().slice(0, 256);
    }
  } catch (_) { /* noop */ }

  try {
    const orders = await loadRecentCustomerOrders(clientId, customerPhone, 1);
    const n = orders[0]?.customerName || orders[0]?.name;
    if (n) return String(n).trim().slice(0, 256);
  } catch (_) { /* noop */ }

  return 'Customer';
}

/** Admin alerts are email-only (platform sender). Legacy whatsapp/both prefs map to email. */
function resolveAdminAlertChannel() {
  return 'email';
}

function parseRecipientList(csv, fallback = '') {
  const items = String(csv || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fb = String(fallback || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...items, ...fb])];
}

function resolveAdminEmailRecipients(client = {}) {
  return parseRecipientList(client.adminAlertEmail, client.adminEmail).slice(0, ADMIN_ALERT_MAX_RECIPIENTS);
}

async function hydrateClientForAdminAlert(client) {
  if (!client) return null;
  if (typeof client === 'string') {
    const Client = require('../../models/Client');
    return Client.findOne({ clientId: client })
      .select(
        'clientId adminEmail adminAlertEmail adminAlertPreferences platformVars brand businessName name config'
      )
      .lean();
  }
  const clientId = client.clientId;
  if (!clientId) return client;
  const hasEmail = client.adminEmail || client.adminAlertEmail;
  if (hasEmail) return client;
  const Client = require('../../models/Client');
  const doc = await Client.findOne({ clientId })
    .select(
      'clientId adminEmail adminAlertEmail adminAlertPreferences platformVars brand businessName name config'
    )
    .lean();
  return doc || client;
}

/**
 * NotificationService
 * Handles high-priority admin alerts triggered by flows or system events.
 */
const NotificationService = {
  /**
   * Dispatches an alert to the configured admin channels.
   *
   * @param {Object} client - The Client document
   * @param {Object} params - { customerPhone, conversationId, topic, triggerSource, channel?, adminPhoneOverride?, customerQuery?, lead?, skipDedup? }
   * @returns {Promise<Object>} - Per-channel dispatch results
   */
  async sendAdminAlert(client, {
    customerPhone,
    conversationId,
    topic,
    triggerSource,
    channel: channelParam,
    adminPhoneOverride,
    customerQuery = '',
    lead = null,
    skipDedup = false,
  }) {
    client = (await hydrateClientForAdminAlert(client)) || client;
    const channel = resolveAdminAlertChannel();
    const clientId = client?.clientId || String(client);

    if (!skipDedup && await shouldSkipAdminAlertDedup(clientId, customerPhone, topic)) {
      log.info(`[sendAdminAlert] Dedup skip for ${clientId} ${customerPhone}`);
      return { deduped: true, email: [] };
    }

    const adminEmails = resolveAdminEmailRecipients(client);

    const baseUrl = process.env.DASHBOARD_URL || 'https://dash.topedgeai.com';
    const transcriptBundle = await loadRecentChatTranscript(
      clientId,
      customerPhone,
      conversationId
    );
    const resolvedConvoId = conversationId || transcriptBundle.conversationId;
    const takeoverLink = buildTakeoverLink({
      baseUrl,
      conversationId: resolvedConvoId,
      customerPhone,
    });
    const recentMessages = transcriptBundle.messages;
    const recentOrders = await loadRecentCustomerOrders(clientId, customerPhone);
    const customerName = await resolveCustomerDisplayName({
      clientId,
      customerPhone,
      conversationId: resolvedConvoId,
      lead,
      customerQuery,
    });

    const chatSummary = recentMessages.length
      ? recentMessages
          .slice(-3)
          .map((m) => {
            const who = m.direction === 'inbound' || m.from === 'user' ? 'Customer' : 'Bot';
            return `${who}: ${String(m.content || '').slice(0, 80)}`;
          })
          .join(' · ')
          .slice(0, 220)
      : '';
    const issueSummary = String(
      chatSummary ||
        [customerQuery, topic, triggerSource].filter(Boolean).join(' — ') ||
        'Needs urgent support'
    ).slice(0, 256);

    const results = { email: [] };

    const brandName =
      client.businessName || client.name || client.brand?.businessName || client.clientId || 'Your brand';

    // Email — platform sender (SYSTEM_EMAIL / RESEND), not merchant Gmail
    if (adminEmails.length > 0) {
      if (!isSystemEmailReady()) {
        log.warn('Admin email alert skipped — platform system email not configured');
        results.email.push({
          email: adminEmails[0],
          status: 'skipped',
          error:
            'Platform email not configured — set SYSTEM_EMAIL_USER + SYSTEM_EMAIL_PASS or RESEND_API_KEY on the server.',
        });
        try {
          await NotificationService.createNotification(client, {
            type: 'system',
            title: 'Admin email alert could not send',
            message:
              'Human escalation requested email delivery but platform outbound email is not configured on the server.',
            customerPhone,
            metadata: { topic, triggerSource },
          });
        } catch (_) { /* non-blocking */ }
      } else {
        await Promise.all(adminEmails.map(async (email) => {
          try {
            log.info(`Sending Email Admin Alert to ${email}`);
            const html = buildAdminEscalationEmailHtml({
              brandName,
              topic: topic || 'Priority support',
              triggerSource: triggerSource || 'Automation flow',
              customerPhone: customerPhone || '—',
              customerName,
              customerQuery: issueSummary || customerQuery,
              takeoverLink,
              recentMessages,
              recentOrders,
            });
            const ok = await sendSystemEmail({
              to: email,
              subject: `🚨 ${brandName}: human help needed — ${customerPhone || 'customer'}`,
              html,
            });
            results.email.push({
              email,
              status: ok ? 'success' : 'failed',
              error: ok ? undefined : 'sendSystemEmail returned false',
            });
            if (!ok) {
              try {
                await NotificationService.createNotification(client, {
                  type: 'system',
                  title: 'Admin alert email failed',
                  message: `Could not deliver escalation email to ${email}. Check platform email configuration.`,
                  customerPhone,
                  metadata: { topic, triggerSource },
                });
              } catch (_) { /* non-blocking */ }
            }
          } catch (err) {
            log.error(`Email Admin Alert failed for ${email}`, { error: err.message });
            results.email.push({ email, status: 'failed', error: err.message });
          }
        }));
      }
    } else {
      log.warn('[sendAdminAlert] No adminAlertEmail / adminEmail on file');
      try {
        await NotificationService.createNotification(client, {
          type: 'system',
          title: 'Admin email alert not delivered',
          message:
            'A customer triggered an escalation, but no admin email is configured. Add alert emails under Settings → Workspace → Alert contacts.',
          customerPhone,
          metadata: { topic, triggerSource },
        });
      } catch (_) { /* non-blocking */ }
    }

    log.info(`Dispatching email alert for ${clientId}`, {
      emailCount: adminEmails.length,
    });

    return results;
  },

  /**
   * Centralized Notification Creation
   * Persists a notification to the DB and emits it to the frontend via Socket.io.
   */
  async createNotification(client, { type, title, message, customerPhone, metadata = {} }) {
    try {
      const Notification = require('../../models/Notification');
      
      const clientId = typeof client === 'string' ? client : (client.clientId || client._id);
      
      const notif = await Notification.create({
        clientId: clientId.toString(),
        type: type || 'system',
        title: title || 'New Alert',
        message: message || '',
        metadata: {
          customerPhone,
          ...metadata
        }
      });

      if (global.io) {
        global.io.to(`client_${clientId}`).emit('new_notification', notif);
      }

      return notif;
    } catch (err) {
      log.error('Failed to create internal notification', { error: err.message });
      return null;
    }
  }
};

module.exports = NotificationService;
module.exports.buildTakeoverLink = buildTakeoverLink;
module.exports.resolveAdminEmailRecipients = resolveAdminEmailRecipients;
