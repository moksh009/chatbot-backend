const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { addHours } = require('date-fns');

const { getShopifyClient, withShopifyRetry } = require('../utils/shopifyHelper');

/** New tenants / disconnected stores: avoid 500 spam when Shopify is not configured */
function isDisconnectedShopifyConfig(err) {
  const m = String(err?.message || '');
  return (
    m.includes('Shopify credentials incomplete') ||
    m.includes('invalid domain configuration') ||
    m.includes('invalid domain') ||
    m.includes('Missing credentials') ||
    m.includes('Client not found') ||
    m.includes('Client context lost')
  );
}

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
  const { clientId } = req.params;
  try {
    
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
            
            // Non-blocking internal triggers
            if (host) {
                const baseUrl = `${protocol}://${host}`;
                axios.post(`${baseUrl}/api/shopify/${clientId}/sync-orders`, {}, {
                    headers: { Authorization: req.headers.authorization }
                }).catch(e => console.error('[AutoSync] Order sync failed:', e.message));
                
                axios.post(`${baseUrl}/api/shopify/${clientId}/sync-products`, {}, {
                    headers: { Authorization: req.headers.authorization }
                }).catch(e => console.error('[AutoSync] Product sync failed:', e.message));
            }
        }

        let payouts = [];
        try {
          const payoutsRes = await shop.get('/shopify_payments/payouts.json?limit=5');
          payouts = payoutsRes.data?.payouts || [];
        } catch (payoutErr) {
          // If 404, it just means Shopify Payments isn't enabled for this store.
          if (payoutErr.response?.status !== 404) {
            console.warn('[Pulse] Payouts Fetch error:', payoutErr.message);
          }
        }

        const revenue = orders.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
        const aov = orders.length ? (revenue / orders.length) : 0;

        return {
            stats: { revenue, orderCount: orders.length, aov, pendingFulfillment: orders.filter(o => !o.fulfillment_status).length },
            payouts
        };
    });

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    res.json({
        success: true,
        ...result,
        shopDomain: client.shopDomain || '',
        shopifyConnectionStatus: client.shopifyConnectionStatus || 'disconnected',
        lastShopifyError: client.lastShopifyError || ''
    });

  } catch (err) {
    const shopifyError = err.response?.data?.errors || err.response?.data?.message || err.message;
    const isAuthError = err.response?.status === 401 || err.response?.status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    const isMissingConfig = err.message?.includes('Shopify credentials incomplete') || err.message?.includes('invalid domain');

    console.error(`[Pulse Error] Client: ${clientId}:`, shopifyError);

    if (isMissingConfig) {
       return res.status(200).json({ 
         success: false, 
         isShopifyConnected: false, 
         error: 'Shopify is not connected' 
       });
    }

    // Capture the exact error string for the frontend to show
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    
    const status = err.response?.status;
    const isClientError = status >= 400 && status < 500;
    
    // RELAY: Instead of forwarding 401 directly (which triggers global logout), 
    // we use 400 to indicate an integration failure.
    res.status(isClientError ? 400 : 500).json({ 
      success: false, 
      error: `Shopify Hub Error: ${errorString}`, 
      isShopifyAuthError: isAuthError,
      isShopifyConnected: true,
      details: err.response?.data
    });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/products
 * @desc    Get all Shopify products with "in bot" status
 */
router.get('/:clientId/products', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {

    const products = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/products.json?limit=250&fields=id,title,variants,images,status,handle');
        const shopifyProducts = response.data.products;
        
        const client = await Client.findOne({ clientId });
        if (!client) throw new Error('Client context lost during fetch');

        const botProducts = client.nicheData?.products || [];
        const botProductIds = new Set(botProducts.map(p => String(p.id)));

        if (!Array.isArray(shopifyProducts)) return [];

        return shopifyProducts.map(p => ({
          ...p,
          isWhatsAppReady: botProductIds.has(String(p.id)),
          inventory: Array.isArray(p.variants) ? p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0) : 0
        }));
    });

    const client = await Client.findOne({ clientId });
    const shopDomain = client ? client.shopDomain : '';

    res.json({ success: true, products: products || [], shopDomain });
  } catch (err) {
    if (isDisconnectedShopifyConfig(err)) {
      const c = await Client.findOne({ clientId });
      return res.json({
        success: true,
        products: [],
        shopDomain: c?.shopDomain || '',
        isShopifyConnected: false,
      });
    }
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const status = err.response?.status;
    const isAuthError = status === 401 || status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    const isClientError = status >= 400 && status < 500;
    res.status(isClientError ? 400 : 500).json({ 
      success: false, 
      products: [], 
      error: `Shopify Hub Products Error: ${errorString}`, 
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
  const { clientId } = req.params;
  try {
    const locations = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/locations.json');
        return response.data.locations;
    });
    res.json({ success: true, locations });
  } catch (err) {
    if (isDisconnectedShopifyConfig(err)) {
      return res.json({ success: true, locations: [], isShopifyConnected: false });
    }
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const status = err.response?.status;
    const isAuthError = status === 401 || status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    const isClientError = status >= 400 && status < 500;
    console.error(`[Locations Error] Client: ${clientId}:`, errorString);
    
    res.status(isClientError ? 400 : 500).json({ 
      success: false, 
      error: errorString, 
      isShopifyAuthError: isAuthError,
      details: err.response?.data
    });
  }
});

/**
 * @route   PUT /api/shopify-hub/:clientId/inventory/set
 * @desc    Update product inventory level in Shopify
 */
router.put('/:clientId/inventory/set', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
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
    const status = err.response?.status;
    const isAuthError = status === 401 || status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    const isClientError = status >= 400 && status < 500;
    console.error(`[InventoryUpdate Error] Client: ${clientId}:`, errorString);
    res.status(isClientError ? 400 : 500).json({ 
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
  const { clientId } = req.params;
  try {
    const customers = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/customers.json?limit=50&order=total_spent+DESC');
        return response.data.customers;
    });
    res.json({ success: true, customers });
  } catch (err) {
    if (isDisconnectedShopifyConfig(err)) {
      return res.json({ success: true, customers: [], isShopifyConnected: false });
    }
    const shopifyError = err.response?.data?.errors || err.response?.data?.error || err.message;
    const errorString = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
    const status = err.response?.status;
    const isAuthError = status === 401 || status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    const isClientError = status >= 400 && status < 500;
    console.error(`[Customers Error] Client: ${clientId}:`, errorString);
    res.status(isClientError ? 400 : 500).json({ 
      success: false, 
      error: errorString, 
      isShopifyAuthError: isAuthError 
    });
  }
});



/**
 * @route   GET /api/shopify-hub/:clientId/discounts
 * @desc    Fetch history of all generated discount codes from DB
 */
router.get('/:clientId/discounts', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    // Return newest first
    const discounts = (client.generatedDiscounts || []).slice().reverse();
    res.json({ success: true, discounts, aiUseGeneratedDiscounts: client.aiUseGeneratedDiscounts ?? false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/shopify-hub/:clientId/discounts
 * @desc    Create a real Shopify discount code and persist it to DB
 */
router.post('/:clientId/discounts', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
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

    // ── Persist to DB ──────────────────────────────────────────────────────────
    const savedEntry = {
      code: discount.code,
      title: title || discount.code,
      type: type === 'percentage' ? 'percentage' : 'fixed_amount',
      value: Number(value),
      expiryHours: Number(expiryHours),
      priceRuleId: discount.price_rule_id,
      shopifyId: discount.id,
      createdAt: new Date()
    };

    await Client.findOneAndUpdate(
      { clientId },
      { $push: { generatedDiscounts: savedEntry } }
    );
    // ──────────────────────────────────────────────────────────────────────────

    res.json({ success: true, discount: { ...discount, ...savedEntry } });
  } catch (err) {
    const { clientId } = req.params;
    console.error(`[Discounts Error] Client: ${clientId}:`, err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   PATCH /api/shopify-hub/:clientId/discounts/ai-toggle
 * @desc    Toggle whether the AI uses dynamically generated discount codes
 */
router.patch('/:clientId/discounts/ai-toggle', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { enabled } = req.body;
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { aiUseGeneratedDiscounts: !!enabled } },
      { new: true }
    );
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ success: true, aiUseGeneratedDiscounts: client.aiUseGeneratedDiscounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/settings
 * @desc    Get ecommerce settings (automations, nicheData)
 */
router.get('/:clientId/settings', protect, verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId })
      .select('automationFlows nicheData flowNodes flowEdges syncedMetaTemplates shopifyConnectionStatus lastShopifyError')
      .lean();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    
    res.json({
      success: true,
      automationFlows: client.automationFlows || [],
      nicheData: client.nicheData || {},
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      syncedMetaTemplates: client.syncedMetaTemplates || [],
      shopifyConnectionStatus: client.shopifyConnectionStatus || 'disconnected',
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
    
    const { automationFlows, nicheData, flowNodes, flowEdges } = req.body;
    
    if (automationFlows) {
        client.automationFlows = automationFlows;
        client.markModified('automationFlows');
    }
    if (nicheData) {
        client.nicheData = { ...client.nicheData, ...nicheData };
        client.markModified('nicheData');
    }
    if (flowNodes) {
        client.flowNodes = flowNodes;
        client.markModified('flowNodes');
    }
    if (flowEdges) {
        client.flowEdges = flowEdges;
        client.markModified('flowEdges');
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
