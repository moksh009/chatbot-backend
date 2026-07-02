'use strict';

const Order = require('../../models/Order');
const ShopifyProduct = require('../../models/ShopifyProduct');
const { isCodShopifyOrder } = require('../../utils/commerce/canonicalOrderMessages');
const {
  normalizeTriggerRules,
  ORDER_EVENTS,
  CART_EVENTS,
  productRuleIds,
  collectionRuleIds,
} = require('./triggerFilterCatalog');
const log = require('../../utils/core/logger')('JourneyTriggerEvaluator');

function extractLineProductIds(payload) {
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  return lineItems.map((li) => String(li?.product_id || '')).filter(Boolean);
}

function cartValueFromPayload(payload) {
  const v = Number(payload?.cartValue ?? payload?.cartTotal ?? payload?.total_price ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function cartProductIdsFromPayload(payload) {
  if (Array.isArray(payload?.productIds)) return payload.productIds.map(String).filter(Boolean);
  if (Array.isArray(payload?.cartItems)) {
    return payload.cartItems
      .map((li) => String(li?.product_id || li?.productId || ''))
      .filter(Boolean);
  }
  if (Array.isArray(payload?.lineItems)) {
    return payload.lineItems.map((li) => String(li?.product_id || li?.productId || '')).filter(Boolean);
  }
  return extractLineProductIds(payload);
}

async function isFirstTimeCustomer(clientId, payload) {
  const customerId = String(payload?.customer?.id || payload?.customer_id || '').trim();
  if (!clientId || !customerId) return true;
  const orderId = String(payload?.name || payload?.id || payload?.orderId || '').trim();
  const priorCount = await Order.countDocuments({
    clientId,
    shopifyCustomerId: customerId,
    ...(orderId ? { orderId: { $ne: orderId } } : {}),
  });
  return priorCount === 0;
}

function parseOrderTags(payload) {
  const raw = payload?.tags || '';
  return String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function parseDiscountCodes(payload) {
  const codes = [];
  if (Array.isArray(payload?.discount_codes)) {
    for (const d of payload.discount_codes) {
      if (d?.code) codes.push(String(d.code).trim().toLowerCase());
    }
  }
  if (Array.isArray(payload?.discount_applications)) {
    for (const d of payload.discount_applications) {
      const c = d?.code || d?.title;
      if (c) codes.push(String(c).trim().toLowerCase());
    }
  }
  return [...new Set(codes)];
}

function lineItemCount(payload) {
  const items = payload?.line_items;
  return Array.isArray(items) ? items.length : 0;
}

async function productIdsMatchCollections(clientId, shopifyProductIds, collectionIds) {
  const pids = (Array.isArray(shopifyProductIds) ? shopifyProductIds : []).map(String).filter(Boolean);
  const cids = (Array.isArray(collectionIds) ? collectionIds : []).map(String).filter(Boolean);
  if (!pids.length || !cids.length || !clientId) return false;
  const hit = await ShopifyProduct.countDocuments({
    clientId,
    shopifyProductId: { $in: pids },
    collectionIds: { $in: cids },
  });
  return hit > 0;
}

const ASYNC_COLLECTION_ATTRS = new Set(['collections', 'collections_exclude', 'cart_collections']);

function tagListMatch(wanted, haystack) {
  const w = (Array.isArray(wanted) ? wanted : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (!w.length) return true;
  return w.some((t) => haystack.includes(t));
}

function evaluateSyncRule(rule, triggerType, payload) {
  const { attribute, value } = rule;

  if (attribute === 'payment_method') {
    if (!value || value === 'any') return true;
    const isCod = isCodShopifyOrder(payload);
    if (value === 'cod') return isCod;
    if (value === 'prepaid') return !isCod;
    return true;
  }

  if (attribute === 'order_total_min' && ORDER_EVENTS.includes(triggerType)) {
    const total = Number(payload?.total_price || payload?.subtotal_price || 0);
    return total >= Number(value);
  }

  if (attribute === 'order_total_max' && ORDER_EVENTS.includes(triggerType)) {
    const total = Number(payload?.total_price || payload?.subtotal_price || 0);
    return total <= Number(value);
  }

  if (attribute === 'products' && ORDER_EVENTS.includes(triggerType)) {
    const wanted = productRuleIds(value);
    if (!wanted.length) return true;
    const orderIds = extractLineProductIds(payload);
    return wanted.some((id) => orderIds.includes(String(id)));
  }

  if (attribute === 'products_exclude' && ORDER_EVENTS.includes(triggerType)) {
    const blocked = productRuleIds(value);
    if (!blocked.length) return true;
    const orderIds = extractLineProductIds(payload);
    return !blocked.some((id) => orderIds.includes(String(id)));
  }

  if (attribute === 'order_tags' && ORDER_EVENTS.includes(triggerType)) {
    const wanted = Array.isArray(value) ? value : [];
    if (!wanted.length) return true;
    return tagListMatch(wanted, parseOrderTags(payload));
  }

  if (attribute === 'order_tags_exclude' && ORDER_EVENTS.includes(triggerType)) {
    const blocked = Array.isArray(value) ? value : [];
    if (!blocked.length) return true;
    return !tagListMatch(blocked, parseOrderTags(payload));
  }

  if (attribute === 'discount_code' && ORDER_EVENTS.includes(triggerType)) {
    const wanted = Array.isArray(value) ? value : [];
    if (!wanted.length) return true;
    return tagListMatch(wanted, parseDiscountCodes(payload));
  }

  if (attribute === 'discount_code_exclude' && ORDER_EVENTS.includes(triggerType)) {
    const blocked = Array.isArray(value) ? value : [];
    if (!blocked.length) return true;
    return !tagListMatch(blocked, parseDiscountCodes(payload));
  }

  if (attribute === 'line_item_count_min' && ORDER_EVENTS.includes(triggerType)) {
    return lineItemCount(payload) >= Number(value);
  }

  if (attribute === 'line_item_count_max' && ORDER_EVENTS.includes(triggerType)) {
    return lineItemCount(payload) <= Number(value);
  }

  if (attribute === 'cart_value_min' && CART_EVENTS.includes(triggerType)) {
    return cartValueFromPayload(payload) >= Number(value);
  }

  if (attribute === 'cart_products' && CART_EVENTS.includes(triggerType)) {
    const wanted = productRuleIds(value);
    if (!wanted.length) return true;
    const ids = cartProductIdsFromPayload(payload);
    return wanted.some((id) => ids.includes(String(id)));
  }

  if (attribute === 'cart_delay' && CART_EVENTS.includes(triggerType)) {
    const delayMin = Number(value) || 25;
    const abandonedAt = payload?.cartAbandonedAt || payload?.lastCartEventAt;
    if (!abandonedAt) return false;
    const elapsed = Date.now() - new Date(abandonedAt).getTime();
    return elapsed >= delayMin * 60 * 1000;
  }

  log.warn(`[JourneyTriggerEvaluator] unknown rule attribute "${attribute}" — fail closed`);
  return false;
}

async function evaluateAsyncRule(rule, clientId, triggerType, payload) {
  if (rule.attribute === 'customer_type' && ORDER_EVENTS.includes(triggerType)) {
    if (!rule.value || rule.value === 'any') return true;
    const isFirst = await isFirstTimeCustomer(clientId, payload);
    if (rule.value === 'first_time') return isFirst;
    if (rule.value === 'returning') return !isFirst;
    return true;
  }

  if (rule.attribute === 'collections' && ORDER_EVENTS.includes(triggerType)) {
    const wanted = collectionRuleIds(rule.value);
    if (!wanted.length) return true;
    const orderIds = extractLineProductIds(payload);
    return productIdsMatchCollections(clientId, orderIds, wanted);
  }

  if (rule.attribute === 'collections_exclude' && ORDER_EVENTS.includes(triggerType)) {
    const blocked = collectionRuleIds(rule.value);
    if (!blocked.length) return true;
    const orderIds = extractLineProductIds(payload);
    const hit = await productIdsMatchCollections(clientId, orderIds, blocked);
    return !hit;
  }

  if (rule.attribute === 'cart_collections' && CART_EVENTS.includes(triggerType)) {
    const wanted = collectionRuleIds(rule.value);
    if (!wanted.length) return true;
    const ids = cartProductIdsFromPayload(payload);
    return productIdsMatchCollections(clientId, ids, wanted);
  }

  return evaluateSyncRule(rule, triggerType, payload);
}

/**
 * Evaluate all trigger rules (AND logic). Empty rules = match all.
 */
async function evaluateTriggerRules({ clientId, triggerType, payload, filters }) {
  const rules = normalizeTriggerRules(filters);
  if (!rules.length) return { match: true };

  for (const rule of rules) {
    const needsAsync =
      (ORDER_EVENTS.includes(triggerType) && (rule.attribute === 'customer_type' || rule.attribute === 'collections' || rule.attribute === 'collections_exclude'))
      || (CART_EVENTS.includes(triggerType) && rule.attribute === 'cart_collections');
    const ok = needsAsync
      ? await evaluateAsyncRule(rule, clientId, triggerType, payload)
      : evaluateSyncRule(rule, triggerType, payload);
    if (!ok) {
      return { match: false, reason: `${rule.attribute}_mismatch` };
    }
  }
  return { match: true };
}

module.exports = {
  evaluateTriggerRules,
  evaluateSyncRule,
  evaluateAsyncRule,
  productIdsMatchCollections,
  isCodShopifyOrder,
  cartProductIdsFromPayload,
};
