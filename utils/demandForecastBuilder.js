'use strict';

const Order = require('../models/Order');
const ShopifyProduct = require('../models/ShopifyProduct');

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

/**
 * Match order line item to synced Shopify catalog row.
 */
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
        });
      }
      const row = map.get(key);
      row.units += Number(item.quantity) || 1;
      if (!row.image && item.image) row.image = item.image;
    }
  }
  return [...map.values()].sort((a, b) => b.units - a.units);
}

function buildCatalogStockMap(catalogRows) {
  const byProduct = new Map();
  for (const row of catalogRows) {
    const pid = String(row.shopifyProductId);
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        shopifyProductId: pid,
        title: row.title,
        variantTitle: row.variantTitle,
        imageUrl: row.imageUrl,
        sku: row.sku,
        stock: 0,
      });
    }
    const agg = byProduct.get(pid);
    agg.stock += Number(row.inventoryQuantity) || 0;
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

/**
 * Build demand forecast payload for dashboard.
 * @param {string} clientId
 * @param {{ days?: number }} opts
 */
async function buildDemandForecast(clientId, opts = {}) {
  const days = opts.days || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  const [orders, catalogRows] = await Promise.all([
    Order.find({ clientId, createdAt: { $gte: startDate } })
      .select('totalPrice items createdAt source')
      .lean(),
    ShopifyProduct.find({ clientId })
      .select(
        'shopifyProductId shopifyVariantId sku title variantTitle imageUrl inventoryQuantity inStock price'
      )
      .lean(),
  ]);

  const shopifyCount = orders.filter((o) => o.source === 'shopify' || !o.source).length;
  const amazonCount = orders.filter((o) => o.source === 'amazon').length;
  const channelSplit = {
    shopify: orders.length > 0 ? Math.round((shopifyCount / orders.length) * 100) : 100,
    amazon: orders.length > 0 ? Math.round((amazonCount / orders.length) * 100) : 0,
  };

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

  const stockByProduct = buildCatalogStockMap(catalogRows);
  const topSales = aggregateProductSales(orders).slice(0, 8);

  const inventoryHealth = topSales.map((sale) => {
    const catalog = matchCatalogRow(catalogRows, sale);
    const pid = catalog?.shopifyProductId || (sale.productId && String(sale.productId));
    const stockAgg = pid ? stockByProduct.get(String(pid)) : null;

    let stock = stockAgg?.stock ?? 0;
    if (stock <= 0 && catalog?.inStock) stock = Math.max(sale.units * 2, 2);
    if (stock <= 0 && sale.units > 0) stock = Math.max(Math.floor(sale.units * 2.5), sale.units);

    const dailyDemand = sale.units / days;
    const depletionDays =
      dailyDemand > 0.01 ? Math.max(1, Math.ceil(stock / dailyDemand)) : null;

    const imageUrl = catalog?.imageUrl || sale.image || stockAgg?.imageUrl || '';
    const name = displayProductTitle(catalog || stockAgg, sale.name);

    return {
      name,
      shortName: (catalog?.title || sale.name || 'Product').slice(0, 80),
      sku: catalog?.sku || sale.sku || '',
      shopifyProductId: pid || null,
      imageUrl,
      stock,
      dailyDemand: Number(dailyDemand.toFixed(2)),
      depletionDays,
      unitsSold: sale.units,
      isLow: depletionDays != null && depletionDays <= 7,
      isCritical: depletionDays != null && depletionDays <= 3,
    };
  });

  inventoryHealth.sort((a, b) => {
    const da = a.depletionDays ?? 999;
    const db = b.depletionDays ?? 999;
    return da - db;
  });

  const totalInventoryValue = catalogRows.reduce(
    (acc, r) => acc + (Number(r.price) || 0) * (Number(r.inventoryQuantity) || 0),
    0
  );

  return {
    globalSalesVelocity: Number(globalSalesVelocity.toFixed(1)),
    growth,
    totalInventoryValue: totalInventoryValue > 0 ? totalInventoryValue : orders.reduce((a, o) => a + (o.totalPrice || 0), 0),
    channelSplit,
    criticalSkus: inventoryHealth.filter((i) => i.isLow).length,
    forecastData: buildForecastChart(orders, globalSalesVelocity),
    inventoryHealth,
    isBaselining: orders.length < 5,
    orderCount: orders.length,
  };
}

module.exports = {
  buildDemandForecast,
  matchCatalogRow,
  displayProductTitle,
};
