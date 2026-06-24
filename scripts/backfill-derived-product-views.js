#!/usr/bin/env node
'use strict';

/**
 * Backfill derived product_view events from historical page_view on /products/* URLs.
 * Usage: node scripts/backfill-derived-product-views.js <clientId> [days]
 *        node scripts/backfill-derived-product-views.js --all [days]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const {
  backfillDerivedProductViews,
  backfillAllClientsDerivedProductViews,
} = require('../utils/commerce/productViewDerivation');

async function main() {
  const arg = process.argv[2];
  const days = Number(process.argv[3]) || 30;
  if (!arg) {
    console.error('Usage: node scripts/backfill-derived-product-views.js <clientId|--all> [days]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (arg === '--all') {
      const result = await backfillAllClientsDerivedProductViews(days);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await backfillDerivedProductViews(arg, days);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
