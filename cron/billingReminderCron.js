"use strict";

const cron = require('node-cron');
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const User = require('../models/User');
const LifecycleAutomationLog = require('../models/LifecycleAutomationLog');
const { renderBrandedEmail } = require('../services/mjmlEmailRenderer');
const { sendSystemEmail } = require('../utils/core/emailService');
const { formatInr } = require('../config/planCatalog');
const { sendPlatformWhatsAppTemplate } = require('../services/lifecycle/platformWelcomeWhatsApp');
const log = require('../utils/core/logger')('BillingReminderCron');

function shouldRun() {
  return String(process.env.SEND_BILLING_REMINDER_7D || 'true').toLowerCase() !== 'false';
}

async function writeLog(entry) {
  await LifecycleAutomationLog.create(entry).catch(() => {});
}

async function runTick() {
  if (!shouldRun()) return;

  const now = Date.now();
  const start = new Date(now + 7 * 24 * 60 * 60 * 1000);
  const end = new Date(now + 8 * 24 * 60 * 60 * 1000);

  const subs = await Subscription.find({
    status: 'active',
    billingCycle: 'monthly',
    currentPeriodEnd: { $gte: start, $lt: end },
  }).lean();

  for (const sub of subs) {
    const client = await Client.findOne({ clientId: sub.clientId }).lean();
    if (!client || client.isLifetimeAdmin === true) continue;

    const locked = await Subscription.updateOne(
      {
        _id: sub._id,
        $or: [
          { preBillReminderSentForPeriodEnd: { $exists: false } },
          { preBillReminderSentForPeriodEnd: { $ne: sub.currentPeriodEnd } },
        ],
      },
      { $set: { preBillReminderSentForPeriodEnd: sub.currentPeriodEnd } }
    );
    if (!locked.modifiedCount) continue;

    const adminUser = await User.findOne({ clientId: sub.clientId, role: 'CLIENT_ADMIN' })
      .select('email phone name')
      .lean();
    const emailTo = adminUser?.email || client.email || '';
    const amount = sub.amount ? Math.round(Number(sub.amount) / 100) : 0;
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'your upcoming renewal date';
    const billingUrl = `${String(process.env.TOPEDGE_DASHBOARD_URL || 'https://dash.topedgeai.com').replace(/\/$/, '')}/billing`;
    const sentForKeyBase = `billing-reminder:${sub.clientId}:${new Date(sub.currentPeriodEnd).toISOString()}`;

    if (emailTo) {
      const html = renderBrandedEmail({
        brandName: 'TopEdge AI',
        title: 'Billing reminder: renewal in 7 days',
        bodyHtml: [
          `Hi ${(adminUser?.name || client.name || 'there').trim()},`,
          `Your ${sub.plan || 'TopEdge'} plan renews on ${periodEnd}.`,
          `Upcoming amount: ${amount ? formatInr(amount) : 'as per your current subscription'}.`,
        ].join('\n\n'),
        ctaUrl: billingUrl,
        ctaLabel: 'Open billing',
      });
      const ok = await sendSystemEmail({
        to: emailTo,
        subject: 'TopEdge billing reminder — renewal in 7 days',
        html,
      });
      await writeLog({
        clientId: sub.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'billing_reminder',
        channel: 'email',
        status: ok ? 'sent' : 'failed',
        reason: ok ? '' : 'send_failed',
        sentForKey: `${sentForKeyBase}:email`,
      });
    } else {
      await writeLog({
        clientId: sub.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'billing_reminder',
        channel: 'email',
        status: 'skipped',
        reason: 'no_email',
        sentForKey: `${sentForKeyBase}:email`,
      });
    }

    if (adminUser?.phone) {
      const wa = await sendPlatformWhatsAppTemplate({
        toPhone: adminUser.phone,
        templateName: String(process.env.TOPEDGE_BILLING_REMINDER_TEMPLATE_NAME || '').trim() || 'topedge_billing_reminder_7d_v1',
        languageCode: 'en',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: adminUser?.name || client.name || 'there' },
              { type: 'text', text: periodEnd },
              { type: 'text', text: amount ? formatInr(amount) : 'your plan amount' },
            ],
          },
        ],
      });
      await writeLog({
        clientId: sub.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'billing_reminder',
        channel: 'whatsapp',
        status: wa.sent ? 'sent' : wa.skipped ? 'skipped' : 'failed',
        reason: wa.reason || '',
        sentForKey: `${sentForKeyBase}:whatsapp`,
      });
    } else {
      await writeLog({
        clientId: sub.clientId,
        clientName: client.name || client.businessName || '',
        automationType: 'billing_reminder',
        channel: 'whatsapp',
        status: 'skipped',
        reason: 'no_phone',
        sentForKey: `${sentForKeyBase}:whatsapp`,
      });
    }
  }
}

function scheduleBillingReminderCron() {
  cron.schedule('30 10 * * *', () => runTick().catch((e) => log.warn(`runTick failed: ${e.message}`)), {
    timezone: 'Asia/Kolkata',
  });
  log.info('Scheduled daily billing reminder cron (10:30 IST)');
}

module.exports = scheduleBillingReminderCron;
module.exports.runTick = runTick;
