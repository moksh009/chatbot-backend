'use strict';

/**
 * Fulfillment + Payment status automations.
 *
 * Drives the new 12 system rules surfaced on /shopify-automation-center:
 *
 *   FULFILLMENT STATUS
 *     - unfulfilled  / partial  / fulfilled  / on_hold  / scheduled
 *
 *   PAYMENT STATUS
 *     - pending  / authorized  / paid  / partially_paid
 *     - refunded / partially_refunded / voided
 *
 * Trigger source: Shopify webhooks `orders/create`, `orders/updated`,
 * `refunds/create`. The handler:
 *
 *   1. Normalises financial_status + fulfillment_status from the payload
 *      (null fulfillment_status → 'unfulfilled').
 *   2. Loads merchant rules from Client.commerceAutomations.
 *   3. For each status type with a value, picks active rules matching
 *      { triggerStatusType, triggerStatus }.
 *   4. Enforces:
 *        - opt-out check on AdLead.optStatus
 *        - specific-product scope (line_items[].product_id)
 *        - dedup via OrderStatusSent unique (clientId, orderId, statusKey)
 *   5. Sends via templateSender.sendForAutomation, then writes the
 *      OrderStatusSent row only on a confirmed send.
 *
 * Any thrown error is swallowed and logged — webhook delivery to Shopify
 * already responded 200 by the time this runs.
 */

const log = require('../core/logger')('OrderStatusAutomation');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const OrderStatusSent = require('../../models/OrderStatusSent');

const FULFILLMENT_VALUES = new Set([
  'unfulfilled',
  'partial',
  'fulfilled',
  'on_hold',
  'scheduled',
]);

const FINANCIAL_VALUES = new Set([
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'refunded',
  'partially_refunded',
  'voided',
]);

function normalizeProductId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)$/);
  return m ? m[1] : s;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Pull a clean Shopify status snapshot from a webhook payload.
 * `null`/missing fulfillment_status is treated as 'unfulfilled' (Shopify uses
 * null for orders with line items that have not been packed).
 */
function readStatusesFromPayload(payload = {}) {
  const fin = String(payload.financial_status || '').toLowerCase().trim();
  const fulRaw = payload.fulfillment_status;
  const ful = fulRaw == null || fulRaw === ''
    ? 'unfulfilled'
    : String(fulRaw).toLowerCase().trim();

  return {
    financial: FINANCIAL_VALUES.has(fin) ? fin : '',
    fulfillment: FULFILLMENT_VALUES.has(ful) ? ful : '',
  };
}

function buildStatusKey(type, status) {
  return `${type}_status_${status}`;
}

function ruleMatchesStatus(rule, type, status) {
  if (!rule || rule.isActive !== true) return false;
  if (!rule.templateName) return false;
  if (String(rule.triggerStatusType || '') !== type) return false;
  if (String(rule.triggerStatus || '').toLowerCase() !== status) return false;
  return true;
}

function ruleProductMatch(rule, payload) {
  const scope = String(rule.triggerScope || 'every_order');
  if (scope !== 'specific_product') return true;
  const targetIds = Array.isArray(rule.productIds) ? rule.productIds : [];
  const legacy = Array.isArray(rule.targetProductIds) ? rule.targetProductIds : [];
  const wantIds = new Set(
    [...targetIds, ...legacy]
      .map(normalizeProductId)
      .filter(Boolean)
  );
  if (!wantIds.size) return true; /** scope set but no products picked yet → behave like every_order */
  const items = payload.line_items || [];
  for (const item of items) {
    if (wantIds.has(normalizeProductId(item.product_id))) return true;
  }
  return false;
}

async function isPhoneOptedOut(clientId, phone) {
  if (!phone) return false;
  try {
    const lead = await AdLead.findOne({ clientId, phoneNumber: phone })
      .select('optStatus')
      .lean();
    return lead?.optStatus === 'opted_out';
  } catch (_) {
    return false;
  }
}

async function alreadySentForOrder({ clientId, orderId, statusKey }) {
  if (!clientId || !orderId || !statusKey) return false;
  const existing = await OrderStatusSent.findOne({
    clientId,
    orderId: String(orderId),
    statusKey,
  })
    .select('_id')
    .lean();
  return !!existing;
}

async function recordSent({ clientId, orderId, statusKey, ruleId, phone }) {
  try {
    await OrderStatusSent.create({
      clientId,
      orderId: String(orderId),
      statusKey,
      ruleId: String(ruleId || ''),
      phone: phone || '',
      sentAt: new Date(),
    });
  } catch (err) {
    /** Duplicate key races are fine — another worker beat us. */
    if (err?.code !== 11000) {
      log.warn(`recordSent failed: ${err.message}`);
    }
  }
}

function buildContextOrder(payload) {
  const cust = payload.customer || {};
  const ship = payload.shipping_address || {};
  const phone = payload.phone
    || cust.phone
    || payload.billing_address?.phone
    || ship.phone
    || '';
  const orderName = payload.name || payload.order_number || `#${payload.id}`;
  return {
    name: orderName,
    orderNumber: orderName,
    orderId: String(payload.id || payload.order_id || ''),
    customer: {
      first_name: cust.first_name || (String(payload.customer_name || '').split(' ')[0] || 'Customer'),
      name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.first_name || 'Customer',
    },
    customerName: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.first_name || 'Customer',
    phone,
    line_items: (payload.line_items || []).map((i) => ({
      title: i.title,
      name: i.title,
      sku: i.sku,
      product_id: i.product_id,
    })),
    total_price: payload.total_price,
    totalPrice: payload.total_price,
    payment_method: (payload.payment_gateway_names && payload.payment_gateway_names[0])
      || payload.gateway
      || '',
    financial_status: payload.financial_status || '',
    fulfillment_status: payload.fulfillment_status || '',
    shipping_address: ship,
    fulfillments: (payload.fulfillments || []).map((f) => ({
      tracking_url: f.tracking_url,
      tracking_number: f.tracking_number,
    })),
  };
}

async function dispatchRule({ client, rule, statusKey, type, status, payload, phoneNorm }) {
  const orderId = String(payload.id || payload.order_id || '');
  if (!orderId) return { skipped: true, reason: 'missing_order_id' };

  if (await alreadySentForOrder({ clientId: client.clientId, orderId, statusKey })) {
    return { skipped: true, reason: 'already_sent' };
  }

  if (!ruleProductMatch(rule, payload)) {
    return { skipped: true, reason: 'product_scope_no_match' };
  }

  if (!phoneNorm) return { skipped: true, reason: 'missing_phone' };

  if (await isPhoneOptedOut(client.clientId, phoneNorm)) {
    return { skipped: true, reason: 'opted_out' };
  }

  const { sendForAutomation } = require('../../services/templateSender');

  const result = await sendForAutomation({
    clientId: client.clientId,
    phone: phoneNorm,
    metaName: rule.templateName,
    contextType: 'order',
    trigger: null,
    variableMappings: rule.variableMappings || undefined,
    contextData: {
      order: buildContextOrder(payload),
      extra: {
        triggerStatusType: type,
        triggerStatus: status,
        ruleId: rule.id,
        customVariableValues: rule.customVariableValues || {},
      },
    },
    channel: 'whatsapp',
  }).catch((err) => {
    log.warn(`sendForAutomation threw: ${err.message}`);
    return null;
  });

  if (result?.whatsapp?.sent) {
    await recordSent({
      clientId: client.clientId,
      orderId,
      statusKey,
      ruleId: rule.id,
      phone: phoneNorm,
    });
    return { sent: true, ruleId: rule.id };
  }

  return {
    sent: false,
    ruleId: rule.id,
    reason: result?.whatsapp?.reason || result?.failureCode || 'send_failed',
  };
}

/**
 * Public entry: process an order webhook payload through the new fulfillment +
 * payment status rules.
 *
 * `client` is the resolved Client document (not lean — but lean is fine, we
 * only read clientId + commerceAutomations).
 *
 * Returns a per-rule outcome array; safe to log but not used by the webhook
 * response.
 */
async function processOrderStatusAutomations({ client, payload, source = 'unknown' }) {
  if (!client || !payload) return { processed: 0, outcomes: [] };
  const clientId = client.clientId;
  if (!clientId) return { processed: 0, outcomes: [] };

  const { financial, fulfillment } = readStatusesFromPayload(payload);
  if (!financial && !fulfillment) return { processed: 0, outcomes: [] };

  let rules = Array.isArray(client.commerceAutomations) ? client.commerceAutomations : null;
  if (!rules) {
    const fresh = await Client.findOne({ clientId })
      .select('commerceAutomations')
      .lean();
    rules = Array.isArray(fresh?.commerceAutomations) ? fresh.commerceAutomations : [];
  }

  const phoneRaw = payload.phone
    || payload.customer?.phone
    || payload.billing_address?.phone
    || payload.shipping_address?.phone
    || '';
  const phoneNorm = normalizePhone(phoneRaw);

  const outcomes = [];
  const checks = [];
  if (financial) checks.push({ type: 'financial', status: financial });
  if (fulfillment) checks.push({ type: 'fulfillment', status: fulfillment });

  for (const { type, status } of checks) {
    const statusKey = buildStatusKey(type, status);
    const matching = rules.filter((r) => ruleMatchesStatus(r, type, status));
    if (!matching.length) continue;

    for (const rule of matching) {
      try {
        const outcome = await dispatchRule({
          client,
          rule,
          statusKey,
          type,
          status,
          payload,
          phoneNorm,
        });
        outcomes.push({ statusKey, ruleId: rule.id, ...outcome });
      } catch (err) {
        log.error(
          `[${source}] rule ${rule.id} (${statusKey}) failed: ${err.message}`
        );
        outcomes.push({ statusKey, ruleId: rule.id, error: err.message });
      }
    }
  }

  if (outcomes.length) {
    log.info(
      `[${source}] ${clientId} order=${payload.id} fin=${financial || '-'} ful=${fulfillment || '-'} outcomes=${JSON.stringify(outcomes)}`
    );
  }

  return { processed: outcomes.length, outcomes };
}

module.exports = {
  processOrderStatusAutomations,
  readStatusesFromPayload,
  buildStatusKey,
  FULFILLMENT_VALUES,
  FINANCIAL_VALUES,
};
