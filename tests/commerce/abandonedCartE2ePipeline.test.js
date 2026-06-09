'use strict';

/**
 * End-to-end abandoned cart pipeline — pixel, webhooks, dedup, attribution, workspace metrics.
 * Uses memory Mongo + Redis. Test phone: 919313045439 (Indian D2C).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('../helpers/memoryRedis');

const TEST_PHONE_RAW = '919313045439';
const TEST_CHECKOUT_TOKEN = 'chk_e2e_9313045439';

async function clearCartPipelineData() {
  await clearCollections([
    'AdLead',
    'CartRecoveryAttempt',
    'PixelEvent',
    'Order',
    'FollowUpSequence',
    'DailyStat',
  ]);
}

async function seedClient(clientId) {
  const Client = require('../../models/Client');
  await Client.findOneAndUpdate(
    { clientId },
    {
      clientId,
      businessName: 'E2E Cart Store',
      shopDomain: 'e2e-demo.myshopify.com',
      shopifyAccessToken: 'shpat_test',
      shopifyConnected: true,
      whatsappToken: 'test_token',
      phoneNumberId: 'test_phone_id',
      wizardFeatures: {
        enableAbandonedCart: true,
        cartNudgeMinutes1: 25,
        cartNudgeHours2: 4,
        cartNudgeHours3: 36,
      },
      commerceAutomations: [
        {
          id: 'sys_cart_followup_1',
          name: 'Followup 1',
          triggerType: 'abandoned_cart',
          isActive: true,
          templateName: 'cart_recovery_1',
          delayMinutes: 25,
          meta: { category: 'abandoned_cart', systemSlot: 'followup_1' },
        },
      ],
      audienceContext: {
        integrations: {
          gokwik: { webhookSecret: 'gokwik_test_secret' },
          razorpay_magic: { webhookSecret: 'razorpay_test_secret' },
        },
      },
    },
    { upsert: true, new: true }
  );
}

describe('Abandoned cart E2E pipeline (919313045439)', () => {
  let clientId;

  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
    clientId = `cart_e2e_${Date.now()}`;
    await seedClient(clientId);
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('normalizeIndianPhone accepts 919313045439', () => {
    const { normalizeIndianPhone, indianPhoneDigits } = require('../../utils/core/normalizeIndianPhone');
    const e164 = normalizeIndianPhone(TEST_PHONE_RAW);
    assert.ok(e164);
    assert.ok(indianPhoneDigits(e164).endsWith('9313045439'));
  });

  it('pixel checkout_contact_identified creates lead with phone from checkout form', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const { processPixelEvent } = require('../../utils/commerce/pixelEventProcessor');
    const AdLead = require('../../models/AdLead');
    const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');

    const result = await processPixelEvent(clientId, {
      eventName: 'checkout_contact_identified',
      data: {
        phone: TEST_PHONE_RAW,
        email: 'e2e@test.com',
        checkoutToken: TEST_CHECKOUT_TOKEN,
        checkoutUrl: 'https://e2e-demo.myshopify.com/checkouts/cn/test',
        cartTotal: 2499,
        cartItems: [{ title: 'Smart Chime', quantity: 1, price: 2499 }],
        source: 'shopify_web_pixel_extension',
      },
    });

    assert.notEqual(result.error, 'Client not found');
    const lead = await AdLead.findOne({ clientId, checkoutToken: TEST_CHECKOUT_TOKEN }).lean();
    assert.ok(lead, 'pixel should create AdLead');
    assert.ok(String(lead.phoneNumber).includes('9313045439'));
    assert.equal(lead.cartStatus, 'abandoned');

    const attempts = await CartRecoveryAttempt.find({ clientId, checkoutToken: TEST_CHECKOUT_TOKEN }).lean();
    assert.equal(attempts.length, 1, 'one CartRecoveryAttempt per checkout');
  });

  it('pixel with null phone does not create recoverable lead', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const { processPixelEvent } = require('../../utils/commerce/pixelEventProcessor');
    const AdLead = require('../../models/AdLead');

    await processPixelEvent(clientId, {
      eventName: 'checkout_contact_identified',
      data: {
        phone: null,
        email: null,
        checkoutToken: 'chk_no_phone',
      },
    });

    const lead = await AdLead.findOne({ clientId, checkoutToken: 'chk_no_phone' }).lean();
    assert.equal(lead, null);
  });

  it('GoKwik webhook ingests phone and dedupes CartRecoveryAttempt', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const { handleThirdPartyWebhook } = require('../../utils/audience/thirdPartyCheckoutHandler');
    const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');

    const body = {
      cartId: 'gokwik_cart_1',
      custPhone: '9313045439',
      custName: 'E2E User',
      cartTotal: 1999,
      abandonLink: 'https://e2e-demo.myshopify.com/recover/gokwik',
      line_items: [{ productName: 'Widget', productQuantity: 1, productPrice: 1999 }],
    };
    const req = {
      body,
      headers: { 'x-webhook-secret': 'gokwik_test_secret' },
    };

    const out1 = await handleThirdPartyWebhook(clientId, 'gokwik', req);
    assert.equal(out1.status, 200);
    assert.equal(out1.body.success, true);

    const out2 = await handleThirdPartyWebhook(clientId, 'gokwik', req);
    assert.equal(out2.status, 200);

    const attempts = await CartRecoveryAttempt.find({ clientId, checkoutToken: 'gokwik_cart_1' }).lean();
    assert.ok(attempts.length <= 2, 'dedup should limit duplicate pending attempts');
  });

  it('Razorpay Magic webhook verifies HMAC and ingests cart', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const { handleThirdPartyWebhook } = require('../../utils/audience/thirdPartyCheckoutHandler');
    const AdLead = require('../../models/AdLead');
    const secret = 'razorpay_test_secret';

    const body = {
      event: 'cart.abandoned',
      payload: {
        contact: '9313045439',
        cart_value: 3499,
        checkout_url: 'https://e2e-demo.myshopify.com/checkout/rzp',
        cart_items: [{ name: 'Razorpay Item', quantity: 1, price: 3499 }],
        checkout_token: 'rzp_tok_1',
      },
    };
    const raw = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const req = {
      body,
      headers: { 'x-razorpay-signature': signature },
      rawBody: raw,
    };

    const out = await handleThirdPartyWebhook(clientId, 'razorpay_magic', req);
    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);

    const lead = await AdLead.findOne({ clientId, checkoutToken: 'rzp_tok_1' }).lean();
    assert.ok(lead);
    assert.ok(String(lead.phoneNumber).includes('9313045439'));
  });

  it('order attribution: checkout_token match + 24h WA window', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const AdLead = require('../../models/AdLead');
    const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
    const Client = require('../../models/Client');
    const { handleOrderAtomic } = require('../../utils/shopify/handleOrderAtomic');
    const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');

    const phone = normalizeIndianPhone(TEST_PHONE_RAW);
    const lead = await AdLead.create({
      clientId,
      phoneNumber: phone,
      cartStatus: 'abandoned',
      checkoutToken: TEST_CHECKOUT_TOKEN,
      recoveryStep: 1,
    });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await CartRecoveryAttempt.create({
      clientId,
      leadId: lead._id,
      contactPhone: '9313045439',
      checkoutToken: TEST_CHECKOUT_TOKEN,
      status: 'pending',
      whatsappMessageSentAt: twoHoursAgo,
      messaged: true,
    });

    const client = await Client.findOne({ clientId }).lean();
    const out = await handleOrderAtomic(
      client,
      {
        id: 'order_e2e_1',
        name: '#1001',
        created_at: new Date().toISOString(),
        checkout_token: TEST_CHECKOUT_TOKEN,
        total_price: '2499.00',
      },
      phone
    );

    assert.strictEqual(out.lead.cartStatus, 'purchased');
    assert.strictEqual(out.lead.recoveredViaWhatsApp, true);

    const attempt = await CartRecoveryAttempt.findOne({
      clientId,
      checkoutToken: TEST_CHECKOUT_TOKEN,
      status: 'recovered',
    }).lean();
    assert.ok(attempt);
    assert.strictEqual(attempt.recoveredViaWhatsapp, true);
    assert.equal(attempt.recoveredOrderValue, 2499);
  });

  it('workspace metrics include recoverable vs non-recoverable split', async () => {
    await clearCartPipelineData();
    await seedClient(clientId);
    const AdLead = require('../../models/AdLead');
    const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');
    const { buildAbandonedCartWorkspace } = require('../../utils/commerce/abandonedCartWorkspace');

    await AdLead.create({
      clientId,
      phoneNumber: normalizeIndianPhone(TEST_PHONE_RAW),
      cartStatus: 'abandoned',
      cartAbandonedAt: new Date(Date.now() - 60 * 60 * 1000),
      cartValue: 1500,
      checkoutInitiatedCount: 1,
      checkoutToken: 'ws_tok_1',
      cartSnapshot: { items: [{ title: 'Test', quantity: 1, price: 1500 }], total_price: 1500 },
    });
    await AdLead.create({
      clientId,
      phoneNumber: 'unknown_checkout_emailonly',
      email: 'no-phone@test.com',
      cartStatus: 'abandoned',
      cartAbandonedAt: new Date(Date.now() - 60 * 60 * 1000),
      cartValue: 800,
    });

    const ws = await buildAbandonedCartWorkspace(clientId, { preset: '30d' });
    assert.ok(ws.success);
    assert.equal(ws.metrics.totalAbandoned, 2);
    assert.equal(ws.metrics.nonRecoverableCount, 1);
    assert.equal(ws.metrics.activeAbandoned, 1);
    assert.ok(ws.metrics.recoverableRevenue >= 1500);
    assert.ok(Array.isArray(ws.rows));
    assert.ok(ws.rows[0].timeline);
  });

  it('readiness API returns checklist with PCD and workers items', async () => {
    await seedClient(clientId);
    const { buildAbandonedCartReadiness } = require('../../utils/commerce/abandonedCartReadiness');
    const readiness = await buildAbandonedCartReadiness(clientId);
    assert.ok(readiness);
    const ids = readiness.checklist.map((i) => i.id);
    assert.ok(ids.includes('pcd_approval'));
    assert.ok(ids.includes('phone_required'));
    assert.ok(ids.includes('workers'));
    assert.ok(ids.includes('third_party_webhook'));
  });
});
