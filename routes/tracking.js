const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');
const DailyStat = require('../models/DailyStat');
const { trackEcommerceEvent } = require('../utils/analyticsHelper');
const { sendCODToPrepaidNudge } = require('../utils/ecommerceHelpers');

const PRODUCTS = {
    'prod_3mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp',
    'prod_5mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp',
    '3mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp',
    '5mp': 'https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp'
};

// GET /r/:uid/:productId
router.get('/:uid/:productId', async (req, res) => {
    const { uid, productId } = req.params;
    const targetUrl = PRODUCTS[productId] || 'https://delitechsmarthome.in';
    const io = req.app.get('socketio');

    try {
        const now = new Date();
        const update = {
            $inc: { linkClicks: 1 },
            $set: { lastInteraction: now },
            $push: {
                activityLog: {
                    action: 'link_click',
                    details: `clicked product ${productId}`,
                    timestamp: now
                }
            }
        };

        const lead = await AdLead.findByIdAndUpdate(
            uid,
            update,
            { new: true }
        );

        if (lead) {
            console.log(`Link clicked by ${lead.phoneNumber} for ${productId}`);
            
            // Increment DailyStat
            await trackEcommerceEvent(lead.clientId, { linkClicks: 1 });

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
    const { phone, product, price, clientId = 'delitech_smarthomes' } = req.body;
    const io = req.app.get('socketio');

    try {
        if (!phone) {
             // Just emit a generic cart event if no phone is known (anonymous user)
             if (io) io.to(`client_${clientId}`).emit('stats_update', { type: 'add_to_cart_anon' });
             return res.status(200).json({ status: 'tracked_anon' });
        }

        // If we have a phone, update the lead
        const lead = await AdLead.findOneAndUpdate(
            { phoneNumber: phone, clientId },
            { 
                $inc: { addToCartCount: 1 },
                $set: { lastInteraction: new Date() },
                $push: { 
                    activityLog: { 
                        action: 'add_to_cart', 
                        details: `Added ${product} (₹${price})`,
                        timestamp: new Date()
                    }
                },
                $setOnInsert: { 
                    phoneNumber: phone, 
                    clientId, 
                    createdAt: new Date(), 
                    source: 'Website' 
                }
            },
            { upsert: true, new: true }
        );

        if (lead && io) {
            // Track in DailyStat
            await trackEcommerceEvent(clientId, { addToCarts: 1 }, { [product]: 1 });

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
// Shopify Webhook for Order Creation
router.post('/order-webhook', async (req, res) => {
    const orderData = req.body;
    const io = req.app.get('socketio');
    const Client = require('../models/Client');
    
    // Shopify sends phone in various formats, need to normalize
    let phone = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
    if (phone) phone = phone.replace(/\D/g, ''); // Remove non-digits
    if (phone && phone.length === 10) phone = '91' + phone; // Assume India if missing code

    const clientId = req.query.clientId || 'delitech_smarthomes';
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

            const lead = await AdLead.findOneAndUpdate(
                leadQuery,
                {
                    $inc: { ordersCount: 1, totalSpent: amount },
                    $set: { isOrderPlaced: true, lastInteraction: new Date() },
                    $push: {
                        activityLog: {
                            action: 'order_placed',
                            details: `Order ${orderId} for ₹${amount}`,
                            timestamp: new Date()
                        }
                    }
                },
                { upsert: true, new: true }
            );

            if (lead && io) {
                // Attribution Logic: Check if this lead recently received a campaign message
                const { attributeRevenueToCampaign } = require('../utils/campaignStatsHelper');
                await attributeRevenueToCampaign(order, lead);

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
                    `https://graph.facebook.com/v18.0/${phoneId}/messages`,
                    {
                        messaging_product: 'whatsapp',
                        to: order.phone,
                        type: "text",
                        text: { 
                            body: `✅ Payment confirmed! ₹${order.totalPrice} received.\n\nYour order ${order.orderId} will be dispatched within 24 hours. Thank you for choosing Delitech! 🏠`
                        }
                    },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
            }
        }

        res.redirect(`https://delitechsmarthome.in`);
    } catch (err) {
        console.error("Cashfree callback error:", err.response?.data || err.message);
        res.redirect(`https://delitechsmarthome.in`);
    }
});

// POST /api/tracking/fulfillment-webhook
// Shopify Webhook for Order Fulfillment
router.post('/fulfillment-webhook', async (req, res) => {
    try {
        const payload = req.body;
        const clientId = req.query.clientId || 'delitech_smarthomes';
        
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

        res.status(200).send("Fulfillment processed, notification sent & review scheduled");
    } catch (err) {
        console.error("Fulfillment Webhook Error:", err.message);
        res.status(500).send("Server Error");
    }
});

module.exports = router;
