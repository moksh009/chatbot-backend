/**
 * Phase 4A verification — conversation list timing + circuit breaker send path.
 * Usage: node scripts/verifyLiveChat4A.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { getBreaker } = require('../utils/circuitBreaker');

async function benchConversations(clientId) {
  const Conversation = require('../models/Conversation');
  const query = { clientId };
  const t0 = Date.now();
  await Conversation.find(query)
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .select('_id phone customerName lastMessage lastMessageAt')
    .hint({ clientId: 1, lastMessageAt: -1 })
    .lean();
  return Date.now() - t0;
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);

  const clientId = process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

  const b1 = await benchConversations(clientId);
  const b2 = await benchConversations(clientId);

  const breaker = getBreaker('verify_exec');
  let execOk = false;
  try {
    const v = await breaker.exec(() => Promise.resolve('ok'));
    execOk = v === 'ok';
  } catch (e) {
    console.error('exec failed:', e.message);
  }

  console.log(JSON.stringify({ clientId, conversationFindMs1: b1, conversationFindMs2: b2, circuitBreakerExec: execOk }, null, 2));

  await mongoose.disconnect();
  const pass = execOk && b2 < 500;
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
