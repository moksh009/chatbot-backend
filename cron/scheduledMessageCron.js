const cron = require('node-cron');
const ScheduledMessage = require('../models/ScheduledMessage');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppInteractive } = require('../utils/meta/whatsappHelpers');
const { sendInstagramDM } = require('../utils/meta/instagramApi');
const { decrypt } = require('../utils/core/encryption');
const {
  cronEnvelopeSend,
  handleCronEnvelopeOutcome,
  idempotencyScheduled,
} = require('../utils/messaging/cronEnvelopeSend');
const log = require('../utils/core/logger')('ScheduledMessageCron');

function resolveScheduledIntent(msg) {
  if (msg.intent) return msg.intent;
  const src = String(msg.sourceType || '');
  if (src.startsWith('csat')) return 'utility';
  if (src === 'cart_recovery') return 'marketing';
  return 'service';
}

function buildWhatsAppPayload(msg) {
  if (msg.messageType === 'template') {
    return {
      templateName: msg.content.templateName,
      templateLanguage: msg.content.languageCode || 'en',
      components: msg.content.components || [],
    };
  }
  if (msg.messageType === 'interactive') {
    return {
      interactive: msg.content,
      text: msg.content?.body?.text || '',
    };
  }
  return { text: msg.content?.text || String(msg.content || '') };
}

async function dispatchScheduledWhatsApp(msg, client, lead) {
  const intent = resolveScheduledIntent(msg);
  const payload = buildWhatsAppPayload(msg);
  const contactId = lead?._id ? String(lead._id) : null;

  const envelopeOut = await cronEnvelopeSend({
    client,
    clientId: client.clientId,
    channel: 'whatsapp',
    intent,
    phone: msg.phone,
    contactId,
    idempotencyKey: idempotencyScheduled({ scheduledMessageId: String(msg._id) }),
    payload,
    context: {
      source: 'cron/scheduledMessageCron',
      scheduledMessageId: String(msg._id),
      sourceType: msg.sourceType,
    },
  });

  if (!envelopeOut.useLegacy) {
    let sent = false;
    const outcome = handleCronEnvelopeOutcome(envelopeOut, {
      onSent: () => {
        sent = true;
      },
      onDuplicate: () => {
        sent = true;
      },
      onSkipped: (out) => {
        log.info(`[ScheduledMessageCron] skipped ${msg._id}: ${out.reason}`);
      },
      onFailed: (out) => {
        log.warn(`[ScheduledMessageCron] blocked ${msg._id}: ${out.reason}`);
      },
    });
    if (outcome === 'rate_limit') {
      return { sent: false, retry: true };
    }
    return { sent, skipped: outcome === 'skipped' };
  }

  const token = client.whatsappToken;
  const phoneId = client.phoneNumberId;

  if (msg.messageType === 'template') {
    const res = await sendWhatsAppTemplate({
      phoneNumberId: phoneId,
      to: msg.phone,
      templateName: msg.content.templateName,
      languageCode: msg.content.languageCode || 'en_US',
      components: msg.content.components || [],
      token,
      clientId: client.clientId,
    });
    return { sent: res.success };
  }
  if (msg.messageType === 'interactive') {
    const res = await sendWhatsAppInteractive({
      phoneNumberId: phoneId,
      to: msg.phone,
      content: msg.content,
      token,
      clientId: client.clientId,
    });
    return { sent: res.success };
  }
  const res = await sendWhatsAppText({
    phoneNumberId: phoneId,
    to: msg.phone,
    body: msg.content.text || msg.content,
    token,
    clientId: client.clientId,
  });
  return { sent: res.success };
}

async function runScheduledMessageTick() {
  const now = new Date();
  log.debug(`Checking pending scheduled messages at ${now.toISOString()}`);

  try {
    const pendingMessages = await ScheduledMessage.find({
      status: 'pending',
      sendAt: { $lte: now },
    })
      .limit(500)
      .lean();

    if (pendingMessages.length === 0) return;

    log.info(`Found ${pendingMessages.length} scheduled messages to process`);

    const clientIds = [...new Set(pendingMessages.map((m) => m.clientId).filter(Boolean))];
    const clientDocs = await Client.find({ clientId: { $in: clientIds } }).lean();
    const clientMap = new Map(clientDocs.map((c) => [c.clientId, c]));

    for (const msg of pendingMessages) {
      const client = clientMap.get(msg.clientId);
      if (!client) {
        await ScheduledMessage.findByIdAndUpdate(msg._id, {
          status: 'failed',
          content: { ...msg.content, error: 'Client not found' },
        });
        continue;
      }

      const lead =
        msg.channel === 'email'
          ? await AdLead.findOne({
              clientId: client.clientId,
              email: String(msg.content?.toEmail || msg.phone || '')
                .trim()
                .toLowerCase(),
            })
              .select('_id email lastInteraction linkClicks')
              .lean()
          : await AdLead.findOne({
              phoneNumber: msg.phone,
              clientId: client.clientId,
            })
              .select('_id lastInteraction linkClicks')
              .lean();

      if (msg.cancelIf && lead) {
        let shouldCancel = false;
        if (msg.cancelIf.userReplied && lead.lastInteraction > msg.createdAt) {
          shouldCancel = true;
        }
        if (msg.cancelIf.linkClicked && lead.linkClicks > 0) {
          shouldCancel = true;
        }
        for (const [key, value] of Object.entries(msg.cancelIf)) {
          if (key !== 'userReplied' && key !== 'linkClicked' && lead[key] === value) {
            shouldCancel = true;
            break;
          }
        }
        if (shouldCancel) {
          log.info(`Cancelling scheduled message ${msg._id} (cancelIf)`);
          await ScheduledMessage.findByIdAndUpdate(msg._id, { status: 'cancelled' });
          continue;
        }
      }

      let sentSuccess = false;
      let markFailed = false;

      try {
        if (msg.channel === 'whatsapp') {
          const result = await dispatchScheduledWhatsApp(msg, client, lead);
          sentSuccess = result.sent;
          if (result.retry) continue;
          if (result.skipped) {
            await ScheduledMessage.findByIdAndUpdate(msg._id, {
              status: 'cancelled',
              content: { ...msg.content, skipReason: 'envelope_blocked' },
            });
            continue;
          }
        } else if (msg.channel === 'instagram') {
          const rawToken = client.instagramAccessToken;
          if (rawToken) {
            const token = decrypt(rawToken);
            await sendInstagramDM(msg.phone, { text: msg.content.text || msg.content }, token);
            sentSuccess = true;
          }
        } else if (msg.channel === 'email') {
          const emailService = require('../utils/core/emailService');
          const { subject, body, toEmail, format, source: contentSource } = msg.content || {};
          const recipient = toEmail || lead?.email || msg.phone;
          if (recipient) {
            const isHubSend = contentSource === 'routes/email-hub:send';
            if (isHubSend) {
              const MessageEnvelope = require('../models/MessageEnvelope');
              const { dispatchTrackedEmail } = require('../utils/core/dispatchTrackedEmail');
              const leadRecord = lead?.email
                ? lead
                : await AdLead.findOne({ clientId: client.clientId, email: recipient }).lean();
              const existingEnvelope = await MessageEnvelope.findOne({
                clientId: client.clientId,
                channel: 'email',
                status: 'queued',
                'context.scheduledMessageId': String(msg._id),
              })
                .select('_id idempotencyKey')
                .lean();
              const out = await dispatchTrackedEmail({
                client,
                clientId: client.clientId,
                to: recipient,
                subject,
                html: format === 'plain' ? undefined : body,
                text: body,
                format: format || 'html',
                intent: resolveScheduledIntent(msg),
                contactId: leadRecord?._id || lead?._id || null,
                context: {
                  source: 'cron/scheduledMessageCron',
                  scheduledMessageId: String(msg._id),
                },
                idempotencyKey:
                  existingEnvelope?.idempotencyKey ||
                  idempotencyScheduled({ scheduledMessageId: String(msg._id) }),
                existingEnvelopeId: existingEnvelope?._id || null,
                templateName: subject,
              });
              sentSuccess = out.success;
            } else {
              const emailOut = await cronEnvelopeSend({
                client,
                clientId: client.clientId,
                channel: 'email',
                intent: resolveScheduledIntent(msg),
                email: recipient,
                contactId: lead?._id,
                idempotencyKey: idempotencyScheduled({ scheduledMessageId: String(msg._id) }),
                payload: {
                  subject,
                  html: `<div>${String(body || '').replace(/\n/g, '<br/>')}</div>`,
                },
                context: { source: 'cron/scheduledMessageCron', scheduledMessageId: String(msg._id) },
              });
              if (!emailOut.useLegacy) {
                sentSuccess = emailOut.action === 'sent' || emailOut.action === 'duplicate';
              }
              if (!sentSuccess) {
                const out = await emailService.sendWorkspaceEmailDirect(client, {
                  to: recipient,
                  subject,
                  html: `<div>${String(body || '').replace(/\n/g, '<br/>')}</div>`,
                  format: 'html',
                });
                sentSuccess = out.success;
              }
            }
          }
        }
      } catch (sendErr) {
        log.error(`Error sending scheduled message to ${msg.phone}: ${sendErr.message}`);
        markFailed = true;
      }

      await ScheduledMessage.findByIdAndUpdate(msg._id, {
        status: sentSuccess ? 'sent' : 'failed',
      });
    }
  } catch (err) {
    log.error(`Scheduled message cron error: ${err.message}`);
  }
}

const scheduleScheduledMessageCron = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/2 * * * *', runScheduledMessageTick);
};

scheduleScheduledMessageCron.runTick = runScheduledMessageTick;
module.exports = scheduleScheduledMessageCron;
