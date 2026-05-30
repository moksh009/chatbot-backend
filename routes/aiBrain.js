'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const Client = require('../models/Client');
const { normalizePersonaTone } = require('../utils/core/personaEngine');
const { callAI } = require('../utils/core/aiGateway');
const { buildPersonaSystemPrompt } = require('../utils/core/personaEngine');

const TONE_OPTIONS = [
  'Professional & Helpful',
  'Casual & Friendly',
  'Luxury & Exclusive',
  'Direct & Technical',
  'Enthusiastic & Salesy',
];

router.get('/persona', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const client = await Client.findOne({ clientId }).select('ai.persona knowledgeBase.faqs clientId').lean();
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    res.json({
      persona: client.ai?.persona || {},
      quickFaqs: client.knowledgeBase?.faqs || [],
      toneOptions: TONE_OPTIONS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/persona', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { name, tone, description, quickFaqs } = req.body || {};
    const updates = {};

    if (name !== undefined) updates['ai.persona.name'] = String(name).slice(0, 120);
    if (tone !== undefined) {
      const normalized = normalizePersonaTone(tone);
      if (normalized) updates['ai.persona.tone'] = normalized;
    }
    if (description !== undefined) {
      updates['ai.persona.description'] = String(description).slice(0, 4000);
    }
    if (Array.isArray(quickFaqs)) {
      updates['knowledgeBase.faqs'] = quickFaqs
        .filter((f) => f?.question?.trim() && f?.answer?.trim())
        .slice(0, 30)
        .map((f) => ({
          question: String(f.question).trim().slice(0, 300),
          answer: String(f.answer).trim().slice(0, 1000),
        }));
    }

    await Client.updateOne({ clientId }, { $set: updates });
    const client = await Client.findOne({ clientId }).select('ai.persona knowledgeBase.faqs').lean();

    res.json({
      success: true,
      persona: client.ai?.persona || {},
      quickFaqs: client.knowledgeBase?.faqs || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/persona/preview', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { message } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    const systemPrompt = buildPersonaSystemPrompt(client, '');
    const result = await callAI({
      clientId,
      feature: 'persona_preview',
      systemPrompt,
      prompt: `Customer message: "${message.trim()}"\n\nReply in character (under 80 words):`,
      maxTokens: 200,
      temperature: 0.6,
    });

    res.json({ reply: result.content, usage: result.usage });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED' || err.message === 'AI_NOT_CONFIGURED') {
      return res.status(400).json({ error: 'Configure your Gemini API key in AI Setup first.' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
