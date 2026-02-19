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
    
    // Shopify sends phone in various formats, need to normalize
    let phone = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
    if (phone) phone = phone.replace(/\D/g, ''); // Remove non-digits
    if (phone && phone.length === 10) phone = '91' + phone; // Assume India if missing code

    const clientId = req.query.clientId || 'delitech_smarthomes';
    const amount = parseFloat(orderData.total_price);
    const orderId = orderData.name || `#${orderData.order_number}`;

    console.log(`📦 New Order Webhook: ${orderId} | Phone: ${phone}`);

    try {
        // 1. Save Order
        const Order = require('../models/Order');
        await Order.create({
            clientId,
            orderId,
            customerName: orderData.customer?.first_name + ' ' + orderData.customer?.last_name,
            phone,
            amount,
            status: 'paid',
            items: orderData.line_items?.map(item => ({
                name: item.title,
                quantity: item.quantity,
                price: parseFloat(item.price)
            })) || []
        });

        // 2. Update Lead if phone matches
        if (phone) {
            const lead = await AdLead.findOneAndUpdate(
                { phoneNumber: phone, clientId },
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
                    amount
                });
            }
        } else {
            // Emit anonymous order
            if (io) io.to(`client_${clientId}`).emit('stats_update', { type: 'new_order_anon', amount });
        }

        res.status(200).send('Webhook Received');

    } catch (e) {
        console.error("Order Webhook Error", e);
        res.status(500).send('Error');
    }
});

module.exports = router;
