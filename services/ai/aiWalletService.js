'use strict';

const AiWallet = require('../../models/AiWallet');
const AiTokenTransaction = require('../../models/AiTokenTransaction');
const Client = require('../../models/Client');
const { encrypt, decrypt } = require('../../utils/core/encryption');
const { isKeyValid } = require('../../utils/core/gemini');
const { isOpenAiKey } = require('../../utils/core/openaiProvider');
const { resolveClientGeminiKey } = require('../../utils/core/clientGeminiKey');
const {
  GEMINI_MODELS,
  OPENAI_MODELS,
  CUSTOMER_INQUIRY_FEATURES,
  curatedModelsForProvider,
  defaultModelForProvider,
  isAllowedModel,
} = require('../../constants/aiModels');

function maskApiKeyPreview(plain) {
  const s = String(plain || '').trim();
  if (!s || s === '••••••••') return null;
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function detectProviderFromKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

function computeMode(activeProvider, geminiOk, openaiOk) {
  if (activeProvider === 'gemini' && geminiOk) return 'byo_gemini';
  if (activeProvider === 'openai' && openaiOk) return 'byo_openai';
  if (geminiOk && openaiOk) return 'byo_both';
  if (geminiOk) return 'byo_gemini';
  if (openaiOk) return 'byo_openai';
  return 'not_configured';
}

function modelsForWallet(wallet, provider) {
  if (provider === 'openai') {
    return curatedModelsForProvider('openai', wallet?.cachedOpenaiModels || []);
  }
  return curatedModelsForProvider('gemini', wallet?.cachedGeminiModels || []);
}

function sanitizeWallet(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  delete o.byoApiKeyEncrypted;
  delete o.byoOpenaiApiKeyEncrypted;

  const geminiConnected = o.byoKeyIsValid === true && o.activeProvider === 'gemini';
  const openaiConnected = o.byoOpenaiKeyIsValid === true && o.activeProvider === 'openai';
  const activeProvider = o.activeProvider || (geminiConnected ? 'gemini' : openaiConnected ? 'openai' : null);
  const connected = geminiConnected || openaiConnected;

  const geminiModels = modelsForWallet(o, 'gemini');
  const openaiModels = modelsForWallet(o, 'openai');

  return {
    clientId: o.clientId,
    mode: o.mode,
    activeProvider,
    byoProvider: activeProvider || o.byoProvider,
    byoModelSelected: o.byoModelSelected,
    byoOpenaiModelSelected: o.byoOpenaiModelSelected,
    byoKeyValidatedAt: o.byoKeyValidatedAt,
    byoOpenaiKeyValidatedAt: o.byoOpenaiKeyValidatedAt,
    byoKeyIsValid: geminiConnected,
    byoOpenaiKeyIsValid: openaiConnected,
    geminiConnected,
    openaiConnected,
    anyConnected: connected,
    preferredProvider: activeProvider || o.preferredProvider || 'auto',
    aiSupportEnabled: o.aiSupportEnabled !== false,
    maxOutputWords: o.maxOutputWords ?? 150,
    totalTokensUsed: o.totalTokensUsed || 0,
    totalInputTokens: o.totalInputTokens || 0,
    totalOutputTokens: o.totalOutputTokens || 0,
    totalCostUsd: o.totalCostUsd || 0,
    availableGeminiModels: geminiModels,
    availableOpenaiModels: openaiModels,
    availableModels: activeProvider === 'openai' ? openaiModels : geminiModels,
    selectedModel: activeProvider === 'openai' ? o.byoOpenaiModelSelected : o.byoModelSelected,
    activeKeyPreview:
      activeProvider === 'openai'
        ? o.byoOpenaiKeyPreview || null
        : o.byoKeyPreview || null,
    geminiKeyPreview: o.byoKeyPreview || null,
    openaiKeyPreview: o.byoOpenaiKeyPreview || null,
    updatedAt: o.updatedAt,
  };
}

async function getOrCreateWallet(clientId) {
  let wallet = await AiWallet.findOne({ clientId });
  if (wallet) return wallet;
  wallet = await AiWallet.create({ clientId, mode: 'not_configured' });
  return wallet;
}

function resolveLegacyKeyPlain(client, field) {
  const raw = field === 'openai'
    ? (client?.ai?.openaiKey || client?.openaiApiKey)
    : resolveClientGeminiKey(client);
  if (!raw) return null;
  try {
    const decrypted = decrypt(raw);
    if (field === 'openai' ? isOpenAiKey(decrypted) : isKeyValid(decrypted)) return decrypted.trim();
  } catch (_) {}
  if (field === 'openai' ? isOpenAiKey(raw) : isKeyValid(raw)) return raw.trim();
  return null;
}

async function syncLegacyKey(clientId) {
  const wallet = await getOrCreateWallet(clientId);
  if (wallet.activeProvider && (wallet.byoKeyIsValid || wallet.byoOpenaiKeyIsValid)) {
    return AiWallet.findOne({ clientId }).select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
  }

  const client = await Client.findOne({ clientId }).lean();
  const updates = {};
  const legacyGemini = resolveLegacyKeyPlain(client, 'gemini');
  const legacyOpenai = resolveLegacyKeyPlain(client, 'openai');

  if (legacyGemini && !wallet.byoKeyIsValid) {
    updates.byoApiKeyEncrypted = encrypt(legacyGemini);
    updates.byoKeyIsValid = true;
    updates.byoKeyValidatedAt = new Date();
    updates.byoKeyPreview = maskApiKeyPreview(legacyGemini);
    updates.byoModelSelected = wallet.byoModelSelected || defaultModelForProvider('gemini');
    updates.activeProvider = 'gemini';
    updates.byoProvider = 'gemini';
  } else if (legacyOpenai && !wallet.byoOpenaiKeyIsValid) {
    updates.byoOpenaiApiKeyEncrypted = encrypt(legacyOpenai);
    updates.byoOpenaiKeyIsValid = true;
    updates.byoOpenaiKeyValidatedAt = new Date();
    updates.byoOpenaiKeyPreview = maskApiKeyPreview(legacyOpenai);
    updates.byoOpenaiModelSelected = wallet.byoOpenaiModelSelected || defaultModelForProvider('openai');
    updates.activeProvider = 'openai';
    updates.byoProvider = 'openai';
  }

  if (Object.keys(updates).length) {
    updates.mode = computeMode(updates.activeProvider, updates.byoKeyIsValid ?? wallet.byoKeyIsValid, updates.byoOpenaiKeyIsValid ?? wallet.byoOpenaiKeyIsValid);
    await AiWallet.updateOne({ clientId }, { $set: updates });
  }

  return AiWallet.findOne({ clientId }).select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
}

function readGeminiKey(wallet) {
  if (wallet?.activeProvider !== 'gemini' || !wallet?.byoKeyIsValid || !wallet.byoApiKeyEncrypted) return null;
  const apiKey = decrypt(wallet.byoApiKeyEncrypted);
  if (!isKeyValid(apiKey)) return null;
  return {
    configured: true,
    provider: 'gemini',
    apiKey,
    model: wallet.byoModelSelected || process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite',
  };
}

function readOpenAiKey(wallet) {
  if (wallet?.activeProvider !== 'openai' || !wallet?.byoOpenaiKeyIsValid || !wallet.byoOpenaiApiKeyEncrypted) return null;
  const apiKey = decrypt(wallet.byoOpenaiApiKeyEncrypted);
  if (!isOpenAiKey(apiKey)) return null;
  return {
    configured: true,
    provider: 'openai',
    apiKey,
    model: wallet.byoOpenaiModelSelected || 'gpt-4o-mini',
  };
}

async function resolveApiKeyForClient(clientId, options = {}) {
  const { provider = null, requireGemini = false } = options;
  await syncLegacyKey(clientId);
  const wallet = await AiWallet.findOne({ clientId }).select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
  const sanitized = sanitizeWallet(wallet);
  const gemini = readGeminiKey(wallet);
  const openai = readOpenAiKey(wallet);

  if (requireGemini && !gemini) {
    return { configured: false, wallet: sanitized, embeddingProvider: null };
  }

  const pref = provider || wallet?.activeProvider || wallet?.preferredProvider || 'auto';

  if (pref === 'openai' && openai) return { ...openai, wallet: sanitized, embeddingProvider: 'openai' };
  if (pref === 'gemini' && gemini) return { ...gemini, wallet: sanitized, embeddingProvider: 'gemini' };
  if (openai) return { ...openai, wallet: sanitized, embeddingProvider: 'openai' };
  if (gemini) return { ...gemini, wallet: sanitized, embeddingProvider: 'gemini' };

  return { configured: false, wallet: sanitized, embeddingProvider: null };
}

async function mirrorAiSettingsToClient(clientId, patch) {
  const clientPatch = {};
  if (patch.aiSupportEnabled !== undefined) {
    clientPatch['config.aiConfig.aiSupportEnabled'] = patch.aiSupportEnabled;
  }
  if (patch.maxOutputWords !== undefined) {
    clientPatch['config.aiConfig.maxOutputWords'] = patch.maxOutputWords;
  }
  if (Object.keys(clientPatch).length) {
    await Client.updateOne({ clientId }, { $set: clientPatch });
  }
}

async function saveValidatedKey(clientId, apiKey, model, provider = 'gemini', fetchedModels = []) {
  const detected = detectProviderFromKey(apiKey);
  const normalizedProvider = provider === 'openai' ? 'openai' : 'gemini';

  if (detected === 'openai' && normalizedProvider === 'gemini') {
    const err = new Error('This looks like an OpenAI key (sk-…). Choose OpenAI as provider.');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }
  if (detected === 'gemini' && normalizedProvider === 'openai') {
    const err = new Error('This looks like a Gemini key (AIza…). Choose Google Gemini as provider.');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }
  if (!detected) {
    const err = new Error('Unrecognized API key format. Use AIza… for Gemini or sk-… for OpenAI.');
    err.code = 'INVALID_KEY_FORMAT';
    throw err;
  }

  const key = String(apiKey).trim();
  const enc = encrypt(key);
  const available = curatedModelsForProvider(normalizedProvider, fetchedModels);
  const defaultModel = defaultModelForProvider(normalizedProvider);
  const selectedModel = model && isAllowedModel(normalizedProvider, model, available) ? model : defaultModel;
  const keyPreview = maskApiKeyPreview(key);

  const clearOther = {
    byoKeyIsValid: false,
    byoOpenaiKeyIsValid: false,
    byoApiKeyEncrypted: null,
    byoOpenaiApiKeyEncrypted: null,
    byoKeyPreview: null,
    byoOpenaiKeyPreview: null,
  };

  if (normalizedProvider === 'openai') {
    await AiWallet.findOneAndUpdate(
      { clientId },
      {
        $set: {
          ...clearOther,
          activeProvider: 'openai',
          byoProvider: 'openai',
          byoOpenaiApiKeyEncrypted: enc,
          byoOpenaiModelSelected: selectedModel,
          byoOpenaiKeyIsValid: true,
          byoOpenaiKeyValidatedAt: new Date(),
          byoOpenaiKeyPreview: keyPreview,
          cachedOpenaiModels: available,
          mode: 'byo_openai',
          preferredProvider: 'openai',
        },
        $setOnInsert: { clientId },
      },
      { upsert: true, new: true }
    );
    await Client.updateOne(
      { clientId },
      {
        $set: { openaiApiKey: enc, 'ai.openaiKey': enc },
        $unset: { geminiApiKey: '', 'ai.geminiKey': '' },
      }
    );
  } else {
    await AiWallet.findOneAndUpdate(
      { clientId },
      {
        $set: {
          ...clearOther,
          activeProvider: 'gemini',
          byoProvider: 'gemini',
          byoApiKeyEncrypted: enc,
          byoModelSelected: selectedModel,
          byoKeyIsValid: true,
          byoKeyValidatedAt: new Date(),
          byoKeyPreview: keyPreview,
          cachedGeminiModels: available,
          mode: 'byo_gemini',
          preferredProvider: 'gemini',
        },
        $setOnInsert: { clientId },
      },
      { upsert: true, new: true }
    );
    await Client.updateOne(
      { clientId },
      {
        $set: { geminiApiKey: enc, 'ai.geminiKey': enc },
        $unset: { openaiApiKey: '', 'ai.openaiKey': '' },
      }
    );
  }

  return getWalletStatus(clientId);
}

async function removeApiKey(clientId) {
  await AiWallet.findOneAndUpdate(
    { clientId },
    {
      $set: {
        mode: 'not_configured',
        activeProvider: null,
        byoProvider: null,
        byoKeyIsValid: false,
        byoOpenaiKeyIsValid: false,
        byoApiKeyEncrypted: null,
        byoOpenaiApiKeyEncrypted: null,
        byoKeyPreview: null,
        byoOpenaiKeyPreview: null,
        preferredProvider: 'auto',
      },
    }
  );
  await Client.updateOne(
    { clientId },
    { $unset: { geminiApiKey: '', openaiApiKey: '', 'ai.geminiKey': '', 'ai.openaiKey': '' } }
  );
  return getWalletStatus(clientId);
}

async function updateWalletSettings(clientId, { aiSupportEnabled, maxOutputWords } = {}) {
  const patch = {};
  if (typeof aiSupportEnabled === 'boolean') patch.aiSupportEnabled = aiSupportEnabled;
  if (maxOutputWords != null) {
    const n = Math.min(800, Math.max(30, parseInt(maxOutputWords, 10) || 150));
    patch.maxOutputWords = n;
  }
  if (Object.keys(patch).length) {
    await getOrCreateWallet(clientId);
    await AiWallet.updateOne({ clientId }, { $set: patch });
    await mirrorAiSettingsToClient(clientId, patch);
  }
  return getWalletStatus(clientId);
}

async function getUsageBreakdown(clientId) {
  const [inquiryAgg, totalAgg] = await Promise.all([
    AiTokenTransaction.aggregate([
      { $match: { clientId, success: true, feature: { $in: CUSTOMER_INQUIRY_FEATURES } } },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$totalTokens' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          costUsd: { $sum: '$costUsd' },
          calls: { $sum: 1 },
        },
      },
    ]),
    AiTokenTransaction.aggregate([
      { $match: { clientId, success: true, feature: { $ne: 'embedding' } } },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$totalTokens' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          costUsd: { $sum: '$costUsd' },
          calls: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    customerInquiries: inquiryAgg[0] || { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
    platformTotal: totalAgg[0] || { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
  };
}

async function backfillKeyPreviewsIfNeeded(wallet) {
  if (!wallet?.clientId) return wallet;
  const needsGemini = wallet.byoKeyIsValid && !wallet.byoKeyPreview;
  const needsOpenai = wallet.byoOpenaiKeyIsValid && !wallet.byoOpenaiKeyPreview;
  if (!needsGemini && !needsOpenai) return wallet;

  const w = await AiWallet.findOne({ clientId: wallet.clientId })
    .select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
  if (!w) return wallet;

  const patch = {};
  if (needsGemini && w.byoApiKeyEncrypted) {
    try {
      patch.byoKeyPreview = maskApiKeyPreview(decrypt(w.byoApiKeyEncrypted));
    } catch (_) { /* noop */ }
  }
  if (needsOpenai && w.byoOpenaiApiKeyEncrypted) {
    try {
      patch.byoOpenaiKeyPreview = maskApiKeyPreview(decrypt(w.byoOpenaiApiKeyEncrypted));
    } catch (_) { /* noop */ }
  }
  if (Object.keys(patch).length) {
    await AiWallet.updateOne({ clientId: wallet.clientId }, { $set: patch });
    return AiWallet.findOne({ clientId: wallet.clientId });
  }
  return wallet;
}

async function getWalletStatus(clientId) {
  try {
    await syncLegacyKey(clientId);
  } catch (err) {
    console.warn('[getWalletStatus] syncLegacyKey skipped:', err?.message || err);
  }
  let wallet = await AiWallet.findOne({ clientId });
  wallet = await backfillKeyPreviewsIfNeeded(wallet);
  const sanitized = sanitizeWallet(wallet) || { clientId, mode: 'not_configured', anyConnected: false };
  const usage = await getUsageBreakdown(clientId);
  return { ...sanitized, usage };
}

async function selectModel(clientId, model, provider = 'gemini') {
  const wallet = await AiWallet.findOne({ clientId });
  const active = provider === 'openai' ? 'openai' : (wallet?.activeProvider || 'gemini');
  const available = modelsForWallet(wallet, active);
  if (!isAllowedModel(active, model, available)) {
    const err = new Error('Unsupported model for this provider');
    err.code = 'INVALID_MODEL';
    throw err;
  }
  if (active === 'openai') {
    await AiWallet.updateOne({ clientId }, { $set: { byoOpenaiModelSelected: model } });
  } else {
    await AiWallet.updateOne({ clientId }, { $set: { byoModelSelected: model } });
  }
  return getWalletStatus(clientId);
}

async function setPreferredProvider(clientId, preferredProvider) {
  const wallet = await AiWallet.findOne({ clientId });
  if (wallet?.activeProvider) {
    return getWalletStatus(clientId);
  }
  const allowed = ['auto', 'gemini', 'openai'];
  if (!allowed.includes(preferredProvider)) {
    const err = new Error('Invalid preferred provider');
    err.code = 'INVALID_PROVIDER';
    throw err;
  }
  await AiWallet.updateOne({ clientId }, { $set: { preferredProvider } });
  return getWalletStatus(clientId);
}

async function incrementWalletTotals(clientId, inputTokens, outputTokens, costUsd) {
  await AiWallet.findOneAndUpdate(
    { clientId },
    {
      $inc: {
        totalTokensUsed: inputTokens + outputTokens,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCostUsd: costUsd,
      },
    }
  );
}

async function getMaxOutputTokens(clientId) {
  const wallet = await AiWallet.findOne({ clientId }).select('maxOutputWords').lean();
  const words = wallet?.maxOutputWords ?? 150;
  return Math.ceil(words * 1.35);
}

module.exports = {
  GEMINI_MODELS,
  OPENAI_MODELS,
  CUSTOMER_INQUIRY_FEATURES,
  detectProviderFromKey,
  getOrCreateWallet,
  syncLegacyKey,
  resolveApiKeyForClient,
  saveValidatedKey,
  removeApiKey,
  updateWalletSettings,
  getWalletStatus,
  getUsageBreakdown,
  selectModel,
  setPreferredProvider,
  incrementWalletTotals,
  getMaxOutputTokens,
  sanitizeWallet,
  modelsForWallet,
  isAllowedModel,
};
