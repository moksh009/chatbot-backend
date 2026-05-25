'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const ClientPersonaEvolution = require('../models/ClientPersonaEvolution');
const Client = require('../models/Client');
const { auditLog } = require('../services/audit/auditWriter');

router.get('/suggestions', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const rows = await ClientPersonaEvolution.find({ clientId: req.user.clientId, status: 'pending' })
      .sort({ version: -1 })
      .limit(3)
      .lean();
    const client = await Client.findOne({ clientId: req.user.clientId }).select('ai.persona ai.systemPrompt').lean();
    res.json({
      success: true,
      currentPersona: client?.ai?.persona?.description || client?.ai?.systemPrompt || '',
      suggestions: rows,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/:id/activate', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const evo = await ClientPersonaEvolution.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!evo) return res.status(404).json({ success: false, message: 'Not found' });
    await Client.updateOne(
      { clientId: req.user.clientId },
      {
        $set: {
          'ai.persona.description': evo.personaText,
          'ai.systemPrompt': evo.personaText,
        },
      }
    );
    evo.status = 'activated';
    evo.activatedAt = new Date();
    evo.activatedBy = req.user._id;
    await evo.save();
    auditLog({
      category: 'ai',
      action: 'ai.persona_activated',
      clientId: req.user.clientId,
      actor: { type: 'user', userId: req.user._id, source: 'dashboard' },
      details: { version: evo.version },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/rollback/:version', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const version = Number(req.params.version);
    const evo = await ClientPersonaEvolution.findOne({
      clientId: req.user.clientId,
      version,
      status: 'activated',
    }).sort({ activatedAt: -1 });
    if (!evo) return res.status(404).json({ success: false, message: 'Version not found' });
    const text = evo.previousPersonaText || evo.personaText;
    await Client.updateOne(
      { clientId: req.user.clientId },
      { $set: { 'ai.persona.description': text, 'ai.systemPrompt': text } }
    );
    auditLog({
      category: 'ai',
      action: 'ai.persona_rolled_back',
      clientId: req.user.clientId,
      actor: { type: 'user', userId: req.user._id, source: 'dashboard' },
      details: { version },
    });
    res.json({ success: true, personaText: text });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/:id/dismiss', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    await ClientPersonaEvolution.updateOne(
      { _id: req.params.id, clientId: req.user.clientId },
      { $set: { status: 'dismissed' } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
