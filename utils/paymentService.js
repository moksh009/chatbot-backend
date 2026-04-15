"use strict";

const axios = require('axios');
const log = require('./logger')('PaymentService');

/**
 * PAYMENT SERVICE
 * Unified interface for generating payment links across multiple gateways.
 * Supported: Razorpay, Cashfree, Stripe, PayU, PhonePe.
 */

async function createPaymentLink(client, orderData, customerData) {
    const gateway = client.activePaymentGateway || 'none';
    const amount = orderData.amount; // Should be in base currency (e.g. INR)
    const phone = customerData.phone;
    const name = customerData.name || "Customer";
    const email = customerData.email || "customer@example.com";
    const orderId = orderData.orderId;
    const description = orderData.description || `Payment for Order ${orderId}`;

    log.info(`Creating payment link | Gateway: ${gateway} | Order: ${orderId} | Amount: ${amount}`);

    try {
        switch (gateway) {
            case 'razorpay':
                return await createRazorpayLink(client, amount, orderId, name, phone, email, description);
            case 'cashfree':
                return await createCashfreeLink(client, amount, orderId, name, phone, email, description);
            case 'stripe':
                return await createStripeLink(client, amount, orderId, name, phone, email, description);
            case 'phonepe':
                return await createPhonePeLink(client, amount, orderId, name, phone, email, description);
            case 'payu':
                return await createPayULink(client, amount, orderId, name, phone, email, description);
            default:
                throw new Error(`Unsupported or inactive payment gateway: ${gateway}`);
        }
    } catch (error) {
        log.error(`Payment link creation failed for ${gateway}`, { error: error.message });
        throw error;
    }
}

async function createRazorpayLink(client, amount, orderId, name, phone, email, description) {
    const rzpKey = client.razorpayKeyId;
    const rzpSecret = client.razorpaySecret;
    if (!rzpKey || !rzpSecret) throw new Error("Razorpay credentials missing");

    const Razorpay = require('razorpay');
    const rzp = new Razorpay({ key_id: rzpKey, key_secret: rzpSecret });

    const link = await rzp.paymentLink.create({
        amount: Math.round(amount * 100), // paise
        currency: "INR",
        accept_partial: false,
        description,
        customer: { name, contact: phone, email },
        notify: { sms: false, email: false },
        callback_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/razorpay-callback/${orderId}`,
        callback_method: 'get'
    });

    return { 
        url: link.short_url, 
        id: link.id, 
        gateway: 'razorpay' 
    };
}

async function createCashfreeLink(client, amount, orderId, name, phone, email, description) {
    const appId = client.cashfreeAppId || client.config?.cashfree?.app_id;
    const secretKey = client.cashfreeSecretKey || client.config?.cashfree?.secret_key;
    if (!appId || !secretKey) throw new Error("Cashfree credentials missing");

    const linkId = `link_${orderId}_${Date.now()}`;
    const response = await axios.post(
        'https://api.cashfree.com/pg/links',
        {
            link_id: linkId,
            link_amount: amount,
            link_currency: "INR",
            link_purpose: description,
            customer_details: {
                customer_phone: phone,
                customer_name: name,
                customer_email: email
            },
            link_meta: {
                return_url: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/cashfree-callback/${orderId}?link_id={link_id}`
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

    return { 
        url: response.data.link_url, 
        id: linkId, 
        gateway: 'cashfree' 
    };
}

async function createStripeLink(client, amount, orderId, name, phone, email, description) {
    const stripeSecret = client.stripeSecretKey;
    if (!stripeSecret) throw new Error("Stripe credentials missing");

    const params = new URLSearchParams();
    params.append('line_items[0][price_data][currency]', 'inr');
    params.append('line_items[0][price_data][product_data][name]', description);
    params.append('line_items[0][price_data][unit_amount]', Math.round(amount * 100));
    params.append('line_items[0][quantity]', '1');
    params.append('mode', 'payment');
    params.append('success_url', `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/stripe-callback/${orderId}?session_id={CHECKOUT_SESSION_ID}`);

    const response = await axios.post('https://api.stripe.com/v1/checkout/sessions', params, {
        headers: {
            'Authorization': `Bearer ${stripeSecret}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    return { 
        url: response.data.url, 
        id: response.data.id, 
        gateway: 'stripe' 
    };
}

async function createPhonePeLink(client, amount, orderId, name, phone, email, description) {
    const merchantId = client.phonepeMerchantId;
    const saltKey = client.phonepeSaltKey;
    const saltIndex = client.phonepeSaltIndex || '1';
    if (!merchantId || !saltKey) throw new Error("PhonePe credentials missing");

    const crypto = require('crypto');
    const transactionId = `T${Date.now()}`;
    const payload = {
        merchantId,
        merchantTransactionId: transactionId,
        merchantUserId: `U${orderId}`,
        amount: Math.round(amount * 100),
        redirectUrl: `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/r/phonepe-callback/${orderId}`,
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

    return { 
        url: response.data.data.instrumentResponse.redirectInfo.url, 
        id: transactionId, 
        gateway: 'phonepe' 
    };
}

async function createPayULink(client, amount, orderId, name, phone, email, description) {
    // PayU implementation usually requires more environment-specific hashing
    // Here we'll implement a robust placeholder or point to a custom PayU utility
    throw new Error("PayU Link generation currently requires manual redirect configuration.");
}

module.exports = { createPaymentLink };
