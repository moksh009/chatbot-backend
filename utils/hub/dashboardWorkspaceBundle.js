'use strict';

const Client = require('../../models/Client');
const Campaign = require('../../models/Campaign');
const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');
const { parseDateRange } = require('../commerce/abandonedCartWorkspace');
const { getShopifyRecentOrders } = require('../shopify/shopifyRecentOrders');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { getCachedClient, CONNECTION_STATUS_SELECT } = require('../core/clientCache');

function isThrottledWhatsApp(clientDoc) {
  const until = clientDoc?.complianceConfig?.rateLimits?.whatsapp?.throttledUntil;
  return !!(until && new Date(until) > new Date());
}

function daysToPreset(days) {
  const n = Number(days) || 30;
  if (n <= 7) return '7d';
  if (n <= 30) return '30d';
  if (n <= 60) return '60d';
  return '90d';
}

async function isWorkspaceConnected(clientId) {
  const client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);
  const flags = buildConnectionStatusPayload(client);
  return !!(flags.shopify_connected || flags.whatsapp_connected);
}

/** GET /campaigns/:id/overview?pulse=1 equivalent */
async function buildCampaignPulse(clientId) {
  const clientDoc = await Client.findOne({ clientId })
    .select('complianceConfig whatsappToken phoneNumberId wabaId plan subscriptionPlan')
    .lean();

  const activeCampaigns = await Campaign.countDocuments({ clientId, status: 'SENDING' }).maxTimeMS(4000);

  return {
    success: true,
    pulse: true,
    activeCampaigns,
    throttledWhatsApp: isThrottledWhatsApp(clientDoc),
  };
}

/** GET /cart-recovery/metrics cohort preset for dashboard home */
async function buildCartRecoveryMetricsCohort(clientId, days = 30) {
  const preset = daysToPreset(days);
  const { from, to, timezone } = parseDateRange({ preset });
  const metrics = await calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from,
    to,
    timezone,
    includeFunnel: true,
    includeRows: false,
    reconcileFirst: false,
    persistOrderMap: false,
  });
  return { success: true, ...metrics };
}

/** GET /shopify/:id/recent-orders equivalent */
async function buildRecentOrders(clientId) {
  return getShopifyRecentOrders(clientId);
}

module.exports = {
  isWorkspaceConnected,
  buildCampaignPulse,
  buildCartRecoveryMetricsCohort,
  buildRecentOrders,
  daysToPreset,
};
