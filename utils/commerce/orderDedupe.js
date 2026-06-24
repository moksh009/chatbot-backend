'use strict';

function normalizeOrderNumberKey(order) {
  const raw = String(order?.orderNumber || order?.orderId || '')
    .replace(/^#+/g, '')
    .trim();
  return raw || null;
}

function orderRichnessScore(doc) {
  let s = 0;
  const ship = doc.shippingAddress;
  if (ship && (ship.address1 || ship.city || ship.province || ship.province_code)) s += 5;
  if (doc.customerName && String(doc.customerName).trim().length > 3) s += 3;
  if (doc.customerPhone || doc.phone) s += 2;
  if (doc.financialStatus) s += 2;
  if (doc.fulfillmentStatus && doc.fulfillmentStatus !== 'unfulfilled') s += 2;
  if (doc.isCOD) s += 1;
  if (doc.shopifyOrderId) s += 1;
  return s;
}

/**
 * Collapse duplicate Mongo Order docs for the same Shopify order (order number / shopifyOrderId).
 */
function dedupeOrdersByShopifyKey(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;
  const byKey = new Map();
  for (const o of orders) {
    const num = normalizeOrderNumberKey(o);
    const k = num
      ? `n:${num}`
      : o.shopifyOrderId
        ? `sid:${String(o.shopifyOrderId)}`
        : `id:${String(o._id)}`;
    const prev = byKey.get(k);
    if (!prev || orderRichnessScore(o) >= orderRichnessScore(prev)) byKey.set(k, o);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

module.exports = {
  normalizeOrderNumberKey,
  orderRichnessScore,
  dedupeOrdersByShopifyKey,
};
