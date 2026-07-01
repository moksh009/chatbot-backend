'use strict';

const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { compileGraphToSteps } = require('../services/journeyBuilder/compileGraphToSteps');
const { seedPlaybooksForClient } = require('../services/journeyBuilder/seedPlaybooks');
const { JOURNEY_NODE_TYPES, normalizeEntryType } = require('../services/journeyBuilder/journeyNodeContract');
const { validateTemplateEligibility } = require('../utils/meta/templateEligibility');
const { checkLimit, incrementUsage } = require('../utils/core/planLimits');
const { enqueueDueStepsForSequence } = require('../utils/messaging/sequenceStepEnqueue');

const MAX_ACTIVE_SEQUENCES = 2;

async function activeSequenceCountMap(clientId, leadIds) {
  const unique = [...new Set((leadIds || []).filter(Boolean).map((id) => String(id)))];
  const oids = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!oids.length) return new Map();

  const rows = await FollowUpSequence.aggregate([
    { $match: { clientId, status: 'active', leadId: { $in: oids } } },
    { $group: { _id: '$leadId', n: { $sum: 1 } } },
  ]);
  const m = new Map();
  rows.forEach((r) => m.set(String(r._id), r.n));
  return m;
}

function journeyQuery(clientId, flowId = null) {
  const q = { clientId, flowType: 'journey' };
  if (flowId) {
    q.$or = [{ flowId }, ...(mongoose.Types.ObjectId.isValid(flowId) ? [{ _id: flowId }] : [])];
  }
  return q;
}

async function validateCompiledSteps(steps, syncedMetaTemplates = [], clientId = null) {
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

  for (let idx = 0; idx < (steps || []).length; idx += 1) {
    const step = steps[idx];
    const type = String(step?.type || 'whatsapp').toLowerCase();
    if (type === 'flow_handoff') {
      if (!String(step?.targetFlowId || '').trim()) {
        failures.push({ step: idx + 1, type: 'flow_handoff', reasons: ['Select a published flow for chatbot handoff'] });
      }
      continue;
    }
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
      failures.push({
        step: idx + 1,
        templateName,
        reasons: eligibility.reasons,
        status: template?.status || 'MISSING',
      });
    }

    if (template && eligibility.ok) {
      const bodyComp = (template.components || []).find(
        (c) => String(c.type || '').toUpperCase() === 'BODY'
      );
      const bodyText = bodyComp?.text || '';
      const placeholders = bodyText.match(/\{\{(\d+)\}\}/g) || [];
      const requiredIndices = [...new Set(placeholders.map((m) => m.replace(/[{}]/g, '')))];
      const bodyMappings = step.variableMappings?.body || step.variableMapping || {};
      const unmapped = requiredIndices.filter(
        (idx_) => !bodyMappings[idx_] || String(bodyMappings[idx_]).trim() === ''
      );
      if (unmapped.length > 0) {
        const stepReasons = failures.find((f) => f.step === idx + 1);
        const reason = `Template placeholder(s) {{${unmapped.join('}}, {{')}}} have no variable binding`;
        if (stepReasons) {
          stepReasons.reasons.push(reason);
        } else {
          failures.push({
            step: idx + 1,
            templateName,
            reasons: [reason],
            severity: 'warn',
          });
        }
      }
    }
  }
  return failures;
}

function scanChannels(...nodeLists) {
  const channels = new Set();
  for (const list of nodeLists) {
    for (const n of list || []) {
      const t = String(n?.type || n?.data?.nodeType || '');
      if (t === JOURNEY_NODE_TYPES.SEND_WHATSAPP) channels.add('whatsapp');
      if (t === JOURNEY_NODE_TYPES.SEND_EMAIL) channels.add('email');
    }
  }
  return [...channels];
}

function triggerSummary(flow) {
  const jt = flow?.journeyTrigger;
  if (typeof jt === 'string' && jt) return jt.replace(/_/g, ' ');
  if (jt && typeof jt === 'object' && jt.type) {
    if (jt.type === 'manual') return 'Manual enroll';
    return String(jt.type).replace(/_/g, ' ');
  }
  return 'Manual enroll';
}

function serializeBlueprint(doc, stats = {}) {
  const draftNodes = doc.nodes || [];
  const publishedNodes = doc.publishedNodes || [];
  return {
    id: doc.flowId,
    _id: doc._id,
    flowId: doc.flowId,
    name: doc.name,
    description: doc.description || '',
    status: doc.status,
    isActive: doc.isActive !== false,
    playbookKey: doc.playbookKey || '',
    publishedAt: doc.publishedAt || null,
    lastPublishedAt: doc.lastPublishedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    journeyTrigger: doc.journeyTrigger,
    journeyPolicies: doc.journeyPolicies,
    nodes: doc.nodes || [],
    edges: doc.edges || [],
    publishedNodes: doc.publishedNodes || [],
    publishedEdges: doc.publishedEdges || [],
    channels: scanChannels(draftNodes, publishedNodes),
    triggerSummary: triggerSummary(doc),
    stats: {
      uniqueRecipients: stats.uniqueRecipients || 0,
      revenueInr: stats.revenueInr || 0,
      openRate: stats.openRate ?? null,
      clickRate: stats.clickRate ?? null,
      orderRate: stats.orderRate ?? null,
      sent: stats.sent ?? 0,
      lowVolume: stats.lowVolume ?? false,
      openRateUnavailable: stats.openRateUnavailable ?? false,
    },
  };
}

async function recipientStatsByFlow(clientId) {
  const rows = await FollowUpSequence.aggregate([
    { $match: { clientId, sourceFlowId: { $ne: '' } } },
    {
      $group: {
        _id: '$sourceFlowId',
        uniqueRecipients: { $addToSet: '$leadId' },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) {
    map.set(r._id, { uniqueRecipients: (r.uniqueRecipients || []).length });
  }
  return map;
}

function defaultTriggerNode() {
  return {
    id: 'trigger_1',
    type: JOURNEY_NODE_TYPES.JOURNEY_TRIGGER,
    position: { x: 80, y: 40 },
    data: { nodeType: JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, entryType: 'manual', cancelOnReply: true },
  };
}

function defaultEndNode() {
  return {
    id: 'end_1',
    type: JOURNEY_NODE_TYPES.END,
    position: { x: 80, y: 200 },
    data: { nodeType: JOURNEY_NODE_TYPES.END, label: 'End' },
  };
}

// GET /api/journeys/:clientId
router.get('/:clientId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const count = await WhatsAppFlow.countDocuments({ clientId, flowType: 'journey' });
    if (count === 0) {
      await seedPlaybooksForClient(clientId);
    }

    const flows = await WhatsAppFlow.find({ clientId, flowType: 'journey' })
      .sort({ updatedAt: -1 })
      .lean();
    const period = req.query.period || '7d';
    const { getBlueprintStatsMap } = require('../services/journeyBuilder/journeyStatsService');
    const statMap = await getBlueprintStatsMap(
      clientId,
      flows.map((f) => f.flowId),
      period
    );

    res.json({
      success: true,
      journeys: flows.map((f) => {
        const s = statMap.get(f.flowId) || {};
        return serializeBlueprint(f, {
          uniqueRecipients: s.uniqueRecipients,
          revenueInr: s.revenueInr,
          openRate: s.openRate,
          clickRate: s.clickRate,
          orderRate: s.orderRate,
          sent: s.sent,
          lowVolume: s.lowVolume,
          openRateUnavailable: s.openRateUnavailable,
        });
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/hub-stats
router.get('/:clientId/hub-stats', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const period = req.query.period || '7d';
    const { getHubStats } = require('../services/journeyBuilder/journeyStatsService');
    const stats = await getHubStats(clientId, period);

    res.json({
      success: true,
      stats,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/journeys/:clientId/seed-defaults
router.post('/:clientId/seed-defaults', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const created = await seedPlaybooksForClient(clientId);
    res.json({ success: true, created });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/:flowId/stats/steps
router.get('/:clientId/:flowId/stats/steps', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId))
      .select('flowId')
      .lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    const period = req.query.period || '7d';
    const { getStepFunnel } = require('../services/journeyBuilder/journeyStatsService');
    const funnel = await getStepFunnel(clientId, flow.flowId, period);
    res.json({ success: true, ...funnel });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/:flowId/stats
router.get('/:clientId/:flowId/stats', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId))
      .select('flowId journeyTrigger playbookKey name')
      .lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    const period = req.query.period || '7d';
    const { getBlueprintStats } = require('../services/journeyBuilder/journeyStatsService');
    const { isNonRevenue } = require('../utils/commerce/journeyAttributionHelper');
    const stats = await getBlueprintStats(clientId, flow.flowId, period);
    const nonRevenue = isNonRevenue(flow.playbookKey || flow.journeyTrigger || '', flow.flowId);
    res.json({
      success: true,
      stats: {
        ...stats,
        revenueEligible: !nonRevenue,
        revenueNote: nonRevenue
          ? 'Confirmation journey — revenue is organic and not attributed to this journey'
          : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/:flowId/analytics/detail — per-journey stats + recipient drill-down
router.get('/:clientId/:flowId/analytics/detail', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId))
      .select('flowId name journeyTrigger playbookKey')
      .lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    const {
      getJourneyAnalyticsDetail,
    } = require('../services/journeyBuilder/journeyEnrollmentDetailService');
    const detail = await getJourneyAnalyticsDetail(clientId, flow.flowId, {
      period: req.query.period || '7d',
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      journeyName: flow.name || '',
    });
    const { isNonRevenue } = require('../utils/commerce/journeyAttributionHelper');
    const nonRevenue = isNonRevenue(flow.playbookKey || flow.journeyTrigger || '', flow.flowId);
    res.json({
      success: true,
      journey: { flowId: flow.flowId, name: flow.name },
      revenueEligible: !nonRevenue,
      revenueNote: nonRevenue
        ? 'Confirmation journey — revenue is organic and not attributed to this journey'
        : null,
      ...detail,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/:flowId/enrollments/export — CSV with engagement columns
router.get('/:clientId/:flowId/enrollments/export', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId))
      .select('flowId')
      .lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    const {
      exportJourneyEnrollmentsCsv,
    } = require('../services/journeyBuilder/journeyEnrollmentDetailService');
    const out = await exportJourneyEnrollmentsCsv(clientId, flow.flowId, {
      period: req.query.period || 'all',
      search: req.query.search,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/journeys/:clientId/:flowId
router.get('/:clientId/:flowId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId)).lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    const period = req.query.period || '7d';
    const { getBlueprintStats } = require('../services/journeyBuilder/journeyStatsService');
    const stats = await getBlueprintStats(clientId, flow.flowId, period);
    res.json({
      success: true,
      journey: serializeBlueprint(flow, stats),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/journeys/:clientId — create blank or from playbookKey
router.post('/:clientId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const body = req.body || {};
    const playbookKey = String(body.playbookKey || '').trim();

    const { PLAYBOOK_CATALOG } = require('../services/journeyBuilder/seedPlaybooks');
    const validPlaybookKeys = PLAYBOOK_CATALOG.map((p) => p.playbookKey).filter(Boolean);
    if (playbookKey && validPlaybookKeys.includes(playbookKey)) {
      await seedPlaybooksForClient(clientId, {
        keys: [playbookKey],
        maxTier: 2,
      });
      const existing = await WhatsAppFlow.findOne({
        clientId,
        flowType: 'journey',
        playbookKey,
      }).lean();
      if (existing) {
        return res.json({ success: true, journey: serializeBlueprint(existing) });
      }
    }

    const name = String(body.name || 'Untitled journey').trim() || 'Untitled journey';
    const flowId = `journey_${Date.now()}`;
    const nodes = Array.isArray(body.nodes) && body.nodes.length
      ? body.nodes
      : [defaultTriggerNode(), defaultEndNode()];
    const edges = Array.isArray(body.edges) ? body.edges : [];

    const doc = await WhatsAppFlow.create({
      clientId,
      flowId,
      name,
      description: body.description || '',
      flowType: 'journey',
      playbookKey: playbookKey || '',
      status: 'DRAFT',
      version: 1,
      nodes,
      edges,
      publishedNodes: [],
      publishedEdges: [],
      journeyTrigger: { type: 'manual', filters: {} },
      journeyPolicies: { cancelOnReply: true },
      isActive: true,
    });

    res.json({ success: true, journey: serializeBlueprint(doc.toObject()) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/journeys/:clientId/:flowId — save draft graph
router.patch('/:clientId/:flowId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId));
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }

    const body = req.body || {};
    if (body.name != null) flow.name = String(body.name).trim() || flow.name;
    if (body.description != null) flow.description = body.description;
    if (Array.isArray(body.nodes)) flow.nodes = body.nodes;
    if (Array.isArray(body.edges)) flow.edges = body.edges;
    if (body.journeyTrigger != null) flow.journeyTrigger = body.journeyTrigger;
    if (body.journeyPolicies != null) {
      flow.journeyPolicies = { ...(flow.journeyPolicies || {}), ...body.journeyPolicies };
    }
    if (typeof body.isActive === 'boolean') flow.isActive = body.isActive;

    await flow.save();
    res.json({ success: true, journey: serializeBlueprint(flow.toObject()) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/journeys/:clientId/:flowId
router.delete('/:clientId/:flowId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId));
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }

    const sourceFlowId = String(flow.flowId || flow._id);
    const activeSeqs = await FollowUpSequence.find({
      clientId,
      sourceFlowId,
      status: 'active',
    })
      .select('_id leadId')
      .lean();

    if (activeSeqs.length) {
      const now = new Date();
      await FollowUpSequence.updateMany(
        { clientId, sourceFlowId, status: 'active' },
        {
          $set: {
            status: 'cancelled',
            cancelledReason: 'journey_deleted',
            cancelledAt: now,
          },
        }
      );

      const leadIds = [...new Set(activeSeqs.map((s) => String(s.leadId)).filter(Boolean))];
      await Promise.all(
        leadIds.map(async (leadId) => {
          const count = await FollowUpSequence.countDocuments({
            clientId,
            leadId,
            status: 'active',
          });
          await AdLead.findByIdAndUpdate(leadId, {
            $set: { 'metaData.hasActiveSequence': count > 0 },
          });
        })
      );
    }

    await WhatsAppFlow.deleteOne({ _id: flow._id });

    res.json({
      success: true,
      cancelledEnrollments: activeSeqs.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/journeys/:clientId/:flowId/publish
router.post('/:clientId/:flowId/publish', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, req.params.flowId));
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }

    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    const { steps, warnings, cancelOnReply } = compileGraphToSteps({ nodes, edges });

    if (!steps.length) {
      return res.status(400).json({
        success: false,
        message: 'Cannot publish: add at least one WhatsApp, email, or chatbot handoff step.',
        warnings,
      });
    }

    const triggerNode = nodes.find(
      (n) => String(n?.type || n?.data?.nodeType) === JOURNEY_NODE_TYPES.JOURNEY_TRIGGER
    );
    const entryType = normalizeEntryType(
      triggerNode?.data?.journeyTrigger?.type || triggerNode?.data?.entryType
    );

    if (entryType === 'cart_abandoned') {
      try {
        const { buildAbandonedCartReadiness } = require('../utils/commerce/abandonedCartReadiness');
        const readiness = await buildAbandonedCartReadiness(clientId);
        const pixelOk = readiness?.pixel?.installed || readiness?.pixelInstalled;
        if (!pixelOk) {
          warnings.push('Cart journey: checkout capture (pixel) not set up — journey will not auto-enroll until the pixel is installed.');
        }
      } catch {
        // readiness check is advisory; don't block publish
      }
    }

    const client = await Client.findOne({ clientId })
      .select('_id clientId syncedMetaTemplates gmailAddress gmailRefreshToken gmailAccessToken emailMethod googleConnected logisticsMode')
      .lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const stepFailures = await validateCompiledSteps(steps, client.syncedMetaTemplates || [], clientId);
    if (stepFailures.length) {
      const unapproved = stepFailures.filter((f) =>
        (f.reasons || []).some((r) => /approv/i.test(r))
      );
      const message = unapproved.length
        ? 'Publish blocked: one or more WhatsApp templates are not approved on Meta yet.'
        : 'Publish blocked: fix template or email fields before going live.';
      return res.status(400).json({
        success: false,
        message,
        details: stepFailures,
        warnings,
      });
    }

    const now = new Date();
    if (!flow.publishedAt) flow.publishedAt = now;
    flow.lastPublishedAt = now;
    flow.publishedNodes = nodes;
    flow.publishedEdges = edges;
    flow.status = 'PUBLISHED';

    const nodeJt = triggerNode?.data?.journeyTrigger;
    flow.journeyTrigger = {
      type: entryType,
      filters: nodeJt?.filters || {},
      exitConditions: nodeJt?.exitConditions || ['journey_end', 'reply'],
    };

    if (flow.journeyPolicies) {
      flow.journeyPolicies.cancelOnReply = cancelOnReply;
    } else {
      flow.journeyPolicies = { cancelOnReply };
    }

    await flow.save();

    res.json({
      success: true,
      journey: serializeBlueprint(flow.toObject()),
      compiledStepCount: steps.length,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/journeys/:clientId/:flowId/enroll/preflight
// Dry-run: per-lead channel eligibility + layman warnings (no sequences created).
router.post('/:clientId/:flowId/enroll/preflight', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const flowId = req.params.flowId;
    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, flowId))
      .select('status isActive publishedNodes publishedEdges nodes edges')
      .lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }

    const { leads } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'No leads provided' });
    }

    const nodes = flow.publishedNodes?.length ? flow.publishedNodes : flow.nodes || [];
    const edges = flow.publishedEdges?.length ? flow.publishedEdges : flow.edges || [];
    const { steps } = compileGraphToSteps({ nodes, edges });

    const leadIds = leads.map((l) => l.leadId).filter(Boolean);
    const leadDocs = leadIds.length
      ? await AdLead.find({ _id: { $in: leadIds }, clientId })
          .select('name fullName phoneNumber email channelConsent optStatus emailBounced')
          .lean()
      : [];

    const { buildEnrollPreflightReport } = require('../services/journeyBuilder/journeyEnrollPreflightService');
    const report = await buildEnrollPreflightReport({
      clientId,
      leads,
      leadDocs,
      steps,
    });

    return res.json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/journeys/:clientId/:flowId/enroll
router.post('/:clientId/:flowId/enroll', protect, async (req, res) => {
  const enrollStarted = Date.now();
  const { journeyLog, journeyLogWarn, journeyLogError } = require('../utils/journeyBuilder/journeyPipelineLog');
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const flowId = req.params.flowId;
    journeyLog('enroll', 'manual enroll request', { clientId, flowId, leadCount: req.body?.leads?.length || 0 });

    const flow = await WhatsAppFlow.findOne(journeyQuery(clientId, flowId)).lean();
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Journey not found' });
    }
    if (flow.status !== 'PUBLISHED') {
      return res.status(400).json({ success: false, message: 'Publish this journey before enrolling leads.' });
    }
    if (flow.isActive === false) {
      return res.status(400).json({ success: false, message: 'This journey is paused. Turn it on to enroll new leads.' });
    }

    const { leads, name } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, message: 'No leads provided' });
    }

    const nodes = flow.publishedNodes?.length ? flow.publishedNodes : flow.nodes || [];
    const edges = flow.publishedEdges?.length ? flow.publishedEdges : flow.edges || [];
    const { steps, cancelOnReply, warnings: compileWarnings } = compileGraphToSteps({ nodes, edges });

    if (compileWarnings?.length) {
      journeyLogWarn('compile', 'journey compile warnings', { clientId, flowId, warnings: compileWarnings });
    }
    if (!steps.length) {
      journeyLogWarn('compile', 'no actionable steps in journey graph', { clientId, flowId });
      return res.status(400).json({
        success: false,
        message: 'Journey has no send steps. Add WhatsApp or email nodes before enrolling.',
        warnings: compileWarnings,
      });
    }

    const client = await Client.findOne({ clientId })
      .select('_id syncedMetaTemplates gmailAddress gmailRefreshToken gmailAccessToken emailMethod googleConnected')
      .lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const clientForWaCheck = await Client.findOne({ clientId })
      .select(require('../utils/meta/clientWhatsAppCreds').WHATSAPP_CREDENTIAL_SELECT)
      .lean();

    const hasEmailSteps = steps.some((s) => String(s.type).toLowerCase() === 'email');
    const hasWaSteps = steps.some((s) => String(s.type || 'whatsapp').toLowerCase() !== 'email');

    if (hasEmailSteps) {
      const { isWorkspaceEmailReady } = require('../utils/core/emailService');
      if (!isWorkspaceEmailReady(client)) {
        journeyLogWarn('enroll', 'blocked — Gmail not connected', { clientId, flowId });
        return res.status(400).json({
          success: false,
          message: 'Connect Gmail in Settings before enrolling journeys with email steps.',
        });
      }
    }

    if (hasWaSteps) {
      const { isWhatsAppOutboundReady } = require('../utils/meta/clientWhatsAppCreds');
      if (!isWhatsAppOutboundReady(clientForWaCheck)) {
        journeyLogWarn('enroll', 'blocked — WhatsApp not ready', { clientId, flowId });
        return res.status(400).json({
          success: false,
          message: 'Connect WhatsApp in Settings before enrolling journeys with WhatsApp steps.',
        });
      }
    }

    const stepFailures = await validateCompiledSteps(steps, client.syncedMetaTemplates || [], clientId);
    if (stepFailures.length) {
      return res.status(400).json({
        success: false,
        message: 'Journey steps are invalid. Republish after fixing templates.',
        details: stepFailures,
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
    const { findOrderDocForSequence } = require('../services/journeyBuilder/journeySequenceWhatsApp');

    const leadDocs = leadOidList.length
      ? await AdLead.find({ clientId, _id: { $in: leadOidList } })
          .select('name fullName phoneNumber email channelConsent optStatus emailBounced')
          .lean()
      : [];
    const leadDocMap = new Map(leadDocs.map((l) => [String(l._id), l]));

    const { buildEnrollPreflightReport } = require('../services/journeyBuilder/journeyEnrollPreflightService');
    const preflightReport = await buildEnrollPreflightReport({
      clientId,
      leads,
      leadDocs,
      steps,
    });
    const enrollWarnings = preflightReport.leads
      .filter((r) => r.warnings?.length)
      .map((r) => ({
        leadId: r.leadId,
        name: r.name,
        warnings: r.warnings,
        enrollStatus: r.enrollStatus,
        blockedReason: r.blockedReason,
      }));

    const blockedLeadIds = new Set(
      preflightReport.leads
        .filter((r) => r.enrollStatus === 'blocked')
        .map((r) => String(r.leadId))
    );

    if (preflightReport.blockedCount === leads.length) {
      return res.status(400).json({
        success: false,
        message: 'None of the selected contacts can be enrolled — check phone, email, and opt-in status.',
        preflight: preflightReport,
      });
    }

    const onlyEmailSteps = hasEmailSteps && steps.every((s) => String(s.type).toLowerCase() === 'email');

    let totalQueued = 0;
    for (const leadInput of leads) {
      let { leadId, phone, email } = leadInput;
      if (!leadId && phone) {
        const ensured = await ensureLeadForSequence({
          clientId,
          phone,
          email,
          source: 'journey_enroll',
        });
        leadId = ensured._id;
        phone = ensured.phoneNumber;
        email = ensured.email;
      }

      if (!leadId) {
        errors.push({ phone, message: 'Could not resolve lead for enrollment' });
        continue;
      }

      const lid = String(leadId);
      if (blockedLeadIds.has(lid)) {
        const blockedRow = preflightReport.leads.find((r) => String(r.leadId) === lid);
        errors.push({
          leadId,
          message: blockedRow?.blockedReason === 'wa_opted_out'
            ? 'Opted out of WhatsApp'
            : blockedRow?.blockedReason === 'no_phone'
              ? 'No valid phone number'
              : 'Cannot enroll this contact',
          code: blockedRow?.blockedReason || 'blocked',
        });
        continue;
      }

      let activeCount = countMap.get(lid) || 0;
      if (activeCount >= MAX_ACTIVE_SEQUENCES) {
        errors.push({ leadId, message: 'Active sequence limit reached' });
        continue;
      }

      const policyCheck = await require('../services/journeyBuilder/journeyPolicyService').checkJourneyEnrollmentAllowed({
        clientId,
        flow,
        leadId,
        orderPayload: leadInput.orderPayload || null,
        enrollmentSource: 'manual',
        sourceOrderId: leadInput.sourceOrderId || null,
      });
      if (!policyCheck.allowed) {
        const policyMessages = {
          repeat_window: 'Already enrolled in this journey',
          max_enrollments: 'Maximum enrollments reached for this journey',
          cooldown: 'Re-entry cooldown active — try again later',
          min_order_value: 'Order value below journey minimum',
        };
        errors.push({
          leadId,
          message: policyMessages[policyCheck.reason] || 'Enrollment blocked by journey policy',
          code: policyCheck.reason,
        });
        continue;
      }

      const normalizedPhone = String(phone || '').replace(/\D/g, '');
      const normalizedEmail = String(email || '').trim();
      if (!hasEmailSteps && hasWaSteps && normalizedPhone.length < 10) {
        errors.push({ leadId, message: 'Contact has no valid phone number' });
        continue;
      }

      const mappedSteps = steps.map((s) => ({
        ...s,
        status: 'pending',
      }));

      const leadDoc = leadDocMap.get(lid);
      const displayName = leadDoc?.name || leadDoc?.fullName || leadInput.name || 'Customer';
      const latestOrder = await findOrderDocForSequence(clientId, null, normalizedPhone);
      const sourceOrderId =
        leadInput.sourceOrderId
        || latestOrder?.orderNumber
        || latestOrder?.shopifyOrderId
        || latestOrder?.orderId
        || undefined;

      const sequence = new FollowUpSequence({
        clientId,
        leadId,
        phone,
        email,
        name: displayName,
        type: 'custom',
        cancelOnReply: cancelOnReply !== false,
        sourceFlowId: flow.flowId,
        sourceOrderId,
        playbookKey: flow.playbookKey || '',
        enrollment: { mode: 'blueprint', blueprint: { flowId: flow.flowId, name: flow.name } },
        steps: mappedSteps,
      });

      await sequence.save();
      await AdLead.findByIdAndUpdate(leadId, {
        $set: { 'metaData.hasActiveSequence': true },
      }).catch(() => {});
      const queued = await enqueueDueStepsForSequence(sequence).catch((enqueueErr) => {
        journeyLogError('enqueue', 'failed after enroll save', {
          clientId,
          flowId,
          sequenceId: String(sequence._id),
          leadId: String(leadId),
          error: enqueueErr.message,
        });
        return 0;
      });
      totalQueued += queued;
      journeyLog('enroll', 'lead enrolled', {
        clientId,
        flowId,
        sequenceId: String(sequence._id),
        leadId: String(leadId),
        stepCount: mappedSteps.length,
        queuedSteps: queued,
        firstSendAt: mappedSteps[0]?.sendAt || null,
      });
      countMap.set(lid, activeCount + 1);
      enrolledSequences.push(sequence);
    }

    if (enrolledSequences.length) {
      await incrementUsage(client._id, 'sequences', enrolledSequences.length);
    }

    journeyLog('enroll', 'manual enroll complete', {
      clientId,
      flowId,
      enrolled: enrolledSequences.length,
      queuedSteps: totalQueued,
      errors: errors.length,
      durationMs: Date.now() - enrollStarted,
    });

    const enrolledCount = enrolledSequences.length;
    res.json({
      success: enrolledCount > 0,
      enrolled: enrolledCount,
      queuedSteps: totalQueued,
      errors,
      warnings: enrollWarnings,
      message:
        enrolledCount === 0 && errors.length
          ? errors[0]?.message || 'No contacts were enrolled'
          : undefined,
      sequences: enrolledSequences.map((s) => ({ _id: s._id, leadId: s.leadId })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Migration status: reads commerceAutomations[] and maps to journeys
// ---------------------------------------------------------------------------
const SYSTEM_RULE_TO_PLAYBOOK = {
  sys_fulfillment_unfulfilled: { playbookKey: 'order-placed-confirm', triggerType: 'order_placed', tier: 1 },
  sys_commerce_cod_confirm:    { playbookKey: 'cod-confirm-basic', triggerType: 'order_placed', tier: 1 },
  sys_cart_followup_1:         { playbookKey: 'cart-recovery-3step', triggerType: 'cart_abandoned', tier: 1 },
  sys_cart_followup_2:         { playbookKey: 'cart-recovery-3step', triggerType: 'cart_abandoned', tier: 1 },
  sys_cart_followup_3:         { playbookKey: 'cart-recovery-3step', triggerType: 'cart_abandoned', tier: 1 },
  sys_shipment_in_transit:     { playbookKey: 'order-shipped-tracking', triggerType: 'order_shipped', tier: 3 },
  sys_shipment_out_for_delivery: { playbookKey: 'order-shipped-tracking', triggerType: 'order_shipped', tier: 3 },
  sys_shipment_delivered:      { playbookKey: 'order-shipped-tracking', triggerType: 'order_delivered', tier: 2 },
  sys_shipment_attempted_delivery: { playbookKey: 'order-shipped-tracking', triggerType: 'order_shipped', tier: 3 },
  sys_shipment_failure:        { playbookKey: 'order-shipped-tracking', triggerType: 'order_shipped', tier: 3 },
};

// GET /:clientId/migration-status — checks which SAC rules need journey migration
router.get('/:clientId/migration-status', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const client = await Client.findOne({ clientId })
      .select('commerceAutomations logisticsMode')
      .lean();

    const rules = Array.isArray(client?.commerceAutomations) ? client.commerceAutomations : [];
    const logisticsMode = client?.logisticsMode || 'shopify_only';

    // Published journey blueprints by playbookKey
    const publishedJourneys = await WhatsAppFlow.find({
      clientId,
      flowType: 'journey',
      status: 'PUBLISHED',
    }).select('playbookKey isActive journeyTrigger').lean();
    const publishedKeys = new Set(publishedJourneys.filter((j) => j.isActive !== false).map((j) => j.playbookKey).filter(Boolean));

    // Deduplicate cart followup into one entry
    const seen = new Set();
    const rulesNeedingMigration = [];
    let hasTier3Active = false;

    for (const rule of rules) {
      const id = rule.id || rule.ruleId || rule._id?.toString() || '';
      const mapping = SYSTEM_RULE_TO_PLAYBOOK[id];
      if (!mapping) continue;

      if (mapping.tier >= 3 && rule.isActive) hasTier3Active = true;

      // Only report Tier 1–2 active rules that don't have a published journey
      if (mapping.tier >= 3) continue;
      if (!rule.isActive) continue;
      if (seen.has(mapping.playbookKey)) continue;
      seen.add(mapping.playbookKey);

      rulesNeedingMigration.push({
        ruleId: id,
        ruleName: rule.name || id,
        playbookKey: mapping.playbookKey,
        triggerType: mapping.triggerType,
        tier: mapping.tier,
        alreadyPublished: publishedKeys.has(mapping.playbookKey),
      });
    }

    const pendingCount = rulesNeedingMigration.filter((r) => !r.alreadyPublished).length;

    res.json({
      success: true,
      rules: rulesNeedingMigration,
      pendingCount,
      logisticsMode,
      hasTier3Active,
      disableTier3Recommended: hasTier3Active && logisticsMode === 'shopify_only',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /:clientId/migrate-rule — import one SAC rule as a draft journey blueprint
router.post('/:clientId/migrate-rule', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { playbookKey } = req.body || {};
    if (!playbookKey) return res.status(400).json({ success: false, message: 'playbookKey required' });

    // Idempotent — if a draft already exists for this playbookKey, return it
    const existing = await WhatsAppFlow.findOne({
      clientId,
      flowType: 'journey',
      playbookKey,
      status: { $in: ['DRAFT', 'PUBLISHED'] },
    }).lean();
    if (existing) {
      return res.json({
        success: true,
        journey: serializeBlueprint(existing),
        alreadyExists: true,
      });
    }

    const { PLAYBOOK_CATALOG } = require('../services/journeyBuilder/seedPlaybooks');
    const catalog = PLAYBOOK_CATALOG.find((p) => p.playbookKey === playbookKey);
    if (!catalog || !catalog.buildGraph) {
      return res.status(400).json({ success: false, message: `Unknown playbook key: ${playbookKey}` });
    }
    const { nodes, edges, journeyTrigger } = catalog.buildGraph();

    const flow = new WhatsAppFlow({
      clientId,
      name: catalog.name,
      description: catalog.description || '',
      flowType: 'journey',
      status: 'DRAFT',
      isActive: false,
      playbookKey,
      nodes,
      edges,
      journeyTrigger,
    });
    await flow.save();
    res.json({ success: true, journey: serializeBlueprint(flow), alreadyExists: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
