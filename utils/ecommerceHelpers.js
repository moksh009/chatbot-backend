const axios = require('axios');
const Order = require('../models/Order');
const { sendCODToPrepaidEmail } = require('./emailService');

/**
 * Sends a WhatsApp interactive message to COD customers, nudging them to pay via UPI for a reward.
 */
async function sendCODToPrepaidNudge(order, client, phone) {
    if (!phone) return;

    let paymentUrl = ""; 
    
    try {
        const cfConfig = client.nicheData?.paymentGateway?.cashfree || client.config?.cashfree || {};
        if (cfConfig.app_id && cfConfig.secret_key) {
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
                        customer_name: order.name || customerName || "Customer",
                        customer_email: order.email || "customer@example.com"
                    },
                    link_meta: {
                        return_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/cashfree-callback/${order._id}?link_id={link_id}`
                    }
                },
                {
                    headers: {
                        'x-client-id': cfConfig.app_id,
                        'x-client-secret': cfConfig.secret_key,
                        'x-api-version': '2023-08-01',
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data && response.data.link_url) {
                paymentUrl = response.data.link_url;
                await Order.findByIdAndUpdate(order._id, {
                    cashfreeLinkId: linkId,
                    cashfreeUrl: paymentUrl
                });
            }
        }
    } catch (err) {
        console.error("Cashfree link creation failed for order", order.orderId, err.response?.data || err.message);
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
                    footer: { text: client.name || "Smart Store" },
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

        // 📧 Also send COD nudge via email if available
        const customerEmail = order.email;
        if (customerEmail) {
            await sendCODToPrepaidEmail(client, {
                customerEmail,
                customerName: order.name || 'Customer',
                orderId: order.orderNumber || order.orderId,
                totalPrice: order.totalPrice,
                paymentLink: order.cashfreeUrl || null
            });
        }
    } catch (error) {
        console.error("WhatsApp COD Nudge Error:", error.response?.data || error.message);
    }
}

module.exports = {
    sendCODToPrepaidNudge
};
