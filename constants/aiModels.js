'use strict';

const {
  GEMINI_MODELS,
  OPENAI_MODELS,
  filterToCuratedModels,
  defaultModelForProvider,
} = require('./aiModelCatalog');

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

function curatedModelsForProvider(provider, fetched) {
  const defaults = provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
  if (provider === 'openai') {
    const openaiMerged = mergeModelLists(defaults, filterOpenAiModelsFromApi(fetched));
    return filterToCuratedModels('openai', openaiMerged);
  }
  const geminiMerged = mergeModelLists(defaults, filterGeminiModelsFromApi(fetched));
  return filterToCuratedModels('gemini', geminiMerged);
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
  const allowed = provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
  if (!allowed.includes(m)) return false;
  if (Array.isArray(availableList) && availableList.length) {
    return availableList.includes(m);
  }
  return true;
}

module.exports = {
  GEMINI_MODELS,
  OPENAI_MODELS,
  OPENAI_EMBEDDING_MODELS,
  CUSTOMER_INQUIRY_FEATURES,
  mergeModelLists,
  curatedModelsForProvider,
  filterToCuratedModels,
  defaultModelForProvider,
  filterGeminiModelsFromApi,
  filterOpenAiModelsFromApi,
  isAllowedModel,
};
