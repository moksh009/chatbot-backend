const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :clientId
const loadClientConfig = require('../middleware/clientConfig');
const { protect, requireTenantMatch } = require('../middleware/auth');
const secure = [protect, requireTenantMatch];
const Client = require('../models/Client');
const InboundDeduplication = require('../models/InboundDeduplication');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { apiCache } = require('../middleware/apiCache');

// Legacy flow webhook handlers (per-client WhatsApp Flow callbacks)
const choiceSalonController = require('./clientcodes/choice_salon_holi');
const topedgeController = require('./clientcodes/topedgeai');
const genericEcommerceEngine = require('./engines/genericEcommerce');
const commerceAutomationService = require('../utils/commerce/commerceAutomationService');
const {
  hasWhatsAppWebhookPayload,
  touchInboundWebhook,
  touchMetaWebhookVerified,
} = require('../utils/meta/whatsappWebhookLifecycle');
const { isDuplicateInbound } = require('../utils/meta/webhookDedup');
const { getMetaWebhookVerifyQuery } = require('../utils/meta/metaHubQuery');
const { metaPayloadReplayGuard } = require('../middleware/webhookReplayGuard');

// Middleware to load client config
router.use(loadClientConfig);

// Integration Setup Endpoint (PUT)
router.put('/integrations', ...secure, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
       return res.status(403).json({ error: 'Unauthorized to update integrations for this client.' });
    }

    const updates = {};
    const allowedFields = [
      'shopDomain', 'shopifyAccessToken', 'shopifyWebhookSecret',
      'emailUser', 'emailAppPassword', 'wabaId'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    await Client.findOneAndUpdate({ clientId }, { $set: updates }, { new: true });
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);

    res.status(200).json({ success: true, message: 'Integrations updated successfully.', updates });
  } catch (err) {
    console.error(`[Integrations] Error updating integrations for ${req.params.clientId}:`, err);
    res.status(500).json({ error: 'Server error updating integrations.' });
  }
});

// Webhook Verification (GET)
router.get('/webhook', (req, res) => {
  const { mode, token, challenge } = getMetaWebhookVerifyQuery(req);

  // Verify token should match what's in the client config or a global verify token
  // Prioritize client-specific token, fallback to global env
  const VERIFY_TOKEN =
    req.clientConfig.verifyToken ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.VERIFY_TOKEN ||
    'my_verify_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log(`[Webhook Verification] SUCCESS for Client: ${req.clientConfig.clientId}`);
      touchMetaWebhookVerified(req.clientConfig.clientId).catch(() => {});
      return res.status(200).send(challenge);
    }
    console.warn(`[Webhook Verification] FAILED for Client: ${req.clientConfig.clientId} | Expected: ${VERIFY_TOKEN} | Received: ${token}`);
    return res.sendStatus(403);
  }
  console.warn(`[Webhook Verification] MISSING PARAMS for Client: ${req.clientConfig.clientId}`);
  return res.sendStatus(400);
});

// Webhook Event Handling (POST) — replay guard before signature / HMAC work
router.post('/webhook', metaPayloadReplayGuard(), async (req, res) => {
  try {
    if (req.webhookReplayDuplicate) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    const { businessType, clientId } = req.clientConfig;

    const entry = req.body?.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];
    const messageId = message?.id;

    if (!message?.from) {
      return res.sendStatus(200);
    }

    if (messageId && (await isDuplicateInbound(messageId, clientId, message?.from))) {
      console.log(`[Webhook Router] Duplicate skipped ${messageId} for ${clientId}`);
      return res.sendStatus(200);
    }

    if (hasWhatsAppWebhookPayload(req.body)) {
      touchInboundWebhook(clientId).catch(() => {});
    }

    console.log(`[Webhook Router] INCOMING POST -> Client: ${clientId} | Type: ${businessType} | Flow: EcommerceEngine`);
    await genericEcommerceEngine.handleWebhook(req, res);
  } catch (error) {
    console.error(`[Webhook Router] FATAL ERROR for Client: ${req.clientConfig?.clientId || 'Unknown'}:`, error.message);
    res.sendStatus(500);
  }
});

// Configuration Sync Endpoints (GET/PATCH)
// Used for Order Trigger Mappings & Niche Data
router.get('/config', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' || 
                        req.user.clientId === clientId || 
                        (req.user.linkedClients && req.user.linkedClients.includes(clientId));

    if (!isAuthorized) {
       return res.status(403).json({ error: 'Unauthorized configuration access.' });
    }
    const client = await Client.findOne({ clientId }).select('-shopifyAccessToken -emailAppPassword');
    if (!client) return res.status(404).json({ error: 'Client configuration not found.' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error fetching config.' });
  }
});

router.patch('/config', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' || 
                        req.user.clientId === clientId || 
                        (req.user.linkedClients && req.user.linkedClients.includes(clientId));

    if (!isAuthorized) {
       return res.status(403).json({ error: 'Unauthorized configuration update.' });
    }
    
    // Whitelist allowable fields for dynamic patching
    const { nicheData, instagramConnected, isGenericBot, rtoProtection } = req.body;
    const updates = {};
    
    // Surgical update for nicheData to prevent overwriting other keys
    if (nicheData && typeof nicheData === 'object') {
      if (nicheData.orderStatusTemplates) {
        const {
          validateOrderStatusTemplates,
          sanitizeOrderStatusTemplates,
        } = require('../utils/commerce/orderStatusTemplatePolicy');
        const commerceAutomationService = require('../utils/commerce/commerceAutomationService');
        const clientRow = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
        const validation = validateOrderStatusTemplates(
          nicheData.orderStatusTemplates,
          clientRow?.syncedMetaTemplates || []
        );
        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            error: validation.errors[0]?.message || 'Invalid order status template mapping',
            errors: validation.errors,
            warnings: validation.warnings,
          });
        }
        const syncResult = await commerceAutomationService.syncOrderStatusFromNicheMap(
          clientId,
          validation.sanitized
        );
        updates['nicheData.orderStatusTemplates'] = syncResult.sanitized;
      }

      Object.keys(nicheData).forEach((key) => {
        if (key === 'orderStatusTemplates') return;
        updates[`nicheData.${key}`] = nicheData[key];
      });
    }

    if (instagramConnected !== undefined) updates.instagramConnected = instagramConnected;
    if (isGenericBot !== undefined) updates.isGenericBot = isGenericBot;

    if (rtoProtection && typeof rtoProtection === 'object') {
      const allowed = [
        'requireCodConfirmation',
        'enableNdrRescue',
        'enableNdrAutoPush',
        'codConfirmationHours',
        'estimatedRtoCostPerOrder',
        'ndrTemplateName',
        'ndrTemplateLanguage',
      ];
      for (const key of allowed) {
        if (rtoProtection[key] !== undefined) {
          updates[`rtoProtection.${key}`] = rtoProtection[key];
        }
      }
      if (rtoProtection.enableNdrRescue === true) {
        const clientRow = await Client.findOne({ clientId }).select('syncedMetaTemplates rtoProtection').lean();
        const tplName = String(
          rtoProtection.ndrTemplateName || clientRow?.rtoProtection?.ndrTemplateName || 'rto_ndr_rescue'
        )
          .trim()
          .toLowerCase();
        const approved = (clientRow?.syncedMetaTemplates || []).some(
          (t) =>
            String(t.name || '').toLowerCase() === tplName &&
            String(t.status || '').toUpperCase() === 'APPROVED'
        );
        if (!approved) {
          return res.status(400).json({
            success: false,
            error: `NDR template "${tplName}" must be approved on Meta before enabling rescue.`,
          });
        }
      }
    }

    const updated = await Client.findOneAndUpdate({ clientId }, { $set: updates }, { new: true })
      .select('-shopifyAccessToken -emailAppPassword -whatsappToken -whatsappAccessToken -metaAccessToken');
    const { clearClientCache } = require('../middleware/apiCache');
    const { invalidateBootstrapCache } = require('../utils/core/bootstrapCache');
    await clearClientCache(clientId);
    invalidateBootstrapCache(req.user?.id);
    res.json({
      success: true,
      rtoProtection: updated?.rtoProtection,
      nicheData: updates['nicheData.orderStatusTemplates'] ? { orderStatusTemplates: updated?.nicheData?.orderStatusTemplates } : undefined,
    });
  } catch (err) {
    console.error(`[Config Patch] Error for ${req.params.clientId}:`, err);
    res.status(500).json({ error: 'Failed to update configuration.' });
  }
});

router.get('/commerce-automations', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    let automations;
    try {
      automations = await commerceAutomationService.ensureSystemAutomationsPersisted(req.clientConfig);
    } catch (persistErr) {
      console.warn(`[commerce-automations] persist path failed for ${req.params.clientId}:`, persistErr.message);
      automations = commerceAutomationService.buildAutomationsFromConfig(req.clientConfig);
    }
    return res.json({
      success: true,
      automations,
      version: req.clientConfig.commerceAutomationVersion || commerceAutomationService.COMMERCE_AUTOMATION_VERSION || 2,
    });
  } catch (err) {
    try {
      const automations = commerceAutomationService.buildAutomationsFromConfig(req.clientConfig || {});
      return res.json({
        success: true,
        automations,
        version: commerceAutomationService.COMMERCE_AUTOMATION_VERSION || 2,
        warning: 'Loaded from cache — sync will retry automatically.',
      });
    } catch (fallbackErr) {
      console.error(`[commerce-automations] GET ${req.params.clientId}:`, err.message, fallbackErr.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to load commerce automations.',
        automations: [],
      });
    }
  }
});

router.get('/shopify-products-picker', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const { fetchShopifyProductsForClient } = require('../utils/commerce/shopifyProductsPicker');
    const result = await fetchShopifyProductsForClient(clientId, {
      query: req.query.q || req.query.query || '',
      limit: req.query.limit,
    });
    return res.json(result);
  } catch (err) {
    const { isMongoTransientError } = require('../utils/core/mongoRetry');
    const { SHOPIFY_RECONNECT_MESSAGE } = require('../utils/shopify/shopifyOAuthTokenExchange');
    let message = err.message || 'Failed to load Shopify products';
    if (isMongoTransientError(err)) {
      message = 'Database connection blip — please retry in a moment.';
    } else if (err.isShopifyAuthError || String(message).includes(SHOPIFY_RECONNECT_MESSAGE)) {
      message = 'Shopify session expired — open Settings → Connections and reconnect your store.';
    }
    console.error(`[shopify-products-picker] GET ${req.params.clientId}:`, err.message);
    return res.status(500).json({ success: false, error: message, message, products: [] });
  }
});

router.post('/commerce-automations', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const automation = await commerceAutomationService.upsertAutomation(clientId, req.body || {});
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, automation });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/order-messages/rules/:ruleId/toggle', ...secure, async (req, res) => {
  try {
    const { clientId, ruleId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const active = req.body?.active === true;
    const automation = await commerceAutomationService.toggleAutomation(clientId, ruleId, { active });
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, automation });
  } catch (err) {
    /** WS-2 H5 — expose `err.code` so the frontend can render actionable
     *  copy (e.g. "Template not approved — open Meta Manager"). */
    const status =
      err.status ||
      (/not found/i.test(err.message) ? 404 : 400);
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || null,
    });
  }
});

router.post('/commerce-automations/pause-batch', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, error: 'ids array is required' });
    }
    const paused = await commerceAutomationService.pauseAutomationsBatch(clientId, ids);
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, pausedCount: paused.length, automations: paused });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/commerce-automations/:automationId', ...secure, async (req, res) => {
  try {
    const { clientId, automationId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const automation = await commerceAutomationService.upsertAutomation(clientId, {
      ...(req.body || {}),
      id: automationId,
    });
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, automation });
  } catch (err) {
    /** WS-2 H5 — expose `err.code` (TEMPLATE_NOT_APPROVED, TEMPLATE_REQUIRED) */
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || null,
    });
  }
});

router.delete('/commerce-automations/:automationId', ...secure, async (req, res) => {
  try {
    const { clientId, automationId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const automations = await commerceAutomationService.deleteAutomation(clientId, automationId);
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, automations });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/commerce-automations/simulate', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });

    const result = commerceAutomationService.simulateAutomation({
      automation: req.body?.automation || {},
      order: req.body?.order || {},
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/logistics/profile', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { assertTenantAccess } = require('../utils/core/queryHelpers');
    const access = assertTenantAccess(req, clientId);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, error: access.message });
    }

    const { getLogisticsProfile } = require('../services/logisticsEligibilityService');
    const profile = await getLogisticsProfile(clientId);
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(err.message === 'Client not found' ? 404 : 500).json({ success: false, error: err.message });
  }
});

router.patch('/logistics/settings', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { assertTenantAccess } = require('../utils/core/queryHelpers');
    const access = assertTenantAccess(req, clientId);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, error: access.message });
    }

    const { updateLogisticsSettings } = require('../services/logisticsEligibilityService');
    const profile = await updateLogisticsSettings(clientId, req.body || {});
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(clientId);
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/commerce-automations/diagnostics', ...secure, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' ||
      req.user.clientId === clientId ||
      (req.user.linkedClients && req.user.linkedClients.includes(clientId));
    if (!isAuthorized) return res.status(403).json({ error: 'Unauthorized' });
    const automations = await commerceAutomationService.listAutomations(req.clientConfig);
    let cronHealth = { lastTickAt: null, stale: null };
    try {
      const { getAppRedis } = require('../utils/core/redisFactory');
      const redis = getAppRedis();
      if (redis && redis.status === 'ready') {
        const last = await redis.get('cron:last_tick');
        if (last) {
          const ageMs = Date.now() - Number(last);
          cronHealth = {
            lastTickAt: new Date(Number(last)).toISOString(),
            ageMinutes: Math.round(ageMs / 60000),
            stale: ageMs > 10 * 60 * 1000,
          };
        }
      }
    } catch (_) { /* non-blocking */ }
    return res.json({
      success: true,
      migrated: (req.clientConfig.commerceAutomationVersion || 0) > 0,
      version: req.clientConfig.commerceAutomationVersion || 0,
      automationCount: automations.length,
      hasLegacySkuConfig: Array.isArray(req.clientConfig.skuAutomations) && req.clientConfig.skuAutomations.length > 0,
      hasLegacyStatusMap: !!Object.keys(req.clientConfig.nicheData?.orderStatusTemplates || {}).length,
      cronHealth,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Instagram Webhooks (Dynamic)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require("crypto");
const { runDualBrainEngine } = require('../utils/commerce/dualBrainEngine');

// Verification handshake for Instagram Messenger API
router.get("/webhook/instagram", async (req, res) => {
  const { mode, token, challenge } = getMetaWebhookVerifyQuery(req);
  
  try {
    const client = req.clientConfig;
    // Reuse the same verify token as WhatsApp for simplicity (or let it be defined in Client)
    const clientVerifyToken = client.verifyToken || "topedge_ai_handshake";

    if (mode === "subscribe" && token === clientVerifyToken) {
      console.log(`[Instagram Webhook] Verified for client: ${client.clientId}`);
      return res.status(200).send(challenge);
    }
    console.warn(`[Instagram Webhook] Verification FAILED for ${client.clientId}. Expected: ${clientVerifyToken}, Got: ${token}`);
    res.sendStatus(403);
  } catch (err) {
    console.error("[Instagram Webhook] GET Error:", err.message);
    res.sendStatus(500);
  }
});

// Handle incoming Instagram DM events
router.post("/webhook/instagram", async (req, res) => {
  try {
    const client = req.clientConfig;
    if (!client?.instagramConnected) return res.sendStatus(200);
    
    // Verify Signature if appSecret is present
    if (client.instagramAppSecret) {
      const signature = req.get("x-hub-signature-256");
      if (signature && req.rawBody) {
        const elements = signature.split("=");
        const signatureHash = elements[1];
        const expectedHash = crypto.createHmac("sha256", client.instagramAppSecret).update(req.rawBody).digest("hex");
        if (signatureHash !== expectedHash) {
          console.error(`[Instagram Webhook] Invalid signature for ${client.clientId}`);
          return res.sendStatus(403);
        }
      }
    }

    res.sendStatus(200); // Meta requirement
    
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (event.message && !event.message.is_echo) {
            const parsedMessage = {
                from:      event.sender.id,
                profileName: "",
                type:      "text",
                text:      { body: event.message.text || "" },
                messageId: event.message.mid,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        } else if (event.postback) {
            const parsedMessage = {
                from:      event.sender.id,
                type:      "interactive",
                interactive: {
                    type: "button_reply",
                    button_reply: { id: event.postback.payload, title: event.postback.title || "" }
                },
                messageId: event.postback.mid || `pb_${event.timestamp}`,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        }
      }
    }
  } catch (err) {
    console.error("[Instagram Webhook] POST Error:", err.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

router.post('/webhook/flow-endpoint', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'choice_salon') {
      await choiceSalonController.handleFlowWebhook(req, res);
    } else if (businessType === 'choice_salon_new') {
      await choiceSalonController.handleFlowWebhook(req, res);
    } else if (businessType === 'agency') {
      await topedgeController.handleFlowWebhook(req, res);
    } else {
      res.status(404).send('Flow endpoint not supported for this client');
    }
  } catch (error) {
    console.error('Error in flow webhook handler:', error);
    res.status(500).send('Internal Server Error');
  }
});
router.post('/webhook/shopify/link-opened', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyLinkOpenedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/cart-update', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyCartUpdatedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/checkout-initiated', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyCheckoutInitiatedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/order-complete', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyOrderCompleteWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/order-fulfilled', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyOrderFulfilledWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/log-restore-event', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.logRestoreEvent(req, res);
    } else {
      res.status(400).send('Not supported for this business type');
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.get('/orders', ...secure, apiCache(120), async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.getClientOrders(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error fetching client orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/customer-refund-count', ...secure, async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.getCustomerRefundCount(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error fetching customer refund count:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.patch('/orders/:orderId/status', ...secure, async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.updateOrderStatus(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/orders/:orderId/send-status-whatsapp', ...secure, async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.sendOrderStatusWhatsAppManual(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error sending order status WhatsApp:', error);
    res.status(500).json({ error: 'Failed to send' });
  }
});

router.get('/messaging-activity/summary', ...secure, apiCache(45), async (req, res) => {
  try {
    const { buildMessagingActivitySummary } = require('../services/messagingActivityService');
    const summary = await buildMessagingActivitySummary(req.clientConfig);
    return res.json({ success: true, ...summary });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/order-messages/overview', ...secure, apiCache(60), async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.getOrderMessagesOverview(req, res);
    } else {
      res.status(400).json({ error: 'Order messages not supported for this business type' });
    }
  } catch (error) {
    console.error('Error loading order messages overview:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.patch('/orders/:orderId/address', ...secure, async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.updateOrderAddress(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error updating order address:', error);
    res.status(500).json({ error: 'Failed to update address' });
  }
});

router.get('/cart-snapshot', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.getCartSnapshot(req, res);
    } else {
      res.status(400).json({ error: 'Not supported for this business type' });
    }
  } catch (error) {
    console.error('Error fetching cart snapshot:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/restore-cart', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.restoreCart(req, res);
    } else {
      res.status(400).send('Not supported for this business type');
    }
  } catch (error) {
    console.error('Error restoring cart:', error);
    res.status(500).send('Failed');
  }
});

module.exports = router;
