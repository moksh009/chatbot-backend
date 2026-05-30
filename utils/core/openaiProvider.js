'use strict';

const OpenAI = require('openai');

const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'];

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
    await client.models.list({ limit: 1 });
    return { valid: true, models: OPENAI_MODELS };
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status === 401) {
      return { valid: false, error: 'Invalid or expired OpenAI API key.' };
    }
    return { valid: false, error: err.message || 'OpenAI key validation failed.' };
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
  isOpenAiKey,
  validateOpenAiKey,
  generateTextWithUsage,
};
