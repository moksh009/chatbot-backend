'use strict';

const AdLead = require('../../models/AdLead');
const DailyStat = require('../../models/DailyStat');
const Order = require('../../models/Order');
const { getCachedClient } = require('../core/clientCache');
const {
  MAX_LIVE_ANALYTICS_DAYS,
  getRealtimeStats,
  getTopProducts,
} = require('../core/analyticsHelper');
const { buildCommercePeriodKpis, mergeRealtimeWithPeriodKpis } = require('../core/commercePeriodKpis');
const { fetchLeadsAnalyticsBundle } = require('../commerce/leadsAnalyticsFacet');
const { istDateRangeStrings, startOfDayForDateStrIST } = require('../core/queryHelpers');

function maskPhoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 4) return `••••${d}`;
  return `•••• ${d.slice(-4)}`;
}

function periodTokenToDays(period) {
  const p = String(period || '30d').toLowerCase();
  if (p === 'today' || p === '1d') return 1;
  if (p === '7d') return 7;
  if (p === '90d') return 90;
  return 30;
}

function daysToOptinPeriod(days) {
  const n = Number(days);
  if (n === 1) return 'today';
  if (n === 7) return '7d';
  if (n === 999 || n >= 90) return '90d';
  return '30d';
}

function daysToCartWorkspacePeriod(days) {
  return daysToOptinPeriod(days);
}

async function buildRealtimeSection(clientId, days) {
  const client = await getCachedClient(clientId, 'businessName name');
  const rawDays = parseInt(days, 10) || 30;
  const apiDays = Math.min(Math.max(rawDays === 999 ? 90 : rawDays, 1), MAX_LIVE_ANALYTICS_DAYS);
  let payload = await getRealtimeStats(clientId, client, apiDays);
  try {
    const periodKpis = await buildCommercePeriodKpis({ clientId, days: apiDays });
    payload = mergeRealtimeWithPeriodKpis(payload, periodKpis);
  } catch (_) {
    /* non-fatal */
  }
  return payload;
}

async function buildOverviewSection(clientId, query) {
  const { getAnalyticsOverviewBundle } = require('../core/analyticsOverviewBundle');
  const payload = await getAnalyticsOverviewBundle(clientId, query);
  return { success: true, ...payload };
}

async function buildTopProductsSection(clientId, days) {
  const apiDays = parseInt(days, 10) === 999 ? 90 : parseInt(days, 10) || 30;
  const rows = await getTopProducts(clientId, { days: apiDays });
  return Array.isArray(rows) ? rows.slice(0, 8) : [];
}

async function buildTopLeadsSection(clientId, limit = 5) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 200);
  const leads = await AdLead.aggregate([
    { $match: { clientId, leadScore: { $gte: 60 } } },
    {
      $lookup: {
        from: 'appointments',
        let: { phoneNo: '$phoneNumber', cId: '$clientId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$phone', '$$phoneNo'] }, { $eq: ['$clientId', '$$cId'] }],
              },
            },
          },
          { $group: { _id: null, apptRevenue: { $sum: '$revenue' }, apptCount: { $sum: 1 } } },
        ],
        as: 'apptData',
      },
    },
    { $addFields: { apptStats: { $arrayElemAt: ['$apptData', 0] } } },
    {
      $addFields: {
        computedTotalSpent: {
          $add: [{ $ifNull: ['$totalSpent', 0] }, { $ifNull: ['$apptStats.apptRevenue', 0] }],
        },
        computedOrdersCount: {
          $add: [{ $ifNull: ['$ordersCount', 0] }, { $ifNull: ['$apptStats.apptCount', 0] }],
        },
      },
    },
    { $sort: { computedTotalSpent: -1, leadScore: -1 } },
    { $limit: capped },
    {
      $project: {
        name: 1,
        phoneNumber: 1,
        leadScore: 1,
        tags: 1,
        lastInteraction: 1,
        ordersCount: '$computedOrdersCount',
        totalSpent: '$computedTotalSpent',
      },
    },
  ]);
  return { success: true, leads, limit: capped };
}

async function buildLeadsSummarySection(clientId, periodDays) {
  const payload = await fetchLeadsAnalyticsBundle(clientId, {
    page: 1,
    limit: 1,
    periodDays: periodDays ? parseInt(periodDays, 10) : undefined,
  });
  return {
    totalLeads: payload?.totalLeads ?? 0,
    summary: payload?.summary ?? {
      activeToday: 0,
      activeInPeriod: 0,
      withConversation: 0,
      highEngagement: 0,
    },
  };
}

async function buildOptinOverviewSection(clientId, period) {
  const days = periodTokenToDays(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [statusAgg, sourceAgg, trendAgg, recent] = await Promise.all([
    AdLead.aggregate([
      { $match: { clientId } },
      {
        $addFields: {
          normalizedOptStatus: {
            $switch: {
              branches: [
                { case: { $eq: ['$optStatus', 'opted_out'] }, then: 'opted_out' },
                { case: { $eq: ['$optStatus', 'pending'] }, then: 'pending' },
              ],
              default: 'opted_in',
            },
          },
        },
      },
      { $group: { _id: '$normalizedOptStatus', count: { $sum: 1 } } },
    ]),
    AdLead.aggregate([
      { $match: { clientId, optStatus: 'opted_in' } },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $eq: ['$optInSource', null] },
                  { $eq: ['$optInSource', ''] },
                  { $eq: ['$optInSource', 'unknown'] },
                ],
              },
              'unknown',
              '$optInSource',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    AdLead.aggregate([
      { $match: { clientId, optStatus: 'opted_in', optInDate: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$optInDate' } },
          newOptIns: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    AdLead.find({ clientId, optStatus: { $in: ['opted_in', 'pending', 'opted_out'] } })
      .sort({ optInDate: -1, updatedAt: -1 })
      .limit(12)
      .select('name optInSource optStatus optInDate updatedAt phoneNumber')
      .lean(),
  ]);

  const map = {};
  statusAgg.forEach((x) => {
    map[x._id || 'opted_in'] = x.count;
  });
  const totalLeads = Object.values(map).reduce((a, b) => a + b, 0);
  const optedIn = (map.opted_in || 0) + (map.unknown || 0);
  const unknown = map.unknown || 0;
  const optedOut = map.opted_out || 0;
  const pending = map.pending || 0;
  const effectiveTotal = totalLeads || optedIn + optedOut + pending;
  const optInRate = effectiveTotal > 0 ? Number(((optedIn / effectiveTotal) * 100).toFixed(1)) : 0;

  const trendMap = {};
  trendAgg.forEach((x) => {
    trendMap[x._id] = x.newOptIns;
  });
  const filledTrend = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    filledTrend.push({ date: key, newOptIns: trendMap[key] || 0 });
  }

  return {
    success: true,
    periodDays: days,
    totalLeads,
    optedIn,
    unknown,
    optedOut,
    pending,
    optInRate,
    bySource: sourceAgg.map((x) => ({ source: x._id || 'unknown', count: x.count })),
    trend: filledTrend,
    recentOptIns: recent.map((x) => ({
      name: x.name || 'Customer',
      phoneMasked: maskPhoneDigits(x.phoneNumber),
      source: x.optInSource || 'unknown',
      status: x.optStatus || 'unknown',
      timestamp: x.optInDate || x.updatedAt || null,
    })),
  };
}

async function buildAbandonedProductsSection(clientId, days) {
  const apiDays = parseInt(days, 10) || 30;
  const { start: startDateStr } = istDateRangeStrings(apiDays);

  const stats = await DailyStat.find({
    clientId,
    date: { $gte: startDateStr },
  }).lean();

  const productMap = {};
  for (const stat of stats) {
    const abandoned = stat.abandonedProducts;
    if (!abandoned) continue;
    const entries =
      abandoned instanceof Map
        ? abandoned.entries()
        : Object.entries(typeof abandoned === 'object' ? abandoned : {});
    for (const [product, count] of entries) {
      productMap[product] = (productMap[product] || 0) + Number(count) || 0;
    }
  }

  if (Object.keys(productMap).length === 0) {
    const rangeStart = startOfDayForDateStrIST(startDateStr);
    const leads = await AdLead.find({
      clientId,
      cartStatus: { $in: ['abandoned', 'active', 'checkout_started'] },
      isOrderPlaced: { $ne: true },
      $or: [
        { cartAbandonedAt: { $gte: rangeStart } },
        { lastInteraction: { $gte: rangeStart } },
        { updatedAt: { $gte: rangeStart } },
      ],
    })
      .select('cartItems lineItems cartSnapshot cartValue cartStatus')
      .limit(500)
      .lean();

    for (const lead of leads) {
      if (lead.cartStatus === 'recovered' || lead.cartStatus === 'purchased') continue;
      const snap = lead.cartSnapshot || {};
      const raw = Array.isArray(snap.items) ? snap.items : [];
      if (raw.length) {
        raw.forEach((item) => {
          const title = item.title || item.name || item.product_title || null;
          if (!title) return;
          const qty = Number(item.quantity || item.qty || 1) || 1;
          productMap[title] = (productMap[title] || 0) + qty;
        });
        continue;
      }
      const legacyItems = Array.isArray(lead.cartItems)
        ? lead.cartItems
        : Array.isArray(lead.lineItems)
          ? lead.lineItems
          : [];
      legacyItems.forEach((item) => {
        const name = item?.title || item?.name || item?.product_title || item?.productTitle || null;
        if (!name) return;
        const qty = Number(item?.quantity || item?.qty) || 1;
        productMap[name] = (productMap[name] || 0) + qty;
      });
    }
  }

  const productNames = Object.keys(productMap);
  const recentOrders = await Order.find({
    clientId,
    'items.name': { $in: productNames },
  })
    .select('items')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const imageMap = {};
  recentOrders.forEach((order) => {
    order.items.forEach((item) => {
      if (item.image && !imageMap[item.name]) imageMap[item.name] = item.image;
    });
  });

  return Object.entries(productMap)
    .map(([name, count]) => ({
      name,
      value: count,
      image: imageMap[name] || null,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

module.exports = {
  buildOverviewSection,
  buildRealtimeSection,
  buildTopProductsSection,
  buildTopLeadsSection,
  buildLeadsSummarySection,
  buildOptinOverviewSection,
  buildAbandonedProductsSection,
  daysToOptinPeriod,
  daysToCartWorkspacePeriod,
};
