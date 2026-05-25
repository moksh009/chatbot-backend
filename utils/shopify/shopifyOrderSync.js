'use strict';

const Order = require('../../models/Order');
const { buildShopifyOrderSet, shopifyOrderFilter, loadVariantCompareAtMap } = require('./shopifyOrderMapper');

/** Fields needed for payment, COD, fulfillment, and 3PL tracking on sync. */
const SYNC_ORDER_FIELDS =
  'id,name,order_number,created_at,cancelled_at,financial_status,fulfillment_status,' +
  'payment_gateway_names,gateway,tags,note_attributes,phone,email,customer,' +
  'billing_address,shipping_address,line_items,fulfillments,total_price';

/**
 * Paginate all Shopify orders (status=any) for a connected store.
 * @param {import('axios').AxiosInstance} shop
 */
async function fetchAllShopifyOrdersForSync(shop) {
  let allOrders = [];
  let url = '/orders.json';
  const params = { status: 'any', limit: 250, fields: SYNC_ORDER_FIELDS };
  let hasNext = true;

  while (hasNext) {
    const response = await shop.get(url, { params: url === '/orders.json' ? params : {} });
    if (response.data?.orders?.length) {
      allOrders = allOrders.concat(response.data.orders);
    }

    const linkHeader = response.headers?.link;
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const links = linkHeader.split(', ');
      const nextLink = links.find((l) => l.includes('rel="next"'));
      const match = nextLink?.match(/<([^>]+)>/);
      if (match) {
        const parsedUrl = new URL(match[1]);
        url = '/orders.json' + parsedUrl.search;
      } else {
        hasNext = false;
      }
    } else {
      hasNext = false;
    }
  }

  return allOrders;
}

/**
 * Upsert every Shopify order into Mongo with logistics-aware status and COD flags.
 */
async function syncShopifyOrdersToMongo(clientId, shop) {
  const orders = await fetchAllShopifyOrdersForSync(shop);
  const variantCompareAtMap = await loadVariantCompareAtMap(clientId, orders);
  let syncedCount = 0;
  let failedCount = 0;
  const financialSeen = new Set();
  const fulfillmentSeen = new Set();

  for (const data of orders) {
    try {
      financialSeen.add(data.financial_status != null ? String(data.financial_status) : '(null)');
      fulfillmentSeen.add(
        data.fulfillment_status != null ? String(data.fulfillment_status) : '(null)'
      );

      const $set = buildShopifyOrderSet(clientId, data, {
        preferLogisticsStatus: true,
        variantCompareAtMap,
      });
      const sid = data?.id != null ? String(data.id) : '';
      const selectors = [];
      if (sid) selectors.push({ clientId, shopifyOrderId: sid });
      if ($set.orderId) selectors.push({ clientId, orderId: $set.orderId });
      if (data?.order_number != null) {
        selectors.push({ clientId, orderNumber: String(data.order_number) });
      }

      let existing = null;
      for (const sel of selectors) {
        existing = await Order.findOne(sel).select('_id').lean();
        if (existing) break;
      }

      if (existing) {
        await Order.updateOne({ _id: existing._id }, { $set });
      } else {
        try {
          await Order.create($set);
        } catch (dupErr) {
          if (dupErr.code === 11000 && $set.orderId) {
            const legacy = await Order.findOne({ clientId, orderId: $set.orderId }).select('_id').lean();
            if (legacy) {
              await Order.updateOne({ _id: legacy._id }, { $set });
            } else {
              throw dupErr;
            }
          } else {
            throw dupErr;
          }
        }
      }
      syncedCount++;
    } catch (individualErr) {
      console.error(
        `[Sync] Failed to process order ${data.name} for ${clientId}:`,
        individualErr.message
      );
      failedCount++;
    }
  }

  console.log(
    `[Shopify sync ${clientId}] financial_status values seen:`,
    [...financialSeen].sort().join(', ')
  );
  console.log(
    `[Shopify sync ${clientId}] fulfillment_status values seen:`,
    [...fulfillmentSeen].sort().join(', ')
  );

  return { synced: syncedCount, failed: failedCount, total: orders.length };
}

module.exports = {
  fetchAllShopifyOrdersForSync,
  syncShopifyOrdersToMongo,
  SYNC_ORDER_FIELDS,
};
