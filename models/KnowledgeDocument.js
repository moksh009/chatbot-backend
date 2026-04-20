const mongoose = require('mongoose');

const knowledgeDocumentSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    sourceType: { type: String, enum: ['manual', 'upload', 'website'], default: 'manual' },
    sourceUrl: { type: String },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'processed' }
}, { timestamps: true });

module.exports = mongoose.model('KnowledgeDocument', knowledgeDocumentSchema);
