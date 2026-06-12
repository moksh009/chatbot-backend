'use strict';

const GENERIC_SOURCES = new Set(['', 'direct', 'unknown', 'organic', 'n/a', 'na']);

const SOURCE_LABELS = {
  whatsapp: 'WhatsApp',
  direct: 'Direct',
  meta_ad: 'Meta ads',
  meta_ads: 'Meta ads',
  facebook_ad: 'Facebook ads',
  instagram_ad: 'Instagram',
  google_ad: 'Google ads',
  organic: 'Organic',
  website: 'Website',
  website_widget: 'Website widget',
  web_widget: 'Website widget',
  shopify: 'Shopify',
  shopify_checkout: 'Shopify checkout',
  form: 'Form',
  import: 'CSV import',
  csv_import: 'CSV import',
  referral: 'Referral',
  qr_scan: 'QR code',
  qr_code: 'QR code',
  spin_wheel: 'Spin wheel',
  checkout: 'Checkout',
  thank_you_page: 'Thank-you page',
  keyword: 'Keyword opt-in',
  api: 'API',
  agent_manual: 'Manual',
  admin_manual: 'Manual',
};

function normalizeKey(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, '_');
}

function formatSourceLabel(raw) {
  const key = normalizeKey(raw);
  if (!key || GENERIC_SOURCES.has(key)) return null;
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  if (key === 'meta ad') return 'Meta ads';
  return String(raw)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function hasImportSignal(lead) {
  if (lead?.importBatchId) return true;
  const tags = Array.isArray(lead?.tags) ? lead.tags : [];
  return tags.some((t) => /^import/i.test(String(t || '')));
}

function hasWhatsAppInbound(lead) {
  if (Number(lead?.inboundMessageCount) > 0) return true;
  if (lead?.lastInboundAt) return true;
  const summary = String(lead?.chatSummary || lead?.lastMessageContent || '').trim();
  return summary.length > 0;
}

/**
 * Resolve how this contact entered the CRM (not ad click attribution).
 */
function resolveAcquisitionSource(lead) {
  if (!lead || typeof lead !== 'object') return null;

  if (hasImportSignal(lead)) return 'csv_import';

  const optIn = normalizeKey(lead.optInSource);
  if (optIn && !GENERIC_SOURCES.has(optIn)) {
    return optIn;
  }

  const waConsent = normalizeKey(lead.channelConsent?.whatsapp?.source);
  if (waConsent === 'csv_import') return 'csv_import';
  if (waConsent === 'web_widget' || waConsent === 'website_widget') return 'website_widget';
  if (waConsent === 'shopify_checkout') return 'shopify_checkout';
  if (waConsent === 'meta_ad') return 'meta_ad';
  if (waConsent === 'qr_scan') return 'qr_scan';

  const rawSource = normalizeKey(lead.source);
  if (rawSource === 'meta ad' || rawSource === 'meta_ad') return 'meta_ad';
  if (rawSource === 'import' || rawSource === 'csv_import') return 'csv_import';

  if (hasWhatsAppInbound(lead)) {
    if (rawSource === 'website' || rawSource === 'website_widget') return 'website_widget';
    return 'whatsapp';
  }

  if (rawSource && !GENERIC_SOURCES.has(rawSource)) {
    return rawSource;
  }

  return null;
}

/**
 * Paid / campaign attribution (separate from CRM acquisition source).
 */
function resolveAdChannel(lead) {
  if (!lead?.adAttribution) return null;
  const ad = lead.adAttribution;
  const src = normalizeKey(ad.source);
  if (ad.adId || ad.adHeadline || ad.adSourceUrl) {
    if (src && !GENERIC_SOURCES.has(src)) return src;
    return 'meta_ad';
  }
  if (src && !GENERIC_SOURCES.has(src) && src !== 'organic') {
    return src;
  }
  return null;
}

function resolveLastSeenAt(lead) {
  const candidates = [lead?.lastInboundAt, lead?.lastInteraction, lead?.lastMessageAt, lead?.lastActivityAt]
    .map((d) => (d ? new Date(d) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString();
}

function resolveLastPurchaseDate(lead, orders = []) {
  if (lead?.lastPurchaseDate) return lead.lastPurchaseDate;
  if (lead?.lastOrderAt) return lead.lastOrderAt;
  if (!Array.isArray(orders) || !orders.length) return null;
  const sorted = [...orders].sort(
    (a, b) => new Date(b.createdAt || b.orderDate || 0) - new Date(a.createdAt || a.orderDate || 0)
  );
  return sorted[0]?.createdAt || sorted[0]?.orderDate || null;
}

function computeAov(lead) {
  const orders = Number(lead?.ordersCount) || 0;
  const spent = Number(lead?.totalSpent ?? lead?.lifetimeValue) || 0;
  if (orders <= 0 || spent <= 0) return null;
  return Math.round(spent / orders);
}

function enrichCommerceFromOrders(lead, orders = []) {
  if (!Array.isArray(orders) || !orders.length) return lead;
  const next = { ...lead };
  const sorted = [...orders].sort(
    (a, b) => new Date(b.createdAt || b.orderDate || 0) - new Date(a.createdAt || a.orderDate || 0)
  );
  if (!next.lastPurchaseDate && !next.lastOrderAt) {
    next.lastPurchaseDate = sorted[0]?.createdAt || sorted[0]?.orderDate || null;
  }
  const orderSum = orders.reduce((sum, o) => {
    const v = parseFloat(o.totalPrice ?? o.amount ?? o.total ?? 0);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  const orderCount = orders.length;
  if ((!next.ordersCount || next.ordersCount === 0) && orderCount > 0) {
    next.ordersCount = orderCount;
  }
  if ((!next.totalSpent || next.totalSpent === 0) && orderSum > 0) {
    next.totalSpent = orderSum;
  }
  if ((!next.lifetimeValue || next.lifetimeValue === 0) && orderSum > 0) {
    next.lifetimeValue = orderSum;
  }
  return next;
}

/**
 * Attach display-safe fields for CRM table + Customer 360.
 */
function normalizeLeadForDisplay(lead, { orders } = {}) {
  if (!lead || typeof lead !== 'object') return lead;
  let base = orders?.length ? enrichCommerceFromOrders(lead, orders) : { ...lead };

  const acquisitionKey = resolveAcquisitionSource(base);
  const adKey = resolveAdChannel(base);
  const lastPurchaseDate = resolveLastPurchaseDate(base, orders);
  const lastSeenAt = resolveLastSeenAt(base);
  const aov = computeAov(base);

  return {
    ...base,
    lastPurchaseDate: lastPurchaseDate || base.lastPurchaseDate || null,
    lastMessageAt: lastSeenAt,
    displaySource: acquisitionKey,
    displaySourceLabel: acquisitionKey ? formatSourceLabel(acquisitionKey) : null,
    displayAdChannel: adKey,
    displayAdChannelLabel: adKey ? formatSourceLabel(adKey) : null,
    displayAov: aov,
    displayLastSeenAt: lastSeenAt,
  };
}

module.exports = {
  normalizeLeadForDisplay,
  resolveAcquisitionSource,
  resolveAdChannel,
  resolveLastSeenAt,
  resolveLastPurchaseDate,
  computeAov,
  formatSourceLabel,
  enrichCommerceFromOrders,
};
