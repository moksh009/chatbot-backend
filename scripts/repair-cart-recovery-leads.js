#!/usr/bin/env node
'use strict';

/**
 * Repair corrupted abandoned-cart AdLead rows for one or all tenants.
 *
 * - Normalizes phone numbers to E.164 (+91…)
 * - Restores real names from Orders (fixes "Checkout Customer")
 * - Merges duplicate leads sharing the same checkoutToken
 *
 * Usage:
 *   node scripts/repair-cart-recovery-leads.js --dry-run
 *   node scripts/repair-cart-recovery-leads.js topedgedemo_956281
 *   node scripts/repair-cart-recovery-leads.js topedgedemo_956281 --dry-run
 *   node scripts/repair-cart-recovery-leads.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const { repairCartRecoveryLeadsForClient } = require('../utils/commerce/cartRecoveryLeadRepair');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const clientArg = args.find((a) => a && !a.startsWith('--'));

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required in chatbot-backend-main/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[repair-cart-recovery-leads] Connected to MongoDB');

  const clientIds = clientArg
    ? [clientArg]
    : await Client.find({ isActive: { $ne: false } }).distinct('clientId');

  let totals = {
    phonesNormalized: 0,
    namesFixed: 0,
    merged: 0,
    deleted: 0,
    conflicts: 0,
  };

  for (const clientId of clientIds) {
    const result = await repairCartRecoveryLeadsForClient(clientId, { dryRun });
    totals.phonesNormalized += result.phonesNormalized;
    totals.namesFixed += result.namesFixed;
    totals.merged += result.merged;
    totals.deleted += result.deleted;
    totals.conflicts += result.conflicts;

    if (
      result.phonesNormalized ||
      result.namesFixed ||
      result.merged ||
      result.deleted ||
      result.conflicts
    ) {
      console.log(
        `[${clientId}] phones=${result.phonesNormalized} names=${result.namesFixed} merged=${result.merged} deleted=${result.deleted} conflicts=${result.conflicts}${dryRun ? ' (dry-run)' : ''}`
      );
      for (const row of result.details) {
        if (row.status === 'phone_normalized') {
          console.log(`  ✓ phone ${row.leadId}: ${row.from} → ${row.to}`);
        } else if (row.status === 'name_fixed') {
          console.log(`  ✓ name ${row.leadId}: "${row.from}" → "${row.to}"`);
        } else if (row.status === 'duplicate_removed') {
          console.log(
            `  ✓ merged token ${row.token}: removed ${row.duplicateId} (kept ${row.canonicalId}) phone=${row.dupPhone || 'n/a'}`
          );
        } else if (row.status === 'phone_conflict') {
          console.log(`  ⚠ phone conflict ${row.leadId}: ${row.from} → ${row.to} (dup ${row.conflictWith})`);
        }
      }
    }
  }

  console.log(
    `[repair-cart-recovery-leads] Done. phones=${totals.phonesNormalized} names=${totals.namesFixed} merged=${totals.merged} deleted=${totals.deleted} conflicts=${totals.conflicts}${dryRun ? ' (dry-run)' : ''}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
