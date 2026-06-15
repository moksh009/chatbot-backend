'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireIntelligenceV2 } = require('../middleware/requireIntelligenceV2');
const { tenantClientId } = require('../utils/core/queryHelpers');
const Client = require('../models/Client');
const { buildPersonaSystemPrompt, applyPersonaPostProcess, syncPersonaAcrossSystem, resolveQuickFaqReply, buildQuickFaqDirective } = require('../utils/core/personaEngine');
const { callAI } = require('../utils/core/aiGateway');
const { retrieveKnowledge, notifyRagFailure, isRagUnavailableError, getActiveKnowledgeHealth } = require('../utils/core/ragEngine');
const { sendAiError } = require('../utils/core/aiProviderErrors');

router.use(protect, requireIntelligenceV2());

router.get('/persona', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const client = await Client.findOne({ clientId }).select('ai.persona knowledgeBase.faqs clientId').lean();
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    res.json({
      persona: client.ai?.persona || {},
      quickFaqs: client.knowledgeBase?.faqs || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/persona', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { name, description, quickFaqs } = req.body || {};
    const updates = {};

    if (name !== undefined) updates['ai.persona.name'] = String(name).slice(0, 120);
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
    await syncPersonaAcrossSystem(clientId, {
      ...(name !== undefined ? { name: String(name).slice(0, 120) } : {}),
      ...(description !== undefined ? { description: String(description).slice(0, 4000) } : {}),
    });

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

router.post('/persona/preview', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { message, quickFaqs: draftQuickFaqs, persona: draftPersona } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    const previewPersona =
      draftPersona && typeof draftPersona === 'object'
        ? { ...(client.ai?.persona || {}), ...draftPersona }
        : client.ai?.persona;
    const previewClient = {
      ...client,
      ai: { ...(client.ai || {}), persona: previewPersona },
    };

    const faqResolved = resolveQuickFaqReply(
      previewClient,
      message.trim(),
      previewPersona,
      Array.isArray(draftQuickFaqs) ? draftQuickFaqs : null
    );

    if (faqResolved.direct) {
      return res.json({
        reply: faqResolved.reply,
        usage: null,
        tone: null,
        chunks: [],
        retrievalMode: 'none',
        matchedFaq: { question: faqResolved.faqMatch.question, direct: true },
      });
    }

    const health = await getActiveKnowledgeHealth(clientId);
    let ragChunks = [];
    let ragContext = '';

    if (health.active > 0) {
      try {
        ragChunks = await retrieveKnowledge(clientId, message.trim(), 3);
        ragContext = ragChunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n');
      } catch (err) {
        if (isRagUnavailableError(err)) {
          if (err.reason === 'query_embed_failed') {
            ragChunks = [];
            ragContext = '';
          } else {
            await notifyRagFailure(clientId, err.reason);
            return res.status(503).json({
              error: err.userMessage,
              code: err.code,
              reason: err.reason,
              ragBlocked: true,
            });
          }
        } else {
          throw err;
        }
      }
    }

    const faqMatch = faqResolved.faqMatch;

    const systemPrompt = buildPersonaSystemPrompt(
      previewClient,
      ragContext ? `RETRIEVED KNOWLEDGE (use when relevant — do not invent facts):\n${ragContext}` : ''
    );

    const result = await callAI({
      clientId,
      feature: 'persona_preview',
      systemPrompt,
      prompt: `Customer message: "${message.trim()}"${buildQuickFaqDirective(faqMatch)}\n\nReply in character using the instructions above. Under 80 words. If a FAQ was matched, keep those facts exactly. If knowledge was provided, answer from it only; otherwise be honest that you need more store details.`,
      maxTokens: 200,
      temperature: 0.55,
    });

    const reply = applyPersonaPostProcess(result.content, previewPersona);

    res.json({
      reply,
      usage: result.usage,
      tone: null,
      chunks: ragChunks,
      retrievalMode: ragChunks.some((c) => c.mode === 'vector') ? 'hybrid' : ragChunks.length ? 'keyword' : 'none',
      matchedFaq: faqMatch ? { question: faqMatch.question } : null,
      ragDegraded: ragContext === '' && health.active > 0,
    });
  } catch (err) {
    return sendAiError(res, err);
  }
});

module.exports = router;
