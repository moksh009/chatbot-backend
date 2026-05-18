'use strict';

const Order = require('../models/Order');
const ScoreTierConfig = require('../models/ScoreTierConfig');
const { normalizePhone } = require('./helpers');

const SUCCESS_FINANCIAL_STATUSES = ['paid', 'fulfilled', 'delivered', 'partially_fulfilled'];
const EXCLUDE_ORDER_STATUSES = ['cancelled', 'refunded', 'returned', 'voided'];

function orderRevenue(order) {
  const v = order?.totalPrice ?? order?.amount ?? 0;
  return Number(v) || 0;
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
  const orders = await Order.find({
    ...buildSuccessfulOrderMatch(clientId),
    ...phoneMatchQuery(customerPhone),
  })
    .select('totalPrice amount')
    .lean();
  return orders.reduce((sum, o) => sum + orderRevenue(o), 0);
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
  const config = await ScoreTierConfig.findOne({ clientId }).lean();
  const tiers = config?.tiers?.length
    ? config.tiers
    : ScoreTierConfig.getDefaultConfig(clientId).tiers;
  return resolveScoreStageName(leadScore, tiers);
}

module.exports = {
  SUCCESS_FINANCIAL_STATUSES,
  EXCLUDE_ORDER_STATUSES,
  buildSuccessfulOrderMatch,
  calculateCustomerLTV,
  calculateAverageLTV,
  calculateAverageOrderValue,
  resolveScoreStageName,
  resolveScoreStageNameForClient,
};
