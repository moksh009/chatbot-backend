'use strict';

/**
 * Unified entry for WhatsApp + commerce automations after an order status transition.
 * Manual dashboard updates and Shopify webhooks (3PL → Shopify → us) must both call this.
 *
 * - Runs legacy template map (sendMappedOrderStatusWhatsApp) for rich tracking / eco headers.
 * - Runs SKU / sequence automations via commerceAutomationService (skips duplicate order_status rules).
 * - Optional plain-text fallback when no template succeeded.
 * - Webhook dedupe via Order.lastDispatchSignature to avoid double-fires when Shopify retries.
 */

const Order = require('../models/Order');
const commerceAutomationService = require('./commerceAutomationService');
const { sendWhatsAppText } = require('./whatsappHelpers');

function dispatchSignature(newStatus, trackingUrl, trackingNumber) {
  return `${String(newStatus || '').toLowerCase()}|${String(trackingUrl || '').trim()}|${String(trackingNumber || '').trim()}`;
}

/**
 * @param {object} params
 * @param {object} params.clientConfig - resolveClient / lean client with tokens, nicheData, clientId
 * @param {object} params.order - Mongo doc or plain object (must include _id, status fields used downstream)
 * @param {string} params.previousStatus
 * @param {string} params.newStatus
 * @param {string} [params.trackingNumber]
 * @param {string} [params.trackingUrl]
 * @param {object|null} params.io - socket.io (optional)
 * @param {string} params.source - e.g. dashboard_manual | shopify_webhook:fulfillments/create
 * @param {object} [params.options] force: bypass webhook dedupe; trackingOnlyRefresh: same status but new tracking (Shopify fulfillment updates)
 */
async function dispatchOrderStatusAutomation({
  clientConfig,
  order,
  previousStatus,
  newStatus,
  trackingNumber = '',
  trackingUrl = '',
  io = null,
  source = 'unknown',
  options = {},
}) {
  const force = !!options.force;
  const trackingOnlyRefresh = !!options.trackingOnlyRefresh;
  const prev = String(previousStatus || '').toLowerCase();
  const next = String(newStatus || '').toLowerCase();
  const isWebhook = String(source).startsWith('shopify_webhook');
  const trackRefreshAllowed = trackingOnlyRefresh && isWebhook;

  if (!next || (prev === next && !trackRefreshAllowed)) {
    return { skipped: true, reason: 'no_status_change' };
  }

  const oid = order._id || order.id;
  const sig = dispatchSignature(next, trackingUrl, trackingNumber);

  if (!force && isWebhook && order.lastDispatchSignature === sig) {
    return { skipped: true, reason: 'duplicate_webhook_signature' };
  }

  const wf =
    clientConfig.wizardFeatures && typeof clientConfig.wizardFeatures.toObject === 'function'
      ? clientConfig.wizardFeatures.toObject()
      : clientConfig.wizardFeatures || {};
  /** Default true when unset — backward compatible. */
  const autoShopifyShippedWaEnabled = wf.enableAutoShopifyShippedWhatsApp !== false;
  const skipWebhookShippedCustomerWa =
    isWebhook &&
    (next === 'shipped' || next === 'fulfilled') &&
    !autoShopifyShippedWaEnabled;

  const { sendMappedOrderStatusWhatsApp } = require('../routes/engines/genericEcommerce');

  let wa = { ok: false, templateAttempted: false, templateName: null, skipped: false };
  if (!skipWebhookShippedCustomerWa) {
    try {
      wa = await sendMappedOrderStatusWhatsApp({
        clientConfig,
        order,
        status: next,
        trackingNumber: trackingNumber || order.trackingNumber,
        trackingUrl: trackingUrl || order.trackingUrl,
        io,
      });
    } catch (e) {
      console.error('[OrderEventDispatcher] sendMappedOrderStatusWhatsApp:', e.message);
    }
  } else {
    wa = { ok: false, templateAttempted: false, templateName: null, skipped: true, reason: 'auto_shopify_shipped_wa_disabled' };
  }

  let auto = { matched: 0 };
  try {
    auto = await commerceAutomationService.runAutomationsForEvent({
      clientConfig,
      eventType: next,
      order: {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        customerPhone: order.customerPhone || order.phone,
        customerName: order.customerName,
        items: order.items || [],
        trackingUrl: trackingUrl || order.trackingUrl,
        trackingNumber: trackingNumber || order.trackingNumber,
        totalPrice: order.totalPrice,
        isCOD: order.isCOD,
        paymentMethod: order.paymentMethod,
      },
      options: { skipOrderStatusRules: true },
    });
  } catch (e) {
    console.error('[OrderEventDispatcher] runAutomationsForEvent:', e.message);
  }

  const shouldTextFallback =
    !skipWebhookShippedCustomerWa &&
    (order.customerPhone || order.phone) &&
    (!wa.templateAttempted || !wa.ok) &&
    auto.matched === 0;

  if (shouldTextFallback) {
    try {
      const rawPhone = order.customerPhone || order.phone;
      const phone = String(rawPhone).replace(/\D/g, '');
      const token = clientConfig.whatsappToken;
      const phoneNumberId = clientConfig.phoneNumberId;
      if (phone && token && phoneNumberId) {
        let msg = `Hi ${order.customerName || 'there'}, your order #${order.orderNumber || order.orderId} status has been updated to *${next}*.`;
        if ((next === 'shipped' || next === 'fulfilled') && (trackingUrl || order.trackingUrl)) {
          msg += `\n\nTrack here: ${trackingUrl || order.trackingUrl}`;
        } else if ((next === 'shipped' || next === 'fulfilled') && !trackingUrl && !order.trackingUrl) {
          msg += '\n\nTracking details will appear in your account shortly.';
        }
        await sendWhatsAppText({
          phoneNumberId,
          to: phone,
          body: msg,
          token,
          clientId: clientConfig.clientId,
        });
      }
    } catch (e) {
      console.error('[OrderEventDispatcher] text fallback:', e.message);
    }
  }

  if (oid && isWebhook) {
    await Order.updateOne({ _id: oid }, { $set: { lastDispatchSignature: sig } }).catch(() => {});
  }

  return {
    skipped: false,
    whatsapp: wa,
    automations: auto,
    autoShopifyShippedWaDisabled: skipWebhookShippedCustomerWa,
  };
}

module.exports = {
  dispatchOrderStatusAutomation,
  dispatchSignature,
};
