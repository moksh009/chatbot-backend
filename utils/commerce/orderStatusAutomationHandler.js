'use strict';

/**
 * Order-status message automations (Jun 2026 — six rules on Order updates).
 *
 *   ORDER PLACED — fulfillment `unfulfilled` on `orders/create` (thank-you / confirmation)
 *   DELIVERY STATUS — courier `shipment_status` on fulfillments webhooks:
 *     in_transit | out_for_delivery | delivered | attempted_delivery | failure
 *
 * Trigger source: Shopify webhooks `orders/create`, `orders/updated`,
 * `fulfillments/create`, `fulfillments/update`, plus logistics inbound. The handler:
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

const {
  buildOrderEmailContext,
  resolveOrderEmailTemplate,
  ruleHasEmailConfig,
  normalizeRuleChannels,
} = require('../core/orderEmailMergeFields');
const {
  enrichLineItemsForCommerce,
  formatLineItemsSummary,
} = require('./orderLineItemEnrichment');
const {
  resolveOrderRecipientPhone,
  phoneLookupVariants,
} = require('./resolveOrderRecipientPhone');
const { isCodShopifyOrder } = require('./canonicalOrderMessages');
const log = require('../core/logger')('OrderStatusAutomation');
const { logDispatchEvent } = require('../messaging/dispatchEventLog');
const { maskPhone } = require('./ruleStatsDetailService');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
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

/** Courier tracking statuses surfaced as Delivery tracking rules. Shopify also
 *  emits label_printed / label_purchased / ready_for_pickup / confirmed, but
 *  those are internal logistics noise merchants don't message customers about. */
const SHIPMENT_VALUES = new Set([
  'in_transit',
  'out_for_delivery',
  'delivered',
  'attempted_delivery',
  'failure',
]);

const PAYMENT_VALUES = new Set(['cod']);

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
  if (String(rule.triggerStatusType || '') !== type) return false;
  if (String(rule.triggerStatus || '').toLowerCase() !== status) return false;
  const channels = normalizeRuleChannels(rule);
  const hasWa = channels.includes('whatsapp');
  const hasEmail = channels.includes('email');
  if (hasWa && !rule.templateName) return false;
  if (hasEmail && !ruleHasEmailConfig(rule)) return false;
  if (!hasWa && !hasEmail) return false;
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
    const variants = phoneLookupVariants(phone);
    const lead = await AdLead.findOne({
      clientId,
      phoneNumber: variants.length ? { $in: variants } : phone,
    })
      .select('optStatus')
      .lean();
    return lead?.optStatus === 'opted_out';
  } catch (_) {
    return false;
  }
}

function extractCustomerEmail(payload = {}) {
  const cust = payload.customer || {};
  return String(cust.email || payload.email || payload.contact_email || '').trim().toLowerCase();
}

async function alreadySentForOrder({ clientId, orderId, statusKey, channel = 'whatsapp' }) {
  if (!clientId || !orderId || !statusKey) return false;
  const channelFilter =
    channel === 'whatsapp'
      ? [{ channel: 'whatsapp' }, { channel: { $exists: false } }, { channel: '' }]
      : [{ channel: 'email' }];
  const existing = await OrderStatusSent.findOne({
    clientId,
    orderId: String(orderId),
    statusKey,
    $or: channelFilter,
  })
    .select('_id')
    .lean();
  return !!existing;
}

async function recordRuleSendOutcome(clientId, ruleId, outcome = {}) {
  if (!clientId || !ruleId) return;
  let errorCode = outcome.sent
    ? null
    : String(outcome.reason || outcome.error || 'send_failed').slice(0, 240);
  if (errorCode === 'not_approved' || errorCode === 'prebuilt_not_approved') {
    errorCode = 'TEMPLATE_NOT_APPROVED';
  }
  const patch = {
    lastSendAt: new Date(),
    lastSendStatus: outcome.sent ? 'sent' : 'failed',
    lastSendError: errorCode,
  };
  try {
    const setFields = {
      'commerceAutomations.$.lastSendAt': patch.lastSendAt,
      'commerceAutomations.$.lastSendStatus': patch.lastSendStatus,
      'commerceAutomations.$.lastSendError': patch.lastSendError,
    };
    if (errorCode) {
      setFields['commerceAutomations.$.lastSendErrorAt'] = new Date();
    }
    await Client.updateOne(
      { clientId, 'commerceAutomations.id': String(ruleId) },
      { $set: setFields }
    );
    if (!outcome.sent && errorCode && global.io) {
      global.io.to(`client:${clientId}`).emit('automation_send_failed', {
        type: 'automation_send_failed',
        ruleId: String(ruleId),
        reason: errorCode,
        clientId,
      });
    }
  } catch (err) {
    log.warn(`recordRuleSendOutcome failed for ${ruleId}: ${err.message}`);
  }
}

async function recordSent({ clientId, orderId, statusKey, ruleId, phone, email, channel = 'whatsapp' }) {
  try {
    await OrderStatusSent.create({
      clientId,
      orderId: String(orderId),
      statusKey,
      channel,
      ruleId: String(ruleId || ''),
      phone: phone || '',
      email: email || '',
      sentAt: new Date(),
    });
  } catch (err) {
    if (err?.code !== 11000) {
      log.warn(`recordSent failed: ${err.message}`);
    }
  }
}

async function buildContextOrderForSend(client, payload) {
  const cust = payload.customer || {};
  const ship = payload.shipping_address || {};
  const phone = payload.phone
    || cust.phone
    || payload.billing_address?.phone
    || ship.phone
    || '';
  const orderName = payload.name || payload.order_number || `#${payload.id}`;
  const enriched = await enrichLineItemsForCommerce(client, payload.line_items || []);
  const first = enriched[0];
  const payGw = (payload.payment_gateway_names || []).join(', ')
    || payload.gateway
    || payload.processing_method
    || '';

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
    line_items: enriched.map((i) => ({
      title: i.title,
      name: i.title,
      sku: i.sku,
      quantity: i.quantity,
      product_id: i.product_id,
      image: i.imageUrl ? { src: i.imageUrl } : undefined,
    })),
    itemsSummary: formatLineItemsSummary(enriched),
    total_price: payload.total_price,
    totalPrice: payload.total_price,
    payment_method: payGw,
    financial_status: payload.financial_status || '',
    fulfillment_status: payload.fulfillment_status || '',
    shipping_address: ship,
    fulfillments: (payload.fulfillments || []).map((f) => ({
      tracking_url: f.tracking_url,
      tracking_number: f.tracking_number,
    })),
    first_product_image: first?.imageUrl || '',
  };
}

async function logRuleDispatchActivity({ client, payload, rule, status, result, source }) {
  try {
    const orderId = String(payload.id || payload.order_id || '');
    if (!orderId) return;
    const order = await Order.findOne({
      clientId: client.clientId,
      shopifyOrderId: orderId,
    })
      .select('_id')
      .lean();
    if (!order?._id) return;

    const { appendOrderWhatsAppActivity } = require('./orderWhatsAppActivity');
    const { resolveTemplateCategory } = require('../../services/messagingActivityService');
    const { estimateCostInr } = require('../../constants/metaWhatsAppPricing');
    const sent = !!result?.whatsapp?.sent;
    const cat = resolveTemplateCategory(client, rule.templateName, {
      contextType: 'order',
      automationSlotId: rule.id,
    });

    await appendOrderWhatsAppActivity(order._id, {
      event: status,
      templateName: rule.templateName,
      channel: 'template',
      success: sent,
      reason: sent
        ? null
        : String(result?.reason || result?.failureCode || 'send_failed').slice(0, 240),
      source: source || 'order_automation',
      metaCategory: cat,
      estCostInr: sent ? estimateCostInr(cat, 1) : null,
    });
  } catch (err) {
    log.warn(`activity log failed: ${err.message}`);
  }
}

async function sendWhatsAppForRule({ client, rule, statusKey, type, status, payload, phoneNorm, source }) {
  const orderId = String(payload.id || payload.order_id || '');

  if (await alreadySentForOrder({ clientId: client.clientId, orderId, statusKey, channel: 'whatsapp' })) {
    log.debug('order send dedup hit', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      statusKey,
      channel: 'whatsapp',
      dedupKey: `${orderId}:${statusKey}:whatsapp`,
    });
    return { sent: false, skipped: true, channel: 'whatsapp', reason: 'already_sent' };
  }
  if (!phoneNorm) {
    log.info('rule send skipped', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      skipReason: 'missing_phone',
      channel: 'whatsapp',
    });
    return { sent: false, skipped: true, channel: 'whatsapp', reason: 'missing_phone' };
  }
  if (await isPhoneOptedOut(client.clientId, phoneNorm)) {
    log.info('rule send skipped', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      skipReason: 'opted_out',
      channel: 'whatsapp',
      phone: maskPhone(phoneNorm),
    });
    return { sent: false, skipped: true, channel: 'whatsapp', reason: 'opted_out' };
  }
  if (!rule.templateName) {
    log.info('rule send skipped', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      skipReason: 'missing_template',
      channel: 'whatsapp',
    });
    return { sent: false, skipped: true, channel: 'whatsapp', reason: 'missing_template' };
  }

  const { sendForAutomation } = require('../../services/templateSender');
  const orderContext = await buildContextOrderForSend(client, payload);
  const result = await sendForAutomation({
    clientId: client.clientId,
    phone: phoneNorm,
    slotId: rule.id,
    metaName: rule.templateName,
    contextType: 'order',
    trigger: null,
    variableMappings: rule.variableMappings || undefined,
    buttonActions: rule.buttonActions || undefined,
    contextData: {
      order: orderContext,
      extra: {
        triggerStatusType: type,
        triggerStatus: status,
        ruleId: rule.id,
        customVariableValues: rule.customVariableValues || {},
        first_product_image: orderContext.first_product_image || '',
      },
    },
    channel: 'whatsapp',
  }).catch((err) => {
    log.warn(`sendForAutomation threw: ${err.message}`);
    return null;
  });

  if (result?.whatsapp?.sent) {
    log.info('rule send matched', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      templateName: rule.templateName,
      channel: 'whatsapp',
      phone: maskPhone(phoneNorm),
    });
    await recordSent({
      clientId: client.clientId,
      orderId,
      statusKey,
      ruleId: rule.id,
      phone: phoneNorm,
      channel: 'whatsapp',
    });
    await logRuleDispatchActivity({ client, payload, rule, status, result, source });
    return { sent: true, channel: 'whatsapp', ruleId: rule.id };
  }

  const failReasonRaw = result?.failureCode || result?.whatsapp?.reason || 'send_failed';
  const failReason =
    failReasonRaw === 'not_approved' || failReasonRaw === 'prebuilt_not_approved'
      ? 'TEMPLATE_NOT_APPROVED'
      : failReasonRaw;
  await logRuleDispatchActivity({
    client,
    payload,
    rule,
    status,
    result: { whatsapp: { sent: false }, reason: failReason },
    source,
  });
  return { sent: false, channel: 'whatsapp', ruleId: rule.id, reason: failReason };
}

async function sendEmailForRule({ client, rule, statusKey, payload, emailRaw, lead, source }) {
  const orderId = String(payload.id || payload.order_id || '');

  if (await alreadySentForOrder({ clientId: client.clientId, orderId, statusKey, channel: 'email' })) {
    log.debug('order send dedup hit', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      statusKey,
      channel: 'email',
      dedupKey: `${orderId}:${statusKey}:email`,
    });
    return { sent: false, skipped: true, channel: 'email', reason: 'already_sent' };
  }
  if (!emailRaw) {
    log.info('rule send skipped', {
      clientId: client.clientId,
      orderId,
      ruleId: rule.id,
      skipReason: 'missing_email',
      channel: 'email',
    });
    return { sent: false, skipped: true, channel: 'email', reason: 'missing_email' };
  }

  const context = buildOrderEmailContext(payload, lead, client);
  const template = await resolveOrderEmailTemplate({
    rule,
    clientId: client.clientId,
    context,
  });
  if (!template.ok) {
    return { sent: false, channel: 'email', reason: template.reason || 'missing_email_template' };
  }

  const { sendEnvelope } = require('../messaging/sendEnvelope');
  const result = await sendEnvelope({
    clientId: client.clientId,
    channel: 'email',
    intent: 'utility',
    contactId: lead?._id,
    contact: lead?._id ? undefined : { email: emailRaw },
    payload: { subject: template.subject, html: template.html },
    idempotency: { key: `order-auto:${rule.id}:${orderId}:${statusKey}:email` },
    context: {
      source: 'orderStatusAutomationHandler',
      ruleId: rule.id,
      orderId,
      statusKey,
      subject: template.subject,
      recipientEmail: emailRaw,
    },
  }).catch((err) => {
    log.warn(`order email sendEnvelope threw: ${err.message}`);
    return { status: 'failed', reason: err.message };
  });

  if (result?.status === 'sent' || result?.status === 'duplicate') {
    await recordSent({
      clientId: client.clientId,
      orderId,
      statusKey,
      ruleId: rule.id,
      email: emailRaw,
      channel: 'email',
    });
    return { sent: true, channel: 'email', ruleId: rule.id, messageId: result.messageId };
  }

  return {
    sent: false,
    channel: 'email',
    ruleId: rule.id,
    reason: result?.reason || result?.blockedBy || 'send_failed',
  };
}

async function dispatchRule({ client, rule, statusKey, type, status, payload, phoneNorm, source }) {
  const orderId = String(payload.id || payload.order_id || '');
  if (!orderId) return { skipped: true, reason: 'missing_order_id' };

  if (!ruleProductMatch(rule, payload)) {
    return { skipped: true, reason: 'product_scope_no_match' };
  }

  const channels = normalizeRuleChannels(rule);
  const sendWa = channels.includes('whatsapp');
  const sendEmail = channels.includes('email');
  const sendWhen = rule.emailConfig?.sendWhen || 'always';
  const emailRaw = extractCustomerEmail(payload);

  let lead = null;
  if (emailRaw) {
    lead = await AdLead.findOne({ clientId: client.clientId, email: emailRaw })
      .select('_id name email phoneNumber emailBounced emailUnsubscribed')
      .lean();
  }

  let waOutcome = null;
  if (sendWa) {
    waOutcome = await sendWhatsAppForRule({
      client,
      rule,
      statusKey,
      type,
      status,
      payload,
      phoneNorm,
      source,
    });
  }

  const waFailedOrSkipped =
    !waOutcome ||
    waOutcome.skipped ||
    waOutcome.sent === false;

  const shouldSendEmail =
    sendEmail &&
    (sendWhen === 'always' ||
      sendWhen === 'both_simultaneously' ||
      (sendWhen === 'no_phone' && !phoneNorm) ||
      (sendWhen === 'wa_failed' && (!sendWa || waFailedOrSkipped)));

  let emailOutcome = null;
  if (shouldSendEmail) {
    emailOutcome = await sendEmailForRule({
      client,
      rule,
      statusKey,
      payload,
      emailRaw,
      lead,
      source,
    });
  }

  const anySent = !!waOutcome?.sent || !!emailOutcome?.sent;
  await recordRuleSendOutcome(client.clientId, rule.id, {
    sent: anySent,
    reason: anySent
      ? null
      : emailOutcome?.reason || waOutcome?.reason || 'no_channel_sent',
  });

  const skipReason = anySent
    ? null
    : emailOutcome?.reason || waOutcome?.reason || 'no_channel_sent';
  logDispatchEvent('OrderStatusAutomation', anySent ? 'order_message_sent' : 'order_message_skipped', {
    clientId: client.clientId,
    orderId,
    ruleId: rule.id,
    statusKey,
    channel: sendWa && waOutcome?.sent ? 'whatsapp' : sendEmail && emailOutcome?.sent ? 'email' : sendWa ? 'whatsapp' : 'email',
    outcome: anySent ? 'sent' : (waOutcome?.skipped || emailOutcome?.skipped ? 'skipped' : 'failed'),
    skipReason,
    delayMinutes: Number(rule.delayMinutes || 0),
    source,
  }, anySent ? 'info' : 'warn');

  if (anySent) {
    return {
      sent: true,
      ruleId: rule.id,
      whatsapp: waOutcome,
      email: emailOutcome,
    };
  }

  if (waOutcome?.skipped && emailOutcome?.skipped) {
    return {
      skipped: true,
      ruleId: rule.id,
      reason: emailOutcome.reason || waOutcome.reason,
      whatsapp: waOutcome,
      email: emailOutcome,
    };
  }

  return {
    sent: false,
    ruleId: rule.id,
    reason: emailOutcome?.reason || waOutcome?.reason || 'no_channel_sent',
    whatsapp: waOutcome,
    email: emailOutcome,
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
  const phoneNorm = phoneRaw ? normalizePhone(phoneRaw) : await resolveOrderRecipientPhone(client, payload);

  const outcomes = [];
  const checks = [];
  if (financial) checks.push({ type: 'financial', status: financial });
  if (fulfillment) checks.push({ type: 'fulfillment', status: fulfillment });

  const src = String(source || '');
  if (src.includes('orders/create') && isCodShopifyOrder(payload)) {
    checks.push({ type: 'payment', status: 'cod' });
  }

  for (const { type, status } of checks) {
    /** Order placed — only on new-order webhooks (not every orders/updated while still unfulfilled). */
    if (type === 'fulfillment' && status === 'unfulfilled') {
      if (payload.cancelled_at) continue;
      const isNewOrder =
        src.includes('orders/create') || src.includes('order_status_reconcile');
      if (!isNewOrder) continue;
    }
    if (type === 'payment' && status === 'cod') {
      if (!src.includes('orders/create') && !src.includes('order_status_reconcile')) continue;
    }
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
          source,
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

/**
 * Public entry: process a Shopify fulfillment webhook (`fulfillments/create`
 * or `fulfillments/update`) through the Delivery tracking rules
 * (`sys_shipment_*`). Courier apps (Shiprocket, Delhivery, AfterShip…) update
 * `fulfillment.shipment_status`; we mirror the matching rule to WhatsApp.
 *
 * `orderPayload` is the full Shopify order (fetched by the webhook handler) —
 * needed for the customer phone, line items, and template variables. The
 * fulfillment's tracking info is merged on top so `tracking_url` resolves.
 */
async function processShipmentStatusAutomations({ client, fulfillment, orderPayload, source = 'unknown' }) {
  if (!client || !fulfillment || !orderPayload) return { processed: 0, outcomes: [] };
  const clientId = client.clientId;
  if (!clientId) return { processed: 0, outcomes: [] };

  const status = String(fulfillment.shipment_status || '').toLowerCase().trim();
  if (!SHIPMENT_VALUES.has(status)) return { processed: 0, outcomes: [] };

  let rules = Array.isArray(client.commerceAutomations) ? client.commerceAutomations : null;
  if (!rules) {
    const fresh = await Client.findOne({ clientId })
      .select('commerceAutomations')
      .lean();
    rules = Array.isArray(fresh?.commerceAutomations) ? fresh.commerceAutomations : [];
  }

  const matching = rules.filter((r) => ruleMatchesStatus(r, 'shipment', status));
  if (!matching.length) return { processed: 0, outcomes: [] };

  /** Surface the fulfillment's tracking link ahead of older fulfillments. */
  const trackingUrl = (Array.isArray(fulfillment.tracking_urls) && fulfillment.tracking_urls[0])
    || fulfillment.tracking_url
    || '';
  const payload = {
    ...orderPayload,
    fulfillments: [
      { tracking_url: trackingUrl, tracking_number: fulfillment.tracking_number || '' },
      ...(orderPayload.fulfillments || []),
    ],
  };

  const phoneRaw = payload.phone
    || payload.customer?.phone
    || payload.billing_address?.phone
    || payload.shipping_address?.phone
    || '';
  const phoneNorm = phoneRaw ? normalizePhone(phoneRaw) : await resolveOrderRecipientPhone(client, payload);

  const statusKey = buildStatusKey('shipment', status);
  const outcomes = [];
  for (const rule of matching) {
    try {
      const outcome = await dispatchRule({
        client,
        rule,
        statusKey,
        type: 'shipment',
        status,
        payload,
        phoneNorm,
        source,
      });
      outcomes.push({ statusKey, ruleId: rule.id, ...outcome });
    } catch (err) {
      log.error(`[${source}] rule ${rule.id} (${statusKey}) failed: ${err.message}`);
      outcomes.push({ statusKey, ruleId: rule.id, error: err.message });
    }
  }

  if (outcomes.length) {
    log.info(
      `[${source}] ${clientId} order=${payload.id} shipment=${status} outcomes=${JSON.stringify(outcomes)}`
    );
  }

  return { processed: outcomes.length, outcomes };
}

function localDashboardStatusToShipment(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'shipped' || st === 'fulfilled') return 'in_transit';
  if (st === 'out_for_delivery') return 'out_for_delivery';
  if (st === 'delivered' || st === 'delivery') return 'delivered';
  if (SHIPMENT_VALUES.has(st)) return st;
  return '';
}

function buildShopifyLikePayloadFromLocalOrder(order, { trackingUrl, trackingNumber } = {}) {
  const ship = order.shippingAddress || {};
  const nameParts = String(order.customerName || 'Customer').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  const lastName = nameParts.slice(1).join(' ');
  const trackUrl = trackingUrl || order.trackingUrl || '';
  const trackNum = trackingNumber || order.trackingNumber || '';
  return {
    id: order.shopifyOrderId || order.orderId || order._id,
    name: order.orderNumber || order.orderId || String(order.shopifyOrderId || ''),
    financial_status: order.financialStatus || 'paid',
    fulfillment_status: order.fulfillmentStatus || 'unfulfilled',
    phone: order.customerPhone || order.phone,
    email: order.customerEmail || order.email,
    customer: {
      first_name: firstName,
      last_name: lastName,
      phone: order.customerPhone || order.phone,
    },
    billing_address: { phone: order.customerPhone || order.phone },
    shipping_address: ship,
    line_items: (order.items || []).map((i) => ({
      product_id: i.productId || i.product_id,
      title: i.name || i.title,
      sku: i.sku,
      quantity: i.quantity || 1,
    })),
    fulfillments: trackUrl || trackNum
      ? [{ tracking_url: trackUrl, tracking_number: trackNum }]
      : order.fulfillments || [],
    total_price: order.totalPrice,
    payment_gateway_names: order.isCOD ? ['Cash on Delivery (COD)'] : [],
  };
}

/**
 * Dashboard manual status updates — route through canonical SAC rules when
 * legacy `dispatchOrderStatusAutomation` is gated off.
 */
async function processLocalOrderStatusAutomations({
  client,
  order,
  status,
  trackingUrl = '',
  trackingNumber = '',
  source = 'dashboard_manual',
}) {
  if (!client || !order) return { processed: 0, outcomes: [] };
  const payload = buildShopifyLikePayloadFromLocalOrder(order, { trackingUrl, trackingNumber });
  const shipmentStatus = localDashboardStatusToShipment(status);
  if (shipmentStatus) {
    return processShipmentStatusAutomations({
      client,
      fulfillment: {
        shipment_status: shipmentStatus,
        tracking_url: trackingUrl || order.trackingUrl || '',
        tracking_number: trackingNumber || order.trackingNumber || '',
        tracking_urls: trackingUrl || order.trackingUrl ? [trackingUrl || order.trackingUrl] : [],
      },
      orderPayload: payload,
      source,
    });
  }
  const st = String(status || '').toLowerCase();
  if (st === 'paid' || st === 'confirmed') {
    payload.financial_status = st === 'confirmed' && order.isCOD ? 'pending' : 'paid';
    return processOrderStatusAutomations({ client, payload, source });
  }
  if (st === 'cancelled') {
    payload.financial_status = 'voided';
    return processOrderStatusAutomations({ client, payload, source });
  }
  return { processed: 0, outcomes: [] };
}

module.exports = {
  processOrderStatusAutomations,
  processShipmentStatusAutomations,
  processLocalOrderStatusAutomations,
  readStatusesFromPayload,
  buildStatusKey,
  ruleMatchesStatus,
  FULFILLMENT_VALUES,
  FINANCIAL_VALUES,
  SHIPMENT_VALUES,
};
