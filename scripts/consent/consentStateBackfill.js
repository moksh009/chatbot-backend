#!/usr/bin/env node
'use strict';

/**
 * One-time or scheduled consent state backfill for all tenants or one clientId.
 * Usage:
 *   node scripts/consent/consentStateBackfill.js
 *   node scripts/consent/consentStateBackfill.js --clientId=acme_store
 *   node scripts/consent/consentStateBackfill.js --dry-run
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../../models/Client');
const {
  auditConsentHealth,
  syncConsentStateForClient,
} = require('../../utils/commerce/marketingConsentPlatform');

function parseArgs() {
  const out = { dryRun: false, clientId: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--clientId=')) out.clientId = arg.split('=')[1];
  }
  return out;
}

async function main() {
  const { dryRun, clientId } = parseArgs();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const clientIds = clientId
    ? [clientId]
    : (await Client.find({}).select('clientId').lean()).map((c) => c.clientId);

  console.log(`Consent backfill — ${clientIds.length} tenant(s)${dryRun ? ' (dry-run)' : ''}`);

  for (const cid of clientIds) {
    const before = await auditConsentHealth(cid);
    console.log(`\n[${cid}] drift before:`, before.totalDrift, before);

    const result = await syncConsentStateForClient(cid, { dryRun });
    console.log(`[${cid}] sync:`, result);

    const after = await auditConsentHealth(cid);
    console.log(`[${cid}] drift after:`, after.totalDrift);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
