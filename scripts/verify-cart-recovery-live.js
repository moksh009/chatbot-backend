#!/usr/bin/env node
'use strict';

/**
 * Live verification for abandoned cart system.
 * Usage:
 *   CLIENT_ID=your_client node scripts/verify-cart-recovery-live.js
 *   CLIENT_ID=your_client TEST_PHONE=919313045439 SEND_LIVE=1 node scripts/verify-cart-recovery-live.js
 *
 * SEND_LIVE=1 attempts real WhatsApp test via sendTestRecoveryMessage (needs approved template + WA creds).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TEST_PHONE = process.env.TEST_PHONE || '919313045439';
const SEND_LIVE = process.env.SEND_LIVE === '1' || process.env.SEND_LIVE === 'true';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const Client = require('../models/Client');
  const { buildAbandonedCartReadiness, sendTestRecoveryMessage } = require('../utils/commerce/abandonedCartReadiness');
  const { buildAbandonedCartWorkspace } = require('../utils/commerce/abandonedCartWorkspace');
  const { processPixelEvent } = require('../utils/commerce/pixelEventProcessor');
  const { handleThirdPartyWebhook } = require('../utils/audience/thirdPartyCheckoutHandler');
  const { normalizeIndianPhone } = require('../utils/core/normalizeIndianPhone');
  const crypto = require('crypto');

  let clientId = process.env.CLIENT_ID;
  if (!clientId) {
    const c = await Client.findOne({
      whatsappToken: { $exists: true, $ne: '' },
      phoneNumberId: { $exists: true, $ne: '' },
      shopifyConnected: { $ne: false },
    })
      .select('clientId businessName')
      .lean();
    clientId = c?.clientId;
    if (c) console.log(`Auto-selected client: ${c.clientId} (${c.businessName})`);
  }

  if (!clientId) {
    console.error('No CLIENT_ID and no WA-connected client found in DB');
    process.exit(1);
  }

  const report = { clientId, testPhone: TEST_PHONE, steps: [] };

  const readiness = await buildAbandonedCartReadiness(clientId);
  report.steps.push({
    step: 'readiness',
    ok: !!readiness,
    recoveryActive: readiness?.recoveryActive,
    recoveryFullyLive: readiness?.recoveryFullyLive,
    cronWorkerEnabled: readiness?.automations?.cronWorkerEnabled,
    templatesApproved: readiness?.templatesApprovedCount,
    unknownPhonePct: readiness?.pcd?.unknownPhonePct,
  });

  const pixelToken = `live_verify_${Date.now()}`;
  const pixelOut = await processPixelEvent(clientId, {
    eventName: 'checkout_contact_identified',
    data: {
      phone: TEST_PHONE,
      checkoutToken: pixelToken,
      cartTotal: 999,
      cartItems: [{ title: 'Live verify product', quantity: 1, price: 999 }],
      source: 'shopify_web_pixel_extension',
    },
  });
  const AdLead = require('../models/AdLead');
  const pixelLead = await AdLead.findOne({ clientId, checkoutToken: pixelToken }).lean();
  report.steps.push({
    step: 'deep_pixel_phone_capture',
    ok: !!pixelLead && String(pixelLead.phoneNumber || '').includes('9313045439'),
    leadId: pixelLead?._id,
    phoneStored: pixelLead?.phoneNumber,
    pixelStatus: pixelOut?.status,
  });

  const client = await Client.findOne({ clientId }).select('audienceContext').lean();
  const gokwikSecret = client?.audienceContext?.integrations?.gokwik?.webhookSecret || 'test_secret_live';
  if (!client?.audienceContext?.integrations?.gokwik?.webhookSecret) {
    await Client.updateOne(
      { clientId },
      { $set: { 'audienceContext.integrations.gokwik.webhookSecret': gokwikSecret } }
    );
  }
  const gokwikBody = {
    cartId: `live_gk_${Date.now()}`,
    custPhone: '9313045439',
    custName: 'Live Verify',
    cartTotal: 1299,
    abandonLink: 'https://example.com/recover',
    line_items: [{ productName: 'Test', productQuantity: 1, productPrice: 1299 }],
  };
  const gokwikOut = await handleThirdPartyWebhook(clientId, 'gokwik', {
    body: gokwikBody,
    headers: { 'x-webhook-secret': gokwikSecret },
  });
  report.steps.push({
    step: 'gokwik_webhook',
    ok: gokwikOut.status === 200 && gokwikOut.body?.success,
    status: gokwikOut.status,
    leadId: gokwikOut.body?.leadId,
  });

  const ws = await buildAbandonedCartWorkspace(clientId, { preset: '7d' });
  report.steps.push({
    step: 'workspace_analytics',
    ok: ws.success,
    totalAbandoned: ws.metrics?.totalAbandoned,
    activeAbandoned: ws.metrics?.activeAbandoned,
    recoveredCarts: ws.metrics?.recoveredCarts,
    recoveryRate: ws.metrics?.recoveryRate,
    nonRecoverableCount: ws.metrics?.nonRecoverableCount,
    rowCount: ws.rows?.length,
  });

  if (SEND_LIVE) {
    try {
      const normalized = normalizeIndianPhone(TEST_PHONE);
      const sendOut = await sendTestRecoveryMessage(clientId, normalized, 'cart_recovery_1');
      report.steps.push({ step: 'whatsapp_test_send', ok: true, message: sendOut.message });
    } catch (err) {
      report.steps.push({ step: 'whatsapp_test_send', ok: false, error: err.message });
    }
  } else {
    report.steps.push({
      step: 'whatsapp_test_send',
      ok: null,
      skipped: true,
      hint: 'Set SEND_LIVE=1 to send cart_recovery_1 to TEST_PHONE',
    });
  }

  console.log(JSON.stringify(report, null, 2));

  const failed = report.steps.filter((s) => s.ok === false);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
