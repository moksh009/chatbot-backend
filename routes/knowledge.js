const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { ensureClientForUser } = require('../utils/ensureClientForUser');
const log = require('../utils/logger')('KnowledgeRoute');
const { tenantClientId } = require('../utils/queryHelpers');
const { clearKnowledgeContextCache } = require('../utils/personaEngine');

/**
 * @route   GET /api/knowledge
 * @desc    Get the full knowledge base of a client
 */
router.get('/', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ message: 'Unauthorized' });

    await ensureClientForUser(req.user);
    const client = await Client.findOne({ clientId }).select('knowledgeBase');
    if (!client) return res.status(404).json({ message: 'Client not found' });

    res.json(client.knowledgeBase || {});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/knowledge/pending
 * @desc    Get all pending knowledge proposals for a client
 */
router.get('/pending', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ message: 'Unauthorized' });

    await ensureClientForUser(req.user);
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const pending = (client.pendingKnowledge || []).filter((k) => k.status === 'pending');
    res.json(pending);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/knowledge/action
 * @desc    Approve or Reject a knowledge proposal
 */
router.post('/action', protect, async (req, res) => {
  try {
    const { proposalId, action } = req.body;
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    await ensureClientForUser(req.user);
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const proposalIndex = client.pendingKnowledge.findIndex(k => k._id.toString() === proposalId);
    if (proposalIndex === -1) return res.status(404).json({ message: 'Proposal not found' });

    const proposal = client.pendingKnowledge[proposalIndex];
    proposal.status = action;

    if (action === 'approved') {
      const { type, content } = proposal;
      if (type === 'faq') {
        client.knowledgeBase.faqs.push({
          question: content.question_or_fact || content.question,
          answer: content.answer
        });
      } else if (type === 'fact') {
        // Append to 'about' or shared facts
        client.knowledgeBase.about = (client.knowledgeBase.about || '') + '\n' + (content.question_or_fact || content.fact);
      }
    }

    // Mark as processed
    await client.save();
    res.json({ message: `Proposal ${action} successfully`, client });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   PUT /api/knowledge/policies
 * @desc    Save core operational policies manually
 */
router.put('/policies', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const { about, returnPolicy, shippingPolicy } = req.body;

    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    if (!client.knowledgeBase) client.knowledgeBase = {};
    if (about !== undefined) client.knowledgeBase.about = about;
    if (returnPolicy !== undefined) client.knowledgeBase.returnPolicy = returnPolicy;
    if (shippingPolicy !== undefined) client.knowledgeBase.shippingPolicy = shippingPolicy;

    await client.save();
    res.json({ success: true, message: 'Policies saved successfully.', knowledgeBase: client.knowledgeBase });
  } catch (err) {
    log.error('Policies Save Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/knowledge/faq
 * @desc    Add a manual FAQ entry to the knowledge base
 * BUG 7 FIX: Enables the non-functional "Add FAQ" button in KnowledgeHub UI
 */
router.post('/faq', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const { question, answer } = req.body;

    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!question?.trim() || !answer?.trim()) {
      return res.status(400).json({ success: false, message: 'Both question and answer are required.' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Initialize knowledgeBase.faqs if missing
    if (!client.knowledgeBase) client.knowledgeBase = {};
    if (!client.knowledgeBase.faqs) client.knowledgeBase.faqs = [];

    client.knowledgeBase.faqs.push({ question: question.trim(), answer: answer.trim() });
    await client.save();

    log.info(`FAQ added for client ${clientId}: "${question.substring(0, 40)}..."`);
    res.json({ 
      success: true, 
      message: 'FAQ added successfully.',
      faqs: client.knowledgeBase.faqs
    });
  } catch (err) {
    log.error('FAQ Add Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   DELETE /api/knowledge/faq/:index
 * @desc    Delete a specific FAQ entry by index
 * BUG 7 FIX: Enables the non-functional delete button per FAQ in KnowledgeHub UI
 */
router.delete('/faq/:index', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const faqIndex = parseInt(req.params.index);

    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (isNaN(faqIndex) || faqIndex < 0) {
      return res.status(400).json({ success: false, message: 'Valid FAQ index required.' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const faqs = client.knowledgeBase?.faqs || [];
    if (faqIndex >= faqs.length) {
      return res.status(404).json({ success: false, message: 'FAQ entry not found at given index.' });
    }

    client.knowledgeBase.faqs.splice(faqIndex, 1);
    await client.save();

    log.info(`FAQ deleted at index ${faqIndex} for client ${clientId}`);
    res.json({ 
      success: true, 
      message: 'FAQ removed successfully.',
      faqs: client.knowledgeBase.faqs
    });
  } catch (err) {
    log.error('FAQ Delete Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/knowledge/audit
 * @desc    Run a system health audit
 */
router.get('/audit', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ message: 'Unauthorized' });

    const { auditClientSystem } = require('../utils/flowAuditor');
    const audit = await auditClientSystem(clientId);
    res.json(audit);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * ─────────────────────────────────────────────────────────────
 * DOCUMENT-BASED KNOWLEDGE BASE (KnowledgeDocument model)
 * Enterprise-grade CRUD for standalone knowledge documents.
 * ─────────────────────────────────────────────────────────────
 */

/**
 * @route   GET /api/knowledge/documents
 * @desc    List all knowledge documents for a client
 */
router.get('/documents', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const KnowledgeDocument = require('../models/KnowledgeDocument');
    const docs = await KnowledgeDocument.find({ clientId })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ success: true, documents: docs });
  } catch (err) {
    log.error('Knowledge Documents List Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   POST /api/knowledge/documents
 * @desc    Create a new knowledge document
 */
router.post('/documents', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const {
      title,
      content,
      sourceType,
      sourceUrl,
      documentType,
      type,
      isActive,
    } = req.body;

    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ success: false, message: 'Title and content are required.' });
    }

    const dt = documentType || type || 'custom';
    const allowedTypes = ['product_catalog', 'sop', 'faq', 'policy', 'custom'];
    const normalizedType = allowedTypes.includes(dt) ? dt : 'custom';

    const KnowledgeDocument = require('../models/KnowledgeDocument');
    const doc = await KnowledgeDocument.create({
      clientId,
      title: title.trim(),
      content: content.trim(),
      documentType: normalizedType,
      sourceType: sourceType || 'manual',
      sourceUrl: sourceUrl || undefined,
      isActive: isActive !== false,
      status: 'processed',
    });

    clearKnowledgeContextCache(clientId);
    log.info(`Knowledge doc created for ${clientId}: "${title.substring(0, 40)}"`);
    res.status(201).json({ success: true, document: doc });
  } catch (err) {
    log.error('Knowledge Document Create Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   PUT /api/knowledge/documents/:id
 * @desc    Update a knowledge document
 */
router.put('/documents/:id', protect, async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    if (!tenantId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const { title, content, isActive, documentType, type } = req.body;
    const KnowledgeDocument = require('../models/KnowledgeDocument');

    const existing = await KnowledgeDocument.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Document not found' });
    if (existing.clientId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const rawType = documentType || type;
    const allowedTypes = ['product_catalog', 'sop', 'faq', 'policy', 'custom'];
    const normalizedType =
      rawType && allowedTypes.includes(rawType) ? rawType : undefined;

    const doc = await KnowledgeDocument.findByIdAndUpdate(
      req.params.id,
      {
        ...(title !== undefined && { title: title.trim() }),
        ...(content !== undefined && { content: content.trim() }),
        ...(isActive !== undefined && { isActive }),
        ...(normalizedType && { documentType: normalizedType }),
      },
      { new: true }
    );

    clearKnowledgeContextCache(tenantId);
    res.json({ success: true, document: doc });
  } catch (err) {
    log.error('Knowledge Document Update Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   DELETE /api/knowledge/documents/:id
 * @desc    Delete a knowledge document
 */
router.delete('/documents/:id', protect, async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    if (!tenantId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const KnowledgeDocument = require('../models/KnowledgeDocument');
    const existing = await KnowledgeDocument.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Document not found' });
    if (existing.clientId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const doc = await KnowledgeDocument.findByIdAndDelete(req.params.id);

    clearKnowledgeContextCache(tenantId);
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * @route   POST /api/knowledge/test
 * @desc    Test knowledge extraction via Gemini using the dynamic context
 */
router.post('/test', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const query = req.body.query ?? req.body.question;

    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!query || !String(query).trim()) return res.status(400).json({ success: false, message: 'Query required' });

    const { buildKnowledgeContext } = require('../utils/personaEngine');
    const { platformGenerateText } = require('../utils/gemini');

    const context = await buildKnowledgeContext(clientId);
    
    if (!context) {
      return res.json({ success: true, answer: "Knowledge base is empty. Please add documents or FAQs first." });
    }

    const systemPrompt = `You are a helpful business assistant. Use ONLY the following business knowledge to answer the user's question. If the answer is not in the knowledge base, say "I don't have that information in my knowledge base." Do NOT make up answers.\n${context}`;

    const answer = await platformGenerateText(systemPrompt, String(query).trim());

    res.json({ success: true, answer, contextUsed: true });
  } catch (err) {
    log.error('Knowledge Test Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
