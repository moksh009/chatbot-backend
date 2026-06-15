'use strict';

const { getCachedClient } = require('../core/clientCache');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { withShopifyRetry } = require('./shopifyHelper');

/** In-process cache so dashboard polls do not block on slow Shopify APIs */
const recentOrdersCache = new Map();
const RECENT_ORDERS_TTL_MS = 90_000;

/**
 * Fetch recent Shopify orders for dashboard (shared by /shopify/:id/recent-orders + dashboard workspace bundle).
 * @returns {{ success: boolean, connected: boolean, orders: object[], cached?: boolean, stale?: boolean }}
 */
async function getShopifyRecentOrders(clientId) {
  if (!clientId) {
    return { success: true, connected: false, orders: [] };
  }

  const client = await getCachedClient(clientId, 'shopDomain shopifyAccessToken commerce');
  const { shopify_connected: connected } = buildConnectionStatusPayload(client);
  if (!connected) {
    return { success: true, connected: false, orders: [] };
  }

  const cached = recentOrdersCache.get(clientId);
  if (cached && Date.now() - cached.at < RECENT_ORDERS_TTL_MS) {
    return { success: true, connected: true, orders: cached.orders, cached: true };
  }

  try {
    const result = await withShopifyRetry(clientId, async (shop) => {
      const response = await shop.get('/orders.json?limit=10&status=any');
      const orders = response.data.orders || [];

      return orders.map((order) => ({
        orderId: order.id ? order.id.toString() : 'N/A',
        orderNumber: order.name || order.order_number || 'Unknown',
        createdAt: order.created_at,
        customerName: order.customer
          ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() ||
            'Shopify Customer'
          : 'Guest',
        totalPrice: parseFloat(order.total_price || 0),
        financialStatus: order.financial_status || 'unknown',
        fulfillmentStatus: order.fulfillment_status || 'unfulfilled',
        itemsCount: (order.line_items || []).reduce(
          (acc, item) => acc + (item.quantity || 0),
          0
        ),
      }));
    });

    recentOrdersCache.set(clientId, { at: Date.now(), orders: result });
    return { success: true, connected: true, orders: result };
  } catch (err) {
    const stale = recentOrdersCache.get(clientId);
    if (stale?.orders?.length) {
      return { success: true, connected: true, orders: stale.orders, cached: true, stale: true };
    }
    const softAuthError =
      err.response?.status === 401 ||
      err.response?.status === 403 ||
      /incomplete|invalid|credentials/i.test(err.message || '');
    if (softAuthError || err.response?.status === 402) {
      return { success: true, connected: false, orders: [] };
    }
    throw err;
  }
}

module.exports = {
  getShopifyRecentOrders,
  recentOrdersCache,
  RECENT_ORDERS_TTL_MS,
};
