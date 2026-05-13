const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const { decrypt } = require('../utils/encryption');
const Contact = require('../models/Contact');
const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const { processOrderForLoyalty } = require('../utils/walletService');
const { logActivity } = require('../utils/activityLogger');
const { recalculateLeadScore } = require('../utils/scoringHelper');
const log = require('../utils/logger')('ShopifyWebhook');
const commerceAutomationService = require('../utils/commerceAutomationService');
const shopifyAdminApiVersion = require('../utils/shopifyAdminApiVersion');

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

    const verifyRow = await Client.findOne({ shopDomain: shop })
      .select('commerce.shopify.webhookSecret shopifyWebhookSecret shopifyClientSecret')
      .lean();
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

    const loadFullClient = () => Client.findOne({ shopDomain: shop }).lean();

    if (hash === hmac) {
        req.client = await loadFullClient();
        if (!req.client) {
          log.error(`Webhook: client disappeared for shop ${shop}`);
          return res.status(401).send('Client not found');
        }
        req.topic = topic;
        next();
    } else {
        log.error(`Invalid HMAC for shop ${shop}. Expected: ${hash}, Received: ${hmac}`);
        // In local/test environments we might allow it, but for prod hardening we fail.
        if (process.env.NODE_ENV === 'production') return res.status(401).send('Invalid signature');
        req.client = await loadFullClient();
        if (!req.client) {
          log.error(`Webhook: client disappeared for shop ${shop}`);
          return res.status(401).send('Client not found');
        }
        req.topic = topic;
        next();
    }
};

async function reconcileLocalOrderFromShopifyAdmin(client, orderPayload, topic) {
    if (!orderPayload || orderPayload.id == null) return;
    const { buildShopifyOrderSet, shopifyOrderFilter } = require('../utils/shopifyOrderMapper');
    const { dispatchOrderStatusAutomation } = require('../utils/orderEventDispatcher');
    const $set = buildShopifyOrderSet(client.clientId, orderPayload, { preferLogisticsStatus: true });
    const filter = shopifyOrderFilter(client.clientId, orderPayload);
    const prev = await Order.findOne(filter).lean();
    const prevStatus = prev?.status || '';
    const prevTrack = `${prev?.trackingUrl || ''}|${prev?.trackingNumber || ''}`;
    const doc = await Order.findOneAndUpdate(filter, { $set }, { upsert: true, new: true, setDefaultsOnInsert: true });
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

async function handleFulfillmentWebhookForAdmin(client, fulfillment, topic) {
    const orderId = fulfillment?.order_id;
    if (!orderId) return;
    const { dispatchOrderStatusAutomation } = require('../utils/orderEventDispatcher');
    const oidStr = String(orderId);
    const prev = await Order.findOne({ clientId: client.clientId, shopifyOrderId: oidStr }).lean();
    if (!prev) {
        log.warn(`[Webhook] fulfillment for missing local order shopify:${oidStr}`);
        return;
    }
    const prevStatus = prev.status || 'pending';
    const urls = fulfillment.tracking_urls;
    const trackingUrl = (Array.isArray(urls) && urls[0]) || fulfillment.tracking_url || prev.trackingUrl || '';
    const trackingNumber = fulfillment.tracking_number || prev.trackingNumber || '';
    const doc = await Order.findOneAndUpdate(
        { clientId: client.clientId, shopifyOrderId: oidStr },
        {
            $set: {
                status: 'shipped',
                fulfillmentStatus: 'fulfilled',
                trackingUrl,
                trackingNumber,
                fulfilledAt: new Date(),
            },
        },
        { new: true }
    );
    await dispatchOrderStatusAutomation({
        clientConfig: client,
        order: doc.toObject(),
        previousStatus: prevStatus,
        newStatus: 'shipped',
        trackingNumber,
        trackingUrl,
        io: null,
        source: `shopify_webhook:${topic}`,
        options: {},
    });
}

// POST /api/shopify/webhook
router.post('/', verifyShopifyWebhook, async (req, res) => {
    const topic = req.topic;
    const client = req.client;
    const data = req.body;

    log.info(`Received Shopify Webhook: ${topic} for ${client.clientId}`);

    res.status(200).send('OK');

    try {
        switch (topic) {
            case 'checkouts/create':
            case 'checkouts/update':
                await handleCheckout(client, data);
                // Fire any flow with abandoned_cart trigger (checkout = potential abandon)
                await fireEventFlow(client, 'abandoned_cart', data).catch(e =>
                  log.warn(`[FlowTrigger] abandoned_cart flow fire failed: ${e.message}`)
                );
                break;
            case 'orders/create':
                await handleOrder(client, data);
                // Fire any flow with order_placed trigger
                await fireEventFlow(client, 'order_placed', data).catch(e =>
                  log.warn(`[FlowTrigger] order_placed flow fire failed: ${e.message}`)
                );
                await commerceAutomationService.runAutomationsForEvent({
                  clientConfig: client,
                  eventType: 'paid',
                  order: {
                    orderId: data.name || data.id,
                    orderNumber: data.name,
                    customerPhone: data.phone || data.customer?.phone || data.billing_address?.phone,
                    customerName: data.customer?.first_name || 'Customer',
                    items: data.line_items.map(i => ({ sku: i.sku, name: i.title })),
                  },
                }).catch(e => log.error('Commerce automations paid failed:', e.message));
                break;
            case 'orders/cancelled':
            case 'orders/refunded':
                await handleRefund(client, data);
                // Fire any flow with order_status_changed trigger set to 'cancelled' or 'returned'
                await fireEventFlow(client, 'order_status_changed', data, data.financial_status === 'refunded' ? 'returned' : 'cancelled').catch(e =>
                  log.warn(`[FlowTrigger] order_status_changed flow fire failed: ${e.message}`)
                );
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
                await reconcileLocalOrderFromShopifyAdmin(client, data, topic);
                break;
            case 'fulfillments/create':
            case 'fulfillments/update':
                await handleFulfillmentWebhookForAdmin(client, data, topic);
                break;
            case 'orders/fulfilled': {
                await reconcileLocalOrderFromShopifyAdmin(client, data, topic);
                const { schedulePostDeliveryUpsell } = require('../utils/upsellEngine');
                const { scheduleReviewRequest } = require('../utils/reputationService');
                await schedulePostDeliveryUpsell(client, data);
                await scheduleReviewRequest(client, data);
                // Fire any flow with order_fulfilled trigger
                await fireEventFlow(client, 'order_fulfilled', data).catch(e =>
                  log.warn(`[FlowTrigger] order_fulfilled flow fire failed: ${e.message}`)
                );

                // --- PHASE 30.5: Enterprise Warranty Auto-Assign (ENGINE) ---
                const { processWarrantyAutoAssignment } = require('../utils/warrantyEngine');
                await processWarrantyAutoAssignment(client, data).catch(e =>
                    log.error('[Warranty] Auto-assignment failed:', e.message)
                );

                break;
            }
            case 'inventory_levels/update':
            case 'inventory_items/update':
                await handleInventoryUpdate(client, data);
                break;
            default:
                log.info(`Unhandled topic: ${topic}`);
        }
    } catch (err) {
        log.error(`Error processing webhook ${topic}:`, { error: err.message });
    }
});

/**
 * Enrich Shopify line items with product images (checkout + order payloads).
 */
async function enrichLineItemsForCommerce(client, lineItems = []) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  return Promise.all(items.map(async (item) => {
    let imageUrl = item.image_url || item.imageUrl || null;
    if (!imageUrl && item.product_id && client.shopifyAccessToken && client.shopDomain) {
      try {
        const res = await axios.get(
          `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${item.product_id}.json`,
          { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
        );
        imageUrl = res.data.product?.images?.[0]?.src || null;
      } catch (_) { /* omit */ }
    }
    const title = item.title || item.name || 'Item';
    const qty = item.quantity || 1;
    return {
      title,
      quantity: qty,
      price: item.price || item.line_price || '',
      imageUrl,
      variant_title: item.variant_title || '',
    };
  }));
}

function formatLineItemsBullets(enriched) {
  if (!enriched.length) return '';
  return enriched
    .map((i) => `• ${i.title}${i.variant_title ? ` (${i.variant_title})` : ''} × ${i.quantity}`)
    .join('\n');
}

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
  const checkoutUrl =
    data.abandoned_checkout_url
    || data.checkout_url
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
  const { findEventTriggeredFlow } = require('../utils/triggerEngine');
  const { normalizePhone } = require('../utils/helpers');

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

  const { executeAutomationFlow } = require('../utils/dualBrainEngine');
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
    // Robust phone normalization
    const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phoneRaw) return;
    const { normalizePhone } = require('../utils/helpers');
    const cleanPhone = normalizePhone(phoneRaw);

    // Auto-fetch product images for the cart snapshot
    const enrichedItems = await Promise.all(data.line_items.map(async item => {
        let imageUrl = item.image_url || null;
        if (!imageUrl && item.product_id && client.shopifyAccessToken) {
            try {
                const res = await axios.get(
                    `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${item.product_id}.json`,
                    { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } }
                );
                imageUrl = res.data.product?.images?.[0]?.src || null;
            } catch (err) {
                // Silently omit missing image
            }
        }
        return {
            variant_id: item.variant_id,
            quantity: item.quantity,
            image: imageUrl,
            title: item.title,
            price: item.price
        };
    }));

    const cartItems = data.line_items.map(item => item.title).join(', ');
    const firstItemImage = enrichedItems[0]?.image || client.logoUrl || null;
    
    const { updateLeadWithScoring } = require('../utils/leadScoring');
    await updateLeadWithScoring(
        cleanPhone, 
        client.clientId, 
        { addToCartCount: data.line_items.length }, // Increments
        { 
            name: data.customer?.first_name ? `${data.customer.first_name} ${data.customer.last_name || ''}` : undefined,
            email: data.email || data.customer?.email,
            lastSeen: new Date(),
            checkoutUrl: data.abandoned_checkout_url,
            isOrderPlaced: false,
            cartSnapshot: {
                items: enrichedItems,
                updatedAt: new Date()
            }
        }, // String/Value updates
        {} // Boolean updates
    );

    // Deep Pixel Hook: Register Backend Checkout Initiation natively
    await AdLead.updateOne(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        { $push: { 
            commerceEvents: {
                event: 'checkout_started',
                amount: parseFloat(data.total_price) || 0,
                currency: data.currency || 'INR',
                timestamp: new Date()
            }
        }}
    ).catch(e => log.error('Failed to log checkout_started event:', e.message));

    // Track in DailyStat
    await trackEcommerceEvent(client.clientId, { checkoutInitiatedCount: 1 });

    // Enterprise Pulse Log: Checkout Initiated
    await logActivity(client.clientId, {
        type: 'LEAD',
        status: 'info',
        title: 'Checkout Started',
        message: `${data.customer?.first_name || 'A customer'} is at the checkout with ${data.line_items.length} items.`,
        icon: 'ShoppingCart',
        url: `/leads/${cleanPhone}`,
        metadata: {
            phone: cleanPhone,
            itemCount: data.line_items.length,
            amount: data.total_price
        }
    });

    log.info(`Lead updated from checkout: ${cleanPhone}`);

    // --- PART 7: Cart Recovery Attempt Lifecycle - Trigger 1 ---
    try {
        const CartRecoveryAttempt = require('../models/CartRecoveryAttempt');
        await CartRecoveryAttempt.create({
            clientId: client.clientId,
            contactPhone: cleanPhone,
            attemptTimestamp: new Date(),
            messaged: false,
            recovered: false,
            status: 'pending'
        });
    } catch (craErr) {
        log.warn(`[CartRecovery] Failed to create attempt record: ${craErr.message}`);
    }

    // TRRIGER WATERFALL ENGINE: Update score in real-time
    await recalculateLeadScore(client.clientId, cleanPhone).catch(e => log.error('Scoring recompute failed:', e.message));
}

async function handleOrder(client, data) {
    // Robust phone normalization
    const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phoneRaw) return;
    const { normalizePhone } = require('../utils/helpers');
    const cleanPhone = normalizePhone(phoneRaw);

    // 1. Fetch Lead
    const lead = await AdLead.findOne({ phoneNumber: cleanPhone, clientId: client.clientId });

    // 2. Update AdLead status to stop abandonment flows and score lead
    const { updateLeadWithScoring } = require('../utils/leadScoring');
    await updateLeadWithScoring(
        cleanPhone, 
        client.clientId, 
        { ordersCount: 1 }, // Increments
        { cartStatus: "purchased", lastOrderAt: new Date() }, // String/Date Updates
        { isRtoRisk: false } // Reset RTO risk on new successful order
    );

    // Deep Pixel Hook: Register Backend Order Completion natively to fix Attribution Grid
    await AdLead.updateOne(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        { $push: { 
            commerceEvents: {
                event: 'checkout_completed',
                amount: parseFloat(data.total_price) || 0,
                currency: data.currency || 'INR',
                timestamp: new Date()
            }
        }}
    ).catch(e => log.error('Failed to log checkout_completed event:', e.message));

    // Track Journey Event
    const { trackEvent } = require('../utils/journeyTracker');
    await trackEvent(client.clientId, cleanPhone, 'order_placed', {
        orderId: data.name || `#${data.id}`,
        total: data.total_price,
        isCOD: (data.gateway === 'Cash on Delivery (COD)' || (data.payment_gateway_names || []).join('').toLowerCase().includes('cod'))
    });

    // 2b. Attribute WhatsApp checkout short links (Commerce)
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

    // 3. Create internal Order record
    const newOrder = await Order.create({
        clientId: client.clientId,
        orderId: data.name || `#${data.id}`,
        orderNumber: data.name || `#${data.id}`,
        shopifyOrderId: String(data.id || ''),
        customerName: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}` : 'Shopify Customer',
        customerPhone: cleanPhone,
        customerEmail: data.email || data.customer?.email || '',
        amount: parseFloat(data.total_price),
        totalPrice: parseFloat(data.total_price),
        financialStatus: data.financial_status || '',
        fulfillmentStatus: data.fulfillment_status || '',
        status: data.financial_status === 'paid' ? 'Paid' : 'Pending',
        items: data.line_items.map(item => ({
            name: item.title,
            quantity: item.quantity,
            price: parseFloat(item.price),
            sku: item.sku || '',
            image: item.image_url || ''
        })),
        address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
        createdAt: data.created_at
    });

    // --- PHASE 27: Loyalty Points Award ---
    if (client.loyaltyConfig?.isEnabled && newOrder.amount > 0) {
        const { awardLoyaltyPoints } = require('../utils/loyaltyEngine');
        awardLoyaltyPoints({
            clientId: client.clientId,
            phone: cleanPhone,
            orderId: newOrder.orderId,
            orderAmount: newOrder.amount
        }).then(res => {
            if (res.success) log.info(`Awarded ${res.points} points to ${cleanPhone} for order ${newOrder.orderId}`);
        }).catch(err => console.error("[Loyalty] Award failed:", err.message));
    }

    // Legacy productTriggers evaluator removed after unified commerce automation cutover.

    // ✅ Phase R3: Cancel active cart recovery sequences on purchase — GAP 6
    // Customer paid → stop all recovery messages so they don't get spammed post-purchase
    try {
        const FollowUpSequence = require('../models/FollowUpSequence');
        await FollowUpSequence.updateMany(
            { 
                clientId: client.clientId, 
                leadPhone: { $in: [cleanPhone, `+${cleanPhone}`, cleanPhone.replace(/^\+/, '')] },
                status: 'active', 
                type: { $in: ['cart_recovery', 'abandoned_cart', 'followup'] }
            },
            { $set: { status: 'cancelled', cancelledReason: 'customer_purchased', cancelledAt: new Date() } }
        );
        log.info(`[CartRecovery] Cancelled active sequences for ${cleanPhone} after purchase`);
    } catch (seqErr) {
        log.warn('[CartRecovery] Failed to cancel sequences after purchase:', seqErr.message);
    }



    // --- SKU-to-Template Automation removed (replaced by SkuTriggerService in switch/case) ---

    // --- COD to Prepaid Conversion ---
    const codActive = (client.automationFlows || []).find(f => f.id === 'cod_to_prepaid')?.isActive;
    const isCOD = data.gateway === 'Cash on Delivery' || data.payment_gateway_names?.includes('Cash on Delivery') || data.payment_gateway_names?.includes('manual');

    if (codActive && isCOD) {
        log.info(`Converting COD order ${data.name} to Prepaid for ${client.clientId}`);
        const niche = client.nicheData || {};
        const WhatsApp = require('../utils/whatsapp');
        
        try {
            // Determine the Payment Gateway Strategy
            let paymentLinkUrl = null;
            let paymentGateway = client.activePaymentGateway || 'none';

            if (paymentGateway === 'razorpay' && client.razorpayKeyId) {
                const { createCODPaymentLink } = require('../utils/razorpay');
                const link = await createCODPaymentLink(newOrder, client);
                paymentLinkUrl = link.short_url;
            } else if (paymentGateway === 'cashfree' && client.cashfreeAppId) {
                const { createCashfreePaymentLink } = require('../utils/cashfree');
                const link = await createCashfreePaymentLink(newOrder, client);
                paymentLinkUrl = link.short_url;
            } else {
                // Fallback to Shopify Draft Order for Native Checkout
                const draftOrder = await createDraftOrder(client, data, niche.cod_discount_code || niche.globalDiscountCode || 'PREPAID5');
                paymentLinkUrl = draftOrder?.invoice_url;
            }
            
            if (paymentLinkUrl) {
                // Prepare dynamic template dispatch
                const firstItemImage = await getProductImageForOrder(data, client);
                const orderId = data.name || data.id;
                const total = data.total_price;
                const customerName = data.customer?.first_name || 'Guest';

                // Determine template name logic based on gateway (user requested distinct tracking/brands via templates)
                let templateName = 'cod_to_prepaid_discount'; // DEFAULT FALLBACK
                
                if (paymentGateway === 'razorpay') templateName = 'razorpay_cod_converter';
                else if (paymentGateway === 'cashfree') templateName = 'cashfree_cod_converter';
                else templateName = 'shopify_cod_converter';

                // We try to send smartly using predefined sync list
                // If it fails, our smart sender gracefully falls back to sequential text params
                try {
                    await WhatsApp.sendSmartTemplate(
                        client, 
                        cleanPhone, 
                        templateName, 
                        [customerName, orderId, total, paymentLinkUrl], // Assumes {{1}}=Name, {{2}}=Order, {{3}}=Total, {{4}}=Link
                        firstItemImage
                    );
                    log.info(`COD Payment link (${paymentGateway}) sent to ${cleanPhone}`);
                } catch (metaErr) {
                    log.warn(`[ShopifyWebhook] Meta Template ${templateName} failed or not synced. Falling back to simple interactive message.`);
                    
                    const fallbackBody = `Hi ${customerName}! 🎁 Want to save more on your order? Pay online securely now and get an extra discount!\n\n💳 Pay here: ${paymentLinkUrl}\n\n*Order:* #${orderId}\n*Amount:* ₹${total}`;
                    const interactive = {
                        type: 'button',
                        header: { type: 'text', text: '💳 Convert to Prepaid' },
                        body: { text: fallbackBody },
                        footer: { text: client.businessName || 'Smart Store' },
                        action: {
                            buttons: [
                                { type: 'reply', reply: { id: `cod_upi_${data.id}`, title: '✅ Confirmed' } }
                            ]
                        }
                    };
                    await WhatsApp.sendInteractive(client, cleanPhone, interactive, fallbackBody);
                }
            }
        } catch (err) {
            log.error(`COD Conversion failed: ${err.message}`);
        }
    }

    // --- PHASE 25: Track 8 - RTO Predictor ---
    const RTOPredictor = require('../utils/rtoPredictor');
    const rtoAssessment = await RTOPredictor.calculateRisk(data, data.customer, lead);
    newOrder.rtoRiskScore = rtoAssessment.score;
    newOrder.rtoRiskLevel = rtoAssessment.riskLevel;
    await newOrder.save();

    // Notify if high risk
    if (rtoAssessment.riskLevel === 'High') {
        const { updateLeadWithScoring } = require('../utils/leadScoring');
        await updateLeadWithScoring(
            cleanPhone, 
            client.clientId, 
            {}, // No increments
            {}, // No string updates
            { isRtoRisk: true } // Boolean Update: Flags them as RTO Risk instantly
        );

        const NotificationService = require('../utils/notificationService');
        await NotificationService.createNotification(client.clientId, {
            type: 'system',
            title: '🚨 High RTO Risk Detected',
            message: `Order #${newOrder.orderId} scored ${rtoAssessment.score}/100. Reasons: ${rtoAssessment.indicators.join(', ')}`,
            customerPhone: cleanPhone,
            metadata: { orderId: newOrder.orderId }
        });
    }

    // 4. Track in DailyStat
    const isRecovered = lead && lead.recoveryStep > 0;
    const statsUpdate = {
        orders: 1,
        revenue: parseFloat(data.total_price)
    };
    if (isRecovered) {
        statsUpdate.cartsRecovered = 1;
        statsUpdate.cartRevenueRecovered = parseFloat(data.total_price);
        
        // Granular Step Attribution
        if (lead.recoveryStep === 1) statsUpdate.recoveredViaStep1 = 1;
        else if (lead.recoveryStep === 2) statsUpdate.recoveredViaStep2 = 1;
        else if (lead.recoveryStep === 3) statsUpdate.recoveredViaStep3 = 1;
    }
    await trackEcommerceEvent(client.clientId, statsUpdate);

    // 5. Feature 5: Shopify Order Tagging for WhatsApp attribution
    const orderTaggingEnabled = (client.automationFlows || []).find(f => f.id === 'order_tagging')?.isActive;
    if (orderTaggingEnabled && lead && lead.recoveryStep > 0 && data.id && client.shopifyAccessToken) {
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

    // --- PART 7: Cart Recovery Attempt Lifecycle - Trigger 3 ---
    try {
        const CartRecoveryAttempt = require('../models/CartRecoveryAttempt');
        const attempt = await CartRecoveryAttempt.findOneAndUpdate(
            {
                clientId: client.clientId,
                contactPhone: cleanPhone,
                messaged: true,
                recovered: false,
                status: 'pending'
            },
            {
                $set: {
                    recovered: true,
                    status: 'recovered',
                    recoveredOrderId: newOrder.orderId,
                    recoveredOrderAmount: parseFloat(data.total_price),
                    updatedAt: new Date()
                }
            },
            { sort: { attemptTimestamp: -1 }, new: true }
        );

        if (attempt) {
            console.log(`[CartRecovery] Marked attempt ${attempt._id} as recovered for phone ${cleanPhone}, order ${newOrder.orderId}`);
        }
    } catch (craErr) {
        log.warn(`[CartRecovery] Failed to update attempt record: ${craErr.message}`);
    }

    // TRRIGER WATERFALL ENGINE: Update score in real-time
    await recalculateLeadScore(client.clientId, cleanPhone).catch(e => log.error('Scoring recompute failed:', e.message));
}

async function handleRefund(client, data) {
    const orderId = data.name || data.id;
    log.info(`Processing refund/cancellation for order ${orderId}`, { clientId: client.clientId });

    try {
        const { reverseOrderPoints } = require('../utils/walletService');
        const result = await reverseOrderPoints(client.clientId, orderId);

        if (result) {
            log.info(`Successfully reversed ${result.pointsDeducted} points for ${orderId}. New Balance: ${result.newBalance}`);
            
            // Revert points in CustomerIntelligence if it tracks them
            const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
            if (phoneRaw) {
                const { normalizePhone } = require('../utils/helpers');
                const cleanPhone = normalizePhone(phoneRaw);
                
                // Flag as RTO Risk in AdLead
                const { updateLeadWithScoring } = require('../utils/leadScoring');
                await updateLeadWithScoring(cleanPhone, client.clientId, {}, {}, { isRtoRisk: true });

                const CustomerIntelligence = require('../models/CustomerIntelligence');
                await CustomerIntelligence.findOneAndUpdate(
                    { clientId: client.clientId, phone: cleanPhone },
                    { $inc: { totalPoints: -result.pointsDeducted } }
                ).catch(() => {}); // Optional fail-safe
                
                // TRIGGER WATERFALL ENGINE: Update score in real-time
                await recalculateLeadScore(client.clientId, cleanPhone).catch(e => log.error('Scoring recompute failed:', e.message));
            }
        } else {
            log.warn(`Point reversal not needed or no loyalty points were awarded for order ${orderId}`);
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
        // Handle inventory_levels/update
        const inventoryItemId = data.inventory_item_id;
        const available = data.available;

        if (!inventoryItemId || typeof available === 'undefined') return;

        // If it's back in stock or has enough stock
        if (available > 0) {
            const ProductWatch = require('../models/ProductWatch');
            // Find anyone watching this item
            const watches = await ProductWatch.find({ 
                clientId: client.clientId, 
                variantId: inventoryItemId.toString(), 
                condition: { $in: ['back_in_stock', 'low_stock'] }, 
                status: 'watching' 
            });

            if (watches.length > 0) {
                const WhatsApp = require('../utils/whatsapp');
                for (const watch of watches) {
                    try {
                        const message = `Good news! 🎉 The item you were looking for (*${watch.productName}*) is back in stock! Grab it before it's gone.`;
                        await WhatsApp.sendText(client, watch.phone, message);
                        
                        watch.status = 'notified';
                        watch.notifiedAt = new Date();
                        await watch.save();
                        
                        log.info(`Notified ${watch.phone} about inventory update for ${watch.productName}`);
                    } catch (e) {
                        log.error(`Failed to notify ${watch.phone} for inventory update`, e.message);
                    }
                }
            }
        }
    } catch (err) {
        log.error(`Inventory update processing failed: ${err.message}`);
    }
}

module.exports = router;
