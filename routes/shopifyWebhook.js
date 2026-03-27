const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
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
        res.status(200).send('OK');
    } catch (err) {
        log.error(`Error processing webhook ${topic}:`, err.message);
        res.status(500).send('Error');
    }
});

async function handleCheckout(client, data) {
    const phone = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phone) return;

    // Standardize phone
    const cleanPhone = phone.replace(/\D/g, '').slice(-10);

    const cartItems = data.line_items.map(item => item.title).join(', ');
    
    await AdLead.findOneAndUpdate(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        {
            $set: {
                name: data.customer?.first_name ? `${data.customer.first_name} ${data.customer.last_name || ''}` : undefined,
                email: data.email || data.customer?.email,
                lastSeen: new Date(),
                checkoutUrl: data.abandoned_checkout_url,
                addToCartCount: data.line_items.length,
                isOrderPlaced: false
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
    log.info(`Lead updated from checkout: ${cleanPhone}`);
}

async function handleOrder(client, data) {
    const phone = data.phone || data.customer?.phone || data.billing_address?.phone;
    if (!phone) return;

    const cleanPhone = phone.replace(/\D/g, '').slice(-10);

    // 1. Update AdLead status to stop abandonment flows
    await AdLead.findOneAndUpdate(
        { phoneNumber: cleanPhone, clientId: client.clientId },
        { 
            isOrderPlaced: true,
            $push: {
                activityLog: {
                    action: 'order_placed',
                    details: `Shopify Order ${data.name || data.id} placed.`,
                    timestamp: new Date()
                }
            }
        }
    );

    // 2. Create internal Order record
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

    // 3. Feature 5: Shopify Order Tagging for WhatsApp attribution
    const orderTaggingEnabled = (client.automationFlows || []).find(f => f.id === 'order_tagging')?.isActive;
    if (orderTaggingEnabled && lead?.recoveryStep > 0 && data.id && client.shopifyAccessToken) {
        try {
            const existingOrder = await axios.get(
                `https://${client.shopDomain}/admin/api/2024-01/orders/${data.id}.json`,
                { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
            );
            const existingTags = existingOrder.data.order?.tags || '';
            const newTags = existingTags ? `${existingTags}, whatsapp_recovered` : 'whatsapp_recovered';
            await axios.put(
                `https://${client.shopDomain}/admin/api/2024-01/orders/${data.id}.json`,
                { order: { id: data.id, tags: newTags } },
                { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
            );
            log.info(`✅ Tagged Shopify order ${data.id} as whatsapp_recovered`);
        } catch (tagErr) {
            log.error('Order tagging failed:', tagErr.message);
        }
    }

    // 4. Emit socket event for dashboard
    if (global.io) {
        global.io.to(`client_${client.clientId}`).emit('new_order', newOrder);
    }
    
    log.info(`Order processed from Shopify: ${newOrder.orderId}`);
}

module.exports = router;
