const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { getShopifyClient, withShopifyRetry, exchangeShopifyToken } = require('../utils/shopifyHelper');

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

    const clientUpdate = await exchangeShopifyToken(clientId, cleanShopDomain, shopifyClientId, shopifyClientSecret);
    const access_token = clientUpdate.shopifyAccessToken;
    const scope = clientUpdate.shopifyScopes;

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
    const { clientId } = req.params;
    const products = await withShopifyRetry(clientId, async (shop) => {
        const client = await Client.findOne({ clientId });
        const response = await shop.get('/products.json?limit=50');
        
        return response.data.products.map(p => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          price: p.variants[0]?.price,
          image: p.image?.src,
          url: `https://${client.shopDomain}/products/${p.handle}`
        }));
    });

    await Client.findOneAndUpdate(
      { clientId },
      { $set: { "nicheData.products": products } }
    );

    res.json({ success: true, count: products.length });
  } catch (err) {
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    res.status(isAuthError ? 400 : 500).json({ success: false, error: err.message, isShopifyAuthError: isAuthError });
  }
});

// POST /api/shopify/:clientId/sync-orders
router.post('/:clientId/sync-orders', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    await withShopifyRetry(clientId, async (shop) => {
        const client = await Client.findOne({ clientId });
        const response = await shop.get('/orders.json?limit=50&status=any');
        const orders = response.data.orders;
        const Order = require('../models/Order');

        for (const data of orders) {
          const phone = data.phone || data.customer?.phone || data.billing_address?.phone;
          const cleanPhone = phone ? phone.replace(/\D/g, '').slice(-10) : '0000000000';

          await Order.findOneAndUpdate(
            { orderId: data.name || `#${data.id}`, clientId },
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
        return orders.length;
    });

    res.json({ success: true, message: 'Sync complete' });
  } catch (err) {
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    res.status(isAuthError ? 400 : 500).json({ success: false, error: err.message, isShopifyAuthError: isAuthError });
  }
});

// GET /api/shopify/:clientId/payouts
router.get('/:clientId/payouts', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const payouts = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/shopify_payments/payouts.json?limit=5');
        return response.data.payouts || [];
    });
    res.json({ success: true, payouts });
  } catch (err) {
    res.json({ success: true, payouts: [], note: 'Shopify Payments not enabled or not applicable.' });
  }
});

module.exports = router;
