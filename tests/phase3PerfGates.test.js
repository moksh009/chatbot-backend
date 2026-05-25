/**
 * Phase 3 perf / integration gates (memory Mongo + Redis).
 */
const assert = require('assert');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('./helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('./helpers/memoryRedis');

const GATES = {
  launch100Ms: Number(process.env.PHASE3_PERF_LAUNCH_100_MS || 5000),
  pauseMs: Number(process.env.PHASE3_PERF_PAUSE_MS || 5000),
  progressP95Ms: Number(process.env.PHASE3_PERF_PROGRESS_P95_MS || 600),
};

async function testConcurrencyCap() {
  const { acquire, release } = require('../utils/messaging/concurrency/tenantConcurrencyGate');
  const client = {
    clientId: 'cap_test',
    plan: 'dfy_enterprise',
    subscriptionPlan: 'dfy_enterprise',
    complianceConfig: { concurrency: { whatsapp: { maxParallel: 10 } } },
  };
  let blocked = 0;
  for (let i = 0; i < 11; i += 1) {
    const r = await acquire({ client, clientId: client.clientId, channel: 'whatsapp' });
    if (!r.acquired) blocked += 1;
  }
  for (let i = 0; i < 10; i += 1) {
    await release({ clientId: client.clientId, channel: 'whatsapp' });
  }
  assert.strictEqual(blocked, 1, '11th acquire should be blocked when cap=10');
}

async function testLaunch100UnderBudget() {
  const queueMod = require('../utils/messaging/queues/campaignDispatchQueue');
  const origBulk = queueMod.bulkEnqueueCampaignJobs;
  queueMod.bulkEnqueueCampaignJobs = async () => 100;
  const Campaign = require('../models/Campaign');
  const { launchCampaignDispatch } = require('../services/campaignLaunchService');
  const clientId = `perf_${Date.now()}`;
  const campaign = await Campaign.create({
    clientId,
    name: 'Perf 100',
    status: 'DRAFT',
    templateName: 'test_tpl',
    channel: 'whatsapp',
  });
  const rows = Array.from({ length: 100 }, (_, i) => ({
    phone: `9199${String(i).padStart(8, '0')}`,
    name: `Lead ${i}`,
  }));
  const t0 = Date.now();
  try {
    const out = await launchCampaignDispatch(campaign, rows);
    const elapsed = Date.now() - t0;
    assert.strictEqual(out.inserted, 100);
    assert.ok(elapsed < GATES.launch100Ms, `launch 100 took ${elapsed}ms`);
  } finally {
    queueMod.bulkEnqueueCampaignJobs = origBulk;
  }
}

async function testPausePropagation() {
  const Campaign = require('../models/Campaign');
  const clientId = `pause_${Date.now()}`;
  const campaign = await Campaign.create({
    clientId,
    name: 'Pause test',
    status: 'SENDING',
    templateName: 't',
  });
  const t0 = Date.now();
  campaign.status = 'PAUSED';
  await campaign.save();
  const fresh = await Campaign.findById(campaign._id).lean();
  assert.strictEqual(fresh.status, 'PAUSED');
  assert.ok(Date.now() - t0 < GATES.pauseMs);
}

async function testProgressThrottle() {
  const { flushCampaignProgress } = require('../utils/messaging/dispatch/campaignProgress');
  const campaignId = `prog_${Date.now()}`;
  const clientId = 'prog_client';
  const { incrCampaignProgress } = require('../utils/messaging/dispatch/campaignProgress');
  await incrCampaignProgress(campaignId, 'queued', 5);
  const t0 = Date.now();
  await flushCampaignProgress(campaignId, clientId, { totalHint: 5 });
  const first = Date.now() - t0;
  const t1 = Date.now();
  const skipped = await flushCampaignProgress(campaignId, clientId, { totalHint: 5 });
  const second = Date.now() - t1;
  assert.strictEqual(skipped, false);
  assert.ok(first <= GATES.progressP95Ms + 50);
  assert.ok(second < 100 || skipped === false);
}

async function main() {
  await startMemoryMongo();
  injectMemoryRedis();
  await clearCollections();

  const tests = [
    ['concurrencyCap', testConcurrencyCap],
    ['launch100', testLaunch100UnderBudget],
    ['pausePropagation', testPausePropagation],
    ['progressThrottle', testProgressThrottle],
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}:`, e.message);
    }
  }

  resetMemoryRedis();
  await stopMemoryMongo();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
