const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { getShopifyClient, exchangeShopifyToken } = require('../utils/shopifyHelper');

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
    const shop = await getShopifyClient(req.params.clientId);
    const client = await Client.findOne({ clientId: req.params.clientId });

    const response = await shop.get('/products.json?limit=50');

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
    const shop = await getShopifyClient(req.params.clientId);
    const client = await Client.findOne({ clientId: req.params.clientId });

    const response = await shop.get('/orders.json?limit=50&status=any');

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

// GET /api/shopify/:clientId/payouts — Feature 4: Revenue & Payout Dashboard
router.get('/:clientId/payouts', protect, verifyClientAccess, async (req, res) => {
  try {
    const shop = await getShopifyClient(req.params.clientId);
    const response = await shop.get('/shopify_payments/payouts.json?limit=5');
    res.json({ success: true, payouts: response.data.payouts || [] });
  } catch (err) {
    // Shopify Payments may not be available on all accounts
    res.json({ success: true, payouts: [], note: 'Shopify Payments not enabled or not applicable for this store.' });
  }
});

// POST /api/shopify/:clientId/create-checkout — Feature 1: WhatsApp-Native Checkout
router.post('/:clientId/create-checkout', protect, verifyClientAccess, async (req, res) => {
  try {
    const shop = await getShopifyClient(req.params.clientId);
    const { variantId, quantity = 1, customerPhone, customerEmail, customerName } = req.body;
    if (!variantId) return res.status(400).json({ error: 'variantId is required' });

    const checkoutPayload = {
      checkout: {
        line_items: [{ variant_id: variantId, quantity }],
        ...(customerPhone && { phone: customerPhone }),
        ...(customerEmail && { email: customerEmail }),
      }
    };

    const response = await shop.post('/checkouts.json', checkoutPayload);
    const checkout = response.data.checkout;
    res.json({ success: true, checkoutUrl: checkout.web_url, token: checkout.token });
  } catch (err) {
    console.error('❌ Create Checkout Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/shopify/:clientId/create-discount-code — Feature 2: Dynamic Discount Codes
router.post('/:clientId/create-discount-code', protect, verifyClientAccess, async (req, res) => {
  try {
    const shop = await getShopifyClient(req.params.clientId);
    const { discountPercent = 10, customerPhone } = req.body;
    const codeSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const code = `COMEBACK-${codeSuffix}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h expiry

    // Step 1: Create Price Rule
    const priceRuleRes = await shop.post('/price_rules.json', {
      price_rule: {
        title: code,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'percentage',
        value: `-${discountPercent}`,
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
        ends_at: expiresAt,
        usage_limit: 1,
        once_per_customer: true
      }
    });
    const priceRuleId = priceRuleRes.data.price_rule.id;

    // Step 2: Create Discount Code under the Price Rule
    await shop.post(`/price_rules/${priceRuleId}/discount_codes.json`, { discount_code: { code } });

    res.json({ success: true, code, discountPercent, expiresAt });
  } catch (err) {
    console.error('❌ Create Discount Code Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
