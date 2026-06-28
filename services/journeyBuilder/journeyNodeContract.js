'use strict';

/** Journey Builder node type SSOT — mirror FE `journeyNodeContract.js`. */
const JOURNEY_NODE_TYPES = Object.freeze({
  JOURNEY_TRIGGER: 'journey_trigger',
  SEND_WHATSAPP: 'send_whatsapp',
  SEND_EMAIL: 'send_email',
  WAIT: 'wait',
  CONDITION: 'condition',
  END: 'end',
});

const PHASE1_NODE_TYPES = Object.freeze([
  JOURNEY_NODE_TYPES.JOURNEY_TRIGGER,
  JOURNEY_NODE_TYPES.SEND_WHATSAPP,
  JOURNEY_NODE_TYPES.SEND_EMAIL,
  JOURNEY_NODE_TYPES.WAIT,
  JOURNEY_NODE_TYPES.CONDITION,
  JOURNEY_NODE_TYPES.END,
]);

/** All valid entry/trigger types for a journey blueprint. */
const ENTRY_TYPES = Object.freeze([
  'manual',
  'cart_abandoned',
  'order_placed',
  'order_shipped',
  'order_delivered',
]);

/** Phase 1 legacy — keep for backward compat; new code should use ENTRY_TYPES. */
const MANUAL_ENTRY_TYPES = Object.freeze(['manual']);

function isKnownJourneyNodeType(type) {
  return PHASE1_NODE_TYPES.includes(String(type || '').trim());
}

function normalizeEntryType(raw) {
  const t = String(raw || 'manual').trim();
  return ENTRY_TYPES.includes(t) ? t : 'manual';
}

/**
 * Normalise journeyTrigger.filters from canvas data to a clean object.
 * Defensive — accepts any shape from studio form.
 */
function normalizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (raw.codOnly === true || raw.paymentMethod === 'cod') out.codOnly = true;
  if (Array.isArray(raw.productIds) && raw.productIds.length) {
    out.productIds = raw.productIds.filter(Boolean);
  }
  if (Number.isFinite(Number(raw.minOrderTotal)) && Number(raw.minOrderTotal) > 0) {
    out.minOrderTotal = Number(raw.minOrderTotal);
  }
  if (raw.shipmentStatus) out.shipmentStatus = String(raw.shipmentStatus);
  return out;
}

/**
 * Derive a human-readable one-liner for the trigger node canvas card.
 * Mirrors FE journeyTriggerSummary().
 */
function journeyTriggerSummary(journeyTrigger) {
  if (!journeyTrigger) return 'Manual enroll';
  const type = typeof journeyTrigger === 'string' ? journeyTrigger : journeyTrigger.type;
  const filters = typeof journeyTrigger === 'object' ? (journeyTrigger.filters || {}) : {};

  const labels = {
    manual: 'Manual enroll',
    cart_abandoned: 'Cart abandoned',
    order_placed: 'Order placed',
    order_shipped: 'Order shipped',
    order_delivered: 'Order delivered',
  };
  let label = labels[type] || String(type || 'Manual enroll');
  if (filters.codOnly) label += ' · COD';
  if (filters.productIds?.length) label += ` · ${filters.productIds.length} product(s)`;
  return label;
}

module.exports = {
  JOURNEY_NODE_TYPES,
  PHASE1_NODE_TYPES,
  ENTRY_TYPES,
  MANUAL_ENTRY_TYPES,
  isKnownJourneyNodeType,
  normalizeEntryType,
  normalizeFilters,
  journeyTriggerSummary,
};
