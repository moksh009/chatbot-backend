const log = require('./logger')('LeadFieldAccess');

const DRIFT_LOG_ONCE = new Set();

function logDriftOnce(key, message) {
  if (DRIFT_LOG_ONCE.has(key)) return;
  DRIFT_LOG_ONCE.add(key);
  log.warn(message);
}

/**
 * Canonical AdLead order count (B7). Schema field is ordersCount.
 */
function getLeadOrdersCount(lead, source = 'unknown') {
  if (!lead) return 0;
  if (lead.ordersCount != null && lead.ordersCount !== '') {
    return Number(lead.ordersCount) || 0;
  }
  if (lead.orderCount != null && lead.orderCount !== '') {
    logDriftOnce('orderCount', `[B7] read legacy lead.orderCount via ${source} — migrate to ordersCount`);
    return Number(lead.orderCount) || 0;
  }
  return 0;
}

/**
 * Canonical cart snapshot total (B7). Prefer totalPrice; accept Shopify snake_case.
 */
function getCartSnapshotTotal(snap = {}, lead = null) {
  if (snap.totalPrice != null && snap.totalPrice !== '') {
    return Number(snap.totalPrice) || 0;
  }
  if (snap.total_price != null && snap.total_price !== '') {
    logDriftOnce('total_price', '[B7] read legacy cartSnapshot.total_price — writers should set totalPrice');
    return Number(snap.total_price) || 0;
  }
  if (lead?.cartValue != null && lead.cartValue !== '') {
    return Number(lead.cartValue) || 0;
  }
  return 0;
}

/** Normalize cart snapshot writes to include canonical totalPrice. */
function normalizeCartSnapshotWrite(snap = {}) {
  if (!snap || typeof snap !== 'object') return snap;
  const total = getCartSnapshotTotal(snap);
  const out = { ...snap };
  if (total > 0 || snap.totalPrice != null || snap.total_price != null) {
    out.totalPrice = total;
    out.total_price = total;
  }
  return out;
}

module.exports = {
  getLeadOrdersCount,
  getCartSnapshotTotal,
  normalizeCartSnapshotWrite,
};
