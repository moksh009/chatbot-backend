const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');

async function ensureGrowthEmbedDoc(clientId) {
  let doc = await Client.findOne({ clientId }).select(
    'growthEmbedPublicKey growthEmbedEnabled growthCompliance growthWidgetConfig clientId'
  );
  if (!doc) return null;
  if (!doc.growthEmbedPublicKey || String(doc.growthEmbedPublicKey).length < 16) {
    const key = crypto.randomBytes(24).toString('hex');
    doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { growthEmbedPublicKey: key } },
      { new: true }
    ).select('growthEmbedPublicKey growthEmbedEnabled growthCompliance growthWidgetConfig clientId');
  }
  return doc;
}


router.put('/:clientId/working-hours', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { enabled, timezone, hours, afterHoursMessage } = req.body;
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { "workingHours.enabled": enabled, "workingHours.timezone": timezone, "workingHours.hours": hours, "workingHours.afterHoursMessage": afterHoursMessage } },
      { new: true }
    );
    res.json({ success: true, workingHours: client.workingHours });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/quick-replies', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { quickReplies } = req.body; // Array of objects
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { quickReplies } },
      { new: true }
    );
    res.json({ success: true, quickReplies: client.quickReplies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/escalation-rules', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { escalationRules } = req.body; 
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { escalationRules } },
      { new: true }
    );
    res.json({ success: true, escalationRules: client.escalationRules });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/knowledge-base', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { knowledgeBase } = req.body; 
    
    // Auto-generate systemPrompt based on knowledge base
    const promptParts = [];
    if (knowledgeBase.about) promptParts.push(`ABOUT BUSINESS:\n${knowledgeBase.about}`);
    if (knowledgeBase.products && knowledgeBase.products.length > 0) {
      promptParts.push(`PRODUCTS/SERVICES:\n${knowledgeBase.products.map(p => `- ${p.name}: ${p.price} - ${p.description} (${p.url})`).join('\n')}`);
    }
    if (knowledgeBase.faqs && knowledgeBase.faqs.length > 0) {
      promptParts.push(`FAQS:\n${knowledgeBase.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n')}`);
    }
    if (knowledgeBase.returnPolicy) promptParts.push(`RETURN POLICY:\n${knowledgeBase.returnPolicy}`);
    if (knowledgeBase.shippingPolicy) promptParts.push(`SHIPPING POLICY:\n${knowledgeBase.shippingPolicy}`);
    if (knowledgeBase.contact) promptParts.push(`CONTACT INFO:\nPhone: ${knowledgeBase.contact.phone}\nEmail: ${knowledgeBase.contact.email}\nAddress: ${knowledgeBase.contact.address}`);
    if (knowledgeBase.tone) promptParts.push(`REQUIRED TONE:\n${knowledgeBase.tone}`);

    const systemPrompt = promptParts.join('\n\n');
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { knowledgeBase, systemPrompt } },
      { new: true }
    );
    res.json({ success: true, knowledgeBase: client.knowledgeBase, systemPrompt: client.systemPrompt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/custom-variables', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId }).select('customVariables').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, customVariables: client.customVariables || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/custom-variables', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { customVariables } = req.body; // Array of objects
    
    if (Array.isArray(customVariables)) {
      for (const v of customVariables) {
        if (v.validationRegex) {
          try {
            new RegExp(v.validationRegex);
          } catch(e) {
            return res.status(400).json({ success: false, message: `Invalid regex pattern in variable ${v.name}` });
          }
        }
      }
    }
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { customVariables } },
      { new: true }
    );
    res.json({ success: true, customVariables: client.customVariables });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GAP 1: Canonical source syncing for AI Persona
router.put('/:clientId/ai-persona', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { 
      botName, tone, language, knowledgeBase, 
      emojiLevel, signaturePhrases, avoidTopics, autoTranslate, systemPrompt 
    } = req.body;
    
    // Canonical Path: Mutating client.ai.persona definitively
    const client = await Client.findOneAndUpdate(
      { clientId },
      { 
        $set: { 
          "ai.persona.name": botName,
          "ai.persona.tone": tone,
          "ai.persona.language": language,
          "ai.persona.knowledgeBase": knowledgeBase,
          "ai.persona.emojiLevel": emojiLevel,
          "ai.persona.signaturePhrases": signaturePhrases,
          "ai.persona.avoidTopics": avoidTopics,
          "ai.persona.autoTranslate": autoTranslate,
          "ai.systemPrompt": systemPrompt // Flat level system prompt override
        } 
      },
      { new: true }
    );
    res.json({ success: true, persona: client.ai.persona, systemPrompt: client.ai.systemPrompt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- Storefront WhatsApp opt-in embed (Marketing compliance) ---
router.get('/:clientId/growth-embed', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const doc = await ensureGrowthEmbedDoc(clientId);
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      embedKey: doc.growthEmbedPublicKey,
      enabled: doc.growthEmbedEnabled !== false,
      compliance: doc.growthCompliance || {},
      widgetConfig: doc.growthWidgetConfig || {},
      subscribeUrl: `${origin}/api/public/growth/subscribe`,
      configUrl: `${origin}/api/public/growth/config?key=${doc.growthEmbedPublicKey}`,
      scriptUrl: `${origin}/embed/growth-widget.js`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:clientId/growth-embed/regenerate', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const key = crypto.randomBytes(24).toString('hex');
    const doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { growthEmbedPublicKey: key } },
      { new: true }
    ).select('growthEmbedPublicKey growthEmbedEnabled growthCompliance');
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      embedKey: doc.growthEmbedPublicKey,
      subscribeUrl: `${origin}/api/public/growth/subscribe`,
      scriptUrl: `${origin}/embed/growth-widget.js`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/growth-embed-enabled', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const enabled = req.body.enabled !== false;
    const doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { growthEmbedEnabled: enabled } },
      { new: true }
    ).select('growthEmbedEnabled');
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, enabled: doc.growthEmbedEnabled !== false });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const cartRecoveryRequiresOptIn = req.body.cartRecoveryRequiresOptIn === true;
    const doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { 'growthCompliance.cartRecoveryRequiresOptIn': cartRecoveryRequiresOptIn } },
      { new: true }
    ).select('growthCompliance');
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, compliance: doc.growthCompliance || {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/growth-widget-config', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const widgetConfig = req.body?.growthWidgetConfig || req.body || {};
    const doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { growthWidgetConfig: widgetConfig } },
      { new: true }
    ).select('growthWidgetConfig');
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, growthWidgetConfig: doc.growthWidgetConfig || {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
