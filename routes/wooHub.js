const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { protect, verifyClientAccess } = require('../middleware/auth');

/**
 * @route   GET /api/woo-hub/ping
 * @desc    Health check for WooCommerce Hub routes
 */
router.get('/ping', (req, res) => res.json({ success: true, message: 'WooCommerce Hub Router is active' }));

/**
 * @route   GET /api/woo-hub/:clientId/pulse
 * @desc    Get store overview for WooCommerce
 */
router.get('/:clientId/pulse', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
    const client = await Client.findOne({ clientId });
    if (!client || !client.woocommerceKey || !client.woocommerceSecret || !client.woocommerceUrl) {
      return res.status(200).json({ success: false, isWooConnected: false, error: 'WooCommerce credentials incomplete' });
    }

    const auth = Buffer.from(`${client.woocommerceKey}:${client.woocommerceSecret}`).toString('base64');
    const baseUrl = client.woocommerceUrl.replace(/\/$/, '') + '/wp-json/wc/v3';

    // Fetch last 30 days of orders
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const ordersRes = await axios.get(`${baseUrl}/orders?after=${thirtyDaysAgo.toISOString()}&per_page=100`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    
    const orders = ordersRes.data || [];
    const revenue = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    const aov = orders.length ? (revenue / orders.length) : 0;

    res.json({
      success: true,
      stats: {
        revenue,
        orderCount: orders.length,
        aov,
        pendingFulfillment: orders.filter(o => o.status === 'processing' || o.status === 'on-hold').length
      },
      shopDomain: client.woocommerceUrl,
      wooConnectionStatus: 'connected'
    });
  } catch (err) {
    console.error(`[Woo Pulse Error] Client: ${clientId}:`, err.message);
    res.status(500).json({ success: false, error: `WooCommerce Sync Error: ${err.message}` });
  }
});

/**
 * @route   GET /api/woo-hub/:clientId/products
 * @desc    Get all WooCommerce products
 */
router.get('/:clientId/products', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const auth = Buffer.from(`${client.woocommerceKey}:${client.woocommerceSecret}`).toString('base64');
    const baseUrl = client.woocommerceUrl.replace(/\/$/, '') + '/wp-json/wc/v3';

    const response = await axios.get(`${baseUrl}/products?per_page=100`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    
    const wooProducts = response.data || [];
    const botProducts = client.nicheData?.products || [];
    const botProductIds = new Set(botProducts.map(p => String(p.id)));

    const products = wooProducts.map(p => ({
      id: p.id,
      title: p.name,
      status: p.status,
      handle: p.slug,
      images: p.images.map(img => ({ src: img.src })),
      variants: p.variations.length > 0 ? [{ id: p.id, price: p.price, title: 'Default' }] : [{ id: p.id, price: p.price, title: 'Default' }],
      isWhatsAppReady: botProductIds.has(String(p.id)),
      inventory: p.stock_quantity || 0
    }));

    res.json({ success: true, products, shopDomain: client.woocommerceUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/woo-hub/:clientId/pixel-setup
 * @desc    Get the manual & automated setup instructions for WooCommerce Pixel
 */
router.get('/:clientId/pixel-setup', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  const pixelUrl = `${protocol}://${host}/api/woo-pixel/${clientId}/script.js`;

  const manualScript = `<script src="${pixelUrl}" async></script>`;
  
  const automatedInstructions = `
    1. Login to your WordPress Admin.
    2. Go to Appearance > Theme File Editor.
    3. Find footer.php.
    4. Paste the following line before the </body> tag:
       ${manualScript}
  `;

  res.json({
    success: true,
    pixelUrl,
    manualScript,
    automatedInstructions,
    pluginSuggestion: "Or use a plugin like 'Insert Headers and Footers' to add the script to your site."
  });
});

module.exports = router;
