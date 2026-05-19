/**
 * Shared analytics data loaders — used by routes/analytics.js and dashboard summary.
 */
const DailyStat = require('../models/DailyStat');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Appointment = require('../models/Appointment');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { listEvents } = require('../utils/googleCalendar');
const { getCachedClient } = require('../utils/clientCache');
const { getAppRedis } = require('../utils/redisFactory');
const { timeParallel } = require('../utils/perfLogger');

const MAX_LIVE_ANALYTICS_DAYS = 90;
const GCAL_CACHE_TTL_SEC = 300;
const TIMELINE_ROLLUP_MIN_DAYS = parseInt(process.env.TIMELINE_ROLLUP_MIN_DAYS || '3', 10);

const {
  todayDateStr,
  aggregateDayMetrics,
  rollupDaysForClient,
  dailyStatToTimelineRow,
  needsRollup,
  ON_DEMAND_ROLLUP_CAP,
} = require('./dailyStatRollup');

function noopTimer() {
  return {
    checkpoint: () => {},
    finish: () => {},
    log: () => {},
    time: async (_label, fn) => fn(),
  };
}

async function fetchGcalEventsCached(clientId, calendarIds, startDate, endDate) {
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();
  const calKey = Array.from(calendarIds).sort().join(',');
  const cacheKey = `gcal:${clientId}:${startIso.slice(0, 10)}:${endIso.slice(0, 10)}:${calKey}`;
  const redis = getAppRedis();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (_) {
      /* fall through */
    }
  }
  const results = await Promise.all(
    Array.from(calendarIds).map((calId) =>
      listEvents(startIso, endIso, calId).catch(() => [])
    )
  );
  if (redis) {
    try {
      await redis.setex(cacheKey, GCAL_CACHE_TTL_SEC, JSON.stringify(results));
    } catch (_) {
      /* non-fatal */
    }
  }
  return results;
}

/**
 * Increments daily statistics for a given client.
 */
async function trackEcommerceEvent(clientId, increments = {}, productAdditions = {}) {
  const today = new Date().toISOString().split('T')[0];

  try {
    const update = { $inc: increments };

    if (Object.keys(productAdditions).length > 0) {
      for (const [name, count] of Object.entries(productAdditions)) {
        update.$inc[`abandonedProducts.${name}`] = count;
      }
    }

    await DailyStat.findOneAndUpdate(
      { clientId, date: today },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`[AnalyticsHelper] Failed to track event for ${clientId}:`, err.message);
  }
}

/**
 * @returns {Promise<object>} Realtime dashboard stats (same shape as GET /api/analytics/realtime)
 */
async function getRealtimeStats(clientId, client, daysInput, options = {}) {
  const timer = options.timer || noopTimer();
  const { getStats } = require('../utils/statCacheEngine');
  const PixelEvent = require('../models/PixelEvent');
  const LinkClickEvent = require('../models/LinkClickEvent');
  const ConversationAssignment = require('../models/ConversationAssignment');

  const stats = await timer.time('getStats', () => getStats(clientId));
  if (!stats) {
    const err = new Error('Client not found or stats unavailable');
    err.statusCode = 404;
    throw err;
  }

  const clientDoc =
    client ||
    (await timer.time('getCachedClient', () =>
      getCachedClient(clientId, 'businessName name')
    ));

  const rawRealtimeDays = parseInt(daysInput, 10) || 1;
  const days = Math.min(Math.max(rawRealtimeDays, 1), MAX_LIVE_ANALYTICS_DAYS);
  const startDate = new Date();
  if (days > 1) {
    startDate.setDate(startDate.getDate() - (days - 1));
  }
  startDate.setHours(0, 0, 0, 0);
  timer.checkpoint('date_range_computed', { days });

  const dateGte = startDate.toISOString().split('T')[0];
  const dateLte = new Date().toISOString().split('T')[0];

  const realtimeParallel = await timeParallel(
    timer,
    {
      pixel_cart_count: () =>
        PixelEvent.countDocuments({
          clientId,
          eventName: { $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started'] },
          timestamp: { $gte: startDate },
        }),
      link_click_count: () =>
        LinkClickEvent.countDocuments({ clientId, timestamp: { $gte: startDate } }),
      daily_stat_flow_perf: () =>
        DailyStat.aggregate([
          { $match: { clientId, date: { $gte: dateGte, $lte: dateLte } } },
          {
            $group: {
              _id: null,
              flowsSent: { $sum: { $ifNull: ['$flowsSent', 0] } },
              flowsCompleted: { $sum: { $ifNull: ['$flowsCompleted', 0] } },
            },
          },
        ]),
      ad_lead_opt_status: () =>
        AdLead.aggregate([
          { $match: { clientId } },
          { $group: { _id: { $ifNull: ['$optStatus', 'unknown'] }, count: { $sum: 1 } } },
        ]),
      pixel_funnel_agg: () =>
        PixelEvent.aggregate([
          {
            $match: {
              clientId,
              timestamp: { $gte: startDate },
              eventName: {
                $in: [
                  'product_added_to_cart',
                  'add_to_cart',
                  'checkout_started',
                  'checkout_completed',
                ],
              },
            },
          },
          { $group: { _id: '$eventName', count: { $sum: 1 } } },
        ]),
      order_rto_risk: () =>
        Order.aggregate([
          { $match: { clientId, createdAt: { $gte: startDate } } },
          {
            $group: {
              _id: { $ifNull: ['$rtoRiskLevel', 'unknown'] },
              count: { $sum: 1 },
              gmv: { $sum: { $ifNull: ['$amount', 0] } },
            },
          },
        ]),
    },
    'realtime_parallel_1'
  );

  const realtimeCarts = realtimeParallel.pixel_cart_count;
  const realtimeClicks = realtimeParallel.link_click_count;
  const flowPerfAgg = realtimeParallel.daily_stat_flow_perf;
  const optStatusAgg = realtimeParallel.ad_lead_opt_status;
  const pixelFunnelAgg = realtimeParallel.pixel_funnel_agg;
  const rtoRiskAgg = realtimeParallel.order_rto_risk;

  const humanHandledAgg = await timer.time('ConversationAssignment.humanHandled', () =>
    ConversationAssignment.aggregate([
      { $match: { clientId, assignedAt: { $gte: startDate } } },
      { $group: { _id: '$conversationId' } },
      { $count: 'count' },
    ])
  );
  const humanHandled = humanHandledAgg[0]?.count || 0;

  const aiHandledAgg = await timer.time('Message.aiHandled', () =>
    Message.aggregate([
      { $match: { clientId, timestamp: { $gte: startDate }, direction: 'outgoing' } },
      { $group: { _id: '$conversationId' } },
      {
        $lookup: {
          from: 'conversationassignments',
          localField: '_id',
          foreignField: 'conversationId',
          pipeline: [{ $match: { assignedAt: { $gte: startDate } } }],
          as: 'assignments',
        },
      },
      { $match: { assignments: { $size: 0 } } },
      { $count: 'count' },
    ])
  );
  const aiHandled = aiHandledAgg[0]?.count || 0;

  const aiResRateAgg = await timer.time('Conversation.aiResolutionRate', () =>
    Conversation.aggregate([
      { $match: { clientId, resolvedAt: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalResolved: { $sum: 1 },
          aiResolved: { $sum: { $cond: [{ $not: ['$assignedTo'] }, 1, 0] } },
        },
      },
    ])
  );
  const resStats = aiResRateAgg[0] || { totalResolved: 0, aiResolved: 0 };
  const aiResolutionRate =
    resStats.totalResolved > 0 ? (resStats.aiResolved / resStats.totalResolved) * 100 : 0;

  timer.checkpoint('derived_metrics_compute');

  const flowPerf = flowPerfAgg[0] || { flowsSent: 0, flowsCompleted: 0 };
  const flowCompletionRate =
    flowPerf.flowsSent > 0 ? (flowPerf.flowsCompleted / flowPerf.flowsSent) * 100 : 0;

  const optMap = Object.fromEntries(
    optStatusAgg.map((r) => [String(r._id || 'unknown'), r.count || 0])
  );
  const totalOptLeads = Object.values(optMap).reduce((acc, n) => acc + n, 0);
  const optedInCount = optMap.opted_in || 0;
  const optedOutCount = optMap.opted_out || 0;
  const optInRate = totalOptLeads > 0 ? (optedInCount / totalOptLeads) * 100 : 0;

  const funnelMap = Object.fromEntries(pixelFunnelAgg.map((r) => [r._id, r.count || 0]));
  const addToCartCount = (funnelMap.add_to_cart || 0) + (funnelMap.product_added_to_cart || 0);
  const checkoutCompletedCount = funnelMap.checkout_completed || 0;
  const checkoutConversionRate =
    addToCartCount > 0 ? (checkoutCompletedCount / addToCartCount) * 100 : 0;

  const totalRiskOrders = rtoRiskAgg.reduce((acc, row) => acc + (row.count || 0), 0);
  const highRiskRow = rtoRiskAgg.find((row) => String(row._id || '').toLowerCase() === 'high');
  const highRiskOrders = highRiskRow?.count || 0;
  const highRiskGmv = highRiskRow?.gmv || 0;
  const highRiskShare = totalRiskOrders > 0 ? (highRiskOrders / totalRiskOrders) * 100 : 0;

  const attributionAgg = await timer.time('PixelEvent.attribution', () =>
    PixelEvent.aggregate([
      { $match: { clientId, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: {
            session: { $ifNull: ['$sessionId', '$ip'] },
            source: {
              $switch: {
                branches: [
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$url', ''] },
                        regex: /utm_source=(meta|facebook|ig|fb|instagram)/i,
                      },
                    },
                    then: 'Meta Ads',
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$url', ''] },
                        regex: /utm_source=(google|gads)/i,
                      },
                    },
                    then: 'Google Ads',
                  },
                ],
                default: 'Direct/Organic',
              },
            },
          },
        },
      },
      { $group: { _id: '$_id.source', count: { $sum: 1 } } },
      { $project: { source: '$_id', count: 1, _id: 0 } },
    ])
  );

  timer.checkpoint('response_build');
  return {
    businessName: clientDoc?.businessName || clientDoc?.name || clientId,
    leads: { total: stats.totalLeads, newToday: stats.leadsToday },
    orders: { count: stats.ordersToday, revenue: stats.revenueToday },
    linkClicks: realtimeClicks || stats.totalLinkClicks,
    agentRequests: humanHandled,
    aiHandled,
    humanHandled,
    addToCarts: realtimeCarts || stats.totalAddToCarts,
    checkouts: stats.totalCheckouts,
    abandonedCarts: stats.abandonedCarts,
    recoveredCarts: stats.recoveredCarts,
    abandonedCartSent: stats.abandonedCartSent,
    abandonedCartClicks: stats.abandonedCartClicks,
    funnel: {
      totalOrdersAllTime: stats.totalOrders,
      whatsappRecoveriesPurchased: stats.whatsappRecoveriesPurchased,
      adminFollowupsPurchased: stats.adminFollowupsPurchased,
    },
    attribution:
      attributionAgg.length > 0 ? attributionAgg : [{ source: 'Direct/Organic', count: 1 }],
    sentiment: stats.sentimentCounts || {
      Positive: 0,
      Neutral: 0,
      Negative: 0,
      Frustrated: 0,
      Urgent: 0,
      Unknown: 0,
    },
    enterprise: {
      aiResolutionRate,
      flowCompletionRate,
      checkoutConversionRate,
      optInRate,
      highRiskShare,
      highRiskGmv,
      counts: {
        aiHandled,
        humanHandled,
        flowsSent: flowPerf.flowsSent || 0,
        flowsCompleted: flowPerf.flowsCompleted || 0,
        addToCartCount,
        checkoutCompletedCount,
        optedInCount,
        optedOutCount,
        highRiskOrders,
        totalRiskOrders,
      },
    },
  };
}

/**
 * @returns {Promise<Array>} Top products array (same shape as GET /api/analytics/top-products)
 */
async function getTopProducts(clientId, options = {}) {
  const timer = options.timer || noopTimer();
  const query = { clientId };

  const topProducts = await timer.time('Order.aggregate_top_products', () =>
    Order.aggregate([
      { $match: query },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          totalSold: { $sum: '$items.quantity' },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
      {
        $project: {
          name: '$_id',
          revenue: '$totalRevenue',
          sold: '$totalSold',
          _id: 0,
        },
      },
    ])
  );

  if (topProducts.length > 0) {
    return topProducts;
  }

  return timer.time('Appointment.aggregate_top_services', () =>
    Appointment.aggregate([
      {
        $match: {
          ...query,
          status: { $ne: 'cancelled' },
          revenue: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$service',
          totalRevenue: { $sum: '$revenue' },
          totalSold: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
      {
        $project: {
          name: '$_id',
          revenue: '$totalRevenue',
          sold: '$totalSold',
          _id: 0,
        },
      },
    ])
  );
}

function resolveTimelineRange(range = {}) {
  let { start, end, days } = range;
  const endDate = end ? new Date(end) : new Date();
  const startDate = start ? new Date(start) : new Date();

  if (!start) {
    const rawDays = parseInt(days, 10) || 7;
    const effectiveDays = Math.min(Math.max(rawDays, 1), MAX_LIVE_ANALYTICS_DAYS);
    startDate.setDate(endDate.getDate() - effectiveDays);
  }

  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  const dates = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }
  return { startDate, endDate, dates };
}

/**
 * Phase 3 — read timeline from DailyStat rollup + live patch for today (+ optional GCal).
 */
async function getTimelineStatsFromRollup(clientId, client, ctx, options = {}) {
  const timer = options.timer || noopTimer();
  const { startDate, endDate, dates } = ctx;
  const today = todayDateStr();
  timer.checkpoint('rollup_read_path', { days_in_range: dates.length });

  let docs = await timer.time('DailyStat.find_rollup', () =>
    DailyStat.find({
      clientId,
      date: { $gte: dates[0], $lte: dates[dates.length - 1] },
    }).lean()
  );
  const byDate = new Map(docs.map((d) => [d.date, d]));

  const missing = dates.filter((d) => needsRollup(byDate.get(d), d, today));
  const toRoll = missing.slice(0, ON_DEMAND_ROLLUP_CAP);
  if (toRoll.length) {
    timer.checkpoint('rollup_on_demand_start', { count: toRoll.length });
    await rollupDaysForClient(clientId, toRoll, { timer });
    docs = await DailyStat.find({
      clientId,
      date: { $gte: dates[0], $lte: dates[dates.length - 1] },
    }).lean();
    docs.forEach((d) => byDate.set(d.date, d));
    timer.checkpoint('rollup_on_demand_done');
  }

  const clientDoc =
    client ||
    (await timer.time('getCachedClient', () =>
      getCachedClient(clientId, 'googleCalendarId config.calendars businessName name')
    ));

  const calendarIds = new Set();
  if (clientDoc?.googleCalendarId) calendarIds.add(clientDoc.googleCalendarId);
  if (clientDoc?.config?.calendars) {
    Object.values(clientDoc.config.calendars).forEach((id) => calendarIds.add(id));
  }
  const skipGcal = calendarIds.size === 0;

  const gcalCounts = {};
  if (!skipGcal) {
    const gcalResults = await timer.time('gcal_list_events', () =>
      fetchGcalEventsCached(clientId, calendarIds, startDate, endDate)
    );
    gcalResults.flat().forEach((event) => {
      const eventStart = event.start?.dateTime || event.start?.date;
      if (eventStart) {
        const dateStr = eventStart.split('T')[0];
        gcalCounts[dateStr] = (gcalCounts[dateStr] || 0) + 1;
      }
    });
  }

  let liveToday = null;
  if (dates.includes(today)) {
    liveToday = await timer.time('aggregateDayMetrics_today', () =>
      aggregateDayMetrics(clientId, today, { timer })
    );
  }

  const stats = dates.map((date) =>
    dailyStatToTimelineRow(date, byDate.get(date), gcalCounts[date] || 0, date === today ? liveToday : null)
  );
  timer.checkpoint('stats_merge_done', { rows: stats.length, path: 'rollup' });
  return stats;
}

/**
 * Full live aggregation path (1–2 day ranges by default).
 */
async function getTimelineStatsLive(clientId, client, ctx, options = {}) {
  const timer = options.timer || noopTimer();
  const clientIdQuery = { clientId };
  const PixelEvent = require('../models/PixelEvent');
  const LinkClickEvent = require('../models/LinkClickEvent');
  const ConversationAssignment = require('../models/ConversationAssignment');

  const { startDate, endDate, dates } = ctx;
  timer.checkpoint('date_range_computed', { days_in_range: dates.length, path: 'live' });

  const clientDoc =
    client ||
    (await timer.time('getCachedClient', () =>
      getCachedClient(clientId, 'googleCalendarId config.calendars businessName name')
    ));

  const calendarIds = new Set();
  if (clientDoc?.googleCalendarId) calendarIds.add(clientDoc.googleCalendarId);
  if (clientDoc?.config?.calendars) {
    Object.values(clientDoc.config.calendars).forEach((id) => calendarIds.add(id));
  }
  const skipGcal = calendarIds.size === 0;
  timer.checkpoint('calendar_ids_resolved', { count: calendarIds.size, skipGcal });

  const analyticsParallel = await timeParallel(
    timer,
    {
      gcal_list_events: () =>
        skipGcal
          ? Promise.resolve([])
          : fetchGcalEventsCached(clientId, calendarIds, startDate, endDate),
      message_conversation_activity: () =>
        Message.aggregate([
          { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
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
          { $match: { ...clientIdQuery, createdAt: { $gte: startDate, $lte: endDate } } },
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
          { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      daily_stat_find: () =>
        DailyStat.find({
          ...clientIdQuery,
          date: { $gte: dates[0], $lte: dates[dates.length - 1] },
        }),
      order_daily: () =>
        Order.aggregate([
          { $match: { ...clientIdQuery, createdAt: { $gte: startDate, $lte: endDate } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              count: { $sum: 1 },
              revenue: { $sum: '$amount' },
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
              timestamp: { $gte: startDate, $lte: endDate },
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
          { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              count: { $sum: 1 },
            },
          },
        ]),
      human_handled_daily: () =>
        ConversationAssignment.aggregate([
          { $match: { ...clientIdQuery, assignedAt: { $gte: startDate, $lte: endDate } } },
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
              timestamp: { $gte: startDate, $lte: endDate },
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
      pixel_attribution: () =>
        PixelEvent.aggregate([
          { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
          {
            $group: {
              _id: {
                session: { $ifNull: ['$sessionId', '$ip'] },
                source: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $regexMatch: {
                            input: { $ifNull: ['$url', ''] },
                            regex: /utm_source=(meta|facebook|ig|fb|instagram)/i,
                          },
                        },
                        then: 'Meta Ads',
                      },
                      {
                        case: {
                          $regexMatch: {
                            input: { $ifNull: ['$url', ''] },
                            regex: /utm_source=(google|gads)/i,
                          },
                        },
                        then: 'Google Ads',
                      },
                    ],
                    default: 'Direct/Organic',
                  },
                },
              },
            },
          },
          { $group: { _id: '$_id.source', count: { $sum: 1 } } },
          { $project: { source: '$_id', count: 1, _id: 0 } },
        ]),
    },
    'analytics_parallel'
  );

  const gcalResults = analyticsParallel.gcal_list_events;
  const conversationActivity = analyticsParallel.message_conversation_activity;
  const appointments = analyticsParallel.appointment_daily;
  const messages = analyticsParallel.message_daily;
  const reminderStats = analyticsParallel.daily_stat_find;
  const orders = analyticsParallel.order_daily;
  const cartEvents = analyticsParallel.pixel_cart_daily;
  const linkClickEvents = analyticsParallel.link_click_daily;
  const humanHandledAgg = analyticsParallel.human_handled_daily;
  const aiHandledAgg = analyticsParallel.ai_handled_daily;

  timer.checkpoint('gcal_flatten_start');
  const gcalCounts = {};
  const allEvents = gcalResults.flat();
  allEvents.forEach((event) => {
    const eventStart = event.start.dateTime || event.start.date;
    if (eventStart) {
      const dateStr = eventStart.split('T')[0];
      gcalCounts[dateStr] = (gcalCounts[dateStr] || 0) + 1;
    }
  });
  timer.checkpoint('gcal_flatten_done', { events: allEvents.length });

  const stats = dates.map((date) => {
    const convActivityForDay = conversationActivity.find((c) => c._id === date)?.count || 0;
    const chatCount = convActivityForDay;
    const userCount = convActivityForDay;
    const apptCount = gcalCounts[date] || 0;
    const msgCount = messages.find((c) => c._id === date)?.count || 0;
    const dayReminder = reminderStats.find((r) => r.date === date);
    const bdayCount = dayReminder?.birthdayRemindersSent || 0;
    const apptRemCount = dayReminder?.appointmentRemindersSent || 0;
    const dayOrder = orders.find((c) => c._id === date);
    const orderCount = dayOrder?.count || 0;
    const orderRevenue = dayOrder?.revenue || 0;
    const cartCount = cartEvents.find((c) => c._id === date)?.count || 0;
    const linkClickCount = linkClickEvents.find((c) => c._id === date)?.count || 0;
    const humanHandled = humanHandledAgg.find((c) => c._id === date)?.count || 0;
    const aiHandled = aiHandledAgg.find((c) => c._id === date)?.count || 0;
    const checkoutCount = dayReminder?.checkouts || 0;
    const abandonedCartSent = dayReminder?.abandonedCartSent || 0;
    const abandonedCartClicks = dayReminder?.abandonedCartClicks || 0;
    const recoveredViaStep1 = dayReminder?.recoveredViaStep1 || 0;
    const recoveredViaStep2 = dayReminder?.recoveredViaStep2 || 0;
    const recoveredViaStep3 = dayReminder?.recoveredViaStep3 || 0;
    const codNudgesSent = dayReminder?.codNudgesSent || 0;
    const rtoCostSaved = dayReminder?.rtoCostSaved || 0;
    const codConvertedRevenue = dayReminder?.codConvertedRevenue || 0;
    const codConvertedCount = dayReminder?.codConvertedCount || 0;
    const cartRevenueRecovered = dayReminder?.cartRevenueRecovered || 0;
    const flowsSent = dayReminder?.flowsSent || 0;
    const flowsCompleted = dayReminder?.flowsCompleted || 0;
    const browseAbandonedCount = dayReminder?.browseAbandonedCount || 0;
    const upsellSentCount = dayReminder?.upsellSentCount || 0;
    const upsellConvertedCount = dayReminder?.upsellConvertedCount || 0;
    const upsellRevenue = dayReminder?.upsellRevenue || 0;
    const marketingMessagesSent = dayReminder?.marketingMessagesSent || 0;
    const aiResolutionRateDay =
      humanHandled + aiHandled > 0 ? (aiHandled / (humanHandled + aiHandled)) * 100 : 0;
    const flowCompletionRateDay = flowsSent > 0 ? (flowsCompleted / flowsSent) * 100 : 0;

    const dayAppointment = appointments.find((c) => c._id === date);
    const apptRevenue = dayAppointment?.revenue || 0;
    const totalRevenue = orderRevenue + apptRevenue;

    return {
      date,
      totalChats: chatCount,
      uniqueUsers: userCount,
      appointmentsBooked: apptCount,
      totalMessagesExchanged: msgCount,
      birthdayRemindersSent: bdayCount,
      appointmentRemindersSent: apptRemCount,
      orders: orderCount,
      revenue: totalRevenue,
      apptRevenue,
      orderRevenue,
      addToCarts: cartCount,
      linkClicks: linkClickCount,
      humanHandled,
      aiHandled,
      agentRequests: humanHandled,
      checkouts: checkoutCount,
      abandonedCartSent,
      abandonedCartClicks,
      recoveredViaStep1,
      recoveredViaStep2,
      recoveredViaStep3,
      codNudgesSent,
      rtoCostSaved,
      codConvertedRevenue,
      codConvertedCount,
      cartRevenueRecovered,
      flowsSent,
      flowsCompleted,
      browseAbandonedCount,
      upsellSentCount,
      upsellConvertedCount,
      upsellRevenue,
      marketingMessagesSent,
      aiResolutionRate: Number(aiResolutionRateDay.toFixed(2)),
      flowCompletionRate: Number(flowCompletionRateDay.toFixed(2)),
    };
  });

  timer.checkpoint('stats_merge_done', { rows: stats.length, path: 'live' });
  return stats;
}

/**
 * @param {{ days?: number, start?: string, end?: string }} range
 * @returns {Promise<Array>} Timeline stats array (same shape as GET /api/analytics)
 */
async function getTimelineStats(clientId, client, range = {}, options = {}) {
  const timer = options.timer || noopTimer();
  const ctx = resolveTimelineRange(range);
  timer.checkpoint('timeline_route', {
    days: ctx.dates.length,
    rollup_threshold: TIMELINE_ROLLUP_MIN_DAYS,
  });
  if (ctx.dates.length >= TIMELINE_ROLLUP_MIN_DAYS) {
    return getTimelineStatsFromRollup(clientId, client, ctx, { ...options, timer });
  }
  return getTimelineStatsLive(clientId, client, ctx, { ...options, timer });
}

/**
 * @returns {Promise<{ success: boolean, operators: Array }>}
 */
async function getOperatorsStats(clientId, daysInput, options = {}) {
  const timer = options.timer || noopTimer();
  const User = require('../models/User');
  const ConversationAssignment = require('../models/ConversationAssignment');

  const dateLimit = new Date();
  if (daysInput && daysInput !== 'all') {
    dateLimit.setDate(dateLimit.getDate() - parseInt(daysInput, 10));
  } else {
    dateLimit.setFullYear(2000);
  }
  timer.checkpoint('date_limit_computed');

  const humanAgg = await timer.time('ConversationAssignment.humanAgg', () =>
    ConversationAssignment.aggregate([
      { $match: { clientId, assignedAt: { $gte: dateLimit } } },
      {
        $lookup: {
          from: 'conversations',
          localField: 'conversationId',
          foreignField: '_id',
          as: 'conv',
        },
      },
      { $unwind: '$conv' },
      {
        $group: {
          _id: '$assignedAgentId',
          currentOpenTickets: {
            $sum: {
              $cond: [{ $in: ['$conv.status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] }, 1, 0],
            },
          },
          ticketsSolved: { $sum: { $cond: [{ $eq: ['$conv.status', 'CLOSED'] }, 1, 0] } },
          pendingTickets: {
            $sum: { $cond: [{ $eq: ['$conv.status', 'WAITING_FOR_INPUT'] }, 1, 0] },
          },
          totalHandled: { $sum: 1 },
          totalResponseTime: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$conv.firstResponseAt', null] },
                    { $ne: ['$conv.firstInboundAt', null] },
                  ],
                },
                { $subtract: ['$conv.firstResponseAt', '$conv.firstInboundAt'] },
                0,
              ],
            },
          },
          countWithResponseTime: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$conv.firstResponseAt', null] },
                    { $ne: ['$conv.firstInboundAt', null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
  );

  const aiAgg = await timer.time('Conversation.aiAgg', () =>
    Conversation.aggregate([
      { $match: { clientId, updatedAt: { $gte: dateLimit }, assignedTo: null } },
      {
        $group: {
          _id: '__AI_BOT__',
          currentOpenTickets: {
            $sum: {
              $cond: [{ $in: ['$status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] }, 1, 0],
            },
          },
          ticketsSolved: { $sum: { $cond: [{ $eq: ['$status', 'CLOSED'] }, 1, 0] } },
          pendingTickets: {
            $sum: { $cond: [{ $eq: ['$status', 'WAITING_FOR_INPUT'] }, 1, 0] },
          },
          totalHandled: { $sum: 1 },
          avgResponseTimeMs: { $avg: { $subtract: ['$firstResponseAt', '$firstInboundAt'] } },
        },
      },
    ])
  );

  const allUsers = await timer.time('User.find', () =>
    User.find({ clientId }).select('name email').lean()
  );

  const agentMap = {};
  humanAgg.forEach((g) => {
    agentMap[String(g._id)] = {
      currentOpenTickets: g.currentOpenTickets,
      pendingTickets: g.pendingTickets,
      ticketsSolved: g.ticketsSolved,
      totalHandled: g.totalHandled,
      avgResponseTimeMs:
        g.countWithResponseTime > 0 ? g.totalResponseTime / g.countWithResponseTime : 0,
    };
  });

  let operators = allUsers.map((u) => {
    const agentStats = agentMap[String(u._id)] || {
      currentOpenTickets: 0,
      pendingTickets: 0,
      ticketsSolved: 0,
      totalHandled: 0,
      avgResponseTimeMs: 0,
    };

    return {
      agentId: String(u._id),
      agentName: u.name || 'Unknown Agent',
      agentEmail: u.email || '-',
      isBot: false,
      currentOpenTickets: agentStats.currentOpenTickets,
      pendingTickets: agentStats.pendingTickets,
      ticketsSolved: agentStats.ticketsSolved,
      totalHandled: agentStats.totalHandled,
      avgResponseTimeMs: Math.max(0, agentStats.avgResponseTimeMs),
    };
  });

  const ai = aiAgg[0] || {
    currentOpenTickets: 0,
    pendingTickets: 0,
    ticketsSolved: 0,
    totalHandled: 0,
    avgResponseTimeMs: 0,
  };
  operators.push({
    agentId: 'ai-bot',
    agentName: 'AI Bot',
    agentEmail: 'system@ai-bot',
    isBot: true,
    currentOpenTickets: ai.currentOpenTickets,
    pendingTickets: ai.pendingTickets,
    ticketsSolved: ai.ticketsSolved,
    totalHandled: ai.totalHandled,
    avgResponseTimeMs: Math.max(0, ai.avgResponseTimeMs || 0),
  });

  operators.sort((a, b) => {
    if (a.isBot && !b.isBot) return -1;
    if (!a.isBot && b.isBot) return 1;
    return b.ticketsSolved - a.ticketsSolved;
  });

  timer.checkpoint('operators_assembly_done', { count: operators.length });
  return { success: true, operators };
}

module.exports = {
  trackEcommerceEvent,
  MAX_LIVE_ANALYTICS_DAYS,
  TIMELINE_ROLLUP_MIN_DAYS,
  fetchGcalEventsCached,
  getRealtimeStats,
  getTopProducts,
  getTimelineStats,
  getTimelineStatsLive,
  getTimelineStatsFromRollup,
  getOperatorsStats,
};
