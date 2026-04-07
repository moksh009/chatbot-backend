const axios = require('axios');
const logger = require('./logger');

/**
 * Generate a Razorpay Payment Link for an order.
 * @param {Object} client - Client model with razorpay keys
 * @param {Object} lead - AdLead model for customer info
 * @param {Object} order - Order model/object
 */
async function generatePaymentLink(client, lead, order) {
  try {
    const keyId     = client.paymentConfig?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
    const keySecret = client.paymentConfig?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new Error("Razorpay credentials missing");
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    
    // Convert amount to paisa (multiplied by 100)
    const amountPaisa = Math.round((order.totalPrice || order.amount) * 100);

    const payload = {
      amount:           amountPaisa,
      currency:         "INR",
      accept_partial:   false,
      first_payment_min_amount: 0,
      expire_by:        Math.floor(Date.now() / 1000) + 1800, // 30 min expiry
      reference_id:     `pay_${order._id}_${Date.now()}`,
      description:      `Payment for Order #${order.orderNumber || order._id}`,
      customer: {
        name:           lead.name || "Customer",
        email:          lead.email || "",
        contact:        lead.phoneNumber
      },
      notify: {
        sms:            false,
        email:          false
      },
      reminder_enable:  false,
      notes: {
        orderId:        String(order._id),
        clientId:       String(client._id)
      },
      callback_url:     `https://dash.topedgeai.com/payment-success?oid=${order._id}`,
      callback_method:  "get"
    };

    const { data } = await axios.post(
      "https://api.razorpay.com/v1/payment_links",
      payload,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    return data.short_url;
  } catch (err) {
    logger.error("[PaymentLinkGen] Error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { generatePaymentLink };
