const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const log = require('../utils/logger')('ShopifyWebhook');

// Middleware to verify Shopify Webhook signature
const verifyShopifyWebhook = async (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !topic || !shop) {
        return res.status(401).send('Missing headers');
    }

    // Find the client to get their clientSecret for verification
    const client = await Client.findOne({ shopDomain: shop });
    if (!client || !client.shopifyClientSecret) {
        log.error(`Webhook verification failed: No client found for shop ${shop}`);
        return res.status(401).send('Client not found');
    }

    const body = JSON.stringify(req.body);
    const hash = crypto
        .createHmac('sha256', client.shopifyClientSecret)
        .update(body, 'utf8')
        .digest('base64');

    if (hash === hmac) {
        req.client = client;
        req.topic = topic;
        next();
    } else {
        log.error(`Invalid HMAC for shop ${shop}`);
        return res.status(401).send('Invalid signature');
    }
};

// POST /api/shopify/webhook
router.post('/', express.json(), verifyShopifyWebhook, async (req, res) => {
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
            default:
                log.info(`Unhandled topic: ${topic}`);
        }
    } catch (err) {
        log.error(`Error processing webhook ${topic}: ${err.message}`);
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

    // --- COD to Prepaid Conversion ---
    const codActive = (client.automationFlows || []).find(f => f.id === 'cod_to_prepaid')?.isActive;
    const isCOD = data.gateway === 'Cash on Delivery' || data.payment_gateway_names?.includes('Cash on Delivery') || data.payment_gateway_names?.includes('manual');

    if (codActive && isCOD) {
        log.info(`Converting COD order ${data.name} to Prepaid for ${client.clientId}`);
        const niche = client.nicheData || {};
        
        try {
            // 1. Create Draft Order for Payment Link
            const draftOrder = await createDraftOrder(client, data, niche.cod_discount_code || 'PREPAID5');
            
            if (draftOrder && draftOrder.invoice_url) {
                const msg = (niche.cod_nudge_msg || `Hi {name}! 🎁 Want to save more on your order? Pay online now and get an extra discount! Click here: {link}`)
                    .replace(/{name}/g, data.customer?.first_name || 'there')
                    .replace(/{link}/g, draftOrder.invoice_url);

                const WhatsApp = require('../utils/whatsapp');
                await WhatsApp.sendText(client, cleanPhone, msg);
                log.info(`COD nudge sent to ${cleanPhone}`);
            }
        } catch (err) {
            log.error(`COD Conversion failed: ${err.message}`);
        }
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

module.exports = router;
