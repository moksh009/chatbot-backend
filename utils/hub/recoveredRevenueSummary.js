'use strict';

const Client = require('../../models/Client');
const { getCartRecoveryDelays } = require('../commerce/cartRecoveryConfigService');
const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');

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
 * Recovery counts/revenue sourced from cartRecoveryMetricsService (cohort SSOT).
 * @param {string} clientId
 * @param {{ days?: number }} opts
 */
async function buildRecoveredRevenueSummary(clientId, opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 30, 1), 90);
  const { istDateRangeStrings, startOfDayForDateStrIST } = require('../core/queryHelpers');
  const { start: startDateStr } = istDateRangeStrings(days);
  const from = startOfDayForDateStrIST(startDateStr);
  const to = new Date();

  const client = await Client.findOne({ clientId })
    .select('wizardFeatures whatsappToken phoneNumberId wabaId shopDomain shopifyAccessToken')
    .lean();

  if (!client) return null;

  const wf = client.wizardFeatures || {};
  const delays = resolveCartNudgeFromClient(client);
  const waConnected = !!(client.whatsappToken && client.phoneNumberId);
  const shopifyConnected = !!(client.shopifyAccessToken && client.shopDomain);
  const cartEnabled = wf.enableAbandonedCart !== false;

  let cartStatus = 'paused';
  if (!cartEnabled) cartStatus = 'paused';
  else if (!waConnected) cartStatus = 'needs_setup';
  else if (!shopifyConnected) cartStatus = 'needs_setup';
  else cartStatus = 'live';

  const metrics = await calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from,
    to,
    includeFunnel: true,
    includeRows: false,
  });

  const cartRevenueInr = Number(metrics.revenueRecovered) || 0;
  const totalRecoveredInr = cartRevenueInr;
  const funnel = metrics.funnel || {};
  const messagesSent =
    (Number(funnel.msg1Sent) || 0) +
    (Number(funnel.msg2Sent) || 0) +
    (Number(funnel.msg3Sent) || 0);

  return {
    days,
    totalRecoveredInr,
    cartRecoveryRevenueInr: cartRevenueInr,
    revenueRecovered: cartRevenueInr,
    codConvertedRevenueInr: 0,
    recoveryRate: metrics.recoveryRate,
    messageEfficiencyRate: funnel.messageEfficiencyRate ?? 0,
    cartRecovery: {
      enabled: cartEnabled,
      status: cartStatus,
      live: cartStatus === 'live',
      delays: {
        minutes1: delays.delay1Min,
        hours2: delays.delay2Hr,
        hours3: delays.delay3Hr,
      },
      messagesSent,
      cartsRecovered: metrics.recoveredCarts,
      recoveredCarts: metrics.recoveredCarts,
      waRecovered: metrics.whatsappRecovered,
      whatsappRecovered: metrics.whatsappRecovered,
      organicRecovered: metrics.organicRecovered,
      waRevenueInr: Math.round(Number(metrics.revenueRecoveredFromWhatsapp) || 0),
      organicRevenueInr: Math.round(Number(metrics.organicRevenue) || 0),
      revenueRecovered: cartRevenueInr,
      revenueSource: metrics.meta?.version || 'ssot-cohort-v1',
      recoveredViaStep1: Number(funnel.recoveredAfterMsg1) || 0,
      recoveredViaStep2: Number(funnel.recoveredAfterMsg2) || 0,
      recoveredViaStep3: Number(funnel.recoveredAfterMsg3) || 0,
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
