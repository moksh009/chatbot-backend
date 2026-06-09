'use strict';

const crypto = require('crypto');
const Client = require('../../models/Client');
const {
  upsertAbandonedCartLead,
  markCartLeadPurchased,
} = require('../commerce/upsertAbandonedCartLead');
const { normalizeIndianPhone } = require('../core/normalizeIndianPhone');
const { invalidateStackContextCache } = require('./stackContext');
const log = require('../core/logger')('ThirdPartyCheckout');

const PROVIDER_KEYS = {
  gokwik: 'gokwik',
  razorpay_magic: 'razorpay_magic',
  razorpay: 'razorpay_magic',
  shiprocket: 'shiprocket_checkout',
  shiprocket_checkout: 'shiprocket_checkout',
  generic: 'generic',
};

function integrationKey(provider) {
  return PROVIDER_KEYS[provider] || 'generic';
}

function isProductionEnv() {
  return process.env.NODE_ENV === 'production';
}

function verifySecret(req, secret) {
  if (!secret) return !isProductionEnv();
  const header =
    req.headers['x-webhook-secret'] ||
    req.headers['x-topedge-secret'] ||
    req.headers['x-gokwik-signature'] ||
    '';
  if (header && String(header) === String(secret)) return true;
  const bodySecret = req.body?.secret || req.body?.webhook_secret;
  if (bodySecret && String(bodySecret) === String(secret)) return true;
  return false;
}

function verifyRazorpaySignature(req, secret) {
  if (!secret) return !isProductionEnv();
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return false;
  const body = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (String(signature).length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function isGoKwikAbandonedCart(body = {}) {
  return Boolean(body.custPhone || body.abandonLink || body.recoverStatus || body.cartId);
}

function isRazorpayAbandonedCart(body = {}) {
  const event = body.event || body.type;
  return event === 'cart.abandoned' || Boolean(body.payload?.contact);
}

function isShiprocketAbandonedCart(body = {}) {
  return Boolean(body.customer_phone || body.checkout_link || body.cart_total);
}

function normalizeGoKwikPayload(body = {}) {
  return {
    phone: body.custPhone,
    email: body.custEmail,
    customerName: body.custName,
    cartItems: (body.line_items || []).map((item) => ({
      productName: item.productName,
      productQuantity: item.productQuantity,
      productVariant: item.productVariant,
      productPrice: item.productPrice,
      variant_id: item.productVariant,
    })),
    cartTotal: body.cartTotal ?? body.subtotal,
    checkoutUrl: body.abandonLink,
    checkoutToken: body.cartId,
    recoverStatus: body.recoverStatus,
    source: 'gokwik',
    optInSource: 'gokwik_checkout',
  };
}

function normalizeRazorpayPayload(body = {}) {
  const p = body.payload || body;
  return {
    phone: p.contact,
    email: p.email,
    customerName: p.customer_name || p.name,
    cartItems: (p.cart_items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      image: item.image,
    })),
    cartTotal: p.cart_value ?? p.amount,
    checkoutUrl: p.checkout_url,
    checkoutToken: p.checkout_token || p.cart_id,
    source: 'razorpay_magic',
    optInSource: 'razorpay_checkout',
  };
}

function normalizeShiprocketPayload(body = {}) {
  return {
    phone: body.customer_phone || body.phone,
    email: body.customer_email || body.email,
    customerName: body.customer_name || body.name,
    cartItems: body.cart_items || body.line_items || [],
    cartTotal: body.cart_total ?? body.amount,
    checkoutUrl: body.checkout_link || body.checkout_url,
    checkoutToken: body.cart_id || body.checkout_id,
    source: 'shiprocket',
    optInSource: 'shiprocket_checkout',
  };
}

async function handleAbandonedCartWebhook(clientId, provider, req) {
  const body = req.body || {};
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { status: 404, body: { success: false, message: 'Client not found' } };

  let normalized;
  if (provider === 'gokwik' || isGoKwikAbandonedCart(body)) {
    normalized = normalizeGoKwikPayload(body);
  } else if (provider === 'razorpay_magic' || provider === 'razorpay' || isRazorpayAbandonedCart(body)) {
    normalized = normalizeRazorpayPayload(body);
  } else if (provider === 'shiprocket' || isShiprocketAbandonedCart(body)) {
    normalized = normalizeShiprocketPayload(body);
  } else {
    const { phone, email, name } = extractLegacyContact(body);
    normalized = {
      phone,
      email,
      customerName: name,
      cartItems: body.cart_items || [],
      cartTotal: body.cart_total || body.amount,
      checkoutUrl: body.checkout_url || body.checkout_link,
      source: `${provider}_checkout`,
      optInSource: `${provider}_checkout`,
    };
  }

  if (normalized.recoverStatus === 'RECOVERED' || body.recoverStatus === 'RECOVERED') {
    const purchased = await markCartLeadPurchased(clientId, {
      phone: normalized.phone,
      checkoutToken: normalized.checkoutToken,
      orderValue: normalized.cartTotal,
    });
    log.info(`GoKwik cart recovered: ${normalizeIndianPhone(normalized.phone) || normalized.checkoutToken}`);
    return { status: 200, body: { success: true, recovered: true, leadId: purchased.lead?._id } };
  }

  const phoneE164 = normalized.phone ? normalizeIndianPhone(normalized.phone) : null;
  if (!phoneE164 && !normalized.email) {
    return { status: 400, body: { success: false, reason: 'missing_phone' } };
  }

  const result = await upsertAbandonedCartLead(client, {
    clientId,
    phone: phoneE164,
    email: normalized.email,
    customerName: normalized.customerName,
    cartItems: normalized.cartItems,
    cartTotal: normalized.cartTotal,
    checkoutUrl: normalized.checkoutUrl,
    checkoutToken: normalized.checkoutToken,
    source: normalized.source,
    optStatus: 'opted_in',
    optInSource: normalized.optInSource,
    cartStatus: 'abandoned',
  });

  if (phoneE164) {
    log.info(`${normalized.source} abandoned cart received: ${phoneE164}`);
  }

  return {
    status: result.success ? 200 : 400,
    body: { success: result.success, leadId: result.lead?._id, phone: phoneE164 },
  };
}

function extractLegacyContact(body) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : body;
  const phone =
    body.custPhone ||
    payload?.custPhone ||
    payload?.contact ||
    body.contact ||
    body.phone ||
    body.mobile ||
    body.customer_phone ||
    body?.customer?.phone;
  const email =
    body.custEmail ||
    payload?.custEmail ||
    payload?.email ||
    body.email ||
    body.customer_email ||
    body?.customer?.email;
  const name =
    body.custName ||
    payload?.custName ||
    payload?.customer_name ||
    body.name ||
    body.customer_name ||
    body?.customer?.name ||
    'Checkout Customer';
  return { phone, email, name };
}

async function upsertCheckoutLead({ clientId, provider, phone, email, name, strategy, orderId }) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { success: false, reason: 'client_not_found' };

  const phoneE164 = phone ? normalizeIndianPhone(phone) : null;
  if (!phoneE164) return { success: false, reason: 'missing_phone' };

  const explicit = strategy === 'explicit';
  const optStatus = explicit ? 'unknown' : 'opted_in';
  const optInSource = explicit ? `${provider}_post_purchase_pending` : `${provider}_post_purchase`;

  const result = await upsertAbandonedCartLead(client, {
    clientId,
    phone: phoneE164,
    email,
    customerName: name,
    source: `${provider}_checkout`,
    optStatus,
    optInSource,
    cartStatus: 'abandoned',
    cartItems: [],
    logActivity: false,
  });

  if (explicit && phoneE164 && result.lead) {
    try {
      const TaskQueueService = require('../messaging/taskQueueService');
      await TaskQueueService.addTask('THIRD_PARTY_OPTIN_FOLLOWUP', {
        clientId,
        leadId: result.lead._id,
        phone: phoneE164,
        provider,
      });
    } catch (e) {
      log.warn(`Opt-in follow-up queue skipped: ${e.message}`);
    }
  }

  return { success: result.success, leadId: result.lead?._id, optStatus };
}

async function handleThirdPartyWebhook(clientId, provider, req) {
  const key = integrationKey(provider);
  const client = await Client.findOne({ clientId }).select('audienceContext businessName').lean();
  if (!client) return { status: 404, body: { success: false, message: 'Client not found' } };

  const ints = client.audienceContext?.integrations || {};
  const cfg = ints[key] || {};
  const secret = cfg.webhookSecret;

  if (provider === 'razorpay_magic' || provider === 'razorpay') {
    if (!verifyRazorpaySignature(req, secret)) {
      return { status: 401, body: { success: false, message: 'Invalid Razorpay signature' } };
    }
  } else if (!verifySecret(req, secret)) {
    return { status: 401, body: { success: false, message: 'Invalid webhook secret' } };
  }

  const body = req.body || {};
  const isAbandoned =
    isGoKwikAbandonedCart(body) ||
    isRazorpayAbandonedCart(body) ||
    isShiprocketAbandonedCart(body) ||
    body.event === 'cart.abandoned';

  let result;
  if (isAbandoned) {
    result = await handleAbandonedCartWebhook(clientId, provider, req);
  } else {
    const { phone, email, name, orderId } = extractLegacyContact(body);
    const strategy = cfg.consentStrategy || 'explicit';
    const upsertResult = await upsertCheckoutLead({
      clientId,
      provider: provider === 'shiprocket_checkout' ? 'shiprocket' : provider,
      phone,
      email,
      name,
      strategy,
      orderId: body.orderId || body.order_id || body?.order?.id,
    });
    result = {
      status: upsertResult.success ? 200 : 400,
      body: { success: upsertResult.success, ...upsertResult },
    };
  }

  await Client.updateOne(
    { clientId },
    {
      $set: {
        [`audienceContext.integrations.${key}.lastWebhookAt`]: new Date(),
        'audienceContext.updatedAt': new Date(),
      },
    }
  );
  invalidateStackContextCache(clientId);

  return result;
}

function generateWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  handleThirdPartyWebhook,
  handleAbandonedCartWebhook,
  upsertCheckoutLead,
  verifySecret,
  verifyRazorpaySignature,
  generateWebhookSecret,
  integrationKey,
  normalizeGoKwikPayload,
};
