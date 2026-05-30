'use strict';

const OpenAI = require('openai');
const {
  OPENAI_MODELS,
  OPENAI_EMBEDDING_MODELS,
  mergeModelLists,
  filterOpenAiModelsFromApi,
} = require('../../constants/aiModels');

function isOpenAiKey(apiKey) {
  const k = String(apiKey || '').trim();
  return k.startsWith('sk-');
}

async function validateOpenAiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!isOpenAiKey(key)) {
    return { valid: false, error: 'Invalid OpenAI API key format. Keys must start with sk-.' };
  }
  try {
    const client = new OpenAI({ apiKey: key, timeout: 12000 });
    const listed = await client.models.list({ limit: 100 });
    const fetched = filterOpenAiModelsFromApi(listed.data || []);
    const models = mergeModelLists(OPENAI_MODELS, fetched);
    return { valid: true, models };
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status === 401) {
      return { valid: false, error: 'Invalid or expired OpenAI API key.' };
    }
    return { valid: false, error: err.message || 'OpenAI key validation failed.' };
  }
}

async function embedTextOpenAI(text, apiKey, options = {}) {
  const key = String(apiKey || '').trim();
  if (!isOpenAiKey(key)) return null;
  const input = String(text || '').trim().slice(0, 8000);
  if (!input) return null;
  const model = options.model || OPENAI_EMBEDDING_MODELS[0];
  try {
    const client = new OpenAI({ apiKey: key, timeout: options.timeout || 20000 });
    const resp = await client.embeddings.create({ model, input });
    const values = resp.data?.[0]?.embedding;
    if (!Array.isArray(values) || !values.length) return null;
    return { embedding: values, dimensions: values.length };
  } catch (err) {
    return null;
  }
}

async function generateTextWithUsage(prompt, apiKey, options = {}) {
  const {
    systemInstruction,
    maxTokens = 300,
    temperature = 0.4,
    model = 'gpt-4o-mini',
    responseMimeType,
  } = options;

  const client = new OpenAI({ apiKey: String(apiKey).trim(), timeout: options.timeout || 60000 });
  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: String(prompt || '') });

  const params = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (responseMimeType === 'application/json') {
    params.response_format = { type: 'json_object' };
  }

  const resp = await client.chat.completions.create(params);
  const content = resp.choices?.[0]?.message?.content || '';
  const inputTokens = resp.usage?.prompt_tokens || 0;
  const outputTokens = resp.usage?.completion_tokens || 0;

  return {
    content,
    usage: { inputTokens, outputTokens },
  };
}

module.exports = {
  OPENAI_MODELS,
  OPENAI_EMBEDDING_MODELS,
  isOpenAiKey,
  validateOpenAiKey,
  generateTextWithUsage,
  embedTextOpenAI,
};
