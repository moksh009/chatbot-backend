'use strict';

const TemplateSendLog = require('../models/TemplateSendLog');
const Order = require('../models/Order');
const {
  estimateCostInr,
  categoryForContext,
  normalizeCategory,
  rateInrForCategory,
  INDIA_RATES_INR,
} = require('../constants/metaWhatsAppPricing');
const { fetchWabaPricingAnalytics } = require('../utils/meta/metaPricingAnalytics');
const { aggregateOrderStatusMetrics } = require('../utils/commerce/orderStatusMetrics');
const { getShopifyWebhookHealth } = require('../utils/shopify/shopifyWebhookHealth');

function resolveTemplateCategory(client, templateName, fallbackCtx = {}) {
  const synced = Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const hit = synced.find((t) => String(t?.name || '') === String(templateName || ''));
  if (hit?.category) return normalizeCategory(hit.category);
  return categoryForContext({ ...fallbackCtx, templateName });
}

async function aggregateTemplateSendLogs(clientId, since) {
  const match = {
    clientId,
    sentAt: { $gte: since },
    failureCode: 'sent',
  };

  const byContext = await TemplateSendLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          contextType: { $ifNull: ['$contextType', 'other'] },
          automationSlotId: { $ifNull: ['$automationSlotId', ''] },
        },
        count: { $sum: 1 },
        templates: { $addToSet: '$templateName' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const recent = await TemplateSendLog.find(match)
    .sort({ sentAt: -1 })
    .limit(15)
    .select('templateName contextType automationSlotId recipientPhone sentAt failureCode status')
    .lean();

  const failed = await TemplateSendLog.countDocuments({
    clientId,
    sentAt: { $gte: since },
    failureCode: { $nin: ['sent', null] },
  });

  const sent = await TemplateSendLog.countDocuments(match);

  return { byContext, recent, sent, failed };
}

function bucketLabel(ctx, slot) {
  const c = String(ctx || '').toLowerCase();
  const s = String(slot || '').toLowerCase();
  if (c === 'abandoned_cart' || s.includes('cart')) return 'cart_recovery';
  if (c === 'cod_prepaid') return 'cod_prepaid';
  if (c === 'order' || s.includes('order') || s.includes('eco_')) return 'order_messages';
  if (c === 'admin_alert' || s.includes('admin')) return 'admin_alerts';
  if (c === 'campaign' || c === 'broadcast') return 'campaigns';
  return c || 'other';
}

async function getCronHealth() {
  try {
    const { getAppRedis } = require('../utils/core/redisFactory');
    const redis = getAppRedis();
    if (!redis || redis.status !== 'ready') return { available: false };
    const last = await redis.get('cron:last_tick');
    if (!last) return { available: true, lastTickAt: null, stale: null };
    const ageMs = Date.now() - Number(last);
    return {
      available: true,
      lastTickAt: new Date(Number(last)).toISOString(),
      ageMinutes: Math.round(ageMs / 60000),
      stale: ageMs > 10 * 60 * 1000,
    };
  } catch (_) {
    return { available: false };
  }
}

/**
 * Unified messaging activity + billing summary for dashboard strips.
 */
async function buildMessagingActivitySummary(clientConfig, opts = {}) {
  const clientId = clientConfig.clientId;
  const now = opts.now ? new Date(opts.now) : new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [logs7d, logsMtd, orders, metaBilling, cronHealth, webhooks] = await Promise.all([
    aggregateTemplateSendLogs(clientId, sevenDaysAgo),
    aggregateTemplateSendLogs(clientId, monthStart),
    Order.find({ clientId })
      .select('whatsappActivityLog orderNumber orderId')
      .lean(),
    fetchWabaPricingAnalytics(clientConfig, { now }),
    getCronHealth(),
    getShopifyWebhookHealth({
      shopDomain: clientConfig.shopDomain,
      shopifyAccessToken: clientConfig.shopifyAccessToken,
    }).catch(() => null),
  ]);

  const orderMetrics = aggregateOrderStatusMetrics(orders, { now: now.getTime() });

  const buckets7d = {};
  let estimatedMtdInr = 0;

  for (const row of logsMtd.byContext) {
    const ctx = row._id.contextType;
    const slot = row._id.automationSlotId;
    const label = bucketLabel(ctx, slot);
    buckets7d[label] = (buckets7d[label] || 0) + row.count;

    const templateName = (row.templates || [])[0];
    const cat = resolveTemplateCategory(clientConfig, templateName, {
      contextType: ctx,
      automationSlotId: slot,
    });
    estimatedMtdInr += estimateCostInr(cat, row.count);
  }

  const buckets7dFromLogs = {};
  for (const row of logs7d.byContext) {
    const label = bucketLabel(row._id.contextType, row._id.automationSlotId);
    buckets7dFromLogs[label] = (buckets7dFromLogs[label] || 0) + row.count;
  }

  const billing = {
    currency: 'INR',
    ratesInr: INDIA_RATES_INR,
    estimatedMtdInr: Math.round(estimatedMtdInr * 100) / 100,
    metaMtdInr: metaBilling?.ok ? metaBilling.totalCostInr : null,
    metaVolumeMtd: metaBilling?.ok ? metaBilling.totalVolume : null,
    metaByCategory: metaBilling?.ok ? metaBilling.byCategory : null,
    metaSource: metaBilling?.ok ? 'meta_pricing_analytics' : 'estimate_only',
    metaFetchError: metaBilling?.ok ? null : metaBilling?.reason || null,
    disclaimer:
      'Meta bills per delivered template by category (India list rates). Utility inside 24h service window is free. Marketing has no volume discount.',
  };

  return {
    sends: {
      last7d: {
        sent: logs7d.sent,
        failed: logs7d.failed,
        byBucket: buckets7dFromLogs,
      },
      monthToDate: {
        sent: logsMtd.sent,
        failed: logsMtd.failed,
        byBucket: buckets7d,
      },
    },
    orderStatus: orderMetrics.byStatus,
    recentFailures: orderMetrics.failures.slice(0, 10),
    recentSends: logs7d.recent.map((r) => ({
      at: r.sentAt,
      templateName: r.templateName,
      contextType: r.contextType,
      automationSlotId: r.automationSlotId,
      phone: r.recipientPhone,
      bucket: bucketLabel(r.contextType, r.automationSlotId),
      estCostInr: estimateCostInr(
        resolveTemplateCategory(clientConfig, r.templateName, {
          contextType: r.contextType,
          automationSlotId: r.automationSlotId,
        }),
        1
      ),
    })),
    billing,
    cronHealth,
    webhooks,
    rateInrForCategory,
  };
}

module.exports = {
  buildMessagingActivitySummary,
  resolveTemplateCategory,
  bucketLabel,
};
