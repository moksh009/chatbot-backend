#!/usr/bin/env node
'use strict';

/**
 * Verify order_placed journey trigger readiness + optional dry-run routing.
 *
 * Usage:
 *   CLIENT_ID=delitech_smarthomes node scripts/verify-journey-order-placed.js
 *   CLIENT_ID=delitech_smarthomes SIMULATE=1 node scripts/verify-journey-order-placed.js
 *   CLIENT_ID=delitech_smarthomes SIMULATE=1 TEST_PHONE=919876543210 node scripts/verify-journey-order-placed.js
 *
 * SIMULATE=1 calls journeyTriggerRouter with a fake Shopify order (creates enrollment if journey matches).
 * Use a unique order name each run to avoid already_sent dedup.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CLIENT_ID = process.env.CLIENT_ID || 'delitech_smarthomes';
const SIMULATE = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';
const TEST_PHONE = process.env.TEST_PHONE || '919876543210';

function ok(label, pass, detail = '') {
  const mark = pass ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const Client = require('../models/Client');
  const WhatsAppFlow = require('../models/WhatsAppFlow');
  const FollowUpSequence = require('../models/FollowUpSequence');
  const { routeToJourneyBlueprints } = require('../services/journeyBuilder/journeyTriggerRouter');

  console.log('\n=== Journey order_placed verification ===');
  console.log(`Client: ${CLIENT_ID}\n`);

  const client = await Client.findOne({ clientId: CLIENT_ID })
    .select('clientId businessName shopifyConnected shopDomain phoneNumberId whatsappToken')
    .lean();

  if (!client) {
    console.error(`Client not found: ${CLIENT_ID}`);
    process.exit(1);
  }

  console.log('1) Connections');
  ok('Shopify connected', client.shopifyConnected !== false, client.shopDomain || 'no shop domain');
  ok('WhatsApp phone number ID', Boolean(client.phoneNumberId), client.phoneNumberId || 'missing');
  ok('WhatsApp token present', Boolean(client.whatsappToken), client.whatsappToken ? 'set' : 'missing');

  console.log('\n2) Published order_placed journeys (Live)');
  const journeys = await WhatsAppFlow.find({
    clientId: CLIENT_ID,
    flowType: 'journey',
    status: 'PUBLISHED',
    isActive: { $ne: false },
    'journeyTrigger.type': 'order_placed',
  })
    .select('flowId name journeyTrigger publishedNodes nodes isActive status')
    .lean();

  if (!journeys.length) {
    ok('At least one journey', false, 'Create → trigger Order placed → Publish → Live ON');
  } else {
    ok('At least one journey', true, `${journeys.length} found`);
    for (const j of journeys) {
      const stepNodes = (j.publishedNodes?.length ? j.publishedNodes : j.nodes || []).filter((n) => {
        const t = String(n?.type || n?.data?.nodeType || '');
        return ['send_whatsapp', 'send_email', 'chatbot_handoff'].includes(t);
      });
      console.log(`     • ${j.name} (${j.flowId}) — ${stepNodes.length} send step(s)`);
    }
  }

  console.log('\n3) Worker / cron (messages actually send)');
  const runCrons = process.env.RUN_CRONS !== 'false';
  const runWorkers = process.env.RUN_WORKERS !== 'false';
  ok('RUN_CRONS', runCrons, runCrons ? 'enabled in this process' : 'OFF — run ./scripts/start-crons-only.sh');
  ok('RUN_WORKERS', runWorkers, runWorkers ? 'enabled' : 'OFF — sequence steps will not dispatch');

  console.log('\n4) Recent journey enrollments (last 5)');
  const recent = await FollowUpSequence.find({
    clientId: CLIENT_ID,
    'enrollment.mode': 'blueprint',
    sourceFlowId: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('sourceFlowId phone status steps.name steps.type steps.status steps.sendAt createdAt sourceOrderId')
    .lean();

  if (!recent.length) {
    console.log('     (none yet)');
  } else {
    for (const s of recent) {
      const pending = (s.steps || []).filter((st) => st.status === 'pending' || st.status === 'queued').length;
      const sent = (s.steps || []).filter((st) => st.status === 'sent').length;
      console.log(
        `     • ${s.createdAt?.toISOString?.() || s.createdAt} | ${s.sourceFlowId} | order ${s.sourceOrderId || '—'} | ${s.status} | sent ${sent}/${(s.steps || []).length} pending ${pending}`
      );
    }
  }

  if (SIMULATE) {
    console.log('\n5) SIMULATE routeToJourneyBlueprints (order_placed)');
    const fakeOrder = {
      name: `#TEST-JRN-${Date.now()}`,
      id: Date.now(),
      phone: TEST_PHONE,
      customer: { first_name: 'Test', phone: TEST_PHONE, email: 'test@example.com' },
      billing_address: { phone: TEST_PHONE, first_name: 'Test' },
      financial_status: 'paid',
      total_price: '1299.00',
      payment_gateway_names: ['manual'],
      line_items: [{ title: 'Test product', quantity: 1, sku: 'TEST-SKU' }],
    };
    console.log(`     Fake order: ${fakeOrder.name} phone …${String(TEST_PHONE).slice(-4)}`);

    const result = await routeToJourneyBlueprints(CLIENT_ID, 'order_placed', fakeOrder);
    console.log('\n     Result:', JSON.stringify(result, null, 2));

    if (result.enrolled > 0) {
      console.log('\n     Check API logs for [JourneyTriggerRouter] enrolled');
      console.log('     If RUN_WORKERS=true, watch for sequenceDispatchWorker within ~2 min');
    } else if (result.skipped?.length) {
      console.log('\n     Skipped reasons (fix in dashboard):');
      for (const s of result.skipped) console.log(`       - ${s}`);
    }
  } else {
    console.log('\n5) Simulate (optional)');
    console.log('   SIMULATE=1 CLIENT_ID=delitech_smarthomes node scripts/verify-journey-order-placed.js');
  }

  console.log('\n6) Live Shopify test checklist');
  console.log('   • Shopify webhooks must hit your API (production api.topedgeai.com or ngrok → local)');
  console.log('   • Place test order with a real phone on billing/shipping');
  console.log('   • Tail logs: grep JourneyTriggerRouter OR ShopifyWebhook journey order_placed');
  console.log('   • Dashboard: Journeys → blueprint → Analytics (recipients funnel)\n');

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
