'use strict';

/**
 * Embedded Signup v4 routes
 *
 * POST /api/whatsapp/embedded-signup/complete
 *   — Atomic token exchange + phone registration + webhook subscription + Client update
 *
 * DELETE /api/whatsapp/embedded-signup/disconnect
 *   — Unsubscribe app from WABA + clear Client WA fields
 *
 * GET /api/whatsapp/embedded-signup/status
 *   — Extended connection status (connectionMethod, quality, etc.)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const ConnectionEvent = require('../models/ConnectionEvent');
const {
  exchangeCodeForToken,
  validateToken,
  getWABADetails,
  getPhoneNumberDetails,
  registerPhoneNumber,
  subscribeAppToWABA,
  unsubscribeAppFromWABA,
  generateRegistrationPin,
} = require('../utils/meta/embeddedSignupService');
const { logActivity } = require('../utils/core/activityLogger');
const log = require('../utils/core/logger')('EmbeddedSignupRoute');
const {
  resolveWhatsAppFields,
  isWhatsAppClientConnected,
} = require('../utils/core/connectionStatus');
const { invalidateClientCache } = require('../utils/core/clientCache');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function logEvent(clientId, sessionId, stage, extra = {}) {
  try {
    await ConnectionEvent.create({ clientId, sessionId, service: 'whatsapp_embedded_signup', stage, ...extra });
  } catch (e) {
    log.error('ConnectionEvent write failed', { stage, error: e.message });
  }
}

function errorEvent(category, message, metaErrorCode = null) {
  return { error: { category, message }, metadata: { metaErrorCode } };
}

// ─── POST /complete ──────────────────────────────────────────────────────────

router.post('/complete', protect, async (req, res) => {
  const clientId = req.user?.clientId;
  if (!clientId) return res.status(401).json({ success: false, message: 'Not authorised.' });

  const { code, sessionId, postMessagePayload } = req.body;

  if (!code || !sessionId || !postMessagePayload?.waba_id || !postMessagePayload?.phone_number_id) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: code, sessionId, postMessagePayload.waba_id, postMessagePayload.phone_number_id',
    });
  }

  const { waba_id: wabaId, phone_number_id: phoneNumberId, event: esEvent } = postMessagePayload;
  const isCoexistence = esEvent === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const userAgent = req.headers['user-agent'] || '';
  const startMs = Date.now();

  await logEvent(clientId, sessionId, 'popup_completed', {
    metadata: { wabaId, phoneNumberId, coexistence: isCoexistence, ip, userAgent },
  });

  // ── Step 1: Exchange code for token ──────────────────────────────────────
  await logEvent(clientId, sessionId, 'token_exchange_started', { metadata: { wabaId, phoneNumberId, ip } });

  const exchangeResult = await exchangeCodeForToken(code);
  if (!exchangeResult.ok) {
    await logEvent(clientId, sessionId, 'token_exchange_failed', errorEvent(exchangeResult.category, exchangeResult.message, exchangeResult.metaErrorCode));
    await logEvent(clientId, sessionId, 'failed', errorEvent(exchangeResult.category, exchangeResult.message));
    return res.status(422).json({ success: false, step: 'token_exchange', message: exchangeResult.message });
  }

  const { accessToken } = exchangeResult;
  await logEvent(clientId, sessionId, 'token_exchange_success', { metadata: { wabaId, phoneNumberId, ip } });

  // ── Step 2: Validate token ───────────────────────────────────────────────
  const tokenCheck = await validateToken(accessToken);
  if (!tokenCheck.ok) {
    await logEvent(clientId, sessionId, 'failed', errorEvent(tokenCheck.category, tokenCheck.message));
    return res.status(422).json({ success: false, step: 'token_validation', message: tokenCheck.message });
  }

  // ── Step 3: Validate WABA ownership ─────────────────────────────────────
  const wabaCheck = await getWABADetails(wabaId, accessToken);
  if (!wabaCheck.ok) {
    await logEvent(clientId, sessionId, 'failed', errorEvent(wabaCheck.category, wabaCheck.message));
    return res.status(422).json({ success: false, step: 'waba_validation', message: wabaCheck.message });
  }

  // ── Step 4: Get phone number details ─────────────────────────────────────
  const phoneCheck = await getPhoneNumberDetails(phoneNumberId, accessToken);
  if (!phoneCheck.ok) {
    await logEvent(clientId, sessionId, 'failed', errorEvent(phoneCheck.category, phoneCheck.message));
    return res.status(422).json({ success: false, step: 'phone_lookup', message: phoneCheck.message });
  }
  const { displayPhoneNumber, verifiedName, qualityRating } = phoneCheck.phoneNumber;

  // ── Step 5: Register phone (skip for coexistence) ────────────────────────
  let registrationPin = null;
  if (!isCoexistence) {
    registrationPin = generateRegistrationPin();
    const regResult = await registerPhoneNumber(phoneNumberId, accessToken, registrationPin);
    if (!regResult.ok) {
      await logEvent(clientId, sessionId, 'failed', errorEvent(regResult.category, regResult.message, regResult.metaErrorCode));
      return res.status(422).json({ success: false, step: 'phone_registration', message: regResult.message });
    }
    await logEvent(clientId, sessionId, 'phone_registered', { metadata: { wabaId, phoneNumberId, ip } });
  }

  // ── Step 6: WABA collision check (before subscription to avoid unnecessary side-effects) ──
  const collision = await Client.findOne({
    wabaId,
    whatsappConnectionType: 'embedded_signup',
    clientId: { $ne: clientId },
  }).select('clientId').lean();

  if (collision) {
    await logEvent(clientId, sessionId, 'failed', errorEvent('validation', 'WABA already connected to another TopEdge account.'));
    return res.status(409).json({
      success: false,
      step: 'collision_check',
      message: 'This WhatsApp Business Account is already connected to another TopEdge account.',
    });
  }

  // ── Step 7: Subscribe app to WABA webhooks ───────────────────────────────
  // Hard failure: if webhook subscription fails, do NOT write partial Client fields.
  // The Client document remains unchanged on any failure before Step 8.
  const subResult = await subscribeAppToWABA(wabaId, accessToken);
  if (!subResult.ok) {
    await logEvent(clientId, sessionId, 'failed', errorEvent('webhook_subscription', subResult.message || 'Webhook subscription failed. No client fields written.'));
    return res.status(502).json({
      success: false,
      step: 'webhook_subscription',
      message: 'Could not subscribe to Meta webhooks. Please try again in a few seconds.',
    });
  }
  const webhookSubscribed = true;
  await logEvent(clientId, sessionId, 'webhook_subscribed', { metadata: { wabaId, phoneNumberId, ip } });

  // ── Step 8: Persist to Client ─────────────────────────────────────────────
  const updatePayload = {
    wabaId,
    phoneNumberId,
    whatsappToken: accessToken,          // encrypted by Client pre-save hook
    whatsappDisplayPhoneNumber: displayPhoneNumber,
    whatsappVerifiedName: verifiedName,
    whatsappQualityRating: qualityRating,
    whatsappConnectionType: 'embedded_signup',
    whatsappCoexistence: isCoexistence,
    whatsappWebhookSubscribed: webhookSubscribed,
    whatsappConnectedAt: new Date(),
    whatsappConnectionMethod: 'embedded_signup_v4',
    whatsappAccountStatus: 'active',
    whatsappRestricted: false,
  };

  if (registrationPin) {
    updatePayload.whatsappRegistrationPin = registrationPin; // encrypted by pre-save
  }

  try {
    await Client.findOneAndUpdate({ clientId }, { $set: updatePayload }, { new: true });
    invalidateClientCache(clientId);
  } catch (dbErr) {
    log.error('Client update failed after successful ES', { clientId, error: dbErr.message });
    await logEvent(clientId, sessionId, 'failed', errorEvent('other', 'Database write failed after successful Meta connection.'));
    return res.status(500).json({
      success: false,
      step: 'client_update',
      message: 'Connected to Meta successfully but could not save to database. Please contact support.',
    });
  }

  // ── Step 9: Quality rating history ───────────────────────────────────────
  await Client.findOneAndUpdate(
    { clientId },
    { $push: { whatsappQualityHistory: { $each: [{ rating: qualityRating, changedAt: new Date() }], $slice: -30 } } }
  );

  // ── Step 10: Audit log + finalize ────────────────────────────────────────
  await logEvent(clientId, sessionId, 'connection_finalized', {
    metadata: {
      wabaId,
      phoneNumberId,
      coexistence: isCoexistence,
      durationMs: Date.now() - startMs,
      ip,
      userAgent,
    },
  });

  await logActivity(clientId, {
    type: 'integration.whatsapp.connected_via_embedded_signup',
    title: 'WhatsApp Connected via Embedded Signup',
    description: `${verifiedName} (${displayPhoneNumber}) connected via Embedded Signup v4${isCoexistence ? ' [Coexistence]' : ''}.`,
    severity: 'info',
  }).catch(() => {});

  // Trigger async template sync (best effort)
  try {
    const { pollPendingMetaTemplatesForClient } = require('../services/templateLifecycleBridge');
    if (typeof pollPendingMetaTemplatesForClient === 'function') {
      pollPendingMetaTemplatesForClient(clientId).catch(() => {});
    }
  } catch (_) {}

  return res.json({
    success: true,
    connection: {
      wabaId,
      phoneNumberId,
      displayPhoneNumber,
      verifiedName,
      qualityRating,
      connectionType: 'embedded_signup',
      coexistence: isCoexistence,
      webhookSubscribed,
    },
  });
});

// ─── DELETE /disconnect ──────────────────────────────────────────────────────

router.delete('/disconnect', protect, async (req, res) => {
  const clientId = req.user?.clientId;
  if (!clientId) return res.status(401).json({ success: false, message: 'Not authorised.' });

  const { confirm } = req.body;
  if (confirm !== 'DISCONNECT') {
    return res.status(400).json({ success: false, message: 'Confirmation string must be "DISCONNECT".' });
  }

  const client = await Client.findOne({ clientId })
    .select('wabaId phoneNumberId whatsappToken whatsappConnectionType whatsappConnectionMethod')
    .lean();
  if (!isWhatsAppClientConnected(client)) {
    const partial = resolveWhatsAppFields(client);
    if (!partial.wabaId && !partial.phoneNumberId && !partial.tokenEnc) {
      return res.status(400).json({ success: false, message: 'No WhatsApp connection found.' });
    }
  }

  // Best-effort unsubscribe (don't fail disconnect if Meta call fails)
  if (client.whatsappConnectionType === 'embedded_signup' && client.whatsappToken) {
    const { decrypt } = require('../utils/core/encryption');
    const rawToken = decrypt ? decrypt(client.whatsappToken) : client.whatsappToken;
    if (rawToken) {
      await unsubscribeAppFromWABA(client.wabaId, rawToken).catch(() => {});
    }
  }

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        wabaId: '',
        phoneNumberId: '',
        whatsappToken: '',
        whatsappDisplayPhoneNumber: '',
        whatsappVerifiedName: '',
        whatsappConnectionType: '',
        whatsappCoexistence: false,
        whatsappWebhookSubscribed: false,
        whatsappConnectedAt: null,
        whatsappConnectionMethod: '',
        whatsappAccountStatus: 'active',
        whatsappRestricted: false,
        whatsappQualityRating: 'UNKNOWN',
        whatsappRegistrationPin: '',
        'whatsapp.accessToken': '',
        'whatsapp.phoneNumberId': '',
        'whatsapp.wabaId': '',
        'config.phoneNumberId': '',
        'config.wabaId': '',
        'config.whatsappToken': '',
      },
    }
  );

  await logActivity(clientId, {
    type: 'integration.whatsapp.disconnected',
    title: 'WhatsApp Disconnected',
    description: `WhatsApp connection removed by user.`,
    severity: 'warn',
  }).catch(() => {});

  invalidateClientCache(clientId);
  try {
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    const { invalidateBootstrapCache } = require('../utils/core/bootstrapCache');
    if (req.user?.id) invalidateBootstrapCache(req.user.id);
  } catch (_) {
    /* non-fatal */
  }

  return res.json({ success: true, message: 'WhatsApp disconnected.' });
});

// ─── GET /config ─────────────────────────────────────────────────────────────
// Runtime Embedded Signup flags for dashboard (avoids stale/missing Vite build env).

router.get('/config', protect, (req, res) => {
  const configId =
    process.env.META_ES_CONFIG_ID ||
    process.env.VITE_META_ES_CONFIG_ID ||
    '';
  const appId = process.env.META_APP_ID || '';
  const enabled = String(process.env.META_EMBEDDED_SIGNUP_ENABLED || 'true').toLowerCase() !== 'false';
  const frontendUrl = (process.env.FRONTEND_URL || 'https://dash.topedgeai.com').replace(/\/$/, '');
  let dashboardHost = 'dash.topedgeai.com';
  try {
    dashboardHost = new URL(frontendUrl).hostname || dashboardHost;
  } catch (_) {
    /* keep default */
  }

  return res.json({
    success: true,
    enabled,
    configId: configId || null,
    appId: appId || null,
    configured: enabled && !!configId && !!appId,
    dashboardHost,
    metaDeveloperUrls: appId
      ? {
          app: `https://developers.facebook.com/apps/${appId}/`,
          fbLoginSettings: `https://developers.facebook.com/apps/${appId}/fb-login/settings/`,
        }
      : null,
    jssdkSetupRequired: true,
  });
});

// ─── GET /status ─────────────────────────────────────────────────────────────

router.get('/status', protect, async (req, res) => {
  const clientId = req.user?.clientId;
  if (!clientId) return res.status(401).json({ success: false });

  const client = await Client.findOne({ clientId })
    .select(
      'wabaId phoneNumberId whatsappDisplayPhoneNumber whatsappVerifiedName ' +
      'whatsappQualityRating whatsappWebhookSubscribed whatsappConnectionType ' +
      'whatsappCoexistence whatsappConnectedAt whatsappConnectionMethod ' +
      'whatsappAccountStatus whatsappRestricted whatsappMessagingLimit whatsappOnboardingCompleted'
    )
    .lean();

  if (!client) return res.status(404).json({ success: false });

  const resolved = resolveWhatsAppFields(client);
  const isConnected = isWhatsAppClientConnected(client);
  const connectionType = client.whatsappConnectionType || '';
  let connectionMethod = client.whatsappConnectionMethod || null;
  if (!connectionMethod && isConnected) {
    connectionMethod =
      connectionType === 'embedded_signup' ? 'embedded_signup_v4' : 'manual';
  }

  return res.json({
    success: true,
    connected: isConnected,
    connectionMethod,
    connectionType: connectionType || (isConnected ? 'manual' : null),
    phoneNumberId: resolved.phoneNumberId || null,
    wabaId: resolved.wabaId || null,
    coexistence: client.whatsappCoexistence || false,
    qualityRating: client.whatsappQualityRating || null,
    webhookSubscribed: client.whatsappWebhookSubscribed || false,
    accountStatus: client.whatsappAccountStatus || 'active',
    restricted: client.whatsappRestricted || false,
    messagingLimit: client.whatsappMessagingLimit || null,
    displayPhoneNumber: client.whatsappDisplayPhoneNumber || null,
    verifiedName: client.whatsappVerifiedName || null,
    connectedAt: client.whatsappConnectedAt || null,
  });
});

module.exports = router;
