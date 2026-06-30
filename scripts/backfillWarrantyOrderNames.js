#!/usr/bin/env node
'use strict';

/**
 * Backfill WarrantyRecord.shopify_order_name from synced Order docs.
 * Dry-run by default — pass --apply to write updates.
 *
 *   node scripts/backfillWarrantyOrderNames.js
 *   node scripts/backfillWarrantyOrderNames.js --apply
 *   node scripts/backfillWarrantyOrderNames.js --apply --clientId=acme_123
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WarrantyRecord = require('../models/WarrantyRecord');
const Order = require('../models/Order');
const {
  resolveWarrantyOrderFields,
  normalizeOrderNameLabel,
} = require('../utils/commerce/warrantyCustomerProfileService');

const APPLY = process.argv.includes('--apply');
const clientArg = process.argv.find((a) => a.startsWith('--clientId='));
const CLIENT_FILTER = clientArg ? clientArg.split('=')[1] : null;

function orderRefKeys(order = {}) {
  return [order.shopifyOrderId, order.orderId, order.name, order.orderNumber]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function needsBackfill(record) {
  const name = String(record.shopify_order_name || '').trim();
  const internal = String(record.shopify_internal_id || '').trim();
  const orderId = String(record.shopifyOrderId || '').trim();
  if (!name) return true;
  if (internal && name === internal) return true;
  if (/^\d{10,}$/.test(name) && !name.startsWith('#')) return true;
  if (/^\d{10,}$/.test(orderId) && name === orderId) return true;
  return false;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`[backfillWarrantyOrderNames] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const query = CLIENT_FILTER ? { clientId: CLIENT_FILTER } : {};
  const records = await WarrantyRecord.find(query).lean();
  const candidates = records.filter(needsBackfill);
  console.log(`Scanned ${records.length} records; ${candidates.length} need backfill`);

  let updated = 0;
  let skipped = 0;

  for (const record of candidates) {
    const keys = [
      record.shopifyOrderId,
      record.shopify_internal_id,
      record.shopify_order_name,
    ]
      .map((v) => String(v || '').trim())
      .filter(Boolean);

    let order = null;
    if (keys.length) {
      order = await Order.findOne({
        clientId: record.clientId,
        $or: [
          { shopifyOrderId: { $in: keys } },
          { orderId: { $in: keys } },
          { name: { $in: keys } },
          { orderNumber: { $in: keys } },
        ],
      }).lean();
    }

    const resolved = order
      ? resolveWarrantyOrderFields(order)
      : resolveWarrantyOrderFields({}, record.shopifyOrderId || record.shopify_internal_id);

    const nextName = normalizeOrderNameLabel(resolved.shopify_order_name);
    const currentName = normalizeOrderNameLabel(record.shopify_order_name);
    const nextInternal =
      resolved.shopify_internal_id ||
      String(record.shopify_internal_id || record.shopifyOrderId || '').trim();

    if (!nextName || nextName === currentName) {
      skipped += 1;
      continue;
    }

    const patch = {
      shopify_order_name: nextName,
      shopify_internal_id: nextInternal,
    };
    if (/^\d{10,}$/.test(String(record.shopifyOrderId || '')) && nextName) {
      patch.shopifyOrderId = nextName;
    }

    console.log(
      `[${APPLY ? 'update' : 'would-update'}] ${record._id} client=${record.clientId} ` +
        `${record.shopifyOrderId} -> name=${nextName} internal=${nextInternal}`
    );

    if (APPLY) {
      await WarrantyRecord.updateOne({ _id: record._id }, { $set: patch });
    }
    updated += 1;
  }

  console.log(`Done. updated=${updated} skipped=${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
