'use strict';

/**
 * Entry trigger filter catalog — SSOT for journey trigger rules.
 * Mirror: chatbot-dashboard-frontend-main/src/components/JourneyBuilder/triggerFilterCatalog.js
 */

const FILTER_ATTRIBUTES = Object.freeze({
  payment_method: {
    label: 'Payment method',
    operator: 'is',
    valueType: 'payment',
    orderEvents: true,
  },
  order_total_min: {
    label: 'Order total',
    operator: 'gte',
    valueType: 'currency',
    orderEvents: true,
  },
  order_total_max: {
    label: 'Order total',
    operator: 'lte',
    valueType: 'currency',
    orderEvents: true,
  },
  products: {
    label: 'Products',
    operator: 'includes_any',
    valueType: 'product_ids',
    orderEvents: true,
  },
  products_exclude: {
    label: 'Products',
    operator: 'excludes',
    valueType: 'product_ids',
    orderEvents: true,
  },
  customer_type: {
    label: 'Customer',
    operator: 'is',
    valueType: 'customer_type',
    orderEvents: true,
  },
  order_tags: {
    label: 'Order tags',
    operator: 'includes_any',
    valueType: 'tag_list',
    orderEvents: true,
  },
  order_tags_exclude: {
    label: 'Order tags',
    operator: 'excludes',
    valueType: 'tag_list',
    orderEvents: true,
  },
  discount_code: {
    label: 'Discount code',
    operator: 'includes_any',
    valueType: 'tag_list',
    orderEvents: true,
  },
  discount_code_exclude: {
    label: 'Discount code',
    operator: 'excludes',
    valueType: 'tag_list',
    orderEvents: true,
  },
  line_item_count_min: {
    label: 'Item count',
    operator: 'gte',
    valueType: 'number',
    orderEvents: true,
  },
  line_item_count_max: {
    label: 'Item count',
    operator: 'lte',
    valueType: 'number',
    orderEvents: true,
  },
  cart_delay: {
    label: 'Wait before enroll',
    operator: 'is',
    valueType: 'cart_delay',
    cartEvents: true,
  },
  cart_value_min: {
    label: 'Cart value',
    operator: 'gte',
    valueType: 'currency',
    cartEvents: true,
  },
  cart_products: {
    label: 'Cart products',
    operator: 'includes_any',
    valueType: 'product_ids',
    cartEvents: true,
  },
  collections: {
    label: 'Collections',
    operator: 'includes_any',
    valueType: 'collection_ids',
    orderEvents: true,
  },
  collections_exclude: {
    label: 'Collections',
    operator: 'excludes',
    valueType: 'collection_ids',
    orderEvents: true,
  },
  cart_collections: {
    label: 'Cart collections',
    operator: 'includes_any',
    valueType: 'collection_ids',
    cartEvents: true,
  },
});

const ORDER_EVENTS = Object.freeze(['order_placed', 'order_shipped', 'order_delivered']);
const CART_EVENTS = Object.freeze(['cart_abandoned']);

const REMOVED_FILTER_ATTRIBUTES = new Set(['shipping_state', 'shipping_city']);

function tagListIds(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function newRuleId() {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function productRuleIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === 'object' && Array.isArray(value.ids)) {
    return value.ids.map(String).filter(Boolean);
  }
  return [];
}

const collectionRuleIds = productRuleIds;

function createRule(attribute, value, operator) {
  const def = FILTER_ATTRIBUTES[attribute];
  if (!def) return null;
  return {
    id: newRuleId(),
    attribute,
    operator: operator || def.operator,
    value: value ?? defaultValueForAttribute(attribute),
  };
}

function defaultValueForAttribute(attribute) {
  switch (attribute) {
    case 'payment_method':
    case 'customer_type':
      return 'any';
    case 'cart_delay':
      return 25;
    case 'products':
    case 'products_exclude':
    case 'cart_products':
    case 'collections':
    case 'collections_exclude':
    case 'cart_collections':
      return { ids: [], titles: {} };
    case 'order_tags':
    case 'order_tags_exclude':
    case 'discount_code':
    case 'discount_code_exclude':
      return [];
    default:
      return '';
  }
}

/** Opt-in filters: orders match all by default; cart always has delay. */
function defaultRulesForEvent(entryType) {
  if (CART_EVENTS.includes(entryType)) {
    return [createRule('cart_delay', 25)];
  }
  return [];
}

function attributesForEvent(entryType) {
  return Object.entries(FILTER_ATTRIBUTES)
    .filter(([, def]) => {
      if (CART_EVENTS.includes(entryType)) return def.cartEvents;
      if (ORDER_EVENTS.includes(entryType)) return def.orderEvents;
      return false;
    })
    .map(([key]) => key);
}

function isRuleActive(rule) {
  if (!rule?.attribute) return false;
  const val = rule.value;
  if (rule.attribute === 'payment_method' || rule.attribute === 'customer_type') {
    return val && val !== 'any';
  }
  if (rule.attribute === 'cart_delay') return Number(val) > 0;
  if (['products', 'products_exclude', 'cart_products', 'collections', 'collections_exclude', 'cart_collections'].includes(rule.attribute)) {
    return productRuleIds(val).length > 0;
  }
  if (['order_tags', 'order_tags_exclude', 'discount_code', 'discount_code_exclude'].includes(rule.attribute)) {
    return tagListIds(val).length > 0;
  }
  if (['order_total_min', 'order_total_max', 'cart_value_min', 'line_item_count_min', 'line_item_count_max'].includes(rule.attribute)) {
    return Number(val) > 0;
  }
  return false;
}

/** Migrate legacy flat filters + normalize rules array for evaluator. */
function normalizeTriggerRules(raw = {}) {
  if (!raw || typeof raw !== 'object') return [];

  if (Array.isArray(raw.rules) && raw.rules.length) {
    return raw.rules
      .filter((r) => r && r.attribute && FILTER_ATTRIBUTES[r.attribute] && !REMOVED_FILTER_ATTRIBUTES.has(r.attribute))
      .map((r) => ({
        id: r.id || newRuleId(),
        attribute: r.attribute,
        operator: r.operator || FILTER_ATTRIBUTES[r.attribute].operator,
        value: r.value,
      }))
      .filter((r) => isRuleActive(r) || r.attribute === 'cart_delay');
  }

  const rules = [];
  if (raw.codOnly === true || raw.paymentMethod === 'cod') {
    rules.push(createRule('payment_method', 'cod'));
  } else if (raw.paymentMethod === 'prepaid') {
    rules.push(createRule('payment_method', 'prepaid'));
  }
  if (Number(raw.minOrderTotal) > 0) {
    rules.push(createRule('order_total_min', Number(raw.minOrderTotal)));
  }
  if (Number(raw.maxOrderTotal) > 0) {
    rules.push(createRule('order_total_max', Number(raw.maxOrderTotal)));
  }
  if (Array.isArray(raw.productIds) && raw.productIds.length) {
    rules.push(createRule('products', raw.productIds));
  }
  if (raw.cartDelayMinutes != null && Number(raw.cartDelayMinutes) > 0) {
    rules.push(createRule('cart_delay', Number(raw.cartDelayMinutes)));
  }
  return rules.filter((r) => isRuleActive(r) || r.attribute === 'cart_delay');
}

/** Persist only active rules; payment_method any / empty totals are omitted. */
function serializeTriggerRules(rules = []) {
  const active = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.attribute)
    .filter((r) => {
      if (r.attribute === 'payment_method') return r.value && r.value !== 'any';
      if (r.attribute === 'customer_type') return r.value && r.value !== 'any';
      return isRuleActive(r);
    })
    .map((r) => ({
      id: r.id || newRuleId(),
      attribute: r.attribute,
      operator: r.operator || FILTER_ATTRIBUTES[r.attribute]?.operator || 'is',
      value: r.value,
    }));

  const legacy = { codOnly: false, productIds: [] };
  for (const r of active) {
    if (r.attribute === 'payment_method' && r.value === 'cod') legacy.codOnly = true;
    if (r.attribute === 'payment_method' && r.value === 'prepaid') legacy.paymentMethod = 'prepaid';
    if (r.attribute === 'order_total_min') legacy.minOrderTotal = Number(r.value);
    if (r.attribute === 'order_total_max') legacy.maxOrderTotal = Number(r.value);
    if (r.attribute === 'products') legacy.productIds = productRuleIds(r.value);
    if (r.attribute === 'cart_delay') legacy.cartDelayMinutes = Number(r.value) || 25;
  }

  return {
    rules: active,
    ...legacy,
  };
}

function summarizeTriggerRules(rules = [], entryType) {
  const parts = [];
  const normalized = Array.isArray(rules) ? rules : normalizeTriggerRules({ rules });

  for (const r of normalized) {
    if (!isRuleActive(r) && r.attribute !== 'cart_delay') continue;
    if (r.attribute === 'payment_method') {
      if (r.value === 'cod') parts.push('COD');
      if (r.value === 'prepaid') parts.push('Prepaid');
    } else if (r.attribute === 'order_total_min') parts.push(`₹${r.value}+`);
    else if (r.attribute === 'order_total_max') parts.push(`≤₹${r.value}`);
    else if (['products', 'cart_products'].includes(r.attribute)) {
      const count = productRuleIds(r.value).length;
      if (count) parts.push(`${count} SKU(s)`);
    } else if (r.attribute === 'customer_type' && r.value !== 'any') {
      parts.push(r.value === 'first_time' ? 'First order' : 'Returning');
    } else if (r.attribute === 'cart_delay') parts.push(`${r.value}m wait`);
    else if (r.attribute === 'cart_value_min') parts.push(`Cart ₹${r.value}+`);
  }

  if (!parts.length && ORDER_EVENTS.includes(entryType)) return ['All orders'];
  if (entryType === 'cart_abandoned') {
    const delayRule = normalized.find((r) => r.attribute === 'cart_delay');
    const delay = delayRule?.value || 25;
    const onlyDelay = parts.length === 1 && parts[0] === `${delay}m wait`;
    if (!parts.length || onlyDelay) return [`All carts after ${delay}m`];
  }

  return parts;
}

module.exports = {
  FILTER_ATTRIBUTES,
  ORDER_EVENTS,
  CART_EVENTS,
  REMOVED_FILTER_ATTRIBUTES,
  newRuleId,
  createRule,
  defaultValueForAttribute,
  defaultRulesForEvent,
  attributesForEvent,
  isRuleActive,
  productRuleIds,
  collectionRuleIds,
  tagListIds,
  normalizeTriggerRules,
  serializeTriggerRules,
  summarizeTriggerRules,
};
