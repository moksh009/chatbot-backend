const mongoose = require('mongoose');
const Client = require('../models/Client');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const { clearTriggerCache } = require('../utils/triggerEngine');
const {
  buildFlow,
  FLOW_ID,
  FLOW_NAME,
  FLOW_DESCRIPTION,
} = require('../data/apexLightOwnerFlow');

/** Target Apex Light production client — change if onboarding another tenant */
const CLIENT_ID = 'shubhampatelsbusiness_1cfb2b';

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });
  const client = await Client.findOne({ clientId: CLIENT_ID });
  if (!client) throw new Error(`Client not found: ${CLIENT_ID}`);

  const { nodes, edges } = buildFlow();

  await WhatsAppFlow.updateMany(
    { clientId: CLIENT_ID, platform: 'whatsapp', flowId: { $ne: FLOW_ID } },
    { $set: { status: 'DRAFT' } }
  );

  const update = {
    clientId: CLIENT_ID,
    flowId: FLOW_ID,
    name: FLOW_NAME,
    platform: 'whatsapp',
    status: 'PUBLISHED',
    version: 2,
    nodes,
    edges,
    publishedNodes: nodes,
    publishedEdges: edges,
    triggerConfig: { type: 'KEYWORD' },
    description: FLOW_DESCRIPTION,
    categories: ['support', 'warranty', 'installation', 'owner_experience', 'catalog', 'apex_light'],
    lastSyncedAt: new Date(),
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
    updatedAt: new Date(),
  };

  await Client.updateOne(
    { clientId: CLIENT_ID },
    {
      $set: {
        plan: 'CX Agent (V2)',
        tier: 'v2',
        isPaidAccount: true,
        trialActive: false,
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

  console.log(
    JSON.stringify(
      {
        success: true,
        clientId: CLIENT_ID,
        flowId: FLOW_ID,
        flowDbId: String(flowDoc._id),
        nodeCount: nodes.length,
        edgeCount: edges.length,
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
