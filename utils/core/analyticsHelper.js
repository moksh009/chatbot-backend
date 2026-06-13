/**
 * Shared analytics data loaders — used by routes/analytics.js and dashboard summary.
 */
const DailyStat = require('../../models/DailyStat');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Appointment = require('../../models/Appointment');
const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const { listEvents } = require('./googleCalendar');
const { getCachedClient } = require('./clientCache');
const { getAppRedis } = require('./redisFactory');
const { timeParallel } = require('./perfLogger');

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
const {
  startOfDayForDateStrIST,
  endOfDayForDateStrIST,
  todayDateStrIST,
  istDateOffsetDays,
  istDateRangeStrings,
} = require('./queryHelpers');

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
  const today = todayDateStrIST();

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
  const { getStats } = require('./statCacheEngine');
  const PixelEvent = require('../../models/PixelEvent');
  const LinkClickEvent = require('../../models/LinkClickEvent');
  const ConversationAssignment = require('../../models/ConversationAssignment');

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
  const { start: dateGte, end: dateLte } = istDateRangeStrings(days);
  const startDate = startOfDayForDateStrIST(dateGte);
  const endDate = endOfDayForDateStrIST(dateLte);
  timer.checkpoint('date_range_computed', { days, dateGte, dateLte });

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
    linkClicks: realtimeClicks,
    unitsSold: stats.unitsSoldToday || 0,
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
    attribution: attributionAgg,
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

function resolveProductImage(name, productId, catalogById, catalogByTitle) {
  if (productId && catalogById.has(String(productId))) {
    return catalogById.get(String(productId));
  }
  const key = (name || '').toLowerCase().trim();
  if (!key) return null;
  if (catalogByTitle.has(key)) return catalogByTitle.get(key);
  for (const [title, url] of catalogByTitle) {
    if (title.includes(key) || key.includes(title)) return url;
  }
  return null;
}

async function enrichTopProductsWithShopifyImages(clientId, products, timer) {
  if (!products?.length) return products;
  const ShopifyProduct = require('../../models/ShopifyProduct');
  const catalog = await (timer || noopTimer()).time('ShopifyProduct.find_catalog', () =>
    ShopifyProduct.find({ clientId })
      .select('shopifyProductId title imageUrl')
      .limit(2000)
      .lean()
  );
  const catalogById = new Map();
  const catalogByTitle = new Map();
  catalog.forEach((p) => {
    if (p.shopifyProductId && p.imageUrl) {
      catalogById.set(String(p.shopifyProductId), p.imageUrl);
    }
    if (p.title && p.imageUrl) {
      catalogByTitle.set(p.title.toLowerCase().trim(), p.imageUrl);
    }
  });

  return products.map((p) => {
    const fromOrder = p.image && String(p.image).trim() ? p.image : null;
    const image =
      fromOrder ||
      resolveProductImage(p.name, p.productId, catalogById, catalogByTitle) ||
      null;
    return { ...p, image };
  });
}

async function aggregateTopProductsFromOrders(clientId, match, limit = 8) {
  const orders = await Order.find(match)
    .select('items orderNumber orderId totalPrice amount')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const map = new Map();
  for (const order of orders) {
    const items = (Array.isArray(order.items) ? order.items : []).filter(
      (item) => item && String(item.name || item.title || '').trim()
    );

    if (items.length === 0) {
      const rev = Number(order.totalPrice ?? order.amount) || 0;
      if (rev <= 0) continue;
      const name = order.orderNumber
        ? `Order #${order.orderNumber}`
        : `Order ${order.orderId || 'purchase'}`;
      const prev = map.get(name) || { name, revenue: 0, sold: 0, image: '', productId: '' };
      prev.revenue += rev;
      prev.sold += 1;
      map.set(name, prev);
      continue;
    }

    for (const item of items) {
      const name = String(item.name || item.title || '').trim();
      const qty = Math.max(1, Number(item.quantity) || 1);
      const price = Number(item.price) || 0;
      const key = `${name}::${item.productId || ''}`;
      const prev = map.get(key) || {
        name,
        productId: item.productId || '',
        revenue: 0,
        sold: 0,
        image: item.image || '',
      };
      prev.revenue += price * qty;
      prev.sold += qty;
      if (!prev.image && item.image) prev.image = item.image;
      map.set(key, prev);
    }
  }

  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

/**
 * @returns {Promise<Array>} Top products array (same shape as GET /api/analytics/top-products)
 */
async function getTopProducts(clientId, options = {}) {
  const timer = options.timer || noopTimer();
  const { buildAnalyticsPeriodOrderMatch } = require('../commerce/customerOrderMetrics');
  const rangeDays = options.days;
  let match = buildAnalyticsPeriodOrderMatch(clientId);
  if (options.startDate && options.endDate) {
    match = buildAnalyticsPeriodOrderMatch(clientId, {
      createdAt: { $gte: options.startDate, $lte: options.endDate },
    });
  } else if (rangeDays && Number(rangeDays) > 0) {
    const { start } = istDateRangeStrings(Number(rangeDays));
    const startDate = startOfDayForDateStrIST(start);
    match = buildAnalyticsPeriodOrderMatch(clientId, { createdAt: { $gte: startDate } });
  }

  const rowLimit = options.limit != null ? Number(options.limit) : 0;
  const limitStage = rowLimit > 0 ? [{ $limit: rowLimit }] : [];

  const topProducts = await timer.time('Order.aggregate_top_products', () =>
    Order.aggregate([
      { $match: match },
      { $unwind: { path: '$items', preserveNullAndEmptyArrays: false } },
      { $match: { 'items.name': { $exists: true, $nin: [null, ''] } } },
      {
        $group: {
          _id: {
            name: '$items.name',
            productId: { $ifNull: ['$items.productId', ''] },
          },
          totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          totalSold: { $sum: '$items.quantity' },
          image: { $first: { $ifNull: ['$items.image', ''] } },
        },
      },
      { $sort: { totalRevenue: -1 } },
      ...limitStage,
      {
        $project: {
          name: '$_id.name',
          productId: '$_id.productId',
          revenue: '$totalRevenue',
          sold: '$totalSold',
          image: 1,
          _id: 0,
        },
      },
    ])
  );

  if (topProducts.length > 0) {
    return enrichTopProductsWithShopifyImages(clientId, topProducts, timer);
  }

  const fallbackLimit = rowLimit > 0 ? rowLimit : 8;
  const fallbackProducts = await timer.time('Order.fallback_top_products', () =>
    aggregateTopProductsFromOrders(clientId, match, fallbackLimit)
  );
  if (fallbackProducts.length > 0) {
    return enrichTopProductsWithShopifyImages(clientId, fallbackProducts, timer);
  }

  const apptProducts = await timer.time('Appointment.aggregate_top_services', () =>
    Appointment.aggregate([
      {
        $match: {
          clientId,
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
      ...limitStage,
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
  return enrichTopProductsWithShopifyImages(clientId, apptProducts, timer);
}

const {
  buildNeedsHumanHelpQuery,
  fetchOpenSupportConversations,
  capResponseTimeMs,
  medianMs,
} = require('./supportConversationMetrics');

/**
 * Live WhatsApp threads needing human support (dashboard queue — aligned with Live Chat).
 */
async function getHumanQueueConversations(clientId, options = {}) {
  const timer = options.timer || noopTimer();
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 200);
  return timer.time('Conversation.humanQueue', () =>
    fetchOpenSupportConversations(clientId, { limit })
  );
}

/**
 * Average response time from escalation to first agent message (per agent).
 */
async function getAgentEscalationResponseMap(clientId, startDate, endDate) {
  const { MAX_AGENT_RESPONSE_MS: maxResponseMs } = require('./supportConversationMetrics');
  const rows = await Message.aggregate([
    {
      $match: {
        clientId,
        direction: 'outgoing',
        agentId: { $exists: true, $ne: null },
      },
    },
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
      $match: {
        'conv.escalationRequestedAt': { $gte: startDate, $lte: endDate, $ne: null },
        $expr: { $gt: ['$timestamp', '$conv.escalationRequestedAt'] },
      },
    },
    { $sort: { timestamp: 1 } },
    {
      $group: {
        _id: { conversationId: '$conversationId', agentId: '$agentId' },
        firstReply: { $first: '$timestamp' },
        escalationAt: { $first: '$conv.escalationRequestedAt' },
      },
    },
    {
      $addFields: {
        responseMs: { $subtract: ['$firstReply', '$escalationAt'] },
      },
    },
    {
      $match: {
        responseMs: { $gte: 0, $lte: maxResponseMs },
      },
    },
    {
      $group: {
        _id: '$_id.agentId',
        samples: { $push: '$responseMs' },
        conversationCount: { $sum: 1 },
      },
    },
  ]);
  const map = {};
  rows.forEach((r) => {
    const med = medianMs(r.samples);
    map[String(r._id)] = {
      avgResponseTimeMs: med != null ? capResponseTimeMs(med) : null,
      escalationPairs: r.conversationCount || 0,
    };
  });
  return map;
}

function resolveTimelineRange(range = {}) {
  let { start, end, days } = range;
  const endDateStr = end
    ? (typeof end === 'string' ? end.slice(0, 10) : todayDateStrIST())
    : todayDateStrIST();
  const endDate = endOfDayForDateStrIST(endDateStr);

  let startDateStr;
  if (start) {
    startDateStr = typeof start === 'string' ? start.slice(0, 10) : endDateStr;
  } else {
    const rawDays = parseInt(days, 10) || 7;
    const effectiveDays = Math.min(Math.max(rawDays, 1), MAX_LIVE_ANALYTICS_DAYS);
    startDateStr = istDateOffsetDays(endDateStr, -(effectiveDays - 1));
  }

  const startDate = startOfDayForDateStrIST(startDateStr);
  const dates = [];
  let cursor = startDateStr;
  while (cursor <= endDateStr) {
    dates.push(cursor);
    cursor = istDateOffsetDays(cursor, 1);
  }
  return { startDate, endDate, dates };
}

/**
 * Live per-day commerce overlays — reconciles stale DailyStat rows with Orders / pixels / link taps.
 */
async function fetchCommerceDailyOverlays(clientId, startDate, endDate) {
  const PixelEvent = require('../../models/PixelEvent');
  const LinkClickEvent = require('../../models/LinkClickEvent');
  const { buildSuccessfulOrderMatch } = require('../commerce/customerOrderMetrics');
  const clientIdQuery = { clientId };

  const [orders, cartEvents, linkClickEvents] = await Promise.all([
    Order.aggregate([
      {
        $match: buildSuccessfulOrderMatch(clientId, {
          createdAt: { $gte: startDate, $lte: endDate },
        }),
      },
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
    ]).option({ maxTimeMS: 12_000 }),
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
    ]).option({ maxTimeMS: 10_000 }),
    LinkClickEvent.aggregate([
      { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: 10_000 }),
  ]);

  return {
    ordersByDate: new Map(orders.map((row) => [row._id, row])),
    cartsByDate: new Map(cartEvents.map((row) => [row._id, row.count || 0])),
    linksByDate: new Map(linkClickEvents.map((row) => [row._id, row.count || 0])),
  };
}

function mergeCommerceOverlayIntoTimelineRow(row, overlays) {
  if (!row || !overlays) return row;
  const dayOrder = overlays.ordersByDate.get(row.date);
  const liveOrders = dayOrder?.count || 0;
  const liveRevenue = dayOrder?.revenue || 0;
  const liveUnits = dayOrder?.units || 0;
  const liveCarts = overlays.cartsByDate.get(row.date) || 0;
  const liveLinks = overlays.linksByDate.get(row.date) || 0;

  const orders = Math.max(Number(row.orders) || 0, liveOrders);
  const orderRevenue = Math.max(Number(row.orderRevenue) || 0, liveRevenue);
  const unitsSold = Math.max(Number(row.unitsSold) || 0, liveUnits);
  const addToCarts = Math.max(Number(row.addToCarts) || 0, liveCarts);
  const linkClicks = Math.max(Number(row.linkClicks) || 0, liveLinks);
  const apptRevenue = Number(row.apptRevenue) || 0;
  const revenue = Math.max(Number(row.revenue) || 0, orderRevenue + apptRevenue);

  return {
    ...row,
    orders,
    orderRevenue,
    unitsSold,
    addToCarts,
    linkClicks,
    revenue,
  };
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

  let stats = dates.map((date) =>
    dailyStatToTimelineRow(date, byDate.get(date), gcalCounts[date] || 0, date === today ? liveToday : null)
  );

  const overlays = await timer.time('commerce_daily_overlay', () =>
    fetchCommerceDailyOverlays(clientId, startDate, endDate)
  );
  stats = stats.map((row) => mergeCommerceOverlayIntoTimelineRow(row, overlays));

  timer.checkpoint('stats_merge_done', { rows: stats.length, path: 'rollup' });
  return stats;
}

/**
 * Full live aggregation path (1–2 day ranges by default).
 */
async function getTimelineStatsLive(clientId, client, ctx, options = {}) {
  const timer = options.timer || noopTimer();
  const clientIdQuery = { clientId };
  const PixelEvent = require('../../models/PixelEvent');
  const LinkClickEvent = require('../../models/LinkClickEvent');
  const ConversationAssignment = require('../../models/ConversationAssignment');

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
      order_daily: () => {
        const { buildSuccessfulOrderMatch } = require('../commerce/customerOrderMetrics');
        return Order.aggregate([
          {
            $match: buildSuccessfulOrderMatch(clientId, {
              createdAt: { $gte: startDate, $lte: endDate },
            }),
          },
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
        ]);
      },
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
    const unitsSold = dayOrder?.units || 0;
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
      unitsSold,
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
 * @returns {Promise<{ success: boolean, operators: Array, teamAvgResponseTimeMs: number|null }>}
 */
async function getOperatorsStats(clientId, daysInput, options = {}) {
  const timer = options.timer || noopTimer();
  const User = require('../../models/User');
  const ConversationAssignment = require('../../models/ConversationAssignment');

  let startDate;
  let endDate;
  if (options.startDate && options.endDate) {
    startDate = options.startDate;
    endDate = options.endDate;
  } else {
    const endDateStr = todayDateStrIST();
    endDate = endOfDayForDateStrIST(endDateStr);
    let startDateStr = endDateStr;
    if (daysInput && daysInput !== 'all') {
      const n = Math.min(Math.max(parseInt(daysInput, 10) || 1, 1), MAX_LIVE_ANALYTICS_DAYS);
      startDateStr = istDateOffsetDays(endDateStr, -(n - 1));
    } else {
      startDateStr = '2000-01-01';
    }
    startDate = startOfDayForDateStrIST(startDateStr);
  }
  timer.checkpoint('date_limit_computed');

  const [handledAgg, solvedAgg, openList, aiAgg, teamUsers, responseMap] = await Promise.all([
    timer.time('ConversationAssignment.handledDistinct', () =>
      ConversationAssignment.aggregate([
        { $match: { clientId, assignedAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: { agentId: '$assignedAgentId', conversationId: '$conversationId' },
          },
        },
        { $group: { _id: '$_id.agentId', totalHandled: { $sum: 1 } } },
      ])
    ),
    timer.time('Conversation.solvedByAgent', () =>
      Conversation.aggregate([
        {
          $match: {
            clientId,
            resolvedAt: { $gte: startDate, $lte: endDate, $ne: null },
            assignedTo: { $exists: true, $ne: null },
          },
        },
        { $group: { _id: '$assignedTo', ticketsSolved: { $sum: 1 } } },
      ])
    ),
    fetchOpenSupportConversations(clientId, { limit: 200 }),
    timer.time('Conversation.aiMetrics', () =>
      Conversation.aggregate([
        {
          $match: {
            clientId,
            updatedAt: { $gte: startDate, $lte: endDate },
            $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }],
          },
        },
        {
          $group: {
            _id: null,
            totalHandled: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $in: ['$status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] },
                      { $eq: ['$requiresAttention', true] },
                      { $eq: ['$botStatus', 'paused'] },
                      { $ne: ['$resolvedAt', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            ticketsSolved: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$resolvedAt', null] },
                      { $gte: ['$resolvedAt', startDate] },
                      { $lte: ['$resolvedAt', endDate] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            currentOpenTickets: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $in: ['$status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] },
                      { $eq: ['$requiresAttention', true] },
                      { $eq: ['$botStatus', 'paused'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            pendingTickets: {
              $sum: { $cond: [{ $eq: ['$status', 'WAITING_FOR_INPUT'] }, 1, 0] },
            },
          },
        },
      ])
    ),
    timer.time('User.find_team', () =>
      User.find({ clientId, role: { $in: ['CLIENT_ADMIN', 'AGENT'] } })
        .select('name email role')
        .lean()
    ),
    getAgentEscalationResponseMap(clientId, startDate, endDate),
  ]);

  const handledMap = {};
  handledAgg.forEach((g) => {
    handledMap[String(g._id)] = g.totalHandled || 0;
  });
  const solvedMap = {};
  solvedAgg.forEach((g) => {
    solvedMap[String(g._id)] = g.ticketsSolved || 0;
  });
  const openMap = {};
  (openList || []).forEach((c) => {
    const agentId = c.assignedTo?._id ? String(c.assignedTo._id) : 'unassigned';
    openMap[agentId] = (openMap[agentId] || 0) + 1;
  });

  let filteredTeam = teamUsers;
  if (options.agentIdFilter) {
    const fid = String(options.agentIdFilter);
    filteredTeam = teamUsers.filter((u) => String(u._id) === fid);
  }

  let operators = filteredTeam.map((u) => {
    const agentId = String(u._id);
    const rt = responseMap[agentId];
    const pairs = rt?.escalationPairs || 0;
    return {
      agentId,
      agentName: u.name || 'Unknown Agent',
      agentEmail: u.email || '-',
      isBot: false,
      currentOpenTickets: openMap[agentId] || 0,
      unassignedOpenTickets: openMap.unassigned || 0,
      pendingTickets: 0,
      ticketsSolved: solvedMap[agentId] || 0,
      totalHandled: handledMap[agentId] || 0,
      avgResponseTimeMs: pairs > 0 ? rt.avgResponseTimeMs : null,
      escalationPairs: pairs,
    };
  });

  const unassignedOpen = (openList || []).filter((c) => !c.assignedTo).length;
  const ai = aiAgg[0] || {
    pendingTickets: 0,
    ticketsSolved: 0,
    totalHandled: 0,
  };
  operators.push({
    agentId: 'ai-bot',
    agentName: 'AI Bot',
    agentEmail: 'system@ai-bot',
    isBot: true,
    currentOpenTickets: unassignedOpen,
    pendingTickets: ai.pendingTickets,
    ticketsSolved: ai.ticketsSolved,
    totalHandled: ai.totalHandled,
    avgResponseTimeMs: null,
    escalationPairs: 0,
  });

  operators.sort((a, b) => {
    if (a.isBot && !b.isBot) return 1;
    if (!a.isBot && b.isBot) return -1;
    return b.totalHandled - a.totalHandled;
  });

  const humans = operators.filter((o) => !o.isBot);
  const withRt = humans.filter((o) => o.escalationPairs > 0);
  const rtSamples = withRt
    .map((o) => o.avgResponseTimeMs)
    .filter((v) => v != null && Number.isFinite(v) && v > 0);
  const teamAvgResponseTimeMs = rtSamples.length ? medianMs(rtSamples) : null;

  timer.checkpoint('operators_assembly_done', { count: operators.length });
  return { success: true, operators, teamAvgResponseTimeMs };
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
  getHumanQueueConversations,
  getAgentEscalationResponseMap,
};
