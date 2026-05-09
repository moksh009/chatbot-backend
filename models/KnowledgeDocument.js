const mongoose = require('mongoose');

const knowledgeDocumentSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    /** Dashboard taxonomy (Product catalog, SOP, FAQ, …) */
    documentType: {
      type: String,
      enum: ['product_catalog', 'sop', 'faq', 'policy', 'custom'],
      default: 'custom'
    },
    sourceType: { type: String, enum: ['manual', 'upload', 'website'], default: 'manual' },
    sourceUrl: { type: String },
    /** When false, excluded from bot / test retrieval (Draft in UI). */
    isActive: { type: Boolean, default: true },
    /** Async ingest pipeline (scrapers); manual docs stay `processed`. */
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'processed' }
}, { timestamps: true });

module.exports = mongoose.model('KnowledgeDocument', knowledgeDocumentSchema);
