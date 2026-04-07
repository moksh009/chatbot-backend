const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const { decrypt } = require('../utils/encryption');
const { processOrderForLoyalty } = require('../utils/walletService');
const log = require('../utils/logger')('ShopifyWebhook');

// Middleware to verify Shopify Webhook signature
const verifyShopifyWebhook = async (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !topic || !shop) {
        return res.status(401).send('Missing headers');
    }

    // Find the client to get their secret for verification
    const client = await Client.findOne({ shopDomain: shop });
    if (!client) {
        log.error(`Webhook verification failed: No client found for shop ${shop}`);
        return res.status(401).send('Client not found');
    }

    // Use Webhook Secret if available, otherwise fallback to Client Secret
    // Support both Tier 2.5 modular sub-documents and legacy fields
    const secretRaw = client.commerce?.shopify?.webhookSecret || client.shopifyWebhookSecret || client.shopifyClientSecret;
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

    if (hash === hmac) {
        req.client = client;
        req.topic = topic;
        next();
    } else {
        log.error(`Invalid HMAC for shop ${shop}. Expected: ${hash}, Received: ${hmac}`);
        // In local/test environments we might allow it, but for prod hardening we fail.
        if (process.env.NODE_ENV === 'production') return res.status(401).send('Invalid signature');
        req.client = client;
        req.topic = topic;
        next();
    }
};

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
                break;
            case 'orders/create':
                await handleOrder(client, data);
                break;
            case 'orders/cancelled':
            case 'orders/refunded':
                await handleRefund(client, data);
                break;
            case 'orders/fulfilled':
                const { schedulePostDeliveryUpsell } = require('../utils/upsellEngine');
                await schedulePostDeliveryUpsell(client, data);
                break;
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

async function handleCheckout(client, data) {
    // Robust phone normalization
    const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phoneRaw) return;
    const { normalizePhone } = require('../utils/helpers');
    const cleanPhone = normalizePhone(phoneRaw);

    const cartItems = data.line_items.map(item => item.title).join(', ');
    const firstItemImage = data.line_items?.[0]?.variant_id ? 
        data.line_items[0].image_url || null : null;
    
    await AdLead.findOneAndUpdate(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        {
            $set: {
                name: data.customer?.first_name ? `${data.customer.first_name} ${data.customer.last_name || ''}` : undefined,
                email: data.email || data.customer?.email,
                lastSeen: new Date(),
                checkoutUrl: data.abandoned_checkout_url,
                addToCartCount: data.line_items.length,
                isOrderPlaced: false,
                cartSnapshot: {
                    items: data.line_items.map(item => ({
                        variant_id: item.variant_id,
                        quantity: item.quantity,
                        image: item.image_url || null,
                        title: item.title
                    })),
                    updatedAt: new Date()
                }
            },
            $push: {
                activityLog: {
                    action: 'shopify_checkout',
                    details: `Checkout ${data.id} updated. Items: ${cartItems}`,
                    timestamp: new Date()
                }
            }
        },
        { upsert: true }
    );

    // Track in DailyStat
    await trackEcommerceEvent(client.clientId, { checkoutInitiatedCount: 1 });

    log.info(`Lead updated from checkout: ${cleanPhone}`);
}

async function handleOrder(client, data) {
    // Robust phone normalization
    const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phoneRaw) return;
    const { normalizePhone } = require('../utils/helpers');
    const cleanPhone = normalizePhone(phoneRaw);

    // 1. Fetch Lead
    const lead = await AdLead.findOne({ phoneNumber: cleanPhone, clientId: client.clientId });

    // 2. Update AdLead status to stop abandonment flows
    await AdLead.findOneAndUpdate(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        { 
            isOrderPlaced: true,
            $set: { cartStatus: 'purchased' },
            $push: {
                activityLog: {
                    action: 'order_placed',
                    details: `Shopify Order ${data.name || data.id} placed.`,
                    timestamp: new Date()
                }
            }
        }
    );

    // 3. Create internal Order record
    const newOrder = await Order.create({
        clientId: client.clientId,
        orderId: data.name || `#${data.id}`,
        customerName: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}` : 'Shopify Customer',
        customerPhone: cleanPhone,
        amount: parseFloat(data.total_price),
        status: data.financial_status === 'paid' ? 'Paid' : 'Pending',
        items: data.line_items.map(item => ({
            name: item.title,
            quantity: item.quantity,
            price: parseFloat(item.price)
        })),
        address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
        createdAt: data.created_at
    });

    // --- PHASE 27: Loyalty Points Award ---
    if (client.loyaltyConfig?.isEnabled) {
        processOrderForLoyalty(client.clientId, cleanPhone, parseFloat(data.total_price), data.name || data.id)
            .then(res => {
                if (res) log.info(`Awarded ${res.pointsAwarded} points to ${cleanPhone}`);
            })
            .catch(e => log.error('Loyalty award failed', e.message));
    }

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
                const firstItemImage = data.line_items?.[0]?.variant_id ? data.line_items[0].image_url : null;
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
            const baseUrl = `https://${client.shopDomain}/admin/api/2024-01`;
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
    
    log.info(`Order processed from Shopify: ${newOrder.orderId}`);
}

async function handleRefund(client, data) {
    const orderId = data.name || data.id;
    log.info(`Processing refund/cancellation for order ${orderId}`, { clientId: client.clientId });

    try {
        const { reverseOrderPoints } = require('../utils/walletService');
        const result = await reverseOrderPoints(client.clientId, orderId);

        if (result) {
            log.info(`Successfully reversed ${result.pointsDeducted} points for ${orderId}. New Balance: ${result.newBalance}`);
            
            // Optional: Notify customer about point deduction via WhatsApp
            // We can add this later in Phase 3
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

    const url = `https://${client.shopDomain}/admin/api/2024-01/draft_orders.json`;
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
