const Razorpay = require("razorpay");

/**
 * Creates a Razorpay payment link for COD-to-Prepaid conversion
 * @param {Object} order - Order document from MongoDB
 * @param {Object} client - Client document from MongoDB
 * @returns {Object} Razorpay payment link object
 */
async function createCODPaymentLink(order, client) {
  if (!client.razorpayKeyId || !client.razorpaySecret) {
    throw new Error(`[Razorpay] Client ${client.clientId} has no Razorpay keys configured`);
  }

  const amount = Math.round(parseFloat(order.totalPrice || order.amount || 0) * 100);
  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error(`[Razorpay] Invalid order amount: ${order.totalPrice}`);
  }

  const rzp = new Razorpay({
    key_id: client.razorpayKeyId,
    key_secret: client.razorpaySecret
  });

  const baseUrl = process.env.BASE_URL || process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
  const expiryTimestamp = Math.floor(Date.now() / 1000) + (2 * 60 * 60); // 2 hours

  const link = await rzp.paymentLink.create({
    amount,
    currency: "INR",
    description: `Order ${order.orderNumber || order._id} - ${client.businessName || client.name || 'Store'}`,
    customer: {
      contact: `+91${order.phone || order.customerPhone || ''}`.replace('+91+91', '+91'), // Guard against double prefix
      email: order.email || order.customerEmail || ""
    },
    notify: { sms: false, email: false, whatsapp: false },
    reminder_enable: false,
    notes: {
      order_db_id: order._id.toString(),
      client_id: client._id.toString(),
      shopify_order_id: order.shopifyOrderId || ""
    },
    callback_url: `${baseUrl}/api/payment/success/${order._id}`,
    callback_method: "get",
    expire_by: expiryTimestamp
  });

  return link;
}

module.exports = { createCODPaymentLink };
