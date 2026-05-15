'use strict';

const Order = require('../models/Order');
const { extractStateFromAddress } = require('./extractStateFromAddress');

async function getDistinctOrderProducts(clientId) {
  const rows = await Order.aggregate([
    { $match: { clientId } },
    { $unwind: '$items' },
    {
      $match: {
        $or: [
          { 'items.productId': { $exists: true, $nin: [null, ''] } },
          { 'items.sku': { $exists: true, $nin: [null, ''] } },
        ],
      },
    },
    {
      $group: {
        _id: {
          $ifNull: [
            '$items.productId',
            { $concat: ['sku:', { $ifNull: ['$items.sku', 'unknown'] }] },
          ],
        },
        shopifyProductId: { $first: '$items.productId' },
        productName: { $first: '$items.name' },
        productImageUrl: { $first: '$items.image' },
        orderIds: { $addToSet: '$_id' },
      },
    },
    {
      $project: {
        shopifyProductId: {
          $cond: [
            { $regexMatch: { input: { $toString: '$_id' }, regex: /^sku:/ } },
            '$_id',
            { $ifNull: ['$shopifyProductId', { $toString: '$_id' }] },
          ],
        },
        productName: 1,
        productImageUrl: 1,
        orderCount: { $size: '$orderIds' },
      },
    },
    { $sort: { orderCount: -1 } },
  ]);

  return rows.map((r) => ({
    shopifyProductId: String(r.shopifyProductId || r._id || '').replace(/^sku:/, '') || String(r._id),
    productName: r.productName || 'Unknown product',
    productImageUrl: r.productImageUrl || '',
    orderCount: r.orderCount || 0,
  }));
}

async function getDistinctOrderStates(clientId) {
  const orders = await Order.find({ clientId })
    .select('shippingAddress state address city')
    .lean();

  const stateMap = {};
  for (const order of orders) {
    const state =
      extractStateFromAddress(order.shippingAddress) ||
      extractStateFromAddress(order.state) ||
      extractStateFromAddress(
        [order.address, order.city, order.state].filter(Boolean).join(', ')
      );
    if (!state) continue;
    if (!stateMap[state]) stateMap[state] = { state, orderCount: 0 };
    stateMap[state].orderCount += 1;
  }

  return Object.values(stateMap).sort((a, b) => b.orderCount - a.orderCount);
}

module.exports = {
  getDistinctOrderProducts,
  getDistinctOrderStates,
};
