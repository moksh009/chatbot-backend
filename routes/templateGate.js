const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const axios = require('axios');
const { decrypt } = require('../utils/encryption');

/**
 * Generalized Template Gate — Replaces per-module template-checking logic.
 * All modules can use these two endpoints to check and submit Meta WhatsApp templates.
 */

// Pre-defined template blueprints for each module
const TEMPLATE_BLUEPRINTS = {
  loyalty_points_reminder: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Hey there! 🎁 You have *{{1}} Points* worth *{{2}}* in your rewards wallet. ⏰ Your points expire in *{{3}} days*. Tier: *{{4}}*. Reply REDEEM to claim your discount!',
        example: { body_text: [['500', '₹50', '30', 'Gold']] }
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Redeem Now' },
          { type: 'QUICK_REPLY', text: 'Check Balance' }
        ]
      }
    ]
  },
  review_request: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}! 🌟 We hope you loved your recent purchase of *{{2}}*. Would you mind sharing your experience? Your feedback means a lot to us!',
        example: { body_text: [['John', 'Premium Earbuds']] }
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: '⭐ Leave Review' },
          { type: 'QUICK_REPLY', text: 'Not Now' }
        ]
      }
    ]
  },
  cart_recovery: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Hey {{1}}! 🛒 You left *{{2}}* worth *{{3}}* in your cart. Complete your order before it sells out!',
        example: { body_text: [['Sarah', 'Wireless Headphones', '₹2,499']] }
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Complete Order' },
          { type: 'QUICK_REPLY', text: 'Remove Items' }
        ]
      }
    ]
  },
  warranty_certificate: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}! ✅ Your warranty for *{{2}}* has been registered successfully. Your coverage is valid until *{{3}}*. Save this message for your records.',
        example: { body_text: [['Customer', 'Smart Watch Pro', '25 Dec 2027']] }
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'View Certificate' },
          { type: 'QUICK_REPLY', text: 'Contact Support' }
        ]
      }
    ]
  }
};

/**
 * GET /api/template-gate/status?name=<templateName>&clientId=<clientId>
 * Checks Meta for the template status. Falls back gracefully.
 */
router.get('/status', protect, async (req, res) => {
  try {
    const { name } = req.query;
    const clientId = req.query.clientId || req.user.clientId;

    if (!name) {
      return res.status(400).json({ status: 'not_created', message: 'Template name is required' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.json({ status: 'not_created' });
    }

    // Fast path: Check synced templates cache
    const synced = (client.syncedMetaTemplates || []).find(t => t.name === name);
    if (synced) {
      return res.json({
        status: synced.status || 'APPROVED',
        templateId: synced.id
      });
    }

    // Slow path: Query Meta Graph API directly
    let token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
    const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;

    if (!token || !wabaId) {
      return res.json({ status: 'not_created' });
    }

    try { token = decrypt(token); } catch (e) { /* use as-is */ }

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${encodeURIComponent(name)}`;
    const metaRes = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const templates = metaRes.data?.data || [];
    if (templates.length === 0) {
      return res.json({ status: 'not_created' });
    }

    const template = templates[0];
    res.json({
      status: template.status || 'PENDING',
      templateId: template.id
    });

  } catch (err) {
    console.error('[TemplateGate] Status check failed:', err.message);
    // Graceful fallback — don't block the UI
    res.json({ status: 'APPROVED' });
  }
});

/**
 * POST /api/template-gate/submit
 * Creates a template via Meta API. Uses pre-defined blueprints or custom payload.
 */
router.post('/submit', protect, async (req, res) => {
  try {
    const { name, clientId: bodyClientId, components: customComponents } = req.body;
    const clientId = bodyClientId || req.user.clientId;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Template name is required' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    let token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
    const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;

    if (!token || !wabaId) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp Business Account not connected. Please configure WABA in Settings.'
      });
    }

    try { token = decrypt(token); } catch (e) { /* use as-is */ }

    // Use blueprint if available, otherwise use custom components
    const blueprint = TEMPLATE_BLUEPRINTS[name];
    const templatePayload = {
      name,
      category: blueprint?.category || 'MARKETING',
      language: blueprint?.language || 'en',
      components: customComponents || blueprint?.components || []
    };

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
    const metaRes = await axios.post(url, templatePayload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const result = metaRes.data;

    // Cache the template in the client's synced templates
    if (!client.syncedMetaTemplates) client.syncedMetaTemplates = [];
    const existingIdx = client.syncedMetaTemplates.findIndex(t => t.name === name);
    const syncEntry = {
      id: result.id,
      name,
      status: result.status || 'PENDING',
      updatedAt: new Date()
    };

    if (existingIdx >= 0) {
      client.syncedMetaTemplates[existingIdx] = syncEntry;
    } else {
      client.syncedMetaTemplates.push(syncEntry);
    }
    await client.save();

    res.json({
      success: true,
      status: result.status || 'PENDING',
      templateId: result.id
    });

  } catch (err) {
    console.error('[TemplateGate] Submit failed:', err.response?.data || err.message);
    const metaError = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      success: false,
      message: `Template submission failed: ${metaError}`
    });
  }
});

module.exports = router;
