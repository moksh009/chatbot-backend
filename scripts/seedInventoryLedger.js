#!/usr/bin/env node
'use strict';

/**
 * Seed InventoryLedger from ShopifyProduct catalog (one row per SKU, location default).
 * Usage: node scripts/seedInventoryLedger.js [clientId]
 */
require('dotenv').config();
const connectDB = require('../db');
const ShopifyProduct = require('../models/ShopifyProduct');
const InventoryLedger = require('../models/InventoryLedger');

async function seed(clientIdFilter) {
  await connectDB();
  const filter = clientIdFilter ? { clientId: clientIdFilter } : {};
  const rows = await ShopifyProduct.find({ ...filter, sku: { $ne: '' } })
    .select('clientId sku inventoryQuantity')
    .lean();

  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.clientId}::${r.sku}`;
    const qty = Number(r.inventoryQuantity) || 0;
    if (!byKey.has(key)) byKey.set(key, { clientId: r.clientId, sku: r.sku, qty });
    else byKey.get(key).qty = Math.max(byKey.get(key).qty, qty);
  }

  let upserted = 0;
  for (const { clientId, sku, qty } of byKey.values()) {
    await InventoryLedger.findOneAndUpdate(
      { clientId, sku, locationId: 'default' },
      {
        $setOnInsert: { reserved: 0, onOrder: 0 },
        $set: {
          available: qty,
          lastShopifySync: { at: new Date(), qty },
        },
      },
      { upsert: true }
    );
    upserted += 1;
  }

  console.log(`Seeded ${upserted} ledger rows from ${rows.length} catalog variants`);
  process.exit(0);
}

const clientId = process.argv[2];
seed(clientId).catch((e) => {
  console.error(e);
  process.exit(1);
});
