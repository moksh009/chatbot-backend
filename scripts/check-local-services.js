#!/usr/bin/env node
'use strict';

/**
 * Quick connectivity check for local backend dependencies.
 * Usage: node scripts/check-local-services.js
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const dns = require('dns');
const net = require('net');

function probeTcp(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function checkMongo() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) {
    console.log('MongoDB: FAIL — MONGODB_URI not set');
    return false;
  }
  if (uri.includes('mongodb+srv')) {
    dns.setServers(
      (process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',').map((s) => s.trim()).filter(Boolean)
    );
  }
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, family: 4 });
    console.log(`MongoDB: OK — ${mongoose.connection.host}`);
    await mongoose.disconnect();
    return true;
  } catch (err) {
    console.log(`MongoDB: FAIL — ${err.message}`);
    if (String(err.message).includes('querySrv ECONNREFUSED')) {
      console.log('  Hint: Windows DNS blocked SRV lookup. db/index.js sets 8.8.8.8 — ensure you start via node index.js');
    }
    return false;
  }
}

async function checkRedis() {
  if (String(process.env.REDIS_DISABLED || '').toLowerCase() === 'true') {
    console.log('Redis: SKIPPED — REDIS_DISABLED=true');
    return true;
  }
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = Number(u.port) || 6379;
  } catch (_) {
    /* use defaults */
  }
  const up = await probeTcp(host, port);
  if (up) {
    console.log(`Redis: OK — ${host}:${port}`);
    return true;
  }
  console.log(`Redis: FAIL — nothing listening on ${host}:${port}`);
  console.log('  Fix: install Redis/Memurai, or for API-only dev set REDIS_DISABLED=true');
  console.log('  Or run: .\\scripts\\start-api-dev.ps1');
  return false;
}

(async () => {
  console.log('--- TopEdge local service check ---\n');
  const mongoOk = await checkMongo();
  const redisOk = await checkRedis();
  console.log('');
  if (mongoOk && redisOk) {
    console.log('All checks passed. You can run: node index.js');
    process.exit(0);
  }
  if (mongoOk && !redisOk) {
    console.log('Mongo OK but Redis down — use .\\scripts\\start-api-dev.ps1 to run without Redis spam.');
  }
  process.exit(1);
})();
