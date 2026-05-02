const express = require('express');
const router = express.Router();
const axios = require('axios');
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { getShopifyClient, withShopifyRetry, exchangeShopifyToken } = require('../utils/shopifyHelper');

// ── INTERNAL SYNC AUTH BYPASS ────────────────────────────────────────────────
// Allows the server to call its own sync routes during OAuth callback
const internalOrProtect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader === 'Bearer INTERNAL_SYNC') {
    return next(); // Bypass JWT check for internal calls
  }
  return protect(req, res, next);
};

async function registerWebhooks(shopDomain, accessToken, clientId) {
  const topics = ['checkouts/create', 'checkouts/update', 'orders/create'];
  const webhookUrl = `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/webhook`;

  for (const topic of topics) {
    try {
      await axios.post(
        `https://${shopDomain}/admin/api/2026-01/webhooks.json`,
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
router.post('/:clientId/sync-products', internalOrProtect, async (req, res) => {
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
    const isAuthError = err.response?.status === 401 || err.response?.status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    res.status(isAuthError ? 400 : 500).json({ success: false, error: err.message, isShopifyAuthError: isAuthError });
  }
});

// POST /api/shopify/:clientId/sync-orders
router.post('/:clientId/sync-orders', internalOrProtect, async (req, res) => {
  try {
    const { clientId } = req.params;
    let syncedCount = 0;
    let failedCount = 0;

    const result = await withShopifyRetry(clientId, async (shop) => {
        const response = await shop.get('/orders.json?limit=100&status=any');
        const orders = response.data.orders || [];
        const Order = require('../models/Order');

        for (const data of orders) {
          try {
            const phone = data.phone || data.customer?.phone || data.billing_address?.phone;
            const cleanPhone = phone ? phone.replace(/\D/g, '').slice(-10) : '0000000000';

            await Order.findOneAndUpdate(
              { orderId: data.name || `#${data.id}`, clientId },
              {
                $set: {
                  shopifyOrderId: data.id.toString(),
                  orderNumber: data.name,
                  customerName: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim() : 'Shopify Customer',
                  customerPhone: cleanPhone,
                  customerEmail: data.email || data.customer?.email || null,
                  amount: parseFloat(data.total_price),
                  totalPrice: parseFloat(data.total_price),
                  status: data.financial_status === 'paid' ? 'paid' : (data.financial_status === 'refunded' ? 'cancelled' : 'pending'),
                  paymentMethod: data.gateway || 'Shopify',
                  isCOD: (data.gateway || '').toLowerCase().includes('cash on delivery') || (data.gateway || '').toLowerCase().includes('cod'),
                  items: (data.line_items || []).map(item => ({
                      name: item.title,
                      quantity: item.quantity,
                      price: parseFloat(item.price),
                      sku: item.sku
                  })),
                  address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
                  city: data.shipping_address?.city || '',
                  state: data.shipping_address?.province || '',
                  zip: data.shipping_address?.zip || '',
                  shippingAddress: data.shipping_address,
                  createdAt: data.created_at,
                  storeString: 'Shopify'
                }
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            syncedCount++;
          } catch (individualErr) {
            console.error(`[Sync] Failed to process order ${data.name} for ${clientId}:`, individualErr.message);
            failedCount++;
          }
        }
        return { synced: syncedCount, failed: failedCount, total: orders.length };
    });

    res.json({ success: true, message: 'Sync complete', ...result });
  } catch (err) {
    console.error(`[Sync Error] for ${req.params.clientId}:`, err.message);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
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

// POST /api/shopify/:clientId/reconnect-store
router.post('/:clientId/reconnect-store', internalOrProtect, async (req, res) => {
  try {
    const { clientId } = req.params;
    console.log(`[Shopify] Force reconnection triggered for ${clientId}...`);
    
    // Call getShopifyClient with forceRefresh = true to trigger credential rotation/refresh
    await getShopifyClient(clientId, true);
    
    // Also trigger a fresh sync of orders and products to verify the new scopes
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    if (host) {
        const baseUrl = `${protocol}://${host}`;
        axios.post(`${baseUrl}/api/shopify/${clientId}/sync-products`, {}, { headers: { Authorization: req.headers.authorization } }).catch(e => {});
        axios.post(`${baseUrl}/api/shopify/${clientId}/sync-orders`, {}, { headers: { Authorization: req.headers.authorization } }).catch(e => {});
    }

    res.json({ success: true, message: 'Store connection refreshed and sync triggered.' });
  } catch (err) {
    console.error(`[Shopify Reconnect Error] for ${req.params.clientId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/shopify/:clientId/recent-orders
router.get('/:clientId/recent-orders', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    console.log(`[Shopify] Fetching recent orders for ${clientId}...`);

    const result = await withShopifyRetry(clientId, async (shop) => {
      const response = await shop.get('/orders.json?limit=10&status=any');
      const orders = response.data.orders || [];

      return orders.map(order => ({
        orderId: order.id ? order.id.toString() : 'N/A',
        orderNumber: order.name || order.order_number || 'Unknown',
        createdAt: order.created_at,
        customerName: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Shopify Customer' : 'Guest',
        totalPrice: parseFloat(order.total_price || 0),
        financialStatus: order.financial_status || 'unknown',
        fulfillmentStatus: order.fulfillment_status || 'unfulfilled',
        itemsCount: (order.line_items || []).reduce((acc, item) => acc + (item.quantity || 0), 0)
      }));
    });

    res.json({ success: true, orders: result });
  } catch (err) {
    console.error(`[Shopify Recent Orders Error] for ${req.params.clientId}:`, err.message);
    const isAuthError = err.response?.status === 401 || err.response?.status === 403 || err.message?.includes('incomplete') || err.message?.includes('invalid');
    res.status(isAuthError ? 400 : 500).json({ 
      success: false, 
      error: err.message, 
      isShopifyAuthError: isAuthError 
    });
  }
});

// GET /api/shopify/:clientId/search-sku
router.get('/:clientId/search-sku', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { sku } = req.query;
    if (!sku) return res.status(400).json({ success: false, message: 'Missing SKU' });

    const result = await withShopifyRetry(clientId, async (shop) => {
      // Search for product variant with matching SKU
      const response = await shop.get(`/products.json?limit=250&fields=id,title,variants,images`);
      const products = response.data.products || [];
      
      for (const p of products) {
        const variant = p.variants.find(v => v.sku?.trim().toLowerCase() === sku.trim().toLowerCase());
        if (variant) {
          return {
            exists: true,
            productTitle: p.title,
            price: variant.price,
            image: p.images?.[0]?.src || null,
            variantTitle: variant.title !== 'Default Title' ? variant.title : null
          };
        }
      }
      return { exists: false };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[Shopify SKU Search Error] for ${req.params.clientId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

