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

const Order = require('../../models/Order');
const OrderStatusSent = require('../../models/OrderStatusSent');
const commerceAutomationService = require('./commerceAutomationService');
const { sendWhatsAppText } = require('../meta/whatsappHelpers');
const { shouldSkipLegacyOrderDispatch } = require('./canonicalOrderMessages');
const log = require('../core/logger')('OrderEventDispatcher');
const { logDispatchEvent } = require('../messaging/dispatchEventLog');

function dispatchSignature(newStatus, trackingUrl, trackingNumber) {
  return `${String(newStatus || '').toLowerCase()}|${String(trackingUrl || '').trim()}|${String(trackingNumber || '').trim()}`;
}

/**
 * Map legacy `newStatus` strings (paid / shipped / fulfilled / delivered / cancelled)
 * to the new pipeline's `OrderStatusSent.statusKey` so the two pipelines share
 * one dedup ledger. Returns `null` when there is no equivalent (legacy-only).
 */
function legacyStatusToSharedKey(newStatus) {
  const s = String(newStatus || '').toLowerCase();
  if (s === 'paid' || s === 'partially_paid' || s === 'confirmed') return `financial_status_${s === 'confirmed' ? 'paid' : s}`;
  if (s === 'pending' || s === 'authorized' || s === 'refunded' || s === 'voided' || s === 'partially_refunded') {
    return `financial_status_${s}`;
  }
  if (s === 'shipped' || s === 'fulfilled') return 'fulfillment_status_fulfilled';
  if (s === 'out_for_delivery') return 'shipment_status_out_for_delivery';
  /** Align with new pipeline `buildStatusKey('shipment', 'delivered')` → shipment_status_delivered */
  if (s === 'delivered') return 'shipment_status_delivered';
  if (s === 'partial') return 'fulfillment_status_partial';
  return null;
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
  if (shouldSkipLegacyOrderDispatch(clientConfig)) {
    logDispatchEvent('OrderEventDispatcher', 'legacy_dispatch_skipped', {
      clientId: clientConfig?.clientId || null,
      newStatus,
      source,
      reason: 'commerce_canonical_only',
    });
    return {
      skipped: true,
      reason: 'commerce_canonical_only',
      whatsapp: { skipped: true, reason: 'commerce_canonical_only' },
      automations: { matched: 0 },
    };
  }

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

  /** WS-2 cross-pipeline dedup: the new `processOrderStatusAutomations`
   *  pipeline writes `OrderStatusSent({clientId, orderId, statusKey})` on
   *  every successful send. If we already sent for this status, don't
   *  double-fire from the legacy path. */
  if (!force && clientConfig?.clientId) {
    const sharedKey = legacyStatusToSharedKey(next);
    const shopifyOrderId = order.shopifyOrderId || order.orderId || order.id || order._id;
    if (sharedKey && shopifyOrderId) {
      try {
        const already = await OrderStatusSent.findOne({
          clientId: clientConfig.clientId,
          orderId: String(shopifyOrderId),
          statusKey: sharedKey,
        }).select('_id').lean();
        if (already) {
          return { skipped: true, reason: 'duplicate_new_pipeline_already_sent' };
        }
      } catch (_) {
        /** dedup table unavailable — fall through to legacy send. */
      }
    }
  }

  const wf =
    clientConfig.wizardFeatures && typeof clientConfig.wizardFeatures.toObject === 'function'
      ? clientConfig.wizardFeatures.toObject()
      : clientConfig.wizardFeatures || {};
  /** Only when explicitly enabled — avoids legacy sends merchants did not turn on. */
  const autoShopifyShippedWaEnabled = wf.enableAutoShopifyShippedWhatsApp === true;
  const skipWebhookShippedCustomerWa =
    isWebhook &&
    (next === 'shipped' || next === 'fulfilled') &&
    !autoShopifyShippedWaEnabled;

  const { sendMappedOrderStatusWhatsApp } = require('../../routes/engines/genericEcommerce');

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
      log.error('sendMappedOrderStatusWhatsApp failed', { error: e.message, source });
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
    log.error('runAutomationsForEvent failed', { error: e.message, source });
  }

  const shouldTextFallback =
    !skipWebhookShippedCustomerWa &&
    autoShopifyShippedWaEnabled &&
    (order.customerPhone || order.phone) &&
    wa.templateAttempted &&
    !wa.ok &&
    auto.matched === 0;

  let textFallbackSent = false;
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
        textFallbackSent = true;
      }
    } catch (e) {
      log.error('text fallback failed', { error: e.message, source });
    }
  }

  try {
    const { appendOrderWhatsAppActivity } = require('./orderWhatsAppActivity');
    if (oid) {
      if (wa.templateAttempted && wa.templateName) {
        // sendMappedOrderStatusWhatsApp already logs success/failure
      } else if (wa.skipped && wa.reason === 'auto_shopify_shipped_wa_disabled') {
        await appendOrderWhatsAppActivity(oid, {
          event: next,
          channel: 'none',
          success: false,
          reason: 'auto_shipped_disabled',
          source,
        });
      } else if (textFallbackSent) {
        await appendOrderWhatsAppActivity(oid, {
          event: next,
          channel: 'text',
          success: true,
          reason: 'no_template_mapping',
          source,
        });
      } else if (auto.matched > 0) {
        await appendOrderWhatsAppActivity(oid, {
          event: next,
          channel: 'automation',
          success: true,
          reason: `${auto.matched} rule(s)`,
          source,
        });
      } else if (!wa.templateAttempted && wa.reason === 'no_mapping') {
        /** No active template mapping — nothing attempted; do not log as a failure. */
      }
    }
  } catch (logErr) {
    log.warn('activity log failed', { error: logErr.message, source });
  }

  if (oid && isWebhook) {
    await Order.updateOne({ _id: oid }, { $set: { lastDispatchSignature: sig } }).catch(() => {});
  }

  /** Record successful legacy sends in the shared dedup ledger so the new
   *  pipeline (if it fires after) also no-ops. */
  if (clientConfig?.clientId && (wa.ok || textFallbackSent)) {
    const sharedKey = legacyStatusToSharedKey(next);
    const shopifyOrderId = order.shopifyOrderId || order.orderId || order.id || order._id;
    if (sharedKey && shopifyOrderId) {
      OrderStatusSent.create({
        clientId: clientConfig.clientId,
        orderId: String(shopifyOrderId),
        statusKey: sharedKey,
        ruleId: 'legacy_dispatch',
        phone: String(order.customerPhone || order.phone || ''),
        sentAt: new Date(),
      }).catch((err) => {
        if (err?.code !== 11000) {
          log.warn('dedup ledger write failed', { error: err.message, source });
        }
      });
    }
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
