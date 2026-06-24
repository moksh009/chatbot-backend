'use strict';

const moment = require('moment');
const ProductDailyStat = require('../../../models/ProductDailyStat');

function capVelocity(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, n);
}

function deltaPct(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p <= 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 100);
}

/**
 * Sum daily stats for a product in a date range (inclusive keys).
 */
async function sumProductStatsInRange(clientId, productId, dateKeys) {
  if (!dateKeys?.length) {
    return { views: 0, addToCarts: 0, checkoutsStarted: 0, purchases: 0, revenue: 0 };
  }
  const rows = await ProductDailyStat.aggregate([
    { $match: { clientId, productId, date: { $in: dateKeys } } },
    {
      $group: {
        _id: null,
        views: { $sum: '$views' },
        addToCarts: { $sum: '$addToCarts' },
        checkoutsStarted: { $sum: '$checkoutsStarted' },
        purchases: { $sum: '$purchases' },
        revenue: { $sum: '$revenue' },
      },
    },
  ]);
  const r = rows[0] || {};
  return {
    views: r.views || 0,
    addToCarts: r.addToCarts || 0,
    checkoutsStarted: r.checkoutsStarted || 0,
    purchases: r.purchases || 0,
    revenue: r.revenue || 0,
  };
}

function buildWeekDateKeys(days) {
  const end = moment().startOf('day');
  const thisWeekStart = end.clone().subtract(6, 'days');
  const prevWeekEnd = thisWeekStart.clone().subtract(1, 'day');
  const prevWeekStart = prevWeekEnd.clone().subtract(6, 'days');

  const keys = (start, finish) => {
    const out = [];
    const cursor = start.clone();
    while (cursor.isSameOrBefore(finish, 'day')) {
      out.push(cursor.format('YYYY-MM-DD'));
      cursor.add(1, 'day');
    }
    return out;
  };

  return {
    thisWeekKeys: keys(thisWeekStart, end),
    prevWeekKeys: keys(prevWeekStart, prevWeekEnd),
  };
}

async function computeProductVelocity(clientId, productId, days = 30) {
  const { thisWeekKeys, prevWeekKeys } = buildWeekDateKeys(days);
  const [thisWeek, prevWeek] = await Promise.all([
    sumProductStatsInRange(clientId, productId, thisWeekKeys),
    sumProductStatsInRange(clientId, productId, prevWeekKeys),
  ]);
  return buildVelocityFromWeeks(thisWeek, prevWeek);
}

function buildVelocityFromWeeks(thisWeek, prevWeek) {
  const viewVelocity = capVelocity(thisWeek.views / Math.max(prevWeek.views, 1));
  const atcVelocity = capVelocity(thisWeek.addToCarts / Math.max(prevWeek.addToCarts, 1));
  const purchaseVelocity = capVelocity(thisWeek.purchases / Math.max(prevWeek.purchases, 1));

  return {
    thisWeek,
    prevWeek,
    viewVelocity,
    atcVelocity,
    purchaseVelocity,
    viewsDelta: deltaPct(thisWeek.views, prevWeek.views),
    addToCartsDelta: deltaPct(thisWeek.addToCarts, prevWeek.addToCarts),
    purchasesDelta: deltaPct(thisWeek.purchases, prevWeek.purchases),
    revenueDelta: deltaPct(thisWeek.revenue, prevWeek.revenue),
  };
}

/**
 * Batch velocity for many SKUs — two aggregations instead of 2×N.
 */
async function computeVelocitiesBatch(clientId, productIds, days = 30) {
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, buildVelocityFromWeeks(
    { views: 0, addToCarts: 0, checkoutsStarted: 0, purchases: 0, revenue: 0 },
    { views: 0, addToCarts: 0, checkoutsStarted: 0, purchases: 0, revenue: 0 }
  )]));
  if (!ids.length) return map;

  const { thisWeekKeys, prevWeekKeys } = buildWeekDateKeys(days);
  const allKeys = [...new Set([...thisWeekKeys, ...prevWeekKeys])];
  const thisSet = new Set(thisWeekKeys);
  const prevSet = new Set(prevWeekKeys);

  const rows = await ProductDailyStat.aggregate([
    { $match: { clientId, productId: { $in: ids }, date: { $in: allKeys } } },
    {
      $group: {
        _id: { productId: '$productId', date: '$date' },
        views: { $sum: '$views' },
        addToCarts: { $sum: '$addToCarts' },
        checkoutsStarted: { $sum: '$checkoutsStarted' },
        purchases: { $sum: '$purchases' },
        revenue: { $sum: '$revenue' },
      },
    },
  ]);

  const thisByProduct = new Map();
  const prevByProduct = new Map();
  const empty = () => ({ views: 0, addToCarts: 0, checkoutsStarted: 0, purchases: 0, revenue: 0 });

  for (const row of rows) {
    const pid = row._id.productId;
    const date = row._id.date;
    const bucket = thisSet.has(date) ? thisByProduct : prevSet.has(date) ? prevByProduct : null;
    if (!bucket) continue;
    if (!bucket.has(pid)) bucket.set(pid, empty());
    const acc = bucket.get(pid);
    acc.views += row.views || 0;
    acc.addToCarts += row.addToCarts || 0;
    acc.checkoutsStarted += row.checkoutsStarted || 0;
    acc.purchases += row.purchases || 0;
    acc.revenue += row.revenue || 0;
  }

  for (const id of ids) {
    map.set(
      id,
      buildVelocityFromWeeks(thisByProduct.get(id) || empty(), prevByProduct.get(id) || empty())
    );
  }
  return map;
}

module.exports = {
  capVelocity,
  deltaPct,
  sumProductStatsInRange,
  buildWeekDateKeys,
  computeProductVelocity,
  computeVelocitiesBatch,
  buildVelocityFromWeeks,
};
