const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { addHours } = require('date-fns');

const { getShopifyClient, withShopifyRetry } = require('../utils/shopifyHelper');

/**
 * @route   GET /api/shopify-hub/ping
 * @desc    Health check for Shopify Hub routes
 */
router.get('/ping', (req, res) => res.json({ success: true, message: 'Shopify Hub Router is active' }));

/**
 * @route   GET /api/shopify-hub/:clientId/pulse
 * @desc    Get store overview (Revenue, Orders, Payouts)
 */
router.get('/:clientId/pulse', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const result = await withShopifyRetry(clientId, async (shop) => {
        // Fetch last 30 days of orders
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const ordersRes = await shop.get(`/orders.json?status=any&created_at_min=${thirtyDaysAgo.toISOString()}&limit=250`);
        const orders = ordersRes.data?.orders || [];

        // AUTOMATIC SYNC: If no orders found in our DB but Shopify has some, trigger background sync
        const internalOrderCount = await Order.countDocuments({ clientId });
        if (internalOrderCount === 0 && orders.length > 0) {
            console.log(`[ShopifyHub] Auto-sync triggered for ${clientId} (0 local orders found)`);
            const protocol = req.secure ? 'https' : 'http';
            const host = req.get('host');
            axios.post(`${protocol}://${host}/api/shopify/${clientId}/sync-orders`, {}, {
                headers: { Authorization: req.headers.authorization }
            }).catch(e => console.error('[AutoSync] Order sync failed:', e.message));
            
            axios.post(`${protocol}://${host}/api/shopify/${clientId}/sync-products`, {}, {
                headers: { Authorization: req.headers.authorization }
            }).catch(e => console.error('[AutoSync] Product sync failed:', e.message));
        }

        let payouts = [];
        try {
          const payoutsRes = await shop.get('/shopify_payments/payouts.json?limit=5');
          payouts = payoutsRes.data?.payouts || [];
        } catch (payoutErr) {
          console.warn('[Pulse] Payouts Fetch skipped:', payoutErr.message);
        }

        const revenue = orders.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
        const aov = orders.length ? (revenue / orders.length) : 0;

        return {
            stats: { revenue, orderCount: orders.length, aov, pendingFulfillment: orders.filter(o => !o.fulfillment_status).length },
            payouts
        };
    });

    const client = await Client.findOne({ clientId });
    res.json({
        success: true,
        ...result,
        shopDomain: client.shopDomain,
        shopifyConnectionStatus: client.shopifyConnectionStatus,
        lastShopifyError: client.lastShopifyError
    });

  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.message;
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    console.error('Pulse Critical Error:', shopifyError);
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      error: shopifyError, 
      isShopifyAuthError: isAuthError
    });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/products
 * @desc    Get all Shopify products with "in bot" status
 */
router.get('/:clientId/products', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;

    const products = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/products.json?limit=100&fields=id,title,variants,images,status,handle');
        const shopifyProducts = response.data.products;
        
        const client = await Client.findOne({ clientId });
        const botProducts = client.nicheData?.products || [];
        const botProductIds = new Set(botProducts.map(p => String(p.id)));

        return shopifyProducts.map(p => ({
          ...p,
          isWhatsAppReady: botProductIds.has(String(p.id)),
          inventory: p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0)
        }));
    });

    res.json({ success: true, products });
  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      products: [], 
      error: errorString, 
      isShopifyAuthError: isAuthError 
    });
  }
});

/**
 * @route   PUT /api/shopify-hub/:clientId/products/:productId/price
 * @desc    Update product price in Shopify
 */
router.put('/:clientId/products/:productId/price', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { variantId, price } = req.body;

    await withShopifyRetry(clientId, async (shop) => {
        return await shop.put(`/variants/${variantId}.json`, {
          variant: { id: variantId, price }
        });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/locations
 * @desc    Get Shopify store locations (needed for inventory updates)
 */
router.get('/:clientId/locations', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const locations = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/locations.json');
        return response.data.locations;
    });
    res.json({ success: true, locations });
  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      error: errorString, 
      isShopifyAuthError: isAuthError 
    });
  }
});

/**
 * @route   PUT /api/shopify-hub/:clientId/inventory/set
 * @desc    Update product inventory level in Shopify
 */
router.put('/:clientId/inventory/set', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { inventoryItemId, locationId, available } = req.body;

    if (!inventoryItemId || locationId === undefined || available === undefined) {
      return res.status(400).json({ success: false, error: 'Missing inventoryItemId, locationId, or available' });
    }

    await withShopifyRetry(clientId, async (shop) => {
        return await shop.post('/inventory_levels/set.json', {
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          available: parseInt(available, 10)
        });
    });

    res.json({ success: true });
  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    console.error('[InventoryUpdate] Error:', errorString);
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      error: errorString, 
      isShopifyAuthError: isAuthError 
    });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/customers
 * @desc    Get top customers from Shopify ordered by total spend
 */
router.get('/:clientId/customers', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const customers = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/customers.json?limit=50&order=total_spent+DESC');
        return response.data.customers;
    });
    res.json({ success: true, customers });
  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403;
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      error: errorString, 
      isShopifyAuthError: isAuthError 
    });
  }
});



/**
 * @route   POST /api/shopify-hub/:clientId/discounts
 * @desc    Create a real Shopify discount code
 */
router.post('/:clientId/discounts', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { title, type, value, expiryHours = 24, prefix = 'TOPAI' } = req.body;

    const discount = await withShopifyRetry(clientId, async (shop) => {
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

        return discountRes.data.discount_code;
    });

    res.json({ success: true, discount });
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
      syncedMetaTemplates: client.syncedMetaTemplates || [],
      shopifyConnectionStatus: client.shopifyConnectionStatus || 'connected',
      lastShopifyError: client.lastShopifyError || ''
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
    
    if (automationFlows) {
        client.automationFlows = automationFlows;
        client.markModified('automationFlows');
    }
    if (nicheData) {
        client.nicheData = { ...client.nicheData, ...nicheData };
        client.markModified('nicheData');
    }
    
    if (!client.businessName) {
        client.businessName = client.clientId || req.params.clientId;
    }
    await client.save();
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    console.error('Settings Update Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
