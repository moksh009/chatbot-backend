#!/usr/bin/env node
/**
 * One-off: cancel active appointment / legacy niche follow-up sequences.
 * Usage: node scripts/cancel-legacy-sequences.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { cancelLegacyFollowUpSequences } = require('../config/ecommerceOnlyPolicy');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Set MONGO_URI or MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const n = await cancelLegacyFollowUpSequences({ reason: 'manual_script' });
  console.log(`Cancelled ${n} legacy sequence(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
