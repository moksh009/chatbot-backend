'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireIntelligenceV2 } = require('../middleware/requireIntelligenceV2');
const { tenantClientId } = require('../utils/core/queryHelpers');
const KnowledgeDocument = require('../models/KnowledgeDocument');
const { buildKnowledgeFromWebsite } = require('../utils/core/websiteKnowledgeBuilder');
const {
  getKnowledgeStats,
  runKnowledgeTest,
  failStaleProcessingDocuments,
  notifyRagFailure,
  isRagUnavailableError,
} = require('../utils/core/ragEngine');
const { sendAiError, isAiProviderError } = require('../utils/core/aiProviderErrors');

router.use(protect, requireIntelligenceV2());

router.get('/stats', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const stats = await getKnowledgeStats(clientId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/documents', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    await failStaleProcessingDocuments(clientId);

    const docs = await KnowledgeDocument.find({ clientId })
      .select('-chunks.embedding')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/documents', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { title, content, status = 'draft', source = 'manual', sourceUrl = null } = req.body || {};
    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'Title and content are required.' });
    }

    const doc = await KnowledgeDocument.create({
      clientId,
      title: title.trim().slice(0, 200),
      content: content.trim().slice(0, 20000),
      status: status === 'active' ? 'active' : 'draft',
      source,
      sourceUrl,
      characterCount: content.trim().length,
      embeddingStatus: 'pending',
    });

    await embedDocumentNow(doc._id.toString(), clientId);
    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/documents/:id', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const doc = await KnowledgeDocument.findOne({ _id: req.params.id, clientId });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    const { title, content, status } = req.body || {};
    const updates = { updatedAt: new Date() };

    if (title?.trim()) updates.title = title.trim().slice(0, 200);
    if (content?.trim()) {
      updates.content = content.trim().slice(0, 20000);
      updates.characterCount = updates.content.length;
      updates.embeddingStatus = 'pending';
      updates.chunks = [];
    }
    if (status === 'active' || status === 'draft') updates.status = status;

    await KnowledgeDocument.updateOne({ _id: doc._id }, { $set: updates });
    const updated = await KnowledgeDocument.findById(doc._id).select('-chunks.embedding').lean();

    if (content?.trim()) {
      await embedDocumentNow(doc._id.toString(), clientId);
    } else if (status === 'active' && doc.embeddingStatus === 'pending') {
      await embedDocumentNow(doc._id.toString(), clientId);
    }

    res.json({ document: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const result = await KnowledgeDocument.deleteOne({ _id: req.params.id, clientId });
    if (!result.deletedCount) return res.status(404).json({ error: 'Document not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/import-url', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { url, title } = req.body || {};
    if (!url?.trim()) return res.status(400).json({ error: 'URL is required.' });

    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch (_) {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    const built = await buildKnowledgeFromWebsite(parsed.href, {
      clientId,
      useAiEnhance: false,
    });

    const docTitle = (title || built.title || parsed.hostname).slice(0, 200);
    const hostname = parsed.hostname.replace(/^www\./, '');

    const existing = await KnowledgeDocument.findOne({
      clientId,
      source: 'website_import',
      $or: [
        { sourceUrl: parsed.href },
        { sourceUrl: { $regex: hostname, $options: 'i' } },
        { title: { $regex: hostname, $options: 'i' } },
      ],
    }).sort({ updatedAt: -1 });

    let doc;
    if (existing) {
      await KnowledgeDocument.updateOne(
        { _id: existing._id },
        {
          $set: {
            title: docTitle,
            content: built.content,
            sourceUrl: parsed.href,
            characterCount: built.content.length,
            status: 'active',
            embeddingStatus: 'pending',
            chunks: [],
            updatedAt: new Date(),
          },
        }
      );
      doc = await KnowledgeDocument.findById(existing._id);
    } else {
      doc = await KnowledgeDocument.create({
        clientId,
        title: docTitle,
        content: built.content,
        status: 'active',
        source: 'website_import',
        sourceUrl: parsed.href,
        characterCount: built.content.length,
        embeddingStatus: 'pending',
      });
    }

    await embedDocumentNow(doc._id.toString(), clientId);
    res.status(existing ? 200 : 201).json({
      document: doc,
      productCount: built.productCount,
      replaced: !!existing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Import failed.' });
  }
});

const { queueDocumentEmbedding } = require('../workers/knowledgeEmbeddingQueues');

async function embedDocumentNow(documentId, clientId, { force = false } = {}) {
  if (force) {
    const { processDocumentEmbedding } = require('../utils/core/ragEngine');
    try {
      await processDocumentEmbedding(documentId, { force: true });
    } catch (err) {
      console.warn(`[knowledge] embed ${documentId}:`, err.message);
    }
    return;
  }
  await queueDocumentEmbedding(documentId, clientId, { force: false });
}

router.post('/documents/:id/reembed', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const doc = await KnowledgeDocument.findOne({ _id: req.params.id, clientId });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    await KnowledgeDocument.updateOne(
      { _id: doc._id },
      {
        $set: {
          embeddingStatus: 'pending',
          embeddingError: null,
          updatedAt: new Date(),
        },
      }
    );

    await embedDocumentNow(doc._id.toString(), clientId, { force: true });
    const updated = await KnowledgeDocument.findById(doc._id).select('-chunks.embedding').lean();
    res.json({ success: true, message: 'Embedding processed.', document: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/process-pending-embeddings', async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    await failStaleProcessingDocuments(clientId);

    const pending = await KnowledgeDocument.find({
      clientId,
      status: 'active',
      embeddingStatus: 'pending',
    }).limit(4);

    let queued = 0;
    for (const doc of pending) {
      const before = doc.embeddingStatus;
      await embedDocumentNow(doc._id.toString(), clientId);
      const after = await KnowledgeDocument.findById(doc._id).select('embeddingStatus').lean();
      if (before === 'pending' && after?.embeddingStatus !== 'pending') queued += 1;
    }
    res.json({ success: true, processed: queued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  const clientId = tenantClientId(req);
  try {
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Question is required.' });

    const result = await runKnowledgeTest(clientId, question.trim());
    res.json(result);
  } catch (err) {
    if (isRagUnavailableError(err)) {
      await notifyRagFailure(clientId, err.reason);
      return res.status(503).json({
        error: err.userMessage,
        code: err.code,
        reason: err.reason,
        ragBlocked: true,
      });
    }
    if (isAiProviderError(err)) {
      return sendAiError(res, err);
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
