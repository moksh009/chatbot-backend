'use strict';

const express = require('express');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { buildStackContext, invalidateStackContextCache } = require('../utils/audience/stackContext');
const { generateWebhookSecret } = require('../utils/audience/thirdPartyCheckoutHandler');

const router = express.Router();

function verifyClientAccess(req, res, clientId) {
  const cid = clientId || tenantClientId(req);
  if (!cid) {
    res.status(403).json({ success: false, message: 'Unauthorized' });
    return null;
  }
  if (req.user?.clientId && req.user.clientId !== cid && req.user?.role !== 'super-admin') {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return null;
  }
  return cid;
}

// GET /api/audience/stack-context/:clientId
router.get('/stack-context/:clientId', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.params.clientId);
    if (!clientId) return;
    const data = await buildStackContext(clientId);
    if (!data) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[AudienceStack] stack-context:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/audience/stack-context/:clientId
router.put('/stack-context/:clientId', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.params.clientId);
    if (!clientId) return;

    const { storePlatform, thirdPartyCheckout, manualOverride } = req.body || {};
    const updates = { 'audienceContext.updatedAt': new Date() };

    if (manualOverride) {
      if (storePlatform) updates['audienceContext.manualOverrides.storePlatform'] = storePlatform;
      if (thirdPartyCheckout) {
        updates['audienceContext.manualOverrides.thirdPartyCheckout'] = thirdPartyCheckout;
        updates['audienceContext.thirdPartyCheckout'] = thirdPartyCheckout;
        updates['audienceContext.checkoutSignal'] = 'merchant_declared';
      }
    } else {
      if (storePlatform) {
        updates['audienceContext.storePlatform'] = storePlatform;
        updates['audienceContext.manualOverrides.storePlatform'] = null;
      }
      if (thirdPartyCheckout) {
        updates['audienceContext.thirdPartyCheckout'] = thirdPartyCheckout;
        updates['audienceContext.checkoutSignal'] = 'merchant_declared';
        updates['audienceContext.manualOverrides.thirdPartyCheckout'] = null;
      }
    }

    await Client.updateOne({ clientId }, { $set: updates });
    invalidateStackContextCache(clientId);
    const data = await buildStackContext(clientId);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[AudienceStack] put stack-context:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/audience/widget-install-check/:clientId
router.get('/widget-install-check/:clientId', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.params.clientId);
    if (!clientId) return;

    const client = await Client.findOne({ clientId })
      .select('shopDomain shopifyAccessToken growthWidgetConfig growthEmbedPublicKey growthEmbedEnabled')
      .lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const lastAt = client.growthWidgetConfig?.lastImpressionAt;
    const detected =
      lastAt && Date.now() - new Date(lastAt).getTime() < 120 * 1000;

    res.json({
      success: true,
      detected,
      domain: client.shopDomain || null,
      lastImpressionAt: lastAt || null,
      installMethod: client.shopifyAccessToken ? 'shopify_theme' : 'manual_snippet',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/audience/growth-snippet-inject/:clientId
router.post('/growth-snippet-inject/:clientId', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.params.clientId);
    if (!clientId) return;

    const doc = await Client.findOne({ clientId }).select('growthEmbedPublicKey shopDomain').lean();
    if (!doc?.growthEmbedPublicKey) {
      return res.status(400).json({ success: false, message: 'Generate embed key first' });
    }

    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const scriptUrl = `${backendUrl}/embed/growth-widget.js`;
    const snippet = `<script>window.TopEdgeGrowth={clientId:'${doc.growthEmbedPublicKey}'};</script>\n<script src="${scriptUrl}" data-embed-key="${doc.growthEmbedPublicKey}" async></script>`;

    const result = await injectGrowthSnippet(clientId, snippet, backendUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function injectGrowthSnippet(clientId, snippet, backendUrl) {
  const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');
  return withShopifyRetry(clientId, async (shop) => {
    const themesRes = await shop.get('/themes.json');
    const mainTheme = (themesRes.data.themes || []).find((t) => t.role === 'main');
    if (!mainTheme) throw new Error('Main theme not found');

    const assetRes = await shop.get(`/themes/${mainTheme.id}/assets.json`, {
      params: { 'asset[key]': 'layout/theme.liquid' },
    });
    let liquid = assetRes.data.asset?.value;
    if (!liquid) throw new Error('Could not read theme.liquid');

    const marker = 'TopEdge Growth Widget';
    if (liquid.includes(marker) || liquid.includes('growth-widget.js')) {
      return { success: true, message: 'Growth snippet already in theme' };
    }

    const tag = `\n<!-- ${marker} -->\n${snippet}\n`;
    if (liquid.includes('</body>')) {
      liquid = liquid.replace('</body>', `${tag}</body>`);
    } else {
      liquid += tag;
    }

    await shop.put(`/themes/${mainTheme.id}/assets.json`, {
      asset: { key: 'layout/theme.liquid', value: liquid },
    });
    return { success: true, message: 'Growth snippet injected into theme.liquid' };
  });
}

// POST /api/audience/integrations/:provider/connect
router.post('/integrations/:provider/connect', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.body?.clientId || tenantClientId(req));
    if (!clientId) return;

    const provider = String(req.params.provider || '').toLowerCase();
    const keyMap = {
      gokwik: 'gokwik',
      'razorpay-magic': 'razorpay_magic',
      razorpay_magic: 'razorpay_magic',
      shiprocket: 'shiprocket_checkout',
      'shiprocket-checkout': 'shiprocket_checkout',
      generic: 'generic',
    };
    const intKey = keyMap[provider];
    if (!intKey) return res.status(400).json({ success: false, message: 'Unknown provider' });

    const secret = generateWebhookSecret();
    const updates = {
      [`audienceContext.integrations.${intKey}.webhookSecret`]: secret,
      'audienceContext.updatedAt': new Date(),
    };
    if (req.body?.consentStrategy) {
      updates[`audienceContext.integrations.${intKey}.consentStrategy`] = req.body.consentStrategy;
    }
    if (provider === 'gokwik' && req.body?.apiKey) {
      updates['audienceContext.integrations.gokwik.apiKeySet'] = true;
    }

    await Client.updateOne({ clientId }, { $set: updates });
    invalidateStackContextCache(clientId);

    const origin = process.env.BACKEND_URL || 'https://api.topedge.com';
    const webhookPath =
      provider === 'gokwik'
        ? `gokwik/${clientId}`
        : provider.includes('razorpay')
          ? `razorpay-magic/${clientId}`
          : provider.includes('shiprocket')
            ? `shiprocket-checkout/${clientId}`
            : `third-party/${clientId}`;

    res.json({
      success: true,
      webhookUrl: `${origin}/api/webhooks/${webhookPath}`,
      webhookSecret: secret,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/audience/integrations/:provider/test
router.post('/integrations/:provider/test', protect, async (req, res) => {
  try {
    const clientId = verifyClientAccess(req, res, req.body?.clientId);
    if (!clientId) return;
    const provider = String(req.params.provider || '').toLowerCase();
    const key =
      provider.includes('razorpay') ? 'razorpay_magic' : provider.includes('shiprocket') ? 'shiprocket_checkout' : provider === 'gokwik' ? 'gokwik' : 'generic';

    await Client.updateOne(
      { clientId },
      { $set: { [`audienceContext.integrations.${key}.lastTestAt`]: new Date() } }
    );
    res.json({ success: true, message: 'Test recorded — send a webhook from your provider dashboard to confirm live capture' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
