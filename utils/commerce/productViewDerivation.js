'use strict';

const PixelEvent = require('../../models/PixelEvent');
const { inferProductFromUrl } = require('./productViewUrlUtils');
const { enrichPixelMetadata } = require('./pixelEventUrlUtils');
const log = require('../core/logger')('ProductViewDerivation');

const DEDUPE_MS = 30_000;

function isProductPageUrl(url) {
  return Boolean(inferProductFromUrl(url));
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rollupHelpers() {
  return require('./productInsightsRollup');
}

async function wasRecentlyRecorded(clientId, sessionId, visitorId, handle, at, shopifyClientId) {
  if (!handle) return false;
  const since = new Date(at.getTime() - DEDUPE_MS);
  const handlePattern = new RegExp(`/products/${escapeRegex(handle)}`, 'i');
  const sessionFilter = sessionId
    ? { sessionId: String(sessionId) }
    : visitorId
      ? { 'metadata.visitorId': String(visitorId) }
      : shopifyClientId
        ? { 'metadata.shopifyClientId': String(shopifyClientId) }
        : null;
  if (!sessionFilter) return false;

  const exists = await PixelEvent.findOne({
    clientId,
    eventName: 'product_view',
    ...sessionFilter,
    timestamp: { $gte: since, $lte: at },
    $or: [{ url: handlePattern }, { 'metadata.product.handle': handle }, { 'metadata.url': handlePattern }],
  })
    .select('_id')
    .lean();
  return Boolean(exists);
}

/**
 * When a page_view lands on /products/{handle}, write a matching product_view
 * (deduped per session + handle within 30s). Powers live feed + audience metrics.
 */
async function deriveProductViewFromPageEvent(clientId, pageEventDoc, payload = {}) {
  if (!pageEventDoc || pageEventDoc.eventName !== 'page_view') return null;

  const { url, metadata: enrichedMeta } = enrichPixelMetadata(payload, pageEventDoc);
  const productMeta = inferProductFromUrl(url);
  if (!productMeta?.handle) return null;

  const at = pageEventDoc.timestamp ? new Date(pageEventDoc.timestamp) : new Date();
  const sessionId = pageEventDoc.sessionId || payload.sessionId;
  const visitorId =
    pageEventDoc.metadata?.visitorId || payload.visitorId || payload.metadata?.visitorId;
  const shopifyClientId =
    pageEventDoc.metadata?.shopifyClientId ||
    payload.shopifyClientId ||
    payload.metadata?.shopifyClientId;

  if (await wasRecentlyRecorded(clientId, sessionId, visitorId, productMeta.handle, at, shopifyClientId)) {
    return null;
  }

  const metadata = {
    ...(pageEventDoc.metadata || {}),
    ...(payload.metadata || {}),
    ...enrichedMeta,
    product: {
      ...(pageEventDoc.metadata?.product || {}),
      ...(payload.metadata?.product || {}),
      ...productMeta,
    },
    derivedFrom: 'page_view',
    source: pageEventDoc.metadata?.source || payload.metadata?.source || 'derived_server',
  };

  try {
    const derived = await PixelEvent.create({
      clientId,
      leadId: pageEventDoc.leadId || undefined,
      eventName: 'product_view',
      url,
      sessionId: sessionId || undefined,
      metadata,
      timestamp: at,
      userAgent: pageEventDoc.userAgent,
      ip: pageEventDoc.ip,
    });

    const { rollupProductEvent } = rollupHelpers();
    await rollupProductEvent(
      clientId,
      'product_view',
      { ...metadata, product: metadata.product, url },
      { timestamp: derived.timestamp, url }
    );

    return derived;
  } catch (err) {
    log.warn(`deriveProductViewFromPageEvent failed: ${err.message}`);
    return null;
  }
}

/**
 * Backfill derived product_view rows for historical page_view on product URLs.
 */
async function backfillDerivedProductViews(clientId, daysBack = 30) {
  const moment = require('moment');
  const since = moment().subtract(Math.max(1, Number(daysBack) || 30), 'days').startOf('day').toDate();

  const pageViews = await PixelEvent.find({
    clientId,
    eventName: 'page_view',
    $or: [
      { url: /\/products\//i },
      { 'metadata.url': /\/products\//i },
      { 'metadata.pathname': /\/products\//i },
      { 'metadata.href': /\/products\//i },
    ],
    timestamp: { $gte: since },
  })
    .sort({ timestamp: 1 })
    .select('url sessionId metadata timestamp userAgent ip leadId')
    .lean();

  let created = 0;
  let skipped = 0;

  for (const ev of pageViews) {
    const productMeta = inferProductFromUrl(
      ev.url || ev.metadata?.url || ev.metadata?.pathname || ev.metadata?.href
    );
    if (!productMeta?.handle) {
      skipped += 1;
      continue;
    }
    const at = new Date(ev.timestamp);
    const sessionId = ev.sessionId;
    const visitorId = ev.metadata?.visitorId;
    const shopifyClientId = ev.metadata?.shopifyClientId;
    if (
      await wasRecentlyRecorded(clientId, sessionId, visitorId, productMeta.handle, at, shopifyClientId)
    ) {
      skipped += 1;
      continue;
    }

    const doc = await deriveProductViewFromPageEvent(clientId, { ...ev, eventName: 'page_view' }, {});
    if (doc) created += 1;
    else skipped += 1;
  }

  return { scanned: pageViews.length, created, skipped };
}

async function backfillAllClientsDerivedProductViews(daysBack = 30) {
  const Client = require('../../models/Client');
  const clients = await Client.find({
    isActive: { $ne: false },
    shopifyAccessToken: { $exists: true, $ne: null },
  })
    .select('clientId')
    .lean();

  let totalCreated = 0;
  for (const c of clients) {
    try {
      const result = await backfillDerivedProductViews(c.clientId, daysBack);
      totalCreated += result.created || 0;
      await new Promise((r) => setTimeout(r, 25));
    } catch (err) {
      log.warn(`backfill derived product views failed for ${c.clientId}: ${err.message}`);
    }
  }
  log.info(`Derived product_view backfill done — ${totalCreated} created across ${clients.length} clients`);
  return { clients: clients.length, created: totalCreated };
}

module.exports = {
  DEDUPE_MS,
  isProductPageUrl,
  deriveProductViewFromPageEvent,
  backfillDerivedProductViews,
  backfillAllClientsDerivedProductViews,
};
