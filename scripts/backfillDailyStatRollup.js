/**
 * Backfill DailyStat rollup rows for a client over N days.
 *
 * Usage:
 *   node scripts/backfillDailyStatRollup.js --clientId=delitech_smarthomes --days=90
 *   node scripts/backfillDailyStatRollup.js --all --days=30
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Client = require('../models/Client');
const { rollupDaysForClient, todayDateStr } = require('../utils/dailyStatRollup');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { clientId: null, all: false, days: 90 };
  for (const a of args) {
    if (a.startsWith('--clientId=')) out.clientId = a.split('=')[1];
    if (a === '--all') out.all = true;
    if (a.startsWith('--days=')) out.days = parseInt(a.split('=')[1], 10) || 90;
  }
  return out;
}

function dateRangeStrings(days) {
  const dates = [];
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function run() {
  const { clientId, all, days } = parseArgs();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  const dates = dateRangeStrings(Math.min(days, 90));
  const today = todayDateStr();
  const historical = dates.filter((d) => d !== today);

  let clientIds = [];
  if (all) {
    const clients = await Client.find({ isActive: { $ne: false } }).select('clientId').lean();
    clientIds = clients.map((c) => c.clientId);
  } else if (clientId) {
    clientIds = [clientId];
  } else {
    throw new Error('Provide --clientId=... or --all');
  }

  console.log(`Backfill ${historical.length} days for ${clientIds.length} client(s)`);

  for (const cid of clientIds) {
    console.log(`→ ${cid}`);
    const t0 = Date.now();
    await rollupDaysForClient(cid, historical, { concurrency: 4 });
    console.log(`  done in ${Date.now() - t0}ms`);
  }

  await mongoose.disconnect();
  console.log('Backfill complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
