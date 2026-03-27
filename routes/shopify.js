const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

async function registerWebhooks(shopDomain, accessToken, clientId) {
  const topics = ['checkouts/create', 'checkouts/update', 'orders/create'];
  const webhookUrl = `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/webhook`;

  for (const topic of topics) {
    try {
      await axios.post(
        `https://${shopDomain}/admin/api/2024-01/webhooks.json`,
        {
          webhook: {
            topic,
            address: webhookUrl,
            format: 'json'
          }
        },
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      console.log(`✅ Registered webhook ${topic} for ${clientId}`);
    } catch (err) {
      console.error(`❌ Failed to register webhook ${topic} for ${clientId}:`, err.response?.data || err.message);
    }
  }
}

// POST /api/shopify/:clientId/connect
router.post('/:clientId/connect', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { shopDomain, shopifyClientId, shopifyClientSecret } = req.body;

    if (!shopDomain || !shopifyClientId || !shopifyClientSecret) {
      return res.status(400).json({ success: false, message: 'Missing required credentials' });
    }

    const cleanShopDomain = shopDomain.replace('https://', '').replace('http://', '').split('/')[0];
    console.log(`🔄 Attempting Shopify token exchange for ${cleanShopDomain}...`);

    const response = await axios.post(`https://${cleanShopDomain}/admin/oauth/access_token`, {
      client_id: shopifyClientId,
      client_secret: shopifyClientSecret,
      grant_type: 'client_credentials'
    });

    const { access_token, scope } = response.data;
    if (!access_token) throw new Error('No access token received');

    await Client.findOneAndUpdate({ clientId }, { 
      $set: { shopifyAccessToken: access_token, shopifyClientId, shopifyClientSecret, shopDomain: cleanShopDomain } 
    });

    // ── NEW: Auto Register Webhooks ──
    await registerWebhooks(cleanShopDomain, access_token, clientId);

    res.json({ success: true, message: 'Shopify connected and webhooks registered!', scope });
  } catch (error) {
    console.error('❌ Shopify Connection Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to connect Shopify' });
  }
});

// POST /api/shopify/:clientId/sync-products
router.post('/:clientId/sync-products', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client?.shopifyAccessToken) return res.status(400).json({ error: 'Shopify not connected' });

    const response = await axios.get(
      `https://${client.shopDomain}/admin/api/2024-01/products.json?limit=50`,
      { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
    );

    const products = response.data.products.map(p => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      price: p.variants[0]?.price,
      image: p.image?.src,
      url: `https://${client.shopDomain}/products/${p.handle}`
    }));

    await Client.findOneAndUpdate(
      { clientId: client.clientId },
      { $set: { "nicheData.products": products } }
    );

    res.json({ success: true, count: products.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/shopify/:clientId/sync-orders
router.post('/:clientId/sync-orders', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client?.shopifyAccessToken) return res.status(400).json({ error: 'Shopify not connected' });

    const response = await axios.get(
      `https://${client.shopDomain}/admin/api/2024-01/orders.json?limit=50&status=any`,
      { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
    );

    const orders = response.data.orders;
    const Order = require('../models/Order');

    for (const data of orders) {
      const phone = data.phone || data.customer?.phone || data.billing_address?.phone;
      const cleanPhone = phone ? phone.replace(/\D/g, '').slice(-10) : '0000000000';

      await Order.findOneAndUpdate(
        { orderId: data.name || `#${data.id}`, clientId: client.clientId },
        {
          $set: {
            customerName: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}` : 'Shopify Customer',
            customerPhone: cleanPhone,
            amount: parseFloat(data.total_price),
            totalPrice: parseFloat(data.total_price),
            status: data.financial_status === 'paid' ? 'Paid' : 'Pending',
            items: data.line_items.map(item => ({
                name: item.title,
                quantity: item.quantity,
                price: parseFloat(item.price)
            })),
            address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
            createdAt: data.created_at
          }
        },
        { upsert: true }
      );
    }

    res.json({ success: true, count: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
