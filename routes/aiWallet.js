'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const AiTokenTransaction = require('../models/AiTokenTransaction');
const {
  saveValidatedKey,
  getWalletStatus,
  selectModel,
  setPreferredProvider,
  GEMINI_MODELS,
  OPENAI_MODELS,
} = require('../services/ai/aiWalletService');
const { validateGeminiKey, validateOpenAiKey, callAI } = require('../utils/core/aiGateway');

router.get('/status', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const status = await getWalletStatus(clientId);
    res.json({
      ...status,
      availableModels: GEMINI_MODELS,
      availableGeminiModels: GEMINI_MODELS,
      availableOpenaiModels: OPENAI_MODELS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/validate-key', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { apiKey, provider = 'gemini', model } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'API key is required.' });

    const normalizedProvider = provider === 'openai' ? 'openai' : 'gemini';
    const key = String(apiKey).trim();

    if (normalizedProvider === 'openai') {
      if (key.startsWith('AIza')) {
        return res.status(400).json({
          error: 'This looks like a Gemini key. Choose Google Gemini as provider or paste an OpenAI key (sk-…).',
        });
      }
      const validation = await validateOpenAiKey(key);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const selectedModel = model && OPENAI_MODELS.includes(model) ? model : 'gpt-4o-mini';
      const status = await saveValidatedKey(clientId, key, selectedModel, 'openai');
      return res.json({
        success: true,
        detectedProvider: 'openai',
        models: validation.models || OPENAI_MODELS,
        wallet: status,
      });
    }

    if (key.startsWith('sk-')) {
      return res.status(400).json({
        error: 'This looks like an OpenAI key. Choose OpenAI as provider or paste a Gemini key (AIza…).',
      });
    }

    const validation = await validateGeminiKey(key);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const selectedModel = model && GEMINI_MODELS.includes(model)
      ? model
      : process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite';

    const status = await saveValidatedKey(clientId, key, selectedModel, 'gemini');
    res.json({
      success: true,
      detectedProvider: 'gemini',
      models: validation.models?.length ? validation.models : GEMINI_MODELS,
      wallet: status,
    });
  } catch (err) {
    res.status(err.code === 'WRONG_PROVIDER' || err.code === 'INVALID_KEY_FORMAT' ? 400 : 500).json({ error: err.message });
  }
});

router.post('/select-model', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { model, provider = 'gemini' } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Model is required.' });
    const status = await selectModel(clientId, model, provider === 'openai' ? 'openai' : 'gemini');
    res.json({ success: true, wallet: status });
  } catch (err) {
    res.status(err.code === 'INVALID_MODEL' ? 400 : 500).json({ error: err.message });
  }
});

router.post('/preferred-provider', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { preferredProvider } = req.body || {};
    if (!preferredProvider) return res.status(400).json({ error: 'preferredProvider is required.' });
    const status = await setPreferredProvider(clientId, preferredProvider);
    res.json({ success: true, wallet: status });
  } catch (err) {
    res.status(err.code === 'INVALID_PROVIDER' ? 400 : 500).json({ error: err.message });
  }
});

router.post('/test-prompt', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { prompt, provider } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required.' });

    const result = await callAI({
      clientId,
      feature: 'other',
      prompt: prompt.trim(),
      maxTokens: 200,
      temperature: 0.5,
      provider: provider || null,
    });
    res.json({ success: true, reply: result.content, usage: result.usage, provider: result.provider });
  } catch (err) {
    const code = err.code || err.message;
    if (code === 'AI_NOT_CONFIGURED') {
      return res.status(400).json({
        error: 'Add your Gemini or OpenAI API key in AI Brain → AI Setup first.',
        code: 'AI_NOT_CONFIGURED',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/transaction-history', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      AiTokenTransaction.find({ clientId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      AiTokenTransaction.countDocuments({ clientId }),
    ]);

    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage-summary', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [wallet, monthAgg, byFeature] = await Promise.all([
      getWalletStatus(clientId),
      AiTokenTransaction.aggregate([
        { $match: { clientId, timestamp: { $gte: startOfMonth }, success: true } },
        {
          $group: {
            _id: null,
            totalTokens: { $sum: '$totalTokens' },
            totalCostUsd: { $sum: '$costUsd' },
            calls: { $sum: 1 },
          },
        },
      ]),
      AiTokenTransaction.aggregate([
        { $match: { clientId, success: true } },
        {
          $group: {
            _id: '$feature',
            totalTokens: { $sum: '$totalTokens' },
            calls: { $sum: 1 },
          },
        },
      ]),
    ]);

    res.json({
      wallet,
      thisMonth: monthAgg[0] || { totalTokens: 0, totalCostUsd: 0, calls: 0 },
      byFeature: byFeature.map((r) => ({
        feature: r._id,
        totalTokens: r.totalTokens,
        calls: r.calls,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
