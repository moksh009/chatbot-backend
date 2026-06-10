const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const { tenantClientId } = require('../utils/core/queryHelpers');
const axios = require('axios');
const { decrypt } = require('../utils/core/encryption');
const { recordTemplateSubmission } = require('../services/templateLifecycleBridge');
const { getSlotByMetaName } = require('../constants/templateCatalog/catalog');

/**
 * Generalized Template Gate — Replaces per-module template-checking logic.
 * All modules can use these two endpoints to check and submit Meta WhatsApp templates.
 */

// Pre-defined template blueprints for each module
const TEMPLATE_BLUEPRINTS = {
  cart_recovery: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Hey {{1}}! 🛒\nYou left *{{2}}* worth *{{3}}* in your cart.\nComplete your order before it sells out!',
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
        text: 'Hi {{1}}! ✅\nYour warranty for *{{2}}* is registered.\nCoverage valid until *{{3}}*.\nSave this message for your records.',
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
  },
  admin_human_alert: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Admin alert: {{1}} ({{2}}) needs urgent support. Context: {{3}} Please open the inbox in the dashboard.',
        example: { body_text: [['Priya Sharma', '+919876543210', 'Asked for a human on checkout']] }
      },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'QUICK_REPLY', text: 'Open Inbox' }]
      }
    ]
  },
  /** Delivery tracking prebuilts — recommended on the Order messages
   *  shipment-status rules. Body positions match the default variable
   *  mappings in utils/commerce/commerceAutomationService ECO_TEMPLATE_BODY_MAPPINGS. */
  order_in_transit: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 📦 Your order {{2}} is on the way.\n\n' +
          'Track your package live here:\n{{3}}',
        example: { body_text: [['Priya', '#1042', 'https://track.example.com/AWB12345']] },
      },
    ],
  },
  order_out_for_delivery: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 🚚 Your order {{2}} is out for delivery and should reach you today.\n\n' +
          'Please keep your phone reachable for the delivery agent.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  order_delivered_update: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! ✅ Your order {{2}} has been delivered.\n\n' +
          'We hope you love it — reply here if anything is not right and we will sort it out.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  delivery_attempt_failed: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, the courier tried to deliver your order {{2}} today but could not complete the delivery.\n\n' +
          'Please reply with a good time to deliver, or share an alternate phone number / address so we can re-attempt it.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  /** RTO Protection — NDR rescue (must match `rtoProtectionService` body variable order). */
  rto_ndr_rescue: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, we could not complete delivery for order *{{2}}*.\n\n' +
          'Please reply in this chat with a *10-digit mobile number* or your *full address and PIN code* so we can try again.\n\n' +
          'Reference: {{3}}',
        example: { body_text: [['Priya', '#1042', '5678901234']] },
      },
    ],
  },
};

/**
 * GET /api/template-gate/status?name=<templateName>&clientId=<clientId>
 * Checks Meta for the template status. Falls back gracefully.
 */
router.get('/status', protect, async (req, res) => {
  try {
    const { name } = req.query;
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

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
    res.json({ status: 'UNKNOWN', reason: 'check_failed' });
  }
});

/**
 * POST /api/template-gate/submit
 * Creates a template via Meta API. Uses pre-defined blueprints or custom payload.
 */
router.post('/submit', protect, async (req, res) => {
  try {
    const { name, components: customComponents, category: reqCategory, language: reqLanguage } = req.body;
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

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
      category: blueprint?.category || reqCategory || 'MARKETING',
      language: blueprint?.language || reqLanguage || 'en',
      components: customComponents || blueprint?.components || [],
    };

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
    const metaRes = await axios.post(url, templatePayload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const result = metaRes.data;

    const slot = getSlotByMetaName(name);
    try {
      await recordTemplateSubmission({
        clientId,
        metaName: name,
        metaTemplateId: result.id || null,
        metaStatus: result.status || 'PENDING',
        components: templatePayload.components,
        category: templatePayload.category,
        language: templatePayload.language,
        source: 'gate_submit',
        catalogSlotId: slot?.id || null,
      });
    } catch (lifeErr) {
      console.warn('[TemplateGate] lifecycle:', lifeErr.message);
    }

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
