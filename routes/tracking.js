const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');
const DailyStat = require('../models/DailyStat');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const { sendCODToPrepaidNudge } = require('../utils/ecommerceHelpers');
const { verifyShopifyTrackingWebhook } = require('../middleware/verifyShopifyTrackingWebhook');

// Legacy PRODUCTS mapping removed to support universal SaaS config in the database.
const PRODUCTS = {};

// GET /r/:uid/:productId
router.get('/:uid/:productId', async (req, res) => {
    const { uid, productId } = req.params;
    const Client = require('../models/Client');
    // Fetch target URL from client config or default to a generic fallback
    const lead = await AdLead.findById(uid);
    const client = lead ? await Client.findOne({ clientId: lead.clientId }) : null;
    const targetUrl = client?.storeUrl || 'https://google.com';
    const io = req.app.get('socketio');

    try {
        const now = new Date();
        const existingLead = await AdLead.findById(uid);
        let lead = null;
        if (existingLead) {
            const { updateLeadWithScoring } = require('../utils/leadScoring');
            lead = await updateLeadWithScoring(existingLead.phoneNumber, existingLead.clientId, { linkClicks: 1 });
        }

        if (lead) {
            console.log(`Link clicked by ${lead.phoneNumber} for ${productId}`);
            
            // Increment DailyStat
            await trackEcommerceEvent(lead.clientId, { linkClicks: 1 });
            
            // Phase 3: Increment StatCache
            const { incrementStat } = require('../utils/statCacheEngine');
            await incrementStat(lead.clientId, { totalLinkClicks: 1 });

            // Write atomic event for dashboard aggregations
            try {
                const LinkClickEvent = require('../models/LinkClickEvent');
                await LinkClickEvent.create({
                    clientId: lead.clientId,
                    leadId: lead._id,
                    productId,
                    url: targetUrl,
                    timestamp: new Date()
                });
            } catch (err) {
                console.error('[Tracking] Failed to write LinkClickEvent:', err.message);
            }

            // Emit socket event for real-time dashboard update
            if (io) {
                io.to(`client_${lead.clientId}`).emit('stats_update', {
                    type: 'link_click',
                    leadId: lead._id,
                    productId
                });
            }
        }
    } catch (err) {
        console.error('Tracking Error:', err);
    }

    // Redirect user to the actual product page
    // Append UTM params to track source as 'chatbot'
    const separator = targetUrl.includes('?') ? '&' : '?';
    const trackedUrl = `${targetUrl}${separator}utm_source=whatsapp_chatbot&utm_medium=cpc&utm_campaign=${productId}&utm_content=${uid}`;
    
    res.redirect(trackedUrl);
});

// POST /api/tracking/cart
// Expects: { phone (optional), product (name/id), price }
router.post('/cart', async (req, res) => {
    const pixelSecret = process.env.TRACKING_PIXEL_SECRET;
    if (pixelSecret && req.get('X-Pixel-Secret') !== pixelSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { phone, product, price, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    const io = req.app.get('socketio');

    try {
        if (!phone) {
             // Just emit a generic cart event if no phone is known (anonymous user)
             if (io) io.to(`client_${clientId}`).emit('stats_update', { type: 'add_to_cart_anon' });
             return res.status(200).json({ status: 'tracked_anon' });
        }

        // If we have a phone, update the lead
        const { updateLeadWithScoring } = require('../utils/leadScoring');
        const lead = await updateLeadWithScoring(
            phone,
            clientId,
            { addToCartCount: 1 },
            { cartStatus: "cart_added", lastCartAt: new Date() }
        );

        if (lead && io) {
            // Track in DailyStat
            await trackEcommerceEvent(clientId, { addToCarts: 1 }, { [product]: 1 });

            // Phase 3: Increment StatCache
            const { incrementStat } = require('../utils/statCacheEngine');
            await incrementStat(clientId, { totalAddToCarts: 1 });

            io.to(`client_${clientId}`).emit('stats_update', {
                type: 'add_to_cart',
                leadId: lead._id,
                product
            });
        }
        res.status(200).json({ status: 'tracked', leadId: lead._id });

    } catch (e) {
        console.error("Cart Tracking Error", e);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/tracking/order-webhook
// Shopify Webhook for Order Creation — authenticated via Shopify HMAC + shop domain (production)
router.post('/order-webhook', verifyShopifyTrackingWebhook, async (req, res) => {
    const orderData = req.body;
    const io = req.app.get('socketio');
    const Client = require('../models/Client');
    
    // Shopify sends phone in various formats, need to normalize
    let phone = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
    if (phone) phone = phone.replace(/\D/g, ''); // Remove non-digits
    if (phone && phone.length === 10) phone = '91' + phone; // Assume India if missing code

    const clientId = req.webhookClient.clientId;
    const amount = parseFloat(orderData.total_price);
    const orderId = orderData.name || `#${orderData.order_number}`;
    const shopifyOrderId = String(orderData.id);

    console.log(`📦 New Order Webhook: ${orderId} | Phone: ${phone}`);

    const isCOD = 
        orderData.payment_gateway?.toLowerCase().includes("cod") ||
        orderData.payment_gateway?.toLowerCase().includes("cash") ||
        orderData.financial_status?.toLowerCase() === "pending";

    try {
        const client = await Client.findOne({ clientId });
        if (!client) {
            console.error('Client not found for webhook tracking:', clientId);
            return res.status(404).send('Client not found');
        }

        // 1. Save Order
        const Order = require('../models/Order');
        const order = await Order.findOneAndUpdate(
            { shopifyOrderId: shopifyOrderId, clientId },
            {
                clientId,
                shopifyOrderId,
                orderId,
                orderNumber: orderData.order_number || orderData.name,
                customerName: orderData.customer?.first_name + ' ' + orderData.customer?.last_name,
                phone,
                email: orderData.email || orderData.customer?.email,
                amount,
                totalPrice: amount,
                isCOD,
                status: 'confirmed',
                source: "shopify_webhook",
                shippingAddress: orderData.shipping_address,
                items: orderData.line_items?.map(item => ({
                    name: item.title,
                    quantity: item.quantity,
                    price: parseFloat(item.price),
                    sku: item.sku
                })) || []
            },
            { upsert: true, new: true }
        );

        // 2. Update Lead if phone matches
        if (phone || orderData.email) {
            let leadQuery = { clientId };
            if (phone) leadQuery.phoneNumber = phone;
            else leadQuery.email = orderData.email;

            const { updateLeadWithScoring } = require('../utils/leadScoring');
            const lead = await updateLeadWithScoring(
                phone,
                clientId,
                { ordersCount: 1, totalSpent: amount },
                { cartStatus: "purchased", lastOrderAt: new Date() }
            );

            if (lead && io) {
                // Attribution Logic: Check if this lead recently received a campaign message
                const { attributeRevenueToCampaign } = require('../utils/campaignStatsHelper');
                await attributeRevenueToCampaign(order, lead);
                
                // Phase 3: Increment StatCache
                const { incrementStat } = require('../utils/statCacheEngine');
                await incrementStat(clientId, { 
                    totalOrders: 1, 
                    ordersToday: 1, 
                    revenueToday: amount 
                });

                io.to(`client_${clientId}`).emit('stats_update', {
                    type: 'new_order',
                    leadId: lead._id,
                    orderId,
                    amount,
                    isCOD
                });
            }
        } else {
            // Emit anonymous order
            if (io) io.to(`client_${clientId}`).emit('stats_update', { type: 'new_order_anon', amount });
        }

        if (isCOD) {
            // Wait 3 minutes then send COD nudge (using setTimeout)
            setTimeout(async () => {
                await sendCODToPrepaidNudge(order, client, phone);
            }, 3 * 60 * 1000);
        }

        res.status(200).send('Webhook Received');

    } catch (e) {
        console.error("Order Webhook Error", e);
        res.status(500).send('Error');
    }
});

// --- CASHFREE CALLBACKS ---

// GET /r/cashfree-callback/:orderId
router.get('/cashfree-callback/:orderId', async (req, res) => {
    try {
        const Order = require('../models/Order');
        const DailyStat = require('../models/DailyStat');
        const Client = require('../models/Client');
        const axios = require('axios');
        
        const { link_id } = req.query;
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).send("Order not found");

        const client = await Client.findOne({ clientId: order.clientId });
        if (!client) return res.status(404).send("Client not found");

        const cfConfig = client.config?.cashfree || {};
        
        // Verify Payment Status with Cashfree
        const verifyRes = await axios.get(
            `https://api.cashfree.com/pg/links/${link_id}`,
            {
                headers: {
                    'x-client-id': cfConfig.app_id,
                    'x-client-secret': cfConfig.secret_key,
                    'x-api-version': '2023-08-01'
                }
            }
        );

        const paymentStatus = verifyRes.data.link_status;
        console.log(`[CASHFREE CALLBACK] Order: ${order.orderNumber} | Status: ${paymentStatus}`);

        if (paymentStatus === 'PAID') {
            // Update order status
            await Order.findByIdAndUpdate(order._id, { 
                isCOD: false, 
                paidViaLink: true, 
                status: 'paid',
                paidAt: new Date() 
            });

            const io = req.app.get('socketio');
            // Emit to dashboard — COD converted!
            if (io) {
                io.to(`client_${order.clientId}`).emit("cod_converted", {
                    phone: order.phone,
                    orderNumber: order.orderNumber || order.orderId,
                    amount: order.totalPrice
                });
            }

            // Update DailyStat for ROI counter
            const today = new Date().toISOString().split('T')[0];
            await DailyStat.findOneAndUpdate(
                { clientId: order.clientId, date: today },
                { 
                    $inc: { 
                        codConvertedCount: 1, 
                        codConvertedRevenue: order.totalPrice,
                        rtoCostSaved: 150 // avg RTO cost per order
                    },
                    $setOnInsert: { clientId: order.clientId, date: today }
                },
                { upsert: true }
            );

            // Send confirmation WhatsApp message
            if (order.phone) {
                const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
                const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
                
                await axios.post(
                    `https://graph.facebook.com/v21.0/${phoneId}/messages`,
                    {
                        messaging_product: 'whatsapp',
                        to: order.phone,
                        type: "text",
                        text: { 
                            body: `✅ Payment confirmed! ₹${order.totalPrice} received.\n\nYour order ${order.orderId} will be dispatched within 24 hours. Thank you for your purchase! 🏠`
                        }
                    },
                    { headers: { Authorization: `Bearer ${token}` } }
                );

            // Update Lead Scoring: Upgrade to "Customer" if not already
                const { updateLeadWithScoring } = require('../utils/leadScoring');
                await updateLeadWithScoring(order.phone, order.clientId, {}, { cartStatus: 'paid', lastInteraction: new Date() });
            }
        }

        const redirectUrl = client.shopDomain ? `https://${client.shopDomain}` : client.storeUrl || 'https://google.com';
        res.redirect(redirectUrl);
    } catch (err) {
        console.error("Cashfree callback error:", err.response?.data || err.message);
        res.redirect('https://chatbot-dashboard-frontend-main-3j9k.onrender.com'); // Dashboard fallback
    }
});

// GET /r/razorpay-callback/:orderId
router.get('/razorpay-callback/:orderId', async (req, res) => {
    try {
        const Order = require('../models/Order');
        const Client = require('../models/Client');
        const DailyStat = require('../models/DailyStat');
        const Razorpay = require('razorpay');
        
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).send("Order not found");

        const client = await Client.findOne({ clientId: order.clientId });
        if (!client) return res.status(404).send("Client not found");

        const rzp = new Razorpay({ key_id: client.razorpayKeyId, key_secret: client.razorpaySecret });
        const link = await rzp.paymentLink.fetch(req.query.razorpay_payment_link_id || order.razorpayLinkId);

        if (link.status === 'paid') {
            await Order.findByIdAndUpdate(order._id, { 
                isCOD: false, paidViaLink: true, status: 'paid', paidAt: new Date() 
            });

            const today = new Date().toISOString().split('T')[0];
            await DailyStat.findOneAndUpdate(
                { clientId: order.clientId, date: today },
                { $inc: { codConvertedCount: 1, codConvertedRevenue: order.totalPrice }, $setOnInsert: { clientId: order.clientId, date: today } },
                { upsert: true }
            );

            if (order.phone) {
                const { updateLeadWithScoring } = require('../utils/leadScoring');
                await updateLeadWithScoring(order.phone, order.clientId, {}, { cartStatus: 'paid', lastInteraction: new Date() });
            }
        }

        res.redirect(client.shopDomain ? `https://${client.shopDomain}` : client.storeUrl || 'https://google.com');
    } catch (err) {
        console.error("Razorpay callback error:", err.message);
        res.redirect(process.env.DASHBOARD_URL || 'https://google.com');
    }
});

// GET /r/stripe-callback/:orderId
router.get('/stripe-callback/:orderId', async (req, res) => {
    try {
        const Order = require('../models/Order');
        const Client = require('../models/Client');
        const axios = require('axios');
        
        const order = await Order.findById(req.params.orderId);
        const { session_id } = req.query;
        if (!order || !session_id) return res.status(404).send("Invalid callback");

        const client = await Client.findOne({ clientId: order.clientId });
        if (!client) return res.status(404).send("Client not found");

        // Verify with Stripe session
        const response = await axios.get(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
            headers: { 'Authorization': `Bearer ${client.stripeSecretKey}` }
        });

        if (response.data.payment_status === 'paid') {
            await Order.findByIdAndUpdate(order._id, { isCOD: false, paidViaLink: true, status: 'paid', paidAt: new Date() });
            if (order.phone) {
                const { updateLeadWithScoring } = require('../utils/leadScoring');
                await updateLeadWithScoring(order.phone, order.clientId, {}, { cartStatus: 'paid', lastInteraction: new Date() });
            }
        }

        const redirectUrl = client.shopDomain ? `https://${client.shopDomain}` : client.storeUrl || 'https://google.com';
        res.redirect(redirectUrl);
    } catch (err) {
        console.error("Stripe callback error:", err.message);
        res.redirect(client?.storeUrl || 'https://google.com');
    }
});

// POST /r/phonepe-callback/:orderId
router.post('/phonepe-callback/:orderId', async (req, res) => {
    // PhonePe redirect logic
    const Order = require('../models/Order');
    const Client = require('../models/Client');
    const order = await Order.findById(req.params.orderId);
    const client = await Client.findOne({ clientId: order?.clientId });
    const redirectUrl = client?.shopDomain ? `https://${client.shopDomain}` : client?.storeUrl || 'https://google.com';
    res.redirect(redirectUrl);
});

// POST /api/tracking/fulfillment-webhook
// Shopify Webhook for Order Fulfillment
router.post('/fulfillment-webhook', verifyShopifyTrackingWebhook, async (req, res) => {
    try {
        const payload = req.body;
        const clientId = req.webhookClient.clientId;
        
        // Ensure this is a fulfillment payload
        if (!payload.order_id && !payload.id) {
            return res.status(400).send("Invalid fulfillment payload");
        }

        const Order = require('../models/Order');
        const ReviewRequest = require('../models/ReviewRequest');
        const Client = require('../models/Client');
        const WhatsApp = require('../utils/whatsapp');
        
        const shopifyOrderId = String(payload.order_id || payload.id);
        const order = await Order.findOne({ shopifyOrderId, clientId });
        const client = await Client.findOne({ clientId });

        if (!order || !client) {
            return res.status(404).send("Order or Client not found");
        }

        // 1. Send WhatsApp Notification (Real-time Shipped Alert)
        if (order.phone) {
            const trackingNum = payload.tracking_number || "Available in link";
            const trackingUrl = payload.tracking_url || `https://${client.shopDomain}/account/orders`;
            
            const customMsg = client.nicheData?.shippingConfig?.shippedMessage || 
                "🚚 *Good news! your order is on the way!*\n\nOrder: *{{order_id}}*\nTracking: {{tracking_num}}\n\nYou can track it here: {{tracking_url}}\n\nThank you for shopping with us! ✨";
            
            const body = customMsg
                .replace('{{order_id}}', order.orderId || order.orderNumber)
                .replace('{{tracking_num}}', trackingNum)
                .replace('{{tracking_url}}', trackingUrl);

            try {
                await WhatsApp.sendText(client, order.phone, body);
                await Order.findByIdAndUpdate(order._id, { $set: { status: 'Shipped', trackingUrl } });
            } catch (waErr) {
                console.error("Failed to send shipping WhatsApp:", waErr.message);
            }
        }
        
        // 2. Schedule review for 4 days later
        const scheduledDate = new Date();
        scheduledDate.setDate(scheduledDate.getDate() + 4);

        await ReviewRequest.findOneAndUpdate(
            { orderId: order._id, clientId },
            {
                clientId,
                phone: order.phone,
                orderId: order._id,
                orderNumber: order.orderNumber,
                productName: order.items && order.items.length > 0 ? order.items[0].name : "your product",
                status: "scheduled",
                scheduledFor: scheduledDate
            },
            { upsert: true, new: true }
        );

        // Update Lead Scoring: Mark as Fulfilled/Shipped
        const { updateLeadWithScoring } = require('../utils/leadScoring');
        await updateLeadWithScoring(order.phone, order.clientId, {}, { cartStatus: 'shipped', lastInteraction: new Date() });

        res.status(200).send("Fulfillment processed, notification sent & review scheduled");
    } catch (err) {
        console.error("Fulfillment Webhook Error:", err.message);
        res.status(500).send("Server Error");
    }
});

module.exports = router;
