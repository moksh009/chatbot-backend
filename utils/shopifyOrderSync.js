'use strict';

const Order = require('../models/Order');
const { buildShopifyOrderSet, shopifyOrderFilter } = require('./shopifyOrderMapper');

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

      const $set = buildShopifyOrderSet(clientId, data, { preferLogisticsStatus: true });
      await Order.findOneAndUpdate(
        shopifyOrderFilter(clientId, data),
        { $set },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
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
