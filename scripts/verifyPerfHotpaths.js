#!/usr/bin/env node
/**
 * Smoke-test hot paths after perf fixes (bootstrap 429, catalog clientId, wa-flows lite).
 * Usage: node scripts/verifyPerfHotpaths.js
 * Requires: API on PORT (default 5001), .env with JWT_SECRET + MONGO_URI
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');

const PORT = process.env.PORT || 5001;
const BASE = `http://127.0.0.1:${PORT}/api`;
const CLIENT_ID = process.env.PERF_TEST_CLIENT_ID || 'delitech_smarthomes';

function request(method, apiPath, token) {
  return new Promise((resolve, reject) => {
    const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = new URL(`${BASE}${p}`);
    const opts = {
      hostname: url.hostname,
      port: url.port || PORT,
      path: url.pathname + url.search,
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const start = Date.now();
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, ms: Date.now() - start, body: body.slice(0, 200) });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET missing in .env');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }
  await mongoose.connect(uri, { maxPoolSize: 3 });
  const User = require('../models/User');
  const user = await User.findOne({ clientId: CLIENT_ID }).select('_id clientId role').lean();
  if (!user) {
    console.error(`No user for clientId=${CLIENT_ID}`);
    process.exit(1);
  }

  const token = jwt.sign(
    { id: user._id.toString(), clientId: user.clientId, role: user.role || 'CLIENT_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  console.log('\n=== Perf hotpath verify ===\n');
  console.log(`User ${user._id} clientId=${CLIENT_ID}\n`);

  // 1) Bootstrap burst — should NOT 429 (login limiter skip + dedupe)
  const burst = 5;
  const codes = [];
  const times = [];
  for (let i = 0; i < burst; i++) {
    const r = await request('GET', '/auth/bootstrap', token);
    codes.push(r.status);
    times.push(r.ms);
  }
  const refresh = await request('GET', '/auth/bootstrap?refresh=1', token);
  console.log(`Bootstrap refresh=1: ${refresh.status} in ${refresh.ms}ms`);
  const got429 = codes.filter((c) => c === 429).length;
  const ok = codes.filter((c) => c === 200).length;
  const p50 = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(`Bootstrap x${burst}: 200=${ok} 429=${got429} p50=${p50}ms min=${Math.min(...times)}ms max=${Math.max(...times)}ms`);
  if (got429 > 0) {
    console.log('❌ Bootstrap still rate-limited');
    process.exitCode = 1;
  } else {
    console.log('✅ No 429 on bootstrap burst');
  }

  // 2) Catalog orders + status
  const hotPaths = [
    ['catalog status', `/catalog/${CLIENT_ID}`],
    ['catalog orders', `/catalog/${CLIENT_ID}/orders?limit=20`],
    ['whatsapp-flows', '/whatsapp-flows'],
    ['templates list', `/templates/list?clientId=${CLIENT_ID}&contextPurpose=flow`],
    ['segments list', '/segments'],
    ['knowledge base (cold)', '/knowledge'],
    ['knowledge base (cached)', '/knowledge'],
  ];

  for (const [label, path] of hotPaths) {
    const r = await request('GET', path, token);
    const isCachedKnowledge = label.includes('cached');
    const slow = isCachedKnowledge ? r.ms > 800 : r.ms > 8000;
    console.log(`${slow ? '❌' : r.ms > 3000 ? '🟡' : '✅'} ${label}: ${r.status} in ${r.ms}ms`);
    if (r.status !== 200) console.log('   ', r.body);
    if (slow) process.exitCode = 1;
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
