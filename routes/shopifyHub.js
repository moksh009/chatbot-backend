const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { addHours } = require('date-fns');

// Helper to create Shopify Client
const shopifyClient = (client) => {
  return axios.create({
    baseURL: `https://${client.shopDomain}/admin/api/2024-01`,
    headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }
  });
};

/**
 * @route   GET /api/shopify-hub/:clientId/pulse
 * @desc    Get store overview (Revenue, Orders, Payouts)
 */
router.get('/:clientId/pulse', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client?.shopifyAccessToken) return res.status(400).json({ error: 'Shopify not connected' });

    const shop = shopifyClient(client);
    
    // Fetch last 30 days of orders
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const [ordersRes, payoutsRes] = await Promise.all([
      shop.get(`/orders.json?status=any&created_at_min=${thirtyDaysAgo.toISOString()}&limit=250`),
      shop.get('/shopify_payments/payouts.json?limit=5').catch(() => ({ data: { payouts: [] } }))
    ]);

    const orders = ordersRes.data.orders;
    const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
    const aov = orders.length ? (revenue / orders.length) : 0;
    
    res.json({
      success: true,
      stats: {
        revenue,
        orderCount: orders.length,
        aov,
        pendingFulfillment: orders.filter(o => !o.fulfillment_status).length,
      },
      payouts: payoutsRes.data.payouts
    });
  } catch (err) {
    console.error('Pulse Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/products
 * @desc    Get all Shopify products with "in bot" status
 */
router.get('/:clientId/products', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    
    // Return empty products if Shopify not connected instead of crashing
    if (!client?.shopifyAccessToken || !client?.shopDomain) {
      return res.json({ success: true, products: [], message: 'Shopify not connected' });
    }

    const shop = shopifyClient(client);
    
    const response = await shop.get('/products.json?limit=100&fields=id,title,variants,images,status,handle');
    const shopifyProducts = response.data.products;
    
    const botProducts = client.nicheData?.products || [];
    const botProductIds = new Set(botProducts.map(p => String(p.id)));

    const products = shopifyProducts.map(p => ({
      ...p,
      isWhatsAppReady: botProductIds.has(String(p.id)),
      inventory: p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0)
    }));

    res.json({ success: true, products });
  } catch (err) {
    console.error('Shopify products error:', err.response?.data || err.message);
    // Return empty instead of 500 so UI doesn't break
    res.json({ success: true, products: [], error: err.message });
  }
});

/**
 * @route   PUT /api/shopify-hub/:clientId/products/:productId/price
 * @desc    Update product price in Shopify
 */
router.put('/:clientId/products/:productId/price', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    const { variantId, price } = req.body;
    const shop = shopifyClient(client);

    await shop.put(`/variants/${variantId}.json`, {
      variant: { id: variantId, price }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/shopify-hub/:clientId/discounts
 * @desc    Create a real Shopify discount code
 */
router.post('/:clientId/discounts', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    const { title, type, value, expiryHours = 24, prefix = 'TOPAI' } = req.body;
    const shop = shopifyClient(client);

    const priceRuleRes = await shop.post('/price_rules.json', {
      price_rule: {
        title: title || `${prefix}-${Date.now()}`,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: type === 'percentage' ? 'percentage' : 'fixed_amount',
        value: `-${value}`,
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
        ends_at: addHours(new Date(), expiryHours).toISOString(),
        usage_limit: 1
      }
    });

    const priceRuleId = priceRuleRes.data.price_rule.id;
    const code = `${prefix}-${Math.random().toString(36).substring(7).toUpperCase()}`;

    const discountRes = await shop.post(`/price_rules/${priceRuleId}/discount_codes.json`, {
      discount_code: { code }
    });

    res.json({ success: true, discount: discountRes.data.discount_code });
  } catch (err) {
    console.error('Discount Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/settings
 * @desc    Get ecommerce settings (automations, nicheData)
 */
router.get('/:clientId/settings', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    
    res.json({
      success: true,
      automationFlows: client.automationFlows || [],
      nicheData: client.nicheData || {},
      syncedMetaTemplates: client.syncedMetaTemplates || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   PATCH /api/shopify-hub/:clientId/settings
 * @desc    Update ecommerce settings
 */
router.patch('/:clientId/settings', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    
    const { automationFlows, nicheData } = req.body;
    
    if (automationFlows) client.automationFlows = automationFlows;
    if (nicheData) client.nicheData = { ...client.nicheData, ...nicheData };
    
    await client.save();
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
