const path = require('path');
// Standalone scripts do not load .env unless we call dotenv (unlike index.js).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Client = require('../models/Client');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const { clearTriggerCache } = require('../utils/triggerEngine');
const { clearClientCache } = require('../middleware/apiCache');
const {
  buildFlow,
  FLOW_ID,
  FLOW_NAME,
  FLOW_DESCRIPTION,
} = require('../data/apexLightOwnerFlow');

/** Default client — override with `APEX_SYNC_CLIENT_ID` or `--clientId=...` */
const DEFAULT_CLIENT_ID = 'shubhampatelsbusiness_1cfb2b';

function resolveClientId() {
  const fromEnv = process.env.APEX_SYNC_CLIENT_ID || process.env.SYNC_CLIENT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const arg = process.argv.find((a) => a.startsWith('--clientId='));
  if (arg) return arg.split('=').slice(1).join('=').trim();
  return DEFAULT_CLIENT_ID;
}

/**
 * Pushes `data/apexLightOwnerFlow.js` (buildFlow) into MongoDB: WhatsAppFlow + Client.visualFlows.
 * WhatsApp live traffic uses the **published flow in the database**, not the repo file alone — run this
 * after editing the Apex flow (or publish the same graph from the dashboard).
 *
 * 1) Approve MPM template in Meta. Header = "Best Seller + {{1}} + items" (Number variable). Body = static. Add sample "3" for {{1}}.
 * 2) Dashboard → sync WhatsApp templates so `syncedMetaTemplates` includes "carosuel".
 * 3) Meta Manager → Catalog: link catalog ID `25779917041614766` (or yours) in dashboard.
 * 4) Run THIS script:  node scripts/setupApexOwnerSupportFlow.js
 *    (includes in-canvas folder groups — or run node scripts/folderizeApexLightFlow.js on existing DB copy)
 * 5) Import Meta catalog + sync categories + MPM IDs (recommended one-liner):
 *      node scripts/refreshApexCatalogFlow.js
 *    Or only patch IDs:  node scripts/patchApexMpmProductIds.js
 * Optional env: `SEED_MPM_META_TEMPLATE_NAME=my_tpl` to override template name in seed nodes.
 *
 * Requires MONGODB_URI (or MONGO_URI). Restart the API after backend code changes.
 *
 * Examples:
 *   node scripts/setupApexOwnerSupportFlow.js
 *   APEX_SYNC_CLIENT_ID=other_client node scripts/setupApexOwnerSupportFlow.js
 *   node scripts/setupApexOwnerSupportFlow.js --clientId=other_client
 */

async function run() {
  const CLIENT_ID = resolveClientId();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });
  const client = await Client.findOne({ clientId: CLIENT_ID });
  if (!client) throw new Error(`Client not found: ${CLIENT_ID}`);

  const { nodes, edges } = buildFlow();

  const greetNode = nodes.find((n) => n.id === 'n_trigger');
  const greetingKeywords = Array.isArray(greetNode?.data?.trigger?.keywords)
    ? greetNode.data.trigger.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const matchMode = greetNode?.data?.trigger?.matchMode || 'contains';

  const existing = await WhatsAppFlow.findOne({ clientId: CLIENT_ID, flowId: FLOW_ID }).select('version').lean();
  const nextVersion = (existing?.version || 0) + 1 || 1;

  await WhatsAppFlow.updateMany(
    { clientId: CLIENT_ID, platform: 'whatsapp', flowId: { $ne: FLOW_ID } },
    { $set: { status: 'DRAFT' } }
  );

  const now = new Date();
  const update = {
    clientId: CLIENT_ID,
    flowId: FLOW_ID,
    name: FLOW_NAME,
    platform: 'whatsapp',
    status: 'PUBLISHED',
    version: nextVersion,
    updatedAt: now,
    nodes,
    edges,
    publishedNodes: nodes,
    publishedEdges: edges,
    triggerConfig: {
      type: 'keyword',
      channel: 'whatsapp',
      keywords:
        greetingKeywords.length > 0
          ? greetingKeywords
          : ['hi', 'hello', 'hey', 'menu', 'start', 'hii', 'hiii', 'help', 'apex', 'namaste'],
      matchMode,
    },
    description: FLOW_DESCRIPTION,
    categories: ['support', 'warranty', 'installation', 'owner_experience', 'catalog', 'apex_light'],
    lastSyncedAt: now,
  };

  const flowDoc = await WhatsAppFlow.findOneAndUpdate(
    { clientId: CLIENT_ID, flowId: FLOW_ID },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { new: true, upsert: true }
  );

  const visualEntry = {
    id: FLOW_ID,
    name: FLOW_NAME,
    platform: 'whatsapp',
    folderId: '',
    isActive: true,
    nodes,
    edges,
    updatedAt: now,
  };

  // Do NOT set trialActive here. The dashboard TrialGate treats
  // `client.trialActive === false` as "Account Suspended" regardless of billing.
  // Only update plan/commerce-related fields plus this flow payload.
  await Client.updateOne(
    { clientId: CLIENT_ID },
    {
      $set: {
        plan: 'CX Agent (V2)',
        tier: 'v2',
        isPaidAccount: true,
        'billing.plan': 'CX Agent (V2)',
        'billing.tier': 'v2',
        'billing.isPaidAccount': true,
        'config.serviceMode': 'done_for_you',
        'config.dfyEnabled': true,
      },
      $pull: { visualFlows: { id: FLOW_ID } },
    }
  );
  await Client.updateOne({ clientId: CLIENT_ID }, { $push: { visualFlows: visualEntry } });

  clearTriggerCache(CLIENT_ID);
  await clearClientCache(CLIENT_ID);

  const hasWelcomeLogo = nodes.some((n) => n.id === 'n_welcome_logo');
  const eT0 = edges.find((e) => e.id === 'e_t0');
  const mainMenu = nodes.find((n) => n.id === 'n_main_menu');
  const verification = {
    hasWelcomeLogoNode: hasWelcomeLogo,
    entryEdge_e_t0_target: eT0?.target || null,
    mainMenuHasImageUrl: !!(mainMenu?.data && mainMenu.data.imageUrl),
  };

  console.warn(
    '[setupApexOwnerSupportFlow] After this sync: hard-refresh the Flow Builder before clicking Publish — Publish copies the *editor* draft to live; a stale tab can overwrite Mongo with an old graph.'
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        clientId: CLIENT_ID,
        flowId: FLOW_ID,
        flowDbId: String(flowDoc._id),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        verification,
        note: 'MongoDB nodes + publishedNodes updated from repo buildFlow(). Redeploy API if server code changed. Use the same MONGODB_URI as production.',
      },
      null,
      2
    )
  );
}

run()
  .catch((err) => {
    console.error('[setupApexOwnerSupportFlow] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
