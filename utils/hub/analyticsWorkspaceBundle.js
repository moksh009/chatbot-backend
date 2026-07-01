'use strict';

const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');
const { parseDateRange } = require('../commerce/abandonedCartWorkspace');
const { buildAbandonedCartWorkspace } = require('../commerce/abandonedCartWorkspace');
const { buildMessagingActivitySummary } = require('../../services/messagingActivityService');
const { isWorkspaceConnected } = require('./dashboardWorkspaceBundle');
const {
  buildOverviewSection,
  buildRealtimeSection,
  buildTopProductsSection,
  buildTopLeadsSection,
  buildLeadsSummarySection,
  buildOptinOverviewSection,
  buildAbandonedProductsSection,
  daysToOptinPeriod,
  daysToCartWorkspacePeriod,
} = require('./analyticsWorkspaceSections');
const { buildCampaignOverviewFullPayload } = require('../commerce/campaignOverviewBundle');

function resolveApiDays(days) {
  const raw = parseInt(days, 10);
  if (raw === 999) return 90;
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 30, 1), 90);
}

async function buildCartRecoveryMetricsSection(clientId, days) {
  const apiDays = resolveApiDays(days);
  const preset =
    apiDays <= 7 ? '7d' : apiDays <= 30 ? '30d' : apiDays <= 60 ? '60d' : '90d';
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

/**
 * GET /api/analytics/workspace — Insights analytics tab first-paint bundle.
 */
async function buildAnalyticsWorkspace(clientId, options = {}) {
  const { clientConfig, days = 30, phoneNumberId = '' } = options;
  const apiDays = resolveApiDays(days);
  const query = {
    days: parseInt(days, 10) === 999 ? 999 : apiDays,
    clientId,
    phoneNumberId: phoneNumberId || undefined,
  };
  const periodDays = apiDays;
  const optinPeriod = daysToOptinPeriod(days);
  const cartPeriod = daysToCartWorkspacePeriod(days);

  const connected = await isWorkspaceConnected(clientId);
  if (!connected) {
    return {
      overview: { success: true, stats: [], summary: { activeChats: 0, audience: 0, audienceTotal: 0 } },
      realtime: null,
      topLeads: { success: true, leads: [], limit: 5 },
      leadsSummary: { totalLeads: 0, summary: { activeToday: 0, activeInPeriod: 0, withConversation: 0, highEngagement: 0 } },
      optinOverview: {},
      topProducts: [],
      abandonedProducts: [],
      cartWorkspace: {},
      campaignOverview: null,
      messagingActivity: null,
      cartRecoveryMetrics: null,
      meta: { partial: false, disconnected: true, days: apiDays },
    };
  }

  const tasks = {
    overview: buildOverviewSection(clientId, query),
    realtime: buildRealtimeSection(clientId, days),
    topLeads: buildTopLeadsSection(clientId, 5),
    leadsSummary: buildLeadsSummarySection(clientId, periodDays),
    optinOverview: buildOptinOverviewSection(clientId, optinPeriod),
    topProducts: buildTopProductsSection(clientId, days),
    abandonedProducts: buildAbandonedProductsSection(clientId, days),
    cartWorkspace: buildAbandonedCartWorkspace(clientId, { period: cartPeriod }),
    campaignOverview: buildCampaignOverviewFullPayload(clientId, days),
    cartRecoveryMetrics: buildCartRecoveryMetricsSection(clientId, days),
  };

  if (clientConfig) {
    tasks.messagingActivity = buildMessagingActivitySummary(clientConfig).then((summary) => ({
      success: true,
      ...summary,
    }));
  }

  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(keys.map((k) => tasks[k]));
  const failedSections = [];
  const out = { meta: { partial: false, days: apiDays } };

  results.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled') {
      out[key] = result.value;
    } else {
      failedSections.push(key);
      out[key] = null;
      console.warn(`[analytics/workspace] ${key}:`, result.reason?.message || result.reason);
    }
  });

  out.meta.partial = failedSections.length > 0;
  out.meta.failedSections = failedSections;
  return out;
}

module.exports = {
  buildAnalyticsWorkspace,
  resolveApiDays,
};
