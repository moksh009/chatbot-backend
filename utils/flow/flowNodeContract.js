'use strict';

/**
 * Flow Builder V1 node contract — single source of truth for shippable types.
 * Frontend mirror: chatbot-dashboard-frontend-main/src/components/FlowBuilder/flowNodeContract.js
 */

const NODE_TYPE_ALIASES = {
  templatenode: 'template',
  messageNode: 'message',
  messagenode: 'message',
  message_node: 'message',
  interactivenode: 'interactive',
  buttonnode: 'interactive',
  conditionnode: 'logic',
  condition: 'logic',
  captureNode: 'capture_input',
  capturenode: 'capture_input',
  capture: 'capture_input',
  webhooknode: 'http_request',
  human_handoff: 'livechat',
  escalateNode: 'escalate',
  escalate: 'livechat',
  triggernode: 'trigger',
  trigger_node: 'trigger',
  warranty_lookup: 'warranty_check',
  flow: 'whatsapp_flow',
  group: 'folder',
};

/** Types the generator, AI builder, and canvas may use in V1. */
const V1_SHIPPABLE_NODE_TYPES = new Set([
  'trigger',
  'intent_trigger',
  'message',
  'interactive',
  'email',
  'whatsapp_flow',
  'logic',
  'delay',
  'link',
  'capture_input',
  'set_variable',
  'ab_test',
  'schedule',
  'catalog',
  'shopify_call',
  'cart_handler',
  'livechat',
  'warranty_check',
  'persona',
  'admin_alert',
  'tag_lead',
  'webhook',
  'http_request',
  'automation',
  'install_guide_entry',
  'template',
  'folder',
  'image',
]);

/** Palette-only or legacy — not emitted by generator/AI in V1. */
const V1_PALETTE_ONLY_TYPES = new Set([
  'cod_prepaid',
]);

/** Deprecated — validator blocks publish; render read-only in studio. */
const V1_FORBIDDEN_NODE_TYPES = new Set([
  'review',
  'order_action',
  'payment_link',
  'cod_prepaid',
]);

/**
 * Legacy type statuses (not in V1 shippable set):
 * - deprecated_readonly: payment_link, review, order_action
 * - runtime_only: segment, sequence (no palette; render if present)
 * - editor_only: sticky (stripped on publish)
 * - migrated: image → message (sendImage)
 */

/** Legacy superset for normalization of old graphs. */
const CANONICAL_NODE_TYPES = new Set([
  ...V1_SHIPPABLE_NODE_TYPES,
  ...V1_PALETTE_ONLY_TYPES,
  ...V1_FORBIDDEN_NODE_TYPES,
  'escalate',
  'sequence',
  'sticky',
  'story_mention',
  'abandoned_cart',
  'segment',
]);

/** Core D2C template feature flags (V1 shipped). */
const V1_CORE_D2C_FEATURES = {
  enableCatalog: true,
  enableOrderTracking: false,
  enableCancelOrder: true,
  enableReturnsRefunds: true,
  enableWarranty: true,
  enableInstallSupport: true,
  enableFAQ: true,
  enableAbandonedCart: true,
  enableReviewCollection: false,
  enableSupportEscalation: true,
  enableAIFallback: true,
  enableBusinessHoursGate: true,
  enableCodToPrepaid: false,
  enableAdminAlerts: true,
  enableB2BWholesale: false,
};

function normalizeNodeType(input) {
  if (!input) return '';
  const raw = String(input).trim();
  const lowered = raw.toLowerCase();
  return NODE_TYPE_ALIASES[raw] || NODE_TYPE_ALIASES[lowered] || raw;
}

function isCanonicalNodeType(type) {
  return CANONICAL_NODE_TYPES.has(type);
}

function isV1ShippableNodeType(type) {
  return V1_SHIPPABLE_NODE_TYPES.has(type);
}

function isV1ForbiddenNodeType(type) {
  return V1_FORBIDDEN_NODE_TYPES.has(type);
}

module.exports = {
  normalizeNodeType,
  isCanonicalNodeType,
  isV1ShippableNodeType,
  isV1ForbiddenNodeType,
  CANONICAL_NODE_TYPES: Array.from(CANONICAL_NODE_TYPES),
  V1_SHIPPABLE_NODE_TYPES: Array.from(V1_SHIPPABLE_NODE_TYPES),
  V1_FORBIDDEN_NODE_TYPES: Array.from(V1_FORBIDDEN_NODE_TYPES),
  V1_CORE_D2C_FEATURES,
};
