#!/usr/bin/env node
'use strict';

/**
 * Repair corrupted AdLead phone numbers for one or all tenants.
 *
 * Usage:
 *   node scripts/repair-adlead-phones.js              # all clients
 *   node scripts/repair-adlead-phones.js <clientId>   # single tenant
 *   node scripts/repair-adlead-phones.js --dry-run    # preview only
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const { repairAdLeadPhonesForClient } = require('../utils/shopify/adLeadPhoneRepair');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const clientArg = args.find((a) => a && !a.startsWith('--'));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[repair-adlead-phones] Connected to MongoDB');

  const clientIds = clientArg
    ? [clientArg]
    : await Client.find({ isActive: { $ne: false } }).distinct('clientId');

  let totalRepaired = 0;
  let totalConflicts = 0;
  let totalFailed = 0;

  for (const clientId of clientIds) {
    const result = await repairAdLeadPhonesForClient(clientId, { dryRun });
    totalRepaired += result.repaired;
    totalConflicts += result.conflicts;
    totalFailed += result.failed;

    if (result.repaired || result.conflicts || result.failed) {
      console.log(
        `[${clientId}] repaired=${result.repaired} conflicts=${result.conflicts} failed=${result.failed} skipped=${result.skipped}${dryRun ? ' (dry-run)' : ''}`
      );
      for (const row of result.details) {
        if (row.status === 'repaired') {
          console.log(`  ✓ ${row.email || row.leadId}: ${row.from} → ${row.to}`);
        } else if (row.status === 'conflict') {
          console.log(`  ⚠ conflict ${row.email || row.leadId}: would be ${row.to} (dup ${row.conflictWith})`);
        } else if (row.status === 'failed') {
          console.log(`  ✗ ${row.email || row.leadId}: could not repair ${row.from}`);
        }
      }
    }
  }

  console.log(
    `[repair-adlead-phones] Done. repaired=${totalRepaired} conflicts=${totalConflicts} failed=${totalFailed}${dryRun ? ' (dry-run)' : ''}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
