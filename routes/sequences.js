const express = require('express');
const mongoose = require('mongoose');
const { resolveClient, tenantClientId } = require('../utils/core/queryHelpers');
const router = express.Router();
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const moment = require('moment');
const SEQUENCE_TEMPLATES = require('../data/sequenceTemplates');
const {
  filterSequenceTemplates,
  isDeprecatedSequenceTemplateId,
  isLegacyFollowUpSequence,
  isLegacyNicheAutomationBlocked,
} = require('../config/ecommerceOnlyPolicy');
const Campaign = require('../models/Campaign');
const Client = require('../models/Client');
const { checkLimit, incrementUsage } = require('../utils/core/planLimits');
const { resolveImportBatchObjectId } = require('../utils/core/importBatchResolver');
const { validateTemplateEligibility } = require('../utils/meta/templateEligibility');

// Max active sequences per lead
const MAX_ACTIVE_SEQUENCES = 2;

/**
 * One aggregation instead of N countDocuments — enrollment hot path.
 * Returns Map leadIdStr -> active count (DB state before this request mutates it).
 */
async function activeSequenceCountMap(clientId, leadIds) {
  const unique = [...new Set((leadIds || []).filter(Boolean).map((id) => String(id)))];
  const oids = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!oids.length) return new Map();

  const rows = await FollowUpSequence.aggregate([
    { $match: { clientId, status: 'active', leadId: { $in: oids } } },
    { $group: { _id: '$leadId', n: { $sum: 1 } } }
  ]);
  const m = new Map();
  rows.forEach((r) => m.set(String(r._id), r.n));
  return m;
}

async function syncLeadHasActiveSequence(clientId, leadId) {
  if (!leadId || !mongoose.Types.ObjectId.isValid(String(leadId))) return;
  const count = await FollowUpSequence.countDocuments({
    clientId,
    leadId,
    status: 'active',
  });
  await AdLead.findByIdAndUpdate(leadId, {
    $set: { 'metaData.hasActiveSequence': count > 0 },
  });
}

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
    const sequences = await FollowUpSequence.find({ clientId })
      .populate('leadId', 'name')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, sequences });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

function validateSequenceSteps(steps, syncedMetaTemplates = [], clientId = null) {
  const failures = [];
  const resolveOne = async (templateName) => {
    let template = syncedMetaTemplates.find((t) => t?.name === templateName);
    if (template) return template;
    if (!clientId) return null;
    try {
      const { resolveTemplateForSend } = require('../services/templateResolver');
      const resolved = await resolveTemplateForSend(clientId, { name: templateName });
      if (!resolved?.template) return null;
      const row = resolved.template;
      return {
        name: templateName,
        status: 'APPROVED',
        category: row.category || row.metaCategory || 'MARKETING',
        components: row.components || [],
        primaryPurpose: row.primaryPurpose || 'marketing',
        secondaryPurposes: Array.isArray(row.secondaryPurposes)
          ? row.secondaryPurposes
          : ['sequence', 'campaign', 'marketing'],
      };
    } catch {
      return null;
    }
  };

  return (async () => {
    for (let idx = 0; idx < (steps || []).length; idx += 1) {
      const step = steps[idx];
      const type = String(step?.type || 'whatsapp').toLowerCase();
      if (type === 'email') {
        if (!String(step?.subject || '').trim()) {
          failures.push({ step: idx + 1, type: 'email', reasons: ['Email subject is required'] });
        }
        if (!String(step?.content || '').trim()) {
          failures.push({ step: idx + 1, type: 'email', reasons: ['Email body is required'] });
        }
        continue;
      }
      const templateName = step?.templateName;
      if (!templateName) {
        failures.push({ step: idx + 1, type: 'whatsapp', reasons: ['WhatsApp template is required'] });
        continue;
      }
      const template = await resolveOne(templateName);
      const eligibility = validateTemplateEligibility({
        template,
        contextPurpose: 'sequence',
        availableFields: ['1', '2', '3', '4', '5', '6', 'name', 'phone', 'email'],
        strict: true,
      });
      if (!eligibility.ok) {
        failures.push({ step: idx + 1, templateName, reasons: eligibility.reasons });
      }
    }
    return failures;
  })();
}

router.post('/:clientId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { leads, name, steps, type } = req.body; // leads is [{ leadId, phone, email }]

    if (isLegacyNicheAutomationBlocked() && isLegacyFollowUpSequence({ name, steps })) {
      return res.status(400).json({
        success: false,
        message:
          'Appointment reminder sequences are disabled by default. Set BLOCK_LEGACY_NICHE_AUTOMATION=false to enroll.',
      });
    }
    
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'No leads provided' });
    }
    
    const client = await Client.findOne({ clientId }).select('_id syncedMetaTemplates gmailAddress gmailRefreshToken gmailAccessToken emailMethod googleConnected').lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const hasEmailSteps = (steps || []).some((s) => String(s.type || '').toLowerCase() === 'email');
    if (hasEmailSteps) {
      const { isWorkspaceEmailReady } = require('../utils/core/emailService');
      if (!isWorkspaceEmailReady(client)) {
        return res.status(400).json({
          success: false,
          message: 'Connect Gmail in Settings before enrolling sequences with email steps.',
        });
      }
    }

    const stepFailures = await validateSequenceSteps(steps, client.syncedMetaTemplates || [], clientId);
    if (stepFailures.length) {
      console.warn('[Sequences][TemplatePreflightFailed]', {
        clientId,
        contextPurpose: 'sequence',
        failures: stepFailures
      });
      return res.status(400).json({
        success: false,
        message: 'One or more sequence steps are invalid. Check WhatsApp templates and email subject/body.',
        details: stepFailures
      });
    }

    const limitCheck = await checkLimit(client._id, 'sequences');
    if (!limitCheck.allowed) {
      return res.status(403).json({ success: false, message: limitCheck.reason });
    }

    const enrolledSequences = [];
    const errors = [];

    const leadOidList = leads.map((l) => l.leadId).filter(Boolean);
    let countMap = await activeSequenceCountMap(clientId, leadOidList);

    const { ensureLeadForSequence } = require('../utils/messaging/ensureLeadForSequence');

    const onlyEmailSteps = hasEmailSteps && (steps || []).every((s) => String(s.type || '').toLowerCase() === 'email');
    const hasWaSteps = (steps || []).some((s) => String(s.type || '').toLowerCase() !== 'email');

    for (const leadInput of leads) {
      let { leadId, phone, email } = leadInput;
      if (!leadId && phone) {
        const ensured = await ensureLeadForSequence({
          clientId,
          phone,
          email,
          source: 'sequence_bulk_enroll',
        });
        leadId = ensured._id;
        phone = ensured.phoneNumber;
        email = ensured.email;
      }

      if (!leadId) {
        errors.push({ phone, message: 'Could not resolve lead for enrollment' });
        continue;
      }

      const leadDoc = await AdLead.findById(leadId)
        .select('cartStatus recoveryStep isOrderPlaced suppressRecovery')
        .lean();
      if (
        leadDoc &&
        leadDoc.cartStatus === 'abandoned' &&
        leadDoc.isOrderPlaced !== true &&
        leadDoc.suppressRecovery !== true &&
        Number(leadDoc.recoveryStep || 0) > 0 &&
        Number(leadDoc.recoveryStep || 0) < 99
      ) {
        errors.push({
          leadId,
          message:
            'Lead is in active cart recovery. Pause recovery or wait until the 3-step sequence completes before enrolling a marketing sequence.',
          code: 'CART_RECOVERY_ACTIVE',
        });
        continue;
      }

      if (onlyEmailSteps && !String(email || '').trim()) {
        errors.push({ leadId, message: 'Contact has no email address' });
        continue;
      }

      const normalizedPhone = String(phone || '').replace(/\D/g, '');
      const normalizedEmail = String(email || '').trim();

      if (!hasEmailSteps && hasWaSteps && normalizedPhone.length < 10) {
        errors.push({ leadId, message: 'Contact has no valid phone number' });
        continue;
      }

      if (hasEmailSteps && hasWaSteps && !normalizedEmail && normalizedPhone.length < 10) {
        errors.push({ leadId, message: 'Contact needs email or phone for this hybrid sequence' });
        continue;
      }

      const lid = String(leadId);
      let activeCount = countMap.get(lid) || 0;

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

      if (lid) {
        countMap.set(lid, activeCount + 1);
      }

      if (leadId) {
        await AdLead.findByIdAndUpdate(leadId, {
          $set: { "metaData.hasActiveSequence": true }
        });
      }
      enrolledSequences.push(sequence);
    }

    if (enrolledSequences.length > 0) {
      await incrementUsage(client._id, 'sequences', enrolledSequences.length);
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

    const sequences = await FollowUpSequence.find(query)
      .populate('leadId', 'name phoneNumber')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, sequences });
  } catch (error) {
    console.error('Sequence fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// STATIC PATHS BEFORE /:sequenceId — do not reorder below this block
router.get('/:clientId/templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    res.json({ success: true, templates: filterSequenceTemplates(SEQUENCE_TEMPLATES) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/:sequenceId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { sequenceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(sequenceId)) {
      return res.status(400).json({ success: false, message: 'Invalid sequence id' });
    }
    const sequence = await FollowUpSequence.findOne({
      _id: sequenceId,
      clientId,
    })
      .populate('leadId', 'name phoneNumber email leadScore intentState')
      .lean();
    if (!sequence) {
      return res.status(404).json({ success: false, message: 'Sequence not found' });
    }

    const steps = (sequence.steps || []).map((s, idx) => {
      const status = String(s.status || 'pending').toLowerCase();
      return {
        index: idx + 1,
        type: s.type || 'whatsapp',
        templateName: s.templateName,
        subject: s.subject,
        content: s.content,
        delayValue: s.delayValue,
        delayUnit: s.delayUnit,
        sendAt: s.sendAt,
        sentAt: s.sentAt,
        status,
        errorLog: s.errorLog,
        failureReason: s.failureReason,
        attempts: s.attempts,
        isCurrent: sequence.currentStepIndex === idx,
      };
    });

    const completed = steps.filter((s) => ['sent', 'delivered', 'completed'].includes(s.status)).length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const cancelled = steps.filter((s) => s.status === 'cancelled').length;
    const total = steps.length || 1;

    res.json({
      success: true,
      sequence,
      stats: {
        enrolled: 1,
        completed: sequence.status === 'completed' ? 1 : 0,
        cancelled: sequence.status === 'cancelled' ? 1 : 0,
        failed,
        completionRate: Math.round((completed / total) * 100),
        stepCounts: { completed, failed, cancelled, total },
      },
      steps,
    });
  } catch (error) {
    console.error('Sequence detail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST enroll from campaign — API reserved; no dashboard UI in V1 (MK-P1-04)
router.post('/:clientId/enroll-from-campaign', protect, async (req, res) => {
  return res.status(501).json({
    success: false,
    code: 'NOT_SHIPPED_V1',
    message:
      'Post-campaign sequence enrollment is not available in the dashboard V1. Use Marketing hub → Sequences to enroll contacts.',
  });
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

    if (isLegacyNicheAutomationBlocked() && isDeprecatedSequenceTemplateId(templateId)) {
      return res.status(400).json({
        success: false,
        message:
          'This template is deprecated for e-commerce by default. Set BLOCK_LEGACY_NICHE_AUTOMATION=false to enroll.',
      });
    }

    const template = SEQUENCE_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Sequence template not found' });
    }

    const templateHasEmail = (template.steps || []).some(
      (s) => String(s.type || '').toLowerCase() === 'email'
    );
    const templateHasWa = (template.steps || []).some(
      (s) => String(s.type || '').toLowerCase() !== 'email'
    );
    const templateOnlyEmail = templateHasEmail && !templateHasWa;

    const client = await Client.findOne({ clientId })
      .select('_id syncedMetaTemplates gmailAddress gmailRefreshToken gmailAccessToken emailMethod googleConnected')
      .lean();
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    if (templateHasEmail) {
      const { isWorkspaceEmailReady } = require('../utils/core/emailService');
      if (!isWorkspaceEmailReady(client)) {
        return res.status(400).json({
          success: false,
          message: 'Connect Gmail in Settings before enrolling email sequence playbooks.',
        });
      }
    }

    const leadQuery = { clientId, importBatchId: resolvedBatchId };
    if (templateOnlyEmail) {
      leadQuery.email = { $exists: true, $ne: '', $regex: /@/i };
    } else if (templateHasWa && !templateHasEmail) {
      leadQuery.phoneNumber = { $exists: true, $ne: '' };
    } else {
      leadQuery.$or = [
        { phoneNumber: { $exists: true, $ne: '' } },
        { email: { $exists: true, $ne: '', $regex: /@/i } },
      ];
    }

    const leads = await AdLead.find(leadQuery).select('_id name phoneNumber email').lean();

    if (!leads.length) {
      return res.status(400).json({
        success: false,
        message: templateOnlyEmail
          ? 'No leads with email addresses found in this imported list'
          : 'No eligible leads found in this imported list',
      });
    }

    const templateFailures = await validateSequenceSteps(template?.steps || [], client.syncedMetaTemplates || [], clientId);
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
    const limitCheck = await checkLimit(client._id, 'sequences');
    if (!limitCheck.allowed) {
      return res.status(403).json({ success: false, message: limitCheck.reason });
    }

    const enrolledSequences = [];
    const errors = [];

    let countMap = await activeSequenceCountMap(
      clientId,
      leads.map((l) => l._id)
    );

    for (const lead of leads) {
      const lid = String(lead._id);
      const normalizedPhone = String(lead.phoneNumber || '').replace(/\D/g, '');
      const normalizedEmail = String(lead.email || '').trim();

      if (templateOnlyEmail && !normalizedEmail) {
        errors.push({ leadId: lead._id, message: 'Contact has no email address' });
        continue;
      }
      if (templateHasWa && !templateHasEmail && normalizedPhone.length < 10) {
        errors.push({ leadId: lead._id, message: 'Contact has no valid phone number' });
        continue;
      }
      if (templateHasEmail && templateHasWa && !normalizedEmail && normalizedPhone.length < 10) {
        errors.push({ leadId: lead._id, message: 'Contact needs email or phone for this hybrid sequence' });
        continue;
      }

      let activeCount = countMap.get(lid) || 0;

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
      countMap.set(lid, activeCount + 1);
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

    const seq = await FollowUpSequence.findOne({ _id: sequenceId, clientId });
    if (!seq) {
      return res.status(404).json({ success: false, message: 'Sequence not found' });
    }

    seq.status = 'cancelled';
    (seq.steps || []).forEach((step) => {
      if (['pending', 'queued', 'retrying'].includes(step.status)) {
        step.status = 'cancelled';
      }
    });
    await seq.save();
    if (seq.leadId) await syncLeadHasActiveSequence(clientId, seq.leadId);

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

    const seq = await FollowUpSequence.findOne({ _id: sequenceId, clientId });
    if (!seq) {
      return res.status(404).json({ success: false, message: 'Sequence not found' });
    }
    const leadId = seq.leadId;
    await FollowUpSequence.findOneAndDelete({ _id: sequenceId, clientId });
    if (leadId) await syncLeadHasActiveSequence(clientId, leadId);
    res.json({ success: true, message: "Sequence deleted" });
  } catch (error) {
    console.error('Sequence delete error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
