'use strict';

const Order = require('../../models/Order');
const Client = require('../../models/Client');
const ShopifyProduct = require('../../models/ShopifyProduct');
const InventoryLedger = require('../../models/InventoryLedger');
const {
  classifyStockHealth,
  forecastConfidence,
  statusSortRank,
  computeChannelSplit,
  ATTENTION_STATUSES,
} = require('../inventory/stockClassification');

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function displayProductTitle(catalog, fallbackName) {
  const base = (catalog?.title || fallbackName || 'Unknown product').trim();
  const variant = catalog?.variantTitle;
  if (variant && variant !== 'Default Title' && !base.includes(variant)) {
    return `${base} · ${variant}`;
  }
  return base;
}

function matchCatalogRow(catalogRows, { productId, variantId, sku, name }) {
  if (!catalogRows?.length) return null;
  const pid = productId != null ? String(productId) : '';
  const vid = variantId != null ? String(variantId) : '';
  const skuKey = normalizeKey(sku);

  if (pid) {
    const byProduct = catalogRows.filter((r) => String(r.shopifyProductId) === pid);
    if (byProduct.length) {
      if (vid) {
        const exact = byProduct.find((r) => String(r.shopifyVariantId) === vid);
        if (exact) return exact;
      }
      return byProduct[0];
    }
  }
  if (skuKey) {
    const bySku = catalogRows.find((r) => normalizeKey(r.sku) === skuKey);
    if (bySku) return bySku;
  }
  const nameKey = normalizeKey(name);
  if (nameKey) {
    const byTitle = catalogRows.find((r) => normalizeKey(r.title) === nameKey);
    if (byTitle) return byTitle;
  }
  return null;
}

function aggregateProductSales(orders) {
  const map = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      const key =
        (item.productId && String(item.productId)) ||
        (item.sku && `sku:${item.sku}`) ||
        `name:${normalizeKey(item.name)}`;
      if (!map.has(key)) {
        map.set(key, {
          productId: item.productId,
          variantId: item.variantId,
          sku: item.sku,
          name: item.name,
          image: item.image,
          units: 0,
          shopifyUnits: 0,
          amazonUnits: 0,
        });
      }
      const row = map.get(key);
      const q = Number(item.quantity) || 1;
      row.units += q;
      if (order.source === 'amazon') row.amazonUnits += q;
      else row.shopifyUnits += q;
      if (!row.image && item.image) row.image = item.image;
    }
  }
  return [...map.values()].sort((a, b) => b.units - a.units);
}

function buildCatalogStockMap(catalogRows, ledgerBySku) {
  const byProduct = new Map();
  for (const row of catalogRows) {
    const pid = String(row.shopifyProductId);
    const ledger = row.sku ? ledgerBySku?.get(row.sku) : null;
    const variantQty =
      ledger != null ? Number(ledger.available) : Number(row.inventoryQuantity) || 0;
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        shopifyProductId: pid,
        title: row.title,
        variantTitle: row.variantTitle,
        imageUrl: row.imageUrl,
        sku: row.sku,
        stock: 0,
        lastSyncedAt: row.lastSyncedAt || null,
        fromLedger: !!ledger,
      });
    }
    const agg = byProduct.get(pid);
    agg.stock += variantQty;
    if (row.lastSyncedAt && (!agg.lastSyncedAt || row.lastSyncedAt > agg.lastSyncedAt)) {
      agg.lastSyncedAt = row.lastSyncedAt;
    }
    if (!agg.imageUrl && row.imageUrl) agg.imageUrl = row.imageUrl;
    if (!agg.sku && row.sku) agg.sku = row.sku;
  }
  return byProduct;
}

function unitsSoldOnDay(orders, dayStart) {
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return orders
    .filter((o) => {
      const t = new Date(o.createdAt);
      return t >= dayStart && t < dayEnd;
    })
    .reduce(
      (acc, o) =>
        acc +
        (o.items || []).reduce((ia, ii) => ia + (Number(ii.quantity) || 1), 0),
      0
    );
}

function buildForecastChart(orders, globalVelocity) {
  const points = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 9; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    points.push({
      date: d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      sales: unitsSoldOnDay(orders, d),
      forecast: null,
    });
  }

  for (let i = 1; i <= 4; i += 1) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    points.push({
      date: d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      sales: null,
      forecast: Math.max(0, Math.round(globalVelocity * (1 + i * 0.04))),
    });
  }

  return points;
}

function windowStart(days) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  return startDate;
}

async function fetchOrdersInWindow(clientId, days) {
  return Order.find({ clientId, createdAt: { $gte: windowStart(days) } })
    .select('totalPrice items createdAt source')
    .lean();
}

function buildHealthRow({ sale, catalog, stockAgg, days, orders }) {
  const pid = catalog?.shopifyProductId || (sale?.productId && String(sale.productId));
  const stock = stockAgg?.stock ?? (catalog ? Number(catalog.inventoryQuantity) || 0 : null);
  const unitsSold = sale?.units ?? 0;
  const dailyDemand = unitsSold / days;
  const catalogSyncedAt = stockAgg?.lastSyncedAt || catalog?.lastSyncedAt || null;

  const classified = classifyStockHealth({
    qty: stock,
    unitsSold30d: unitsSold,
    dailyDemand,
    catalogSyncedAt,
    catalogMissing: !catalog && !stockAgg,
  });

  const amazonHeavy =
    unitsSold > 0 && (sale?.amazonUnits || 0) > (sale?.shopifyUnits || 0);

  const confidence = forecastConfidence({
    orderCountInWindow: orders.length,
    unitsSold,
    analysisWindowDays: days,
  });

  const imageUrl = catalog?.imageUrl || sale?.image || stockAgg?.imageUrl || '';
  const name = displayProductTitle(catalog || stockAgg, sale?.name);

  return {
    name,
    shortName: (catalog?.title || sale?.name || 'Product').slice(0, 80),
    sku: catalog?.sku || sale?.sku || '',
    shopifyProductId: pid || null,
    shopifyVariantId: catalog?.shopifyVariantId || sale?.variantId || null,
    imageUrl,
    stock: stock ?? 0,
    stockStatus: classified.stockStatus,
    dailyDemand: Number(dailyDemand.toFixed(2)),
    depletionDays: classified.depletionDays,
    unitsSold,
    shopifyUnits30d: sale?.shopifyUnits ?? 0,
    amazonUnits30d: sale?.amazonUnits ?? 0,
    isLow: classified.isLow,
    isCritical: classified.isCritical,
    catalogStale: classified.catalogStale,
    catalogVeryStale: classified.catalogVeryStale,
    stockAsOf: classified.stockAsOf,
    forecastConfidence: confidence,
    amazonHeavy,
    lastSoldAt: sale?.lastSoldAt || null,
  };
}

async function buildDemandForecast(clientId, opts = {}) {
  const preferredDays = opts.days || 30;
  const totalOrderCount = await Order.countDocuments({ clientId });

  let days = preferredDays;
  let orders = await fetchOrdersInWindow(clientId, days);

  if (orders.length < 5 && totalOrderCount >= 5) {
    days = 90;
    orders = await fetchOrdersInWindow(clientId, days);
  }

  const [catalogRows, clientLean, ledgerRows] = await Promise.all([
    ShopifyProduct.find({ clientId })
      .select(
        'shopifyProductId shopifyVariantId sku title variantTitle imageUrl inventoryQuantity inStock price lastSyncedAt shopifyInventoryItemId'
      )
      .lean(),
    Client.findOne({ clientId }).select('catalogSyncedAt shopifyLastProductSync').lean(),
    InventoryLedger.find({ clientId }).select('sku available locationId lastAdjustmentAt').lean(),
  ]);

  const ledgerBySku = new Map();
  for (const row of ledgerRows) {
    if (row.locationId && row.locationId !== 'default') continue;
    ledgerBySku.set(row.sku, row);
  }

  const catalogSyncedAt =
    clientLean?.catalogSyncedAt || clientLean?.shopifyLastProductSync || null;

  const channelSplit = computeChannelSplit(orders);

  const totalUnits = orders.reduce(
    (acc, o) =>
      acc + (o.items || []).reduce((ia, ii) => ia + (Number(ii.quantity) || 1), 0),
    0
  );
  const globalSalesVelocity = totalUnits / days;

  const midPoint = new Date();
  midPoint.setDate(midPoint.getDate() - Math.floor(days / 2));
  const recentUnits = orders
    .filter((o) => new Date(o.createdAt) >= midPoint)
    .reduce(
      (acc, o) =>
        acc + (o.items || []).reduce((ia, ii) => ia + (Number(ii.quantity) || 1), 0),
      0
    );
  const olderUnits = orders
    .filter((o) => new Date(o.createdAt) < midPoint)
    .reduce(
      (acc, o) =>
        acc + (o.items || []).reduce((ia, ii) => ia + (Number(ii.quantity) || 1), 0),
      0
    );
  const growth =
    olderUnits > 0
      ? Number((((recentUnits - olderUnits) / olderUnits) * 100).toFixed(1))
      : recentUnits > 0
        ? 100
        : 0;

  const stockByProduct = buildCatalogStockMap(catalogRows, ledgerBySku);
  const salesRows = aggregateProductSales(orders);

  const salesByProductId = new Map();
  for (const sale of salesRows) {
    const catalog = matchCatalogRow(catalogRows, sale);
    const pid = catalog?.shopifyProductId || (sale.productId && String(sale.productId));
    if (!pid) continue;
    const prev = salesByProductId.get(pid);
    if (!prev || sale.units > prev.units) {
      salesByProductId.set(pid, { ...sale, catalog });
    }
  }

  const healthByProduct = new Map();

  for (const [pid, stockAgg] of stockByProduct.entries()) {
    const sale = salesByProductId.get(pid) || null;
    healthByProduct.set(
      pid,
      buildHealthRow({ sale, catalog: sale?.catalog || null, stockAgg, days, orders })
    );
  }

  for (const sale of salesRows) {
    const catalog = matchCatalogRow(catalogRows, sale);
    const pid = catalog?.shopifyProductId || (sale.productId && String(sale.productId));
    if (!pid || healthByProduct.has(String(pid))) continue;
    healthByProduct.set(
      String(pid),
      buildHealthRow({ sale, catalog, stockAgg: stockByProduct.get(String(pid)), days, orders })
    );
  }

  let inventoryHealth = [...healthByProduct.values()];

  const attentionRows = inventoryHealth.filter((r) => ATTENTION_STATUSES.has(r.stockStatus));
  attentionRows.sort((a, b) => {
    const sr = statusSortRank(a.stockStatus) - statusSortRank(b.stockStatus);
    if (sr !== 0) return sr;
    const da = a.depletionDays ?? 999;
    const db = b.depletionDays ?? 999;
    return da - db;
  });

  const healthyExtras = inventoryHealth
    .filter((r) => r.stockStatus === 'healthy')
    .sort((a, b) => (a.depletionDays ?? 999) - (b.depletionDays ?? 999))
    .slice(0, 8);

  const seen = new Set();
  inventoryHealth = [];
  for (const r of [...attentionRows, ...healthyExtras]) {
    const k = r.shopifyProductId || r.sku;
    if (seen.has(k)) continue;
    seen.add(k);
    inventoryHealth.push(r);
  }

  const criticalSkus = inventoryHealth.filter(
    (i) => i.stockStatus === 'out_of_stock' || i.stockStatus === 'critical' || i.isCritical
  ).length;

  const totalInventoryValue = catalogRows.reduce(
    (acc, r) => acc + (Number(r.price) || 0) * (Number(r.inventoryQuantity) || 0),
    0
  );

  return {
    globalSalesVelocity: Number(globalSalesVelocity.toFixed(1)),
    growth,
    totalInventoryValue:
      totalInventoryValue > 0
        ? totalInventoryValue
        : orders.reduce((a, o) => a + (o.totalPrice || 0), 0),
    channelSplit,
    channelSplitLegacy: {
      shopify: channelSplit.orders.shopify,
      amazon: channelSplit.orders.amazon,
    },
    criticalSkus,
    forecastData: buildForecastChart(orders, globalSalesVelocity),
    inventoryHealth,
    attentionCount: attentionRows.length,
    isBaselining: totalOrderCount < 1,
    orderCount: orders.length,
    totalOrderCount,
    analysisWindowDays: days,
    needsOrderSync: totalOrderCount < 5,
    catalogSyncedAt,
    inventoryTruthVersion: 1,
  };
}

module.exports = {
  buildDemandForecast,
  matchCatalogRow,
  displayProductTitle,
};
