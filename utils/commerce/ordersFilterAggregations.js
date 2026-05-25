'use strict';

const Order = require('../../models/Order');
const ShopifyProduct = require('../../models/ShopifyProduct');
const { extractStateFromAddress } = require('../core/extractStateFromAddress');

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

/**
 * State distribution for a date window — same normalization as order filters, with revenue.
 */
async function getOrdersByStateInRange(clientId, startDate, endDate) {
  const match = { clientId };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const buckets = await Order.aggregate([
    { $match: match },
    {
      $project: {
        shippingAddress: 1,
        state: 1,
        address: 1,
        city: 1,
        totalPrice: { $ifNull: ['$totalPrice', '$amount', 0] },
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
        totalRevenue: { $sum: '$totalPrice' },
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
    if (!stateMap[state]) stateMap[state] = { state, orderCount: 0, totalRevenue: 0 };
    stateMap[state].orderCount += row.orderCount || 0;
    stateMap[state].totalRevenue += Number(row.totalRevenue) || 0;
  }

  return Object.values(stateMap).sort((a, b) => b.orderCount - a.orderCount);
}

/** COD vs prepaid from synced Mongo orders (matches Orders list). */
async function getPaymentMethodSplitInRange(clientId, startDate, endDate) {
  const match = { clientId };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        codOrders: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$isCOD', true] },
                  { $regexMatch: { input: { $toLower: { $ifNull: ['$paymentMethod', ''] } }, regex: /cod|cash on delivery/ } },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const raw = rows[0] || { total: 0, codOrders: 0 };
  const total = Number(raw.total) || 0;
  const codOrders = Number(raw.codOrders) || 0;
  const prepaidOrders = Math.max(0, total - codOrders);
  const codPercent = total > 0 ? Math.round((codOrders / total) * 1000) / 10 : 0;
  const prepaidPercent = total > 0 ? Math.round((prepaidOrders / total) * 1000) / 10 : 0;

  return {
    codOrders,
    prepaidOrders,
    codPercent,
    prepaidPercent,
    totalOrders: total,
  };
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
  getOrdersByStateInRange,
  getPaymentMethodSplitInRange,
  getAllCatalogProductsForFilter,
};
