'use strict';

const cron = require('node-cron');
const Client = require('../models/Client');
const { buildWinningProductsWorkspace } = require('../utils/commerce/winningProducts/winningProductsAggregator');
const { CLASSIFICATIONS } = require('../utils/commerce/winningProducts/storyClassifier');
const { WINNING_PRODUCTS_DIGEST_SLOTS } = require('../constants/winningProductsDigestTemplates');
const log = require('../utils/core/logger')('WinningProductsDigest');

const DIGEST_TEMPLATE_SLOTS = Object.fromEntries(
  WINNING_PRODUCTS_DIGEST_SLOTS.map((row) => {
    const key = row.slot.includes('daily')
      ? 'daily'
      : row.slot.includes('weekly')
        ? 'weekly'
        : row.slot.includes('rising')
          ? 'rising'
          : 'audienceReady';
    return [key, row.slot];
  })
);

function whatsappChannelEnabled(prefs) {
  return prefs?.channels?.whatsapp !== false;
}

async function sendDigestTemplate(clientId, slotName, contextData) {
  try {
    const client = await Client.findOne({ clientId }).select('insightsNotifications phoneNumber adminPhone').lean();
    if (!whatsappChannelEnabled(client?.insightsNotifications)) {
      return { skipped: true, reason: 'whatsapp_channel_disabled' };
    }
    const { sendByName } = require('../services/templateSender');
    const phone = client?.adminPhone || client?.phoneNumber;
    if (!phone) return { skipped: true, reason: 'no_phone' };
    await sendByName({
      clientId,
      templateName: slotName,
      phone,
      contextData,
      channel: 'whatsapp',
    });
    return { sent: true };
  } catch (err) {
    log.warn(`Digest send failed for ${clientId}: ${err.message}`);
    return { error: err.message };
  }
}

function formatDailyBody(workspace) {
  const winners = (workspace.products || [])
    .filter((p) => p.classification === CLASSIFICATIONS.WINNING)
    .slice(0, 3);
  const rising = (workspace.products || []).find((p) => p.classification === CLASSIFICATIONS.RISING);
  const stalled = (workspace.products || []).find((p) => p.classification === CLASSIFICATIONS.STALLED);
  return { winners, rising, stalled };
}

async function runDailyDigestForClient(client) {
  const prefs = client.insightsNotifications || {};
  if (!prefs.daily) return;

  const workspace = await buildWinningProductsWorkspace(client.clientId, 1);
  if (!workspace.pixelHealth?.daysOfData) return;

  const { winners, rising, stalled } = formatDailyBody(workspace);
  if (!winners.length && !rising && !stalled) return;

  const lines = winners.map(
    (w, i) => `${['🥇', '🥈', '🥉'][i] || '•'} ${w.title} — ${w.stats?.views || 0} views, ${w.stats?.purchases || 0} sales`
  );
  if (rising) lines.push(`Rising: ${rising.title}`);
  if (stalled) lines.push(`Needs attention: ${stalled.title}`);

  await sendDigestTemplate(client.clientId, DIGEST_TEMPLATE_SLOTS.daily, {
    lines: lines.join('\n'),
    link: 'https://dash.topedgeai.com/commerce-hub?tab=product_insights&section=overview',
  });
}

async function runWeeklyDigestForClient(client) {
  const prefs = client.insightsNotifications || {};
  if (prefs.weekly === false) return;

  const workspace = await buildWinningProductsWorkspace(client.clientId, 7);
  if (!workspace.pixelHealth?.daysOfData || workspace.pixelHealth.daysOfData < 3) return;

  const topWinner = (workspace.products || []).find((p) => p.classification === CLASSIFICATIONS.WINNING);
  const rising = (workspace.products || []).find((p) => p.classification === CLASSIFICATIONS.RISING);
  const leak = workspace.sitewideFunnel?.biggestLeak;

  await sendDigestTemplate(client.clientId, DIGEST_TEMPLATE_SLOTS.weekly, {
    winner: topWinner?.title || '—',
    rising: rising?.title || '—',
    issue: leak?.suggestion || 'Review your storefront funnel',
    audience: workspace.audiences?.cartAbandoners?.count || 0,
    link: 'https://dash.topedgeai.com/commerce-hub?tab=product_insights&section=overview',
  });
}

async function checkRealtimeAlerts(client) {
  const prefs = client.insightsNotifications || {};
  if (prefs.realtimeAlerts === false) return;

  const workspace = await buildWinningProductsWorkspace(client.clientId, 7);
  const cartTier = workspace.audiences?.cartAbandoners?.tier;
  const prevTier = client.insightsState?.lastAudienceTier;
  if (prevTier === 'build' && cartTier === 'minimum') {
    await sendDigestTemplate(client.clientId, DIGEST_TEMPLATE_SLOTS.audienceReady, {
      count: workspace.audiences?.cartAbandoners?.count || 0,
    });
  }

  const rising = (workspace.products || []).filter((p) => p.classification === CLASSIFICATIONS.RISING);
  if (rising.length && prefs.realtimeAlerts) {
    const last = client.insightsState?.lastRisingAlertAt;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (!last || new Date(last).getTime() < dayAgo) {
      await sendDigestTemplate(client.clientId, DIGEST_TEMPLATE_SLOTS.rising, {
        product: rising[0].title,
      });
      await Client.updateOne(
        { clientId: client.clientId },
        { $set: { 'insightsState.lastRisingAlertAt': new Date(), 'insightsState.lastAudienceTier': cartTier } }
      );
      return;
    }
  }

  await Client.updateOne(
    { clientId: client.clientId },
    { $set: { 'insightsState.lastAudienceTier': cartTier } }
  );
}

function scheduleWinningProductsDigestCron() {
  // 9:00 AM IST = 3:30 AM UTC
  cron.schedule('30 3 * * *', async () => {
    log.info('Daily winning products digest start');
    const clients = await Client.find({
      shopifyAccessToken: { $exists: true, $ne: null },
      isActive: { $ne: false },
    })
      .select('clientId insightsNotifications insightsState phoneNumber adminPhone')
      .lean();

    for (const client of clients) {
      try {
        await runDailyDigestForClient(client);
        await checkRealtimeAlerts(client);
      } catch (err) {
        log.warn(`Daily digest failed ${client.clientId}: ${err.message}`);
      }
    }
  });

  // Monday 9:00 AM IST
  cron.schedule('30 3 * * 1', async () => {
    log.info('Weekly winning products digest start');
    const clients = await Client.find({
      shopifyAccessToken: { $exists: true, $ne: null },
      isActive: { $ne: false },
    })
      .select('clientId insightsNotifications')
      .lean();

    for (const client of clients) {
      try {
        await runWeeklyDigestForClient(client);
      } catch (err) {
        log.warn(`Weekly digest failed ${client.clientId}: ${err.message}`);
      }
    }
  });
}

module.exports = {
  scheduleWinningProductsDigestCron,
  DIGEST_TEMPLATE_SLOTS,
  runDailyDigestForClient,
  runWeeklyDigestForClient,
};
