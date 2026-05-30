'use strict';

const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    text: { type: String },
    embedding: [{ type: Number }],
    chunkIndex: { type: Number },
  },
  { _id: false }
);

const knowledgeDocumentSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    title: { type: String, required: true, maxlength: 200 },
    content: { type: String, required: true, maxlength: 20000 },
    status: { type: String, enum: ['draft', 'active'], default: 'draft' },
    source: { type: String, enum: ['manual', 'website_import'], default: 'manual' },
    sourceUrl: { type: String, default: null },
    chunks: [chunkSchema],
    totalChunks: { type: Number, default: 0 },
    embeddingStatus: {
      type: String,
      enum: ['pending', 'processing', 'complete', 'failed'],
      default: 'pending',
    },
    embeddingProvider: { type: String, default: 'gemini' },
    embeddingDimensions: { type: Number, default: 3072 },
    embeddingError: { type: String, default: null, maxlength: 500 },
    embeddingStartedAt: { type: Date, default: null },
    characterCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

knowledgeDocumentSchema.index({ clientId: 1, status: 1 });
knowledgeDocumentSchema.index({ clientId: 1, embeddingStatus: 1 });

module.exports = mongoose.model('KnowledgeDocument', knowledgeDocumentSchema);
