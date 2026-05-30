'use strict';

const AiWallet = require('../../models/AiWallet');
const Client = require('../../models/Client');
const { encrypt, decrypt } = require('../../utils/core/encryption');
const { isKeyValid } = require('../../utils/core/gemini');
const { isOpenAiKey } = require('../../utils/core/openaiProvider');
const { resolveClientGeminiKey } = require('../../utils/core/clientGeminiKey');

const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
];

function detectProviderFromKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

function computeMode(geminiOk, openaiOk) {
  if (geminiOk && openaiOk) return 'byo_both';
  if (geminiOk) return 'byo_gemini';
  if (openaiOk) return 'byo_openai';
  return 'not_configured';
}

function sanitizeWallet(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  delete o.byoApiKeyEncrypted;
  delete o.byoOpenaiApiKeyEncrypted;

  const geminiConnected = o.byoKeyIsValid === true;
  const openaiConnected = o.byoOpenaiKeyIsValid === true;

  return {
    clientId: o.clientId,
    mode: o.mode,
    byoProvider: o.byoProvider,
    byoModelSelected: o.byoModelSelected,
    byoOpenaiModelSelected: o.byoOpenaiModelSelected,
    byoKeyValidatedAt: o.byoKeyValidatedAt,
    byoOpenaiKeyValidatedAt: o.byoOpenaiKeyValidatedAt,
    byoKeyIsValid: geminiConnected,
    byoOpenaiKeyIsValid: openaiConnected,
    geminiConnected,
    openaiConnected,
    anyConnected: geminiConnected || openaiConnected,
    preferredProvider: o.preferredProvider || 'auto',
    totalTokensUsed: o.totalTokensUsed || 0,
    totalInputTokens: o.totalInputTokens || 0,
    totalOutputTokens: o.totalOutputTokens || 0,
    totalCostUsd: o.totalCostUsd || 0,
    availableGeminiModels: GEMINI_MODELS,
    availableOpenaiModels: OPENAI_MODELS,
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
  const client = await Client.findOne({ clientId }).lean();
  const updates = {};

  if (!wallet.byoKeyIsValid || !wallet.byoApiKeyEncrypted) {
    const legacyGemini = resolveLegacyKeyPlain(client, 'gemini');
    if (legacyGemini) {
      updates.byoApiKeyEncrypted = encrypt(legacyGemini);
      updates.byoKeyIsValid = true;
      updates.byoKeyValidatedAt = new Date();
      updates.byoProvider = 'gemini';
      updates.byoModelSelected = wallet.byoModelSelected || process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite';
    }
  }

  if (!wallet.byoOpenaiKeyIsValid || !wallet.byoOpenaiApiKeyEncrypted) {
    const legacyOpenai = resolveLegacyKeyPlain(client, 'openai');
    if (legacyOpenai) {
      updates.byoOpenaiApiKeyEncrypted = encrypt(legacyOpenai);
      updates.byoOpenaiKeyIsValid = true;
      updates.byoOpenaiKeyValidatedAt = new Date();
      updates.byoOpenaiModelSelected = wallet.byoOpenaiModelSelected || 'gpt-4o-mini';
    }
  }

  if (Object.keys(updates).length) {
    updates.mode = computeMode(
      updates.byoKeyIsValid ?? wallet.byoKeyIsValid,
      updates.byoOpenaiKeyIsValid ?? wallet.byoOpenaiKeyIsValid
    );
    await AiWallet.updateOne({ clientId }, { $set: updates });
  }

  return AiWallet.findOne({ clientId }).select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
}

function readGeminiKey(wallet) {
  if (!wallet?.byoKeyIsValid || !wallet.byoApiKeyEncrypted) return null;
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
  if (!wallet?.byoOpenaiKeyIsValid || !wallet.byoOpenaiApiKeyEncrypted) return null;
  const apiKey = decrypt(wallet.byoOpenaiApiKeyEncrypted);
  if (!isOpenAiKey(apiKey)) return null;
  return {
    configured: true,
    provider: 'openai',
    apiKey,
    model: wallet.byoOpenaiModelSelected || 'gpt-4o-mini',
  };
}

/**
 * Resolve tenant BYO key. Never uses platform keys.
 * @param {string} clientId
 * @param {{ provider?: 'gemini'|'openai'|'auto', requireGemini?: boolean }} options
 */
async function resolveApiKeyForClient(clientId, options = {}) {
  const { provider = null, requireGemini = false } = options;
  await syncLegacyKey(clientId);
  const wallet = await AiWallet.findOne({ clientId }).select('+byoApiKeyEncrypted +byoOpenaiApiKeyEncrypted');
  const gemini = readGeminiKey(wallet);
  const openai = readOpenAiKey(wallet);
  const sanitized = sanitizeWallet(wallet);

  if (requireGemini) {
    if (!gemini) return { configured: false, wallet: sanitized };
    return { ...gemini, wallet: sanitized };
  }

  const pref = provider || wallet?.preferredProvider || 'auto';

  if (pref === 'gemini' && gemini) return { ...gemini, wallet: sanitized };
  if (pref === 'openai' && openai) return { ...openai, wallet: sanitized };

  if (gemini) return { ...gemini, wallet: sanitized };
  if (openai) return { ...openai, wallet: sanitized };

  return { configured: false, wallet: sanitized };
}

async function saveValidatedKey(clientId, apiKey, model, provider = 'gemini') {
  const detected = detectProviderFromKey(apiKey);
  const normalizedProvider = provider === 'openai' ? 'openai' : 'gemini';

  if (detected === 'openai' && normalizedProvider === 'gemini') {
    const err = new Error('This looks like an OpenAI key (sk-…). Switch provider to OpenAI or paste a Gemini key (AIza…).');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }
  if (detected === 'gemini' && normalizedProvider === 'openai') {
    const err = new Error('This looks like a Gemini key (AIza…). Switch provider to Gemini or paste an OpenAI key (sk-…).');
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

  if (normalizedProvider === 'openai') {
    const selectedModel = model && OPENAI_MODELS.includes(model) ? model : 'gpt-4o-mini';
    const wallet = await AiWallet.findOne({ clientId });
    const geminiOk = wallet?.byoKeyIsValid === true;
    await AiWallet.findOneAndUpdate(
      { clientId },
      {
        $set: {
          byoOpenaiApiKeyEncrypted: enc,
          byoOpenaiModelSelected: selectedModel,
          byoOpenaiKeyIsValid: true,
          byoOpenaiKeyValidatedAt: new Date(),
          mode: computeMode(geminiOk, true),
        },
        $setOnInsert: { clientId },
      },
      { upsert: true, new: true }
    );
    await Client.updateOne(
      { clientId },
      { $set: { openaiApiKey: enc, 'ai.openaiKey': enc } }
    );
  } else {
    const selectedModel = model && GEMINI_MODELS.includes(model)
      ? model
      : process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite';
    const wallet = await AiWallet.findOne({ clientId });
    const openaiOk = wallet?.byoOpenaiKeyIsValid === true;
    await AiWallet.findOneAndUpdate(
      { clientId },
      {
        $set: {
          mode: computeMode(true, openaiOk),
          byoProvider: 'gemini',
          byoApiKeyEncrypted: enc,
          byoModelSelected: selectedModel,
          byoKeyIsValid: true,
          byoKeyValidatedAt: new Date(),
        },
        $setOnInsert: { clientId },
      },
      { upsert: true, new: true }
    );
    await Client.updateOne(
      { clientId },
      { $set: { geminiApiKey: enc, 'ai.geminiKey': enc } }
    );
  }

  return getWalletStatus(clientId);
}

async function getWalletStatus(clientId) {
  await syncLegacyKey(clientId);
  const wallet = await AiWallet.findOne({ clientId });
  return sanitizeWallet(wallet);
}

async function selectModel(clientId, model, provider = 'gemini') {
  if (provider === 'openai') {
    if (!OPENAI_MODELS.includes(model)) {
      const err = new Error('Unsupported OpenAI model');
      err.code = 'INVALID_MODEL';
      throw err;
    }
    await AiWallet.updateOne({ clientId }, { $set: { byoOpenaiModelSelected: model } });
  } else {
    if (!GEMINI_MODELS.includes(model)) {
      const err = new Error('Unsupported Gemini model');
      err.code = 'INVALID_MODEL';
      throw err;
    }
    await AiWallet.updateOne({ clientId }, { $set: { byoModelSelected: model } });
  }
  return getWalletStatus(clientId);
}

async function setPreferredProvider(clientId, preferredProvider) {
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

module.exports = {
  GEMINI_MODELS,
  OPENAI_MODELS,
  detectProviderFromKey,
  getOrCreateWallet,
  syncLegacyKey,
  resolveApiKeyForClient,
  saveValidatedKey,
  getWalletStatus,
  selectModel,
  setPreferredProvider,
  incrementWalletTotals,
  sanitizeWallet,
};
