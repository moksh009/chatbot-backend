'use strict';

const PixelEvent = require('../../models/PixelEvent');
const AdLead = require('../../models/AdLead');
const moment = require('moment');
const { startOfDayForDateStrIST, endOfDayForDateStrIST } = require('../core/queryHelpers');
const { PRODUCT_VIEW_MATCH_EXPR } = require('./productViewUrlUtils');

const ADD_TO_CART_EVENT_NAMES = ['product_added_to_cart', 'add_to_cart'];
const ADD_TO_CART_EVENTS = new Set(ADD_TO_CART_EVENT_NAMES);

function sinceFromIstPeriod(periodStart, periodEnd) {
  return startOfDayForDateStrIST(periodStart);
}

function untilFromIstPeriod(periodEnd) {
  return endOfDayForDateStrIST(periodEnd);
}

async function countUniqueCheckoutContacts(clientId, since) {
  return AdLead.countDocuments({
    clientId,
    phoneNumber: { $exists: true, $nin: [null, ''], $not: /^unknown_checkout_/ },
    $or: [
      { contactCapturedAt: { $gte: since } },
      { cartAbandonedAt: { $gte: since } },
      { abandonedCartRecoveredAt: { $gte: since } },
      { lastCartEventAt: { $gte: since } },
      { updatedAt: { $gte: since } },
    ],
  });
}

async function buildCheckoutFunnelMetrics(clientId, since) {
  const [
    pageViews,
    addToCart,
    checkoutStarted,
    contactCaptureEvents,
    uniqueCheckoutContacts,
    abandoned,
    recovered,
  ] = await Promise.all([
    PixelEvent.countDocuments({
      clientId,
      eventName: 'page_view',
      timestamp: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: { $in: ADD_TO_CART_EVENT_NAMES },
      timestamp: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: 'checkout_started',
      timestamp: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: {
        $in: ['checkout_contact_identified', 'checkout_contact_info_submitted', 'contact_identified'],
      },
      timestamp: { $gte: since },
    }),
    countUniqueCheckoutContacts(clientId, since),
    AdLead.countDocuments({
      clientId,
      cartStatus: { $in: ['abandoned', 'active'] },
      cartAbandonedAt: { $gte: since },
    }),
    AdLead.countDocuments({
      clientId,
      $or: [
        { cartStatus: 'recovered' },
        { cartStatus: 'purchased', abandonedCartRecoveredAt: { $exists: true, $gte: since } },
      ],
      updatedAt: { $gte: since },
    }),
  ]);

  const conversionRate =
    checkoutStarted > 0
      ? Math.min(100, Math.round((uniqueCheckoutContacts / checkoutStarted) * 100))
      : pageViews > 0
        ? Math.min(100, Math.round((uniqueCheckoutContacts / pageViews) * 100))
        : 0;

  return {
    pageViews,
    addToCart,
    checkoutStarted,
    contactIdentified: uniqueCheckoutContacts,
    uniqueCheckoutContacts,
    contactCaptureEvents,
    cartLeadsCount: uniqueCheckoutContacts,
    abandoned,
    recovered,
    conversionRate,
  };
}

function metaReadinessTier(count) {
  const n = Number(count) || 0;
  return {
    count: n,
    canRetarget: n >= 100,
    recommended: n >= 1000,
    tier: n >= 1000 ? 'strong' : n >= 100 ? 'minimum' : 'build',
  };
}

function funnelDropPct(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  if (f <= 0) return null;
  if (t > f) return null;
  return Math.max(0, Math.round((1 - t / f) * 100));
}

async function buildRetargetingAudienceMetrics(clientId, since, windowDays = 30) {
  const sessionEvents = await PixelEvent.aggregate([
    {
      $match: {
        clientId,
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
              scid: { $ifNull: ['$metadata.shopifyClientId', ''] },
              ctok: { $ifNull: ['$metadata.checkoutToken', ''] },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: { $toString: '$$sid' } }, 0] },
                { $concat: ['sid:', { $toString: '$$sid' }] },
                {
                  $cond: [
                    { $gt: [{ $strLenCP: { $toString: '$$vid' } }, 0] },
                    { $concat: ['vid:', { $toString: '$$vid' }] },
                    {
                      $cond: [
                        { $gt: [{ $strLenCP: { $toString: '$$scid' } }, 0] },
                        { $concat: ['sc:', { $toString: '$$scid' }] },
                        {
                          $cond: [
                            { $gt: [{ $strLenCP: { $toString: '$$ctok' } }, 0] },
                            { $concat: ['ct:', { $toString: '$$ctok' }] },
                            null,
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
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
        _id: '$visitorKey',
        events: { $addToSet: '$eventName' },
        hasProductView: { $max: '$countsAsProductView' },
      },
    },
  ]);

  const [pageViewEvents, addToCartEvents, checkoutStartedEvents, checkoutCompletedEvents] =
    await Promise.all([
      PixelEvent.countDocuments({
        clientId,
        eventName: 'page_view',
        timestamp: { $gte: since },
      }),
      PixelEvent.countDocuments({
        clientId,
        eventName: { $in: ADD_TO_CART_EVENT_NAMES },
        timestamp: { $gte: since },
      }),
      PixelEvent.countDocuments({
        clientId,
        eventName: 'checkout_started',
        timestamp: { $gte: since },
      }),
      PixelEvent.countDocuments({
        clientId,
        eventName: 'checkout_completed',
        timestamp: { $gte: since },
      }),
    ]);

  let uniqueVisitors = 0;
  let productViewers = 0;
  let addToCart = 0;
  let checkoutStarted = 0;
  let checkoutCompleted = 0;
  let checkoutAbandoned = 0;
  let cartOnly = 0;

  for (const row of sessionEvents) {
    const ev = new Set(row.events || []);
    const hasProduct = ev.has('product_view') || Number(row.hasProductView) > 0;
    const hasPage = ev.has('page_view');
    const hasAtc = [...ev].some((e) => ADD_TO_CART_EVENTS.has(e));
    const hasStarted = ev.has('checkout_started');
    const hasCompleted = ev.has('checkout_completed');

    if (hasPage) uniqueVisitors += 1;
    if (hasProduct) productViewers += 1;
    if (hasAtc) addToCart += 1;
    if (hasStarted) checkoutStarted += 1;
    if (hasCompleted) checkoutCompleted += 1;
    if (hasStarted && !hasCompleted) checkoutAbandoned += 1;
    if (hasAtc && !hasStarted) cartOnly += 1;
  }

  const segments = {
    uniqueVisitors: metaReadinessTier(uniqueVisitors),
    productViewers: metaReadinessTier(productViewers),
    addToCart: metaReadinessTier(addToCart),
    checkoutStarted: metaReadinessTier(checkoutStarted),
    checkoutAbandoned: metaReadinessTier(checkoutAbandoned),
    cartOnly: metaReadinessTier(cartOnly),
  };

  const funnelDropoffs = {
    visitorsToCart: funnelDropPct(uniqueVisitors, addToCart),
    cartToCheckout: funnelDropPct(addToCart, checkoutStarted),
    checkoutToComplete: funnelDropPct(checkoutStarted, checkoutCompleted),
  };

  let insightSegment = 'addToCart';
  let insightCount = addToCart;
  if (checkoutAbandoned >= insightCount) {
    insightSegment = 'checkoutAbandoned';
    insightCount = checkoutAbandoned;
  }
  if (cartOnly > insightCount) {
    insightSegment = 'cartOnly';
    insightCount = cartOnly;
  }

  return {
    windowDays: Number(windowDays) || 30,
    segments,
    funnelDropoffs,
    insight: { segment: insightSegment, count: insightCount },
    pageViewEvents,
    addToCartEvents,
    checkoutStartedEvents,
    checkoutCompletedEvents,
    uniqueSessionCount: sessionEvents.length,
  };
}

function enrichRetargetingDisplay(audiences, funnel) {
  if (!audiences) return null;
  const segs = audiences.segments || {};
  const uVisitors = segs.uniqueVisitors?.count ?? 0;
  const uAtc = segs.addToCart?.count ?? 0;
  const uCheckout = segs.checkoutStarted?.count ?? 0;
  const uAbandoned = segs.checkoutAbandoned?.count ?? 0;

  const pageViews = audiences.pageViewEvents ?? funnel?.pageViews ?? 0;
  const atcRaw = audiences.addToCartEvents ?? funnel?.addToCart ?? 0;
  const checkoutRaw = audiences.checkoutStartedEvents ?? funnel?.checkoutStarted ?? 0;
  const completedRaw = audiences.checkoutCompletedEvents ?? 0;
  const leftRaw = Math.max(0, checkoutRaw - completedRaw);

  const pick = (unique, raw, preferRawLabel) => {
    if (unique > 0) return { count: unique, basis: 'sessions' };
    if (raw > 0) return { count: raw, basis: preferRawLabel || 'events' };
    return { count: 0, basis: 'sessions' };
  };

  const storeVisitors = pick(uVisitors, pageViews, 'page_views');
  const addToCart = pick(uAtc, atcRaw, 'events');
  const checkoutStarted = pick(uCheckout, checkoutRaw, 'events');
  const leftCheckout = pick(uAbandoned, leftRaw, 'events');

  return {
    ...audiences,
    display: {
      storeVisitors,
      addToCart,
      checkoutStarted,
      leftCheckout,
    },
  };
}

function buildStorefrontFunnelSummary(audiences, funnel) {
  const enriched = enrichRetargetingDisplay(audiences, funnel);
  const display = enriched?.display || {};
  return {
    storeVisitors: display.storeVisitors?.count ?? 0,
    addToCart: display.addToCart?.count ?? 0,
    checkoutStarted: display.checkoutStarted?.count ?? 0,
    leftCheckout: display.leftCheckout?.count ?? 0,
    pageViewEvents: audiences?.pageViewEvents ?? funnel?.pageViews ?? 0,
    addToCartEvents: audiences?.addToCartEvents ?? funnel?.addToCart ?? 0,
    checkoutStartedEvents: audiences?.checkoutStartedEvents ?? funnel?.checkoutStarted ?? 0,
    uniqueSessionCount: audiences?.uniqueSessionCount ?? 0,
  };
}

async function buildDailyStorefrontTrend(clientId, dateKeys) {
  if (!dateKeys?.length) return [];
  const start = startOfDayForDateStrIST(dateKeys[0]);
  const end = endOfDayForDateStrIST(dateKeys[dateKeys.length - 1]);

  const rows = await PixelEvent.aggregate([
    {
      $match: {
        clientId,
        timestamp: { $gte: start, $lte: end },
        eventName: { $in: ['page_view', 'product_view', ...ADD_TO_CART_EVENT_NAMES] },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$timestamp',
            timezone: 'Asia/Kolkata',
          },
        },
        views: {
          $sum: {
            $cond: [{ $in: ['$eventName', ['page_view', 'product_view']] }, 1, 0],
          },
        },
        addToCarts: {
          $sum: {
            $cond: [{ $in: ['$eventName', ADD_TO_CART_EVENT_NAMES] }, 1, 0],
          },
        },
      },
    },
  ]);

  const byDate = new Map(rows.map((r) => [r._id, { views: r.views || 0, addToCarts: r.addToCarts || 0 }]));
  return dateKeys.map((date) => ({
    date,
    views: byDate.get(date)?.views ?? 0,
    addToCarts: byDate.get(date)?.addToCarts ?? 0,
  }));
}

async function buildStorefrontMetricsForPeriod(clientId, periodStart, periodEnd) {
  const since = sinceFromIstPeriod(periodStart, periodEnd);
  const keys = periodStart && periodEnd
    ? Math.max(1, moment(periodEnd, 'YYYY-MM-DD').diff(moment(periodStart, 'YYYY-MM-DD'), 'days') + 1)
    : 30;
  const [funnel, audiences] = await Promise.all([
    buildCheckoutFunnelMetrics(clientId, since),
    buildRetargetingAudienceMetrics(clientId, since, keys),
  ]);
  const storefrontFunnel = buildStorefrontFunnelSummary(audiences, funnel);
  return {
    funnel,
    audiences,
    storefrontFunnel,
    hasActivity:
      storefrontFunnel.pageViewEvents > 0 ||
      storefrontFunnel.addToCartEvents > 0 ||
      storefrontFunnel.checkoutStartedEvents > 0,
  };
}

module.exports = {
  ADD_TO_CART_EVENT_NAMES,
  ADD_TO_CART_EVENTS,
  sinceFromIstPeriod,
  untilFromIstPeriod,
  buildCheckoutFunnelMetrics,
  buildRetargetingAudienceMetrics,
  enrichRetargetingDisplay,
  buildStorefrontFunnelSummary,
  buildDailyStorefrontTrend,
  buildStorefrontMetricsForPeriod,
  metaReadinessTier,
  funnelDropPct,
};
