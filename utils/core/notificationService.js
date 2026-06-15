"use strict";

const WhatsApp = require('../meta/whatsapp');
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

async function logAdminAlertWhatsAppSend(clientId, {
  templateName,
  recipientPhone,
  success,
  errorMessage,
  topic,
  triggerSource,
  skippedReason,
}) {
  try {
    const TemplateSendLog = require('../../models/TemplateSendLog');
    await TemplateSendLog.create({
      clientId,
      templateName: templateName || 'admin_human_alert',
      automationSlotId: 'admin_alert',
      contextType: 'admin_alert',
      failureCode: success ? 'sent' : (skippedReason || 'send_error'),
      channel: 'whatsapp',
      recipientPhone: String(recipientPhone || ''),
      contextData: { topic, triggerSource, skippedReason },
      status: success ? 'sent' : 'failed',
      errorMessage: errorMessage || null,
    });
  } catch (_) {
    /* non-blocking */
  }
}

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

function resolveAdminAlertChannel(client, explicitChannel) {
  if (explicitChannel === 'whatsapp' || explicitChannel === 'email' || explicitChannel === 'both') {
    return explicitChannel;
  }
  const pref = client.adminAlertPreferences;
  if (pref === 'whatsapp' || pref === 'email' || pref === 'both') return pref;
  return 'both';
}

const ADMIN_ALERT_TEMPLATE_CANDIDATES = ['admin_human_alert', 'admin_handoff', 'admin_notification_v1'];

function isAdminAlertTemplateApproved(client = {}, templateName) {
  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const hit = synced.find(
    (t) => String(t?.name || '') === templateName && String(t?.status || '').toUpperCase() === 'APPROVED'
  );
  return !!hit;
}

function resolveAdminAlertTemplateName(client = {}) {
  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  for (const name of ADMIN_ALERT_TEMPLATE_CANDIDATES) {
    const hit = synced.find(
      (t) => String(t?.name || '') === name && String(t?.status || '').toUpperCase() === 'APPROVED'
    );
    if (hit) return name;
  }
  return null;
}

function templateHasUrlButton(client = {}, templateName) {
  if (templateName === 'admin_notification_v1') return true;
  const synced = (client.syncedMetaTemplates || []).find((t) => String(t?.name || '') === templateName);
  if (!synced) return templateName === 'admin_human_alert';
  const components = Array.isArray(synced.components) ? synced.components : [];
  return components.some(
    (c) =>
      String(c?.type || '').toUpperCase() === 'BUTTONS' &&
      (c.buttons || []).some((b) => String(b?.type || '').toUpperCase() === 'URL')
  );
}

function buildAdminAlertWhatsAppComponents(
  templateName,
  client,
  { customerPhone, topic, triggerSource, customerQuery, customerName, conversationId, issueSummary }
) {
  const phoneText = String(customerPhone || '—').slice(0, 256);
  const issueContext = String(
    issueSummary ||
      [topic, triggerSource, customerQuery].filter(Boolean).join(' — ') ||
      'Needs urgent support'
  ).slice(0, 256);

  if (templateName === 'admin_notification_v1') {
    return [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: String(topic || 'New Request').slice(0, 256) },
          { type: 'text', text: String(triggerSource || 'Manual Trigger').slice(0, 256) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: buildAdminAlertUrlSuffix({ conversationId, customerPhone }) }],
      },
    ];
  }

  const customerLabel = String(customerName || customerQuery || topic || 'Customer').slice(0, 256);
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: customerLabel },
        { type: 'text', text: phoneText },
        { type: 'text', text: issueContext },
      ],
    },
  ];

  if (templateHasUrlButton(client, templateName)) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: buildAdminAlertUrlSuffix({ conversationId, customerPhone }) }],
    });
  }

  return components;
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

function resolveAdminWhatsappRecipients(client = {}, adminPhoneOverride = '') {
  let adminWhatsapps = parseRecipientList(client.adminAlertWhatsapp);
  if (client.config?.adminPhones && Array.isArray(client.config.adminPhones)) {
    adminWhatsapps = [...new Set([...adminWhatsapps, ...client.config.adminPhones.map(String)])];
  }
  const primary = String(
    adminPhoneOverride ||
      client.adminPhone ||
      client.brand?.adminPhone ||
      client.platformVars?.adminWhatsappNumber ||
      ''
  ).trim();
  if (primary) {
    adminWhatsapps = [...new Set([primary, ...adminWhatsapps])];
  }
  return [...new Set(adminWhatsapps)].slice(0, ADMIN_ALERT_MAX_RECIPIENTS);
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
        'clientId adminPhone adminAlertWhatsapp adminEmail adminAlertEmail adminAlertPreferences platformVars brand businessName name config syncedMetaTemplates'
      )
      .lean();
  }
  const clientId = client.clientId;
  if (!clientId) return client;
  const hasPhone =
    client.adminPhone ||
    client.adminAlertWhatsapp ||
    client.platformVars?.adminWhatsappNumber ||
    client.brand?.adminPhone;
  const hasEmail = client.adminEmail || client.adminAlertEmail;
  if (hasPhone || hasEmail) return client;
  const Client = require('../../models/Client');
  const doc = await Client.findOne({ clientId })
    .select(
      'clientId adminPhone adminAlertWhatsapp adminEmail adminAlertEmail adminAlertPreferences platformVars brand businessName name config syncedMetaTemplates'
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
    const channel = resolveAdminAlertChannel(client, channelParam);
    const clientId = client?.clientId || String(client);

    if (!skipDedup && await shouldSkipAdminAlertDedup(clientId, customerPhone, topic)) {
      log.info(`[sendAdminAlert] Dedup skip for ${clientId} ${customerPhone}`);
      return { deduped: true, whatsapp: [], email: [] };
    }

    const adminEmails = resolveAdminEmailRecipients(client);
    const adminWhatsapps = resolveAdminWhatsappRecipients(client, adminPhoneOverride);

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

    const results = { whatsapp: [], email: [] };
    const approvedTemplate = resolveAdminAlertTemplateName(client);

    // 1. WhatsApp — approved Meta template only (no free-form text to admins)
    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length === 0) {
      log.warn('[sendAdminAlert] WhatsApp channel selected but no admin numbers on file');
      try {
        await NotificationService.createNotification(client, {
          type: 'system',
          title: 'Admin WhatsApp alert not delivered',
          message:
            'A customer triggered a human escalation, but no admin WhatsApp number is configured. Add Admin Phone or Admin WhatsApp Alert(s) under Settings → Workspace → Alert contacts.',
          customerPhone,
          metadata: { topic, triggerSource },
        });
      } catch (_) { /* non-blocking */ }
    }

    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length > 0 && !approvedTemplate) {
      log.warn('[sendAdminAlert] WhatsApp skipped — admin_human_alert not approved on Meta');
      results.whatsapp.push({ status: 'skipped', error: 'admin_human_alert template not approved' });
      try {
        await NotificationService.createNotification(client, {
          type: 'system',
          title: 'Approve admin alert template',
          message:
            'A shopper needs human help. Your admin numbers are saved, but WhatsApp alerts need the admin_human_alert template approved in Meta Manager — then sync templates.',
          customerPhone,
          metadata: { topic, triggerSource, takeoverLink },
        });
      } catch (_) { /* non-blocking */ }
    }

    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length > 0 && approvedTemplate) {
      const customerNorm = normalizePhone(customerPhone);
      await Promise.all(adminWhatsapps.map(async (number) => {
        const adminNorm = normalizePhone(number);
        if (customerNorm && adminNorm && adminNorm === customerNorm) {
          log.warn(
            `[sendAdminAlert] Skipping WhatsApp to ${number} — same number as customer`
          );
          results.whatsapp.push({ number, status: 'skipped', error: 'same_as_customer' });
          return;
        }
        try {
          log.info(`Sending WhatsApp Admin Alert to ${number} via ${approvedTemplate}`);
          const components = buildAdminAlertWhatsAppComponents(approvedTemplate, client, {
            customerPhone,
            topic,
            triggerSource,
            customerQuery,
            customerName,
            conversationId: resolvedConvoId,
            issueSummary,
          });
          const res = await WhatsApp.sendTemplate(
            client,
            number,
            approvedTemplate,
            'en',
            components
          );
          results.whatsapp.push({ number, status: 'success', res, templateName: approvedTemplate });
          await logAdminAlertWhatsAppSend(clientId, {
            templateName: approvedTemplate,
            recipientPhone: number,
            success: true,
            topic,
            triggerSource,
          });
        } catch (err) {
          log.error(`WhatsApp Admin Alert failed for ${number}`, { error: err.message });
          results.whatsapp.push({ number, status: 'failed', error: err.message, templateName: approvedTemplate });
          await logAdminAlertWhatsAppSend(clientId, {
            templateName: approvedTemplate,
            recipientPhone: number,
            success: false,
            errorMessage: err.message,
            topic,
            triggerSource,
          });
          try {
            await NotificationService.createNotification(client, {
              type: 'system',
              title: 'Admin WhatsApp alert failed',
              message: `Could not deliver admin_human_alert to ${number}. Confirm the template is approved and matches the latest blueprint in Meta Manager.`,
              customerPhone,
              metadata: { topic, triggerSource, error: err.message },
            });
          } catch (_) { /* non-blocking */ }
        }
      }));
    }

    const brandName =
      client.businessName || client.name || client.brand?.businessName || client.clientId || 'Your brand';

    // 2. Email — platform owner mail (SYSTEM_EMAIL / RESEND), not merchant Gmail
    if ((channel === 'email' || channel === 'both') && adminEmails.length > 0) {
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
    } else if (channel === 'email' || channel === 'both') {
      log.warn('[sendAdminAlert] Email channel selected but no adminAlertEmail / adminEmail on file');
    }

    log.info(`Dispatching alert for ${clientId}`, {
      channels: channel,
      emailCount: adminEmails.length,
      whatsappCount: adminWhatsapps.length,
      template: approvedTemplate || 'none',
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
module.exports.resolveAdminAlertTemplateName = resolveAdminAlertTemplateName;
module.exports.isAdminAlertTemplateApproved = isAdminAlertTemplateApproved;
module.exports.buildAdminAlertWhatsAppComponents = buildAdminAlertWhatsAppComponents;
module.exports.buildTakeoverLink = buildTakeoverLink;
module.exports.templateHasUrlButton = templateHasUrlButton;
module.exports.resolveAdminWhatsappRecipients = resolveAdminWhatsappRecipients;
module.exports.resolveAdminEmailRecipients = resolveAdminEmailRecipients;
