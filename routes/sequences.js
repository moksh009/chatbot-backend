const express = require('express');
const router = express.Router();
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const moment = require('moment');

// Max active sequences per lead
const MAX_ACTIVE_SEQUENCES = 2;

router.post('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leads, name, steps } = req.body; // leads is [{ leadId, phone, email }]
    
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'No leads provided' });
    }

    const enrolledSequences = [];
    const errors = [];

    for (const lead of leads) {
      const { leadId, phone, email } = lead;

      // Check for existing active sequences
      const activeCount = await FollowUpSequence.countDocuments({
        clientId,
        leadId,
        status: "active"
      });

      if (activeCount >= MAX_ACTIVE_SEQUENCES) {
        errors.push({ leadId, message: 'Active sequence limit reached' });
        continue;
      }
      
      // Parse and schedule steps
      let currentSendAt = moment();
      const mappedSteps = steps.map(s => {
        const { delayValue, delayUnit, type, templateId, templateName, subject, content } = s;
        currentSendAt = currentSendAt.add(delayValue || 0, delayUnit || 'm');

        return {
          type: type || 'whatsapp',
          templateId,
          templateName,
          subject,
          content,
          delayValue,
          delayUnit,
          sendAt: currentSendAt.toDate(),
          status: "pending"
        };
      });

      const sequence = new FollowUpSequence({
        clientId,
        leadId,
        phone,
        email,
        name: name || 'Untitled Sequence',
        steps: mappedSteps
      });

      await sequence.save();
      
      if (leadId) {
        await AdLead.findByIdAndUpdate(leadId, { 
          $set: { "metaData.hasActiveSequence": true }
        });
      }
      enrolledSequences.push(sequence);
    }

    res.json({ 
      success: true, 
      count: enrolledSequences.length, 
      skipped: errors.length,
      errors: errors.length > 0 ? errors : undefined 
    });
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

// Cancel a sequence
router.patch('/:clientId/:sequenceId/cancel', protect, async (req, res) => {
  try {
    const { clientId, sequenceId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const seq = await FollowUpSequence.findOneAndUpdate(
      { _id: sequenceId, clientId },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    
    res.json({ success: true, sequence: seq });
  } catch (error) {
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
