'use strict';

const NodeCache = require('node-cache');
const Order = require('../../models/Order');
const ScoreTierConfig = require('../../models/ScoreTierConfig');
const { normalizePhone } = require('../core/helpers');

/** Per-client score tiers — safe to cache 2 min (Live Chat full-context hot path). */
const scoreTierCache = new NodeCache({ stdTTL: 120, checkperiod: 60, maxKeys: 200 });

const SUCCESS_FINANCIAL_STATUSES = ['paid', 'fulfilled', 'delivered', 'partially_fulfilled'];
const EXCLUDE_ORDER_STATUSES = ['cancelled', 'refunded', 'returned', 'voided'];

function orderRevenue(order) {
  const v = order?.totalPrice ?? order?.amount ?? 0;
  return Number(v) || 0;
}

/** Orders counted in analytics period KPIs (includes COD / pending — not only paid). */
function buildAnalyticsPeriodOrderMatch(clientId, extra = {}) {
  return {
    clientId,
    ...extra,
    status: { $nin: EXCLUDE_ORDER_STATUSES },
  };
}

/** Mongo match for paid/successful orders (excludes pending, cancelled, refunded). */
function buildSuccessfulOrderMatch(clientId, extra = {}) {
  return {
    clientId,
    ...extra,
    $and: [
      {
        $or: [
          { financialStatus: { $in: SUCCESS_FINANCIAL_STATUSES } },
          { status: { $in: SUCCESS_FINANCIAL_STATUSES } },
        ],
      },
      { status: { $nin: EXCLUDE_ORDER_STATUSES } },
      { financialStatus: { $nin: ['pending', 'refunded', 'voided', 'partially_refunded', 'unpaid'] } },
    ],
  };
}

/**
 * Orders that count toward per-customer LTV (Live Chat sidebar, lead enrichment).
 * Includes COD / Shopify pending — same spirit as calculateAnalyticsPeriodMetrics.
 */
function buildCustomerLtvOrderMatch(clientId, extra = {}) {
  return {
    clientId,
    ...extra,
    status: { $nin: EXCLUDE_ORDER_STATUSES },
    financialStatus: { $nin: ['cancelled', 'refunded', 'voided', 'partially_refunded'] },
  };
}

function phoneMatchQuery(phone) {
  const norm = normalizePhone(phone);
  const digits = String(phone || '').replace(/\D/g, '');
  const suffix = digits.length >= 10 ? digits.slice(-10) : digits;
  const or = [{ phone: norm }, { customerPhone: norm }];
  if (suffix) {
    or.push({ phone: { $regex: `${suffix}$` } }, { customerPhone: { $regex: `${suffix}$` } });
  }
  if (phone && phone !== norm) {
    or.push({ phone }, { customerPhone: phone });
  }
  return { $or: or };
}

/**
 * LTV = sum of successful order totals for one customer (all time).
 */
async function calculateCustomerLTV(clientId, customerPhone) {
  if (!clientId || !customerPhone) return 0;
  const rows = await Order.aggregate([
    {
      $match: {
        ...buildCustomerLtvOrderMatch(clientId),
        ...phoneMatchQuery(customerPhone),
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }],
          },
        },
      },
    },
  ]);
  return Number(rows[0]?.total) || 0;
}

/**
 * Average LTV = mean of per-customer lifetime totals (all successful orders, all time per customer).
 * When startDate/endDate are set, only customers with at least one successful order in that window
 * are included; each customer's LTV still sums all their successful orders ever.
 */
async function calculateAverageLTV(clientId, startDate, endDate) {
  if (!clientId) return 0;

  const baseMatch = buildSuccessfulOrderMatch(clientId);
  let customerFilter = null;

  if (startDate || endDate) {
    const periodMatch = { ...baseMatch };
    periodMatch.createdAt = {};
    if (startDate) periodMatch.createdAt.$gte = new Date(startDate);
    if (endDate) periodMatch.createdAt.$lte = new Date(endDate);

    const [phones, phonesAlt] = await Promise.all([
      Order.distinct('phone', periodMatch),
      Order.distinct('customerPhone', periodMatch),
    ]);
    const keys = [...new Set([...phones, ...phonesAlt].filter(Boolean))];
    if (!keys.length) return 0;
    customerFilter = keys;
  }

  const lifetimeMatch = { ...baseMatch };
  if (customerFilter) {
    lifetimeMatch.$or = [
      { phone: { $in: customerFilter } },
      { customerPhone: { $in: customerFilter } },
    ];
  }

  const ltvByCustomer = await Order.aggregate([
    { $match: lifetimeMatch },
    {
      $addFields: {
        customerKey: {
          $ifNull: [
            '$phone',
            '$customerPhone',
          ],
        },
        revenue: {
          $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }],
        },
      },
    },
    { $match: { customerKey: { $nin: [null, ''] } } },
    {
      $group: {
        _id: '$customerKey',
        customerLTV: { $sum: '$revenue' },
      },
    },
  ]);

  if (!ltvByCustomer.length) return 0;
  const totalLTVSum = ltvByCustomer.reduce((sum, c) => sum + (c.customerLTV || 0), 0);
  return totalLTVSum / ltvByCustomer.length;
}

/**
 * AOV = total successful revenue / count of successful orders (optional createdAt window).
 */
async function calculateAverageOrderValue(clientId, startDate, endDate) {
  if (!clientId) return 0;

  const match = buildSuccessfulOrderMatch(clientId);
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const result = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalRevenue: {
          $sum: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] },
        },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  if (!result.length || !result[0].orderCount) return 0;
  return result[0].totalRevenue / result[0].orderCount;
}

/**
 * Stage name from Score Settings tiers: highest threshold <= leadScore.
 */
function resolveScoreStageName(leadScore, tiers) {
  const score = Number(leadScore) || 0;
  if (!Array.isArray(tiers) || !tiers.length) return 'Unprocessed';

  const sorted = [...tiers].sort((a, b) => Number(a.score) - Number(b.score));
  let stageName = sorted[0].tierLabel || sorted[0].label || 'Unprocessed';

  for (const tier of sorted) {
    const threshold = Number(tier.score) || 0;
    if (score >= threshold) {
      stageName = tier.tierLabel || tier.label || stageName;
    }
  }
  return stageName;
}

async function resolveScoreStageNameForClient(clientId, leadScore) {
  let tiers = scoreTierCache.get(clientId);
  if (!tiers) {
    const config = await ScoreTierConfig.findOne({ clientId }).select('tiers').lean();
    tiers = config?.tiers?.length
      ? config.tiers
      : ScoreTierConfig.getDefaultConfig(clientId).tiers;
    scoreTierCache.set(clientId, tiers);
  }
  return resolveScoreStageName(leadScore, tiers);
}

/**
 * Period metrics for Analytics retention panel — aligns with dashboard revenue
 * (includes COD / pending paid orders with totalPrice, not only strict "paid" status).
 */
async function calculateAnalyticsPeriodMetrics(clientId, startDate, endDate) {
  if (!clientId) {
    return { avgOrderValue: 0, avgLTV: 0, orderCount: 0, totalRevenue: 0 };
  }

  const match = {
    clientId,
    status: { $nin: EXCLUDE_ORDER_STATUSES },
    financialStatus: { $nin: ['cancelled', 'refunded', 'voided', 'partially_refunded'] },
  };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const rows = await Order.aggregate([
    { $match: match },
    {
      $addFields: {
        revenue: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] },
        customerKey: { $ifNull: ['$phone', '$customerPhone'] },
      },
    },
    { $match: { revenue: { $gt: 0 } } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: '$revenue' },
              orderCount: { $sum: 1 },
            },
          },
        ],
        byCustomer: [
          { $match: { customerKey: { $nin: [null, ''] } } },
          { $group: { _id: '$customerKey', customerLTV: { $sum: '$revenue' } } },
        ],
      },
    },
  ]);

  const facet = rows[0] || {};
  const totals = facet.totals?.[0] || { totalRevenue: 0, orderCount: 0 };
  const byCustomer = facet.byCustomer || [];
  const orderCount = totals.orderCount || 0;
  const totalRevenue = totals.totalRevenue || 0;
  const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;
  const avgLTV =
    byCustomer.length > 0
      ? byCustomer.reduce((sum, c) => sum + (c.customerLTV || 0), 0) / byCustomer.length
      : 0;

  return {
    avgOrderValue: Math.round(avgOrderValue * 100) / 100,
    avgLTV: Math.round(avgLTV * 100) / 100,
    orderCount,
    totalRevenue,
  };
}

module.exports = {
  SUCCESS_FINANCIAL_STATUSES,
  EXCLUDE_ORDER_STATUSES,
  buildSuccessfulOrderMatch,
  buildAnalyticsPeriodOrderMatch,
  buildCustomerLtvOrderMatch,
  orderRevenue,
  calculateCustomerLTV,
  calculateAverageLTV,
  calculateAverageOrderValue,
  calculateAnalyticsPeriodMetrics,
  resolveScoreStageName,
  resolveScoreStageNameForClient,
};
