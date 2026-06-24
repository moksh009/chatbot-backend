#!/usr/bin/env node
'use strict';

/**
 * Repair inflated ProductDailyStat order fields and report duplicate Order docs.
 * Usage: node scripts/repair-product-insights-orders.js <clientId> [--days=30]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const ProductDailyStat = require('../models/ProductDailyStat');
const {
  aggregateOrderProductStats,
  dateRangeKeys,
  mergeOrderPurchasesIntoStats,
  reconcileProductStatsFromEvents,
  buildProductInsightsOrderMatch,
} = require('../utils/commerce/productInsightsRollup');
const { dedupeOrdersByShopifyKey, normalizeOrderNumberKey } = require('../utils/commerce/orderDedupe');
const { istDateRangeStrings, startOfDayForDateStrIST, endOfDayForDateStrIST } = require('../utils/core/queryHelpers');

async function main() {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error('Usage: node scripts/repair-product-insights-orders.js <clientId> [--days=30]');
    process.exit(1);
  }
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) || 30 : 30;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`\nProduct insights repair — ${clientId} (${days}d IST)\n`);

  const { start: periodStart, end: periodEnd } = istDateRangeStrings(days);
  const startDate = startOfDayForDateStrIST(periodStart);
  const endDate = endOfDayForDateStrIST(periodEnd);
  const match = buildProductInsightsOrderMatch(clientId, startDate, endDate);

  const rawOrders = await Order.find(match)
    .select('shopifyOrderId orderId orderNumber createdAt items totalPrice')
    .lean();
  const deduped = dedupeOrdersByShopifyKey(rawOrders);

  console.log(`Orders in period: ${rawOrders.length} raw Mongo docs → ${deduped.length} deduped`);

  const dupGroups = new Map();
  for (const o of rawOrders) {
    const num = normalizeOrderNumberKey(o);
    const k = num ? `n:${num}` : o.shopifyOrderId ? `sid:${o.shopifyOrderId}` : `id:${o._id}`;
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(o._id.toString());
  }
  const multi = [...dupGroups.entries()].filter(([, ids]) => ids.length > 1);
  if (multi.length) {
    console.log(`\nDuplicate groups (${multi.length}):`);
    for (const [key, ids] of multi.slice(0, 10)) {
      console.log(`  ${key}: ${ids.length} docs`);
    }
    if (multi.length > 10) console.log(`  … and ${multi.length - 10} more`);
  } else {
    console.log('No duplicate order groups in period.');
  }

  const keys = dateRangeKeys(days);
  const zeroed = await ProductDailyStat.updateMany(
    { clientId },
    { $set: { purchases: 0, revenue: 0, updatedAt: new Date() } }
  );
  console.log(`\nReset purchases/revenue on ${zeroed.modifiedCount} ProductDailyStat rows (all dates).`);

  await mergeOrderPurchasesIntoStats(clientId, keys);
  await reconcileProductStatsFromEvents(clientId, Math.min(days, 30));

  const stats = await aggregateOrderProductStats(clientId, days);
  console.log('\nLive deduped metrics after repair:');
  console.log(`  Orders: ${stats.summary.orderCount}`);
  console.log(`  Units sold: ${stats.summary.unitsSold}`);
  console.log(`  Revenue: ₹${Math.round(stats.summary.ordersRevenue).toLocaleString('en-IN')}`);
  console.log(`  Period: ${stats.summary.periodStart} → ${stats.summary.periodEnd} (IST)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
