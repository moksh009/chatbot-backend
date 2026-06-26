'use strict';

const TemplateSendLog = require('../../models/TemplateSendLog');
const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
const commerceAutomationService = require('./commerceAutomationService');
const {
  aggregateRuleSendStats,
  mergeCartPerformanceIntoRuleStats,
  ZERO_RULE_STATS,
} = require('./orderMessagesOverview');

const {
  resolveAttributionWindowHours,
} = require('../../constants/cartRecoveryDefaults');

const CART_RULE_TEMPLATE_BY_ID = {
  sys_cart_followup_1: 'cart_recovery_1',
  sys_cart_followup_2: 'cart_recovery_2',
  sys_cart_followup_3: 'cart_recovery_3',
};

function resolveStatsSince(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return new Date(0);
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '—';
  return `••••${d.slice(-4)}`;
}

function buildRuleLookupIds(rule) {
  const { buildRuleLookupIds: buildAll } = require('./orderMessagesOverview');
  return buildAll([rule]).lookupIds;
}

function mapLogRow(log) {
  const ctx = log.contextData && typeof log.contextData === 'object' ? log.contextData : {};
  const orderId = ctx.orderId || ctx.order?.id || ctx.order_id || null;
  const orderNumber = ctx.orderNumber || ctx.order?.name || ctx.order?.orderNumber || null;
  let outcome = 'sent';
  if (log.failureCode && log.failureCode !== 'sent' && log.failureCode !== 'skipped') {
    outcome = 'failed';
  } else if (log.readAt) {
    outcome = 'read';
  } else if (log.deliveredAt) {
    outcome = 'delivered';
  }

  return {
    id: String(log._id),
    sentAt: log.sentAt,
    recipientPhone: maskPhone(log.recipientPhone),
    recipientPhoneRaw: log.recipientPhone || '',
    templateName: log.templateName || '',
    channel: log.channel || 'whatsapp',
    status: log.status || 'sent',
    failureCode: log.failureCode || null,
    errorMessage: log.errorMessage || null,
    orderId: orderId ? String(orderId) : null,
    orderNumber: orderNumber ? String(orderNumber) : null,
    engagement: {
      deliveredAt: log.deliveredAt || null,
      readAt: log.readAt || null,
      clickedAt: log.clickedAt || null,
    },
    outcome,
    recovered: false,
    recoveredRevenue: null,
    source: 'template_send_log',
  };
}

async function fetchCartRuleSendRows(clientId, rule, since) {
  const step = Number(rule.meta?.followupStep) || 1;
  const tplName =
    String(rule.templateName || '').trim() || CART_RULE_TEMPLATE_BY_ID[rule.id] || '';

  const attempts = await CartRecoveryAttempt.find({
    clientId,
    attemptTimestamp: { $gte: since },
    'whatsappTemplatesSent.0': { $exists: true },
  })
    .sort({ attemptTimestamp: -1 })
    .limit(120)
    .lean();

  const rows = [];
  for (const att of attempts) {
    for (const tpl of att.whatsappTemplatesSent || []) {
      const followup = Number(tpl.followupNumber) || 0;
      if (followup !== step) continue;
      if (tplName && String(tpl.templateName || '') !== tplName) continue;

      const recovered =
        att.status === 'recovered' && att.recoveredViaWhatsapp === true;
      let outcome = 'sent';
      if (tpl.clickedAt) outcome = 'clicked';
      else if (tpl.readAt) outcome = 'read';
      else if (tpl.deliveredAt) outcome = 'delivered';
      if (recovered) outcome = 'recovered';

      rows.push({
        id: `${att._id}_${followup}`,
        sentAt: tpl.sentAt || att.attemptTimestamp,
        recipientPhone: maskPhone(att.contactPhone),
        recipientPhoneRaw: att.contactPhone || '',
        templateName: tpl.templateName || tplName,
        channel: 'whatsapp',
        status: outcome,
        failureCode: att.lastSendFailure?.step === step ? 'send_error' : null,
        errorMessage: att.lastSendFailure?.detail || att.lastSendFailure?.reason || null,
        orderId: att.recoveredOrderId ? String(att.recoveredOrderId) : null,
        orderNumber: null,
        engagement: {
          deliveredAt: tpl.deliveredAt || null,
          readAt: tpl.readAt || null,
          clickedAt: tpl.clickedAt || null,
          clickType: tpl.clickType || null,
        },
        outcome,
        recovered,
        recoveredViaWhatsapp: recovered && att.recoveredViaWhatsapp === true,
        recoveredRevenue: recovered
          ? Number(att.recoveredOrderValue || att.recoveredOrderAmount || 0)
          : null,
        recoveryAttributionLabel: recovered
          ? att.recoveredViaWhatsapp
            ? 'Recovered via TopEdge WhatsApp'
            : 'Purchased (organic)'
          : null,
        leadId: String(att.leadId || ''),
        source: 'cart_recovery_attempt',
      });
    }
  }

  return rows.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, 50);
}

async function aggregateDailyBreakdown(clientId, lookupIds, since) {
  if (!lookupIds.length) return [];

  const rows = await TemplateSendLog.aggregate([
    {
      $match: {
        clientId,
        automationSlotId: { $in: lookupIds },
        sentAt: { $gte: since },
        failureCode: 'sent',
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$sentAt', timezone: 'Asia/Kolkata' },
        },
        sent: { $sum: 1 },
        read: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $ifNull: ['$deliveredAt', false] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({
    date: r._id,
    sent: r.sent || 0,
    delivered: r.delivered || 0,
    read: r.read || 0,
  }));
}

/**
 * Per-rule stats drill-down for Order messages + cart follow-ups.
 */
async function buildRuleStatsDetail(clientConfig, ruleId, options = {}) {
  const clientId = clientConfig.clientId;
  const daysRaw = options.days;
  const windowDays =
    daysRaw === 'all' || daysRaw === 0 || daysRaw === '0'
      ? 0
      : Math.max(parseInt(daysRaw, 10) || 7, 0);
  const since = resolveStatsSince(windowDays);

  const automations = await commerceAutomationService
    .ensureSystemAutomationsPersisted(clientConfig)
    .catch(() => commerceAutomationService.buildAutomationsFromConfig(clientConfig));

  const rule = (automations || []).find((r) => r.id === ruleId);
  if (!rule) {
    return { success: false, notFound: true, ruleId };
  }

  let allStats = await aggregateRuleSendStats(clientId, automations, since);
  allStats = await mergeCartPerformanceIntoRuleStats(clientId, automations, allStats, since);
  const summary = { ...ZERO_RULE_STATS, ...(allStats[ruleId] || {}) };

  const lookupIds = buildRuleLookupIds(rule);
  const isCartRule = Boolean(CART_RULE_TEMPLATE_BY_ID[ruleId]);

  let recentSends = [];
  if (isCartRule) {
    recentSends = await fetchCartRuleSendRows(clientId, rule, since);
  }

  const logs = await TemplateSendLog.find({
    clientId,
    automationSlotId: { $in: lookupIds },
    sentAt: { $gte: since },
  })
    .sort({ sentAt: -1 })
    .limit(50)
    .lean();

  if (!isCartRule) {
    recentSends = logs.map(mapLogRow);
  } else if (!recentSends.length) {
    recentSends = logs.map(mapLogRow);
  }

  const recentFailures = logs
    .filter((l) => l.failureCode && l.failureCode !== 'sent' && l.failureCode !== 'skipped')
    .slice(0, 20)
    .map((l) => ({
      at: l.sentAt,
      recipientPhone: maskPhone(l.recipientPhone),
      failureCode: l.failureCode,
      errorMessage: l.errorMessage || null,
      orderId: l.contextData?.orderId || null,
    }));

  const dailyBreakdown = await aggregateDailyBreakdown(clientId, lookupIds, since);

  const recoveredCount = isCartRule
    ? recentSends.filter((r) => r.recovered).length
    : 0;
  const recoveryRevenue = isCartRule
    ? recentSends.reduce((sum, r) => sum + (Number(r.recoveredRevenue) || 0), 0)
    : 0;

  const attributionHours = resolveAttributionWindowHours(
    clientConfig?.cartRecoveryConfig?.attributionWindowHours
  );
  const attributionDays = Math.round(attributionHours / 24);

  return {
    success: true,
    ruleId,
    rule: {
      id: rule.id,
      name: rule.name,
      isActive: !!rule.isActive,
      templateName: rule.templateName || '',
      triggerStatusType: rule.triggerStatusType || null,
      triggerStatus: rule.triggerStatus || null,
      delayMinutes: Number(rule.delayMinutes || 0),
      channels: rule.channels || ['whatsapp'],
      category: rule.meta?.category || null,
    },
    window: {
      days: windowDays || null,
      label: windowDays ? `${windowDays} days` : 'All time',
      since: since.toISOString(),
      until: new Date().toISOString(),
    },
    summary: {
      ...summary,
      recovered: isCartRule ? summary.recovered || recoveredCount : summary.recovered,
      purchased: isCartRule ? summary.purchased || 0 : summary.purchased,
      recoveryRevenue: isCartRule
        ? summary.recoveryRevenue || recoveryRevenue
        : summary.recoveryRevenue,
    },
    recentSends,
    recentFailures,
    dailyBreakdown,
    trackingNote: isCartRule
      ? `Recovered via WhatsApp when the same phone places an order within ${attributionDays} day${attributionDays === 1 ? '' : 's'} after any cart recovery message (1, 2, or 3). Shoppers who return and complete checkout without a recovery message count as recovered at checkout.`
      : 'Opened tracking improves when Meta delivery receipts are linked to each send.',
  };
}

module.exports = { buildRuleStatsDetail, maskPhone };
