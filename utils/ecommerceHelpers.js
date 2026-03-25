const axios = require('axios');
const Razorpay = require('razorpay');
const Order = require('../models/Order');

/**
 * Sends a WhatsApp interactive message to COD customers, nudging them to pay via UPI for a reward.
 */
async function sendCODToPrepaidNudge(order, client, phone) {
    if (!phone) return;

    let paymentUrl = ""; 
    
    try {
        const rzpConfig = client.config?.razorpay || {};
        if (rzpConfig.key_id && rzpConfig.key_secret) {
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

module.exports = {
    sendCODToPrepaidNudge
};
