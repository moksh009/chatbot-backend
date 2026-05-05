/**
 * Storefront-facing growth endpoints — no Bearer auth (uses public embed key only).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const GrowthQrScan = require('../models/GrowthQrScan');
const { normalizePhoneDigits } = require('../utils/marketingConsent');

const router = express.Router();

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again shortly.' },
});

const WIDGET_TYPES = new Set([
  'popup',
  'spin_wheel',
  'exit_intent',
  'discount_bar',
  'checkout_optin',
  'mystery_gift',
  'embedded_form',
  'floating_button',
  'inline_form',
  'sticky_bar',
  'thank_you_page',
]);

router.post('/impression', async (req, res) => {
  try {
    const key = String(req.body.embedKey || req.body.key || '').trim();
    if (!key) return res.status(400).json({ success: false, message: 'embedKey required' });
    const widgetTypeRaw = String(req.body.widgetType || 'unknown').toLowerCase().trim();
    const widgetType = WIDGET_TYPES.has(widgetTypeRaw) ? widgetTypeRaw : 'unknown';
    const client = await Client.findOne({ growthEmbedPublicKey: key, growthEmbedEnabled: { $ne: false } })
      .select('clientId')
      .lean();
    if (!client) return res.status(404).json({ success: false, message: 'Unknown key' });
    await Client.updateOne(
      { clientId: client.clientId },
      {
        $inc: { [`growthWidgetConfig.impressions.${widgetType}`]: 1 },
        $set: { 'growthWidgetConfig.lastImpressionAt': new Date() },
      }
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/qr-redirect', async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();
    const source = String(req.query.source || 'qr').trim().slice(0, 50);
    if (!clientId) return res.status(400).send('Missing clientId');

    const client = await Client.findOne({ clientId })
      .select('clientId businessName phoneNumber platformVars.adminWhatsappNumber wabaAccounts.phoneNumber')
      .lean();
    if (!client) return res.status(404).send('Client not found');

    const phone =
      String(client.phoneNumber || '').replace(/\D/g, '') ||
      String(client?.platformVars?.adminWhatsappNumber || '').replace(/\D/g, '') ||
      String(client?.wabaAccounts?.[0]?.phoneNumber || '').replace(/\D/g, '');
    if (!phone) return res.status(400).send('WhatsApp number missing');

    const ipAddress = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').slice(0, 120);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);
    await GrowthQrScan.create({ clientId, source, ipAddress, userAgent, scannedAt: new Date() });

    const text = encodeURIComponent(`Hi! I'd like to receive updates from ${client.businessName || 'your brand'} (source:${source})`);
    const waLink = `https://wa.me/${phone}?text=${text}`;
    return res.redirect(302, waLink);
  } catch (e) {
    return res.status(500).send('Redirect failed');
  }
});

router.get('/config', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ success: false, reason: 'missing_key' });
    const client = await Client.findOne({ growthEmbedPublicKey: key })
      .select('growthEmbedEnabled growthWidgetConfig businessName brand.businessName')
      .lean();
    if (!client || client.growthEmbedEnabled === false) {
      return res.json({ success: false, reason: 'embed_disabled' });
    }
    const cfg = client.growthWidgetConfig || {};
    return res.json({
      success: true,
      widgetTypes: cfg.activeWidgets || ['floating_button'],
      branding: {
        color: cfg?.floatingButton?.color || '#25D366',
        logo: null,
        name: client.brand?.businessName || client.businessName || 'Our brand',
      },
      settings: cfg,
    });
  } catch (e) {
    console.error('[publicGrowth/config]', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/public/growth/subscribe
 * Body: embedKey, phone, consent (boolean), widgetType?, name?, pageUrl?
 */
router.post('/subscribe', subscribeLimiter, async (req, res) => {
  try {
    const embedKey = String(req.body.embedKey || req.body.embed_key || '').trim();
    const phoneNorm = normalizePhoneDigits(req.body.phone);
    const consent = req.body.consent === true || req.body.consent === 'true' || req.body.consent === '1';
    const widgetTypeRaw = String(req.body.widgetType || req.body.widget_type || 'embedded_form').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const widgetType = WIDGET_TYPES.has(widgetTypeRaw) ? widgetTypeRaw : 'embedded_form';
    const name = String(req.body.name || '').trim().slice(0, 120);
    const pageUrl = String(req.body.pageUrl || req.body.page_url || '').trim().slice(0, 2000);
    const spinPrize = String(req.body.prize || '').trim().slice(0, 80);
    const spinCode = String(req.body.prizeCode || '').trim().slice(0, 40);
    const ipAddress = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').slice(0, 120);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    if (!embedKey || embedKey.length < 16) {
      return res.status(400).json({ success: false, message: 'Invalid embed key' });
    }
    if (!phoneNorm) {
      return res.status(400).json({ success: false, message: 'Valid phone number required' });
    }
    if (!consent) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp marketing requires explicit consent',
      });
    }

    const client = await Client.findOne({
      growthEmbedPublicKey: embedKey,
      growthEmbedEnabled: { $ne: false },
      isActive: { $ne: false },
    })
      .select('clientId businessName growthEmbedEnabled brand.businessName growthCompliance growthWidgetConfig')
      .lean();

    if (!client) {
      return res.status(404).json({ success: false, message: 'Unknown or disabled embed key' });
    }

    const sourceField = `website_${widgetType}`;

    const doubleOptIn = client.growthWidgetConfig?.doubleOptInEnabled === true;
    const pendingCode = String(Math.floor(100000 + Math.random() * 900000));
    const setDoc = {
      optStatus: doubleOptIn ? 'pending' : 'opted_in',
      optInDate: new Date(),
      optInMethod: doubleOptIn ? 'double' : 'single',
      optInSource: sourceField,
      source: 'Website',
      lastInteraction: new Date(),
    };
    if (name) {
      setDoc.name = name;
      setDoc.isNameCustom = false;
      setDoc.nameSource = 'whatsapp';
    }
    if (widgetType === 'spin_wheel') {
      if (spinPrize) setDoc.spinWheelPrize = spinPrize;
      if (spinCode) setDoc.spinWheelCode = spinCode;
    }

    if (doubleOptIn) {
      setDoc.pendingOptInCode = pendingCode;
      setDoc.pendingOptInExpiry = new Date(Date.now() + 15 * 60 * 1000);
    }

    await AdLead.findOneAndUpdate(
      { clientId: client.clientId, phoneNumber: phoneNorm },
      {
        $set: setDoc,
        $setOnInsert: {
          phoneNumber: phoneNorm,
          clientId: client.clientId,
        },
        $push: {
          optInHistory: {
            $each: [
              {
                event: doubleOptIn ? 'pending' : 'opted_in',
                action: doubleOptIn ? 'pending' : 'opted_in',
                timestamp: new Date(),
                source: sourceField,
                method: doubleOptIn ? 'double' : 'single',
                pageUrl,
                ipAddress,
                userAgent,
                widgetType,
                note: pageUrl ? pageUrl.slice(0, 200) : 'Public embed subscribe',
              },
            ],
            $position: 0,
            $slice: 40,
          },
        },
      },
      { upsert: true, new: true }
    );

    if (doubleOptIn) {
      try {
        const WhatsApp = require('../utils/whatsapp');
        const clientDoc = await Client.findOne({ clientId: client.clientId });
        if (clientDoc) {
          await WhatsApp.sendText(
            clientDoc,
            phoneNorm,
            `Please confirm your WhatsApp subscription. Reply YES within 15 minutes to confirm updates from ${client.businessName || 'our brand'}.`
          );
        }
      } catch (sendErr) {
        console.warn('[publicGrowth/subscribe] double opt-in prompt failed', sendErr.message);
      }
      return res.status(200).json({
        success: true,
        status: 'pending',
        message: 'Confirmation message sent. Reply YES on WhatsApp to complete opt-in.',
      });
    }

    return res.status(200).json({
      success: true,
      status: 'opted_in',
      message: 'You are subscribed to WhatsApp updates from this brand.',
    });
  } catch (e) {
    console.error('[publicGrowth/subscribe]', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
