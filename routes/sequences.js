const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const moment = require('moment');
const SEQUENCE_TEMPLATES = require('../data/sequenceTemplates');
const Campaign = require('../models/Campaign');
const Client = require('../models/Client');
const { checkLimit, incrementUsage } = require('../utils/planLimits');

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
    
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const limitCheck = await checkLimit(client._id, 'sequences');
    if (!limitCheck.allowed) {
      return res.status(403).json({ success: false, message: limitCheck.reason });
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

// GET Pre-built templates
router.get('/:clientId/templates', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    res.json({ success: true, templates: SEQUENCE_TEMPLATES });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST enroll from campaign
router.post('/:clientId/enroll-from-campaign', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { campaignId, templateId, condition } = req.body;
    if (!campaignId || !templateId || !condition) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    const campaign = await Campaign.findOne({ _id: campaignId, clientId });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const client = await Client.findOne({ clientId });
    const limitCheck = await checkLimit(client?._id, 'sequences');
    if (!limitCheck.allowed) {
      return res.status(403).json({ success: false, message: limitCheck.reason });
    }

    const template = SEQUENCE_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    // Determine target leads based on condition
    let targetPhones = [];
    if (condition === "no_reply") {
      targetPhones = campaign.stats.delivered.filter(p => !campaign.metrics?.replied?.includes(p));
    } else if (condition === "no_read") {
      targetPhones = campaign.stats.delivered.filter(p => !campaign.stats.read.includes(p));
    } else if (condition === "no_click") {
      targetPhones = campaign.stats.read.filter(p => !campaign.metrics?.clicked?.includes(p));
    }

    if (targetPhones.length === 0) {
      return res.json({ success: true, message: 'No leads matched this condition', count: 0 });
    }

    // Find the actual leads
    const leads = await AdLead.find({ clientId, phoneNumber: { $in: targetPhones } }).lean();
    if (!leads.length) {
      return res.json({ success: true, message: 'No valid leads found', count: 0 });
    }

    const enrolledSequences = [];
    const errors = [];

    // Enrollment loop
    for (const lead of leads) {
      const activeCount = await FollowUpSequence.countDocuments({
        clientId, leadId: lead._id, status: "active"
      });

      if (activeCount >= MAX_ACTIVE_SEQUENCES) {
        errors.push({ leadId: lead._id, message: 'Limit reached' });
        continue;
      }

      let currentSendAt = moment();
      const mappedSteps = template.steps.map(s => {
        currentSendAt = currentSendAt.add(s.delayValue || 0, s.delayUnit || 'm');
        return {
           type: s.type || 'whatsapp',
           templateId: s.templateId,
           templateName: s.templateName,
           subject: s.subject,
           content: s.content,
           delayValue: s.delayValue,
           delayUnit: s.delayUnit,
           condition: s.condition, // Store condition if template has one
           sendAt: currentSendAt.toDate(),
           status: "pending"
        };
      });

      const sequence = new FollowUpSequence({
        clientId,
        leadId: lead._id,
        phone: lead.phoneNumber,
        email: lead.email,
        name: template.name,
        steps: mappedSteps
      });

      await sequence.save();
      await AdLead.findByIdAndUpdate(lead._id, { $set: { "metaData.hasActiveSequence": true } });
      enrolledSequences.push(sequence);
    }

    res.json({
      success: true,
      count: enrolledSequences.length,
      skipped: errors.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Campaign sequence enrollment error:', error);
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

// Update sequence status (e.g., pause, resume)
router.patch('/:clientId/:sequenceId/status', protect, async (req, res) => {
  try {
    const { clientId, sequenceId } = req.params;
    const { status } = req.body;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const seq = await FollowUpSequence.findOneAndUpdate(
      { _id: sequenceId, clientId },
      { $set: { status } },
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
