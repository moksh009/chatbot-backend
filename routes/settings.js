const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

// Middleware to verify client access
const verifyClientAccess = (req, res, next) => {
  const { clientId } = req.params;
  if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

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

module.exports = router;
