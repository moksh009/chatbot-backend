const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');

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

// --- HELPER FUNCTION: Send COD Nudge ---
async function sendCODToPrepaidNudge(order, client, phone) {
    if (!phone) return;
    const Order = require('../models/Order');

    let paymentUrl = ""; // fallback to empty, user can ask for UPI manually
    
    try {
        const rzpConfig = client.config?.razorpay || {};
        if (rzpConfig.key_id && rzpConfig.key_secret) {
            const Razorpay = require("razorpay");
            const rzp = new Razorpay({
                key_id: rzpConfig.key_id,
                key_secret: rzpConfig.key_secret
            });
            
            const link = await rzp.paymentLink.create({
                amount: Math.round(order.totalPrice * 100), // in paise
                currency: "INR",
                description: `Order ${order.orderNumber || order.orderId} - Delitech Smart Home`,
                customer: { 
                    contact: `+${phone}`,
                    email: order.email || ""
                },
                notify: { sms: false, email: false, whatsapp: false },
                reminder_enable: false,
                notes: {
                    order_db_id: order._id.toString(),
                    shopify_order_id: order.shopifyOrderId
                },
                callback_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/payment-success/${order._id}`,
                callback_method: "get",
                expire_by: Math.floor(Date.now() / 1000) + (2 * 60 * 60) // 2 hours
            });
            
            paymentUrl = link.short_url;
            await Order.findByIdAndUpdate(order._id, { 
                razorpayLinkId: link.id,
                razorpayUrl: link.short_url 
            });
        }
    } catch (err) {
        console.error("Razorpay link creation failed for order", order.orderId, err.message);
    }

    // Send WhatsApp interactive message
    const itemName = order.items && order.items[0] ? order.items[0].name : "your product";
    
    const axios = require('axios');
    const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'interactive',
                interactive: {
                    type: "button",
                    header: {
                        type: "text",
                        text: "💳 Save on Your Order!"
                    },
                    body: {
                        text: `Hi! Your order ${order.orderId} for *${itemName}* (₹${order.totalPrice}) is confirmed as COD.\n\n🎁 Pay via UPI right now and get:\n✅ ₹50 cashback\n✅ Priority shipping\n\nOffer expires in 2 hours!`
                    },
                    footer: { text: "Delitech Smart Home" },
                    action: {
                        buttons: [
                            { 
                                type: "reply", 
                                reply: { id: `cod_pay_${order._id}`, title: "💳 Pay via UPI Now" }
                            },
                            { 
                                type: "reply", 
                                reply: { id: `cod_keep_${order._id}`, title: "Keep COD" }
                            }
                        ]
                    }
                }
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        await Order.findByIdAndUpdate(order._id, { codNudgeSentAt: new Date() });
    } catch (error) {
        console.error("WhatsApp COD Nudge Error:", error.response?.data || error.message);
    }
}

// GET /r/payment-success/:orderId (Callback for Razorpay)
router.get('/payment-success/:orderId', async (req, res) => {
    try {
        const Order = require('../models/Order');
        const DailyStat = require('../models/DailyStat');
        const Client = require('../models/Client');
        const axios = require('axios');
        
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).send("Order not found");

        const client = await Client.findOne({ clientId: order.clientId });
        if (!client) return res.status(404).send("Client not found");

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

        res.redirect(`https://delitechsmarthome.in`);
    } catch (err) {
        console.error("Payment callback error:", err);
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
        
        // The order ID might be under payload.order_id for fulfillment webhooks 
        // Or if it's an order update Webhook, it might be payload.id
        const shopifyOrderId = String(payload.order_id || payload.id);
        
        const order = await Order.findOne({ shopifyOrderId, clientId });
        if (!order) {
            return res.status(404).send("Order not found");
        }
        
        // Schedule review for 4 days later
        const scheduledDate = new Date();
        scheduledDate.setDate(scheduledDate.getDate() + 4);

        await ReviewRequest.findOneAndUpdate(
            { orderId: order._id, clientId },
            {
                clientId,
                phone: order.phone,
                orderId: order._id,
                orderNumber: order.orderNumber,
                productName: order.items && order.items.length > 0 ? order.items[0].name : "your Delitech product",
                status: "scheduled",
                scheduledFor: scheduledDate
            },
            { upsert: true, new: true }
        );

        res.status(200).send("Fulfillment processed, review scheduled");
    } catch (err) {
        console.error("Fulfillment Webhook Error:", err.message);
        res.status(500).send("Server Error");
    }
});

module.exports = router;
