'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { formatReplyForWhatsApp } = require('../utils/core/personaEngine');
const AiTokenTransaction = require('../models/AiTokenTransaction');
const {
  saveValidatedKey,
  getWalletStatus,
  selectModel,
  removeApiKey,
  updateWalletSettings,
  getUsageBreakdown,
  GEMINI_MODELS,
  OPENAI_MODELS,
} = require('../services/ai/aiWalletService');
const { validateGeminiKey, validateOpenAiKey, callAI } = require('../utils/core/aiGateway');
const { sendAiError } = require('../utils/core/aiProviderErrors');

router.get('/status', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const status = await getWalletStatus(clientId);
    res.json({
      ...status,
      availableModels: status.availableModels || GEMINI_MODELS,
      availableGeminiModels: status.availableGeminiModels || GEMINI_MODELS,
      availableOpenaiModels: status.availableOpenaiModels || OPENAI_MODELS,
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
        return res.status(400).json({ error: 'This looks like a Gemini key. Choose Google Gemini as provider.' });
      }
      const validation = await validateOpenAiKey(key);
      if (!validation.valid) return res.status(400).json({ error: validation.error });
      const selectedModel = model && validation.models.includes(model) ? model : 'gpt-4o-mini';
      const status = await saveValidatedKey(clientId, key, selectedModel, 'openai', validation.models);
      return res.json({ success: true, detectedProvider: 'openai', models: validation.models, wallet: status });
    }

    if (key.startsWith('sk-')) {
      return res.status(400).json({ error: 'This looks like an OpenAI key. Choose OpenAI as provider.' });
    }

    const validation = await validateGeminiKey(key);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const selectedModel = model && validation.models.includes(model)
      ? model
      : process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite';

    const status = await saveValidatedKey(clientId, key, selectedModel, 'gemini', validation.models);
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

router.delete('/disconnect', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const status = await removeApiKey(clientId);
    res.json({ success: true, wallet: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/settings', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { aiSupportEnabled, maxOutputWords } = req.body || {};
    const status = await updateWalletSettings(clientId, { aiSupportEnabled, maxOutputWords });
    res.json({ success: true, wallet: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/select-model', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { model, provider } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Model is required.' });
    const status = await selectModel(clientId, model, provider);
    res.json({ success: true, wallet: status });
  } catch (err) {
    res.status(err.code === 'INVALID_MODEL' ? 400 : 500).json({ error: err.message });
  }
});

router.post('/test-prompt', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const { prompt } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required.' });

    const result = await callAI({
      clientId,
      feature: 'other',
      prompt: prompt.trim(),
      temperature: 0.5,
    });
    res.json({ success: true, reply: formatReplyForWhatsApp(result.content), usage: result.usage, provider: result.provider });
  } catch (err) {
    return sendAiError(res, err);
  }
});

router.get('/transaction-history', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;
    const includeEmbeddings = req.query.includeEmbeddings === 'true';

    const filter = {
      clientId,
      success: true,
      ...(includeEmbeddings ? {} : { feature: { $ne: 'embedding' } }),
    };

    const [items, total] = await Promise.all([
      AiTokenTransaction.find(filter)
        .sort({ timestamp: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AiTokenTransaction.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      items,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * One-time maintenance: remove stale embedding token ledger rows.
 * SUPER_ADMIN only — never call from merchant UI on tab load.
 */
router.post('/purge-embedding-noise', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super admin only' });
    }

    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const result = await AiTokenTransaction.deleteMany({
      clientId,
      feature: 'embedding',
    });

    res.json({ success: true, deleted: result.deletedCount || 0 });
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

    const [wallet, usage, monthAgg, byFeature] = await Promise.all([
      getWalletStatus(clientId),
      getUsageBreakdown(clientId),
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
        { $match: { clientId, success: true, feature: { $ne: 'embedding' } } },
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
      usage,
      customerInquiryTokens: usage.customerInquiries.totalTokens,
      platformTotalTokens: usage.platformTotal.totalTokens,
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
