const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/queryHelpers');
const router = express.Router();
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const moment = require('moment');
const SEQUENCE_TEMPLATES = require('../data/sequenceTemplates');
const Campaign = require('../models/Campaign');
const Client = require('../models/Client');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const { resolveImportBatchObjectId } = require('../utils/importBatchResolver');
const { validateTemplateEligibility } = require('../utils/templateEligibility');

// Max active sequences per lead
const MAX_ACTIVE_SEQUENCES = 2;

function normalizeDelayUnit(unit) {
  const raw = String(unit || 'm').toLowerCase().trim();
  if (raw === 'm' || raw === 'min' || raw === 'mins' || raw === 'minute' || raw === 'minutes') return 'm';
  if (raw === 'h' || raw === 'hr' || raw === 'hrs' || raw === 'hour' || raw === 'hours') return 'h';
  if (raw === 'd' || raw === 'day' || raw === 'days') return 'd';
  return 'm';
}

function normalizeDelayValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// Root handler for frontend compatibility (/api/automation -> /api/automation/)
router.get('/', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const sequences = await FollowUpSequence.find({ clientId }).populate('leadId', 'name').sort({ createdAt: -1 });
    res.json({ success: true, sequences });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

function validateSequenceSteps(steps, syncedMetaTemplates = []) {
  const failures = [];
  (steps || []).forEach((step, idx) => {
    if (String(step?.type || '').toLowerCase() !== 'whatsapp') return;
    const templateName = step?.templateName;
    if (!templateName) return;
    const template = syncedMetaTemplates.find((t) => t?.name === templateName);
    const eligibility = validateTemplateEligibility({
      template,
      contextPurpose: 'sequence',
      strict: true
    });
    if (!eligibility.ok) {
      failures.push({ step: idx + 1, templateName, reasons: eligibility.reasons });
    }
  });
  return failures;
}

router.post('/:clientId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leads, name, steps, type } = req.body; // leads is [{ leadId, phone, email }]
    
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'No leads provided' });
    }
    
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    const stepFailures = validateSequenceSteps(steps, client.syncedMetaTemplates || []);
    if (stepFailures.length) {
      console.warn('[Sequences][TemplatePreflightFailed]', {
        clientId,
        contextPurpose: 'sequence',
        failures: stepFailures
      });
      return res.status(400).json({
        success: false,
        message: 'One or more WhatsApp sequence steps have invalid/unapproved templates.',
        details: stepFailures
      });
    }

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
        const normalizedUnit = normalizeDelayUnit(delayUnit);
        const normalizedValue = normalizeDelayValue(delayValue);
        currentSendAt = currentSendAt.add(normalizedValue, normalizedUnit);

        return {
          type: type || 'whatsapp',
          templateId,
          templateName,
          subject,
          content,
          delayValue: normalizedValue,
          delayUnit: normalizedUnit,
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
        type: type || 'custom',
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
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leadId } = req.query;
    const query = { clientId };
    if (leadId) query.leadId = leadId;

    const sequences = await FollowUpSequence.find(query).populate('leadId', 'name').sort({ createdAt: -1 });
    res.json({ success: true, sequences });
  } catch (error) {
    console.error('Sequence fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET Pre-built templates
router.get('/:clientId/templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const templateFailures = validateSequenceSteps(template?.steps || [], client.syncedMetaTemplates || []);
    if (templateFailures.length) {
      console.warn('[Sequences][PlaybookTemplatePreflightFailed]', {
        clientId,
        templateId,
        contextPurpose: 'sequence',
        failures: templateFailures
      });
      return res.status(400).json({
        success: false,
        message: 'Selected playbook includes WhatsApp templates that are not approved/eligible.',
        details: templateFailures
      });
    }
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
        const normalizedUnit = normalizeDelayUnit(s.delayUnit);
        const normalizedValue = normalizeDelayValue(s.delayValue);
        currentSendAt = currentSendAt.add(normalizedValue, normalizedUnit);
        return {
           type: s.type || 'whatsapp',
           templateId: s.templateId,
           templateName: s.templateName,
           subject: s.subject,
           content: s.content,
           delayValue: normalizedValue,
           delayUnit: normalizedUnit,
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

// Enroll a sequence from imported CSV audience batch
router.post('/:clientId/from-imported-list', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { importBatchId, templateId, name } = req.body;
    if (!importBatchId) {
      return res.status(400).json({ success: false, message: 'importBatchId is required' });
    }
    if (!templateId) {
      return res.status(400).json({ success: false, message: 'templateId is required' });
    }

    const resolvedBatchId = await resolveImportBatchObjectId(importBatchId, clientId);
    if (!resolvedBatchId) {
      return res.status(404).json({ success: false, message: 'Import batch not found' });
    }

    const template = SEQUENCE_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Sequence template not found' });
    }

    const leads = await AdLead.find({
      clientId,
      importBatchId: resolvedBatchId,
      phoneNumber: { $exists: true, $ne: '' }
    }).select('_id name phoneNumber email').lean();

    if (!leads.length) {
      return res.status(400).json({ success: false, message: 'No leads found in this imported list' });
    }

    const client = await Client.findOne({ clientId }).select('_id').lean();
    const fullClient = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
    const templateFailures = validateSequenceSteps(template?.steps || [], fullClient?.syncedMetaTemplates || []);
    if (templateFailures.length) {
      console.warn('[Sequences][ImportedPlaybookTemplatePreflightFailed]', {
        clientId,
        templateId,
        contextPurpose: 'sequence',
        failures: templateFailures
      });
      return res.status(400).json({
        success: false,
        message: 'Selected playbook includes WhatsApp templates that are not approved/eligible.',
        details: templateFailures
      });
    }
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    const limitCheck = await checkLimit(client._id, 'sequences');
    if (!limitCheck.allowed) {
      return res.status(403).json({ success: false, message: limitCheck.reason });
    }

    const enrolledSequences = [];
    const errors = [];

    for (const lead of leads) {
      const activeCount = await FollowUpSequence.countDocuments({
        clientId,
        leadId: lead._id,
        status: 'active'
      });

      if (activeCount >= MAX_ACTIVE_SEQUENCES) {
        errors.push({ leadId: lead._id, message: 'Active sequence limit reached' });
        continue;
      }

      let currentSendAt = moment();
      const mappedSteps = (template.steps || []).map(step => {
        const normalizedUnit = normalizeDelayUnit(step.delayUnit);
        const normalizedValue = normalizeDelayValue(step.delayValue);
        currentSendAt = currentSendAt.add(normalizedValue, normalizedUnit);
        return {
          type: step.type || 'whatsapp',
          templateId: step.templateId,
          templateName: step.templateName,
          subject: step.subject,
          content: step.content,
          delayValue: normalizedValue,
          delayUnit: normalizedUnit,
          condition: step.condition,
          sendAt: currentSendAt.toDate(),
          status: 'pending'
        };
      });

      const sequence = new FollowUpSequence({
        clientId,
        leadId: lead._id,
        phone: lead.phoneNumber,
        email: lead.email,
        name: name || template.name || 'Imported List Sequence',
        type: template.category || 'custom',
        steps: mappedSteps
      });

      await sequence.save();
      await AdLead.findByIdAndUpdate(lead._id, { $set: { 'metaData.hasActiveSequence': true } });
      enrolledSequences.push(sequence);
    }

    if (enrolledSequences.length > 0) {
      await incrementUsage(client._id, 'sequences', enrolledSequences.length);
    }

    return res.json({
      success: true,
      count: enrolledSequences.length,
      skipped: errors.length,
      errors: errors.length ? errors : undefined,
      importBatchId: resolvedBatchId.toString()
    });
  } catch (error) {
    console.error('Imported list sequence enrollment error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to enroll sequence from imported list' });
  }
});

// Cancel a sequence
router.patch('/:clientId/:sequenceId/cancel', protect, async (req, res) => {
  try {
    const { sequenceId } = req.params;
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const { sequenceId } = req.params;
    const { status } = req.body;
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const { sequenceId } = req.params;
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
