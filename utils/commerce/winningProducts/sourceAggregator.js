'use strict';

const PixelEvent = require('../../../models/PixelEvent');
const { startOfDayForDateStrIST, endOfDayForDateStrIST } = require('../../core/queryHelpers');
const { aggregateSourceCounts } = require('./sourceClassifier');

async function fetchProductViewEvents(clientId, since, until, productId) {
  const handle = String(productId || '').startsWith('handle:') ? productId.slice(7) : null;
  const match = {
    clientId,
    eventName: 'product_view',
    timestamp: { $gte: since, ...(until ? { $lte: until } : {}) },
  };
  if (handle) {
    match.url = new RegExp(`/products/${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  } else if (productId) {
    match.$or = [
      { 'metadata.product.productId': productId },
      { 'metadata.product.id': productId },
    ];
  }
  return PixelEvent.find(match).select('metadata url').lean();
}

async function fetchSiteWideViewEvents(clientId, since, until) {
  return PixelEvent.find({
    clientId,
    eventName: { $in: ['product_view', 'page_view'] },
    timestamp: { $gte: since, ...(until ? { $lte: until } : {}) },
  })
    .select('metadata url')
    .lean();
}

async function buildSiteWideSourceBreakdown(clientId, periodStart, periodEnd) {
  const since = startOfDayForDateStrIST(periodStart);
  const until = endOfDayForDateStrIST(periodEnd);
  const events = await fetchSiteWideViewEvents(clientId, since, until);
  const { total, breakdown } = aggregateSourceCounts(events);
  const hasReferrerData = events.some(
    (e) => e.metadata?.referrer || e.metadata?.referrerUrl || e.metadata?.utm_source
  );
  const hasUtmData = events.some(
    (e) => e.metadata?.utm_source || e.metadata?.utm_medium || e.metadata?.utm_campaign
  );
  return { total, breakdown, hasReferrerData, hasUtmData };
}

async function buildProductSourceBreakdown(clientId, productId, periodStart, periodEnd) {
  const since = startOfDayForDateStrIST(periodStart);
  const until = endOfDayForDateStrIST(periodEnd);
  const events = await fetchProductViewEvents(clientId, since, until, productId);
  if (!events.length) return null;
  const { breakdown } = aggregateSourceCounts(events);
  return breakdown;
}

module.exports = {
  buildSiteWideSourceBreakdown,
  buildProductSourceBreakdown,
};
