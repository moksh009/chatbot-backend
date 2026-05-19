/**
 * Verify Phase 3 rollup read path for 30D timeline.
 * Prefers HTTP (shared server pool) — avoids second mongoose connection starving Atlas.
 *
 * Usage:
 *   node scripts/verifyPhase3Rollup.js --clientId=delitech_smarthomes
 *   SIGNOFF_API_BASE=http://localhost:5001/api node scripts/verifyPhase3Rollup.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const BASE = process.env.SIGNOFF_API_BASE || 'http://localhost:5001/api';

async function verifyViaHttp(clientId) {
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri, { maxPoolSize: 2 });
  const User = require('../models/User');
  const user = await User.findOne({ clientId }).lean();
  await mongoose.disconnect();
  if (!user) throw new Error(`No user for ${clientId}`);

  const token = jwt.sign(
    { id: user._id, clientId: user.clientId, role: user.role || 'CLIENT_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const { createTimer } = require('../utils/perfLogger');
  const timer = createTimer('verifyPhase3Rollup HTTP', clientId);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/dashboard/summary?days=30`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const wallMs = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  timer.checkpoint('GET /dashboard/summary', { status: res.status, wallMs });

  const timeline = data?.timeline || data?.stats?.timeline || [];
  const rowCount = Array.isArray(timeline) ? timeline.length : 0;
  timer.finish(`rows=${rowCount} wallMs=${wallMs}`);

  return {
    ok: res.status === 200 && rowCount >= 28,
    rowCount,
    wallMs,
    cache: res.headers.get('x-cache'),
    mode: 'http',
  };
}

async function verifyViaDirect(clientId) {
  const mongoose = require('mongoose');
  const { createTimer } = require('../utils/perfLogger');
  const { getTimelineStats, TIMELINE_ROLLUP_MIN_DAYS } = require('../utils/analyticsHelper');
  const { getCachedClient } = require('../utils/clientCache');

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000 });

  const timer = createTimer('verifyPhase3Rollup direct', clientId);
  const client = await timer.time('getCachedClient', () =>
    getCachedClient(clientId, 'clientId businessName')
  );
  const stats = await getTimelineStats(clientId, client, { days: 30 }, { timer });
  timer.finish(`rows=${stats.length}`);
  await mongoose.disconnect();

  return {
    ok: stats.length >= 28,
    rowCount: stats.length,
    wallMs: null,
    mode: 'direct',
    threshold: TIMELINE_ROLLUP_MIN_DAYS,
  };
}

async function run() {
  const clientId =
    process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';

  let result;
  try {
    result = await verifyViaHttp(clientId);
    console.log(JSON.stringify(result, null, 2));
  } catch (httpErr) {
    console.warn('HTTP verify failed, falling back to direct Mongo:', httpErr.message);
    result = await verifyViaDirect(clientId);
    console.log(JSON.stringify(result, null, 2));
  }

  const pass = result.ok && (result.wallMs == null || result.wallMs < 8000);
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
