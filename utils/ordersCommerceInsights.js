'use strict';

/**
 * Single source of truth for Orders → Analytics KPIs, waterfall inputs, and commerce funnel.
 * range=all caps order documents to the last 24 months for bounded scans (see ORDER_RANGE_ALL_DAYS).
 */

const Order = require('../models/Order');
const DailyStat = require('../models/DailyStat');
const PixelEvent = require('../models/PixelEvent');
const Message = require('../models/Message');
const { withShopifyRetry } = require('./shopifyHelper');

/** When range=all, never scan unbounded order history (production safety). */
const ORDER_RANGE_ALL_DAYS = 730;

const MS_48H = 48 * 3600000;
const MS_30D = 30 * 86400000;

function rangeToStartDate(range) {
  const now = new Date();
  if (range === '7d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === '30d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === 'all') {
    const d = new Date(now);
    d.setDate(d.getDate() - ORDER_RANGE_ALL_DAYS);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(now);
  d.setDate(d.getDate() - 365);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Cap storefront / chat signals when range is "all" to keep aggregations bounded. */
function activityStartForFunnel(range, orderStart) {
  const d = new Date();
  d.setDate(d.getDate() - 365);
  d.setHours(0, 0, 0, 0);
  if (!orderStart) return d;
  return orderStart > d ? orderStart : d;
}

function eachDateKeyInRange(start, end = new Date()) {
  const keys = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) {
    keys.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

function money(o) {
  const n = Number(o?.totalPrice ?? o?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isPaidFinancial(doc) {
  const fs = String(doc.financialStatus || '').toLowerCase();
  return fs === 'paid';
}

function isNetShipped(doc) {
  if (!isPaidFinancial(doc)) return false;
  const ful = String(doc.fulfillmentStatus || '').toLowerCase();
  const st = String(doc.status || '').toLowerCase();
  return ful === 'fulfilled' || st === 'delivered' || st === 'shipped';
}

function isReturnedOrRefunded(doc) {
  const fs = String(doc.financialStatus || '').toLowerCase();
  if (fs.includes('refund')) return true;
  return String(doc.status || '').toLowerCase() === 'rto';
}

function isCancelledOrVoided(doc) {
  const fs = String(doc.financialStatus || '').toLowerCase();
  if (fs.includes('refund')) return false;
  const st = String(doc.status || '').toLowerCase();
  return st === 'cancelled' || fs === 'voided';
}

/**
 * Potential loss (₹): actionable near-term exposure only —
 *  (A) Unpaid/pending, strictly not cancelled, order age between 48h and 30d, OR
 *  (B) Same age window + unpaid + High RTO predictor risk.
 * Excludes dead leads (older than 30d) so totals cannot balloon forever.
 */
async function aggregatePotentialLoss(clientId, orderStart) {
  const now = Date.now();
  const match = { clientId };
  if (orderStart) match.createdAt = { $gte: orderStart };

  const rows = await Order.find(match)
    .select('totalPrice amount financialStatus status rtoRiskLevel createdAt')
    .lean();

  const seen = new Set();
  let sum = 0;
  for (const o of rows) {
    const id = String(o._id);
    if (seen.has(id)) continue;

    const fs = String(o.financialStatus || '').toLowerCase();
    const st = String(o.status || '').toLowerCase();
    if (st === 'cancelled') continue;

    const ageMs = now - new Date(o.createdAt).getTime();
    if (ageMs <= MS_48H || ageMs > MS_30D) continue;

    const isPending = fs === 'pending' || (fs === '' && st === 'pending');
    const stalePending = isPending;
    const highRtoUnpaid = (o.rtoRiskLevel || '') === 'High' && !isPaidFinancial(o);

    if (stalePending || highRtoUnpaid) {
      seen.add(id);
      sum += money(o);
    }
  }
  return { amount: Math.round(sum * 100) / 100, ordersCount: seen.size };
}

async function fetchShopifyAbandoned(clientId) {
  try {
    const data = await withShopifyRetry(clientId, async (shop) => {
      const response = await shop.get('/checkouts.json?limit=250');
      const checkouts = response.data.checkouts || [];
      const incomplete = checkouts.filter((c) => !c.completed_at);
      const totalValue = incomplete.reduce((s, c) => s + parseFloat(c.total_price || 0), 0);
      return { count: incomplete.length, totalValue };
    });
    return { success: true, insufficient: false, ...data };
  } catch (e) {
    return { success: false, insufficient: true, count: 0, totalValue: 0, error: e.message };
  }
}

async function getOrdersCommerceInsights(clientId, range = '30d') {
  const orderStart = rangeToStartDate(range);
  const funnelStart = activityStartForFunnel(range, orderStart);
  const endDate = new Date();
  const orderMatch = { clientId, createdAt: { $gte: orderStart } };

  const [
    ordersLean,
    discoveryCount,
    interactionsCount,
    checkoutStartedPixel,
    abandonedShopify,
    potentialLoss,
    dailyRoiAgg,
  ] = await Promise.all([
    Order.find(orderMatch)
      .select(
        'totalPrice amount financialStatus fulfillmentStatus status rtoRiskLevel createdAt items'
      )
      .lean(),
    PixelEvent.countDocuments({
      clientId,
      timestamp: { $gte: funnelStart },
      eventName: { $in: ['page_view', 'product_view', 'search'] },
    }),
    Message.countDocuments({
      clientId,
      timestamp: { $gte: funnelStart },
      direction: 'incoming',
    }),
    PixelEvent.countDocuments({
      clientId,
      timestamp: { $gte: funnelStart },
      eventName: 'checkout_started',
    }),
    fetchShopifyAbandoned(clientId),
    aggregatePotentialLoss(clientId, orderStart),
    DailyStat.aggregate([
      {
        $match: {
          clientId,
          date: { $in: eachDateKeyInRange(funnelStart, endDate) },
        },
      },
      {
        $group: {
          _id: null,
          cartRevenueRecovered: { $sum: { $ifNull: ['$cartRevenueRecovered', 0] } },
          codConvertedRevenue: { $sum: { $ifNull: ['$codConvertedRevenue', 0] } },
          rtoCostSaved: { $sum: { $ifNull: ['$rtoCostSaved', 0] } },
          cartsRecovered: { $sum: { $ifNull: ['$cartsRecovered', 0] } },
          codConvertedCount: { $sum: { $ifNull: ['$codConvertedCount', 0] } },
        },
      },
    ]),
  ]);

  const total = ordersLean.length;
  let grossIntent = 0;
  let netRealized = 0;
  let netRevenueWaterfall = 0;
  let rtoLoss = 0;
  let cancelValue = 0;
  let fulfilledCount = 0;
  let paidCount = 0;

  for (const o of ordersLean) {
    grossIntent += money(o);
    if (isPaidFinancial(o)) {
      paidCount += 1;
      netRealized += money(o);
    }
    if (isNetShipped(o)) netRevenueWaterfall += money(o);
    if (isReturnedOrRefunded(o)) rtoLoss += money(o);
    if (isCancelledOrVoided(o)) cancelValue += money(o);
    const ful = String(o.fulfillmentStatus || '').toLowerCase();
    const st = String(o.status || '').toLowerCase();
    if (ful === 'fulfilled' || st === 'delivered' || st === 'shipped') fulfilledCount += 1;
  }

  const roiRow = dailyRoiAgg[0] || {};
  const automationRoiAmount =
    (roiRow.cartRevenueRecovered || 0) +
    (roiRow.codConvertedRevenue || 0) +
    (roiRow.rtoCostSaved || 0);
  const automationRoiHasData =
    automationRoiAmount > 0 ||
    (roiRow.cartsRecovered || 0) > 0 ||
    (roiRow.codConvertedCount || 0) > 0;

  const cartSignal =
    abandonedShopify.success && !abandonedShopify.insufficient
      ? Math.max(Number(abandonedShopify.count) || 0, checkoutStartedPixel)
      : checkoutStartedPixel;

  const steps = [
    {
      id: 'discovery',
      label: 'Storefront events',
      subtitle: 'Pixel: page_view, product_view, search (same window)',
      count: discoveryCount,
      source: 'pixel_events',
    },
    {
      id: 'interactions',
      label: 'Inbound WhatsApp',
      subtitle: 'Customer → you messages (same window)',
      count: interactionsCount,
      source: 'messages_incoming',
    },
    {
      id: 'cart',
      label: 'Checkout signals',
      subtitle:
        abandonedShopify.success && !abandonedShopify.insufficient
          ? 'max(open Shopify checkouts, checkout_started pixel)'
          : 'checkout_started pixel only (Shopify checkouts API unavailable)',
      count: cartSignal,
      source: 'shopify_checkouts_pixel',
      checkoutStartedPixel,
      shopifyOpenCheckouts: abandonedShopify.count || 0,
    },
    {
      id: 'orders',
      label: 'Paid orders',
      subtitle: 'Shopify orders with financial_status = paid',
      count: paidCount,
      source: 'orders',
    },
  ];

  /**
   * These four counts are not a sequential funnel (WhatsApp can exceed storefront events).
   * We expose them as parallel signals only — do not derive step-to-step "conversion %".
   */
  const funnel = {
    model: 'parallel_signals',
    disclosure:
      'Each number is a separate total for the same date range. They are not subsets of each other, so there is no step-to-step conversion rate.',
    steps,
    edges: [],
  };

  const checkoutDropValue =
    abandonedShopify.success && !abandonedShopify.insufficient
      ? Math.max(Number(abandonedShopify.totalValue) || 0, 0)
      : 0;

  return {
    success: true,
    range,
    window: {
      orderStart: orderStart.toISOString(),
      funnelActivityStart: funnelStart.toISOString(),
      end: endDate.toISOString(),
      orderHistoryCapDays: range === 'all' ? ORDER_RANGE_ALL_DAYS : null,
    },
    definitions: {
      funnelWindow:
        range === 'all'
          ? `Orders and waterfall load at most the last ${ORDER_RANGE_ALL_DAYS} days of synced history. Pixel and WhatsApp signal tiles use the same order-window floor vs the last 365 days of events (whichever is newer).`
          : 'Orders, waterfall, commerce signal tiles, and ROI use the same rolling window.',
      potentialLoss:
        '₹ sum of non-cancelled orders with age strictly between 48 hours and 30 days where (1) financial pending (or empty financial with status pending), or (2) unpaid with High RTO risk. Older dead leads are excluded so the KPI cannot grow without bound.',
      automationRoi:
        'Sum of DailyStat cart revenue recovered, COD→prepaid converted revenue, and RTO cost saved over the same calendar window.',
      discovery: 'Count of storefront Pixel events (not Meta Ads): page_view, product_view, search.',
      interactions: 'Count of WhatsApp inbound (incoming) messages.',
      cart: 'Max of open incomplete Shopify checkouts (when API works) and checkout_started pixel events in the window.',
      paidOrders: 'Orders with financial_status paid (Shopify) in the window.',
      funnelSignals:
        'The four funnel tiles are parallel signals, not a strict funnel. Inbound WhatsApp can be higher than storefront pixel counts because chats include returning customers, campaigns, and traffic outside the pixel scope.',
    },
    kpis: {
      netRealized: Math.round(netRealized * 100) / 100,
      netRealizedShareOfIntent: grossIntent > 0 ? Math.round((netRealized / grossIntent) * 1000) / 10 : null,
      potentialLoss: potentialLoss.amount,
      potentialLossOrders: potentialLoss.ordersCount,
      automationRoiAmount: Math.round(automationRoiAmount * 100) / 100,
      automationRoiHasData,
      automationRoiBreakdown: {
        cartRevenueRecovered: roiRow.cartRevenueRecovered || 0,
        codConvertedRevenue: roiRow.codConvertedRevenue || 0,
        rtoCostSaved: roiRow.rtoCostSaved || 0,
        cartsRecovered: roiRow.cartsRecovered || 0,
        codConvertedCount: roiRow.codConvertedCount || 0,
      },
      fulfilledCount,
      totalOrders: total,
    },
    waterfall: {
      grossIntent: Math.round(grossIntent * 100) / 100,
      checkoutDrop: {
        value: checkoutDropValue ? -Math.round(checkoutDropValue * 100) / 100 : 0,
        insufficient: !abandonedShopify.success || abandonedShopify.insufficient,
        abandonedCount: abandonedShopify.count,
      },
      rtoLoss: Math.round(rtoLoss * 100) / 100,
      cancelValue: Math.round(cancelValue * 100) / 100,
      netRevenueWaterfall: Math.round(netRevenueWaterfall * 100) / 100,
    },
    funnel: {
      ...funnel,
      shopifyAbandoned: abandonedShopify,
    },
  };
}

module.exports = { getOrdersCommerceInsights, rangeToStartDate, ORDER_RANGE_ALL_DAYS };
