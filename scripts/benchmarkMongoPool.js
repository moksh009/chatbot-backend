/**
 * Compare getCachedClient latency under API-only vs full cron load.
 * Usage:
 *   Terminal A: RUN_CRONS=false RUN_WORKERS=false node index.js
 *   Terminal B: node scripts/benchmarkMongoPool.js
 *
 * Or pass SIGNOFF_API_BASE if server already running.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const SAMPLES = parseInt(process.argv.find((a) => a.startsWith('--samples='))?.split('=')[1] || '8', 10);
const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function benchGetCachedClient() {
  const { getCachedClient, invalidateClientCache } = require('../utils/core/clientCache');
  invalidateClientCache(clientId);
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    invalidateClientCache(clientId);
    const t0 = Date.now();
    await getCachedClient(clientId, 'clientId phoneNumberId whatsappToken');
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1],
    samples: times,
  };
}

async function benchHttp() {
  const jwt = require('jsonwebtoken');
  const User = require('../models/User');
  const user = await User.findOne({ clientId }).lean();
  if (!user) throw new Error('no user');
  const token = jwt.sign(
    { id: user._id, clientId: user.clientId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const BASE = process.env.SIGNOFF_API_BASE || 'http://localhost:5001/api';
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/conversations?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await r.json();
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), max: times[times.length - 1] };
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`\n=== Mongo pool benchmark (${clientId}, n=${SAMPLES}) ===\n`);

  const direct = await benchGetCachedClient();
  console.log('Direct getCachedClient (cold cache each sample):');
  console.log(JSON.stringify(direct, null, 2));

  try {
    const http = await benchHttp();
    console.log('\nHTTP GET /conversations (3 runs):');
    console.log(JSON.stringify(http, null, 2));
  } catch (e) {
    console.log('\nHTTP bench skipped (server not up?):', e.message);
  }

  const { getMongoCronBudgetStats } = require('../utils/core/mongoCronBudget');
  console.log('\nCron mongo budget:', getMongoCronBudgetStats());

  await mongoose.disconnect();
  const pass = direct.p95 < 3000;
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
