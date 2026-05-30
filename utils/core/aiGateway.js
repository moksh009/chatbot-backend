'use strict';

const AiTokenTransaction = require('../../models/AiTokenTransaction');
const { generateTextWithUsage: geminiGenerate, isKeyValid } = require('./gemini');
const { generateTextWithUsage: openaiGenerate, validateOpenAiKey } = require('./openaiProvider');
const { resolveApiKeyForClient, incrementWalletTotals, getMaxOutputTokens } = require('../../services/ai/aiWalletService');

const CREDIT_RATE = {
  gemini: {
    'gemini-2.5-flash-lite': { inputPer1k: 0.000075, outputPer1k: 0.0003 },
    'gemini-2.5-flash': { inputPer1k: 0.000125, outputPer1k: 0.0005 },
    'gemini-embedding-001': { inputPer1k: 0.00001, outputPer1k: 0 },
    'text-embedding-004': { inputPer1k: 0.00001, outputPer1k: 0 },
  },
  openai: {
    'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
    'gpt-4.1-mini': { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  },
};

function calculateCost(provider, model, inputTokens, outputTokens) {
  const rates = CREDIT_RATE[provider]?.[model];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.inputPer1k + (outputTokens / 1000) * rates.outputPer1k;
}

async function logTransaction(payload) {
  try {
    const {
      clientId, feature, provider, model,
      inputTokens, outputTokens, costUsd, source, success, errorCode = null,
    } = payload;
    await AiTokenTransaction.create({
      clientId,
      feature,
      provider: provider || 'gemini',
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      source: source || 'byo',
      success,
      errorCode,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[aiGateway] Failed to log transaction:', err.message);
  }
}

/**
 * Single entry point for tenant-scoped AI calls (BYO key only — never platform keys).
 */
async function callAI({
  clientId,
  feature = 'other',
  prompt,
  systemPrompt = null,
  maxTokens = 300,
  temperature = 0.4,
  fast = true,
  model = null,
  jsonMode = false,
  provider = null,
}) {
  const resolved = await resolveApiKeyForClient(clientId, { provider: provider || null });
  if (!resolved.configured) {
    const err = new Error('AI_NOT_CONFIGURED');
    err.code = 'AI_NOT_CONFIGURED';
    err.userMessage = 'Add your API key in Intelligence Hub → AI Setup.';
    throw err;
  }

  const walletMaxTokens = await getMaxOutputTokens(clientId);
  const effectiveMaxTokens = maxTokens ? Math.min(maxTokens, walletMaxTokens) : walletMaxTokens;

  const activeProvider = resolved.provider;
  const activeModel = model || resolved.model;
  const apiKey = resolved.apiKey;

  let result;
  if (activeProvider === 'openai') {
    result = await openaiGenerate(prompt, apiKey, {
      systemInstruction: systemPrompt || undefined,
      maxTokens: effectiveMaxTokens,
      temperature,
      model: activeModel,
      responseMimeType: jsonMode ? 'application/json' : undefined,
    });
  } else {
    result = await geminiGenerate(prompt, apiKey, {
      noEnvFallback: true,
      fast,
      maxTokens: effectiveMaxTokens,
      temperature,
      model: activeModel,
      systemInstruction: systemPrompt || undefined,
      responseMimeType: jsonMode ? 'application/json' : undefined,
    });
  }

  if (!result?.content) {
    await logTransaction({
      clientId,
      feature,
      provider: activeProvider,
      model: activeModel,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      source: 'byo',
      success: false,
      errorCode: 'EMPTY_RESPONSE',
    });
    const err = new Error('AI_EMPTY_RESPONSE');
    err.code = 'AI_EMPTY_RESPONSE';
    throw err;
  }

  const inputTokens = result.usage?.inputTokens || 0;
  const outputTokens = result.usage?.outputTokens || 0;
  const costUsd = calculateCost(activeProvider, activeModel, inputTokens, outputTokens);

  await logTransaction({
    clientId,
    feature,
    provider: activeProvider,
    model: activeModel,
    inputTokens,
    outputTokens,
    costUsd,
    source: 'byo',
    success: true,
  });
  await incrementWalletTotals(clientId, inputTokens, outputTokens, costUsd);

  return {
    content: result.content,
    usage: { inputTokens, outputTokens, costUsd },
    model: activeModel,
    provider: activeProvider,
  };
}

function parseJsonContent(raw) {
  if (!raw) return null;
  try {
    const clean = String(raw)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();
    return JSON.parse(clean);
  } catch (_) {
    return null;
  }
}

async function callAIJSON(options) {
  const result = await callAI({
    ...options,
    jsonMode: true,
    temperature: options.temperature ?? 0.2,
  });
  const parsed = parseJsonContent(result.content);
  if (!parsed) {
    const err = new Error('AI_JSON_PARSE_FAILED');
    err.code = 'AI_JSON_PARSE_FAILED';
    throw err;
  }
  return { data: parsed, usage: result.usage, model: result.model, provider: result.provider };
}

async function logEmbeddingUsage(clientId, textLength = 0, success = true, errorCode = null, provider = 'gemini') {
  if (!success) return;
  const estimatedTokens = Math.max(1, Math.ceil(textLength / 4));
  const rawModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
  const deprecated = new Set(['text-embedding-004', 'embedding-001']);
  const model = provider === 'openai'
    ? 'text-embedding-3-small'
    : (deprecated.has(rawModel) ? 'gemini-embedding-001' : rawModel);
  const costUsd = calculateCost(provider, model, estimatedTokens, 0) || 0;
  await logTransaction({
    clientId,
    feature: 'embedding',
    provider: provider || 'gemini',
    model,
    inputTokens: estimatedTokens,
    outputTokens: 0,
    costUsd,
    source: 'byo',
    success,
    errorCode,
  });
  if (success) {
    await incrementWalletTotals(clientId, estimatedTokens, 0, costUsd);
  }
}

async function validateGeminiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!isKeyValid(key)) {
    return { valid: false, error: 'Invalid Gemini API key format. Keys must start with AIza.' };
  }
  try {
    const axios = require('axios');
    const { filterGeminiModelsFromApi, mergeModelLists, GEMINI_MODELS } = require('../../constants/aiModels');
    const resp = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { timeout: 12000 }
    );
    if (resp.status === 200) {
      const models = mergeModelLists(GEMINI_MODELS, filterGeminiModelsFromApi(resp.data?.models || []));
      return { valid: true, models };
    }
    return { valid: false, error: 'Key validation failed.' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return { valid: false, error: 'Invalid or expired Gemini API key.' };
    }
    return { valid: false, error: err.message || 'Validation request failed.' };
  }
}

module.exports = {
  callAI,
  callAIJSON,
  calculateCost,
  validateGeminiKey,
  validateOpenAiKey,
  logTransaction,
  logEmbeddingUsage,
  parseJsonContent,
};
