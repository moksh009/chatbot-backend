'use strict';
/**
 * Diagnose Meta catalog API access for a client.
 *   node scripts/diagnoseMetaCatalog.js
 *   APEX_SYNC_CLIENT_ID=other node scripts/diagnoseMetaCatalog.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { diagnoseMetaCatalogAccess } = require('../utils/metaCatalogSync');

function resolveClientId() {
  const fromEnv = process.env.APEX_SYNC_CLIENT_ID || process.env.SYNC_CLIENT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const arg = process.argv.find((a) => a.startsWith('--clientId='));
  if (arg) return arg.split('=').slice(1).join('=').trim();
  return 'shubhampatelsbusiness_1cfb2b';
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });

  const clientId = resolveClientId();
  const report = await diagnoseMetaCatalogAccess(clientId);

  console.log(JSON.stringify(report, null, 2));

  if (!report.canImport) {
    console.log('\n── How to fix ─────────────────────────────────────────────');
    console.log('1. Meta Business Settings → Users → System users → Add');
    console.log('2. Assign your Product Catalog asset to that system user');
    console.log('3. Generate token with: catalog_management, business_management');
    console.log('4. Settings → Commerce → paste as "Meta catalog access token"');
    console.log('   OR connect Meta Ads under Meta Manager (uses business token)');
    console.log('5. Re-run: node scripts/patchApexMpmProductIds.js');
    if (report.phoneLinkedCatalogId) {
      console.log(`\nWhatsApp-linked catalog ID: ${report.phoneLinkedCatalogId}`);
      console.log('Use this ID in the dashboard if it differs from Commerce Manager UI.');
    }
    process.exitCode = 1;
  }
}

run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
