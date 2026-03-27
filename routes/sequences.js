const express = require('express');
const router = express.Router();
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');

router.post('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leadId, phone, steps } = req.body;
    
    // Parse times
    const mappedSteps = steps.map(s => ({
      message: s.message,
      templateId: s.templateId,
      sendAt: new Date(s.sendAt),
      status: "pending"
    }));

    const sequence = new FollowUpSequence({
      clientId,
      leadId,
      phone,
      steps: mappedSteps
    });

    await sequence.save();
    res.json({ success: true, sequence });
  } catch (error) {
    console.error('Sequence creation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leadId } = req.query;
    const query = { clientId };
    if (leadId) query.leadId = leadId;

    const sequences = await FollowUpSequence.find(query).sort({ createdAt: -1 });
    res.json({ success: true, sequences });
  } catch (error) {
    console.error('Sequence fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:clientId/:sequenceId', protect, async (req, res) => {
  try {
    const { clientId, sequenceId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    await FollowUpSequence.findOneAndDelete({ _id: sequenceId, clientId });
    res.json({ success: true, message: "Sequence deleted" });
  } catch (error) {
    console.error('Sequence delete error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
