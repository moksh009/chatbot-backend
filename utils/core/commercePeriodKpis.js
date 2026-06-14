'use strict';

/**
 * Commerce period KPIs — canonical sources (AN-P1-03):
 * - Store revenue / orders: reconciled DailyStat + live Orders + timeline
 * - Cart recovery metrics: cartRecoveryMetricsService (cohort abandon-date SSOT)
 * - Recovery messages: DailyStat.cartRecoveryMessagesSent (funnel only — NOT recovery rate denominator)
 */

const DailyStat = require('../../models/DailyStat');
const { istDateRangeStrings, startOfDayForDateStrIST, istDateOffsetDays } = require('./queryHelpers');
const Order = require('../../models/Order');
const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');

/**
 * Sum timeline rows (from getTimelineStats / dailyStatToTimelineRow) into period KPIs.
 * Uses orderRevenue for store revenue; total revenue includes appointments when present.
 */
function sumTimelineKpis(timeline = []) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const out = {
    orders: 0,
    orderRevenue: 0,
    revenue: 0,
    unitsSold: 0,
    totalChats: 0,
    totalMessagesExchanged: 0,
    linkClicks: 0,
    addToCarts: 0,
    checkouts: 0,
    abandonedCartSent: 0,
    abandonedCartClicks: 0,
    cartRecoveryMessagesSent: 0,
    cartsRecovered: 0,
    cartRevenueRecovered: 0,
    codConvertedCount: 0,
    codConvertedRevenue: 0,
    flowsSent: 0,
    flowsCompleted: 0,
    marketingMessagesSent: 0,
    humanHandled: 0,
    aiHandled: 0,
    uniqueUsers: 0,
  };

  for (const row of rows) {
    const orderRev =
      row.orderRevenue != null
        ? Number(row.orderRevenue) || 0
        : Math.max(0, (Number(row.revenue) || 0) - (Number(row.apptRevenue) || 0));
    out.orders += Number(row.orders) || 0;
    out.orderRevenue += orderRev;
    out.revenue += Number(row.revenue) || 0;
    out.unitsSold += Number(row.unitsSold) || 0;
    out.totalChats += Number(row.totalChats) || 0;
    out.totalMessagesExchanged += Number(row.totalMessagesExchanged) || 0;
    out.linkClicks += Number(row.linkClicks) || 0;
    out.addToCarts += Number(row.addToCarts) || 0;
    out.checkouts += Number(row.checkouts) || 0;
    out.abandonedCartSent += Number(row.abandonedCartSent) || 0;
    out.abandonedCartClicks += Number(row.abandonedCartClicks) || 0;
    out.cartRecoveryMessagesSent += Number(row.cartRecoveryMessagesSent) || 0;
    out.cartsRecovered += Number(row.cartsRecovered) || 0;
    out.cartRevenueRecovered += Number(row.cartRevenueRecovered) || 0;
    out.codConvertedCount += Number(row.codConvertedCount) || 0;
    out.codConvertedRevenue += Number(row.codConvertedRevenue) || 0;
    out.flowsSent += Number(row.flowsSent) || 0;
    out.flowsCompleted += Number(row.flowsCompleted) || 0;
    out.marketingMessagesSent += Number(row.marketingMessagesSent) || 0;
    out.humanHandled += Number(row.humanHandled) || 0;
    out.aiHandled += Number(row.aiHandled) || 0;
    out.uniqueUsers += Number(row.uniqueUsers) || 0;
  }

  out.avgOrderValue = out.orders > 0 ? Math.round(out.orderRevenue / out.orders) : 0;
  out.cartRecoveryRate = 0;
  out.flowCompletionRate =
    out.flowsSent > 0 ? Math.round((out.flowsCompleted / out.flowsSent) * 100) : 0;

  return out;
}

function dateRangeStrings(days) {
  return istDateRangeStrings(days);
}

function applyCanonicalCartRecoveryToKpis(kpis, recoveryMetrics) {
  if (!recoveryMetrics) return kpis;
  kpis.totalAbandoned = recoveryMetrics.totalAbandoned;
  kpis.cartsRecovered = recoveryMetrics.recoveredCarts;
  kpis.recoveredCarts = recoveryMetrics.recoveredCarts;
  kpis.cartRevenueRecovered = recoveryMetrics.revenueRecovered;
  kpis.revenueRecovered = recoveryMetrics.revenueRecovered;
  kpis.cartRecoveryRate = recoveryMetrics.recoveryRate;
  kpis.recoveryRate = recoveryMetrics.recoveryRate;
  kpis.whatsappRecovered = recoveryMetrics.whatsappRecovered;
  kpis.organicRecovered = recoveryMetrics.organicRecovered;
  kpis.messageEfficiencyRate = recoveryMetrics.funnel?.messageEfficiencyRate ?? 0;
  return kpis;
}

async function fetchCanonicalCartRecoveryMetrics(clientId, startDate, endDate) {
  return calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from: startDate,
    to: endDate,
    includeFunnel: true,
    includeRows: false,
  }).catch(() => null);
}

/** Prior window of equal length immediately before the current period (for dashboard deltas). */
function priorDateRangeStrings(days) {
  const n = Math.min(Math.max(parseInt(days, 10) || 1, 1), 90);
  const { start: currentStart } = istDateRangeStrings(n);
  const priorEnd = istDateOffsetDays(currentStart, -1);
  const priorStart = istDateOffsetDays(priorEnd, -(n - 1));
  return { start: priorStart, end: priorEnd, days: n };
}

async function buildPriorCommercePeriodKpis(clientId, daysInput, opts = {}) {
  let start;
  let end;
  let days;
  if (opts.end && opts.days) {
    days = Math.min(Math.max(parseInt(opts.days, 10) || 1, 1), 90);
    end = typeof opts.end === 'string' ? opts.end.slice(0, 10) : opts.end;
    start = istDateOffsetDays(end, -(days - 1));
  } else {
    ({ start, end, days } = priorDateRangeStrings(daysInput));
  }
  const { endOfDayForDateStrIST } = require('./queryHelpers');
  const startDate = startOfDayForDateStrIST(start);
  const endDate = endOfDayForDateStrIST(end);
  const [dailyKpis, liveOrders, liveEngagement, recoveryMetrics] = await Promise.all([
    aggregateDailyStatKpis(clientId, start, end),
    aggregateLiveOrdersForRange(clientId, startDate, endDate),
    aggregateLiveEngagementForRange(clientId, startDate, endDate),
    fetchCanonicalCartRecoveryMetrics(clientId, startDate, endDate),
  ]);
  const kpis = reconcileKpis({}, dailyKpis, liveOrders, liveEngagement);
  applyCanonicalCartRecoveryToKpis(kpis, recoveryMetrics);
  return { ...kpis, days, startDate: start, endDate: end, source: 'prior_reconciled' };
}

/**
 * Ground-truth rollup from DailyStat (includes bot/WhatsApp event counters).
 */
async function aggregateDailyStatKpis(clientId, startDateStr, endDateStr) {
  const agg = await DailyStat.aggregate([
    { $match: { clientId, date: { $gte: startDateStr, $lte: endDateStr } } },
    {
      $group: {
        _id: null,
        orders: { $sum: { $ifNull: ['$orders', 0] } },
        orderRevenue: { $sum: { $ifNull: ['$orderRevenue', 0] } },
        revenue: { $sum: { $ifNull: ['$revenue', 0] } },
        unitsSold: { $sum: { $ifNull: ['$unitsSold', 0] } },
        totalChats: { $sum: { $ifNull: ['$totalChats', 0] } },
        totalMessagesExchanged: { $sum: { $ifNull: ['$totalMessagesExchanged', 0] } },
        linkClicks: { $sum: { $ifNull: ['$linkClicks', 0] } },
        addToCarts: { $sum: { $ifNull: ['$addToCarts', 0] } },
        checkouts: { $sum: { $ifNull: ['$checkouts', 0] } },
        abandonedCartSent: { $sum: { $ifNull: ['$abandonedCartSent', 0] } },
        abandonedCartClicks: { $sum: { $ifNull: ['$abandonedCartClicks', 0] } },
        cartRecoveryMessagesSent: { $sum: { $ifNull: ['$cartRecoveryMessagesSent', 0] } },
        cartsRecovered: { $sum: { $ifNull: ['$cartsRecovered', 0] } },
        cartRevenueRecovered: { $sum: { $ifNull: ['$cartRevenueRecovered', 0] } },
        codConvertedCount: { $sum: { $ifNull: ['$codConvertedCount', 0] } },
        codConvertedRevenue: { $sum: { $ifNull: ['$codConvertedRevenue', 0] } },
        flowsSent: { $sum: { $ifNull: ['$flowsSent', 0] } },
        flowsCompleted: { $sum: { $ifNull: ['$flowsCompleted', 0] } },
        marketingMessagesSent: { $sum: { $ifNull: ['$marketingMessagesSent', 0] } },
        humanHandled: { $sum: { $ifNull: ['$humanHandled', 0] } },
        aiHandled: { $sum: { $ifNull: ['$aiHandled', 0] } },
        uniqueUsers: { $sum: { $ifNull: ['$uniqueUsers', 0] } },
      },
    },
  ]).option({ maxTimeMS: 15_000 });

  const s = agg[0] || {};
  const orderRevenue =
    Number(s.orderRevenue) > 0
      ? Number(s.orderRevenue)
      : Math.max(0, (Number(s.revenue) || 0) - 0);
  const orders = Number(s.orders) || 0;

  return {
    orders,
    orderRevenue,
    revenue: Number(s.revenue) || 0,
    unitsSold: Number(s.unitsSold) || 0,
    totalChats: Number(s.totalChats) || 0,
    totalMessagesExchanged: Number(s.totalMessagesExchanged) || 0,
    linkClicks: Number(s.linkClicks) || 0,
    addToCarts: Number(s.addToCarts) || 0,
    checkouts: Number(s.checkouts) || 0,
    abandonedCartSent: Number(s.abandonedCartSent) || 0,
    abandonedCartClicks: Number(s.abandonedCartClicks) || 0,
    cartRecoveryMessagesSent: Number(s.cartRecoveryMessagesSent) || 0,
    cartsRecovered: Number(s.cartsRecovered) || 0,
    cartRevenueRecovered: Number(s.cartRevenueRecovered) || 0,
    codConvertedCount: Number(s.codConvertedCount) || 0,
    codConvertedRevenue: Number(s.codConvertedRevenue) || 0,
    flowsSent: Number(s.flowsSent) || 0,
    flowsCompleted: Number(s.flowsCompleted) || 0,
    marketingMessagesSent: Number(s.marketingMessagesSent) || 0,
    humanHandled: Number(s.humanHandled) || 0,
    aiHandled: Number(s.aiHandled) || 0,
    uniqueUsers: Number(s.uniqueUsers) || 0,
    avgOrderValue: orders > 0 ? Math.round(orderRevenue / orders) : 0,
    cartRecoveryRate: 0,
    flowCompletionRate:
      Number(s.flowsSent) > 0
        ? Math.round((Number(s.flowsCompleted) / Number(s.flowsSent)) * 100)
        : 0,
  };
}

async function aggregateLiveOrdersForRange(clientId, startDate, endDate = null) {
  const createdAt = { $gte: startDate };
  if (endDate) createdAt.$lte = endDate;
  const agg = await Order.aggregate([
    { $match: { clientId, createdAt } },
    {
      $addFields: {
        orderUnits: {
          $sum: {
            $map: {
              input: { $ifNull: ['$items', []] },
              as: 'it',
              in: { $ifNull: ['$$it.quantity', 0] },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        orderRevenue: {
          $sum: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] },
        },
        unitsSold: { $sum: '$orderUnits' },
      },
    },
  ]).option({ maxTimeMS: 12_000 });

  const row = agg[0] || {};
  return {
    orders: Number(row.orders) || 0,
    orderRevenue: Math.round(Number(row.orderRevenue) || 0),
    unitsSold: Number(row.unitsSold) || 0,
  };
}

async function aggregateLiveEngagementForRange(clientId, startDate, endDate) {
  const LinkClickEvent = require('../../models/LinkClickEvent');
  const PixelEvent = require('../../models/PixelEvent');
  const [linkClicks, addToCarts] = await Promise.all([
    LinkClickEvent.countDocuments({
      clientId,
      timestamp: { $gte: startDate, $lte: endDate },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: { $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started'] },
      timestamp: { $gte: startDate, $lte: endDate },
    }),
  ]);
  return {
    linkClicks: Number(linkClicks) || 0,
    addToCarts: Number(addToCarts) || 0,
  };
}

/** Pick authoritative commerce counts (timeline + DailyStat + live orders). */
function reconcileKpis(timelineKpis, dailyKpis, liveOrders, liveEngagement = {}) {
  const pickMax = (a, b, c) => Math.max(Number(a) || 0, Number(b) || 0, Number(c) || 0);

  const orders = pickMax(timelineKpis.orders, dailyKpis.orders, liveOrders.orders);
  const orderRevenue = pickMax(
    timelineKpis.orderRevenue,
    dailyKpis.orderRevenue,
    liveOrders.orderRevenue
  );
  const unitsSold = pickMax(timelineKpis.unitsSold, dailyKpis.unitsSold, liveOrders.unitsSold);

  const merged = {
    ...dailyKpis,
    orders,
    orderRevenue,
    revenue: pickMax(timelineKpis.revenue, dailyKpis.revenue, orderRevenue),
    unitsSold,
    totalChats: pickMax(timelineKpis.totalChats, dailyKpis.totalChats),
    totalMessagesExchanged: pickMax(
      timelineKpis.totalMessagesExchanged,
      dailyKpis.totalMessagesExchanged
    ),
    linkClicks: pickMax(
      timelineKpis.linkClicks,
      dailyKpis.linkClicks,
      liveEngagement.linkClicks
    ),
    addToCarts: pickMax(
      timelineKpis.addToCarts,
      dailyKpis.addToCarts,
      liveEngagement.addToCarts
    ),
    checkouts: pickMax(timelineKpis.checkouts, dailyKpis.checkouts),
    abandonedCartSent: pickMax(timelineKpis.abandonedCartSent, dailyKpis.abandonedCartSent),
    abandonedCartClicks: pickMax(
      timelineKpis.abandonedCartClicks,
      dailyKpis.abandonedCartClicks
    ),
    cartRecoveryMessagesSent: pickMax(
      timelineKpis.cartRecoveryMessagesSent,
      dailyKpis.cartRecoveryMessagesSent
    ),
    cartsRecovered: pickMax(timelineKpis.cartsRecovered, dailyKpis.cartsRecovered),
    cartRevenueRecovered: pickMax(
      timelineKpis.cartRevenueRecovered,
      dailyKpis.cartRevenueRecovered
    ),
    codConvertedCount: pickMax(timelineKpis.codConvertedCount, dailyKpis.codConvertedCount),
    codConvertedRevenue: pickMax(
      timelineKpis.codConvertedRevenue,
      dailyKpis.codConvertedRevenue
    ),
    flowsSent: pickMax(timelineKpis.flowsSent, dailyKpis.flowsSent),
    flowsCompleted: pickMax(timelineKpis.flowsCompleted, dailyKpis.flowsCompleted),
    marketingMessagesSent: pickMax(
      timelineKpis.marketingMessagesSent,
      dailyKpis.marketingMessagesSent
    ),
    humanHandled: pickMax(timelineKpis.humanHandled, dailyKpis.humanHandled),
    aiHandled: pickMax(timelineKpis.aiHandled, dailyKpis.aiHandled),
    uniqueUsers: pickMax(timelineKpis.uniqueUsers, dailyKpis.uniqueUsers),
  };

  merged.avgOrderValue = merged.orders > 0 ? Math.round(merged.orderRevenue / merged.orders) : 0;
  merged.cartRecoveryRate = 0;
  merged.flowCompletionRate =
    merged.flowsSent > 0 ? Math.round((merged.flowsCompleted / merged.flowsSent) * 100) : 0;

  return merged;
}

/**
 * @param {{ clientId: string, days: number, timeline?: array, startDate?: Date }} opts
 */
async function buildCommercePeriodKpis(opts) {
  const { clientId, days: daysInput, timeline, start: startOverride, end: endOverride } = opts;
  let start;
  let end;
  let days;
  if (startOverride && endOverride) {
    start = startOverride.slice(0, 10);
    end = endOverride.slice(0, 10);
    const startMs = startOfDayForDateStrIST(start).getTime();
    const endMs = startOfDayForDateStrIST(end).getTime();
    days = Math.min(Math.max(Math.floor((endMs - startMs) / 86400000) + 1, 1), 90);
  } else {
    ({ start, end, days } = dateRangeStrings(daysInput));
  }
  const startDate = startOfDayForDateStrIST(start);

  const { endOfDayForDateStrIST } = require('./queryHelpers');
  const endDate = endOfDayForDateStrIST(end);

  const [dailyKpis, liveOrders, liveEngagement, recoveryMetrics] = await Promise.all([
    aggregateDailyStatKpis(clientId, start, end),
    aggregateLiveOrdersForRange(clientId, startDate, endDate),
    aggregateLiveEngagementForRange(clientId, startDate, endDate),
    fetchCanonicalCartRecoveryMetrics(clientId, startDate, endDate),
  ]);

  const timelineKpis = sumTimelineKpis(timeline || []);
  const kpis = reconcileKpis(timelineKpis, dailyKpis, liveOrders, liveEngagement);
  applyCanonicalCartRecoveryToKpis(kpis, recoveryMetrics);

  return {
    ...kpis,
    days,
    startDate: start,
    endDate: end,
    source: 'reconciled',
  };
}

function mergeRealtimeWithPeriodKpis(realtime, periodKpis) {
  if (!realtime || !periodKpis) return realtime;
  return {
    ...realtime,
    orders: {
      count: periodKpis.orders ?? realtime.orders?.count ?? 0,
      revenue: periodKpis.orderRevenue ?? realtime.orders?.revenue ?? 0,
    },
    unitsSold: periodKpis.unitsSold ?? realtime.unitsSold ?? 0,
    linkClicks: periodKpis.linkClicks ?? realtime.linkClicks ?? 0,
    addToCarts: periodKpis.addToCarts ?? realtime.addToCarts ?? 0,
    checkouts: periodKpis.checkouts ?? realtime.checkouts ?? 0,
    abandonedCartSent: periodKpis.abandonedCartSent ?? realtime.abandonedCartSent ?? 0,
    abandonedCartClicks: periodKpis.abandonedCartClicks ?? realtime.abandonedCartClicks ?? 0,
    recoveredCarts: periodKpis.recoveredCarts ?? periodKpis.cartsRecovered ?? realtime.recoveredCarts ?? 0,
    cartRecoveryMessagesSent:
      periodKpis.cartRecoveryMessagesSent ?? realtime.cartRecoveryMessagesSent ?? 0,
    cartRevenueRecovered:
      periodKpis.revenueRecovered ?? periodKpis.cartRevenueRecovered ?? realtime.cartRevenueRecovered ?? 0,
    recoveryRate: periodKpis.recoveryRate ?? periodKpis.cartRecoveryRate ?? realtime.recoveryRate ?? 0,
    messageEfficiencyRate: periodKpis.messageEfficiencyRate ?? realtime.messageEfficiencyRate ?? 0,
    periodKpis,
  };
}

module.exports = {
  sumTimelineKpis,
  aggregateDailyStatKpis,
  aggregateLiveOrdersForRange,
  reconcileKpis,
  buildCommercePeriodKpis,
  buildPriorCommercePeriodKpis,
  mergeRealtimeWithPeriodKpis,
  dateRangeStrings,
  priorDateRangeStrings,
};
