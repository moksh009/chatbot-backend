const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const log = require('../utils/logger')('KnowledgeRoute');

/**
 * @route   GET /api/knowledge
 * @desc    Get the full knowledge base of a client
 */
router.get('/', protect, async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ message: 'ClientId required' });

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
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ message: 'ClientId required' });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const pending = client.pendingKnowledge.filter(k => k.status === 'pending');
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
    const { clientId, proposalId, action } = req.body;
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

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
 * @route   GET /api/knowledge/audit
 * @desc    Run a system health audit
 */
router.get('/audit', protect, async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ message: 'ClientId required' });

    const { auditClientSystem } = require('../utils/flowAuditor');
    const audit = await auditClientSystem(clientId);
    res.json(audit);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
