const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { addHours } = require('date-fns');
const { apiCache } = require('../middleware/apiCache');

const { getShopifyClient, withShopifyRetry } = require('../utils/shopify/shopifyHelper');
const { resetShopifyBreaker, isCircuitOpenError } = require('../utils/core/circuitBreaker');
const { enrichShopifyCustomers } = require('../utils/shopify/shopifyCustomerEnrichment');
const {
  getCachedClient,
  SHOPIFY_BOT_PRODUCTS_SELECT,
  SHOPIFY_PULSE_META_SELECT,
} = require('../utils/core/clientCache');
const {
  resolveUsageLimit,
  enrichDiscountsList,
  buildShopifyAdminDiscountUrl,
} = require('../utils/commerce/discountCodes');
const {
  syncShopifyCustomersForClient,
  listShopifyCustomersForClient,
} = require('../utils/shopify/shopifyCustomersHub');

const pulseCache = new Map();
const PULSE_CACHE_TTL_MS = 120_000;
const orderCountCache = new Map();
const ORDER_COUNT_CACHE_TTL_MS = 300_000;

async function getCachedOrderCount(clientId) {
  const hit = orderCountCache.get(clientId);
  if (hit && Date.now() - hit.at < ORDER_COUNT_CACHE_TTL_MS) return hit.count;
  const count = await Order.countDocuments({ clientId }).maxTimeMS(2500);
  orderCountCache.set(clientId, { count, at: Date.now() });
  return count;
}

function isShopifyLocationsScopeError(err) {
  const status = err?.response?.status;
  if (status !== 403 && status !== 404) return false;
  const blob = JSON.stringify(err?.response?.data || err?.message || '').toLowerCase();
  return blob.includes('location') || blob.includes('read_locations') || blob.includes('scope');
}

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
router.get('/:clientId/pulse', protect, verifyClientAccess, apiCache(90), async (req, res) => {
  const { clientId } = req.params;
  try {
    const cached = pulseCache.get(clientId);
    if (cached && Date.now() - cached.at < PULSE_CACHE_TTL_MS) {
      return res.json({ success: true, ...cached.payload, cached: true });
    }

    const result = await withShopifyRetry(clientId, async (shop) => {
        // Fetch last 30 days of orders (capped — full 250-order pulls blocked the Node event loop)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const ordersRes = await shop.get(`/orders.json?status=any&created_at_min=${thirtyDaysAgo.toISOString()}&limit=50`);
        const orders = ordersRes.data?.orders || [];

        // AUTOMATIC SYNC: If no orders found in our DB but Shopify has some, trigger background sync
        const internalOrderCount = await getCachedOrderCount(clientId);
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

    const client = await getCachedClient(clientId, SHOPIFY_PULSE_META_SELECT);
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const payload = {
        ...result,
        shopDomain: client.shopDomain || '',
        shopifyConnectionStatus: client.shopifyConnectionStatus || 'disconnected',
        lastShopifyError: client.lastShopifyError || '',
    };
    pulseCache.set(clientId, { at: Date.now(), payload });

    res.json({
        success: true,
        ...payload
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
router.get('/:clientId/products', protect, verifyClientAccess, apiCache(120), async (req, res) => {
  const { clientId } = req.params;
  try {
    const clientMeta = await getCachedClient(clientId, SHOPIFY_BOT_PRODUCTS_SELECT);
    const botProducts = clientMeta?.nicheData?.products || [];
    const botProductIds = new Set(botProducts.map((p) => String(p.id)));

    const products = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/products.json?limit=250&fields=id,title,variants,images,status,handle');
        const shopifyProducts = response.data.products;
        if (!Array.isArray(shopifyProducts)) return [];

        return shopifyProducts.map(p => ({
          ...p,
          isWhatsAppReady: botProductIds.has(String(p.id)),
          inventory: Array.isArray(p.variants) ? p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0) : 0
        }));
    });

    res.json({ success: true, products: products || [], shopDomain: clientMeta?.shopDomain || '' });
  } catch (err) {
    if (isCircuitOpenError(err)) {
      return res.status(503).json({
        success: false,
        code: 'CIRCUIT_OPEN',
        error: err.message,
        retryAfterMs: 30_000,
      });
    }
    if (isDisconnectedShopifyConfig(err)) {
      const c = await getCachedClient(clientId, SHOPIFY_BOT_PRODUCTS_SELECT);
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

    try {
      const { writeAuditLog } = require('../utils/messaging/writeAuditLog');
      await writeAuditLog({
        clientId,
        action_type: 'commerce_price_changed',
        target_resource: `product:${req.params.productId}`,
        actor: {
          type: 'user',
          userId: req.user?._id || req.user?.id,
          source: 'dashboard',
        },
        payload: { variantId, price, category: 'commerce' },
      });
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/shopify-hub/:clientId/circuit-reset
 * @desc    Clear Shopify circuit breaker after transient failures (UI Retry)
 */
router.post('/:clientId/circuit-reset', protect, verifyClientAccess, async (req, res) => {
  resetShopifyBreaker();
  res.json({ success: true, message: 'Shopify circuit reset' });
});

/**
 * @route   GET /api/shopify-hub/:clientId/locations
 * @desc    Get Shopify store locations (needed for inventory updates)
 */
router.get('/:clientId/locations', protect, verifyClientAccess, apiCache(300), async (req, res) => {
  const { clientId } = req.params;
  try {
    const locations = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/locations.json');
        return response.data.locations || [];
    });
    res.json({ success: true, locations: locations || [] });
  } catch (err) {
    if (isCircuitOpenError(err)) {
      return res.status(503).json({
        success: false,
        code: 'CIRCUIT_OPEN',
        error: err.message,
        retryAfterMs: 30_000,
      });
    }
    if (isDisconnectedShopifyConfig(err) || isShopifyLocationsScopeError(err)) {
      return res.json({
        success: true,
        locations: [],
        isShopifyConnected: !isShopifyLocationsScopeError(err),
        locationsScopeMissing: isShopifyLocationsScopeError(err),
      });
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
 * @route   POST /api/shopify-hub/:clientId/sync-customers
 * @desc    Pull customers from Shopify, enrich, cache for paginated hub UI
 */
router.post('/:clientId/sync-customers', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await syncShopifyCustomersForClient(clientId);
    res.json({
      success: true,
      count: result.count,
      syncedAt: result.syncedAt,
    });
  } catch (err) {
    if (isDisconnectedShopifyConfig(err)) {
      return res.status(400).json({ success: false, error: 'Shopify is not connected' });
    }
    console.error(`[SyncCustomers Error] Client: ${clientId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/shopify-hub/:clientId/customers
 * @desc    Paginated, filterable customer list (from sync cache)
 * @query   cursor, limit, sort (spend|orders|last_order|lead_score), tier, topedge, search
 */
router.get('/:clientId/customers', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await listShopifyCustomersForClient(clientId, {
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: req.query.sort,
      tier: req.query.tier,
      topedge: req.query.topedge,
      search: req.query.search,
    });

    res.json({
      success: true,
      customers: result.customers,
      total: result.total,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      syncedAt: result.syncedAt,
      cacheCount: result.cacheCount,
      needsSync: result.needsSync,
    });
  } catch (err) {
    if (isDisconnectedShopifyConfig(err)) {
      return res.json({
        success: true,
        customers: [],
        total: 0,
        hasMore: false,
        isShopifyConnected: false,
      });
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
      isShopifyAuthError: isAuthError,
    });
  }
});



/**
 * @route   GET /api/shopify-hub/:clientId/discounts
 * @desc    Fetch history of all generated discount codes from DB
 */
router.get('/:clientId/discounts', protect, verifyClientAccess, apiCache(60), async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await getCachedClient(clientId, 'generatedDiscounts aiUseGeneratedDiscounts shopDomain');
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const raw = (client.generatedDiscounts || []).slice().reverse();
    const discounts = await enrichDiscountsList(clientId, raw, async () => {
      const shop = await getShopifyClient(clientId);
      return shop;
    });

    res.json({
      success: true,
      discounts: discounts.map((d) => ({
        ...d,
        shopifyAdminUrl:
          d.shopifyAdminUrl || buildShopifyAdminDiscountUrl(client.shopDomain, d.priceRuleId),
      })),
      shopDomain: client.shopDomain || null,
      aiUseGeneratedDiscounts: client.aiUseGeneratedDiscounts ?? false,
    });
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
    const {
      title,
      type,
      value,
      expiryHours = 24,
      prefix = 'TOPAI',
      usageLimitMode = 'single',
      usageLimitCount,
    } = req.body;
    const numericValue = Number(value);
    const normalizedType = type === 'fixed' ? 'fixed' : 'percentage';
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return res.status(400).json({ success: false, error: 'Discount value must be greater than 0' });
    }
    if (!Number.isFinite(Number(expiryHours)) || Number(expiryHours) <= 0) {
      return res.status(400).json({ success: false, error: 'Expiry must be a positive number of hours' });
    }

    const { usageLimit, usageLimitLabel } = resolveUsageLimit(usageLimitMode, usageLimitCount);
    const endsAt = addHours(new Date(), Number(expiryHours));

    const clientMeta = await Client.findOne({ clientId }).select('shopDomain').lean();

    const discount = await withShopifyRetry(clientId, async (shop) => {
        const priceRulePayload = {
          title: title || `${prefix}-${Date.now()}`,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value_type: normalizedType === 'percentage' ? 'percentage' : 'fixed_amount',
          value: `-${numericValue}`,
          customer_selection: 'all',
          starts_at: new Date().toISOString(),
          ends_at: endsAt.toISOString(),
        };
        if (usageLimit != null) {
          priceRulePayload.usage_limit = usageLimit;
        }

        const priceRuleRes = await shop.post('/price_rules.json', {
          price_rule: priceRulePayload,
        });

        const priceRuleId = priceRuleRes.data.price_rule.id;
        const code = `${prefix}-${Math.random().toString(36).substring(7).toUpperCase()}`;

        const discountRes = await shop.post(`/price_rules/${priceRuleId}/discount_codes.json`, {
          discount_code: { code },
        });

        return { ...discountRes.data.discount_code, priceRuleId };
    });

    const savedEntry = {
      code: discount.code,
      title: title || discount.code,
      type: normalizedType === 'percentage' ? 'percentage' : 'fixed_amount',
      value: numericValue,
      expiryHours: Number(expiryHours),
      usageLimitMode: usageLimitMode || 'single',
      usageLimit,
      usageLimitLabel,
      usageCount: 0,
      endsAt: endsAt.toISOString(),
      disabledAt: null,
      priceRuleId: discount.priceRuleId || discount.price_rule_id,
      shopifyId: discount.id,
      shopifyAdminUrl: buildShopifyAdminDiscountUrl(clientMeta?.shopDomain, discount.priceRuleId),
      createdAt: new Date(),
      status: 'active',
    };

    await Client.findOneAndUpdate(
      { clientId },
      { $push: { generatedDiscounts: savedEntry } }
    );

    res.json({ success: true, discount: savedEntry });
  } catch (err) {
    console.error(`[Discounts Error] Client: ${clientId}:`, err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/shopify-hub/:clientId/discounts/:code/disable
 */
router.post('/:clientId/discounts/:code/disable', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId, code } = req.params;
    const client = await Client.findOne({ clientId }).select('generatedDiscounts shopDomain');
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const entry = (client.generatedDiscounts || []).find((d) => d.code === code);
    if (!entry) return res.status(404).json({ success: false, error: 'Discount not found' });
    if (!entry.priceRuleId) {
      return res.status(400).json({ success: false, error: 'Missing Shopify price rule' });
    }

    const now = new Date().toISOString();
    await withShopifyRetry(clientId, async (shop) => {
      await shop.put(`/price_rules/${entry.priceRuleId}.json`, {
        price_rule: { id: entry.priceRuleId, ends_at: now },
      });
    });

    await Client.updateOne(
      { clientId, 'generatedDiscounts.code': code },
      {
        $set: {
          'generatedDiscounts.$.disabledAt': now,
          'generatedDiscounts.$.endsAt': now,
          'generatedDiscounts.$.status': 'disabled',
        },
      }
    );

    res.json({ success: true, code, status: 'disabled' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   DELETE /api/shopify-hub/:clientId/discounts/:code
 */
router.delete('/:clientId/discounts/:code', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId, code } = req.params;
    const client = await Client.findOne({ clientId }).select('generatedDiscounts');
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const entry = (client.generatedDiscounts || []).find((d) => d.code === code);
    if (!entry) return res.status(404).json({ success: false, error: 'Discount not found' });

    if (entry.priceRuleId) {
      try {
        await withShopifyRetry(clientId, async (shop) => {
          await shop.delete(`/price_rules/${entry.priceRuleId}.json`);
        });
      } catch (err) {
        console.warn('[Discounts] Shopify delete failed:', err.message);
      }
    }

    await Client.updateOne(
      { clientId },
      { $pull: { generatedDiscounts: { code } } }
    );

    res.json({ success: true, code });
  } catch (err) {
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
