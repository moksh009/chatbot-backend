'use strict';

const commerceAutomationService = require('../commerce/commerceAutomationService');
const { buildOrderMessagesOverview } = require('../commerce/orderMessagesOverview');
const { buildAbandonedCartReadiness } = require('../commerce/abandonedCartReadiness');
const { buildPlatformHealth } = require('./platformHealth');
const { getLogisticsProfile } = require('../../services/logisticsEligibilityService');
const { isWorkspaceConnected } = require('./dashboardWorkspaceBundle');

function resolveCodConfig(clientConfig) {
  const rto = clientConfig?.rtoProtection || clientConfig?.config?.rtoProtection || {};
  return {
    requireCodConfirmation: rto.requireCodConfirmation === true,
    enabled: rto.enabled === true,
    ...rto,
  };
}

function resolveStatsDays(days) {
  const raw = parseInt(days, 10);
  if (raw === 0) return 0;
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

async function buildAutomationsSection(clientConfig) {
  try {
    const automations = await commerceAutomationService.ensureSystemAutomationsPersisted(clientConfig);
    return {
      success: true,
      automations,
      version:
        clientConfig.commerceAutomationVersion ||
        commerceAutomationService.COMMERCE_AUTOMATION_VERSION ||
        2,
    };
  } catch (persistErr) {
    console.warn('[order-messages/workspace] automations persist fallback:', persistErr.message);
    const automations = commerceAutomationService.buildAutomationsFromConfig(clientConfig);
    return {
      success: true,
      automations,
      version: commerceAutomationService.COMMERCE_AUTOMATION_VERSION || 2,
      warning: 'Loaded from cache — sync will retry automatically.',
    };
  }
}

/**
 * GET /api/client/:clientId/order-messages/workspace — SAC + Audience cart gate bundle.
 */
async function buildOrderMessagesWorkspace(clientId, options = {}) {
  const { clientConfig, days = 7 } = options;
  const statsDays = resolveStatsDays(days);
  const codConfig = resolveCodConfig(clientConfig);

  const connected = await isWorkspaceConnected(clientId);
  if (!connected) {
    return {
      automations: { success: true, automations: [], version: 2 },
      overview: null,
      readiness: null,
      codConfig,
      platformHealth: null,
      logistics: null,
      meta: { partial: false, disconnected: true, days: statsDays },
    };
  }

  const overviewDays = statsDays === 0 ? 0 : statsDays;
  const sectionKeys = ['automations', 'overview', 'readiness', 'platformHealth', 'logistics'];
  const sectionTasks = [
    buildAutomationsSection(clientConfig),
    buildOrderMessagesOverview(clientConfig, { days: overviewDays }),
    buildAbandonedCartReadiness(clientId),
    buildPlatformHealth(),
    getLogisticsProfile(clientId),
  ];

  const settled = await Promise.allSettled(sectionTasks);
  const failedSections = [];

  const automations =
    settled[0].status === 'fulfilled' ? settled[0].value : null;
  const overview =
    settled[1].status === 'fulfilled' ? settled[1].value : null;
  const readiness =
    settled[2].status === 'fulfilled' ? settled[2].value : null;
  const platformHealth =
    settled[3].status === 'fulfilled' ? settled[3].value : null;
  const logisticsProfile =
    settled[4].status === 'fulfilled' ? settled[4].value : null;

  sectionKeys.forEach((key, i) => {
    if (settled[i].status === 'rejected') {
      failedSections.push(key);
      console.warn(`[order-messages/workspace] ${key}:`, settled[i].reason?.message || settled[i].reason);
    }
  });

  return {
    automations,
    overview,
    readiness,
    codConfig,
    platformHealth,
    logistics: logisticsProfile ? { success: true, profile: logisticsProfile } : null,
    meta: {
      partial: failedSections.length > 0,
      failedSections,
      days: statsDays,
      disconnected: false,
    },
  };
}

module.exports = {
  buildOrderMessagesWorkspace,
  resolveStatsDays,
};
