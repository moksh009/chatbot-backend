'use strict';

const mongoose = require('mongoose');

/**
 * Per-tenant AI configuration (BYO Gemini and/or OpenAI — no platform billing).
 */
const aiWalletSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true, index: true },
    mode: {
      type: String,
      enum: ['byo_gemini', 'byo_openai', 'byo_both', 'not_configured'],
      default: 'not_configured',
    },
    /** Single active BYO provider — only one key at a time. */
    activeProvider: {
      type: String,
      enum: ['gemini', 'openai', null],
      default: null,
    },
    preferredProvider: {
      type: String,
      enum: ['auto', 'gemini', 'openai'],
      default: 'auto',
    },
    byoProvider: {
      type: String,
      enum: ['gemini', 'openai', null],
      default: null,
    },
    /** When false, bot uses linear flows only — no RAG/AI fallback. */
    aiSupportEnabled: { type: Boolean, default: true },
    /** Merchant cap for AI reply length (words). */
    maxOutputWords: { type: Number, default: 150, min: 30, max: 800 },
    /** Cached model ids returned from provider on last validation. */
    cachedGeminiModels: { type: [String], default: [] },
    cachedOpenaiModels: { type: [String], default: [] },
    byoApiKeyEncrypted: { type: String, default: null, select: false },
    byoModelSelected: { type: String, default: null },
    byoKeyValidatedAt: { type: Date, default: null },
    byoKeyIsValid: { type: Boolean, default: false },
    byoOpenaiApiKeyEncrypted: { type: String, default: null, select: false },
    byoOpenaiModelSelected: { type: String, default: 'gpt-4o-mini' },
    byoOpenaiKeyValidatedAt: { type: Date, default: null },
    byoOpenaiKeyIsValid: { type: Boolean, default: false },
    totalTokensUsed: { type: Number, default: 0 },
    totalInputTokens: { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AiWallet', aiWalletSchema);
