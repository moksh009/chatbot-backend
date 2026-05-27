'use strict';

const crypto = require('crypto');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const { normalizeIndianPhone } = require('../core/normalizeIndianPhone');
const { normalizePhoneWithCountry } = require('../core/helpers');
const { invalidateStackContextCache } = require('./stackContext');
const log = require('../core/logger')('ThirdPartyCheckout');

const PROVIDER_KEYS = {
  gokwik: 'gokwik',
  razorpay_magic: 'razorpay_magic',
  shiprocket: 'shiprocket_checkout',
  shiprocket_checkout: 'shiprocket_checkout',
  generic: 'generic',
};

function integrationKey(provider) {
  return PROVIDER_KEYS[provider] || 'generic';
}

function verifySecret(req, secret) {
  if (!secret) return true;
  const header =
    req.headers['x-webhook-secret'] ||
    req.headers['x-topedge-secret'] ||
    req.headers['x-gokwik-signature'] ||
    '';
  if (header && String(header) === String(secret)) return true;
  const bodySecret = req.body?.secret || req.body?.webhook_secret;
  return bodySecret && String(bodySecret) === String(secret);
}

function extractContact(body) {
  const phone =
    body.phone ||
    body.mobile ||
    body.customer_phone ||
    body?.customer?.phone ||
    body?.order?.phone;
  const email = body.email || body.customer_email || body?.customer?.email;
  const name = body.name || body.customer_name || body?.customer?.name || 'Checkout Customer';
  const orderId = body.orderId || body.order_id || body?.order?.id;
  const amount = body.amount || body.total || body?.order?.amount;
  return { phone, email, name, orderId, amount };
}

async function upsertCheckoutLead({ clientId, provider, phone, email, name, strategy, orderId }) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { success: false, reason: 'client_not_found' };

  const normalizedPhone = phone
    ? normalizeIndianPhone(phone) || normalizePhoneWithCountry(phone, client)
    : null;
  if (!normalizedPhone) return { success: false, reason: 'missing_phone' };
  const phoneStored = String(normalizedPhone).startsWith('+')
    ? normalizedPhone
    : `+${normalizedPhone}`;
  const phoneVariants = [phoneStored, phoneStored.replace(/^\+/, '')];

  const now = new Date();
  const sourceBase = `${provider}_checkout`;
  const explicit = strategy === 'explicit';

  const optStatus = explicit ? 'unknown' : 'opted_in';
  const optInSource = explicit ? `${provider}_post_purchase_pending` : `${provider}_post_purchase`;

  const lead = await AdLead.findOneAndUpdate(
    { clientId, phoneNumber: { $in: phoneVariants } },
    {
      $set: {
        optStatus,
        phoneNumber: phoneStored,
        ...(explicit ? {} : { optInDate: now, whatsappMarketingEligible: true }),
        optInSource,
        name: name || 'Checkout Customer',
        ...(email ? { email: String(email).trim().toLowerCase() } : {}),
        ...(orderId ? { lastOrderId: String(orderId) } : {}),
      },
      $push: {
        optInHistory: {
          $each: [
            {
              event: explicit ? 'capture_pending' : 'opted_in',
              action: explicit ? 'pending_explicit' : 'opted_in',
              timestamp: now,
              source: optInSource,
              note: `Third-party checkout (${provider})`,
            },
          ],
          $position: 0,
          $slice: 40,
        },
      },
      $setOnInsert: { clientId, phoneNumber: phoneStored, source: sourceBase, createdAt: now },
    },
    { upsert: true, new: true }
  );

  if (explicit && phoneStored) {
    try {
      const TaskQueueService = require('../messaging/taskQueueService');
      await TaskQueueService.addTask('THIRD_PARTY_OPTIN_FOLLOWUP', {
        clientId,
        leadId: lead._id,
        phone: phoneStored,
        provider,
      });
    } catch (e) {
      log.warn(`Opt-in follow-up queue skipped: ${e.message}`);
    }
  }

  return { success: true, leadId: lead._id, optStatus };
}

async function handleThirdPartyWebhook(clientId, provider, req) {
  const key = integrationKey(provider);
  const client = await Client.findOne({ clientId }).select('audienceContext businessName').lean();
  if (!client) return { status: 404, body: { success: false, message: 'Client not found' } };

  const ints = client.audienceContext?.integrations || {};
  const cfg = ints[key] || {};
  if (!verifySecret(req, cfg.webhookSecret)) {
    return { status: 401, body: { success: false, message: 'Invalid webhook secret' } };
  }

  const { phone, email, name, orderId } = extractContact(req.body || {});
  const strategy = cfg.consentStrategy || 'explicit';
  const result = await upsertCheckoutLead({
    clientId,
    provider: provider === 'shiprocket_checkout' ? 'shiprocket' : provider,
    phone,
    email,
    name,
    strategy,
    orderId,
  });

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

  return {
    status: result.success ? 200 : 400,
    body: { success: result.success, ...result },
  };
}

function generateWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  handleThirdPartyWebhook,
  upsertCheckoutLead,
  verifySecret,
  generateWebhookSecret,
  integrationKey,
};
