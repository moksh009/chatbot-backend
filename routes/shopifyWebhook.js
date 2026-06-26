const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { trackEcommerceEvent } = require('../utils/core/analyticsHelper');
const { decrypt } = require('../utils/core/encryption');
const Contact = require('../models/Contact');
const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const { logActivity } = require('../utils/core/activityLogger');
const { recalculateLeadScore } = require('../utils/core/scoringHelper');
const log = require('../utils/core/logger')('ShopifyWebhook');
const commerceAutomationService = require('../utils/commerce/commerceAutomationService');
const { processOrderStatusAutomations, processShipmentStatusAutomations } = require('../utils/commerce/orderStatusAutomationHandler');
const shopifyAdminApiVersion = require('../utils/shopify/shopifyAdminApiVersion');
const {
    applyWarrantyVoidFromOrder,
    parseRefundedProductIds,
} = require('../utils/commerce/warrantyVoidAutomation');
const {
    enrichLineItemsForCommerce,
    formatLineItemsBullets,
} = require('../utils/commerce/orderLineItemEnrichment');

/** Push reconciled order to dashboard (Orders page) without manual refresh */
function emitOrderUpdatedToDashboard(io, clientId, orderDoc) {
    if (!io || !clientId || !orderDoc) return;
    try {
        const payload = typeof orderDoc.toObject === 'function' ? orderDoc.toObject() : orderDoc;
        io.to(`client_${clientId}`).emit('order_updated', payload);
    } catch (e) {
        log.warn(`[Socket] order_updated emit failed: ${e.message}`);
    }
}

async function getProductImageForOrder(order, client) {
  // Try to get from order line items first (fastest)
  const lineItem = order.line_items?.[0];
  if (lineItem?.product_id && client.shopifyAccessToken) {
    try {
      const res = await axios.get(
        `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${lineItem.product_id}.json`,
        { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } }
      );
      return res.data.product?.images?.[0]?.src || null;
    } catch { return null; }
  }
  // Fallback: client logo or generic image
  return client.logoUrl || null;
}

// Middleware to verify Shopify Webhook signature
const verifyShopifyWebhook = async (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !topic || !shop) {
        return res.status(401).send('Missing headers');
    }

    const { resolveClientForShop } = require('../utils/shopify/shopifyStoreHelpers');
    const resolved = await resolveClientForShop(shop);
    const verifyRow = resolved?.client;
    if (!verifyRow) {
        log.error(`Webhook verification failed: No client found for shop ${shop}`);
        return res.status(401).send('Client not found');
    }

    // Use Webhook Secret if available, otherwise fallback to Client Secret
    // Support both Tier 2.5 modular sub-documents and legacy fields
    const secretRaw =
      verifyRow.commerce?.shopify?.webhookSecret ||
      verifyRow.shopifyWebhookSecret ||
      verifyRow.shopifyClientSecret;
    const secret = decrypt(secretRaw);

    if (!secret) {
        log.error(`Webhook verification failed: No secret for shop ${shop}`);
        return res.status(401).send('Secret not found');
    }

    // Use rawBody for accurate HMAC verification
    const body = req.rawBody ? req.rawBody : JSON.stringify(req.body);
    const hash = crypto
        .createHmac('sha256', secret)
        .update(body, 'utf8')
        .digest('base64');

    const loadFullClient = async () => {
      const r = await resolveClientForShop(shop);
      return r?.client || null;
    };

    if (hash === hmac) {
        req.client = await loadFullClient();
        req.shopifyStoreKey = shop;
        if (!req.client) {
          log.error(`Webhook: client disappeared for shop ${shop}`);
          return res.status(401).send('Client not found');
        }
        req.topic = topic;
        next();
    } else {
        const { auditLog } = require('../services/audit/auditWriter');
        auditLog({
          category: 'security',
          action: 'webhook_signature_failed',
          severity: 'high',
          clientId: verifyRow.clientId || 'unknown',
          actor: { type: 'system', source: 'shopify_webhook', ip: req.ip },
          details: { shop, topic },
        });
        return res.status(401).end();
    }
};

async function reconcileLocalOrderFromShopifyAdmin(client, orderPayload, topic, io, storeKey = '') {
    if (!orderPayload || orderPayload.id == null) return;
    const { buildShopifyOrderSet, shopifyOrderFilter } = require('../utils/shopify/shopifyOrderMapper');
    const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');
    const key = storeKey || client.shopDomain || '';
    const $set = buildShopifyOrderSet(client.clientId, orderPayload, {
      preferLogisticsStatus: true,
      storeKey: key,
      shopDomain: key,
    });
    const filter = shopifyOrderFilter(client.clientId, orderPayload);
    const prev = await Order.findOne(filter).lean();
    const prevStatus = prev?.status || '';
    const prevTrack = `${prev?.trackingUrl || ''}|${prev?.trackingNumber || ''}`;
    const doc = await Order.findOneAndUpdate(filter, { $set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    emitOrderUpdatedToDashboard(io, client.clientId, doc);
    const newStatus = doc.status;
    const newTrack = `${doc.trackingUrl || ''}|${doc.trackingNumber || ''}`;
    const statusChanged = String(prevStatus).toLowerCase() !== String(newStatus).toLowerCase();
    const trackingFilledIn = newTrack !== prevTrack && !!(doc.trackingUrl || doc.trackingNumber);
    const shouldNotify =
        statusChanged ||
        (String(newStatus).toLowerCase() === 'shipped' && trackingFilledIn);
    if (!shouldNotify) return;
    await dispatchOrderStatusAutomation({
        clientConfig: client,
        order: doc.toObject(),
        previousStatus: prevStatus || 'pending',
        newStatus,
        trackingNumber: doc.trackingNumber,
        trackingUrl: doc.trackingUrl,
        io: null,
        source: `shopify_webhook:${topic}`,
        options: {},
    });
}

async function handleFulfillmentWebhookForAdmin(client, fulfillment, topic, io) {
    const orderId = fulfillment?.order_id;
    if (!orderId) return { ndrResult: null, shipmentStatus: '' };
    const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');
    const { maybeSendNdrRescueFromFulfillment, NDR_SHIPMENT_TRIGGERS, rtoCfg } = require('../utils/commerce/rtoProtectionService');
    const { SHIPMENT_VALUES } = require('../utils/commerce/orderStatusAutomationHandler');
    const { recordObservedShopifyStatus } = require('../services/logisticsEligibilityService');
    const oidStr = String(orderId);
    const prev = await Order.findOne({ clientId: client.clientId, shopifyOrderId: oidStr }).lean();
    if (!prev) {
        log.warn(`[Webhook] fulfillment for missing local order shopify:${oidStr}`);
        return { ndrResult: null, shipmentStatus: '' };
    }
    const prevStatus = prev.status || 'pending';
    const shipmentStatus = String(
        fulfillment.shipment_status || fulfillment.status || ''
    ).toLowerCase();

    if (shipmentStatus) {
        await recordObservedShopifyStatus(client.clientId, shipmentStatus).catch(() => {});
    }

    if (NDR_SHIPMENT_TRIGGERS.has(shipmentStatus)) {
        let ndrResult = null;
        if (rtoCfg(client).enableNdrRescue) {
            ndrResult = await maybeSendNdrRescueFromFulfillment(client, fulfillment, io).catch((e) => {
                log.warn(`[RTOProtection] NDR path failed: ${e.message}`);
                return { ok: false, error: e.message };
            });
        }
        const urls = fulfillment.tracking_urls;
        const trackingUrl = (Array.isArray(urls) && urls[0]) || fulfillment.tracking_url || prev.trackingUrl || '';
        const trackingNumber = fulfillment.tracking_number || prev.trackingNumber || '';
        const doc = await Order.findOneAndUpdate(
            { clientId: client.clientId, shopifyOrderId: oidStr },
            {
                $set: {
                    trackingUrl,
                    trackingNumber,
                    fulfillmentStatus: shipmentStatus || prev.fulfillmentStatus,
                    lastShipmentStatus: shipmentStatus,
                    lastShipmentStatusAt: new Date(),
                },
            },
            { new: true }
        );
        if (doc) emitOrderUpdatedToDashboard(io, client.clientId, doc);
        return { ndrResult, shipmentStatus };
    }

    /** Granular courier statuses — SAC `sys_shipment_*` rules handle WhatsApp.
     *  Skip legacy coarse shipped/delivered dispatch to avoid duplicate messages. */
    if (SHIPMENT_VALUES.has(shipmentStatus)) {
        const urls = fulfillment.tracking_urls;
        const trackingUrl = (Array.isArray(urls) && urls[0]) || fulfillment.tracking_url || prev.trackingUrl || '';
        const trackingNumber = fulfillment.tracking_number || prev.trackingNumber || '';
        const isDelivered =
            shipmentStatus === 'delivered' ||
            shipmentStatus === 'delivery';
        const platformStatus = isDelivered ? 'delivered' : prev.status || 'shipped';
        const doc = await Order.findOneAndUpdate(
            { clientId: client.clientId, shopifyOrderId: oidStr },
            {
                $set: {
                    status: isDelivered ? 'delivered' : (prev.status === 'delivered' ? 'delivered' : platformStatus),
                    fulfillmentStatus: shipmentStatus,
                    trackingUrl,
                    trackingNumber,
                    lastShipmentStatus: shipmentStatus,
                    lastShipmentStatusAt: new Date(),
                },
            },
            { new: true }
        );
        if (doc) emitOrderUpdatedToDashboard(io, client.clientId, doc);
        return { ndrResult: null, shipmentStatus };
    }

    const urls = fulfillment.tracking_urls;
    const trackingUrl = (Array.isArray(urls) && urls[0]) || fulfillment.tracking_url || prev.trackingUrl || '';
    const trackingNumber = fulfillment.tracking_number || prev.trackingNumber || '';
    const isDelivered =
        shipmentStatus === 'delivered' ||
        shipmentStatus === 'delivery' ||
        String(fulfillment.status || '').toLowerCase() === 'success';
    const platformStatus = isDelivered ? 'delivered' : 'shipped';
    const doc = await Order.findOneAndUpdate(
        { clientId: client.clientId, shopifyOrderId: oidStr },
        {
            $set: {
                status: platformStatus,
                fulfillmentStatus: isDelivered ? 'delivered' : 'fulfilled',
                trackingUrl,
                trackingNumber,
                fulfilledAt: new Date(),
            },
        },
        { new: true }
    );
    if (doc) emitOrderUpdatedToDashboard(io, client.clientId, doc);
    if (!doc) return { ndrResult: null, shipmentStatus };

    const prevNorm = String(prevStatus || '').toLowerCase();
    const prevShipped = prevNorm === 'shipped' || prevNorm === 'delivered';
    const prevTrackSig = `${prev.trackingUrl || ''}|${prev.trackingNumber || ''}`;
    const newTrackSig = `${doc.trackingUrl || ''}|${doc.trackingNumber || ''}`;
    if (prevShipped && prevNorm === platformStatus && newTrackSig === prevTrackSig) {
        return { ndrResult: null, shipmentStatus };
    }
    const trackingOnlyRefresh =
        prevShipped && newTrackSig !== prevTrackSig && !!(doc.trackingUrl || doc.trackingNumber);

    await dispatchOrderStatusAutomation({
        clientConfig: client,
        order: doc.toObject(),
        previousStatus: prevStatus,
        newStatus: platformStatus,
        trackingNumber,
        trackingUrl,
        io: null,
        source: `shopify_webhook:${topic}`,
        options: { trackingOnlyRefresh },
    });
    return { ndrResult: null, shipmentStatus };
}

// POST /api/shopify/webhook
const { replayGuard } = require('../middleware/webhookReplayGuard');
const shopifyReplay = replayGuard({ header: 'X-Shopify-Webhook-Id', keyPrefix: 'shopify_replay', ttlSec: 3600 });

router.post('/', verifyShopifyWebhook, shopifyReplay, async (req, res) => {
    const topic = req.topic;
    const client = req.client;
    const data = req.body;
    const storeKey = req.shopifyStoreKey || client.shopDomain || '';

    log.info(`Received Shopify Webhook: ${topic} for ${client.clientId}`);

    res.status(200).send('OK');

    const io = req.app.get('socketio');

    try {
        switch (topic) {
            case 'checkouts/create':
            case 'checkouts/update':
                await handleCheckout(client, data);
                break;
            case 'orders/create': {
                await handleOrder(client, data, storeKey);
                await fireEventFlow(client, 'order_placed', data).catch(e =>
                  log.warn(`[FlowTrigger] order_placed flow fire failed: ${e.message}`)
                );
                /** OM-P0-02 / WS-2: Order event pipelines (sequential, shared dedup ledger).
                 *  1. processOrderStatusAutomations — canonical sys_* rules + OrderStatusSent ledger
                 *  2. dispatchOrderStatusAutomation — legacy commerce rules (checks ledger before send)
                 *  3. commerceAutomationService — SKU-scoped automations only (skipOrderStatusRules)
                 *  AWAIT step 1 before 2 so dedup pre-check sees ledger writes. */
                await processOrderStatusAutomations({
                  client,
                  payload: data,
                  source: 'shopify_webhook:orders/create',
                }).catch((e) => log.error(`OrderStatus automation orders/create failed: ${e.message}`));
                const fin = String(data.financial_status || '').toLowerCase();
                const isPaid = fin === 'paid' || fin === 'partially_paid';
                const { shouldSkipLegacyOrderDispatch } = require('../utils/commerce/canonicalOrderMessages');
                if (!shouldSkipLegacyOrderDispatch(client)) {
                const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');
                const lineItems = (data.line_items || []).map((i) => ({
                  sku: i.sku,
                  name: i.title,
                  productId: String(i.product_id || ''),
                  variantId: String(i.variant_id || ''),
                }));
                const orderPayload = {
                  orderId: data.name || data.id,
                  orderNumber: data.name,
                  customerPhone: data.phone || data.customer?.phone || data.billing_address?.phone,
                  customerName: data.customer?.first_name || data.customer?.default_address?.first_name || 'Customer',
                  items: lineItems,
                  totalPrice: data.total_price,
                  paymentMethod: data.gateway || data.payment_gateway_names?.[0],
                  isCOD: (data.payment_gateway_names || []).some((g) => /cod|cash/i.test(String(g))),
                };
                const statusEvent = isPaid ? 'paid' : 'pending';

                await dispatchOrderStatusAutomation({
                  clientConfig: client,
                  order: orderPayload,
                  previousStatus: '',
                  newStatus: statusEvent,
                  io,
                  source: 'shopify_webhook:orders/create',
                }).catch((e) => log.error(`Commerce automations ${statusEvent} failed:`, e.message));
                await commerceAutomationService.runAutomationsForEvent({
                  clientConfig: client,
                  eventType: statusEvent,
                  order: orderPayload,
                  options: { skipOrderStatusRules: true },
                }).catch((e) => log.error(`Commerce automations ${statusEvent} SKU failed:`, e.message));
                }

                if (isPaid) {
                    const { processWarrantyAutoAssignment } = require('../utils/commerce/warrantyEngine');
                    await processWarrantyAutoAssignment(client, data).catch((e) =>
                        log.error('[Warranty] Auto-assignment orders/create failed:', e.message)
                    );
                }
                if (client?.clientId) {
                    const { scheduleSegmentCountRefresh } = require('../services/segmentCountSync');
                    scheduleSegmentCountRefresh(client.clientId);
                }
                break;
            }
            case 'orders/cancelled':
            case 'orders/refunded':
                await handleRefund(client, data);
                // Fire any flow with order_status_changed trigger set to 'cancelled' or 'returned'
                await fireEventFlow(client, 'order_status_changed', data, data.financial_status === 'refunded' ? 'returned' : 'cancelled').catch(e =>
                  log.warn(`[FlowTrigger] order_status_changed flow fire failed: ${e.message}`)
                );
                await processOrderStatusAutomations({
                  client,
                  payload: data,
                  source: `shopify_webhook:${topic}`,
                }).catch((e) => log.error(`OrderStatus automation ${topic} failed: ${e.message}`));
                await commerceAutomationService.runAutomationsForEvent({
                  clientConfig: client,
                  eventType: 'cancelled',
                  order: {
                    orderId: data.name || data.id,
                    orderNumber: data.name,
                    customerPhone: data.phone || data.customer?.phone || data.billing_address?.phone,
                    customerName: data.customer?.first_name || 'Customer',
                    items: data.line_items.map(i => ({ sku: i.sku, name: i.title })),
                  },
                }).catch(e => log.error('Commerce automations cancelled failed:', e.message));
                break;
            case 'orders/updated':
                /** WS-2 fix: AWAIT before any legacy paths inside reconcile fire,
                 *  to keep the `OrderStatusSent` ledger authoritative. */
                await processOrderStatusAutomations({
                  client,
                  payload: data,
                  source: 'shopify_webhook:orders/updated',
                }).catch((e) => log.error(`OrderStatus automation orders/updated failed: ${e.message}`));
                await reconcileLocalOrderFromShopifyAdmin(client, data, topic, io, storeKey);
                {
                    const fin = String(data.financial_status || '').toLowerCase();
                    const isPaidUpdate = fin === 'paid' || fin === 'partially_paid';
                    if (isPaidUpdate) {
                        const { processWarrantyAutoAssignment } = require('../utils/commerce/warrantyEngine');
                        await processWarrantyAutoAssignment(client, data).catch((e) =>
                            log.error('[Warranty] Auto-assignment orders/updated failed:', e.message)
                        );
                    }
                }
                break;
            case 'fulfillments/create':
            case 'fulfillments/update': {
                const fulfillmentMeta = await handleFulfillmentWebhookForAdmin(client, data, topic, io);
                /** WS-2: fulfillment webhooks must also drive the new
                 *  `sys_fulfillment_*` rules. The fulfillment payload lacks
                 *  customer + financial_status, so refetch the full order
                 *  from Shopify (same pattern as refunds/create). */
                const fulfillmentOrderId = data?.order_id;
                if (fulfillmentOrderId && client.shopDomain && client.shopifyAccessToken) {
                    try {
                        const orderRes = await axios.get(
                            `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/orders/${fulfillmentOrderId}.json`,
                            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                        );
                        const fullOrder = orderRes.data?.order;
                        if (fullOrder) {
                            await processOrderStatusAutomations({
                                client,
                                payload: fullOrder,
                                source: `shopify_webhook:${topic}`,
                            }).catch((e) =>
                                log.error(`OrderStatus automation ${topic} failed: ${e.message}`)
                            );
                            const shipmentStatus = String(
                                fulfillmentMeta?.shipmentStatus ||
                                data.shipment_status ||
                                data.status ||
                                ''
                            ).toLowerCase();
                            const { shouldSkipSacForNdr } = require('../utils/commerce/rtoProtectionService');
                            if (!shouldSkipSacForNdr(client, shipmentStatus, fulfillmentMeta?.ndrResult)) {
                                await processShipmentStatusAutomations({
                                    client,
                                    fulfillment: data,
                                    orderPayload: fullOrder,
                                    source: `shopify_webhook:${topic}`,
                                }).catch((e) =>
                                    log.error(`Shipment automation ${topic} failed: ${e.message}`)
                                );
                            }
                        }
                    } catch (fulErr) {
                        log.warn(`[${topic}] order fetch for status automation failed: ${fulErr.message}`);
                    }
                }
                break;
            }
            case 'refunds/create': {
                /** refund payloads are partial — refetch the order so we have an authoritative
                 *  financial_status (paid → partially_refunded vs paid → refunded). */
                const refundOrderId = data?.order_id;
                if (!refundOrderId || !client.shopDomain || !client.shopifyAccessToken) {
                    log.warn(`[refunds/create] missing order_id or Shopify creds — skipping`);
                    break;
                }
                try {
                    const orderRes = await axios.get(
                        `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/orders/${refundOrderId}.json`,
                        { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                    );
                    const fullOrder = orderRes.data?.order;
                    if (fullOrder) {
                        const financial = String(fullOrder.financial_status || '').toLowerCase();
                        const partialRefundIds =
                            financial === 'partially_refunded' ? parseRefundedProductIds(data) : [];
                        await applyWarrantyVoidFromOrder({
                            clientId: client.clientId,
                            orderPayload: fullOrder,
                            refundedProductIds: partialRefundIds,
                            source: 'shopify_webhook:refunds/create',
                        }).catch((e) =>
                            log.error(`Warranty void refunds/create failed: ${e.message}`)
                        );
                        await processOrderStatusAutomations({
                            client,
                            payload: fullOrder,
                            source: 'shopify_webhook:refunds/create',
                        }).catch((e) => log.error(`OrderStatus automation refunds/create failed: ${e.message}`));
                    }
                } catch (refundErr) {
                    log.warn(`[refunds/create] order fetch failed: ${refundErr.message}`);
                }
                break;
            }
            case 'orders/fulfilled': {
                /** Courier delivery rules fire from fulfillments/* webhooks
                 *  (shipment_status). orders/fulfilled still reconciles local order state. */
                await processOrderStatusAutomations({
                    client,
                    payload: data,
                    source: 'shopify_webhook:orders/fulfilled',
                }).catch((e) =>
                    log.error(`OrderStatus automation orders/fulfilled failed: ${e.message}`)
                );
                await reconcileLocalOrderFromShopifyAdmin(client, data, topic, io, storeKey);
                const { schedulePostPurchaseEnrollment } = require('../services/postPurchaseJourneys/enroll');
                schedulePostPurchaseEnrollment({
                  client,
                  orderPayload: data,
                  shopifyTopic: 'orders/fulfilled',
                  storeKey,
                });
                const { schedulePostDeliveryUpsell } = require('../utils/commerce/upsellEngine');
                await schedulePostDeliveryUpsell(client, data);
                // Fire any flow with order_fulfilled trigger
                await fireEventFlow(client, 'order_fulfilled', data).catch(e =>
                  log.warn(`[FlowTrigger] order_fulfilled flow fire failed: ${e.message}`)
                );

                // --- PHASE 30.5: Enterprise Warranty Auto-Assign (ENGINE) ---
                const { processWarrantyAutoAssignment } = require('../utils/commerce/warrantyEngine');
                await processWarrantyAutoAssignment(client, data).catch(e =>
                    log.error('[Warranty] Auto-assignment failed:', e.message)
                );

                break;
            }
            case 'inventory_levels/update':
            case 'inventory_items/update':
                await handleInventoryUpdate(client, data);
                break;
            case 'app/uninstalled': {
                log.info(`[Uninstall] App uninstalled from ${storeKey} (client: ${client.clientId})`);
                const { invalidateClientCache } = require('../utils/core/clientCache');
                await Client.updateOne(
                  { clientId: client.clientId },
                  {
                    $set: {
                      shopifyConnectionStatus: 'disconnected',
                      lastShopifyError: 'App uninstalled by merchant',
                      shopifyAccessToken: '',
                      'commerce.shopify.accessToken': '',
                    },
                  }
                );
                invalidateClientCache(client.clientId);
                if (io) {
                  io.to(`client_${client.clientId}`).emit('integration_token_expired', { channel: 'shopify' });
                }
                break;
            }
            default:
                log.info(`Unhandled topic: ${topic}`);
        }
    } catch (err) {
        log.error(`Error processing webhook ${topic}:`, { error: err.message });
    }
});

/**
 * Flat fields merged into `conversation.metadata` so flow nodes can use {{first_name}}, {{line_items_list}}, etc.
 * (Mongoose Client has no `variables` path — old writes were ignored in strict mode.)
 */
async function buildCommerceMetadataPatch(client, eventName, data, status = null) {
  const cust = data.customer || {};
  const firstName = cust.first_name
    || (String(data.customer_name || '').trim().split(/\s+/)[0])
    || 'there';
  const fullName = [cust.first_name, cust.last_name].filter(Boolean).join(' ')
    || String(data.customer_name || '').trim()
    || '';
  const ship = data.shipping_address || {};
  const shipLines = [ship.name, ship.address1, ship.address2, ship.city, ship.province, ship.zip, ship.country]
    .filter(Boolean)
    .join(', ');
  const currency = data.currency || data.presentment_currency || 'INR';
  const totalRaw = data.total_price || data.total_line_items_price || '';
  const totalDisp = totalRaw ? `${currency} ${totalRaw}` : '';
  const payGw = (data.payment_gateway_names || []).join(', ')
    || data.gateway
    || data.processing_method
    || '—';
  const orderNum = String(data.name || data.order_number || '');
  const enriched = await enrichLineItemsForCommerce(client, data.line_items || []);
  const lineList = formatLineItemsBullets(enriched) || '—';
  const first = enriched[0];
  const storeHost = client.shopDomain ? String(client.shopDomain).replace(/^https?:\/\//, '') : '';
  const checkoutToken = data.checkout_token || data.token || '';
  const recoverCandidate =
    storeHost && checkoutToken ? `https://${storeHost}/cart/recover/${checkoutToken}` : '';
  const checkoutUrl =
    data.abandoned_checkout_url
    || data.checkout_url
    || recoverCandidate
    || (data.token && storeHost ? `https://${storeHost}/checkouts/cn/${data.token}` : '')
    || (storeHost ? `https://${storeHost}` : '');

  const meta = {
    commerce_event: eventName,
    first_name: firstName,
    customer_name: fullName || firstName,
    order_number: orderNum,
    order_total: totalDisp,
    order_total_raw: String(totalRaw || ''),
    currency: String(currency),
    payment_method: payGw,
    shipping_address: shipLines || '—',
    line_items_list: lineList,
    first_product_title: first?.title || '',
    first_product_image: first?.imageUrl || '',
    checkout_url: checkoutUrl,
    cart_total: totalDisp || (data.total_line_items_price ? `${currency} ${data.total_line_items_price}` : ''),
    cart_items_count: Array.isArray(data.line_items) ? data.line_items.length : 0,
    cart_url: data.abandoned_checkout_url || checkoutUrl || '',
    cart_items: (data.line_items || []).map((i) => i.title).filter(Boolean).join(', '),
    is_cod: String(payGw || '').toLowerCase().includes('cod') ? 'true' : 'false',
    lastOrder: {
      orderNumber: orderNum,
      status: status || data.fulfillment_status || (eventName === 'order_placed' ? 'confirmed' : ''),
      totalPrice: totalRaw != null && totalRaw !== '' ? String(Number(totalRaw).toFixed(2)) : String(data.total_price || ''),
      currency: String(currency),
      itemsSummary: lineList,
      trackingUrl: (data.fulfillments && data.fulfillments[0] && data.fulfillments[0].tracking_url) || '',
      orderId: String(data.id || data.order_id || ''),
    },
  };
  if (status) meta.order_status_detail = status;
  return { meta, enriched, checkoutUrl };
}

/**
 * Fire a commerce event-triggered flow for the customer on this order/checkout.
 * Routes through the dualBrainEngine's flow executor so all node types are supported.
 */
async function fireEventFlow(client, eventName, data, status = null) {
  const { findEventTriggeredFlow } = require('../utils/flow/triggerEngine');
  const { normalizePhone } = require('../utils/core/helpers');

  const phoneRaw = data.phone
    || data.customer?.phone
    || data.billing_address?.phone
    || data.shipping_address?.phone;

  if (!phoneRaw) {
    log.info(`[FlowTrigger] ${eventName}: No phone number on payload, skipping`);
    return;
  }

  const phone = normalizePhone(phoneRaw);

  const result = await findEventTriggeredFlow(eventName, data, client, status);
  if (!result) {
    log.info(`[FlowTrigger] ${eventName}: No matching published flow for ${client.clientId}`);
    return;
  }

  const { flow, startNodeId } = result;
  if (!startNodeId) {
    log.warn(`[FlowTrigger] ${eventName}: Flow ${flow._id} has no start node`);
    return;
  }

  log.info(`[FlowTrigger] Executing flow "${flow.name}" for ${phone} (event: ${eventName})`);

  const AdLead = require('../models/AdLead');
  const Conversation = require('../models/Conversation');

  const { meta: metaPatch, enriched } = await buildCommerceMetadataPatch(client, eventName, data, status);

  const lead = await AdLead.findOne({ phoneNumber: phone, clientId: client.clientId }).lean();
  let convo = await Conversation.findOne({ phone, clientId: client.clientId });

  if (!convo) {
    convo = await Conversation.create({
      phone,
      clientId: client.clientId,
      channel: 'whatsapp',
      status: 'active',
      source: `flow/${eventName}`,
    });
  }

  const prevMeta =
    convo.metadata && typeof convo.metadata === 'object' ? { ...convo.metadata } : {};
  await Conversation.findByIdAndUpdate(convo._id, {
    $set: { metadata: { ...prevMeta, ...metaPatch, lastCommerceEventAt: new Date() } },
  });

  if (enriched?.length) {
    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      {
        $set: {
          cartSnapshot: {
            items: enriched,
            titles: enriched.map((e) => e.title),
            total_price: data.total_price,
            updatedAt: new Date(),
          },
          lastInteraction: new Date(),
        },
      },
      { upsert: true, new: true }
    ).catch((e) => log.warn(`[FlowTrigger] Lead cart snapshot update failed: ${e.message}`));
  }

  const [convoFresh, leadFresh] = await Promise.all([
    Conversation.findById(convo._id).lean(),
    AdLead.findOne({ phoneNumber: phone, clientId: client.clientId }).lean(),
  ]);

  const { executeAutomationFlow } = require('../utils/commerce/dualBrainEngine');
  await executeAutomationFlow({
    client,
    phone,
    flow: {
      _id: flow._id,
      id: flow.flowId || flow.id,
      flowId: flow.flowId,
      nodes: flow.publishedNodes || flow.nodes,
      edges: flow.publishedEdges || flow.edges,
    },
    currentNodeId: startNodeId,
    convo: convoFresh,
    lead: leadFresh || lead,
    userMessage: `__event:${eventName}__`,
    suppressConversationPersistence: true,
  }).catch((e) => log.error(`[FlowTrigger] executeAutomationFlow error for ${eventName}:`, e.message));
}



async function handleCheckout(client, data) {
    const { upsertAbandonedCartLead } = require('../utils/commerce/upsertAbandonedCartLead');
    const { normalizeIndianPhone } = require('../utils/core/normalizeIndianPhone');

    const phoneRaw =
      data.phone ||
      data.customer?.phone ||
      data.billing_address?.phone ||
      data.shipping_address?.phone;
    const email = data.email || data.customer?.email;
    const phoneE164 = phoneRaw ? normalizeIndianPhone(phoneRaw) : null;

    const checkoutToken = data.checkout_token || data.token || '';
    const cartToken = data.cart_token || '';

    if (!phoneE164 && !email && !checkoutToken) {
      log.warn(
        `[Checkout] Dropped — no phone, email, or checkout token (client=${client.clientId})`
      );
      const { trackEcommerceEvent } = require('../utils/core/analyticsHelper');
      await trackEcommerceEvent(client.clientId, { checkoutDroppedNoContact: 1 }).catch(() => {});
      return;
    }
    const storeHost = client.shopDomain ? String(client.shopDomain).replace(/^https?:\/\//, '').split('/')[0] : '';
    const recoverUrl =
      storeHost && checkoutToken ? `https://${storeHost}/cart/recover/${checkoutToken}` : '';
    const checkoutUrl =
      data.abandoned_checkout_url ||
      data.checkout_url ||
      recoverUrl ||
      (data.token && storeHost ? `https://${storeHost}/checkouts/cn/${data.token}` : '') ||
      '';

    const customerName = data.customer?.first_name
      ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim()
      : undefined;

    const isPurchased = Boolean(data.completed_at);
    const result = await upsertAbandonedCartLead(client, {
      clientId: client.clientId,
      phone: phoneE164,
      email,
      customerName,
      cartItems: data.line_items || [],
      cartTotal: data.total_price,
      checkoutUrl,
      checkoutToken,
      cartToken,
      source: 'shopify_native',
      currency: data.currency || 'INR',
      cartStatus: isPurchased ? 'purchased' : 'active',
      contactCapturedAt: isPurchased ? null : new Date(),
      completedAt: data.completed_at || null,
      shippingAddress: data.shipping_address,
      billingAddress: data.billing_address,
      logActivity: false,
    });

    if (!result.success) return;
    if (result.skipped) return;

    log.info(
      `[CheckoutWebhook] contact captured client=${client.clientId} token=${checkoutToken || 'n/a'} phone=${phoneE164 ? 'yes' : 'no'} email=${email ? 'yes' : 'no'} status=${isPurchased ? 'purchased' : 'active'}`
    );

    const cleanPhone = result.phone || '';
    const lineItems = data.line_items || [];

    await logActivity(client.clientId, {
        type: 'LEAD',
        status: 'info',
        title: 'Checkout Started',
        message: `${customerName || 'A customer'} is at the checkout with ${lineItems.length} items.`,
        icon: 'ShoppingCart',
        url: cleanPhone ? `/leads/${cleanPhone}` : '/leads',
        metadata: {
            phone: cleanPhone || email,
            itemCount: lineItems.length,
            amount: data.total_price
        }
    });

    log.info(`Lead updated from checkout: ${cleanPhone || email}`);
}

async function handleOrder(client, data, storeKey = '') {
    const { resolveShopifyOrderContact } = require('../utils/commerce/resolveShopifyOrderContact');
    const { indianPhoneLookupVariants } = require('../utils/core/normalizeIndianPhone');
    const contact = resolveShopifyOrderContact(client, data);

    if (!contact.canProcess) {
      log.warn(
        `[ShopifyWebhook] Order skipped — no phone, email, or checkout_token (${data.id || data.name})`
      );
      return;
    }

    if (!contact.cleanPhone) {
      log.info(
        `[ShopifyWebhook] Order ${data.id || data.name} — matching via ${contact.matchVia}`
      );
    }

    const { handleOrderAtomic } = require('../utils/shopify/handleOrderAtomic');
    let atomic;
    try {
      atomic = await handleOrderAtomic(client, data, contact.cleanPhone || '');
    } catch (atomicErr) {
      log.error(`[ShopifyWebhook] handleOrderAtomic failed: ${atomicErr.message}`);
      throw atomicErr;
    }
    if (atomic.duplicate) {
      log.info(`[ShopifyWebhook] Order already processed — skipping side effects (${data.id || data.name})`);
      return;
    }
    const lead = atomic.lead;

    const cleanPhone =
      contact.cleanPhone ||
      (lead?.phoneNumber
        ? String(lead.phoneNumber).replace(/\D/g, '').slice(-10)
        : '');

    try {
      const { recordOrderPositiveOutcome } = require('../services/training/trainingOutcomeTracker');
      if (cleanPhone) await recordOrderPositiveOutcome(client.clientId, cleanPhone);
    } catch (_) {}

    const phoneVariants = cleanPhone ? indianPhoneLookupVariants(cleanPhone) : [];
    const leadFilter = phoneVariants.length
      ? { clientId: client.clientId, phoneNumber: { $in: phoneVariants } }
      : lead?._id
        ? { _id: lead._id, clientId: client.clientId }
        : null;

    if (leadFilter) {
      await AdLead.updateOne(
        leadFilter,
        {
          $push: {
            commerceEvents: {
              event: 'checkout_completed',
              amount: parseFloat(data.total_price) || 0,
              currency: data.currency || 'INR',
              timestamp: new Date(),
            },
          },
        }
      ).catch((e) => log.error('Failed to log checkout_completed event:', e.message));
    }

    if (cleanPhone) {
      const { trackEvent } = require('../utils/commerce/journeyTracker');
      await trackEvent(client.clientId, cleanPhone, 'order_placed', {
        orderId: data.name || `#${data.id}`,
        total: data.total_price,
        isCOD: (data.gateway === 'Cash on Delivery (COD)' || (data.payment_gateway_names || []).join('').toLowerCase().includes('cod'))
      });
    }

    if (cleanPhone) {
      try {
        const CheckoutLink = require("../models/CheckoutLink");
        await CheckoutLink.findOneAndUpdate(
          { clientId: client.clientId, phone: cleanPhone, converted: false },
          {
            $set: {
              converted: true,
              convertedAt: new Date(),
              shopifyOrderId: String(data.id || "")
            }
          },
          { sort: { createdAt: -1 } }
        );
      } catch (clErr) {
        log.warn(`[CheckoutLink] attribution skipped: ${clErr.message}`);
      }
    }

    // 3. Upsert internal Order record (same mapper as sync / orders/updated — COD + logistics status)
    const { buildShopifyOrderSet, shopifyOrderFilter, detectCodFromShopify } = require('../utils/shopify/shopifyOrderMapper');
    const resolvedStoreKey = storeKey || client.shopDomain || '';
    const $set = buildShopifyOrderSet(client.clientId, data, {
      preferLogisticsStatus: true,
      storeKey: resolvedStoreKey,
      shopDomain: resolvedStoreKey,
    });
    $set.customerPhone = cleanPhone || $set.customerPhone;
    const filter = shopifyOrderFilter(client.clientId, data);
    const newOrder = await Order.findOneAndUpdate(
        filter,
        { $set },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const isCODOrder = !!newOrder.isCOD || detectCodFromShopify(data);

    try {
      const fin = String(data.financial_status || newOrder.financialStatus || '').toLowerCase();
      const successStatuses = ['paid', 'fulfilled', 'delivered', 'partially_fulfilled'];
      if (successStatuses.includes(fin)) {
        const { attributeRevenueToCampaign } = require('../utils/commerce/campaignStatsHelper');
        await attributeRevenueToCampaign(
          {
            clientId: client.clientId,
            customerPhone: cleanPhone,
            totalPrice: parseFloat(data.total_price) || newOrder.totalPrice || newOrder.amount || 0,
            amount: parseFloat(data.total_price) || newOrder.totalPrice || newOrder.amount || 0,
            orderId: data.name || String(data.id),
            createdAt: new Date(data.created_at || newOrder.createdAt || Date.now()),
          },
          lead
        );
      }
    } catch (attrErr) {
      log.warn(`[ShopifyWebhook] campaign revenue attribution skipped: ${attrErr.message}`);
    }

    try {
      const fin = String(data.financial_status || newOrder.financialStatus || '').toLowerCase();
      const successStatuses = ['paid', 'fulfilled', 'delivered', 'partially_fulfilled'];
      if (successStatuses.includes(fin)) {
        const units = (newOrder.items || data.line_items || []).reduce(
          (sum, it) => sum + (Number(it.quantity) || 0),
          0
        );
        const revenue = parseFloat(data.total_price) || newOrder.totalPrice || newOrder.amount || 0;
        const { incrementStat } = require('../utils/core/statCacheEngine');
        await incrementStat(client.clientId, {
          totalOrders: 1,
          ordersToday: 1,
          totalUnitsSold: units,
          unitsSoldToday: units,
          revenueToday: revenue,
        });
      }
    } catch (statErr) {
      log.warn(`[ShopifyWebhook] StatCache increment skipped: ${statErr.message}`);
    }

    try {
      const { applyAdjustment } = require('../utils/inventory/ledger');
      const { applyBundleOrderDecrement } = require('../utils/inventory/bundleHandler');
      const { recordBackorder } = require('../utils/inventory/backorderHandler');
      const lineItems = data.line_items || newOrder.items || [];
      for (const item of lineItems) {
        const sku = item.sku || item.variant_id;
        if (!sku) continue;
        const qty = Number(item.quantity) || 1;
        const lineId = item.id || item.variant_id || sku;
        const bundleResult = await applyBundleOrderDecrement({
          clientId: client.clientId,
          bundleSku: String(sku),
          orderQty: qty,
          orderId: String(data.id || newOrder.orderId),
          lineItemId: String(lineId),
        });
        if (bundleResult.applied) continue;

        const ledgerRow = await require('../models/InventoryLedger')
          .findOne({ clientId: client.clientId, sku: String(sku), locationId: 'default' })
          .lean();
        const avail = ledgerRow ? Number(ledgerRow.available) : null;
        if (avail != null && avail < qty) {
          const bo = await recordBackorder({
            clientId: client.clientId,
            sku: String(sku),
            qty,
            orderId: String(data.id || newOrder.orderId),
            lineItemId: String(lineId),
          });
          if (bo.allowed) continue;
        }

        await applyAdjustment({
          clientId: client.clientId,
          sku: String(sku),
          delta: -qty,
          reason: 'other',
          source: 'shopify_order',
          sourceRef: String(data.id || newOrder.orderId),
          idempotencyKey: `shopify:${data.id}:${lineId}:create`,
          skipShopifyPush: true,
        });
      }
    } catch (ledgerErr) {
      log.warn(`[ShopifyWebhook] ledger adjustment skipped: ${ledgerErr.message}`);
    }

    // Legacy template auto-triggers — skip when canonical SAC order rules handle sends.
    const {
      shouldSkipLegacyOrderDispatch,
      isActiveOrderRule,
    } = require('../utils/commerce/canonicalOrderMessages');
    const canonical = shouldSkipLegacyOrderDispatch(client);

    if (!canonical) {
      try {
        const { sendByTrigger } = require('../services/templateSender');
        const orderTrigger = isCODOrder ? 'cod_order_placed' : 'order_placed';
        await sendByTrigger({
          clientId: client.clientId,
          phone: cleanPhone,
          trigger: orderTrigger,
          contextData: {
            order: data,
            email: data.email || data.customer?.email,
          },
          email: data.email || data.customer?.email,
        });
      } catch (tplErr) {
        log.warn(`[ShopifyWebhook] order template send skipped: ${tplErr.message}`);
      }
    } else if (isCODOrder && !isActiveOrderRule(client, 'sys_commerce_cod_confirm')) {
      try {
        const { sendByTrigger } = require('../services/templateSender');
        await sendByTrigger({
          clientId: client.clientId,
          phone: cleanPhone,
          trigger: 'cod_order_placed',
          contextData: { order: data, email: data.email || data.customer?.email },
          email: data.email || data.customer?.email,
        });
      } catch (tplErr) {
        log.warn(`[ShopifyWebhook] COD template send skipped: ${tplErr.message}`);
      }
    }

    if (isCODOrder && !canonical && !isActiveOrderRule(client, 'sys_commerce_cod_confirm')) {
      try {
        const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');
        const orderPlain = typeof newOrder.toObject === 'function' ? newOrder.toObject() : newOrder;
        await dispatchOrderStatusAutomation({
          clientConfig: client,
          order: orderPlain,
          previousStatus: '',
          newStatus: 'cod',
          io: null,
          source: 'shopify_webhook:orders/create:cod',
          options: { force: true },
        });
      } catch (codErr) {
        log.warn(`[ShopifyWebhook] COD automation dispatch skipped: ${codErr.message}`);
      }
    }

    if (!canonical) {
      try {
        const fin = String(data.financial_status || '').toLowerCase();
        if (!isCODOrder && (fin === 'paid' || fin === 'partially_paid')) {
          const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');
          const orderPlain = typeof newOrder.toObject === 'function' ? newOrder.toObject() : newOrder;
          await dispatchOrderStatusAutomation({
            clientConfig: client,
            order: orderPlain,
            previousStatus: 'pending',
            newStatus: 'paid',
            io: null,
            source: 'shopify_webhook:orders/create',
            options: { force: true },
          });
        }
      } catch (dispatchErr) {
        log.warn(`[ShopifyWebhook] paid order status dispatch skipped: ${dispatchErr.message}`);
      }
    }

    // Legacy productTriggers evaluator removed after unified commerce automation cutover.

    // Sequence/campaign cancel handled atomically in handleOrderAtomic (Phase 2 — B1/B2)

    // --- SKU-to-Template Automation removed (replaced by SkuTriggerService in switch/case) ---

    // --- COD → Prepaid nudge (wizardFeatures.enableCodToPrepaid) ---
    if (isCODOrder) {
        try {
            const { maybeDispatchCodPrepaidNudge } = require('../utils/commerce/codPrepaidDispatch');
            const codOut = await maybeDispatchCodPrepaidNudge({
                client,
                orderDoc: newOrder,
                shopifyPayload: data,
                phone: cleanPhone,
            });
            if (codOut?.ok || codOut?.scheduled) {
                log.info(`[ShopifyWebhook] COD prepaid nudge ${codOut.ok ? 'sent' : 'scheduled'} for ${data.name}`);
            }
        } catch (codErr) {
            log.error(`COD prepaid nudge failed: ${codErr.message}`);
        }
    }

    // --- PHASE 25: Track 8 - RTO Predictor ---
    const RTOPredictor = require('../utils/commerce/rtoPredictor');
    const rtoAssessment = await RTOPredictor.calculateRisk(data, data.customer, lead);
    newOrder.rtoRiskScore = rtoAssessment.score;
    newOrder.rtoRiskLevel = rtoAssessment.riskLevel;
    await newOrder.save();

    // Notify if high risk
    if (rtoAssessment.riskLevel === 'High') {
        const { updateLeadWithScoring } = require('../utils/commerce/leadScoring');
        await updateLeadWithScoring(
            cleanPhone, 
            client.clientId, 
            {}, // No increments
            {}, // No string updates
            { isRtoRisk: true } // Boolean Update: Flags them as RTO Risk instantly
        );

        const NotificationService = require('../utils/core/notificationService');
        await NotificationService.createNotification(client.clientId, {
            type: 'system',
            title: '🚨 High RTO Risk Detected',
            message: `Order #${newOrder.orderId} scored ${rtoAssessment.score}/100. Reasons: ${rtoAssessment.indicators.join(', ')}`,
            customerPhone: cleanPhone,
            metadata: { orderId: newOrder.orderId }
        });
    }

    const { maybeSendCodConfirmationAfterOrderCreate } = require('../utils/commerce/rtoProtectionService');
    await maybeSendCodConfirmationAfterOrderCreate(client, newOrder).catch((e) =>
        log.warn(`[RTOProtection] COD confirm hook: ${e.message}`)
    );

    // 4. Track in DailyStat (use CartRecoveryAttempt attribution from handleOrderAtomic)
    const recoveryAttempt = atomic.recoveryAttempt;
    const hadAbandonLead = Boolean(atomic.recoveryMatched);
    const statsUpdate = {
        orders: 1,
        revenue: parseFloat(data.total_price)
    };
    if (hadAbandonLead) {
        statsUpdate.cartsRecovered = 1;
        statsUpdate.cartRevenueRecovered = parseFloat(data.total_price);
        if (recoveryAttempt?.recoveredViaWhatsapp) {
            const sentSteps = (recoveryAttempt.whatsappTemplatesSent || [])
                .map((t) => Number(t.followupNumber))
                .filter(Boolean);
            const recoverStep = sentSteps.length ? Math.max(...sentSteps) : Number(lead?.recoveryStep || 1);
            if (recoverStep >= 3) statsUpdate.recoveredViaStep3 = 1;
            else if (recoverStep >= 2) statsUpdate.recoveredViaStep2 = 1;
            else statsUpdate.recoveredViaStep1 = 1;
        }
    }
    await trackEcommerceEvent(client.clientId, statsUpdate);

    // 5. Feature 5: Shopify Order Tagging for WhatsApp attribution
    const orderTaggingEnabled = (client.automationFlows || []).find(f => f.id === 'order_tagging')?.isActive;
    if (orderTaggingEnabled && recoveryAttempt?.recoveredViaWhatsapp && data.id && client.shopifyAccessToken) {
        try {
            const baseUrl = `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}`;
            const existingOrderRes = await axios.get(`${baseUrl}/orders/${data.id}.json`, {
                headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }
            });
            
            let tags = existingOrderRes.data.order?.tags || '';
            if (!tags.includes('whatsapp_recovered')) {
                tags = tags ? `${tags}, whatsapp_recovered` : 'whatsapp_recovered';
                await axios.put(`${baseUrl}/orders/${data.id}.json`, 
                    { order: { id: data.id, tags } },
                    { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
                );
                log.info(`✅ Tagged Shopify order ${data.id} as whatsapp_recovered`);
            }
        } catch (tagErr) {
            log.error('Order tagging failed:', tagErr.response?.data || tagErr.message);
        }
    }

    // 5. Emit socket event for dashboard
    if (global.io) {
        global.io.to(`client_${client.clientId}`).emit('new_order', newOrder);
    }
    
    // Enterprise Pulse Log: New Order
    await logActivity(client.clientId, {
        type: 'ORDER',
        status: 'success',
        title: 'New Shopify Order!',
        message: `Order ${newOrder.orderId} received for ₹${newOrder.amount} from ${newOrder.customerName}.`,
        icon: 'ShoppingBag',
        url: `/orders`,
        metadata: {
            orderId: newOrder.orderId,
            amount: newOrder.amount,
            customer: newOrder.customerName,
            isCritical: newOrder.amount > 1000 // Flag as VIP order if > 1000
        }
    });

    log.info(`Order processed from Shopify: ${newOrder.orderId}`);

    if (recoveryAttempt) {
        log.info(
            `[CartRecovery] ${recoveryAttempt.recoveredViaWhatsapp ? 'WhatsApp' : 'Organic'} recovery for ${cleanPhone}, order ${newOrder.orderId}`
        );
    }

    // TRRIGER WATERFALL ENGINE: Update score in real-time
    await recalculateLeadScore(client.clientId, cleanPhone).catch(e => log.error('Scoring recompute failed:', e.message));
}

async function handleRefund(client, data) {
    const orderId = data.name || data.id;
    log.info(`Processing refund/cancellation for order ${orderId}`, { clientId: client.clientId });

    try {
        const topicLikeStatus = String(data.financial_status || '').toLowerCase();
        const partialRefundIds =
            topicLikeStatus === 'partially_refunded' ? parseRefundedProductIds(data) : [];
        await applyWarrantyVoidFromOrder({
            clientId: client.clientId,
            orderPayload: data,
            refundedProductIds: partialRefundIds,
            source: 'shopify_webhook:orders/refund_or_cancel',
        });

        const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
        if (phoneRaw) {
            const { normalizePhone } = require('../utils/core/helpers');
            const cleanPhone = normalizePhone(phoneRaw);
            const { updateLeadWithScoring } = require('../utils/commerce/leadScoring');
            await updateLeadWithScoring(cleanPhone, client.clientId, {}, {}, { isRtoRisk: true });
            await recalculateLeadScore(client.clientId, cleanPhone).catch(e => log.error('Scoring recompute failed:', e.message));
        }
    } catch (err) {
        log.error(`Error processing refund for ${orderId}:`, err.message);
    }
}

async function createDraftOrder(client, originalOrder, discountCode) {
    if (!client.shopifyAccessToken || !client.shopDomain) {
        log.error("Missing Shopify credentials for Draft Order creation");
        return null;
    }

    const url = `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/draft_orders.json`;
    const payload = {
        draft_order: {
            line_items: originalOrder.line_items.map(item => ({
                variant_id: item.variant_id,
                quantity: item.quantity
            })),
            customer: { id: originalOrder.customer?.id },
            use_customer_default_address: true,
            applied_discount: {
                description: "Prepaid Conversion Discount",
                value_type: "percentage",
                value: "5.0", 
                title: discountCode
            }
        }
    };

    try {
        const res = await axios.post(url, payload, {
            headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }
        });
        return res.data.draft_order;
    } catch (err) {
        log.error(`Shopify Draft Order API Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        throw err;
    }
}

async function handleInventoryUpdate(client, data) {
    try {
        const inventoryItemId = String(data.inventory_item_id || '');
        const locationId = String(data.location_id || 'default');
        const available = Number(data.available);
        const updatedAt = data.updated_at || new Date().toISOString();

        if (!inventoryItemId || Number.isNaN(available)) return;

        const { getAppRedis } = require('../utils/core/redisFactory');
        const redis = getAppRedis();
        const dedupeKey = `inv_webhook:${client.clientId}:${inventoryItemId}:${locationId}:${updatedAt}`;
        if (redis) {
            const seen = await redis.set(dedupeKey, '1', 'EX', 86400, 'NX');
            if (seen !== 'OK') return;
        }

        const ShopifyProduct = require('../models/ShopifyProduct');
        const Client = require('../models/Client');
        const product = await ShopifyProduct.findOneAndUpdate(
            { clientId: client.clientId, shopifyInventoryItemId: inventoryItemId },
            {
                $set: {
                    inventoryQuantity: Math.max(0, available),
                    inStock: available > 0,
                    lastSyncedAt: new Date(),
                },
            },
            { new: true }
        ).lean();

        if (product) {
            const InventoryLedger = require('../models/InventoryLedger');
            const sku = product.sku || product.shopifyVariantId;
            await InventoryLedger.findOneAndUpdate(
                { clientId: client.clientId, sku, locationId: locationId === 'default' ? 'default' : locationId },
                {
                    $set: {
                        available: Math.max(0, available),
                        lastShopifySync: { at: new Date(), qty: available },
                    },
                },
                { upsert: true }
            );
        }

        await Client.updateOne(
            { clientId: client.clientId },
            { $set: { catalogSyncedAt: new Date(), shopifyLastProductSync: new Date() } }
        );

        const { auditLog } = require('../services/audit/auditWriter');
        auditLog({
            category: 'inventory',
            action: 'inventory.shopify_webhook_received',
            clientId: client.clientId,
            details: { inventoryItemId, locationId, available, sku: product?.sku },
        }).catch(() => {});

        if (available > 0) {
            const { triggerRestockNotifications } = require('../services/productWatch/triggerRestockNotifications');
            await triggerRestockNotifications({
                clientId: client.clientId,
                sku: product?.sku || inventoryItemId,
                productName: product?.title || 'Your watched product',
                productUrl: product?.productUrl || '',
                currentStock: available,
            });
        }
    } catch (err) {
        log.error(`Inventory update processing failed: ${err.message}`);
    }
}

module.exports = router;
