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
