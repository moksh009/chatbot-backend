'use strict';

const moment = require('moment');
const ProductDailyStat = require('../../models/ProductDailyStat');
const PixelEvent = require('../../models/PixelEvent');
const Order = require('../../models/Order');
const { buildAnalyticsPeriodOrderMatch } = require('./customerOrderMetrics');
const { dedupeOrdersByShopifyKey } = require('./orderDedupe');
const {
  istDateRangeStrings,
  startOfDayForDateStrIST,
  endOfDayForDateStrIST,
} = require('../core/queryHelpers');
const {
  buildStorefrontMetricsForPeriod,
  buildDailyStorefrontTrend,
} = require('./storefrontPixelMetrics');
const { inferProductFromUrl } = require('./productViewUrlUtils');
const log = require('../core/logger')('ProductInsightsRollup');

function dateKey(d = new Date()) {
  return moment(d).format('YYYY-MM-DD');
}

function dateRangeKeys(days) {
  const end = moment().startOf('day');
  const start = end.clone().subtract(Math.max(1, Number(days) || 30) - 1, 'days');
  const keys = [];
  const cursor = start.clone();
  while (cursor.isSameOrBefore(end, 'day')) {
    keys.push(cursor.format('YYYY-MM-DD'));
    cursor.add(1, 'day');
  }
  return keys;
}

function normalizeProductId(raw) {
  const id = String(raw || '').trim();
  if (!id) return null;
  return id;
}

function normalizeProductMeta(data = {}) {
  const p = data.product || data.metadata?.product || {};
  if (p.items && Array.isArray(p.items) && p.items.length) {
    return normalizeProductMeta({ ...data, product: p.items[0] });
  }
  const productId = normalizeProductId(p.productId || p.product_id || p.id);
  const handle = String(p.handle || '').trim();
  if (!productId && !handle) return null;
  return {
    productId: productId || `handle:${handle}`,
    variantId: p.variantId || p.variant_id || null,
    title: String(
      p.title || p.product_title || p.name || handle.replace(/-/g, ' ') || 'Product'
    ).trim(),
    handle,
    image: p.image || p.imageUrl || p.featured_image?.url || '',
    price: parseFloat(p.price || p.final_price || 0) || 0,
    currency: p.currency || 'INR',
  };
}

async function incrementProductStat(clientId, eventName, productMeta, opts = {}) {
  if (!clientId || !productMeta?.productId) return;
  const date = dateKey(opts.timestamp || new Date());
  const inc = {};
  if (eventName === 'product_view') inc.views = 1;
  else if (eventName === 'product_added_to_cart' || eventName === 'add_to_cart') inc.addToCarts = 1;
  else if (eventName === 'checkout_started') inc.checkoutsStarted = 1;

  if (!Object.keys(inc).length) return;

  const setFields = { updatedAt: new Date() };
  if (productMeta.title) setFields.title = productMeta.title;
  if (productMeta.handle) setFields.handle = productMeta.handle;
  if (productMeta.image) setFields.image = productMeta.image;

  try {
    await ProductDailyStat.updateOne(
      { clientId, date, productId: productMeta.productId },
      {
        $inc: inc,
        $set: setFields,
        $setOnInsert: { clientId, date, productId: productMeta.productId },
      },
      { upsert: true }
    );
  } catch (err) {
    log.warn(`incrementProductStat failed: ${err.message}`);
  }
}

async function rollupProductEvent(clientId, eventName, data = {}, opts = {}) {
  const url = opts.url || data.url || data.metadata?.url || '';
  let productMeta = normalizeProductMeta(data);
  if (!productMeta && (eventName === 'page_view' || eventName === 'product_view')) {
    productMeta = inferProductFromUrl(url);
  }
  if (!productMeta) return;
  const rollupName =
    eventName === 'page_view' && inferProductFromUrl(url) ? 'product_view' : eventName;
  await incrementProductStat(clientId, rollupName, productMeta, { ...opts, url });
}

async function countProductDiscoveryEvents(clientId, since) {
  const [productViews, productPageViews] = await Promise.all([
    PixelEvent.countDocuments({
      clientId,
      eventName: 'product_view',
      timestamp: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: 'page_view',
      url: /\/products\//i,
      timestamp: { $gte: since },
    }),
  ]);
  return productViews + productPageViews;
}

async function enrichProductsWithCatalog(clientId, products) {
  if (!products?.length) return products;
  const ShopifyProduct = require('../../models/ShopifyProduct');
  const catalog = await ShopifyProduct.find({ clientId })
    .select('shopifyProductId title imageUrl productUrl')
    .limit(2000)
    .lean();

  const byId = new Map();
  const byTitle = new Map();
  const byHandle = new Map();
  for (const p of catalog) {
    if (p.shopifyProductId) byId.set(String(p.shopifyProductId), p);
    if (p.title) byTitle.set(p.title.toLowerCase().trim(), p);
    if (p.productUrl) {
      const match = String(p.productUrl).match(/\/products\/([^/?#]+)/);
      if (match?.[1]) byHandle.set(decodeURIComponent(match[1]).toLowerCase(), p);
    }
  }

  const resolveMatch = (row) => {
    const pid = String(row.productId || '');
    if (pid.startsWith('name:')) {
      const nameKey = pid.slice(5).toLowerCase().trim();
      if (nameKey && byTitle.has(nameKey)) return byTitle.get(nameKey);
      if (nameKey) {
        for (const [t, product] of byTitle) {
          if (t.includes(nameKey) || nameKey.includes(t)) return product;
        }
      }
    }
    if (pid && !pid.startsWith('handle:') && !pid.startsWith('name:') && byId.has(pid)) {
      return byId.get(pid);
    }
    const handleKey = (row.handle || (pid.startsWith('handle:') ? pid.slice(7) : '')).toLowerCase();
    if (handleKey && byHandle.has(handleKey)) return byHandle.get(handleKey);
    const titleKey = String(row.title || row.name || '').toLowerCase().trim();
    if (titleKey && byTitle.has(titleKey)) return byTitle.get(titleKey);
    if (titleKey) {
      for (const [t, product] of byTitle) {
        if (t.includes(titleKey) || titleKey.includes(t)) return product;
      }
    }
    return null;
  };

  return products.map((row) => {
    const match = resolveMatch(row);
    return {
      ...row,
      title: row.title || match?.title || row.handle?.replace(/-/g, ' ') || 'Product',
      image: (row.image && String(row.image).trim()) || match?.imageUrl || '',
      handle: row.handle || (String(row.productId || '').startsWith('handle:') ? row.productId.slice(7) : ''),
    };
  });
}

function mergeImagesFromOrderProducts(winningProducts, orderRows) {
  if (!winningProducts?.length || !orderRows?.length) return winningProducts;
  const byTitle = new Map();
  const byId = new Map();
  for (const row of orderRows) {
    const image = row.image && String(row.image).trim();
    if (!image) continue;
    const title = String(row.title || row.name || '').toLowerCase().trim();
    if (title) byTitle.set(title, image);
    if (row.productId) byId.set(String(row.productId), image);
  }
  return winningProducts.map((w) => {
    const pid = String(w.productId || '');
    const titleKey = String(w.title || '').toLowerCase().trim();
    const nameKey = pid.startsWith('name:') ? pid.slice(5).toLowerCase().trim() : '';
    const fromOrder =
      (w.image && String(w.image).trim()) ||
      byId.get(pid) ||
      (titleKey && byTitle.get(titleKey)) ||
      (nameKey && byTitle.get(nameKey)) ||
      '';
    return { ...w, image: fromOrder };
  });
}

async function countUniqueProductViewers(clientId, since) {
  const rows = await PixelEvent.aggregate([
    {
      $match: {
        clientId,
        eventName: { $in: ['product_view', 'page_view'] },
        timestamp: { $gte: since },
      },
    },
    {
      $addFields: {
        visitorKey: {
          $let: {
            vars: {
              sid: { $ifNull: ['$sessionId', ''] },
              vid: { $ifNull: ['$metadata.visitorId', ''] },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: { $toString: '$$sid' } }, 0] },
                { $toString: '$$sid' },
                {
                  $cond: [
                    { $gt: [{ $strLenCP: { $toString: '$$vid' } }, 0] },
                    { $toString: '$$vid' },
                    null,
                  ],
                },
              ],
            },
          },
        },
        isProductView: {
          $or: [
            { $eq: ['$eventName', 'product_view'] },
            {
              $and: [
                { $eq: ['$eventName', 'page_view'] },
                { $regexMatch: { input: { $ifNull: ['$url', ''] }, regex: /\/products\// } },
              ],
            },
          ],
        },
      },
    },
    { $match: { visitorKey: { $ne: null }, isProductView: true } },
    { $group: { _id: '$visitorKey' } },
    { $count: 'count' },
  ]);
  return rows[0]?.count || 0;
}

function productGroupKey(item) {
  const pid = normalizeProductId(item?.productId);
  if (pid) return pid;
  const name = String(item?.name || '').trim();
  if (name) return `name:${name}`;
  return null;
}

function buildProductInsightsOrderMatch(clientId, startDate, endDate) {
  return {
    ...buildAnalyticsPeriodOrderMatch(clientId, {
      createdAt: { $gte: startDate, $lte: endDate },
      'items.0': { $exists: true },
    }),
    financialStatus: { $nin: ['cancelled', 'refunded', 'voided', 'partially_refunded'] },
    $or: [{ totalPrice: { $gt: 0 } }, { amount: { $gt: 0 } }],
  };
}

async function aggregateOrderProductStats(clientId, days = 30) {
  const { start: periodStart, end: periodEnd } = istDateRangeStrings(days);
  const startDate = startOfDayForDateStrIST(periodStart);
  const endDate = endOfDayForDateStrIST(periodEnd);
  const match = buildProductInsightsOrderMatch(clientId, startDate, endDate);

  const rawOrders = await Order.find(match)
    .select(
      'items createdAt shopifyOrderId orderId orderNumber totalPrice amount financialStatus shippingAddress customerName customerPhone phone fulfillmentStatus isCOD'
    )
    .lean();

  const orders = dedupeOrdersByShopifyKey(rawOrders);
  const orderCount = orders.length;

  const byProduct = new Map();
  let ordersRevenue = 0;
  let unitsSold = 0;

  for (const order of orders) {
    ordersRevenue += Number(order.totalPrice ?? order.amount ?? 0) || 0;
    for (const item of order.items || []) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const key = productGroupKey(item);
      if (!key) continue;
      const qty = Number(item.quantity) || 1;
      const price = parseFloat(item.price) || 0;
      unitsSold += qty;

      if (!byProduct.has(key)) {
        byProduct.set(key, {
          productId: key,
          title: name,
          image: item.image || '',
          purchases: 0,
          revenue: 0,
        });
      }
      const row = byProduct.get(key);
      row.purchases += qty;
      row.revenue += price * qty;
      if (name) row.title = name;
      if (item.image && String(item.image).trim()) row.image = item.image;
    }
  }

  const sorted = [...byProduct.values()].sort(
    (a, b) => (b.revenue || 0) - (a.revenue || 0) || (b.purchases || 0) - (a.purchases || 0)
  );
  const productsWithSales = sorted.filter((row) => (row.purchases || 0) > 0).length;

  const winningProducts = sorted.slice(0, 20).map((row, idx) => ({
    rank: idx + 1,
    productId: row.productId,
    title: row.title || 'Product',
    handle: row.productId.startsWith('handle:') ? row.productId.slice(7) : '',
    image: row.image || '',
    views: 0,
    addToCarts: 0,
    purchases: row.purchases || 0,
    revenue: row.revenue || 0,
    viewToCartRate: 0,
    isWinner: idx < 3 && (row.purchases || 0) > 0,
    dataSource: 'orders',
  }));

  const orderTopProducts = sorted.slice(0, 8).map((row) => ({
    name: row.title,
    sold: row.purchases || 0,
    revenue: row.revenue || 0,
    image: row.image || '',
    productId: row.productId.startsWith('name:') ? null : row.productId,
  }));

  return {
    summary: {
      ordersRevenue,
      unitsSold,
      productsWithSales,
      orderCount,
      periodStart,
      periodEnd,
      timezone: 'Asia/Kolkata',
    },
    winningProducts,
    orderTopProducts,
    meta: {
      rawOrderDocs: rawOrders.length,
      dedupedOrderCount: orderCount,
    },
  };
}

function mergePixelWithOrderStats(pixelProducts, orderProducts) {
  const byKey = new Map();
  for (const row of orderProducts || []) {
    const pid = String(row.productId || '').toLowerCase();
    const title = String(row.title || '').toLowerCase().trim();
    if (pid) byKey.set(pid, row);
    if (title) byKey.set(title, row);
    if (pid.startsWith('name:')) byKey.set(pid.slice(5), row);
  }

  const merged = new Map();
  for (const pixel of pixelProducts || []) {
    const pid = String(pixel.productId || '').toLowerCase();
    const title = String(pixel.title || '').toLowerCase().trim();
    const order =
      byKey.get(pid) ||
      byKey.get(title) ||
      (pid.startsWith('name:') ? byKey.get(pid.slice(5)) : null);
    const key = pid || title || pixel.productId;
    merged.set(key, {
      ...pixel,
      purchases: order?.purchases ?? pixel.purchases ?? 0,
      revenue: order?.revenue ?? pixel.revenue ?? 0,
      dataSource:
        (pixel.views || 0) > 0 || (pixel.addToCarts || 0) > 0 ? 'pixel' : 'orders',
    });
  }

  for (const order of orderProducts || []) {
    const pid = String(order.productId || '').toLowerCase();
    const title = String(order.title || '').toLowerCase().trim();
    const keys = [pid, title, pid.startsWith('name:') ? pid.slice(5) : null].filter(Boolean);
    const already = keys.some((k) => merged.has(k));
    if (!already && ((order.purchases || 0) > 0 || (order.revenue || 0) > 0)) {
      const key = pid || title || order.productId;
      merged.set(key, {
        ...order,
        views: order.views || 0,
        addToCarts: order.addToCarts || 0,
        checkoutsStarted: order.checkoutsStarted || 0,
        dataSource: 'orders',
      });
    }
  }

  return [...merged.values()];
}

async function zeroOrderStatsInRange(clientId, dateKeys) {
  if (!dateKeys?.length) return;
  await ProductDailyStat.updateMany(
    { clientId, date: { $in: dateKeys } },
    { $set: { purchases: 0, revenue: 0, updatedAt: new Date() } }
  );
}

async function mergeOrderPurchasesIntoStats(clientId, dateKeys) {
  if (!dateKeys.length) return;
  await zeroOrderStatsInRange(clientId, dateKeys);

  const { start: periodStart, end: periodEnd } = istDateRangeStrings(
    Math.max(1, dateKeys.length)
  );
  const start = startOfDayForDateStrIST(dateKeys[0] || periodStart);
  const end = endOfDayForDateStrIST(dateKeys[dateKeys.length - 1] || periodEnd);

  const rawOrders = await Order.find(
    buildProductInsightsOrderMatch(clientId, start, end)
  )
    .select(
      'createdAt items shopifyOrderId orderId orderNumber totalPrice amount financialStatus shippingAddress customerName customerPhone phone fulfillmentStatus isCOD'
    )
    .lean();

  const orders = dedupeOrdersByShopifyKey(rawOrders);
  const byDateProduct = new Map();

  for (const order of orders) {
    const d = dateKey(order.createdAt);
    if (!dateKeys.includes(d)) continue;
    for (const item of order.items || []) {
      const productId = productGroupKey(item);
      if (!productId) continue;
      const key = `${d}::${productId}`;
      if (!byDateProduct.has(key)) {
        byDateProduct.set(key, { purchases: 0, revenue: 0, title: item.name || '' });
      }
      const row = byDateProduct.get(key);
      const qty = Number(item.quantity) || 1;
      const price = parseFloat(item.price) || 0;
      row.purchases += qty;
      row.revenue += price * qty;
      if (item.name) row.title = item.name;
    }
  }

  const ops = [];
  for (const [key, row] of byDateProduct.entries()) {
    const [date, productId] = key.split('::');
    ops.push({
      updateOne: {
        filter: { clientId, date, productId },
        update: {
          $set: {
            purchases: row.purchases,
            revenue: row.revenue,
            updatedAt: new Date(),
            ...(row.title ? { title: row.title } : {}),
          },
          $setOnInsert: { clientId, date, productId },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) {
    await ProductDailyStat.bulkWrite(ops, { ordered: false });
  }
}

async function aggregateProductStats(clientId, days = 30) {
  const keys = dateRangeKeys(days);
  const since = moment(keys[0], 'YYYY-MM-DD').startOf('day').toDate();

  const rows = await ProductDailyStat.aggregate([
    { $match: { clientId, date: { $in: keys } } },
    {
      $group: {
        _id: '$productId',
        title: { $last: '$title' },
        handle: { $last: '$handle' },
        image: { $last: '$image' },
        views: { $sum: '$views' },
        addToCarts: { $sum: '$addToCarts' },
        checkoutsStarted: { $sum: '$checkoutsStarted' },
        purchases: { $sum: '$purchases' },
        revenue: { $sum: '$revenue' },
      },
    },
    { $sort: { views: -1, addToCarts: -1 } },
  ]);

  const totalViews = rows.reduce((s, r) => s + (r.views || 0), 0);
  const totalAtc = rows.reduce((s, r) => s + (r.addToCarts || 0), 0);
  const uniqueViewers = await countUniqueProductViewers(clientId, since);
  const viewToCartRate = totalViews > 0 ? Math.min(100, Math.round((totalAtc / totalViews) * 100)) : 0;

  const rankedRows =
    totalViews > 0
      ? rows
      : [...rows].sort(
          (a, b) =>
            (b.purchases || 0) - (a.purchases || 0) ||
            (b.revenue || 0) - (a.revenue || 0) ||
            (b.addToCarts || 0) - (a.addToCarts || 0)
        );

  const winningProducts = rankedRows.slice(0, 20).map((r, idx) => {
    const views = r.views || 0;
    const atc = r.addToCarts || 0;
    const purchases = r.purchases || 0;
    const hasPixelSignal = views > 0 || atc > 0;
    return {
      rank: idx + 1,
      productId: r._id,
      title: r.title || r.handle || 'Product',
      handle: r.handle || '',
      image: r.image || '',
      views,
      addToCarts: atc,
      purchases,
      revenue: r.revenue || 0,
      viewToCartRate: views > 0 ? Math.min(100, Math.round((atc / views) * 100)) : 0,
      isWinner: idx < 3 && (hasPixelSignal || purchases > 0),
      dataSource: hasPixelSignal ? 'pixel' : purchases > 0 ? 'orders' : 'pixel',
    };
  });

  const trendMap = new Map(keys.map((k) => [k, { date: k, views: 0, addToCarts: 0 }]));
  const dailyRows = await ProductDailyStat.aggregate([
    { $match: { clientId, date: { $in: keys } } },
    {
      $group: {
        _id: '$date',
        views: { $sum: '$views' },
        addToCarts: { $sum: '$addToCarts' },
      },
    },
  ]);
  for (const row of dailyRows) {
    if (trendMap.has(row._id)) {
      trendMap.set(row._id, { date: row._id, views: row.views || 0, addToCarts: row.addToCarts || 0 });
    }
  }

  const viewedNoCart = rows.filter((r) => (r.views || 0) > 0 && (r.addToCarts || 0) === 0).length;
  const addedNoCheckout = rows.filter((r) => (r.addToCarts || 0) > 0 && (r.checkoutsStarted || 0) === 0).length;
  const highViewsLowConversion = rows.filter((r) => {
    const views = r.views || 0;
    const atc = r.addToCarts || 0;
    return views >= 20 && views > 0 && (atc / views) * 100 < 2;
  }).length;

  return {
    rangeDays: Number(days) || 30,
    summary: {
      productViews: totalViews,
      uniqueViewers,
      addToCarts: totalAtc,
      viewToCartRate,
      ordersRevenue: rows.reduce((s, r) => s + (r.revenue || 0), 0),
    },
    winningProducts,
    trend: keys.map((k) => trendMap.get(k)),
    segments: {
      viewedNoCart: { count: viewedNoCart, label: 'Products viewed but never added to cart' },
      addedNoCheckout: { count: addedNoCheckout, label: 'Added to cart but never started checkout' },
      highViewsLowConversion: { count: highViewsLowConversion, label: 'High views, low add-to-cart rate' },
    },
  };
}

async function buildPixelHealthSnippet(clientId, days = 30) {
  const since = moment().subtract(Number(days) || 30, 'days').toDate();
  const fifteenMinAgo = moment().subtract(15, 'minutes').toDate();
  const { resolveTrackingInstallStatus } = require('./trackingInstallStatus');
  const [lastEvent, productViewEventsInRange, trackingStatus] = await Promise.all([
    PixelEvent.findOne({ clientId }).sort({ timestamp: -1 }).select('timestamp eventName').lean(),
    PixelEvent.countDocuments({
      clientId,
      eventName: 'product_view',
      timestamp: { $gte: since },
    }),
    resolveTrackingInstallStatus(clientId),
  ]);
  const eventsLive = Boolean(lastEvent && moment(lastEvent.timestamp).isAfter(fifteenMinAgo));
  return {
    eventsLive,
    trackingInstalled: trackingStatus.trackingInstalled,
    hasDbRegistration: trackingStatus.hasDbRegistration,
    webPixelOnShopify: trackingStatus.webPixelOnShopify,
    lastEventAt: lastEvent?.timestamp || null,
    lastEventName: lastEvent?.eventName || null,
    productViewEventsInRange,
    recordingProductViews: productViewEventsInRange > 0,
  };
}

async function reconcileProductStatsFromEvents(clientId, daysBack = 7) {
  const { start: periodStart } = istDateRangeStrings(daysBack);
  const since = startOfDayForDateStrIST(periodStart);
  const events = await PixelEvent.find({
    clientId,
    timestamp: { $gte: since },
    eventName: { $in: ['product_view', 'product_added_to_cart', 'add_to_cart', 'page_view'] },
  })
    .select('eventName url metadata timestamp')
    .lean();

  for (const ev of events) {
    const data = { ...(ev.metadata || {}), url: ev.url || ev.metadata?.url };
    if (ev.eventName === 'page_view') {
      await rollupProductEvent(clientId, 'page_view', data, { timestamp: ev.timestamp, url: data.url });
    } else {
      await rollupProductEvent(clientId, ev.eventName, data, { timestamp: ev.timestamp, url: data.url });
    }
  }

  const keys = dateRangeKeys(daysBack);
  await mergeOrderPurchasesIntoStats(clientId, keys);
  return { processed: events.length };
}

async function reconcileAllClientsProductStats(daysBack = 7) {
  const Client = require('../../models/Client');
  const { backfillAllClientsDerivedProductViews } = require('./productViewDerivation');
  const clients = await Client.find({
    isActive: { $ne: false },
    shopifyAccessToken: { $exists: true, $ne: null },
  })
    .select('clientId')
    .lean();

  let total = 0;
  for (const c of clients) {
    try {
      const result = await reconcileProductStatsFromEvents(c.clientId, daysBack);
      total += result.processed || 0;
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      log.warn(`reconcile failed for ${c.clientId}: ${err.message}`);
    }
  }
  log.info(`Product insights reconciliation done — ${total} events across ${clients.length} clients`);
  await backfillAllClientsDerivedProductViews(Math.min(Number(daysBack) || 7, 30));
  return { clients: clients.length, events: total };
}

function resolveProductInsightsDataMode({ hasStorefrontActivity, hasProductRollup, orderActive }) {
  if (hasProductRollup) return 'pixel_products';
  if (hasStorefrontActivity) return 'pixel_storefront';
  if (orderActive) return 'orders';
  return 'empty';
}

async function buildProductInsightsWorkspace(clientId, days = 30) {
  const keys = dateRangeKeys(days);
  const { start: periodStart, end: periodEnd } = istDateRangeStrings(days);
  const since = startOfDayForDateStrIST(periodStart);

  const [orderStats, pixelHealth, aggregatedInitial, storefrontBundle] = await Promise.all([
    aggregateOrderProductStats(clientId, days),
    buildPixelHealthSnippet(clientId, days),
    aggregateProductStats(clientId, days),
    buildStorefrontMetricsForPeriod(clientId, periodStart, periodEnd),
  ]);

  let aggregated = aggregatedInitial;
  const discoveryEvents = await countProductDiscoveryEvents(clientId, since);
  const storefrontFunnel = storefrontBundle.storefrontFunnel;
  const hasStorefrontActivity = storefrontBundle.hasActivity;
  const hasProductRollup =
    (aggregated.summary.productViews ?? 0) > 0 || (aggregated.summary.addToCarts ?? 0) > 0;

  if (hasStorefrontActivity && !hasProductRollup) {
    await reconcileProductStatsFromEvents(clientId, Math.min(Number(days) || 30, 30));
    aggregated = await aggregateProductStats(clientId, days);
  } else if ((aggregated.summary.productViews ?? 0) === 0 && discoveryEvents > 0) {
    await reconcileProductStatsFromEvents(clientId, Math.min(Number(days) || 30, 30));
    aggregated = await aggregateProductStats(clientId, days);
  }

  const hasProductRollupAfter =
    (aggregated.summary.productViews ?? 0) > 0 || (aggregated.summary.addToCarts ?? 0) > 0;
  const pixelActive = hasStorefrontActivity || hasProductRollupAfter;
  const orderActive = (orderStats.summary?.ordersRevenue ?? 0) > 0;

  let dataMode = resolveProductInsightsDataMode({
    hasStorefrontActivity,
    hasProductRollup: hasProductRollupAfter,
    orderActive,
  });

  let winningProducts = hasProductRollupAfter
    ? mergePixelWithOrderStats(aggregated.winningProducts, orderStats.winningProducts)
    : orderStats.winningProducts;

  const pageViewsKpi =
    hasProductRollupAfter && (aggregated.summary.productViews ?? 0) > 0
      ? aggregated.summary.productViews
      : storefrontFunnel.pageViewEvents;
  const cartAddsKpi =
    hasProductRollupAfter && (aggregated.summary.addToCarts ?? 0) > 0
      ? aggregated.summary.addToCarts
      : storefrontFunnel.addToCartEvents;
  const uniqueSessionsKpi = storefrontFunnel.storeVisitors || aggregated.summary.uniqueViewers || 0;
  const viewToCartRateKpi =
    hasProductRollupAfter && (aggregated.summary.viewToCartRate ?? 0) > 0
      ? aggregated.summary.viewToCartRate
      : pageViewsKpi > 0
        ? Math.round((cartAddsKpi / pageViewsKpi) * 100)
        : 0;

  const summary = {
    productViews: aggregated.summary.productViews ?? 0,
    uniqueViewers: aggregated.summary.uniqueViewers ?? 0,
    addToCarts: aggregated.summary.addToCarts ?? 0,
    viewToCartRate: aggregated.summary.viewToCartRate ?? 0,
    pageViews: pageViewsKpi,
    cartAdds: cartAddsKpi,
    checkoutStarted: storefrontFunnel.checkoutStartedEvents ?? 0,
    uniqueSessions: uniqueSessionsKpi,
    storefrontViewToCartRate: viewToCartRateKpi,
    ordersRevenue: orderStats.summary.ordersRevenue ?? 0,
    unitsSold: orderStats.summary.unitsSold ?? 0,
    productsWithSales: orderStats.summary.productsWithSales ?? 0,
    orderCount: orderStats.summary.orderCount ?? 0,
    periodStart: orderStats.summary.periodStart || periodStart,
    periodEnd: orderStats.summary.periodEnd || periodEnd,
    timezone: orderStats.summary.timezone || 'Asia/Kolkata',
  };

  winningProducts = await enrichProductsWithCatalog(clientId, winningProducts);

  const enrichedOrders = await enrichProductsWithCatalog(
    clientId,
    (orderStats.orderTopProducts || []).map((p) => ({
      productId: p.productId,
      title: p.name,
      name: p.name,
      image: p.image || '',
      purchases: p.sold,
      revenue: p.revenue,
    }))
  );

  winningProducts = mergeImagesFromOrderProducts(winningProducts, enrichedOrders);

  let trend = aggregated.trend || [];
  const trendHasSignal = trend.some((row) => (row.views ?? 0) > 0 || (row.addToCarts ?? 0) > 0);
  let trendSource = 'product_daily_stat';
  if (!trendHasSignal && pixelActive) {
    trend = await buildDailyStorefrontTrend(clientId, keys);
    trendSource = 'pixel_events';
  }

  const productSegments = hasProductRollupAfter ? aggregated.segments : null;

  return {
    rangeDays: Number(days) || 30,
    summary,
    winningProducts,
    trend,
    trendSource,
    segments: aggregated.segments,
    storefrontFunnel: {
      storeVisitors: storefrontFunnel.storeVisitors ?? 0,
      addToCart: storefrontFunnel.addToCart ?? 0,
      checkoutStarted: storefrontFunnel.checkoutStarted ?? 0,
      leftCheckout: storefrontFunnel.leftCheckout ?? 0,
    },
    productSegments,
    dataMode,
    pixelHealth: {
      ...pixelHealth,
      recordingStorefront: hasStorefrontActivity,
      recordingProductViews:
        pixelHealth.recordingProductViews || hasProductRollupAfter,
    },
    orderTopProducts: enrichedOrders.map((p) => ({
      name: p.title,
      revenue: p.revenue || 0,
      sold: p.purchases || 0,
      image: p.image || '',
      productId: p.productId || null,
    })),
    sampleMode: false,
    syncMeta: {
      discoveryEventsInRange: discoveryEvents,
      backfilled: hasProductRollupAfter && (discoveryEvents > 0 || hasStorefrontActivity),
      orderSource: 'live_orders_deduped',
      rawOrderDocs: orderStats.meta?.rawOrderDocs ?? null,
      dedupedOrderCount: orderStats.meta?.dedupedOrderCount ?? orderStats.summary?.orderCount,
      storefrontActivity: hasStorefrontActivity,
      productRollup: hasProductRollupAfter,
    },
  };
}

module.exports = {
  dateKey,
  dateRangeKeys,
  normalizeProductMeta,
  inferProductFromUrl,
  incrementProductStat,
  rollupProductEvent,
  aggregateProductStats,
  aggregateOrderProductStats,
  mergePixelWithOrderStats,
  buildPixelHealthSnippet,
  reconcileProductStatsFromEvents,
  reconcileAllClientsProductStats,
  buildProductInsightsWorkspace,
  resolveProductInsightsDataMode,
  buildProductInsightsOrderMatch,
  productGroupKey,
  zeroOrderStatsInRange,
  mergeOrderPurchasesIntoStats,
  enrichProductsWithCatalog,
  mergeImagesFromOrderProducts,
  countProductDiscoveryEvents,
};
