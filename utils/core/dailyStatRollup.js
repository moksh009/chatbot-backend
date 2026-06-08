/**
 * Phase 3 — DailyStat rollup write path + helpers for timeline read path.
 * Nightly/hourly jobs and on-demand backfill call rollupDayForClient().
 */
const DailyStat = require('../../models/DailyStat');
const Message = require('../../models/Message');
const Appointment = require('../../models/Appointment');
const Order = require('../../models/Order');
const { timeParallel } = require('./perfLogger');
const log = require('./logger')('DailyStatRollup');
const {
  todayDateStrIST,
  startOfDayForDateStrIST,
  endOfDayForDateStrIST,
} = require('./queryHelpers');

const ROLLUP_CONCURRENCY = parseInt(process.env.DAILY_STAT_ROLLUP_CONCURRENCY || '4', 10);
const ON_DEMAND_ROLLUP_CAP = parseInt(process.env.DAILY_STAT_ON_DEMAND_CAP || '31', 10);

function noopTimer() {
  return {
    checkpoint: () => {},
    finish: () => {},
    log: () => {},
    time: async (_label, fn) => fn(),
  };
}

function todayDateStr() {
  return todayDateStrIST();
}

/** IST midnight bounds for YYYY-MM-DD (matches getTimelineStats date loop). */
function dayBounds(dateStr) {
  return {
    start: startOfDayForDateStrIST(dateStr),
    end: endOfDayForDateStrIST(dateStr),
  };
}

function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Run one-day aggregations (same metrics as timeline live path, scoped to a single day).
 */
async function aggregateDayMetrics(clientId, dateStr, options = {}) {
  const timer = options.timer || noopTimer();
  const PixelEvent = require('../../models/PixelEvent');
  const LinkClickEvent = require('../../models/LinkClickEvent');
  const ConversationAssignment = require('../../models/ConversationAssignment');
  const clientIdQuery = { clientId };
  const { start, end } = dayBounds(dateStr);

  const parallel = await timeParallel(
    timer,
    {
      message_conversation_activity: () =>
        Message.aggregate([
          { $match: { ...clientIdQuery, timestamp: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: {
                date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
                conversationId: '$conversationId',
              },
            },
          },
          { $group: { _id: '$_id.date', count: { $sum: 1 } } },
        ]),
      appointment_daily: () =>
        Appointment.aggregate([
          { $match: { ...clientIdQuery, createdAt: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              count: { $sum: 1 },
              revenue: { $sum: { $ifNull: ['$revenue', 0] } },
            },
          },
        ]),
      message_daily: () =>
        Message.aggregate([
          { $match: { ...clientIdQuery, timestamp: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      order_daily: () =>
        Order.aggregate([
          { $match: { ...clientIdQuery, createdAt: { $gte: start, $lte: end } } },
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
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              count: { $sum: 1 },
              revenue: {
                $sum: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] },
              },
              units: { $sum: '$orderUnits' },
            },
          },
        ]),
      pixel_cart_daily: () =>
        PixelEvent.aggregate([
          {
            $match: {
              ...clientIdQuery,
              eventName: {
                $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started'],
              },
              timestamp: { $gte: start, $lte: end },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      pixel_checkout_daily: () =>
        PixelEvent.aggregate([
          {
            $match: {
              ...clientIdQuery,
              eventName: 'checkout_started',
              timestamp: { $gte: start, $lte: end },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      link_click_daily: () =>
        LinkClickEvent.aggregate([
          { $match: { ...clientIdQuery, timestamp: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      human_handled_daily: () =>
        ConversationAssignment.aggregate([
          { $match: { ...clientIdQuery, assignedAt: { $gte: start, $lte: end } } },
          {
            $group: {
              _id: {
                date: { $dateToString: { format: '%Y-%m-%d', date: '$assignedAt' } },
                conversationId: '$conversationId',
              },
            },
          },
          { $group: { _id: '$_id.date', count: { $sum: 1 } } },
        ]),
      ai_handled_daily: () =>
        Message.aggregate([
          {
            $match: {
              ...clientIdQuery,
              timestamp: { $gte: start, $lte: end },
              direction: 'outgoing',
            },
          },
          {
            $group: {
              _id: {
                date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
                conversationId: '$conversationId',
              },
            },
          },
          {
            $lookup: {
              from: 'conversationassignments',
              let: { cId: '$_id.conversationId', d: '$_id.date' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$conversationId', '$$cId'] },
                        {
                          $eq: [
                            { $dateToString: { format: '%Y-%m-%d', date: '$assignedAt' } },
                            '$$d',
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
              as: 'assignments',
            },
          },
          { $match: { assignments: { $size: 0 } } },
          { $group: { _id: '$_id.date', count: { $sum: 1 } } },
        ]),
    },
    `rollup_day_${dateStr}`
  );

  const pick = (arr) => arr.find((r) => r._id === dateStr);
  const convActivity = pick(parallel.message_conversation_activity)?.count || 0;
  const appt = pick(parallel.appointment_daily);
  const msgs = pick(parallel.message_daily)?.count || 0;
  const ord = pick(parallel.order_daily);
  const carts = pick(parallel.pixel_cart_daily)?.count || 0;
  const checkouts = pick(parallel.pixel_checkout_daily)?.count || 0;
  const links = pick(parallel.link_click_daily)?.count || 0;
  const humanHandled = pick(parallel.human_handled_daily)?.count || 0;
  const aiHandled = pick(parallel.ai_handled_daily)?.count || 0;

  const orderCount = ord?.count || 0;
  const orderRevenue = ord?.revenue || 0;
  const apptRevenue = appt?.revenue || 0;
  const apptCount = appt?.count || 0;

  return {
    totalChats: convActivity,
    uniqueUsers: convActivity,
    orders: orderCount,
    unitsSold: ord?.units || 0,
    revenue: orderRevenue + apptRevenue,
    orderRevenue,
    bookingRevenue: apptRevenue,
    appointmentsBooked: apptCount,
    totalMessagesExchanged: msgs,
    addToCarts: carts,
    linkClicks: links,
    checkouts,
    humanHandled,
    aiHandled,
  };
}

/**
 * Upsert rollup-computed fields. Does not zero event-driven counters (abandoned cart, flows, etc.).
 */
async function upsertDailyStatRollup(clientId, dateStr, metrics) {
  const $set = {
    totalChats: metrics.totalChats,
    uniqueUsers: metrics.uniqueUsers,
    orders: metrics.orders,
    unitsSold: metrics.unitsSold ?? 0,
    revenue: metrics.revenue,
    orderRevenue: metrics.orderRevenue ?? 0,
    bookingRevenue: metrics.bookingRevenue,
    appointmentsBooked: metrics.appointmentsBooked,
    totalMessagesExchanged: metrics.totalMessagesExchanged,
    addToCarts: metrics.addToCarts,
    linkClicks: metrics.linkClicks,
    humanHandled: metrics.humanHandled,
    aiHandled: metrics.aiHandled,
    rollupComputedAt: new Date(),
  };
  if (metrics.checkouts != null) {
    $set.checkouts = metrics.checkouts;
  }

  return DailyStat.findOneAndUpdate(
    { clientId, date: dateStr },
    { $set, $setOnInsert: { clientId, date: dateStr } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function rollupDayForClient(clientId, dateStr, options = {}) {
  const metrics = await aggregateDayMetrics(clientId, dateStr, options);
  const doc = await upsertDailyStatRollup(clientId, dateStr, metrics);
  return doc;
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err };
        log.warn(`rollup failed ${items[i]}: ${err.message}`);
      }
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

/**
 * Roll up multiple days for one client (backfill / on-demand).
 */
async function rollupDaysForClient(clientId, dateStrings, options = {}) {
  const unique = [...new Set(dateStrings)].sort();
  const concurrency = options.concurrency || ROLLUP_CONCURRENCY;
  await runPool(unique, (dateStr) => rollupDayForClient(clientId, dateStr, options), concurrency);
  return unique.length;
}

function needsRollup(doc, dateStr, today) {
  if (!doc) return true;
  if (dateStr === today) return false;
  if (!doc.rollupComputedAt) return true;
  // Recompute rollups that recorded orders but missed revenue (legacy amount-only rollup)
  if ((doc.orders || 0) > 0 && (doc.orderRevenue || 0) <= 0 && (doc.revenue || 0) <= 0) {
    return true;
  }
  return false;
}

/**
 * Map a DailyStat document (+ optional GCal count + live overlay for today) to timeline row shape.
 */
function dailyStatToTimelineRow(date, doc, gcalCount = 0, liveOverlay = null) {
  const base = doc ? (doc.toObject ? doc.toObject() : doc) : {};
  const m = liveOverlay ? { ...base, ...liveOverlay } : base;

  const humanHandled = m.humanHandled || 0;
  const aiHandled = m.aiHandled || 0;
  const flowsSent = m.flowsSent || 0;
  const flowsCompleted = m.flowsCompleted || 0;
  const apptRevenue = m.bookingRevenue || 0;
  const orderRevenue =
    m.orderRevenue != null
      ? m.orderRevenue
      : Math.max(0, (m.revenue || 0) - apptRevenue);
  const orderCount = m.orders || 0;
  const apptCount =
    gcalCount > 0 ? gcalCount : m.appointmentsBooked || 0;
  const totalRevenue =
    liveOverlay?.revenue != null
      ? liveOverlay.revenue
      : orderRevenue + apptRevenue;

  const aiResolutionRateDay =
    humanHandled + aiHandled > 0 ? (aiHandled / (humanHandled + aiHandled)) * 100 : 0;
  const flowCompletionRateDay = flowsSent > 0 ? (flowsCompleted / flowsSent) * 100 : 0;

  return {
    date,
    totalChats: m.totalChats || 0,
    uniqueUsers: m.uniqueUsers || 0,
    appointmentsBooked: apptCount,
    totalMessagesExchanged: m.totalMessagesExchanged || 0,
    birthdayRemindersSent: m.birthdayRemindersSent || 0,
    appointmentRemindersSent: m.appointmentRemindersSent || 0,
    orders: orderCount,
    unitsSold: m.unitsSold || 0,
    revenue: totalRevenue,
    apptRevenue,
    orderRevenue: liveOverlay?.orderRevenue != null ? liveOverlay.orderRevenue : orderRevenue,
    addToCarts: m.addToCarts || 0,
    linkClicks: m.linkClicks || 0,
    humanHandled,
    aiHandled,
    agentRequests: humanHandled,
    checkouts: m.checkouts || 0,
    abandonedCartSent: m.abandonedCartSent || 0,
    abandonedCartClicks: m.abandonedCartClicks || 0,
    cartRecoveryMessagesSent: m.cartRecoveryMessagesSent || 0,
    cartsRecovered: m.cartsRecovered || 0,
    recoveredViaStep1: m.recoveredViaStep1 || 0,
    recoveredViaStep2: m.recoveredViaStep2 || 0,
    recoveredViaStep3: m.recoveredViaStep3 || 0,
    codNudgesSent: m.codNudgesSent || 0,
    rtoCostSaved: m.rtoCostSaved || 0,
    codConvertedRevenue: m.codConvertedRevenue || 0,
    codConvertedCount: m.codConvertedCount || 0,
    cartRevenueRecovered: m.cartRevenueRecovered || 0,
    flowsSent,
    flowsCompleted,
    browseAbandonedCount: m.browseAbandonedCount || 0,
    upsellSentCount: m.upsellSentCount || 0,
    upsellConvertedCount: m.upsellConvertedCount || 0,
    upsellRevenue: m.upsellRevenue || 0,
    marketingMessagesSent: m.marketingMessagesSent || 0,
    aiResolutionRate: Number(aiResolutionRateDay.toFixed(2)),
    flowCompletionRate: Number(flowCompletionRateDay.toFixed(2)),
  };
}

/**
 * Roll up yesterday for every active client (nightly job).
 */
async function rollupYesterdayForAllClients() {
  const Client = require('../../models/Client');
  const dateStr = yesterdayDateStr();
  const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
  log.info(`Rolling up ${dateStr} for ${clients.length} clients`);
  for (const c of clients) {
    try {
      await rollupDayForClient(c.clientId, dateStr);
    } catch (err) {
      log.warn(`rollupYesterday ${c.clientId}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  log.info(`Yesterday rollup done for ${clients.length} clients`);
}

/**
 * Refresh today's rollup for all active clients (hourly job).
 */
async function rollupTodayForAllClients() {
  const Client = require('../../models/Client');
  const dateStr = todayDateStr();
  const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
  for (const c of clients) {
    try {
      await rollupDayForClient(c.clientId, dateStr);
    } catch (err) {
      log.warn(`rollupToday ${c.clientId}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

module.exports = {
  todayDateStr,
  yesterdayDateStr,
  dayBounds,
  aggregateDayMetrics,
  upsertDailyStatRollup,
  rollupDayForClient,
  rollupDaysForClient,
  dailyStatToTimelineRow,
  needsRollup,
  ON_DEMAND_ROLLUP_CAP,
  rollupYesterdayForAllClients,
  rollupTodayForAllClients,
};
