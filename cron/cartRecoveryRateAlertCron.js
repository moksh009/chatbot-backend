'use strict';

const cron = require('node-cron');
const Client = require('../models/Client');
const Notification = require('../models/Notification');
const { emitAdminNotification } = require('../utils/admin/emitAdminNotification');
const { sendEmail } = require('../utils/core/emailService');
const { calculateRecoveryMetrics } = require('../services/cartRecoveryMetricsService');
const log = require('../utils/core/logger')('CartRecoveryAlert');

const RECOVERY_RATE_THRESHOLD = 5;
const LOOKBACK_DAYS = 7;
const MIN_COHORT_VOLUME = 10;

async function computeSevenDayRecoveryRate(clientId) {
  const to = new Date();
  const from = new Date(to.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000);
  from.setHours(0, 0, 0, 0);

  const metrics = await calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from,
    to,
    includeFunnel: true,
    includeRows: false,
  });

  const totalAbandoned = metrics.totalAbandoned;
  const recovered = metrics.recoveredCarts;
  const step1Sent = metrics.funnel?.msg1Sent || 0;

  if (totalAbandoned < MIN_COHORT_VOLUME) {
    return { rate: null, step1Sent, recovered, totalAbandoned, skip: 'insufficient_volume' };
  }

  return {
    rate: metrics.recoveryRate,
    step1Sent,
    recovered,
    totalAbandoned,
    messageEfficiencyRate: metrics.funnel?.messageEfficiencyRate ?? 0,
    skip: null,
  };
}

async function alertLowRecoveryRate(client) {
  const stats = await computeSevenDayRecoveryRate(client.clientId);
  if (stats.skip || stats.rate == null || stats.rate >= RECOVERY_RATE_THRESHOLD) return;

  const title = 'Cart recovery rate dropped';
  const message = `${client.businessName || client.clientId}: recovery rate is ${stats.rate}% (${stats.recovered}/${stats.totalAbandoned} abandoned carts recovered over ${LOOKBACK_DAYS}d). Review templates and timing in Order messages.`;

  const recent = await Notification.findOne({
    clientId: client.clientId,
    title,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  }).lean();
  if (recent) return;

  const doc = await Notification.create({
    clientId: client.clientId,
    audience: 'merchant',
    title,
    message,
    type: 'cart_recovery_alert',
    metadata: { rate: stats.rate, ...stats },
  });
  emitAdminNotification(doc);

  const to = (client.adminAlertEmail || client.adminEmail || '').split(',')[0]?.trim();
  if (to) {
    await sendEmail(client, {
      to,
      subject: `[TopEdge] ${title}`,
      html: `<p>${message}</p><p>Dashboard: <a href="${process.env.DASHBOARD_URL || 'https://dash.topedgeai.com'}/cart-leads">Cart leads</a></p>`,
      intent: 'utility',
    }).catch((e) => log.warn(`Recovery alert email failed: ${e.message}`));
  }

  log.info(`[CartRecoveryAlert] Sent for ${client.clientId} — ${stats.rate}%`);
}

async function runCartRecoveryRateAlerts() {
  const clients = await Client.find({
    commerceAutomations: { $elemMatch: { 'meta.category': 'abandoned_cart', isActive: true } },
  })
    .select('clientId businessName adminEmail adminAlertEmail')
    .lean();

  for (const client of clients) {
    await alertLowRecoveryRate(client).catch((e) =>
      log.warn(`Alert scan failed for ${client.clientId}: ${e.message}`)
    );
  }
}

function registerCartRecoveryRateAlertCron() {
  cron.schedule(
    '30 7 * * *',
    () => {
      runCartRecoveryRateAlerts().catch((e) => log.error(`Recovery rate alert cron: ${e.message}`));
    },
    { timezone: 'Asia/Kolkata' }
  );
}

module.exports = { registerCartRecoveryRateAlertCron, runCartRecoveryRateAlerts, computeSevenDayRecoveryRate };
