'use strict';

const Order = require('../../models/Order');
const TemplateSendLog = require('../../models/TemplateSendLog');
const { aggregateOrderStatusMetrics } = require('./orderStatusMetrics');
const { getShopifyWebhookHealth,
  ORDER_MESSAGE_WEBHOOK_TOPICS,
} = require('../shopify/shopifyWebhookHealth');
const commerceAutomationService = require('./commerceAutomationService');
const { estimateCostInr, categoryForContext } = require('../../constants/metaWhatsAppPricing');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const ZERO_RULE_STATS = {
  sent: 0,
  delivered: 0,
  failed: 0,
  read: 0,
  clicked: 0,
  recovered: 0,
  purchased: 0,
  recoveryRevenue: 0,
  lastSendAt: null,
  deliveryRate: null,
  readRate: null,
  clickRate: null,
  recoveryRate: null,
};

function resolveStatsSince(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return new Date(0);
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function ensureAllRuleStats(automations = [], stats = {}) {
  const out = { ...stats };
  for (const rule of automations) {
    const ruleId = String(rule?.id || '').trim();
    if (!ruleId) continue;
    out[ruleId] = { ...ZERO_RULE_STATS, ...(out[ruleId] || {}) };
  }
  return out;
}

const CART_SLOT_LOOKUP_BY_RULE = {
  sys_cart_followup_1: ['followup_1', 'cart_recovery_1'],
  sys_cart_followup_2: ['followup_2', 'cart_recovery_2'],
  sys_cart_followup_3: ['followup_3', 'cart_recovery_3'],
};

/** Jun 2026 — historical TemplateSendLog rows keyed by retired rule ids. */
const RETIRED_RULE_STATS_ALIASES = {
  sys_financial_paid: 'sys_fulfillment_unfulfilled',
  sys_financial_pending: 'sys_fulfillment_unfulfilled',
  sys_fulfillment_fulfilled: 'sys_shipment_in_transit',
  sys_fulfillment_partial: 'sys_shipment_in_transit',
};

function buildRuleLookupIds(automations = []) {
  const ruleIdByLookup = {};
  const lookupIds = new Set();

  for (const rule of automations) {
    const ruleId = String(rule?.id || '').trim();
    if (!ruleId) continue;

    ruleIdByLookup[ruleId] = ruleId;
    lookupIds.add(ruleId);

    const cartSlots = CART_SLOT_LOOKUP_BY_RULE[ruleId];
    if (cartSlots) {
      for (const slot of cartSlots) {
        ruleIdByLookup[slot] = ruleId;
        lookupIds.add(slot);
      }
      continue;
    }

    const cartSlot = commerceAutomationService.cartFollowupSlotFromRule(rule);
    if (cartSlot) {
      ruleIdByLookup[cartSlot] = ruleId;
      lookupIds.add(cartSlot);
    }
  }

  for (const [legacyId, canonicalId] of Object.entries(RETIRED_RULE_STATS_ALIASES)) {
    if (!ruleIdByLookup[canonicalId]) continue;
    ruleIdByLookup[legacyId] = canonicalId;
    lookupIds.add(legacyId);
  }

  return { ruleIdByLookup, lookupIds: [...lookupIds] };
}

async function aggregateRuleSendStats(clientId, automations = [], since) {
  const { ruleIdByLookup, lookupIds } = buildRuleLookupIds(automations);
  if (!clientId || !lookupIds.length) return {};

  const rows = await TemplateSendLog.aggregate([
    {
      $match: {
        clientId,
        sentAt: { $gte: since },
        automationSlotId: { $in: lookupIds },
      },
    },
    {
      $group: {
        _id: '$automationSlotId',
        sent: {
          $sum: {
            $cond: [{ $eq: ['$failureCode', 'sent'] }, 1, 0],
          },
        },
        delivered: {
          $sum: {
            $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0],
          },
        },
        failed: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$failureCode', 'sent'] },
                  { $ne: ['$failureCode', null] },
                  { $ne: ['$failureCode', 'skipped'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        lastSendAt: { $max: '$sentAt' },
      },
    },
  ]);

  const stats = {};
  for (const row of rows) {
    const ruleId = ruleIdByLookup[row._id] || row._id;
    if (!stats[ruleId]) {
      stats[ruleId] = { ...ZERO_RULE_STATS };
    }
    stats[ruleId].sent += row.sent || 0;
    stats[ruleId].delivered += row.delivered || 0;
    stats[ruleId].failed += row.failed || 0;
    if (
      row.lastSendAt &&
      (!stats[ruleId].lastSendAt || new Date(row.lastSendAt) > new Date(stats[ruleId].lastSendAt))
    ) {
      stats[ruleId].lastSendAt = row.lastSendAt;
    }
  }

  return stats;
}

const CART_RULE_TEMPLATE_BY_ID = {
  sys_cart_followup_1: 'cart_recovery_1',
  sys_cart_followup_2: 'cart_recovery_2',
  sys_cart_followup_3: 'cart_recovery_3',
};

async function mergeCartPerformanceIntoRuleStats(clientId, automations, stats, since) {
  const cartRules = (automations || []).filter((r) => CART_RULE_TEMPLATE_BY_ID[r?.id]);
  if (!clientId || !cartRules.length) return stats;

  try {
    const { getCartRecoveryTemplatePerformance } = require('./cartRecoveryAttemptService');
    const templates = await getCartRecoveryTemplatePerformance(clientId, since, new Date());
    const byName = Object.fromEntries((templates || []).map((t) => [t.templateName, t]));

    for (const rule of cartRules) {
      const tplName =
        String(rule.templateName || '').trim() ||
        CART_RULE_TEMPLATE_BY_ID[rule.id] ||
        '';
      const perf = byName[tplName];
      const existing = stats[rule.id] || { ...ZERO_RULE_STATS };

      stats[rule.id] = {
        ...existing,
        sent: Math.max(existing.sent || 0, perf?.sends || 0),
        delivered: Math.max(existing.delivered || 0, perf?.delivered || 0),
        read: perf?.read || 0,
        clicked: perf?.clicked || 0,
        recovered: perf?.recovered || 0,
        purchased: perf?.purchased || 0,
        recoveryRevenue: perf?.recoveryRevenue || 0,
        deliveryRate: perf?.deliveryRate ?? null,
        readRate: perf?.readRate ?? null,
        clickRate: perf?.clickRate ?? null,
        recoveryRate: perf?.recoveryRate ?? null,
      };
    }
  } catch (err) {
    console.warn('[OrderMessagesOverview] cart performance merge:', err.message);
  }

  return stats;
}

function countActiveAutomations(automations = []) {
  return (automations || []).filter((rule) => rule?.isActive === true).length;
}

async function buildPeriodSummaryKpis(clientId, ruleSendStats = {}, since) {
  let totalSent = 0;
  let totalFailed = 0;
  let totalRead = 0;
  let totalClicked = 0;

  for (const stats of Object.values(ruleSendStats || {})) {
    totalSent += Number(stats?.sent) || 0;
    totalFailed += Number(stats?.failed) || 0;
    totalRead += Number(stats?.read) || 0;
    totalClicked += Number(stats?.clicked) || 0;
  }

  let estimatedCostInr = 0;
  try {
    const logs = await TemplateSendLog.find({
      clientId,
      sentAt: { $gte: since },
      failureCode: 'sent',
    })
      .select('templateName contextType automationSlotId')
      .lean();

    for (const log of logs) {
      const cat = categoryForContext({
        contextType: log.contextType,
        templateName: log.templateName,
        automationSlotId: log.automationSlotId,
      });
      estimatedCostInr += estimateCostInr(cat, 1);
    }
    estimatedCostInr = Math.round(estimatedCostInr * 100) / 100;
  } catch (err) {
    console.warn('[OrderMessagesOverview] period cost estimate:', err.message);
    estimatedCostInr = Math.round(totalSent * 0.115 * 100) / 100;
  }

  return {
    totalSent,
    totalFailed,
    totalRead,
    totalClicked,
    estimatedCostInr,
  };
}

function buildOrderMessagesAlerts({
  actionableFailures = [],
  activeRulesCount = 0,
  shippedAutoEnabled = false,
  webhooks = {},
}) {
  const failuresCount = actionableFailures.length;
  const webhooksMissing = Array.isArray(webhooks.missing) ? webhooks.missing.length : 0;
  const automationEnabled = activeRulesCount > 0 || shippedAutoEnabled;

  return {
    failures: {
      show: automationEnabled && failuresCount > 0,
      count: failuresCount,
      message:
        failuresCount > 0
          ? `${failuresCount} WhatsApp send${failuresCount === 1 ? '' : 's'} failed this week on live automations — review templates on the rules below.`
          : null,
    },
    webhooks: {
      show: automationEnabled && webhooksMissing > 0 && !webhooks.checkFailed,
      count: webhooksMissing,
      message:
        webhooksMissing > 0
          ? `${webhooksMissing} Shopify order webhook${webhooksMissing === 1 ? '' : 's'} missing — order events may not reach TopEdge until connected.`
          : null,
      settingsUrl: '/settings?tab=connections',
    },
  };
}

/**
 * SAC order-messages overview: per-status metrics, recent failures, webhook health.
 */
async function buildOrderMessagesOverview(clientConfig, options = {}) {
  const clientId = clientConfig.clientId;
  const statsWindowDays = Number(options.days);
  const windowDays = Number.isFinite(statsWindowDays) && statsWindowDays > 0 ? statsWindowDays : null;
  const since = resolveStatsSince(windowDays || 0);
  const now = Date.now();
  const sevenDaysAgo = new Date(now - SEVEN_DAYS_MS);

  const [orders, webhooks, automations] = await Promise.all([
    Order.find({ clientId }).select('whatsappActivityLog orderNumber orderId').lean(),
    getShopifyWebhookHealth({
      shopDomain: clientConfig.shopDomain,
      shopifyAccessToken: clientConfig.shopifyAccessToken,
      topics: ORDER_MESSAGE_WEBHOOK_TOPICS,
    }),
    commerceAutomationService
      .ensureSystemAutomationsPersisted(clientConfig)
      .catch(() => commerceAutomationService.buildAutomationsFromConfig(clientConfig)),
  ]);

  const { byStatus, failures } = aggregateOrderStatusMetrics(orders, { now });
  let ruleSendStats = await aggregateRuleSendStats(clientId, automations, since);
  ruleSendStats = await mergeCartPerformanceIntoRuleStats(
    clientId,
    automations,
    ruleSendStats,
    since
  );
  ruleSendStats = ensureAllRuleStats(automations, ruleSendStats);

  const periodSummary = await buildPeriodSummaryKpis(clientId, ruleSendStats, since);

  const wf =
    clientConfig.wizardFeatures && typeof clientConfig.wizardFeatures.toObject === 'function'
      ? clientConfig.wizardFeatures.toObject()
      : clientConfig.wizardFeatures || {};

  const shippedAutoEnabled = wf.enableAutoShopifyShippedWhatsApp === true;
  const activeRulesCount = countActiveAutomations(automations);
  const alerts = buildOrderMessagesAlerts({
    actionableFailures: failures,
    activeRulesCount,
    shippedAutoEnabled,
    webhooks,
  });

  let messagingActivity = null;
  let templateReadiness = null;
  try {
    const { buildMessagingActivitySummary } = require('../../services/messagingActivityService');
    messagingActivity = await buildMessagingActivitySummary(clientConfig);
  } catch (err) {
    console.warn('[OrderMessagesOverview] messaging activity:', err.message);
  }
  try {
    const { buildCartRecoveryTemplateReadiness } = require('./cartRecoveryTemplateReadiness');
    templateReadiness = buildCartRecoveryTemplateReadiness(clientConfig);
  } catch (err) {
    console.warn('[OrderMessagesOverview] template readiness:', err.message);
  }

  return {
    metrics: byStatus,
    failures: failures.slice(0, 80),
    webhooks,
    alerts,
    activeRulesCount,
    ruleSendStats,
    periodSummary,
    statsWindowDays: windowDays,
    features: {
      enableAutoShopifyShippedWhatsApp: shippedAutoEnabled,
    },
    orderTriggers: clientConfig.nicheData?.orderStatusTemplates || {},
    messagingActivity,
    templateReadiness,
    cronHealth: messagingActivity?.cronHealth || null,
  };
}

module.exports = {
  buildOrderMessagesOverview,
  aggregateRuleSendStats,
  mergeCartPerformanceIntoRuleStats,
  ensureAllRuleStats,
  buildOrderMessagesAlerts,
  buildRuleLookupIds,
  ZERO_RULE_STATS,
  resolveStatsSince,
};
