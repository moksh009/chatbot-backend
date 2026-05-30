'use strict';

/** Curated defaults — merged with live API lists on key validation. */
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
];

const OPENAI_MODELS = [
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4o-2024-08-06',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1',
  'o1-mini',
  'o3-mini',
];

const OPENAI_EMBEDDING_MODELS = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'];

/** Token usage attributed to customer-facing AI on the SaaS platform. */
const CUSTOMER_INQUIRY_FEATURES = ['whatsapp_bot', 'knowledge_test', 'persona_preview'];

function mergeModelLists(defaults, fetched) {
  const seen = new Set();
  const out = [];
  for (const m of [...(fetched || []), ...defaults]) {
    const id = String(m || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function filterGeminiModelsFromApi(models) {
  return (models || [])
    .map((m) => String(m.name || m || '').replace(/^models\//, ''))
    .filter((n) => n && n.includes('gemini') && !n.includes('embedding') && !n.includes('aqa'))
    .sort();
}

function filterOpenAiModelsFromApi(models) {
  return (models || [])
    .map((m) => m.id || m)
    .filter((id) => {
      const s = String(id);
      return (
        s.startsWith('gpt-')
        || s.startsWith('o1')
        || s.startsWith('o3')
        || s.startsWith('o4')
        || s.startsWith('chatgpt-')
      ) && !s.includes('instruct') && !s.includes('realtime') && !s.includes('audio');
    })
    .sort();
}

function isAllowedModel(provider, model, availableList) {
  const m = String(model || '').trim();
  if (!m) return false;
  if (Array.isArray(availableList) && availableList.includes(m)) return true;
  if (provider === 'gemini') return /^gemini-/.test(m);
  if (provider === 'openai') return /^(gpt-|o\d|chatgpt-)/.test(m);
  return false;
}

module.exports = {
  GEMINI_MODELS,
  OPENAI_MODELS,
  OPENAI_EMBEDDING_MODELS,
  CUSTOMER_INQUIRY_FEATURES,
  mergeModelLists,
  filterGeminiModelsFromApi,
  filterOpenAiModelsFromApi,
  isAllowedModel,
};
