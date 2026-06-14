'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const DailyStat = require('../../models/DailyStat');
const { getCartRecoveryDelays } = require('../commerce/cartRecoveryConfigService');

function resolveCartNudgeFromClient(client) {
  const { delay1Min, delay2Min, delay3Min } = getCartRecoveryDelays(client || {});
  return {
    delay1Min,
    delay2Hr: Math.round(delay2Min / 60),
    delay3Hr: Math.round(delay3Min / 60),
  };
}

/**
 * Revenue + automation status for dashboard hero (Phase 2).
 * @param {string} clientId
 * @param {{ days?: number }} opts
 */
async function buildRecoveredRevenueSummary(clientId, opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 30, 1), 90);
  const { istDateRangeStrings, startOfDayForDateStrIST } = require('../core/queryHelpers');
  const { start: startDateStr } = istDateRangeStrings(days);
  const start = startOfDayForDateStrIST(startDateStr);

  const client = await Client.findOne({ clientId })
    .select('wizardFeatures whatsappToken phoneNumberId wabaId shopDomain shopifyAccessToken')
    .lean();

  if (!client) return null;

  const wf = client.wizardFeatures || {};
  const delays = resolveCartNudgeFromClient(client);
  const waConnected = !!(client.whatsappToken && client.phoneNumberId);
  const shopifyConnected = !!(client.shopifyAccessToken && client.shopDomain);
  const cartEnabled = wf.enableAbandonedCart !== false;

  let cartLive = cartEnabled && waConnected;
  let cartStatus = 'paused';
  if (!cartEnabled) cartStatus = 'paused';
  else if (!waConnected) cartStatus = 'needs_setup';
  else if (!shopifyConnected) cartStatus = 'needs_setup';
  else cartStatus = 'live';

  const startStr = startDateStr;
  const { getRecoveryTotalsFromAttempts } = require('../commerce/cartRecoveryAttemptService');
  const attemptTotals = await getRecoveryTotalsFromAttempts(clientId, start, new Date()).catch(() => null);

  const agg = await DailyStat.aggregate([
    { $match: { clientId, date: { $gte: startStr } } },
    {
      $group: {
        _id: null,
        cartRevenueRecovered: { $sum: '$cartRevenueRecovered' },
        codConvertedRevenue: { $sum: '$codConvertedRevenue' },
        cartRecoveryMessagesSent: { $sum: '$cartRecoveryMessagesSent' },
        abandonedCartSent: { $sum: '$abandonedCartSent' },
        cartsRecovered: { $sum: '$cartsRecovered' },
        recoveredViaStep1: { $sum: '$recoveredViaStep1' },
        recoveredViaStep2: { $sum: '$recoveredViaStep2' },
        recoveredViaStep3: { $sum: '$recoveredViaStep3' },
      },
    },
  ]);

  const s = agg[0] || {};
  const attemptRevenue = Math.round(Number(attemptTotals?.revenueRecovered) || 0);
  const dailyStatRevenue = Math.round(Number(s.cartRevenueRecovered) || 0);
  const cartRevenueInr = attemptRevenue > 0 ? attemptRevenue : dailyStatRevenue;
  // V1: cart recovery only — COD→prepaid is coming soon and excluded from hero totals.
  const totalRecoveredInr = cartRevenueInr;

  return {
    days,
    totalRecoveredInr,
    cartRecoveryRevenueInr: cartRevenueInr,
    codConvertedRevenueInr: 0,
    cartRecovery: {
      enabled: cartEnabled,
      status: cartStatus,
      live: cartStatus === 'live',
      delays: {
        minutes1: delays.delay1Min,
        hours2: delays.delay2Hr,
        hours3: delays.delay3Hr,
      },
      messagesSent: Number(s.cartRecoveryMessagesSent) || Number(s.abandonedCartSent) || 0,
      cartsRecovered: attemptTotals?.recoveredCarts ?? (Number(s.cartsRecovered) || 0),
      waRecovered: attemptTotals?.waRecovered ?? 0,
      organicRecovered: attemptTotals?.organicRecovered ?? 0,
      waRevenueInr: Math.round(Number(attemptTotals?.waRevenue) || 0),
      organicRevenueInr: Math.round(Number(attemptTotals?.organicRevenue) || 0),
      revenueSource: attemptRevenue > 0 ? 'cart_recovery_attempts' : 'daily_stat',
      recoveredViaStep1: Number(s.recoveredViaStep1) || 0,
      recoveredViaStep2: Number(s.recoveredViaStep2) || 0,
      recoveredViaStep3: Number(s.recoveredViaStep3) || 0,
    },
    automations: [
      {
        key: 'cart_recovery',
        label: 'Cart recovery (3-msg)',
        revenueInr: cartRevenueInr,
        status: cartStatus,
        meta: `Msg 1 · ${delays.delay1Min}m · Msg 2 · ${delays.delay2Hr}h · Msg 3 · ${delays.delay3Hr}h`,
      },
      {
        key: 'order_confirm',
        label: 'Order confirmations',
        revenueInr: 0,
        status:
          wf.enableOrderConfirmTpl !== false
            ? waConnected && shopifyConnected
              ? 'live'
              : 'needs_setup'
            : 'paused',
        meta: 'Utility templates',
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildRecoveredRevenueSummary };
