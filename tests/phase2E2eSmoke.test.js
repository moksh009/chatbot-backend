/**
 * Phase 2 Slice 6 — revenue pipeline E2E smoke + performance gates (memory Mongo/Redis).
 *
 * Flow: abandoned cart step-1 dedup key → order webhook → sequences cancelled + Redis cleared.
 */
const assert = require('assert');
const mongoose = require('mongoose');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('./helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('./helpers/memoryRedis');

const PERF = {
  envelopeP95Ms: Number(process.env.PHASE2_PERF_ENVELOPE_P95_MS || 25),
  cancelP95Ms: Number(process.env.PHASE2_PERF_CANCEL_P95_MS || 35),
  orderP95Ms: Number(process.env.PHASE2_PERF_ORDER_P95_MS || 150),
  envelopeIterations: Number(process.env.PHASE2_PERF_ENVELOPE_N || 500),
  cancelIterations: Number(process.env.PHASE2_PERF_CANCEL_N || 100),
  orderIterations: Number(process.env.PHASE2_PERF_ORDER_N || 100),
};

function p95(samples) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function runRevenuePipelineE2E() {
  const Client = require('../models/Client');
  const AdLead = require('../models/AdLead');
  const FollowUpSequence = require('../models/FollowUpSequence');
  const CampaignMessage = require('../models/CampaignMessage');
  const Campaign = require('../models/Campaign');
  const { handleOrderAtomic } = require('../utils/shopify/handleOrderAtomic');
  const { finishCancelSideEffects } = require('../utils/messaging/cancelAllAutomationsFor');
  const { getAppRedis } = require('../utils/core/redisFactory');
  const { mongoCartRecoveryFilter } = require('../utils/commerce/marketingConsent');

  const clientId = `e2e_${Date.now()}`;
  const phone = '9199000111222';
  const checkoutToken = 'chk_e2e_token';
  const orderId = `e2e_order_${Date.now()}`;

  await Client.create({
    clientId,
    businessName: 'E2E Store',
    automationFlows: [{ id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } }],
    wizardFeatures: { cartNudgeMinutes1: 15 },
    flags: { useSendEnvelope: true },
    complianceConfig: {
      channels: { whatsapp: { enabled: true }, email: { enabled: true }, instagram: { enabled: true } },
    },
  });

  const abandonAt = new Date(Date.now() - 20 * 60 * 1000);
  const lead = await AdLead.create({
    clientId,
    phoneNumber: phone,
    name: 'E2E Lead',
    cartStatus: 'abandoned',
    isOrderPlaced: false,
    cartAbandonedAt: abandonAt,
    recoveryStep: 0,
    checkoutToken,
    cartSnapshot: { totalPrice: 999, checkoutToken, items: [{ title: 'Test SKU' }] },
  });

  const seq = await FollowUpSequence.create({
    clientId,
    leadId: lead._id,
    phone,
    type: 'abandoned_cart',
    status: 'active',
    steps: [{ type: 'whatsapp', status: 'pending', delayValue: 1, delayUnit: 'h' }],
  });

  const campaign = await Campaign.create({
    clientId,
    name: 'E2E Campaign',
    status: 'SENDING',
    templateName: 'cart_recovery',
  });

  await CampaignMessage.create({
    clientId,
    campaignId: campaign._id,
    phone,
    status: 'queued',
  });

  const redis = getAppRedis();
  assert.ok(redis, 'memory redis required');
  await redis.set(`cart_recovery:${clientId}:${phone}:step1`, '1', 'EX', 3600);
  await redis.set(`cart_recovery:${clientId}:${phone}:step2`, '1', 'EX', 3600);
  await redis.set(`nlp_buffer:${clientId}:${phone}`, 'buf', 'EX', 3600);

  const client = await Client.findOne({ clientId }).lean();
  const orderPayload = { id: orderId, name: `#${orderId}`, created_at: new Date().toISOString() };

  const first = await handleOrderAtomic(client, orderPayload, phone);
  assert.strictEqual(first.duplicate, false);
  assert.ok(first.lead);
  assert.strictEqual(first.lead.isOrderPlaced, true);
  assert.ok(first.cancelled.sequences >= 1, 'expected sequence cancel');

  await finishCancelSideEffects(
    {
      clientId,
      leadId: first.lead._id,
      phone,
      reason: 'order_placed',
      channels: 'all',
      actor: { type: 'system', source: 'test:e2e' },
    },
    first.cancelled
  );

  const seqAfter = await FollowUpSequence.findById(seq._id).lean();
  assert.strictEqual(seqAfter.status, 'cancelled');
  assert.strictEqual(seqAfter.cancelledReason, 'order_placed');

  const cmAfter = await CampaignMessage.findOne({ clientId, phone }).lean();
  assert.strictEqual(cmAfter.status, 'cancelled');

  assert.strictEqual(await redis.get(`cart_recovery:${clientId}:${phone}:step1`), null);
  assert.strictEqual(await redis.get(`cart_recovery:${clientId}:${phone}:step2`), null);

  const dup = await handleOrderAtomic(client, orderPayload, phone);
  assert.strictEqual(dup.duplicate, true);

  const stillAbandoned = await AdLead.countDocuments({
    clientId,
    ...mongoCartRecoveryFilter(client),
    isOrderPlaced: { $ne: true },
    cartStatus: 'abandoned',
    phoneNumber: phone,
  });
  assert.strictEqual(stillAbandoned, 0, 'purchased lead must not match abandoned-cart cron query');

  console.log('  revenue pipeline E2E OK');
}

async function benchmarkEnvelopeHotPath() {
  const { validateInput } = require('../utils/messaging/checks/validateInput');
  const { checkConsent } = require('../utils/messaging/checks/checkConsent');
  const { checkServiceWindow } = require('../utils/messaging/checks/checkServiceWindow');
  const contact = {
    channelConsent: { whatsapp: { status: 'opted_in' } },
    lastInboundAt: new Date(),
  };
  const input = {
    clientId: 'bench',
    channel: 'whatsapp',
    intent: 'marketing',
    contact: { phone: '919876543210' },
    payload: { templateName: 'cart_recovery_1' },
  };
  const times = [];
  for (let i = 0; i < PERF.envelopeIterations; i += 1) {
    const t0 = process.hrtime.bigint();
    const v = validateInput(input);
    if (!v.pass) throw new Error(v.reason);
    checkConsent({ contact, channel: 'whatsapp', intent: 'marketing', strictMode: true });
    checkServiceWindow({
      channel: 'whatsapp',
      intent: 'service',
      payload: { text: 'hi' },
      contact,
    });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p = p95(times);
  console.log(`  envelope hot-path p95=${p.toFixed(2)}ms (n=${PERF.envelopeIterations}, limit=${PERF.envelopeP95Ms}ms)`);
  assert.ok(p <= PERF.envelopeP95Ms, `envelope p95 ${p}ms > ${PERF.envelopeP95Ms}ms`);
}

async function benchmarkCancelAll() {
  const { applyMongoCancellations } = require('../utils/messaging/cancelAllAutomationsFor');
  const AdLead = require('../models/AdLead');
  const FollowUpSequence = require('../models/FollowUpSequence');
  const clientId = 'bench_cancel';
  const phone = '9198888777666';
  const params = {
    clientId,
    phone,
    reason: 'stop_keyword',
    channels: 'all',
    actor: { type: 'system', source: 'test:perf' },
  };

  await clearCollections(['AdLead', 'FollowUpSequence', 'CampaignMessage', 'ScheduledMessage']);

  const lead = await AdLead.create({ clientId, phoneNumber: phone, name: 'Bench' });
  params.leadId = lead._id;
  const seq = await FollowUpSequence.create({
    clientId,
    leadId: lead._id,
    phone,
    type: 'custom',
    status: 'active',
    steps: [{ type: 'whatsapp', status: 'pending' }],
  });

  const resetSeq = async () => {
    await FollowUpSequence.updateOne(
      { _id: seq._id },
      {
        $set: {
          status: 'active',
          cancelledReason: null,
          cancelledAt: null,
          'steps.0.status': 'pending',
        },
      }
    );
  };

  for (let w = 0; w < 5; w += 1) {
    await resetSeq();
    await applyMongoCancellations(params, null);
  }

  const times = [];
  for (let i = 0; i < PERF.cancelIterations; i += 1) {
    await resetSeq();
    const t0 = process.hrtime.bigint();
    await applyMongoCancellations(params, null);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p = p95(times);
  console.log(
    `  cancelAllAutomationsFor (mongo) p95=${p.toFixed(2)}ms (n=${PERF.cancelIterations}, limit=${PERF.cancelP95Ms}ms)`
  );
  assert.ok(p <= PERF.cancelP95Ms, `cancel p95 ${p}ms > ${PERF.cancelP95Ms}ms`);
}

async function benchmarkOrderAtomic() {
  const Client = require('../models/Client');
  const AdLead = require('../models/AdLead');
  const { handleOrderAtomic } = require('../utils/shopify/handleOrderAtomic');

  const clientId = 'bench_order';
  await clearCollections(['Client', 'AdLead', 'FollowUpSequence', 'CampaignMessage']);

  await Client.create({
    clientId,
    businessName: 'Bench Order',
    automationFlows: [{ id: 'abandoned_cart', isActive: true }],
  });
  const client = await Client.findOne({ clientId }).lean();

  const times = [];
  for (let i = 0; i < PERF.orderIterations; i += 1) {
    const phone = `919877766${String(i).padStart(4, '0')}`;
    await AdLead.create({
      clientId,
      phoneNumber: phone,
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      channelConsent: { email: { unsubscribeToken: `bench_order_${i}` } },
    });
    const t0 = process.hrtime.bigint();
    await handleOrderAtomic(client, { id: `ord_${i}`, name: `#${i}` }, phone);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p = p95(times);
  console.log(`  handleOrderAtomic p95=${p.toFixed(2)}ms (n=${PERF.orderIterations}, limit=${PERF.orderP95Ms}ms)`);
  assert.ok(p <= PERF.orderP95Ms, `order p95 ${p}ms > ${PERF.orderP95Ms}ms`);
}

async function main() {
  injectMemoryRedis();
  await startMemoryMongo();
  try {
    console.log('Phase 2 E2E smoke');
    await runRevenuePipelineE2E();
    await benchmarkEnvelopeHotPath();
    await benchmarkCancelAll();
    await benchmarkOrderAtomic();
    console.log('Phase 2 E2E smoke — all gates passed');
    process.exitCode = 0;
  } finally {
    resetMemoryRedis();
    await stopMemoryMongo();
  }
}

main()
  .then(() => process.exit(process.exitCode === undefined ? 0 : process.exitCode))
  .catch((err) => {
    console.error('Phase 2 E2E smoke failed:', err);
    process.exit(1);
  });
