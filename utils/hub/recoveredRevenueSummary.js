'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const DailyStat = require('../../models/DailyStat');
const CART_NUDGE_DEFAULTS = { minutes1: 15, hours2: 2, hours3: 24 };

function resolveCartNudgeDelay(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveCartNudgeFromClient(client) {
  const wf = client?.wizardFeatures || {};
  return {
    delay1Min: resolveCartNudgeDelay(wf.cartNudgeMinutes1, CART_NUDGE_DEFAULTS.minutes1),
    delay2Hr: resolveCartNudgeDelay(wf.cartNudgeHours2, CART_NUDGE_DEFAULTS.hours2),
    delay3Hr: resolveCartNudgeDelay(wf.cartNudgeHours3, CART_NUDGE_DEFAULTS.hours3),
  };
}

/**
 * Revenue + automation status for dashboard hero (Phase 2).
 * @param {string} clientId
 * @param {{ days?: number }} opts
 */
async function buildRecoveredRevenueSummary(clientId, opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 30, 1), 90);
  const start = moment().subtract(days, 'days').startOf('day').toDate();

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

  const startStr = moment(start).format('YYYY-MM-DD');
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
  const cartRevenueInr = Math.round(Number(s.cartRevenueRecovered) || 0);
  const codRevenueInr = Math.round(Number(s.codConvertedRevenue) || 0);
  const totalRecoveredInr = cartRevenueInr + codRevenueInr;

  return {
    days,
    totalRecoveredInr,
    cartRecoveryRevenueInr: cartRevenueInr,
    codConvertedRevenueInr: codRevenueInr,
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
      cartsRecovered: Number(s.cartsRecovered) || 0,
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
        key: 'cod_prepaid',
        label: 'COD → prepaid nudges',
        revenueInr: codRevenueInr,
        status: wf.enableCodToPrepaid ? (waConnected ? 'live' : 'needs_setup') : 'paused',
        meta: wf.enableCodToPrepaid ? 'Enabled in automations' : 'Off',
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
