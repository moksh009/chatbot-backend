'use strict';

const STALE_CATALOG_MS = 24 * 60 * 60 * 1000;
const VERY_STALE_CATALOG_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {'out_of_stock'|'critical'|'low'|'healthy'|'idle'|'unknown'} StockStatus
 */

/**
 * Forecast confidence from order history depth.
 * @returns {'high'|'medium'|'low'|'none'}
 */
function forecastConfidence({ orderCountInWindow = 0, unitsSold = 0, analysisWindowDays = 30 }) {
  if (unitsSold <= 0) return 'none';
  if (analysisWindowDays >= 30 && orderCountInWindow >= 10 && unitsSold >= 10) return 'high';
  if (analysisWindowDays >= 15 && orderCountInWindow >= 5 && unitsSold >= 5) return 'medium';
  if (unitsSold > 0) return 'low';
  return 'none';
}

/**
 * Classify SKU stock health — no synthetic quantities.
 * @param {object} p
 * @param {number|null} p.qty — sellable units (null = unknown)
 * @param {number} p.unitsSold30d
 * @param {number} p.dailyDemand
 * @param {Date|string|null} p.catalogSyncedAt
 * @param {boolean} p.catalogMissing
 */
function classifyStockHealth({
  qty,
  unitsSold30d = 0,
  dailyDemand = 0,
  catalogSyncedAt = null,
  catalogMissing = false,
}) {
  const syncedAt = catalogSyncedAt ? new Date(catalogSyncedAt) : null;
  const ageMs = syncedAt ? Date.now() - syncedAt.getTime() : Infinity;
  const stale = ageMs > STALE_CATALOG_MS;
  const veryStale = ageMs > VERY_STALE_CATALOG_MS;

  if (catalogMissing || qty == null) {
    return {
      stockStatus: 'unknown',
      depletionDays: null,
      isLow: false,
      isCritical: false,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (stale) {
    return {
      stockStatus: 'unknown',
      depletionDays: null,
      isLow: false,
      isCritical: false,
      catalogStale: true,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  const stock = Math.max(0, Number(qty) || 0);
  const demand = Number(dailyDemand) || 0;
  const units = Number(unitsSold30d) || 0;

  if (stock === 0) {
    return {
      stockStatus: 'out_of_stock',
      depletionDays: null,
      isLow: true,
      isCritical: true,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (units <= 0 && demand <= 0.01) {
    return {
      stockStatus: 'idle',
      depletionDays: null,
      isLow: false,
      isCritical: false,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  const depletionDays = demand > 0.01 ? Math.max(1, Math.ceil(stock / demand)) : null;

  if (stock > 0 && stock <= 3) {
    return {
      stockStatus: 'critical',
      depletionDays,
      isLow: true,
      isCritical: true,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (depletionDays != null && depletionDays <= 3) {
    return {
      stockStatus: 'critical',
      depletionDays,
      isLow: true,
      isCritical: true,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (depletionDays != null && depletionDays <= 7) {
    return {
      stockStatus: 'low',
      depletionDays,
      isLow: true,
      isCritical: false,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (stock > 0 && units > 0 && depletionDays != null && depletionDays > 7) {
    return {
      stockStatus: 'healthy',
      depletionDays,
      isLow: false,
      isCritical: false,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  if (stock > 0 && units > 0) {
    return {
      stockStatus: 'low',
      depletionDays,
      isLow: true,
      isCritical: false,
      catalogStale: stale,
      catalogVeryStale: veryStale,
      stockAsOf: syncedAt,
    };
  }

  return {
    stockStatus: 'idle',
    depletionDays: null,
    isLow: false,
    isCritical: false,
    catalogStale: stale,
    catalogVeryStale: veryStale,
    stockAsOf: syncedAt,
  };
}

const ATTENTION_STATUSES = new Set(['out_of_stock', 'critical', 'low', 'unknown']);

function statusSortRank(status) {
  const order = { out_of_stock: 0, critical: 1, low: 2, unknown: 3, idle: 4, healthy: 5 };
  return order[status] ?? 9;
}

function computeChannelSplit(orders) {
  let shopifyOrders = 0;
  let amazonOrders = 0;
  let shopifyUnits = 0;
  let amazonUnits = 0;
  let shopifyRevenue = 0;
  let amazonRevenue = 0;

  for (const o of orders) {
    const isAmazon = o.source === 'amazon';
    if (isAmazon) amazonOrders += 1;
    else shopifyOrders += 1;

    const lineUnits = (o.items || []).reduce((a, ii) => a + (Number(ii.quantity) || 1), 0);
    const rev = Number(o.totalPrice) || 0;
    if (isAmazon) {
      amazonUnits += lineUnits;
      amazonRevenue += rev;
    } else {
      shopifyUnits += lineUnits;
      shopifyRevenue += rev;
    }
  }

  const totalOrders = orders.length;
  const totalUnits = shopifyUnits + amazonUnits;
  const totalRevenue = shopifyRevenue + amazonRevenue;

  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

  return {
    orders: {
      shopify: pct(shopifyOrders, totalOrders),
      amazon: pct(amazonOrders, totalOrders),
      shopifyCount: shopifyOrders,
      amazonCount: amazonOrders,
    },
    units: {
      shopify: pct(shopifyUnits, totalUnits),
      amazon: pct(amazonUnits, totalUnits),
      shopifyCount: shopifyUnits,
      amazonCount: amazonUnits,
    },
    revenue: {
      shopify: pct(shopifyRevenue, totalRevenue),
      amazon: pct(amazonRevenue, totalRevenue),
      shopifyCount: Math.round(shopifyRevenue),
      amazonCount: Math.round(amazonRevenue),
    },
  };
}

module.exports = {
  STALE_CATALOG_MS,
  VERY_STALE_CATALOG_MS,
  ATTENTION_STATUSES,
  forecastConfidence,
  classifyStockHealth,
  statusSortRank,
  computeChannelSplit,
};
