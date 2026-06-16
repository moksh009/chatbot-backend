"use strict";

const cron = require('node-cron');
const Client = require('../models/Client');
const User = require('../models/User');
const LifecycleAutomationLog = require('../models/LifecycleAutomationLog');
const { renderBrandedEmail } = require('../services/mjmlEmailRenderer');
const { sendSystemEmail } = require('../utils/core/emailService');
const { sendPlatformWhatsAppTemplate } = require('../services/lifecycle/platformWelcomeWhatsApp');
const { buildPlatformReviewToken } = require('../utils/core/platformReviewToken');
const log = require('../utils/core/logger')('PlatformReviewCron');

function shouldRun() {
  return String(process.env.SEND_POST_PURCHASE_REVIEW_14D || 'true').toLowerCase() !== 'false';
}

function surveyBaseUrl() {
  return String(process.env.POST_PURCHASE_SURVEY_BASE_URL || 'https://dash.topedgeai.com').replace(/\/$/, '');
}

async function runTick() {
  if (!shouldRun()) return;
  const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const clients = await Client.find({
    becamePayingAt: { $lte: threshold },
    $or: [{ platformReviewSentAt: null }, { platformReviewSentAt: { $exists: false } }],
    isLifetimeAdmin: { $ne: true },
  })
    .select('clientId name businessName becamePayingAt')
    .lean();

  for (const client of clients) {
    const token = buildPlatformReviewToken({ clientId: client.clientId });
    const link = `${surveyBaseUrl()}/survey/${token}`;
    const adminUser = await User.findOne({ clientId: client.clientId, role: 'CLIENT_ADMIN' })
      .select('name email phone')
      .lean();

    const lock = await Client.updateOne(
      { clientId: client.clientId, $or: [{ platformReviewSentAt: null }, { platformReviewSentAt: { $exists: false } }] },
      { $set: { platformReviewSentAt: new Date() } }
    );
    if (!lock.modifiedCount) continue;

    const sentForKey = `review-14d:${client.clientId}:${new Date().toISOString().slice(0, 10)}`;

    if (adminUser?.email) {
      const html = renderBrandedEmail({
        brandName: 'TopEdge AI',
        title: 'How has your first 14 days been?',
        bodyHtml: `Hi ${(adminUser.name || client.name || client.businessName || 'there').trim()}, please rate your TopEdge experience so far and share any concerns.`,
        ctaUrl: link,
        ctaLabel: 'Rate now',
      });
      const ok = await sendSystemEmail({
        to: adminUser.email,
        subject: 'Quick 14-day TopEdge feedback',
        html,
      });
      await LifecycleAutomationLog.create({
        clientId: client.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'review_14d',
        channel: 'email',
        status: ok ? 'sent' : 'failed',
        reason: ok ? '' : 'send_failed',
        sentForKey,
      }).catch(() => {});
    } else {
      await LifecycleAutomationLog.create({
        clientId: client.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'review_14d',
        channel: 'email',
        status: 'skipped',
        reason: 'no_email',
        sentForKey,
      }).catch(() => {});
    }

    if (adminUser?.phone) {
      const wa = await sendPlatformWhatsAppTemplate({
        toPhone: adminUser.phone,
        templateName: String(process.env.TOPEDGE_POST_PURCHASE_REVIEW_TEMPLATE_NAME || '').trim() || 'topedge_review_14d_v1',
        languageCode: 'en',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: adminUser.name || client.name || client.businessName || 'there' },
              { type: 'text', text: link },
            ],
          },
        ],
      });
      await LifecycleAutomationLog.create({
        clientId: client.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'review_14d',
        channel: 'whatsapp',
        status: wa.sent ? 'sent' : wa.skipped ? 'skipped' : 'failed',
        reason: wa.reason || '',
        sentForKey,
      }).catch(() => {});
    } else {
      await LifecycleAutomationLog.create({
        clientId: client.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'review_14d',
        channel: 'whatsapp',
        status: 'skipped',
        reason: 'no_phone',
        sentForKey,
      }).catch(() => {});
    }
  }
}

function schedulePlatformReviewCron() {
  cron.schedule('45 10 * * *', () => runTick().catch((e) => log.warn(`runTick failed: ${e.message}`)), {
    timezone: 'Asia/Kolkata',
  });
  log.info('Scheduled daily 14-day platform review cron (10:45 IST)');
}

module.exports = schedulePlatformReviewCron;
module.exports.runTick = runTick;
