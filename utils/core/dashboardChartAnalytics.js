'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const { buildSuccessfulOrderMatch } = require('../commerce/customerOrderMetrics');
const { calculateRecoveryMetrics } = require('../../services/cartRecoveryMetricsService');
const {
  istDateRangeStrings,
  startOfDayForDateStrIST,
  formatDateStrIST,
} = require('./queryHelpers');

const PERIOD_MAP = {
  '7d': 7,
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

function resolvePeriodRange(period = '30d') {
  const days = PERIOD_MAP[period] || 30;
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  startDate.setHours(0, 0, 0, 0);
  return { period, days, startDate, endDate };
}

function bucketUnit(period) {
  return period === '60d' || period === '90d' ? 'week' : 'day';
}

function dateKeysInRange(startDate, endDate, unit) {
  if (unit === 'day') {
    const keys = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      keys.push(d.toISOString().split('T')[0]);
    }
    return keys;
  }
  const keys = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  const day = cursor.getDay();
  const diff = cursor.getDate() - day + (day === 0 ? -6 : 1);
  cursor.setDate(diff);
  while (cursor <= endDate) {
    keys.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 7);
  }
  return keys;
}

function bucketKey(date, unit) {
  const d = new Date(date);
  if (unit === 'day') return d.toISOString().split('T')[0];
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1);
  copy.setDate(diff);
  copy.setHours(0, 0, 0, 0);
  return copy.toISOString().split('T')[0];
}

function emptyBuckets(startDate, endDate, unit) {
  const map = new Map();
  dateKeysInRange(startDate, endDate, unit).forEach((k) => {
    map.set(k, { date: k, value: 0, secondaryValue: null });
  });
  return map;
}

function finalizePoints(map, field) {
  const points = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  let count = 0;
  points.forEach((p) => {
    if (field === 'aov') {
      if (p.value != null && p.value > 0) {
        total += p.value;
        count += 1;
      }
    } else if (field === 'orders_units') {
      total += (p.value || 0) + (p.secondaryValue || 0);
      count += 1;
    } else {
      total += p.value || 0;
      count += 1;
    }
  });
  const average = field === 'aov' && count > 0 ? total / count : count > 0 ? total / count : 0;
  return { dataPoints: points, summary: { total, average } };
}

/**
 * GET /api/dashboard/analytics-chart
 */
async function getAnalyticsChart(clientId, field = 'customers', period = '30d') {
  const { startDate, endDate, days } = resolvePeriodRange(period);
  const unit = bucketUnit(period);
  const map = emptyBuckets(startDate, endDate, unit);

  if (field === 'customers') {
    const rows = await AdLead.aggregate([
      { $match: { clientId, createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]);
    rows.forEach((r) => {
      const key = bucketKey(r._id, unit);
      if (!map.has(key)) map.set(key, { date: key, value: 0, secondaryValue: null });
      const cur = map.get(key);
      cur.value += r.count || 0;
    });
    const { dataPoints, summary } = finalizePoints(map, 'customers');
    return { field: 'customers', period, dataPoints, summary };
  }

  const orderMatch = buildSuccessfulOrderMatch(clientId, {
    createdAt: { $gte: startDate, $lte: endDate },
  });

  if (field === 'gross_sales') {
    const rows = await Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] } },
        },
      },
    ]);
    rows.forEach((r) => {
      const key = bucketKey(r._id, unit);
      if (!map.has(key)) map.set(key, { date: key, value: 0, secondaryValue: null });
      map.get(key).value += r.revenue || 0;
    });
    const { dataPoints, summary } = finalizePoints(map, 'gross_sales');
    return { field: 'gross_sales', period, dataPoints, summary };
  }

  if (field === 'orders_units') {
    const rows = await Order.aggregate([
      { $match: orderMatch },
      {
        $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
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
          _id: '$day',
          orders: { $sum: 1 },
          units: { $sum: '$orderUnits' },
        },
      },
    ]);
    rows.forEach((r) => {
      const key = bucketKey(r._id, unit);
      if (!map.has(key)) map.set(key, { date: key, value: 0, secondaryValue: 0 });
      const cur = map.get(key);
      cur.value += r.orders || 0;
      cur.secondaryValue = (cur.secondaryValue || 0) + (r.units || 0);
    });
    const { dataPoints, summary } = finalizePoints(map, 'orders_units');
    return { field: 'orders_units', period, dataPoints, summary };
  }

  if (field === 'aov') {
    const rows = await Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: { $ifNull: ['$totalPrice', { $ifNull: ['$amount', 0] }] } },
          orders: { $sum: 1 },
        },
      },
    ]);
    rows.forEach((r) => {
      const key = bucketKey(r._id, unit);
      if (!map.has(key)) return;
      const orders = r.orders || 0;
      if (orders === 0) return;
      map.get(key).value = (r.revenue || 0) / orders;
    });
    const points = Array.from(map.values())
      .filter((p) => p.value != null && p.value > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalRev = rows.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalOrd = rows.reduce((s, r) => s + (r.orders || 0), 0);
    return {
      field: 'aov',
      period,
      dataPoints: points,
      summary: {
        total: totalOrd > 0 ? totalRev / totalOrd : 0,
        average: points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : 0,
      },
    };
  }

  const err = new Error(`Unknown field: ${field}`);
  err.statusCode = 400;
  throw err;
}

/**
 * GET /api/dashboard/cart-recovery-chart
 * Cohort abandon-date axis — same SSOT as /api/cart-recovery/metrics.
 */
async function getCartRecoveryChart(clientId, period = '30d') {
  const days = PERIOD_MAP[period] || 30;
  const { start: startStr } = istDateRangeStrings(days);
  const from = startOfDayForDateStrIST(startStr);
  const to = new Date();
  const unit = bucketUnit(period);

  const map = new Map();
  dateKeysInRange(from, to, unit).forEach((k) => {
    map.set(k, { date: k, abandoned: 0, recovered: 0, stillAbandoned: 0, messaged: 0 });
  });

  const metrics = await calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from,
    to,
    includeFunnel: true,
    includeRows: true,
  });

  for (const row of metrics.rows || []) {
    if (!row.abandonedAt) continue;
    const dayKey = formatDateStrIST(row.abandonedAt);
    const key = unit === 'day' ? dayKey : bucketKey(startOfDayForDateStrIST(dayKey), unit);
    if (!map.has(key)) {
      map.set(key, { date: key, abandoned: 0, recovered: 0, stillAbandoned: 0, messaged: 0 });
    }
    const pt = map.get(key);
    pt.abandoned += 1;
    if (row.recovered) pt.recovered += 1;
    else pt.stillAbandoned += 1;
    if (row.messaged) pt.messaged += 1;
  }

  const totalMessaged = (metrics.rows || []).filter((r) => r.messaged).length;

  return {
    period,
    summary: {
      totalAbandoned: metrics.totalAbandoned,
      totalRecovered: metrics.recoveredCarts,
      stillAbandoned: Math.max(0, metrics.totalAbandoned - metrics.recoveredCarts),
      recoveryRate: metrics.recoveryRate,
      totalMessaged,
      messageEfficiencyRate: metrics.funnel?.messageEfficiencyRate ?? 0,
    },
    dataPoints: Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Sum units sold in date range (for dashboard KPI).
 */
async function getUnitsSoldInRange(clientId, startDate, endDate) {
  const orderMatch = buildSuccessfulOrderMatch(clientId, {
    createdAt: { $gte: startDate, $lte: endDate },
  });
  const agg = await Order.aggregate([
    { $match: orderMatch },
    { $unwind: '$items' },
    { $group: { _id: null, totalUnits: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
  ]);
  return agg[0]?.totalUnits || 0;
}

module.exports = {
  PERIOD_MAP,
  resolvePeriodRange,
  getAnalyticsChart,
  getCartRecoveryChart,
  getUnitsSoldInRange,
};
