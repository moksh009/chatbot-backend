'use strict';

/**
 * Merchant-facing curated models only — avoids dumping full provider API lists in the dashboard.
 * Pricing: USD per 1M tokens (input / output), approximate — verify on provider billing pages.
 */
const CURATED_GEMINI = [
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    inputUsdPerM: 0.1,
    outputUsdPerM: 0.4,
    badge: 'recommended',
    hint: 'Best value for WhatsApp volume — fast, low cost.',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    inputUsdPerM: 0.3,
    outputUsdPerM: 2.5,
    badge: 'balanced',
    hint: 'Smarter replies with low latency.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    inputUsdPerM: 1.25,
    outputUsdPerM: 10,
    badge: 'premium',
    hint: 'Complex reasoning or longer context.',
  },
];

const CURATED_OPENAI = [
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    inputUsdPerM: 0.15,
    outputUsdPerM: 0.6,
    badge: 'recommended',
    hint: 'Cheapest OpenAI chat — great for support bots.',
  },
  {
    id: 'gpt-4.1-nano',
    label: 'GPT-4.1 nano',
    inputUsdPerM: 0.1,
    outputUsdPerM: 0.4,
    badge: 'budget',
    hint: 'Ultra-low cost for simple Q&A.',
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    inputUsdPerM: 0.4,
    outputUsdPerM: 1.6,
    badge: 'balanced',
    hint: 'Strong instruction following, 1M context.',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    inputUsdPerM: 2.5,
    outputUsdPerM: 10,
    badge: 'premium',
    hint: 'Highest quality when budget allows.',
  },
];

const GEMINI_MODELS = CURATED_GEMINI.map((m) => m.id);
const OPENAI_MODELS = CURATED_OPENAI.map((m) => m.id);

const CURATED_IDS = {
  gemini: new Set(GEMINI_MODELS),
  openai: new Set(OPENAI_MODELS),
};

function filterToCuratedModels(provider, modelIds) {
  const allowed = CURATED_IDS[provider] || CURATED_IDS.gemini;
  const ids = Array.isArray(modelIds) ? modelIds : [];
  const curated = ids.filter((id) => allowed.has(id));
  if (curated.length) return curated;
  return provider === 'openai' ? [...OPENAI_MODELS] : [...GEMINI_MODELS];
}

function defaultModelForProvider(provider) {
  if (provider === 'openai') return 'gpt-4o-mini';
  return process.env.GEMINI_BOT_MODEL || 'gemini-2.5-flash-lite';
}

module.exports = {
  CURATED_GEMINI,
  CURATED_OPENAI,
  GEMINI_MODELS,
  OPENAI_MODELS,
  filterToCuratedModels,
  defaultModelForProvider,
};
