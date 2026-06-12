'use strict';

const Conversation = require('../../models/Conversation');
const AdLead = require('../../models/AdLead');
const Appointment = require('../../models/Appointment');
const Order = require('../../models/Order');
const { getTimelineStats } = require('./analyticsHelper');
const { getCachedClient } = require('./clientCache');
const { buildCommercePeriodKpis } = require('./commercePeriodKpis');

/**
 * Bounded insights for analytics page (Phase 8 — no full-collection scans).
 */
async function getBoundedInsights(clientId, { startDate, endDate } = {}) {
  const {
    calculateAverageLTV,
    calculateAverageOrderValue,
    calculateAnalyticsPeriodMetrics,
  } = require('../commerce/customerOrderMetrics');

  const dateMatch = {};
  if (startDate) dateMatch.$gte = startDate;
  if (endDate) dateMatch.$lte = endDate;

  const apptQuery = { clientId, ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}) };
  const orderQuery = { clientId, ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}) };
  const leadQuery = { clientId };
  if (startDate) {
    leadQuery.$or = [{ createdAt: dateMatch }, { lastSeen: dateMatch }];
  }

  const [appts, orders, leads, avgLTVStrict, avgOrderValueStrict, periodCommerce] = await Promise.all([
    Appointment.find(apptQuery).select('createdAt phone revenue').limit(5000).lean(),
    Order.find(orderQuery).select('createdAt amount totalPrice phone customerPhone').limit(5000).lean(),
    AdLead.find(leadQuery)
      .select('createdAt lastSeen ordersCount addToCartCount phoneNumber checkoutInitiatedCount cartStatus')
      .limit(5000)
      .lean(),
    calculateAverageLTV(clientId, startDate, endDate),
    calculateAverageOrderValue(clientId, startDate, endDate),
    calculateAnalyticsPeriodMetrics(clientId, startDate, endDate),
  ]);

  const avgLTV = periodCommerce.avgLTV > 0 ? periodCommerce.avgLTV : avgLTVStrict;
  const avgOrderValue =
    periodCommerce.avgOrderValue > 0 ? periodCommerce.avgOrderValue : avgOrderValueStrict;

  const heatmap = {};
  const addToMap = (dateStr) => {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return;
    const key = `${d.getDay()}_${d.getHours()}`;
    heatmap[key] = (heatmap[key] || 0) + 1;
  };

  appts.forEach((a) => addToMap(a.createdAt));
  orders.forEach((o) => addToMap(o.createdAt));
  leads.forEach((l) => {
    if (l.lastSeen) addToMap(l.lastSeen);
  });

  let returning = 0;
  let newLeads = 0;
  leads.forEach((l) => {
    if ((l.ordersCount || 0) > 1) returning++;
    else newLeads++;
  });

  let totalRev = 0;
  appts.forEach((a) => {
    if (a.revenue > 0) totalRev += a.revenue;
  });
  orders.forEach((o) => {
    const rev = Number(o.totalPrice ?? o.amount ?? 0) || 0;
    if (rev > 0) totalRev += rev;
  });

  return {
    heatmap,
    returningLeads: returning,
    newLeads,
    avgOrderValue: Math.round(avgOrderValue * 100) / 100,
    avgLTV: Math.round(avgLTV * 100) / 100,
    periodOrderCount: periodCommerce.orderCount || 0,
    periodRevenue: periodCommerce.totalRevenue || 0,
    totalRevenueGlobally: totalRev,
  };
}

/**
 * Single bundle for Analytics.jsx first paint (replaces 5+ parallel calls).
 */
async function getAnalyticsOverviewBundle(clientId, query = {}, options = {}) {
  const { timer } = options;
  const rawDays = parseInt(query.days, 10);
  const days = rawDays === 999 ? 90 : rawDays;
  let startDate = query.startDate ? new Date(query.startDate) : null;
  let endDate = query.endDate ? new Date(query.endDate) : null;
  if (!startDate && Number.isFinite(days) && days > 0) {
    startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    endDate = new Date();
  }

  const client = await (timer
    ? timer.time('getCachedClient', () =>
        getCachedClient(clientId, 'googleCalendarId config.calendars businessName name')
      )
    : getCachedClient(clientId, 'googleCalendarId config.calendars businessName name'));

  const statsPromise = getTimelineStats(
    clientId,
    client,
    { start: query.start, end: query.end, days: rawDays === 999 ? 90 : query.days },
    { timer }
  );

  const convoQuery = { clientId };
  if (startDate) {
    convoQuery.lastMessageAt = { $gte: startDate };
    if (endDate) convoQuery.lastMessageAt.$lte = endDate;
  }

  const audienceTotalQuery = { clientId };
  const audiencePeriodQuery = { clientId };
  if (startDate) {
    audiencePeriodQuery.$or = [
      { lastSeen: { $gte: startDate, ...(endDate ? { $lte: endDate } : {}) } },
      { createdAt: { $gte: startDate, ...(endDate ? { $lte: endDate } : {}) } },
    ];
  }

  const [stats, activeChats, audienceTotal, audienceInPeriod, insights] = await Promise.all([
    statsPromise,
    timer
      ? timer.time('Conversation.countDocuments', () => Conversation.countDocuments(convoQuery))
      : Conversation.countDocuments(convoQuery),
    timer
      ? timer.time('AdLead.countDocuments', () => AdLead.countDocuments(audienceTotalQuery))
      : AdLead.countDocuments(audienceTotalQuery),
    timer
      ? timer.time('AdLead.period', () => AdLead.countDocuments(audiencePeriodQuery))
      : AdLead.countDocuments(audiencePeriodQuery),
    timer
      ? timer.time('getBoundedInsights', () => getBoundedInsights(clientId, { startDate, endDate }))
      : getBoundedInsights(clientId, { startDate, endDate }),
  ]);

  let periodKpis = null;
  try {
    periodKpis = await buildCommercePeriodKpis({
      clientId,
      days: query.days,
      timeline: stats || [],
      startDate,
    });
  } catch (_) {
    periodKpis = null;
  }

  const reconciledInsights = insights
    ? {
        ...insights,
        periodOrderCount: Math.max(
          insights.periodOrderCount || 0,
          periodKpis?.orders || 0
        ),
        periodRevenue: Math.max(
          insights.periodRevenue || 0,
          periodKpis?.orderRevenue || 0
        ),
        avgOrderValue:
          periodKpis?.avgOrderValue > 0
            ? periodKpis.avgOrderValue
            : insights.avgOrderValue,
      }
    : insights;

  return {
    stats,
    periodKpis,
    summary: {
      activeChats,
      audience: audienceInPeriod,
      audienceTotal,
    },
    insights: reconciledInsights,
  };
}

module.exports = {
  getAnalyticsOverviewBundle,
  getBoundedInsights,
};
