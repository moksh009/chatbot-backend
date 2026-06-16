#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { attributeRevenueToCampaign } = require('../utils/commerce/campaignStatsHelper');

async function main() {
  const args = process.argv.slice(2);
  const clientId = args.find((a) => a && !a.startsWith('--')) || '';
  const daysArg = args.find((a) => a.startsWith('--days='));
  const days = Math.max(1, Number((daysArg || '--days=30').split('=')[1]) || 30);

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[backfill-campaign-revenue-attribution] connected');

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const q = { createdAt: { $gte: since } };
  if (clientId) q.clientId = clientId;

  const rows = await Order.find(q)
    .select('clientId customerPhone phone totalPrice amount createdAt orderId shopifyOrderId')
    .sort({ createdAt: -1 })
    .lean();

  let scanned = 0;
  let attributed = 0;
  for (const order of rows) {
    scanned += 1;
    const campaignId = await attributeRevenueToCampaign(order, null);
    if (campaignId) attributed += 1;
  }

  console.log(
    `[backfill-campaign-revenue-attribution] scanned=${scanned} attributed=${attributed} days=${days}${clientId ? ` clientId=${clientId}` : ''}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
