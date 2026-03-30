const axios = require('axios');
const Order = require('../models/Order');
const { sendCODToPrepaidEmail } = require('./emailService');
const log = require('./logger')('EcommerceHelpers');

/**
 * Sends a WhatsApp interactive message to COD customers, nudging them to pay via UPI for a reward.
 */
async function sendCODToPrepaidNudge(order, client, phone) {
    if (!phone) {
        log.warn(`COD nudge skipped — no phone for order: ${order.orderId || order._id}`);
        return;
    }
    log.info(`COD nudge dispatching | order: ${order.orderId} | phone: ${phone} | gateway: ${client.activePaymentGateway}`);
    
    let paymentUrl = ""; 
    const gateway = client.activePaymentGateway || 'none';

    try {
        // --- BRANCH A: CASHFREE ---
        if (gateway === 'cashfree') {
            const appId = client.cashfreeAppId || client.config?.cashfree?.app_id;
            const secretKey = client.cashfreeSecretKey || client.config?.cashfree?.secret_key;

            if (appId && secretKey) {
                const linkId = `cf_link_${order._id}_${Date.now()}`;
                const response = await axios.post(
                    'https://api.cashfree.com/pg/links',
                    {
                        link_id: linkId,
                        link_amount: order.totalPrice,
                        link_currency: "INR",
                        link_purpose: `Order ${order.orderNumber || order.orderId}`,
                        customer_details: {
                            customer_phone: phone,
                            customer_name: order.customerName || order.name || "Customer",
                            customer_email: order.customerEmail || order.email || "customer@example.com"
                        },
                        link_meta: {
                            return_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/cashfree-callback/${order._id}?link_id={link_id}`
                        }
                    },
                    {
                        headers: {
                            'x-client-id': appId,
                            'x-client-secret': secretKey,
                            'x-api-version': '2023-08-01',
                            'Content-Type': 'application/json'
                        }
                    }
                );

                if (response.data && response.data.link_url) {
                    paymentUrl = response.data.link_url;
                    log.success(`Cashfree payment link created: ${paymentUrl}`);
                    await Order.findByIdAndUpdate(order._id, { cashfreeLinkId: linkId, cashfreeUrl: paymentUrl });
                }
            }
        } 
        // --- BRANCH B: RAZORPAY ---
        else if (gateway === 'razorpay') {
            const rzpKey = client.razorpayKeyId;
            const rzpSecret = client.razorpaySecret;

            if (rzpKey && rzpSecret) {
                const Razorpay = require('razorpay');
                const rzp = new Razorpay({ key_id: rzpKey, key_secret: rzpSecret });
                
                const link = await rzp.paymentLink.create({
                    amount: order.totalPrice * 100, // Razorpay uses paise
                    currency: "INR",
                    accept_partial: false,
                    description: `Payment for Order ${order.orderNumber || order.orderId}`,
                    customer: {
                        name: order.customerName || "Customer",
                        contact: phone,
                        email: order.email || "customer@example.com"
                    },
                    notify: { sms: false, email: false },
                    reminder_enable: true,
                    callback_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/razorpay-callback/${order._id}`,
                    callback_method: 'get'
                });

                if (link && link.short_url) {
                    paymentUrl = link.short_url;
                    log.success(`Razorpay payment link created: ${paymentUrl}`);
                    await Order.findByIdAndUpdate(order._id, { razorpayLinkId: link.id, razorpayUrl: paymentUrl });
                }
            }
        }
    } catch (err) {
        log.error(`${gateway} link creation failed | order: ${order.orderId}`, { error: err.response?.data || err.message });
    }

    // Send WhatsApp interactive message
    const itemName = order.items && order.items[0] ? order.items[0].name : "your product";
    
    // Choose the best available token/phoneId
    const token = client.whatsappToken || client.config?.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneId = client.phoneNumberId || client.config?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    try {
        const buttons = [
            { 
                type: "reply", 
                reply: { id: `cod_pay_${order._id}`, title: "💳 Pay via UPI Now" }
            },
            { 
                type: "reply", 
                reply: { id: `cod_keep_${order._id}`, title: "Keep COD" }
            }
        ];

        // If we successfully generated a payment link, we can use a URL button if preferred, 
        // but keeping current button flow for consistency in tracking.
        
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
                    footer: { text: client.name || "Smart Store" },
                    action: { buttons }
                }
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        log.success(`COD WhatsApp nudge sent | order: ${order.orderId} | phone: ${phone}`);
        await Order.findByIdAndUpdate(order._id, { codNudgeSentAt: new Date() });

        // 📧 Also send COD nudge via email if available
        const customerEmail = order.customerEmail || order.email;
        if (customerEmail) {
            await sendCODToPrepaidEmail(client, {
                customerEmail,
                customerName: order.name || 'Customer',
                orderId: order.orderNumber || order.orderId,
                totalPrice: order.totalPrice,
                paymentLink: paymentUrl || null
            });
        }
    } catch (error) {
        log.error(`COD nudge failed | order: ${order?.orderId}`, { error: error.response?.data || error.message });
    }
}

module.exports = {
    sendCODToPrepaidNudge
};
