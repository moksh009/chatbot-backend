'use strict';

const Order = require('../../models/Order');
const { isCodShopifyOrder } = require('../../utils/commerce/canonicalOrderMessages');
const { normalizeTriggerRules, ORDER_EVENTS, CART_EVENTS } = require('./triggerFilterCatalog');

function extractLineProductIds(payload) {
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  return lineItems.map((li) => String(li?.product_id || '')).filter(Boolean);
}

function extractOrderTags(payload) {
  const raw = payload?.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return String(raw || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function extractShippingField(payload, field) {
  const addr = payload?.shipping_address || payload?.billing_address || {};
  return String(addr[field] || '').trim().toLowerCase();
}

function cartValueFromPayload(payload) {
  const v = Number(payload?.cartValue ?? payload?.cartTotal ?? payload?.total_price ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function cartProductIdsFromPayload(payload) {
  if (Array.isArray(payload?.productIds)) return payload.productIds.map(String).filter(Boolean);
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

function evaluateSyncRule(rule, triggerType, payload) {
  const { attribute, operator, value } = rule;

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
    const wanted = Array.isArray(value) ? value.map(String) : [];
    if (!wanted.length) return true;
    const orderIds = extractLineProductIds(payload);
    return wanted.some((id) => orderIds.includes(String(id)));
  }

  if (attribute === 'products_exclude' && ORDER_EVENTS.includes(triggerType)) {
    const blocked = Array.isArray(value) ? value.map(String) : [];
    if (!blocked.length) return true;
    const orderIds = extractLineProductIds(payload);
    return !blocked.some((id) => orderIds.includes(String(id)));
  }

  if (attribute === 'order_tags' && ORDER_EVENTS.includes(triggerType)) {
    const wanted = (Array.isArray(value) ? value : String(value || '').split(','))
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length) return true;
    const tags = extractOrderTags(payload);
    return wanted.some((t) => tags.includes(t));
  }

  if (attribute === 'shipping_state' && ORDER_EVENTS.includes(triggerType)) {
    const want = String(value || '').trim().toLowerCase();
    if (!want) return true;
    return extractShippingField(payload, 'province') === want
      || extractShippingField(payload, 'province_code') === want;
  }

  if (attribute === 'shipping_city' && ORDER_EVENTS.includes(triggerType)) {
    const want = String(value || '').trim().toLowerCase();
    if (!want) return true;
    return extractShippingField(payload, 'city') === want;
  }

  if (attribute === 'cart_value_min' && CART_EVENTS.includes(triggerType)) {
    return cartValueFromPayload(payload) >= Number(value);
  }

  if (attribute === 'cart_products' && CART_EVENTS.includes(triggerType)) {
    const wanted = Array.isArray(value) ? value.map(String) : [];
    if (!wanted.length) return true;
    const ids = cartProductIdsFromPayload(payload);
    return wanted.some((id) => ids.includes(String(id)));
  }

  if (attribute === 'cart_delay') {
    return true;
  }

  return true;
}

async function evaluateAsyncRule(rule, clientId, triggerType, payload) {
  if (rule.attribute === 'customer_type' && ORDER_EVENTS.includes(triggerType)) {
    if (!rule.value || rule.value === 'any') return true;
    const isFirst = await isFirstTimeCustomer(clientId, payload);
    if (rule.value === 'first_time') return isFirst;
    if (rule.value === 'returning') return !isFirst;
    return true;
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
    const ok = ORDER_EVENTS.includes(triggerType) && rule.attribute === 'customer_type'
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
  isCodShopifyOrder,
};
