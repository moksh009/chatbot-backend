const axios = require('axios');
const Order = require('../models/Order');
const { sendCODToPrepaidEmail } = require('./emailService');
const { trackEcommerceEvent } = require('./analyticsHelper');
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
                    await Order.findByIdAndUpdate(order._id, { 
                        razorpayLinkId: link.id, 
                        razorpayUrl: paymentUrl,
                        gatewayPaymentId: link.id,
                        gatewayPaymentUrl: paymentUrl
                    });
                }
            }
        }
        // --- BRANCH C: STRIPE ---
        else if (gateway === 'stripe') {
            const stripeSecret = client.stripeSecretKey;
            if (stripeSecret) {
                // Using axios for Stripe to avoid extra SDK dependency
                const params = new URLSearchParams();
                params.append('line_items[0][price_data][currency]', 'inr');
                params.append('line_items[0][price_data][product_data][name]', `Order ${order.orderNumber || order.orderId}`);
                params.append('line_items[0][price_data][unit_amount]', Math.round(order.totalPrice * 100));
                params.append('line_items[0][quantity]', '1');
                params.append('mode', 'payment');
                params.append('success_url', `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/stripe-callback/${order._id}?session_id={CHECKOUT_SESSION_ID}`);
                params.append('cancel_url', `https://${client.shopDomain || 'store'}/cart`);

                const response = await axios.post('https://api.stripe.com/v1/checkout/sessions', params, {
                    headers: {
                        'Authorization': `Bearer ${stripeSecret}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });

                if (response.data && response.data.url) {
                    paymentUrl = response.data.url;
                    log.success(`Stripe checkout URL created: ${paymentUrl}`);
                    await Order.findByIdAndUpdate(order._id, { 
                        stripeLinkId: response.data.id, 
                        stripeUrl: paymentUrl,
                        gatewayPaymentId: response.data.id,
                        gatewayPaymentUrl: paymentUrl
                    });
                }
            }
        }
        // --- BRANCH D: PAYU ---
        else if (gateway === 'payu') {
            const key = client.payuMerchantKey;
            const salt = client.payuMerchantSalt;
            if (key && salt) {
                const crypto = require('crypto');
                const txnid = `PAYU_${order._id}_${Date.now()}`;
                const amount = order.totalPrice.toFixed(2);
                const productinfo = `Order ${order.orderNumber || order.orderId}`;
                const firstname = order.customerName || "Customer";
                const email = order.customerEmail || "customer@example.com";
                
                // key|txnid|amount|productinfo|firstname|email|||||||||||salt
                const hashString = `${key}|${txnid}|${amount}|${productinfo}|${firstname}|email|||||||||||${salt}`;
                const hash = crypto.createHash('sha512').update(hashString).digest('hex');

                // Note: PayU usually requires a form redirect, but they have a Link API as well.
                // For simplicity in a bot, we'll suggest using their Link API or a hosted session if available.
                // Here we'll implement a placeholder logic that would match their API Link creation if possible via axios.
                log.info("PayU Link API initiated (v1 logic)...");
                // (Detailed PayU Link API implementation would go here)
            }
        }
        // --- BRANCH E: PHONEPE ---
        else if (gateway === 'phonepe') {
            const merchantId = client.phonepeMerchantId;
            const saltKey = client.phonepeSaltKey;
            const saltIndex = client.phonepeSaltIndex || '1';

            if (merchantId && saltKey) {
                const crypto = require('crypto');
                const payload = {
                    merchantId,
                    merchantTransactionId: `T${Date.now()}`,
                    merchantUserId: `U${order._id}`,
                    amount: Math.round(order.totalPrice * 100),
                    redirectUrl: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/phonepe-callback/${order._id}`,
                    redirectMode: 'POST',
                    callbackUrl: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/payment/phonepe/webhook`,
                    paymentInstrument: { type: 'PAY_PAGE' }
                };

                const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
                const stringToHash = base64Payload + "/pg/v1/pay" + saltKey;
                const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
                const checksum = sha256 + "###" + saltIndex;

                const response = await axios.post('https://api.phonepe.com/apis/hermes/pg/v1/pay', 
                    { request: base64Payload },
                    { headers: { 'X-VERIFY': checksum, 'Content-Type': 'application/json' } }
                );

                if (response.data && response.data.data && response.data.data.instrumentResponse.redirectInfo.url) {
                    paymentUrl = response.data.data.instrumentResponse.redirectInfo.url;
                    log.success(`PhonePe payment URL created: ${paymentUrl}`);
                    await Order.findByIdAndUpdate(order._id, { 
                        gatewayPaymentId: response.data.data.merchantTransactionId, 
                        gatewayPaymentUrl: paymentUrl 
                    });
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
        const nd = client.nicheData || {};
        const bodyText = (nd.codMsg || "Hi {name}, convert your COD order for {item} to Prepaid and get an extra discount!")
            .replace(/{name}/g, order.customerName || order.name || 'Customer')
            .replace(/{order_id}/g, order.orderNumber || order.orderId)
            .replace(/{total}/g, order.totalPrice)
            .replace(/{item}/g, itemName);

        const buttons = [
            { type: "reply", reply: { id: `cod_pay_${order._id}`, title: (nd.codMsg_btn1 || "💳 Pay via UPI").substring(0, 20) } },
            { type: "reply", reply: { id: `cod_keep_${order._id}`, title: (nd.codMsg_btn2 || "Keep COD").substring(0, 20) } }
        ];
        
        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    header: { type: 'text', text: "💳 Save on Your Order!" },
                    body: { text: bodyText },
                    footer: { text: client.name || "Smart Store" },
                    action: { buttons: buttons }
                }
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        log.success(`COD WhatsApp nudge sent | order: ${order.orderId} | phone: ${phone}`);
        await Order.findByIdAndUpdate(order._id, { codNudgeSentAt: new Date() });
        await trackEcommerceEvent(client.clientId, { codNudgesSent: 1 });

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
