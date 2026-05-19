/**
 * One-time / CI script: ensure critical MongoDB indexes exist.
 * Usage: node scripts/verifyIndexes.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const criticalIndexes = [
  { collection: "conversations", keys: { clientId: 1, phone: 1 } },
  { collection: "conversations", keys: { clientId: 1, status: 1, lastMessageAt: -1 } },
  { collection: "conversations", keys: { clientId: 1, lastMessageAt: -1 } },
  { collection: "conversations", keys: { clientId: 1, flowPausedUntil: 1, status: 1 } },
  { collection: "conversations", keys: { activeFlowId: 1 } },
  { collection: "adleads", keys: { phoneNumber: 1, clientId: 1 }, unique: true },
  { collection: "adleads", keys: { clientId: 1, optStatus: 1 } },
  { collection: "whatsappflows", keys: { clientId: 1, status: 1 } },
  { collection: "whatsappflows", keys: { flowId: 1, clientId: 1 }, unique: true },
  { collection: "messages", keys: { conversationId: 1, timestamp: -1 } },
  { collection: "messages", keys: { clientId: 1, createdAt: -1 } },
  { collection: "messages", keys: { messageId: 1 } },
  { collection: "campaignmessages", keys: { messageId: 1 } },
  { collection: "campaignmessages", keys: { campaignId: 1, status: 1 } },
  { collection: "keywordtriggers", keys: { clientId: 1, isActive: 1 } },
  { collection: "inbounddeduplications", keys: { messageId: 1, clientId: 1 }, unique: true },
  { collection: "inbounddeduplications", keys: { processedAt: 1 }, ttl: 7200 },
  // Dashboard / analytics hot paths (Phase 1)
  { collection: "clients", keys: { clientId: 1 }, unique: true },
  { collection: "pixelevents", keys: { clientId: 1, timestamp: -1 } },
  { collection: "pixelevents", keys: { clientId: 1, eventName: 1, timestamp: -1 } },
  { collection: "linkclickevents", keys: { clientId: 1, timestamp: -1 } },
  { collection: "conversationassignments", keys: { clientId: 1, assignedAt: -1 } },
  { collection: "messages", keys: { clientId: 1, timestamp: -1, direction: 1 } },
  { collection: "orders", keys: { clientId: 1, createdAt: -1 } },
  { collection: "dailystats", keys: { clientId: 1, date: 1 } },
  { collection: "users", keys: { clientId: 1 } },
];

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;

  for (const idx of criticalIndexes) {
    const collection = db.collection(idx.collection);
    try {
      await collection.createIndex(idx.keys, {
        unique: idx.unique || false,
        background: true,
        ...(idx.ttl ? { expireAfterSeconds: idx.ttl } : {}),
      });
      console.log(`✅ ${idx.collection} ${JSON.stringify(idx.keys)}`);
    } catch (err) {
      console.log(`ℹ️ ${idx.collection}: ${err.message}`);
    }
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
