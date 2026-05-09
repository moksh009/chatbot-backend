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
  triggernode: 'trigger',
  trigger_node: 'trigger',
};

const CANONICAL_NODE_TYPES = new Set([
  'trigger',
  'message',
  'interactive',
  'template',
  'capture_input',
  'logic',
  'delay',
  'shopify_call',
  'http_request',
  'tag_lead',
  'escalate',
  'ab_test',
  'payment_link',
  'loyalty_action',
  'order_action',
  'cod_prepaid',
  'abandoned_cart',
  'review',
  'warranty_check',
  'admin_alert',
  'livechat',
  'catalog',
  'cart_handler',
  'segment',
  'email',
  'sequence',
  'folder',
  'image',
  'persona',
  'intent_trigger',
  'automation',
  'schedule',
  'link',
  'sticky',
]);

function normalizeNodeType(input) {
  if (!input) return '';
  const raw = String(input).trim();
  const lowered = raw.toLowerCase();
  return NODE_TYPE_ALIASES[raw] || NODE_TYPE_ALIASES[lowered] || raw;
}

function isCanonicalNodeType(type) {
  return CANONICAL_NODE_TYPES.has(type);
}

module.exports = {
  normalizeNodeType,
  isCanonicalNodeType,
  CANONICAL_NODE_TYPES: Array.from(CANONICAL_NODE_TYPES),
};
