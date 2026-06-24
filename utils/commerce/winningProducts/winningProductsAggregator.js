'use strict';

const moment = require('moment');
const PixelEvent = require('../../../models/PixelEvent');
const AdLead = require('../../../models/AdLead');
const Client = require('../../../models/Client');
const ProductDailyStat = require('../../../models/ProductDailyStat');
const {
  aggregateOrderProductStats,
  mergePixelWithOrderStats,
  enrichProductsWithCatalog,
  mergeImagesFromOrderProducts,
  dateRangeKeys,
  countProductDiscoveryEvents,
} = require('../productInsightsRollup');
const {
  buildStorefrontMetricsForPeriod,
  funnelDropPct,
  metaReadinessTier,
  ADD_TO_CART_EVENTS,
} = require('../storefrontPixelMetrics');
const { istDateRangeStrings, startOfDayForDateStrIST } = require('../../core/queryHelpers');
const {
  getOrdersByStateInRange,
  getOrdersByCityInRange,
} = require('../ordersFilterAggregations');
const { computeVelocitiesBatch } = require('./velocityCalculator');
const {
  classifyProduct,
  medianRevenueOfTop,
  CLASSIFICATIONS,
} = require('./storyClassifier');
const {
  detectBottleneck,
  buildProductNarrative,
  buildSitewideLeakDiagnosis,
  buildComparisonInsights,
} = require('./narrativeBuilder');
const { recommendActions } = require('./actionRecommender');
const { buildRealtimeAlerts } = require('./realtimeAlerts');
const {
  buildSiteWideSourceBreakdown,
  buildProductSourceBreakdown,
} = require('./sourceAggregator');
const { PRODUCT_VIEW_MATCH_EXPR } = require('../productViewUrlUtils');

function interestScore(product) {
  const views = Number(product.stats?.views) || 0;
  const revenue = Number(product.stats?.revenue) || 0;
  const velocity = Number(product.velocity?.viewVelocity) || 1;
  const classBoost =
    product.classification === CLASSIFICATIONS.WINNING
      ? 1000
      : product.classification === CLASSIFICATIONS.RISING
        ? 800
        : product.classification === CLASSIFICATIONS.STALLED
          ? 600
          : 100;
  return views * velocity + revenue * 0.1 + classBoost;
}

async function computeDaysOfData(clientId) {
  const first = await PixelEvent.findOne({ clientId }).sort({ timestamp: 1 }).select('timestamp').lean();
  if (!first?.timestamp) return 0;
  return Math.floor((Date.now() - new Date(first.timestamp).getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

async function loadProductStatsWithCheckout(clientId, days, limit = 50) {
  const keys = dateRangeKeys(days);
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
        lastDate: { $max: '$date' },
      },
    },
    { $sort: { views: -1, addToCarts: -1, revenue: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({
    productId: r._id,
    title: r.title || r.handle || 'Product',
    handle: r.handle || '',
    image: r.image || '',
    views: r.views || 0,
    addToCarts: r.addToCarts || 0,
    checkoutsStarted: r.checkoutsStarted || 0,
    purchases: r.purchases || 0,
    revenue: r.revenue || 0,
    viewToCartRate: r.views > 0 ? Math.min(100, Math.round((r.addToCarts / r.views) * 100)) : 0,
    lastDate: r.lastDate,
  }));
}

async function buildPerProductAudienceMetrics(clientId, since, productIds) {
  const sessionEvents = await PixelEvent.aggregate([
    {
      $match: {
        clientId,
        timestamp: { $gte: since },
        eventName: { $in: [...ADD_TO_CART_EVENTS, 'checkout_started', 'checkout_completed', 'product_view'] },
      },
    },
    {
      $addFields: {
        visitorKey: {
          $ifNull: ['$sessionId', { $ifNull: ['$metadata.visitorId', '$metadata.shopifyClientId'] }],
        },
        pid: {
          $ifNull: [
            '$metadata.product.productId',
            { $ifNull: ['$metadata.product.id', null] },
          ],
        },
        handle: { $ifNull: ['$metadata.product.handle', null] },
      },
    },
    { $match: { visitorKey: { $ne: null } } },
    {
      $group: {
        _id: { visitorKey: '$visitorKey', pid: '$pid', handle: '$handle' },
        events: { $addToSet: '$eventName' },
      },
    },
  ]);

  const map = new Map();
  for (const id of productIds) map.set(String(id), 0);

  for (const row of sessionEvents) {
    const pid = row._id.pid || (row._id.handle ? `handle:${row._id.handle}` : null);
    if (!pid || !map.has(String(pid))) continue;
    const ev = new Set(row.events || []);
    const hasAtc = [...ev].some((e) => ADD_TO_CART_EVENTS.has(e));
    const hasPurchase = ev.has('checkout_completed');
    if (hasAtc && !hasPurchase) {
      map.set(String(pid), (map.get(String(pid)) || 0) + 1);
    }
  }
  return map;
}

async function buildPastPurchaserAudience(clientId, since) {
  const [count, withPhone, withEmail] = await Promise.all([
    AdLead.countDocuments({
      clientId,
      $or: [{ cartStatus: 'purchased' }, { isOrderPlaced: true }],
      updatedAt: { $gte: since },
    }),
    AdLead.countDocuments({
      clientId,
      $or: [{ cartStatus: 'purchased' }, { isOrderPlaced: true }],
      updatedAt: { $gte: since },
      phoneNumber: { $exists: true, $nin: [null, ''] },
    }),
    AdLead.countDocuments({
      clientId,
      $or: [{ cartStatus: 'purchased' }, { isOrderPlaced: true }],
      updatedAt: { $gte: since },
      email: { $exists: true, $nin: [null, ''] },
    }),
  ]);
  return { count, withPhone, withEmail };
}

async function buildDailyAudienceTrend(clientId, dateKeys) {
  if (!dateKeys?.length) return [];
  const start = startOfDayForDateStrIST(dateKeys[0]);
  const end = moment(dateKeys[dateKeys.length - 1], 'YYYY-MM-DD').endOf('day').toDate();

  const rows = await PixelEvent.aggregate([
    { $match: { clientId, timestamp: { $gte: start, $lte: end } } },
    {
      $addFields: {
        day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'Asia/Kolkata' } },
        visitorKey: {
          $ifNull: ['$sessionId', { $ifNull: ['$metadata.visitorId', '$metadata.shopifyClientId'] }],
        },
      },
    },
    { $match: { visitorKey: { $ne: null } } },
    {
      $addFields: {
        countsAsProductView: { $cond: [PRODUCT_VIEW_MATCH_EXPR, 1, 0] },
      },
    },
    {
      $group: {
        _id: { day: '$day', visitorKey: '$visitorKey' },
        events: { $addToSet: '$eventName' },
        hasProductView: { $max: '$countsAsProductView' },
      },
    },
  ]);

  const byDay = new Map(
    dateKeys.map((d) => [
      d,
      {
        storeVisitors: new Set(),
        productViewers: new Set(),
        cartAbandoners: new Set(),
        checkoutAbandoners: new Set(),
        pastPurchasers: new Set(),
      },
    ])
  );

  for (const row of rows) {
    const day = row._id.day;
    const bucket = byDay.get(day);
    if (!bucket) continue;
    const ev = new Set(row.events || []);
    const key = row._id.visitorKey;
    if (ev.has('page_view')) bucket.storeVisitors.add(key);
    if (ev.has('product_view') || Number(row.hasProductView) > 0) bucket.productViewers.add(key);
    const hasAtc = [...ev].some((e) => ADD_TO_CART_EVENTS.has(e));
    const hasCheckout = ev.has('checkout_started');
    const hasComplete = ev.has('checkout_completed');
    if (hasAtc && !hasCheckout) bucket.cartAbandoners.add(key);
    if (hasCheckout && !hasComplete) bucket.checkoutAbandoners.add(key);
    if (hasComplete) bucket.pastPurchasers.add(key);
  }

  let cumVisitors = 0;
  let cumProduct = 0;
  let cumCart = 0;
  let cumCheckout = 0;
  let cumPurchasers = 0;

  return dateKeys.map((date) => {
    const b = byDay.get(date) || {
      storeVisitors: new Set(),
      productViewers: new Set(),
      cartAbandoners: new Set(),
      checkoutAbandoners: new Set(),
      pastPurchasers: new Set(),
    };
    cumVisitors += b.storeVisitors.size;
    cumProduct += b.productViewers.size;
    cumCart += b.cartAbandoners.size;
    cumCheckout += b.checkoutAbandoners.size;
    cumPurchasers += b.pastPurchasers.size;
    return {
      date,
      storeVisitors: cumVisitors,
      productViewers: cumProduct,
      cartAbandoners: cumCart,
      checkoutAbandoners: cumCheckout,
      pastPurchasers: cumPurchasers,
    };
  });
}

function applyViewEstimate(stats) {
  const views = Number(stats?.views) || 0;
  const atc = Number(stats?.addToCarts) || 0;
  const purchases = Number(stats?.purchases) || 0;
  if (views > 0) return stats;
  if (atc > 0 || purchases > 0) {
    const estimatedViews = Math.max(atc, purchases);
    return {
      ...stats,
      views: estimatedViews,
      viewsEstimated: true,
      conversionRate:
        estimatedViews > 0
          ? Math.round((purchases / estimatedViews) * 10000) / 100
          : stats.conversionRate,
    };
  }
  return stats;
}

function buildAudienceCard(seg, extras = {}) {
  const tier = seg?.tier || metaReadinessTier(seg?.count || 0).tier;
  return {
    count: seg?.count ?? 0,
    tier,
    canRetarget: (seg?.count ?? 0) >= 100,
    recommended: (seg?.count ?? 0) >= 1000,
    ...extras,
  };
}

function withRegionShare(rows, totalOrders, limit = 15) {
  return (rows || []).slice(0, limit).map((row) => ({
    state: row.state,
    city: row.city,
    orderCount: row.orderCount || 0,
    totalRevenue: Math.round(row.totalRevenue || 0),
    sharePct:
      totalOrders > 0 ? Math.round(((row.orderCount || 0) / totalOrders) * 1000) / 10 : 0,
  }));
}

async function buildOrderRegions(clientId, periodStart, periodEnd, ordersInPeriod = 0) {
  const since = startOfDayForDateStrIST(periodStart);
  const end = startOfDayForDateStrIST(periodEnd);
  end.setHours(23, 59, 59, 999);
  const [stateRows, cityRows] = await Promise.all([
    getOrdersByStateInRange(clientId, since, end),
    getOrdersByCityInRange(clientId, since, end),
  ]);
  const totalOrders = stateRows.reduce((sum, row) => sum + (row.orderCount || 0), 0);
  return {
    states: withRegionShare(stateRows, totalOrders),
    cities: withRegionShare(cityRows, totalOrders),
    totalOrders,
    orderCountInPeriod: ordersInPeriod,
    ordersWithRegion: totalOrders,
    emptyReason:
      ordersInPeriod === 0
        ? 'no_orders'
        : totalOrders === 0
          ? 'no_shipping_address'
          : null,
    period: { start: periodStart, end: periodEnd, timezone: 'Asia/Kolkata' },
    source: 'order_shipping_address',
  };
}

function resolveDataQuality(daysOfData) {
  if (daysOfData < 3) {
    return {
      sampleSize: 'low',
      daysOfData,
      confidence: 'low',
      warning: 'Building your insights — come back in 3 days for reliable signal.',
    };
  }
  if (daysOfData < 7) {
    return {
      sampleSize: 'low',
      daysOfData,
      confidence: 'low',
      warning: 'Only a few days of data — wait for 7+ days for reliable classifications.',
    };
  }
  if (daysOfData < 14) {
    return { sampleSize: 'medium', daysOfData, confidence: 'medium', warning: null };
  }
  return { sampleSize: 'high', daysOfData, confidence: 'high', warning: null };
}

async function buildWinningProductsWorkspace(clientId, days = 30) {
  const rangeDays = Math.min(90, Math.max(7, Number(days) || 30));
  const { start: periodStart, end: periodEnd } = istDateRangeStrings(rangeDays);
  const since = startOfDayForDateStrIST(periodStart);
  const keys = dateRangeKeys(rangeDays);

  const [client, orderStats, pixelRowsInitial, storefrontBundle, daysOfData, siteSources, discoveryEvents] =
    await Promise.all([
      Client.findOne({ clientId })
        .select('shopDomain brandName insightsState insightsNotifications')
        .lean(),
      aggregateOrderProductStats(clientId, rangeDays),
      loadProductStatsWithCheckout(clientId, rangeDays, 50),
      buildStorefrontMetricsForPeriod(clientId, periodStart, periodEnd),
      computeDaysOfData(clientId),
      buildSiteWideSourceBreakdown(clientId, periodStart, periodEnd),
      countProductDiscoveryEvents(clientId, since),
    ]);

  let pixelRows = pixelRowsInitial;
  const hasPixelRollup = pixelRows.some((r) => (r.views || 0) > 0 || (r.addToCarts || 0) > 0);
  const needsPixelReconcile =
    (storefrontBundle.hasActivity || discoveryEvents > 0) &&
    (!hasPixelRollup || discoveryEvents > pixelRows.reduce((s, r) => s + (r.views || 0), 0));

  if (needsPixelReconcile) {
    const { reconcileProductStatsFromEvents } = require('../productInsightsRollup');
    const { backfillDerivedProductViews } = require('../productViewDerivation');
    await backfillDerivedProductViews(clientId, Math.min(rangeDays, 30));
    await reconcileProductStatsFromEvents(clientId, Math.min(rangeDays, 30));
    pixelRows = await loadProductStatsWithCheckout(clientId, rangeDays, 50);
  }

  let merged = pixelRows.length
    ? mergePixelWithOrderStats(
        pixelRows.map((r, idx) => ({ ...r, rank: idx + 1, dataSource: 'pixel' })),
        orderStats.winningProducts || []
      )
    : orderStats.winningProducts || [];

  merged = await enrichProductsWithCatalog(clientId, merged);
  merged = mergeImagesFromOrderProducts(merged, orderStats.orderTopProducts || []);

  const medianRev = medianRevenueOfTop(merged);
  const productIds = merged.map((p) => p.productId).filter(Boolean);
  const [perProductAudience, pastPurchasers, velocityMap] = await Promise.all([
    buildPerProductAudienceMetrics(clientId, since, productIds),
    buildPastPurchaserAudience(clientId, since),
    computeVelocitiesBatch(clientId, productIds, rangeDays),
  ]);

  const avgOrderValue =
    (orderStats.summary?.orderCount || 0) > 0
      ? (orderStats.summary?.ordersRevenue || 0) / orderStats.summary.orderCount
      : 500;

  const sourceCandidates = merged.filter((r) => (r.views || 0) >= 10).slice(0, 25);
  const sourceEntries = await Promise.all(
    sourceCandidates.map(async (row) => {
      const sources = await buildProductSourceBreakdown(clientId, row.productId, periodStart, periodEnd);
      return [String(row.productId), sources];
    })
  );
  const sourcesByProduct = new Map(sourceEntries);

  const enrichedProducts = [];
  for (const row of merged) {
    const velocity = velocityMap.get(String(row.productId)) || velocityMap.get(row.productId) || {
      prevWeek: { views: 0, addToCarts: 0, purchases: 0, revenue: 0 },
      viewsDelta: 0,
      addToCartsDelta: 0,
      purchasesDelta: 0,
      revenueDelta: 0,
      viewVelocity: 0,
    };
    const statsRaw = {
      views: row.views || 0,
      viewsPrev: velocity.prevWeek.views,
      viewsDelta: velocity.viewsDelta,
      addToCarts: row.addToCarts || 0,
      addToCartsPrev: velocity.prevWeek.addToCarts,
      addToCartsDelta: velocity.addToCartsDelta,
      checkoutStarts: row.checkoutsStarted || 0,
      purchases: row.purchases || 0,
      purchasesPrev: velocity.prevWeek.purchases,
      purchasesDelta: velocity.purchasesDelta,
      revenue: row.revenue || 0,
      revenueDelta: velocity.revenueDelta,
      conversionRate:
        row.views > 0 ? Math.round(((row.purchases || 0) / row.views) * 10000) / 100 : 0,
      avgOrderValue: (row.purchases || 0) > 0 ? Math.round((row.revenue || 0) / row.purchases) : 0,
    };
    const stats = applyViewEstimate(statsRaw);

    const funnel = {
      views: stats.views,
      addToCart: stats.addToCarts,
      checkout: stats.checkoutStarts,
      purchase: stats.purchases,
      drops: [
        { from: 'views', to: 'addToCart', dropPercent: funnelDropPct(stats.views, stats.addToCarts) },
        { from: 'addToCart', to: 'checkout', dropPercent: funnelDropPct(stats.addToCarts, stats.checkoutStarts) },
        { from: 'checkout', to: 'purchase', dropPercent: funnelDropPct(stats.checkoutStarts, stats.purchases) },
      ],
    };

    const cartAbandoners = perProductAudience.get(String(row.productId)) || 0;
    const retargetTier = metaReadinessTier(cartAbandoners).tier;

    const daysSinceLastEvent = row.lastDate
      ? moment().diff(moment(row.lastDate, 'YYYY-MM-DD'), 'days')
      : null;

    const classification = classifyProduct({
      stats,
      velocity,
      daysOfData,
      daysSinceLastEvent,
      medianTopRevenue: medianRev,
    });

    const bottleneck = detectBottleneck(funnel);
    const narrative = buildProductNarrative({
      product: row,
      stats,
      classification,
      funnel,
      velocity,
      days: rangeDays,
      retargetableCount: cartAbandoners,
      avgOrderValue,
    });

    const sources = sourcesByProduct.get(String(row.productId)) || null;

    enrichedProducts.push({
      productId: row.productId,
      title: row.title,
      handle: row.handle,
      image: row.image,
      classification,
      narrative,
      stats,
      funnel,
      bottleneck,
      retargetableAudience: {
        cartAbandoners,
        retargetableTier: retargetTier,
      },
      recommendedActions: recommendActions({
        product: row,
        classification,
        bottleneck,
        shopDomain: client?.shopDomain,
        retargetableCount: cartAbandoners,
      }),
      sources,
      velocity,
    });
  }

  enrichedProducts.sort((a, b) => interestScore(b) - interestScore(a));

  const scoreboard = {
    winners: {
      count: enrichedProducts.filter((p) => p.classification === CLASSIFICATIONS.WINNING).length,
      top3: enrichedProducts
        .filter((p) => p.classification === CLASSIFICATIONS.WINNING)
        .slice(0, 3)
        .map((p) => ({ productId: p.productId, title: p.title, image: p.image })),
    },
    rising: {
      count: enrichedProducts.filter((p) => p.classification === CLASSIFICATIONS.RISING).length,
      top3: enrichedProducts
        .filter((p) => p.classification === CLASSIFICATIONS.RISING)
        .slice(0, 3)
        .map((p) => ({ productId: p.productId, title: p.title, image: p.image })),
    },
    dying: {
      count: enrichedProducts.filter((p) => p.classification === CLASSIFICATIONS.DYING).length,
      top3: enrichedProducts
        .filter((p) => p.classification === CLASSIFICATIONS.DYING)
        .slice(0, 3)
        .map((p) => ({ productId: p.productId, title: p.title, image: p.image })),
    },
  };

  const segs = storefrontBundle.audiences?.segments || {};
  const cartAbandonersCount =
    (segs.cartOnly?.count || 0) + (segs.checkoutAbandoned?.count || 0);

  const [cartWithPhone, cartWithEmail] = await Promise.all([
    AdLead.countDocuments({
      clientId,
      cartStatus: { $in: ['abandoned', 'active'] },
      cartAbandonedAt: { $gte: since },
      phoneNumber: { $exists: true, $nin: [null, ''] },
    }),
    AdLead.countDocuments({
      clientId,
      cartStatus: { $in: ['abandoned', 'active'] },
      cartAbandonedAt: { $gte: since },
      email: { $exists: true, $nin: [null, ''] },
    }),
  ]);

  const sf = storefrontBundle.storefrontFunnel || {};
  const visitors = sf.storeVisitors || 0;
  const productViews = segs.productViewers?.count ?? 0;
  const addToCarts = sf.addToCart || 0;
  const checkouts = sf.checkoutStarted || 0;
  const purchases =
    orderStats.summary?.orderCount ??
    storefrontBundle.audiences?.checkoutCompletedEvents ??
    0;

  const hasProductRollup = pixelRows.some((r) => (r.views || 0) > 0 || (r.addToCarts || 0) > 0);
  let dataMode = 'empty';
  if (hasProductRollup) dataMode = 'pixel_products';
  else if (storefrontBundle.hasActivity) dataMode = 'pixel_storefront';
  else if ((orderStats.summary?.orderCount || 0) > 0) dataMode = 'orders';

  let rollupWarning = null;
  if (!hasProductRollup && discoveryEvents > 0 && storefrontBundle.hasActivity) {
    rollupWarning =
      'Product SKU rollup is still building — rankings may update after nightly sync or open Product Insights once.';
  }

  const audiencePayload = {
    storeVisitors: buildAudienceCard(segs.uniqueVisitors || metaReadinessTier(visitors)),
    productViewers: buildAudienceCard(segs.productViewers || metaReadinessTier(0)),
    cartAbandoners: buildAudienceCard(metaReadinessTier(cartAbandonersCount), {
      hasPhone: cartWithPhone,
      hasEmail: cartWithEmail,
      estimatedRecovery: Math.round(cartAbandonersCount * avgOrderValue * 0.15),
    }),
    checkoutAbandoners: buildAudienceCard(segs.checkoutAbandoned || metaReadinessTier(0)),
    pastPurchasers: buildAudienceCard(metaReadinessTier(pastPurchasers.count), {
      hasPhone: pastPurchasers.withPhone,
      hasEmail: pastPurchasers.withEmail,
    }),
  };

  const alerts = buildRealtimeAlerts(enrichedProducts, audiencePayload, client?.insightsState);
  const dashboardAlertsEnabled = client?.insightsNotifications?.channels?.dashboard !== false;

  const dataQuality = resolveDataQuality(daysOfData);
  if (rollupWarning && !dataQuality.warning) {
    dataQuality.warning = rollupWarning;
  }

  const sitewideDrops = [
    { from: 'visitors', to: 'productViews', dropPercent: funnelDropPct(visitors, productViews) },
    { from: 'productViews', to: 'addToCarts', dropPercent: funnelDropPct(productViews, addToCarts) },
    { from: 'addToCarts', to: 'checkouts', dropPercent: funnelDropPct(addToCarts, checkouts) },
    { from: 'checkouts', to: 'purchases', dropPercent: funnelDropPct(checkouts, purchases) },
  ];

  const pixelFunnelEvents =
    (visitors || 0) + (productViews || 0) + (addToCarts || 0) + (checkouts || 0);
  const mixedData =
    purchases > checkouts ||
    checkouts > addToCarts ||
    (addToCarts > productViews && productViews === 0 && purchases > 0);
  const sparseFunnel = pixelFunnelEvents < 5;
  const mixedDataNote = mixedData
    ? 'Orders come from Shopify; funnel steps come from pixel tracking. Install the pixel on all pages for an accurate funnel.'
    : null;

  const audienceTrend = await buildDailyAudienceTrend(clientId, keys);
  const regions = await buildOrderRegions(
    clientId,
    periodStart,
    periodEnd,
    orderStats.summary?.orderCount || 0
  );

  const trackingInstalled = Boolean(storefrontBundle.hasActivity) || daysOfData > 0;
  const productRevenueSum = enrichedProducts.reduce(
    (sum, p) => sum + (Number(p.stats?.revenue) || 0),
    0
  );
  const ordersRevenue = Math.round(
    Math.max(Number(orderStats.summary?.ordersRevenue) || 0, productRevenueSum)
  );
  const orderCount = purchases || orderStats.summary?.orderCount || 0;

  const estimatedProductViews = enrichedProducts.reduce((sum, p) => {
    if (p.stats?.viewsEstimated) return sum + (p.stats?.views || 0);
    return sum + (p.stats?.views || 0);
  }, 0);
  const summaryProductViews =
    productViews > 0 ? productViews : estimatedProductViews > 0 ? estimatedProductViews : productViews;

  return {
    rangeDays,
    period: { start: periodStart, end: periodEnd, timezone: 'Asia/Kolkata' },
    brandName: client?.brandName || client?.shopDomain || 'your store',
    scoreboard,
    products: enrichedProducts,
    audiences: audiencePayload,
    audienceTrend,
    alerts: dashboardAlertsEnabled ? alerts : [],
    sitewideFunnel: {
      visitors,
      productViews,
      productViewLabel: 'Product viewers',
      addToCarts,
      checkouts,
      purchases,
      purchaseLabel: 'Orders',
      drops: sitewideDrops,
      biggestLeak: sparseFunnel ? null : buildSitewideLeakDiagnosis(sitewideDrops.filter((d) => d.dropPercent != null)),
      steps: [
        { key: 'visitors', label: 'Store visitors', value: visitors, source: 'pixel' },
        { key: 'productViews', label: 'Product viewers', value: productViews, source: 'pixel' },
        { key: 'addToCarts', label: 'Cart adds', value: addToCarts, source: 'pixel' },
        { key: 'checkouts', label: 'Checkout started', value: checkouts, source: 'pixel' },
        { key: 'purchases', label: 'Orders', value: purchases, source: 'shopify' },
      ],
      mixedData,
      mixedDataNote,
      sparse: sparseFunnel,
      sparseSummary:
        sparseFunnel && orderCount > 0
          ? { orders: orderCount, revenue: ordersRevenue }
          : null,
      pixelEventCount: pixelFunnelEvents,
    },
    sources: siteSources.total > 0 ? siteSources.breakdown : null,
    pixelHealth: {
      installed: trackingInstalled,
      eventsLive: daysOfData > 0,
      daysOfData,
      hasUtmData: siteSources.hasUtmData,
      hasReferrerData: siteSources.hasReferrerData,
    },
    dataQuality,
    dataMode,
    discoveryEventsInRange: discoveryEvents,
    avgOrderValue: Math.round(avgOrderValue),
    sampleMode: false,
    regions,
    summary: {
      orderCount,
      ordersRevenue,
      productViews: summaryProductViews,
      productViewsEstimated: productViews === 0 && estimatedProductViews > 0,
      cartAdds: addToCarts,
      checkoutStarted: checkouts,
      uniqueSessions: visitors,
      periodStart,
      periodEnd,
    },
    winningProducts: enrichedProducts,
  };
}

function buildWinningProductsCompareFromWorkspace(workspace, productIds) {
  const idSet = new Set((productIds || []).map(String));
  const products = (workspace?.products || []).filter((p) => idSet.has(String(p.productId)));
  return {
    rangeDays: workspace?.rangeDays,
    period: workspace?.period,
    products,
    insights: buildComparisonInsights(products),
  };
}

async function buildWinningProductsCompare(clientId, productIds, days = 30, cachedWorkspace = null) {
  const workspace = cachedWorkspace || (await buildWinningProductsWorkspace(clientId, days));
  return buildWinningProductsCompareFromWorkspace(workspace, productIds);
}

module.exports = {
  buildWinningProductsWorkspace,
  buildWinningProductsCompare,
  buildWinningProductsCompareFromWorkspace,
  interestScore,
  loadProductStatsWithCheckout,
};
