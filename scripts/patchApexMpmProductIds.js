'use strict';
/**
 * patchApexMpmProductIds.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads real Shopify products from MongoDB for this client, maps each MPM
 * catalog node in the live Apex flow to the correct Content IDs
 * (shopifyVariantId), and writes the patched nodes back to both
 *   • WhatsAppFlow.nodes / publishedNodes
 *   • Client.visualFlows[].nodes
 *
 * Run ONCE after a Shopify product sync, or whenever product IDs change:
 *   node scripts/patchApexMpmProductIds.js
 *   APEX_SYNC_CLIENT_ID=other_client node scripts/patchApexMpmProductIds.js
 *   node scripts/patchApexMpmProductIds.js --clientId=other_client --dry-run
 *
 * Environment:
 *   MONGODB_URI or MONGO_URI  — required
 *   APEX_SYNC_CLIENT_ID       — optional client override
 *
 * How it works
 * ─────────────
 * Each MPM catalog node has a `header` field (e.g. "TV Backlights", "Gaming Lights").
 * This script looks up products whose collectionTitles contain keywords from
 * that header, picks up to MAX_PER_SECTION in-stock products, and replaces
 * `productIds` and `thumbnailProductRetailerId` on the node.
 *
 * Category → keyword mapping (edit CATEGORY_KEYWORDS below to tune matching):
 *   "TV Backlights"   → tv, backlight, hdmi
 *   "Monitor Sync"    → monitor
 *   "Govee Collection"→ govee
 *   "Floor Lamps"     → floor, table, lamp, uplighter
 *   "Gaming Lights"   → gaming, bar, triangle, hexagon, wall
 *   "LED Strip Lights"→ strip, neon, rope, cob
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { runMetaCatalogImport } = require('../utils/metaCatalogSync');
const { autoPatchMpmFlowNodes } = require('../utils/flowMpmPatch');

const FLOW_ID = 'flow_apex_owner_support_hub_v2';

function resolveClientId() {
  const fromEnv = process.env.APEX_SYNC_CLIENT_ID || process.env.SYNC_CLIENT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const arg = process.argv.find((a) => a.startsWith('--clientId='));
  if (arg) return arg.split('=').slice(1).join('=').trim();
  return 'shubhampatelsbusiness_1cfb2b';
}

const skipImport = process.argv.includes('--skip-import');

async function run() {
  const CLIENT_ID = resolveClientId();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required in .env');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });
  console.log(`[patchApexMpmProductIds] Client: ${CLIENT_ID}`);

  if (!skipImport) {
    console.log('[patchApexMpmProductIds] Importing from Meta catalog…');
    const imp = await runMetaCatalogImport(CLIENT_ID);
    console.log(`  → ${imp.synced} products, ${imp.collections} collections`);
  }

  const patch = await autoPatchMpmFlowNodes(CLIENT_ID, { flowId: FLOW_ID });
  console.log(`\n✅ Patched ${patch.patched} MPM nodes in flow ${patch.flowId || FLOW_ID}`);
  if (patch.patches) {
    for (const [nodeId, p] of Object.entries(patch.patches)) {
      console.log(`  ${nodeId}: ${p.count} products (thumb ${p.thumbnailProductRetailerId})`);
    }
  }
}

run()
  .catch((err) => {
    console.error('[patchApexMpmProductIds] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });
