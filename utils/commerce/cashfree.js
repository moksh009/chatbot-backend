const axios = require('axios');

/**
 * Creates a Cashfree payment link for COD-to-Prepaid conversion
 * @param {Object} order - Order document from MongoDB
 * @param {Object} client - Client document from MongoDB
 * @returns {Object} Cashfree payment link object containing 'short_url'
 */
async function createCashfreePaymentLink(order, client) {
  if (!client.cashfreeAppId || !client.cashfreeSecretKey) {
    throw new Error(`[Cashfree] Client ${client.clientId} has no Cashfree keys configured`);
  }

  const amount = parseFloat(order.totalPrice || order.amount || 0);
  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error(`[Cashfree] Invalid order amount: ${order.totalPrice}`);
  }

  const baseUrl = process.env.BASE_URL || process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com';
  // Use v3 API for Cashfree payment links
  const cashfreeEndpoint = 'https://sandbox.cashfree.com/pg/links'; // Will default to sandbox for safety if not overridden. Can be configured to PROD below.
  const isProd = process.env.NODE_ENV === 'production' && !client.cashfreeAppId.includes('test');
  const apiUrl = isProd ? 'https://api.cashfree.com/pg/links' : 'https://sandbox.cashfree.com/pg/links';

  const expiryDate = new Date(Date.now() + (2 * 60 * 60 * 1000)); // 2 hours

  const payload = {
    link_id: `cod_conv_${order._id.toString()}_${Date.now()}`,
    link_amount: amount,
    link_currency: "INR",
    link_purpose: `Order ${order.orderNumber || order._id} - ${client.businessName || 'Store'}`,
    customer_details: {
      customer_phone: `+91${order.phone || order.customerPhone || ''}`.replace('+91+91', '+91').replace(/\+/g, ""), 
      customer_email: order.email || order.customerEmail || "customer@example.com",
      customer_name: order.customerName || "Customer"
    },
    link_notify: {
      send_sms: false,
      send_email: false
    },
    link_meta: {
      return_url: `${baseUrl}/api/payment/success/${order._id}?cf_id={link_id}`,
      notify_url: `${baseUrl}/api/payment/webhook/cashfree`,
      notes: {
        order_db_id: order._id.toString(),
        client_id: client._id.toString(),
        shopify_order_id: String(order.shopifyOrderId) || ""
      }
    },
    link_expiry_time: expiryDate.toISOString()
  };

  try {
    const res = await axios.post(apiUrl, payload, {
      headers: {
        'x-client-id': client.cashfreeAppId,
        'x-client-secret': client.cashfreeSecretKey,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    return {
      short_url: res.data.link_url,
      id: res.data.link_id,
      ...res.data
    };
  } catch (err) {
    throw new Error(`[Cashfree] API Error: ${err.response?.data?.message || err.message}`);
  }
}

module.exports = { createCashfreePaymentLink };
