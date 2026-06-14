'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');
const { buildRecoveryUrl } = require('../../utils/commerce/buildRecoveryUrl');
const { buildCartRecoveryComponents } = require('../../utils/commerce/buildCartRecoveryComponents');
const {
  buildSystemAutomations,
  mergeSystemAutomations,
  CART_FOLLOWUP_DEFAULT_MINUTES,
} = require('../../utils/commerce/commerceAutomationPresets');
const {
  normalizeGoKwikPayload,
  verifySecret,
  verifyRazorpaySignature,
} = require('../../utils/audience/thirdPartyCheckoutHandler');
const { buildFollowupSteps } = require('../../utils/commerce/cartRecoveryAttemptService');

test('Task 6 — normalizeIndianPhone stores +91 E.164', () => {
  assert.equal(normalizeIndianPhone('9876543210'), '+919876543210');
  assert.equal(normalizeIndianPhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizeIndianPhone('09876543210'), '+919876543210');
});

test('Task 10 — buildRecoveryUrl appends UTM params', () => {
  const url = buildRecoveryUrl('https://store.com/cart/recover/abc', 2);
  assert.match(url, /utm_source=whatsapp/);
  assert.match(url, /utm_medium=cart_recovery/);
  assert.match(url, /utm_campaign=cart_msg_2/);
});

test('Task 2 — buildCartRecoveryComponents step 1 (image + 3 body + button)', () => {
  const lead = {
    firstName: 'Rahul',
    cartSnapshot: {
      items: [{ title: 'Doorbell', image: 'https://cdn.shopify.com/img.jpg', price: 1499 }],
      totalPrice: 1499,
    },
    checkoutUrl: 'https://store.com/checkout/abc',
  };
  const client = { shopDomain: 'demo.myshopify.com' };
  const { components } = buildCartRecoveryComponents(lead, client, 1);
  assert.equal(components[0].type, 'header');
  assert.equal(components[0].parameters[0].type, 'image');
  const body = components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 3);
  assert.equal(body.parameters[0].text, 'Rahul');
  assert.equal(body.parameters[1].text, 'Doorbell');
  const button = components.find((c) => c.type === 'button');
  assert.ok(button);
  assert.match(button.parameters[0].text, /utm_campaign=cart_msg_1/);
});

test('Task 2 — buildCartRecoveryComponents step 2 (2 body vars, no image header)', () => {
  const lead = {
    firstName: 'Rahul',
    cartSnapshot: { items: [{ title: 'Doorbell', image: 'https://cdn.shopify.com/img.jpg' }] },
    checkoutUrl: 'https://store.com/checkout/abc',
  };
  const { components } = buildCartRecoveryComponents(lead, {}, 2);
  assert.ok(!components.some((c) => c.type === 'header'));
  const body = components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 2);
});

test('Task 2 — buildCartRecoveryComponents step 3 includes discount in body', () => {
  const lead = {
    firstName: 'Rahul',
    cartSnapshot: { items: [{ title: 'Doorbell' }], totalPrice: 999 },
    checkoutUrl: 'https://store.com/checkout/abc',
    discountCode: 'SAVE10',
  };
  const { components } = buildCartRecoveryComponents(lead, {}, 3);
  const body = components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 4);
  assert.equal(body.parameters[3].text, 'SAVE10');
});

test('Task 1 — GoKwik payload normalizes phone and cart fields', () => {
  const normalized = normalizeGoKwikPayload({
    custPhone: '9876543210',
    custEmail: 'test@example.com',
    custName: 'John',
    cartTotal: 1499,
    abandonLink: 'https://store.com/recover',
    recoverStatus: 'NOT_RECOVERED',
    line_items: [{ productName: 'Widget', productQuantity: 1, productPrice: 1499 }],
  });
  assert.equal(normalized.phone, '9876543210');
  assert.equal(normalized.checkoutUrl, 'https://store.com/recover');
  assert.equal(normalized.source, 'gokwik');
  assert.equal(normalized.optInSource, 'gokwik_checkout');
});

test('Task 1 — verifySecret rejects wrong secret', () => {
  const req = { headers: { 'x-webhook-secret': 'wrong' }, body: {} };
  assert.equal(verifySecret(req, 'expected'), false);
  assert.equal(verifySecret(req, ''), true);
});

test('Task 1 — verifySecret rejects missing secret in production', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const req = { headers: {}, body: {} };
    assert.equal(verifySecret(req, ''), false);
    assert.equal(verifyRazorpaySignature(req, ''), false);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('Cart recovery — 24h WA attribution window helper', () => {
  const {
    WA_RECOVERY_ATTRIBUTION_WINDOW_MS,
    contactPhoneKey,
  } = require('../../utils/commerce/cartRecoveryAttemptService');
  assert.equal(WA_RECOVERY_ATTRIBUTION_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.ok(contactPhoneKey('+919876543210').endsWith('9876543210'));
});

test('Cart recovery — min followup 1 delay is 15 minutes (SSOT)', () => {
  const { CART_FOLLOWUP_MIN_MINUTES } = require('../../constants/cartRecoveryDefaults');
  assert.equal(CART_FOLLOWUP_MIN_MINUTES.followup_1, 15);
});

test('Task 1 — verifyRazorpaySignature validates HMAC', () => {
  const crypto = require('crypto');
  const secret = 'test_secret';
  const body = JSON.stringify({ event: 'cart.abandoned' });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const req = { headers: { 'x-razorpay-signature': signature }, rawBody: body, body: JSON.parse(body) };
  assert.equal(verifyRazorpaySignature(req, secret), true);
  assert.equal(verifyRazorpaySignature(req, 'bad_secret'), false);
});

test('Task 4 — system cart rules default to 25m / 4h / 36h (WS-3) with cart variable mappings', () => {
  assert.equal(CART_FOLLOWUP_DEFAULT_MINUTES.followup_1, 25);
  assert.equal(CART_FOLLOWUP_DEFAULT_MINUTES.followup_2, 4 * 60);
  assert.equal(CART_FOLLOWUP_DEFAULT_MINUTES.followup_3, 36 * 60);

  const presets = buildSystemAutomations();
  const f1 = presets.find((r) => r.id === 'sys_cart_followup_1');
  const f2 = presets.find((r) => r.id === 'sys_cart_followup_2');
  const f3 = presets.find((r) => r.id === 'sys_cart_followup_3');
  assert.equal(f1.delayMinutes, 25);
  assert.equal(f2.delayMinutes, 240);
  assert.equal(f3.delayMinutes, 2160);
  assert.deepEqual(f1.variableMappings.body, { 1: 'first_name', 2: 'product_name', 3: 'cart_total' });
  assert.deepEqual(f2.variableMappings.body, { 1: 'first_name', 2: 'product_name' });
  assert.equal(f3.variableMappings.body[4], 'discount_code');
});

test('Task 2 Step 5 — mergeSystemAutomations backfills empty cart mappings', () => {
  const merged = mergeSystemAutomations([
    {
      id: 'sys_cart_followup_1',
      templateName: 'cart_recovery_1',
      variableMappings: { body: {} },
      delayMinutes: 25,
    },
  ]);
  const rule = merged.find((r) => r.id === 'sys_cart_followup_1');
  assert.equal(rule.variableMappings.body['1'], 'first_name');
  assert.equal(rule.variableMappings.body['3'], 'cart_total');
});

test('Cart recovery — buildFollowupSteps returns 3-step ladder with sent/delivered/read', () => {
  const steps = buildFollowupSteps(
    {
      whatsappTemplatesSent: [
        { followupNumber: 1, sentAt: new Date(), deliveredAt: new Date() },
        { followupNumber: 2, sentAt: new Date(), readAt: new Date() },
      ],
    },
    { followups: [{ followupNumber: 1, label: 'Msg 1' }] },
    2
  );
  assert.equal(steps.length, 3);
  assert.equal(steps[0].status, 'delivered');
  assert.equal(steps[1].status, 'read');
  assert.equal(steps[2].status, 'pending');
});
