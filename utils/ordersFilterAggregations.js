'use strict';

const Order = require('../models/Order');
const ShopifyProduct = require('../models/ShopifyProduct');
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
  // Phase 6: one aggregation pass + in-memory normalize (not full Order.find per doc)
  const buckets = await Order.aggregate([
    { $match: { clientId } },
    {
      $project: {
        shippingAddress: 1,
        state: 1,
        address: 1,
        city: 1,
      },
    },
    {
      $group: {
        _id: {
          province: { $ifNull: ['$shippingAddress.province', ''] },
          provinceCode: { $ifNull: ['$shippingAddress.province_code', ''] },
          shipState: { $ifNull: ['$shippingAddress.state', ''] },
          topState: { $ifNull: ['$state', ''] },
          city: { $ifNull: ['$shippingAddress.city', '$city', ''] },
          address1: { $ifNull: ['$shippingAddress.address1', '$address', ''] },
        },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  const stateMap = {};
  for (const row of buckets) {
    const id = row._id || {};
    const state =
      extractStateFromAddress({
        province: id.province,
        province_code: id.provinceCode,
        state: id.shipState || id.topState,
        city: id.city,
        address1: id.address1,
      }) ||
      extractStateFromAddress(id.topState) ||
      extractStateFromAddress([id.address1, id.city, id.topState].filter(Boolean).join(', '));
    if (!state) continue;
    if (!stateMap[state]) stateMap[state] = { state, orderCount: 0 };
    stateMap[state].orderCount += row.orderCount || 0;
  }

  return Object.values(stateMap).sort((a, b) => b.orderCount - a.orderCount);
}

/** All synced Shopify catalog products (not limited to products that appear on orders). */
async function getAllCatalogProductsForFilter(clientId) {
  const rows = await ShopifyProduct.find({ clientId })
    .select('shopifyProductId title imageUrl')
    .sort({ title: 1 })
    .lean();

  const byProductId = new Map();
  for (const p of rows) {
    const id = String(p.shopifyProductId || '').trim();
    if (!id || byProductId.has(id)) continue;
    byProductId.set(id, {
      shopifyProductId: id,
      productName: p.title || 'Product',
      productImageUrl: p.imageUrl || '',
    });
  }

  return Array.from(byProductId.values()).sort((a, b) =>
    String(a.productName).localeCompare(String(b.productName), undefined, { sensitivity: 'base' })
  );
}

module.exports = {
  getDistinctOrderProducts,
  getDistinctOrderStates,
  getAllCatalogProductsForFilter,
};
