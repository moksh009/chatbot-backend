'use strict';

const mongoose = require('mongoose');
const FollowUpSequence = require('../../models/FollowUpSequence');
const { formatLineItemsSummary } = require('../../utils/commerce/orderLineItemEnrichment');
const log = require('../../utils/core/logger')('SequenceContext');

const ORDER_TRIGGER_TYPES = new Set(['order_placed', 'order_shipped', 'order_delivered']);
const RESERVED_CONTEXT_KEYS = new Set([
  'webhookSnapshot',
  'triggerType',
  'blueprintFlowId',
  'enrolledAt',
  '_frozen',
  '_lifecycle',
]);

function sanitizeAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const countryCode = String(
    addr.country_code || addr.countryCode || addr.country || ''
  ).trim();
  return {
    first_name: addr.first_name || addr.firstName || '',
    last_name: addr.last_name || addr.lastName || '',
    phone: addr.phone || '',
    address1: addr.address1 || addr.line1 || '',
    address2: addr.address2 || addr.line2 || '',
    city: addr.city || '',
    province: addr.province || addr.state || '',
    zip: addr.zip || addr.postal_code || '',
    country: addr.country || countryCode || '',
    countryCode,
  };
}

/**
 * Extract a minimal commerce snapshot from a Shopify order webhook payload.
 * Does NOT persist the full webhook JSON.
 */
function extractWebhookSnapshot(shopifyPayload = {}) {
  if (!shopifyPayload || typeof shopifyPayload !== 'object') return null;

  const rawItems = Array.isArray(shopifyPayload.line_items) ? shopifyPayload.line_items : [];
  const numericOrderId =
    shopifyPayload.id != null
      ? String(shopifyPayload.id)
      : String(shopifyPayload.name || '').replace(/\D/g, '') || '';

  const lineItems = rawItems
    .map((li) => {
      const variantId = li?.variant_id != null ? String(li.variant_id) : '';
      const productId = li?.product_id != null ? String(li.product_id) : '';
      return {
        variant_id: variantId,
        product_id: productId,
        variantGid: variantId ? `gid://shopify/ProductVariant/${variantId}` : '',
        productGid: productId ? `gid://shopify/Product/${productId}` : '',
        quantity: Number(li?.quantity) || 1,
        unitPrice: li?.price != null ? String(li.price) : '',
        title: li?.title || li?.name || '',
        variant_title: li?.variant_title || '',
      };
    })
    .filter((li) => li.variant_id || li.product_id);

  const customerNumeric =
    shopifyPayload.customer?.id != null
      ? String(shopifyPayload.customer.id)
      : shopifyPayload.customer_id != null
        ? String(shopifyPayload.customer_id)
        : '';

  const shippingAddress = sanitizeAddress(
    shopifyPayload.shipping_address || shopifyPayload.billing_address || null
  );

  const paymentGateways = Array.isArray(shopifyPayload.payment_gateway_names)
    ? shopifyPayload.payment_gateway_names.map((g) => String(g)).filter(Boolean)
    : [];

  const orderName = String(shopifyPayload.name || shopifyPayload.order_number || '');

  return {
    lineItems,
    shippingAddress,
    customer: customerNumeric,
    customerGid: customerNumeric ? `gid://shopify/Customer/${customerNumeric}` : '',
    financial_status: shopifyPayload.financial_status != null
      ? String(shopifyPayload.financial_status)
      : '',
    payment_gateway_names: paymentGateways,
    orderId: orderName || numericOrderId,
    orderName,
    shopifyOrderNumericId: numericOrderId,
    shopifyOrderGid: numericOrderId ? `gid://shopify/Order/${numericOrderId}` : '',
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Cart / lead snapshot for cart_abandoned enrollments (AdLead-shaped payload).
 */
function extractCartSnapshotFromLead(leadPayload = {}) {
  if (!leadPayload || typeof leadPayload !== 'object') return null;

  const rawItems =
    leadPayload.cartSnapshot?.items ||
    leadPayload.cartItems ||
    leadPayload.lineItems ||
    [];

  const lineItems = (Array.isArray(rawItems) ? rawItems : [])
    .map((li) => ({
      variant_id: String(li?.variant_id || li?.variantId || ''),
      product_id: String(li?.product_id || li?.productId || ''),
      quantity: Number(li?.quantity) || 1,
    }))
    .filter((li) => li.variant_id || li.product_id);

  return {
    lineItems,
    shippingAddress: sanitizeAddress(leadPayload.shippingAddress || null),
    customer: leadPayload.shopifyCustomerId ? String(leadPayload.shopifyCustomerId) : '',
    financial_status: '',
    payment_gateway_names: [],
    cartValue: leadPayload.cartValue ?? leadPayload.cartTotal ?? leadPayload.cartSnapshot?.total_price ?? null,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Build isolated per-enrollment memory at FollowUpSequence.create().
 */
function buildInitialSequenceContext({
  triggerType,
  rawPayload = null,
  blueprintFlowId = '',
  leadPayload = null,
  normalizedPhone = '',
}) {
  const ctx = {
    triggerType: String(triggerType || 'manual'),
    blueprintFlowId: String(blueprintFlowId || ''),
    enrolledAt: new Date().toISOString(),
    _frozen: false,
    _lifecycle: 'active',
  };

  const phoneDigits = String(
    normalizedPhone
    || leadPayload?.phoneNumber
    || leadPayload?.phone
    || rawPayload?.phone
    || ''
  ).replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    ctx.normalizedPhone = phoneDigits;
  }

  if (ORDER_TRIGGER_TYPES.has(ctx.triggerType) && rawPayload) {
    const snap = extractWebhookSnapshot(rawPayload);
    if (snap) ctx.webhookSnapshot = snap;
  } else if (ctx.triggerType === 'cart_abandoned' && (leadPayload || rawPayload)) {
    const snap = extractCartSnapshotFromLead(leadPayload || rawPayload);
    if (snap && (snap.lineItems.length || snap.cartValue != null)) {
      ctx.webhookSnapshot = snap;
    }
  } else if (ctx.triggerType === 'manual' && leadPayload) {
    const snap = extractCartSnapshotFromLead(leadPayload);
    if (snap?.lineItems?.length) ctx.webhookSnapshot = snap;
  }

  return ctx;
}

/**
 * Flatten sequenceContext → template variable dictionary.
 * sequenceContext values override normalized DB order fields when merged later.
 */
function flattenSequenceContextForTemplates(sequenceContext = {}) {
  if (!sequenceContext || typeof sequenceContext !== 'object') return {};

  const flat = {};

  for (const [key, value] of Object.entries(sequenceContext)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'object') {
      flat[key] = value;
    } else {
      flat[key] = String(value);
    }
  }

  const snap = sequenceContext.webhookSnapshot;
  if (snap && typeof snap === 'object') {
    if (snap.customer) flat.shopify_customer_id = String(snap.customer);
    if (snap.financial_status) flat.financial_status = String(snap.financial_status);
    if (Array.isArray(snap.payment_gateway_names) && snap.payment_gateway_names.length) {
      flat.payment_gateway_names = snap.payment_gateway_names.join(', ');
      flat.payment_method = snap.payment_gateway_names[0];
    }
    if (snap.orderId) flat.order_id = String(snap.orderId);

    const items = Array.isArray(snap.lineItems) ? snap.lineItems : [];
    if (items.length) {
      flat.line_items = items;
      flat.order_items = formatLineItemsSummary(
        items.map((li) => ({
          title: li.title || li.name || `Product ${li.product_id || li.variant_id || ''}`.trim(),
          quantity: li.quantity || 1,
          variant_title: li.variant_title || '',
        }))
      );
      const first = items[0];
      if (first?.product_id) flat.first_product_id = String(first.product_id);
      if (first?.variant_id) flat.first_variant_id = String(first.variant_id);
    }

    if (snap.shippingAddress) {
      const a = snap.shippingAddress;
      flat.shipping_address = [
        a.address1,
        a.address2,
        a.city,
        a.province,
        a.zip,
      ]
        .filter(Boolean)
        .join(', ');
    }

    if (snap.cartValue != null && snap.cartValue !== '') {
      flat.cart_total = `₹${Number(snap.cartValue).toLocaleString('en-IN')}`;
    }
  }

  return flat;
}

/**
 * Merge sequenceContext on top of base send context (sequence wins on conflict).
 */
function applySequenceContextToSendContext(baseContext = {}, sequenceContext = null) {
  if (!sequenceContext || typeof sequenceContext !== 'object') return { ...baseContext };
  const seqFlat = flattenSequenceContextForTemplates(sequenceContext);
  return { ...baseContext, ...seqFlat, _sequenceContext: sequenceContext };
}

function sequenceObjectId(sequenceId) {
  const s = String(sequenceId || '');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Safely inject data into this enrollment's isolated memory.
 * Only allowed while sequence status is `active` (no bleed to lead profile or other sequences).
 */
async function updateSequenceContext(sequenceId, key, value, { clientId } = {}) {
  if (!sequenceId || !key) {
    return { ok: false, reason: 'missing_args' };
  }

  const oid = sequenceObjectId(sequenceId);
  if (!oid) return { ok: false, reason: 'invalid_sequence_id' };

  const query = { _id: oid };
  if (clientId) query.clientId = String(clientId);

  const seq = await FollowUpSequence.findOne(query).select('status sequenceContext').lean();
  if (!seq) return { ok: false, reason: 'not_found' };
  if (seq.status !== 'active') {
    return { ok: false, reason: 'sequence_not_active', status: seq.status };
  }
  if (seq.sequenceContext?._frozen) {
    return { ok: false, reason: 'context_frozen' };
  }

  const safeKey = String(key).replace(/^\$/, '').trim();
  if (!safeKey || safeKey.includes('.')) {
    return { ok: false, reason: 'invalid_key' };
  }

  const updated = await FollowUpSequence.findOneAndUpdate(
    query,
    { $set: { [`sequenceContext.${safeKey}`]: value } },
    { new: true }
  ).select('sequenceContext status');

  return { ok: true, sequenceContext: updated?.sequenceContext || {} };
}

/**
 * Graceful pre-flight for steps that require enrollment memory (action nodes).
 * Never throws — returns { ok, reason, missing }.
 */
function assertSequenceContextForStep(sequence, step = {}) {
  const required = Array.isArray(step.requiredContextKeys)
    ? step.requiredContextKeys
    : step.requiresWebhookSnapshot
      ? ['webhookSnapshot']
      : [];

  if (!required.length) {
    return { ok: true };
  }

  const ctx = sequence?.sequenceContext || {};
  const missing = [];

  for (const key of required) {
    if (key === 'webhookSnapshot') {
      if (!ctx.webhookSnapshot || typeof ctx.webhookSnapshot !== 'object') {
        missing.push('webhookSnapshot');
      }
      continue;
    }
    if (ctx[key] == null) missing.push(key);
  }

  if (missing.length) {
    return { ok: false, reason: `missing_sequence_context:${missing.join(',')}`, missing };
  }

  return { ok: true };
}

/**
 * When template mappings need order/cart data but neither DB order nor snapshot exists.
 */
function assertOrderContextAvailable(sequence, orderPayload, { mappingsNeedOrder = false } = {}) {
  if (!mappingsNeedOrder) return { ok: true };

  const hasOrderDoc = Boolean(
    orderPayload &&
      (orderPayload.orderId || orderPayload.orderNumber || orderPayload.name)
  );
  const hasSnapshot = Boolean(sequence?.sequenceContext?.webhookSnapshot);

  if (hasOrderDoc || hasSnapshot) return { ok: true };

  return { ok: false, reason: 'missing_order_context', missing: ['webhookSnapshot', 'order'] };
}

function stepMappingsNeedOrderContext(mappings = {}) {
  const ORDER_FIELDS = new Set([
    'order_id',
    'order_number',
    'order_items',
    'order_total',
    'payment_method',
    'tracking_url',
    'shipping_address',
    'first_product_image',
    'shopify_customer_id',
  ]);
  const body = mappings.body || mappings;
  return Object.values(body || {}).some((v) => ORDER_FIELDS.has(String(v)));
}

const CONTEXT_ACTION_STEP_TYPES = new Set([
  'whatsapp',
  'email',
  'flow_handoff',
  'review_request',
  'warranty_resend',
  'cod_prepaid',
]);

/**
 * Ghost nodes (wait/condition/end) compile into sendAt delays — only action steps load enrollment memory.
 */
function stepNeedsContextResolution(step = {}) {
  if (Array.isArray(step.requiredContextKeys) && step.requiredContextKeys.length) return true;
  if (step.requiresWebhookSnapshot) return true;
  const t = String(step.type || 'whatsapp').toLowerCase();
  return CONTEXT_ACTION_STEP_TYPES.has(t);
}

/**
 * Part 3 — COD → Prepaid execution preflight.
 * Never throws; returns { ok, reason?, missing? }.
 */
function assertCodPrepaidEnrollmentContext(sequence, lead = null) {
  const missing = [];
  const ctx = sequence?.sequenceContext || {};
  const snap = ctx.webhookSnapshot;

  const normalizedPhone =
    ctx.normalizedPhone ||
    String(sequence?.phone || lead?.phoneNumber || lead?.phone || '').replace(/\D/g, '');
  if (!normalizedPhone || normalizedPhone.length < 8) {
    missing.push('normalizedPhone');
  }

  if (!snap || typeof snap !== 'object') {
    missing.push('webhookSnapshot');
    return { ok: false, reason: 'missing_cod_prepaid_context', missing };
  }

  if (!snap.shopifyOrderNumericId) missing.push('shopifyOrderNumericId');
  if (!snap.shopifyOrderGid) missing.push('shopifyOrderGid');

  const items = Array.isArray(snap.lineItems) ? snap.lineItems : [];
  if (!items.length) {
    missing.push('lineItems');
  } else {
    for (const li of items) {
      if (!li.variantGid) {
        missing.push('lineItems.variantGid');
        break;
      }
      const qty = Number(li.quantity);
      if (!Number.isFinite(qty) || qty < 1) {
        missing.push('lineItems.quantity');
        break;
      }
      if (li.unitPrice == null || String(li.unitPrice).trim() === '') {
        missing.push('lineItems.unitPrice');
        break;
      }
    }
  }

  const addr = snap.shippingAddress;
  if (!addr || typeof addr !== 'object') {
    missing.push('shippingAddress');
  } else {
    if (!String(addr.address1 || '').trim()) missing.push('shippingAddress.address1');
    if (!String(addr.city || '').trim()) missing.push('shippingAddress.city');
    if (!String(addr.zip || '').trim()) missing.push('shippingAddress.zip');
    const countryCode = String(addr.countryCode || addr.country || '').trim();
    if (!countryCode) missing.push('shippingAddress.countryCode');
  }

  if (missing.length) {
    return { ok: false, reason: 'missing_cod_prepaid_context', missing };
  }

  return { ok: true };
}

async function markSequenceContextLifecycleBulk(sequenceIds, lifecycle) {
  const oids = (sequenceIds || []).map(sequenceObjectId).filter(Boolean);
  if (!oids.length) return;
  await FollowUpSequence.updateMany(
    { _id: { $in: oids } },
    { $set: { 'sequenceContext._lifecycle': String(lifecycle), 'sequenceContext._frozen': true } }
  ).catch((err) => {
    log.warn(`markSequenceContextLifecycleBulk failed: ${err.message}`);
  });
}

async function markSequenceContextLifecycle(sequenceId, lifecycle) {
  const oid = sequenceObjectId(sequenceId);
  if (!oid) return;
  await FollowUpSequence.updateOne(
    { _id: oid },
    { $set: { 'sequenceContext._lifecycle': String(lifecycle), 'sequenceContext._frozen': true } }
  ).catch((err) => {
    log.warn(`markSequenceContextLifecycle failed: ${err.message}`);
  });
}

module.exports = {
  RESERVED_CONTEXT_KEYS,
  extractWebhookSnapshot,
  extractCartSnapshotFromLead,
  buildInitialSequenceContext,
  flattenSequenceContextForTemplates,
  applySequenceContextToSendContext,
  updateSequenceContext,
  assertSequenceContextForStep,
  assertOrderContextAvailable,
  stepMappingsNeedOrderContext,
  stepNeedsContextResolution,
  assertCodPrepaidEnrollmentContext,
  markSequenceContextLifecycle,
  markSequenceContextLifecycleBulk,
};
