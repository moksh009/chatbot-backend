'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const KnowledgeDocument = require('../models/KnowledgeDocument');
const { scrapeWebsiteText } = require('../utils/core/urlScraper');
const { queueDocumentEmbedding } = require('../workers/knowledgeEmbeddingQueues');
const {
  getKnowledgeStats,
  runKnowledgeTest,
} = require('../utils/core/ragEngine');

router.get('/stats', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    const stats = await getKnowledgeStats(clientId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/documents', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const docs = await KnowledgeDocument.find({ clientId })
      .select('-chunks.embedding')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/documents', protect, async (req, res) => {
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

    await queueDocumentEmbedding(doc._id.toString(), clientId);
    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/documents/:id', protect, async (req, res) => {
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
      await queueDocumentEmbedding(doc._id.toString(), clientId);
    }

    res.json({ document: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/documents/:id', protect, async (req, res) => {
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

router.post('/import-url', protect, async (req, res) => {
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

    const text = await scrapeWebsiteText(parsed.href);
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Could not extract enough text from that page.' });
    }

    const doc = await KnowledgeDocument.create({
      clientId,
      title: (title || parsed.hostname || 'Imported page').slice(0, 200),
      content: text.slice(0, 20000),
      status: 'draft',
      source: 'website_import',
      sourceUrl: parsed.href,
      characterCount: Math.min(text.length, 20000),
      embeddingStatus: 'pending',
    });

    await queueDocumentEmbedding(doc._id.toString(), clientId);
    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Import failed.' });
  }
});

router.post('/test', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Question is required.' });

    const result = await runKnowledgeTest(clientId, question.trim());
    res.json(result);
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED' || err.message === 'AI_NOT_CONFIGURED') {
      return res.status(400).json({ error: 'Configure your Gemini API key in AI Setup first.' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
