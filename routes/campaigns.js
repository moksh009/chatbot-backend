const express = require('express');
const mongoose = require('mongoose');
const { resolveClient, tenantClientId, denyUnlessTenant } = require('../utils/core/queryHelpers');
const router = express.Router();
const TaskQueueService = require('../services/TaskQueueService');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { requireRoleCategory } = require('../middleware/requireRole');
const { requirePaidOrTrial } = require('../middleware/requirePaidOrTrial');
const { tenantRateLimit } = require('../middleware/tenantRateLimit');

const campaignByIdScope = verifyTenantScope({ lookupBy: 'campaign', param: 'id' });
const campaignMutate = [
  protect,
  tenantRateLimit(),
  requirePaidOrTrial(),
  campaignByIdScope,
  requireRoleCategory('mutate_config'),
];
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const csv = require('csv-parser');
const Client = require('../models/Client');
const { sendBirthdayWishWithImage } = require('../utils/commerce/sendBirthdayMessage');
const DailyStat = require('../models/DailyStat');
const WhatsApp = require('../utils/meta/whatsapp');
const { createMessage } = require('../utils/core/createMessage');
const { checkLimit, incrementUsage } = require('../utils/core/planLimits');
const log = require('../utils/core/logger')('Campaigns');
const { apiCache } = require('../middleware/apiCache');
const { incrementStat } = require('../utils/core/statCacheEngine');
const { resolveImportBatchObjectId } = require('../utils/core/importBatchResolver');
const {
  filterAudienceForMarketingOptIn,
  filterAudienceByOptStatus,
  mongoMarketingOptInOnly,
  mongoNotOptedOut,
  audienceOptQueryForCampaign,
  normalizeEmail,
  shouldRequireMarketingOptIn,
  canSendToContact,
  evaluateAudiencePolicySummary,
} = require('../utils/commerce/marketingConsent');
const { validateTemplateEligibility } = require('../utils/meta/templateEligibility');

try {
  fs.mkdirSync('uploads', { recursive: true });
} catch {}

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function normalizePhone(p) {
  if (!p) return '';
  let digits = String(p).replace(/[^\d]/g, '');
  if (!digits) return '';
  const cc = process.env.DEFAULT_COUNTRY_CODE || '91';
  // Handle 11-digit numbers starting with 0 (strip leading 0)
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  // Prepend country code for 10-digit local numbers
  if (digits.length === 10) return cc + digits;
  // Reject numbers that are too short after normalization
  if (digits.length < 10) return '';
  return digits;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// @route   POST /api/campaigns
// @desc    Create a new campaign (upload CSV)
// @access  Private
router.post('/', protect, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    // Check subscription plan (using new validation limits)
    const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
    const isV1 = client?.plan === 'CX Agent (V1)' || client?.subscriptionPlan === 'v1';
    if (!client || isV1) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(403).json({ message: 'Marketing Broadcasting is locked for CX Agent (V1). Please upgrade.' });
    }

    const limits = await checkLimit(client._id, 'campaigns');
    if (!limits.allowed) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(403).json({ message: limits.reason });
    }

    await incrementUsage(client._id, 'campaigns', 1);

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });
    if (rows.length > 5000) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ message: 'CSV too large. Maximum 5000 rows allowed.' });
    }

    const audience = [];
    rows.forEach(row => {
      const phone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      if (phone || row.email) {
        audience.push({
           phone,
           email: row.email || row.Email || '',
           name: row.name || '',
           ...row // store full row data for variable mapping
        });
      }
    });

    const validCount = audience.length;

    const campaign = await Campaign.create({
      clientId: req.user.clientId,
      name: req.body.name,
      templateName: req.body.templateName,
      status: 'DRAFT',
      csvFile: req.file.path,
      audienceCount: validCount,
      audience // Store audience directly in document
    });
    log.info(`Campaign CREATED: ${campaign.name} | clientId: ${req.user.clientId} | rows: ${validCount}`);
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   POST /api/campaigns/from-segment
// @desc    Create a campaign from a saved AI Segment
// @access  Private
router.post('/from-segment', protect, async (req, res) => {
    const { segmentId, name } = req.body;
    try {
        const segment = await Segment.findOne({ _id: segmentId, clientId: req.user.clientId });
        if (!segment) return res.status(404).json({ error: 'Segment not found' });

        const count = await AdLead.countDocuments({ ...segment.query, clientId: req.user.clientId });
        const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();

        const limits = await checkLimit(client._id, 'campaigns');
        if (!limits.allowed) {
            return res.status(403).json({ error: limits.reason });
        }

        await incrementUsage(client._id, 'campaigns', 1);

        const campaign = await Campaign.create({
            clientId: req.user.clientId,
            name: name || `Segment: ${segment.name}`,
            status: 'DRAFT',
            audienceCount: count,
            segmentId: segmentId
        });

        res.json(campaign);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create campaign from segment' });
    }
});

// @route   POST /api/campaigns/from-imported-list
// @desc    Create a campaign targeting an imported list
// @access  Private
router.post('/from-imported-list', protect, async (req, res) => {
    const { importBatchId, name } = req.body;
    try {
        if (!importBatchId) {
            return res.status(400).json({ error: 'importBatchId is required' });
        }

        // The frontend sends either ImportSession._id or ImportSession.batchId
        // (the BATCH_* string). Normalize before querying AdLead — the schema
        // there is ObjectId-typed and would otherwise crash with a CastError.
        const resolvedId = await resolveImportBatchObjectId(importBatchId, req.user.clientId);
        if (!resolvedId) {
            return res.status(404).json({ error: 'Import batch not found for this account' });
        }

        const count = await AdLead.countDocuments({ importBatchId: resolvedId, clientId: req.user.clientId });
        if (count === 0) {
            return res.status(400).json({ error: 'This import batch has no targetable contacts.' });
        }

        const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const limits = await checkLimit(client._id, 'campaigns');
        if (!limits.allowed) {
            return res.status(403).json({ error: limits.reason });
        }

        await incrementUsage(client._id, 'campaigns', 1);

        const campaign = await Campaign.create({
            clientId: req.user.clientId,
            name: name || `Imported List Broadcast`,
            status: 'DRAFT',
            audienceCount: count,
            // Persist the canonical ObjectId hex string so downstream
            // workers (cron + broadcast engine) get a safe value.
            importBatchId: resolvedId.toString()
        });

        res.json(campaign);
    } catch (err) {
        log.error('[from-imported-list] Failed:', err.message);
        res.status(500).json({ error: 'Failed to create campaign from imported list' });
    }
});

// @route   POST /api/campaigns/from-leads
// @desc    Create a DRAFT campaign with a fixed audience from CRM lead IDs (Audience hub / mass message).
// @access  Private
router.post('/from-leads', protect, async (req, res) => {
    const { leadIds, name } = req.body || {};
    try {
        const rawIds = Array.isArray(leadIds) ? leadIds : [];
        const objectIds = [
            ...new Set(
                rawIds
                    .map((id) => String(id || '').trim())
                    .filter((id) => mongoose.Types.ObjectId.isValid(id))
                    .map((id) => new mongoose.Types.ObjectId(id))
            ),
        ];
        if (objectIds.length === 0) {
            return res.status(400).json({ error: 'leadIds must be a non-empty array of valid lead IDs' });
        }
        if (objectIds.length > 10000) {
            return res.status(400).json({ error: 'Maximum 10,000 leads per CRM broadcast' });
        }

        const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const limits = await checkLimit(client._id, 'campaigns');
        if (!limits.allowed) {
            return res.status(403).json({ error: limits.reason });
        }

        const leads = await AdLead.find({
            _id: { $in: objectIds },
            clientId: req.user.clientId,
        }).lean();

        if (!leads.length) {
            return res.status(400).json({ error: 'No matching leads found for this account' });
        }

        const audience = leads.map((l) => ({
            phone: l.phoneNumber,
            name: l.name || '',
            ...l,
        }));

        await incrementUsage(client._id, 'campaigns', 1);

        const campaign = await Campaign.create({
            clientId: req.user.clientId,
            name: name || `CRM · ${audience.length} contacts`,
            status: 'DRAFT',
            audience,
            audienceCount: audience.length,
        });

        res.json(campaign);
    } catch (err) {
        log.error('[from-leads] Failed:', err.message);
        res.status(500).json({ error: 'Failed to create campaign from selected leads' });
    }
});

// @route   POST /api/campaigns/from-hot-leads
// @desc    Create a campaign from a list of hot leads
// @access  Private
router.post('/from-hot-leads', protect, async (req, res) => {
    const { name, count } = req.body;
    try {
        const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
        if (!client) return res.status(403).json({ error: 'Client not found' });

        const limits = await checkLimit(client._id, 'campaigns');
        if (!limits.allowed) {
            return res.status(403).json({ error: limits.reason });
        }

        const { resolvePlanLimits } = require('../config/planCatalog');
        const planLimits = resolvePlanLimits(client.subscriptionPlan || client.plan);
        const hotMax = Math.max(50, Number(planLimits.leads || 500));
        const requested = Math.max(1, Number(count) || 50);
        const cappedCount = Math.min(requested, hotMax);

        await incrementUsage(client._id, 'campaigns', 1);

        const campaign = await Campaign.create({
            clientId: req.user.clientId,
            name: name || `Hot Leads Targeting`,
            status: 'DRAFT',
            audienceCount: cappedCount,
            isSmartSend: true,
            templateName: ""
        });

        res.json(campaign);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Failed to create hot leads campaign' });
    }
});

// @route   POST /api/campaigns/quick-send
// @desc    Send a template message to multiple contacts (max 250)
// @access  Private
router.post('/quick-send', protect, async (req, res) => {
  const { leadId, leadIds, templateName, channel, strictValidation = true } = req.body;
  const clientId = req.user.clientId;
  if (!req.body.templateCategory) {
    return res.status(400).json({
      success: false,
      message: 'templateCategory is required for compliance-safe quick send',
    });
  }
  const quickCampaign = {
    channel: channel || 'whatsapp',
    templateCategory: String(req.body.templateCategory || 'MARKETING').toUpperCase(),
  };

  const finalLeadIds = leadIds || (leadId ? [leadId] : []);

  if (finalLeadIds.length === 0 || !templateName) {
    return res.status(400).json({ success: false, message: 'leadIds and templateName are required' });
  }

  if (finalLeadIds.length > 250) {
    return res.status(400).json({ success: false, message: 'Maximum 250 recipients allowed for quick broadcast' });
  }

  try {
    const client = await Client.findOne({ clientId })
      .select('clientId whatsappToken phoneNumberId wabaId syncedMetaTemplates messageTemplates')
      .lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    if (!client.phoneNumberId || !client.whatsappToken) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp is not connected. Connect Cloud API in Settings → Integrations.',
      });
    }

    const { resolveTemplateForSend } = require('../services/templateResolver');
    const { sendForAutomation } = require('../services/templateSender');
    const resolved = await resolveTemplateForSend(clientId, { name: templateName });
    if (!resolved?.template) {
      return res.status(400).json({
        success: false,
        message: `Template "${templateName}" was not found. Open Meta Manager and sync approved templates.`,
      });
    }

    const syncedTpl = (client.syncedMetaTemplates || []).find((t) => t?.name === templateName);
    const eligibilityTpl = syncedTpl || {
      name: templateName,
      status: resolved.template.submissionStatus === 'approved' ? 'APPROVED' : 'APPROVED',
      components: resolved.template.components,
      primaryPurpose: resolved.template.primaryPurpose || 'campaign',
      secondaryPurposes: Array.isArray(resolved.template.secondaryPurposes)
        ? resolved.template.secondaryPurposes
        : ['campaign', 'utility'],
    };

    const preflight = validateTemplateEligibility({
      template: eligibilityTpl,
      contextPurpose: 'campaign',
      strict: strictValidation !== false,
    });
    if (!preflight.ok) {
      log.warn('[QuickSend][TemplatePreflightFailed]', {
        clientId,
        templateName,
        contextPurpose: 'campaign',
        missingVariables: preflight.missingVariables,
        requiredVariableCount: preflight.requiredVariableCount,
        reasons: preflight.reasons,
      });
      return res.status(400).json({
        success: false,
        message: preflight.reasons.join(' '),
        missingVariables: preflight.missingVariables,
        requiredVariableCount: preflight.requiredVariableCount,
      });
    }

    const leads = await AdLead.find({ _id: { $in: finalLeadIds }, clientId });
    if (leads.length === 0) return res.status(404).json({ success: false, message: 'No valid leads found' });

    let successCount = 0;
    let failCount = 0;
    let skippedOptIn = 0;

    for (const lead of leads) {
      const eligibility = await canSendToContact(clientId, lead, quickCampaign.templateCategory);
      if (!eligibility.canSend) {
        skippedOptIn++;
        continue;
      }

      try {
        const sendResult = await sendForAutomation({
          clientId,
          phone: lead.phoneNumber,
          metaName: templateName,
          contextType: 'flow',
          contextData: {
            extra: {
              first_name: lead.name || 'Customer',
              leadName: lead.name || '',
            },
          },
        });

        if (sendResult?.whatsapp?.sent) {
          await AdLead.findByIdAndUpdate(lead._id, {
            $push: {
              activityLog: {
                action: 'quick_message_sent',
                details: `Sent template: ${templateName}`,
                timestamp: new Date(),
              },
            },
          });
          successCount++;
        } else {
          const reason =
            sendResult?.whatsapp?.reason ||
            sendResult?.whatsapp?.error ||
            'send_failed';
          log.warn(`[QuickSend] Skipped ${lead.phoneNumber}: ${reason}`);
          failCount++;
        }
      } catch (err) {
        log.error(`[QuickSend] Failed for ${lead.phoneNumber}:`, err.message);
        failCount++;
      }

      if (finalLeadIds.length > 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (successCount === 0 && failCount === 0 && skippedOptIn > 0) {
      return res.status(400).json({
        success: false,
        message:
          'No messages sent — selected contacts opted out of marketing or could not be reached.',
        successCount: 0,
        failCount: 0,
        skippedMarketingOptIn: skippedOptIn,
      });
    }

    if (successCount === 0 && failCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Broadcast failed for all recipients. Check template variables, media header, or WhatsApp connection.',
        successCount,
        failCount,
        skippedMarketingOptIn: skippedOptIn,
      });
    }

    await incrementStat(clientId, { totalConversations: successCount });

    res.json({
      success: true,
      message: `Broadcast complete. Success: ${successCount}, Failed: ${failCount}${skippedOptIn ? `, Skipped (opted out): ${skippedOptIn}` : ''}`,
      successCount,
      failCount,
      skippedMarketingOptIn: skippedOptIn,
    });
  } catch (err) {
    log.error('[QuickSend] Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process quick broadcast: ' + err.message });
  }
});

// @route   GET /api/campaigns
// @desc    List campaigns
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const campaigns = await Campaign.find({ clientId }).sort({ createdAt: -1 }).lean();
    
    // Aggregate stats for all campaigns of this client to avoid N+1 queries
    const campaignStats = await CampaignMessage.aggregate([
      { $match: { clientId } },
      {
        $group: {
          _id: { campaignId: "$campaignId", status: "$status" },
          count: { $sum: 1 }
        }
      }
    ]);

    // Map stats back to campaigns
    const statsMap = campaignStats.reduce((acc, curr) => {
      const cId = curr._id.campaignId.toString();
      if (!acc[cId]) {
        acc[cId] = { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0 };
      }

      const status = curr._id.status;
      if (status === 'sent') acc[cId].sent += curr.count;
      if (status === 'delivered') acc[cId].delivered += curr.count;
      if (status === 'read') acc[cId].read += curr.count;
      if (status === 'replied') acc[cId].replied += curr.count;
      if (status === 'failed') acc[cId].failed += curr.count;
      if (status === 'cancelled') acc[cId].cancelled += curr.count;

      return acc;
    }, {});

    const enrichedCampaigns = campaigns.map(c => {
      const stats = statsMap[c._id.toString()] || {
        sent: 0,
        delivered: 0,
        read: 0,
        replied: 0,
        failed: 0,
        cancelled: 0,
      };
      const totalDelivered = stats.delivered + stats.read + stats.replied;
      const totalRead = stats.read + stats.replied;
      const totalSent = stats.sent + totalDelivered;

      return {
        ...c,
        sentCount: totalSent,
        deliveredCount: totalDelivered,
        readCount: totalRead,
        repliedCount: stats.replied,
        failedCount: stats.failed,
        cancelledCount: stats.cancelled,
        stats: {
          sent: totalSent,
          delivered: totalDelivered,
          read: totalRead,
          replied: stats.replied,
          failed: stats.failed,
          cancelled: stats.cancelled,
        },
      };
    });

    res.json(enrichedCampaigns);
  } catch (error) {
    console.error('[Campaigns] List error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// STATIC PATHS BEFORE /:id and /:campaignId — do not register literals below parameterized GETs
router.get('/templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const { filterTemplatesForContext } = require('../utils/meta/templatePolicy');
    const contextPurpose = String(req.query.contextPurpose || 'campaign').toLowerCase();
    const synced = client.syncedMetaTemplates || [];
    const { eligible, hidden, approvedTotal, syncedTotal } = filterTemplatesForContext(synced, contextPurpose);
    res.json({
      success: true,
      templates: eligible,
      meta: {
        syncedTotal,
        approvedTotal,
        eligibleTotal: eligible.length,
        hiddenSystem: hidden.systemExcluded,
        hiddenNotApproved: hidden.notApproved,
        hiddenWrongCategory: hidden.wrongCategory,
        hiddenNonMarketing: contextPurpose === 'campaign' ? hidden.wrongCategory : 0,
      },
    });
  } catch (err) {
    console.error('[CampaignTemplates] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
});

router.get('/audience-estimate', protect, apiCache(30), async (req, res) => {
    const { source, segmentId, importBatchId, campaignId } = req.query;
    const cid = req.user.clientId;
    let count = 0;

    try {
        if (source === 'all') {
            count = await AdLead.countDocuments({ clientId: cid });
        } else if (source === 'segment' && segmentId) {
            const segment = await Segment.findOne({ _id: segmentId, clientId: cid });
            if (segment) {
                count = await AdLead.countDocuments({ clientId: cid, ...segment.query });
            }
        } else if (source === 'imported' && importBatchId) {
            const resolvedId = await resolveImportBatchObjectId(importBatchId, cid);
            count = resolvedId
                ? await AdLead.countDocuments({ clientId: cid, importBatchId: resolvedId })
                : 0;
        } else if (source === 'hot') {
            count = await AdLead.countDocuments({ 
                clientId: cid, 
                $or: [
                    { cartStatus: 'abandoned' },
                    { addToCartCount: { $gt: 0 }, isOrderPlaced: { $ne: true } }
                ]
            });
        } else if (source === 'manual' && campaignId && mongoose.Types.ObjectId.isValid(String(campaignId))) {
            const campaign = await Campaign.findOne({ _id: campaignId, clientId: cid }).select('audience').lean();
            count = Array.isArray(campaign?.audience) ? campaign.audience.length : 0;
        }

        res.json({ success: true, count });
    } catch (err) {
        console.error('[AudienceEstimate] Error:', err);
        res.json({ success: true, count: 0, warning: 'estimate_failed' });
    }
});

router.get('/audience-preview', protect, async (req, res) => {
  try {
    const cid = req.user.clientId;
    const {
      source: sourceRaw,
      segmentId,
      importBatchId,
      campaignId,
      templateCategory = 'MARKETING',
    } = req.query;
    let leads = [];

    let source = String(sourceRaw || '').toLowerCase();
    if (!source) {
      if (segmentId) source = 'segment';
      else if (importBatchId) source = 'imported';
      else if (campaignId) source = 'manual';
    }

    if (source === 'segment' && segmentId) {
      const segment = await Segment.findOne({ _id: segmentId, clientId: cid }).lean();
      if (!segment) return res.status(404).json({ success: false, message: 'Segment not found' });
      leads = await AdLead.find({ clientId: cid, ...segment.query })
        .select('optStatus optInSource')
        .lean();
    } else if (source === 'imported' && importBatchId) {
      const resolved = await resolveImportBatchObjectId(importBatchId, cid);
      if (!resolved) return res.status(404).json({ success: false, message: 'Import batch not found' });
      leads = await AdLead.find({ clientId: cid, importBatchId: resolved })
        .select('optStatus optInSource')
        .lean();
    } else if (source === 'manual' && campaignId) {
      if (!mongoose.Types.ObjectId.isValid(String(campaignId))) {
        return res.status(400).json({ success: false, message: 'Invalid campaign id' });
      }
      const campaign = await Campaign.findOne({ _id: campaignId, clientId: cid }).select('audience').lean();
      if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
      const phones = [
        ...new Set(
          (campaign.audience || [])
            .map((row) => String(row?.phone || row?.phoneNumber || '').trim())
            .filter(Boolean)
        ),
      ];
      if (phones.length) {
        leads = await AdLead.find({ clientId: cid, phoneNumber: { $in: phones } })
          .select('optStatus optInSource')
          .lean();
      } else {
        leads = [];
      }
    } else if (source === 'hot') {
      leads = await AdLead.find({
        clientId: cid,
        $or: [
          { cartStatus: 'abandoned' },
          { addToCartCount: { $gt: 0 }, isOrderPlaced: { $ne: true } },
        ],
      })
        .select('optStatus optInSource')
        .lean();
    } else {
      return res.status(400).json({
        success: false,
        message: 'Specify a valid audience source (segment, imported, manual, or hot) with the required ids.',
      });
    }

    const cat = String(templateCategory || 'MARKETING').toUpperCase();
    const counts = evaluateAudiencePolicySummary(leads, cat);
    const sourceMap = new Map();
    for (const lead of leads) {
      const src = lead.optInSource || 'unknown';
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
    }

    res.json({
      success: true,
      templateCategory: cat,
      ...counts,
      bySource: [...sourceMap.entries()].map(([source, count]) => ({ source, count })),
      recommendedRepermission: counts.unknownBlocked > 0 ? counts.unknownBlocked : 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   POST /api/campaigns/:id/pause
router.post('/:id/pause', ...campaignMutate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    campaign.status = 'PAUSED';
    await campaign.save();
    const { removeWaitingJobsForCampaign } = require('../utils/messaging/queues/campaignDispatchQueue');
    await removeWaitingJobsForCampaign(String(campaign._id));
    const io = req.app.get('socketio');
    if (io) io.to(`client_${campaign.clientId}`).emit('campaign:paused', { campaignId: campaign._id });
    return res.json({ success: true, status: 'PAUSED' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/:id/cancel
router.post('/:id/cancel', ...campaignMutate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    if (['CANCELLED', 'COMPLETED', 'FAILED'].includes(campaign.status)) {
      return res.status(400).json({ success: false, message: `Campaign already ${campaign.status}` });
    }

    campaign.status = 'CANCELLED';
    campaign.audienceRefreshable = false;
    await campaign.save();

    const { removeWaitingJobsForCampaign } = require('../utils/messaging/queues/campaignDispatchQueue');
    await removeWaitingJobsForCampaign(String(campaign._id));

    const cancelAt = new Date();
    const msgRes = await CampaignMessage.updateMany(
      {
        campaignId: campaign._id,
        status: { $in: ['queued', 'retrying', 'processing'] },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledReason: 'merchant_cancelled',
          cancelledAt: cancelAt,
          lockedBy: null,
          lockedAt: null,
        },
      }
    );

    const { cancelAllAutomationsFor } = require('../utils/messaging/cancelAllAutomationsFor');
    const FollowUpSequence = require('../models/FollowUpSequence');
    const ScheduledMessage = require('../models/ScheduledMessage');
    const leadRows = await CampaignMessage.find({ campaignId: campaign._id })
      .select('phone metadata.leadId')
      .lean();
    const seen = new Set();
    let automationsCancelled = 0;
    for (const row of leadRows) {
      const leadId = row.metadata?.leadId;
      const key = leadId ? String(leadId) : String(row.phone || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const hasSeq = leadId
        ? await FollowUpSequence.exists({
            clientId: campaign.clientId,
            leadId,
            status: 'active',
          })
        : await FollowUpSequence.exists({
            clientId: campaign.clientId,
            phone: row.phone,
            status: 'active',
          });
      const hasSched = leadId
        ? await ScheduledMessage.exists({
            clientId: campaign.clientId,
            leadId,
            status: { $in: ['pending', 'queued', 'scheduled'] },
          })
        : await ScheduledMessage.exists({
            clientId: campaign.clientId,
            phone: row.phone,
            status: { $in: ['pending', 'queued', 'scheduled'] },
          });
      if (!hasSeq && !hasSched) continue;
      await cancelAllAutomationsFor({
        clientId: campaign.clientId,
        leadId: leadId || undefined,
        phone: row.phone,
        reason: 'agent_block',
        channels: 'all',
        actor: {
          type: 'user',
          userId: req.user._id || req.user.id,
          source: 'dashboard',
        },
      });
      automationsCancelled += 1;
    }

    const { writeAuditLog } = require('../utils/messaging/writeAuditLog');
    await writeAuditLog({
      clientId: campaign.clientId,
      action_type: 'campaign_cancelled',
      target_resource: `campaign:${campaign._id}`,
      actor: {
        type: 'user',
        userId: req.user._id || req.user.id,
        source: 'dashboard',
      },
      payload: { messagesCancelled: msgRes.modifiedCount || 0, automationsCancelled },
    });

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${campaign.clientId}`).emit('campaign:cancelled', {
        campaignId: campaign._id,
        messagesCancelled: msgRes.modifiedCount || 0,
      });
    }
    return res.json({
      success: true,
      status: 'CANCELLED',
      messagesCancelled: msgRes.modifiedCount || 0,
      automationsCancelled,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   DELETE /api/campaigns/:id
router.delete('/:id', ...campaignMutate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    if (['SENDING', 'QUEUED'].includes(campaign.status)) {
      return res.status(400).json({
        success: false,
        message:
          campaign.status === 'SENDING'
            ? 'Cancel the campaign before deleting'
            : 'Wait for launch to finish or cancel the campaign first',
      });
    }
    await Campaign.deleteOne({ _id: campaign._id, clientId: req.user.clientId });
    return res.json({ success: true, message: 'Campaign deleted' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/:id/refresh-audience
router.post('/:id/refresh-audience', ...campaignMutate, async (req, res) => {
  try {
    const { refreshCampaignAudience } = require('../services/campaignRefreshAudience');
    const result = await refreshCampaignAudience(req.params.id, req.user.clientId);
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.message });
    }
    return res.json({
      success: true,
      added: result.added,
      lastAudienceRefreshAt: result.lastAudienceRefreshAt,
      audienceRefreshable: result.audienceRefreshable,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/:id/resume
router.post('/:id/resume', ...campaignMutate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    campaign.status = 'SENDING';
    await campaign.save();
    const { reenqueueQueuedMessages } = require('../services/campaignLaunchService');
    const n = await reenqueueQueuedMessages(campaign._id);
    const io = req.app.get('socketio');
    if (io) io.to(`client_${campaign.clientId}`).emit('campaign:resumed', { campaignId: campaign._id, requeued: n });
    return res.json({ success: true, status: 'SENDING', requeued: n });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/:id/send-winner
router.post('/:id/send-winner', ...campaignMutate, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!campaign || !campaign.isAbTest) {
      return res.status(400).json({ success: false, message: 'Not an A/B campaign' });
    }
    const winnerLabel = req.body.variantId || campaign.winnerVariant;
    const winner = (campaign.abVariants || []).find((v) => v.label === winnerLabel);
    if (!winner) return res.status(400).json({ success: false, message: 'Winner variant not found' });
    campaign.winnerVariant = winner.label;
    const holdback = await CampaignMessage.find({
      campaignId: campaign._id,
      abVariantLabel: 'holdout',
      status: 'queued',
    }).lean();
    const rows = holdback.map((m) => ({
      phone: m.phone,
      _id: m.metadata?.leadId,
      name: m.metadata?.name,
      variantId: winner.label,
    }));
    for (const m of holdback) {
      await CampaignMessage.updateOne(
        { _id: m._id },
        { $set: { variantId: winner.label, abVariantLabel: `holdout_${winner.label}` } }
      );
    }
    const { bulkEnqueueCampaignJobs } = require('../utils/messaging/queues/campaignDispatchQueue');
    await bulkEnqueueCampaignJobs(
      holdback.map((m) => ({
        campaignMessageId: String(m._id),
        campaignId: String(campaign._id),
        clientId: campaign.clientId,
        channel: 'whatsapp',
      }))
    );
    campaign.abTestConfig = { ...(campaign.abTestConfig || {}), holdbackProcessed: true };
    await campaign.save();
    return res.json({ success: true, holdbackEnqueued: rows.length, winner: winner.label });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/preflight
// @desc    Opt-in + template checks before launch (Phase 2)
// @access  Private
router.post('/preflight', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { campaignId, audienceCount: rawCount, channel: rawChannel, templateName } = req.body || {};
    const Campaign = require('../models/Campaign');
    const Client = require('../models/Client');
    let campaign = null;
    let audienceRows = [];
    if (campaignId) {
      campaign = await Campaign.findOne({ _id: campaignId, clientId }).lean();
      if (!campaign) {
        return res.status(404).json({ success: false, blocked: true, message: 'Campaign not found' });
      }
      audienceRows = Array.isArray(campaign.audience) ? campaign.audience : [];
    }

    const channel = String(rawChannel || campaign?.channel || 'whatsapp').toLowerCase();
    const isEmail = channel === 'email';
    const audienceCount =
      audienceRows.length ||
      Math.max(0, Number(rawCount) || Number(campaign?.audienceCount) || 0);

    const blockers = [];
    let eligibleCount = audienceCount;

    if (campaign && audienceRows.length > 0) {
      const optFiltered = await filterAudienceForMarketingOptIn(
        clientId,
        audienceRows,
        { ...campaign, channel }
      );
      eligibleCount = optFiltered.rows.length;
      if (eligibleCount === 0) {
        blockers.push({
          code: 'no_opt_in',
          message: isEmail
            ? 'No email marketing–eligible contacts in this audience.'
            : 'No WhatsApp contacts in this audience (everyone may be opted out).',
        });
      } else if (optFiltered.excluded > 0) {
        blockers.push({
          code: 'partial_opt_in',
          message: `${optFiltered.excluded} contact(s) will be skipped (opted out). ${eligibleCount} eligible.`,
          severity: 'warning',
        });
      }
    } else if (!isEmail && audienceCount > 0) {
      blockers.push({
        code: 'opt_in_unverified',
        message:
          'Audience size is estimated. Opted-out contacts are skipped at send time.',
        severity: 'warning',
      });
      eligibleCount = audienceCount;
    }

    if (!isEmail && templateName) {
      const client = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
      const synced = client?.syncedMetaTemplates || [];
      const tpl = synced.find((t) => t?.name === templateName);
      if (!tpl) {
        blockers.push({
          code: 'template_missing',
          message: `Template "${templateName}" is not synced from Meta. Open Meta Manager and sync templates.`,
        });
      } else {
        const pre = validateTemplateEligibility({
          template: tpl,
          contextPurpose: 'campaign',
        });
        if (!pre.ok) {
          blockers.push({
            code: 'template_not_approved',
            message: (pre.reasons && pre.reasons[0]) || 'Template is not approved for sending.',
          });
        }
      }
    }

    const hardBlock = blockers.some((b) => b.severity !== 'warning' && b.code !== 'partial_opt_in' && b.code !== 'opt_in_unverified');
    const blocked = blockers.some((b) => b.code === 'no_opt_in' || b.code === 'template_missing' || b.code === 'template_not_approved');

    const {
      estimateMetaBreakdown,
      estimateTenantCost,
      META_MARKETING_INR,
    } = require('../services/billing/costEstimation');
    const waCount = isEmail ? 0 : eligibleCount;
    const emailCount = isEmail ? eligibleCount : 0;
    const meta = estimateMetaBreakdown({ marketingCount: waCount, utilityCount: 0 });
    const row = estimateTenantCost({
      usage: { whatsappSent: waCount, emailSent: emailCount },
      planPriceInr: 0,
      marketingCount: waCount,
      utilityCount: 0,
    });

    return res.json({
      success: true,
      blocked: blocked || hardBlock,
      blockers,
      eligibleCount,
      audienceCount,
      channel,
      estimate: {
        estimatedTotalInr: row.meta_messages + row.email,
        perMessageInr: isEmail ? 0.1 : META_MARKETING_INR,
        meta_breakdown: meta,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, blocked: true, message: e.message });
  }
});

// @route   POST /api/campaigns/estimate-cost
// @desc    Rough per-campaign send cost (heuristic, INR)
// @access  Private
router.post('/estimate-cost', protect, async (req, res) => {
  try {
    const count = Math.max(0, Number(req.body.audienceCount) || 0);
    const channel = String(req.body.channel || 'whatsapp').toLowerCase();
    const {
      estimateTenantCost,
      estimateMetaBreakdown,
      META_MARKETING_INR,
    } = require('../services/billing/costEstimation');
    const waCount = channel === 'email' ? 0 : count;
    const emailCount = channel === 'email' ? count : 0;
    const meta = estimateMetaBreakdown({ marketingCount: waCount, utilityCount: 0 });
    const row = estimateTenantCost({
      usage: { whatsappSent: waCount, emailSent: emailCount },
      planPriceInr: 0,
      marketingCount: waCount,
      utilityCount: 0,
    });
    const estimatedTotalInr = row.meta_messages + row.email;
    return res.json({
      success: true,
      audienceCount: count,
      channel,
      whatsapp: {
        count: waCount,
        perMessageInr: META_MARKETING_INR,
        category: 'marketing',
        subtotalInr: meta.marketing_inr,
      },
      email: {
        count: emailCount,
        perMessageInr: 0.1,
        subtotalInr: row.email,
      },
      perMessageInr: count > 0 ? estimatedTotalInr / count : channel === 'email' ? 0.1 : META_MARKETING_INR,
      estimatedTotalInr,
      meta_breakdown: meta,
      disclaimer: row.disclaimer,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// @route   POST /api/campaigns/start
// @desc    Start a CSV campaign and send messages
// @access  Private
router.post('/start', protect, async (req, res) => {
  const { campaignId, templateType } = req.body;
  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }
  const bodyChannel = String(req.body.channel || '').toLowerCase();
  if (bodyChannel !== 'email' && !templateType) {
    return res.status(400).json({ message: 'campaignId and templateType are required' });
  }
  try {
    const campaign = await Campaign.findOne({ _id: campaignId, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

    const startChannel = bodyChannel || String(campaign.channel || 'whatsapp').toLowerCase();
    campaign.channel = startChannel === 'email' ? 'email' : 'whatsapp';
    if (campaign.channel === 'email') {
      campaign.emailSubject =
        req.body.emailSubject || campaign.emailSubject || 'Update from your store';
      campaign.emailHtml =
        req.body.emailHtml ||
        req.body.customTextValues?.body ||
        campaign.emailHtml ||
        '<p>Hello,</p>';
      campaign.templateName = req.body.templateName || campaign.templateName || 'email_campaign';
    }
    
    const hasInlineAudience = Array.isArray(campaign.audience) && campaign.audience.length > 0;
    // CSV / segment / import resolve audience at start; CRM-from-leads stores audience on the document;
    // smart-send campaigns resolve audience in the worker.
    if (
        !campaign.csvFile &&
        !campaign.segmentId &&
        !campaign.importBatchId &&
        !hasInlineAudience &&
        !campaign.isSmartSend
    ) {
        return res.status(400).json({ message: 'No audience attached to this campaign' });
    }

    log.info(`Campaign START: campaignId=${campaignId} | clientId=${req.user.clientId} | templateType=${templateType}`);
    campaign.status = req.body.scheduledDate ? 'SCHEDULED' : 'SENDING';
    if (req.body.scheduledDate) {
        campaign.scheduledAt = new Date(req.body.scheduledDate);
    }
    await campaign.save();

    // Fetch client configuration
    const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
    if (!client) {
        return res.status(404).json({ message: 'Client configuration not found' });
    }

    const isV1 = client?.plan === 'CX Agent (V1)' || client?.subscriptionPlan === 'v1';
    if (isV1) {
      return res.status(403).json({ message: 'Marketing Broadcasting is locked for CX Agent (V1). Please upgrade to V2.' });
    }

    const limits = await checkLimit(client._id, 'messages'); // Check if messages allowed
    if (!limits.allowed) {
      return res.status(403).json({ message: limits.reason });
    }

    // Determine actual template name from client config
    let actualTemplateName = null;
    if (templateType === 'birthday') {
        actualTemplateName = client.config?.templates?.birthday || 'happy_birthday_wish_1';
    } else if (templateType === 'appointment') {
        return res.status(400).json({
          message: 'Appointment campaigns are no longer supported (e-commerce platform only).',
        });
    }

    let total = 0;
    let sent = 0;
    let failed = 0;

    // --- Unified Processing ---
    // Save variables to the campaign so the cron can process them
    campaign.variableMapping = req.body.variableMapping || {};
    campaign.customTextValues = req.body.customTextValues || {};
    campaign.templateComponents = req.body.templateComponents || [];
    campaign.languageCode = req.body.languageCode || 'en';
    
    // Instead of inline processing, mark it QUEUED (or SCHEDULED)
    campaign.status = req.body.scheduledDate ? 'SCHEDULED' : 'QUEUED';
    if (req.body.scheduledDate) {
        campaign.scheduledAt = new Date(req.body.scheduledDate);
    }

    campaign.campaignType = String(req.body.campaignType || campaign.campaignType || 'STANDARD').toUpperCase();
    campaign.templateCategory = String(
      req.body.templateCategory || campaign.templateCategory || 'MARKETING'
    ).toUpperCase();
    if (campaign.campaignType === 'RE_PERMISSION') {
      campaign.templateCategory = 'UTILITY';
    }
    const marketingOptQ = audienceOptQueryForCampaign(campaign);
    const isEmailChannel = campaign.channel === 'email';
    
    // Resolve audience for Segments and Import Lists if not already set
    if (!campaign.audience || campaign.audience.length === 0) {
        if (campaign.segmentId) {
            const segment = await Segment.findById(campaign.segmentId);
            if (segment) {
                const leads = await AdLead.find({
                  ...segment.query,
                  clientId: req.user.clientId,
                  ...marketingOptQ,
                }).lean();
                campaign.audience = leads.map((l) => ({
                  phone: l.phoneNumber,
                  email: l.email,
                  name: l.name || '',
                  _id: l._id,
                }));
            }
        } else if (campaign.importBatchId) {
            // Normalize whatever was stored (legacy BATCH_* string or canonical ObjectId hex)
            // before querying AdLead.importBatchId (ObjectId-typed).
            const resolvedBatchId = await resolveImportBatchObjectId(campaign.importBatchId, req.user.clientId);
            if (!resolvedBatchId) {
                campaign.status = 'FAILED';
                await campaign.save();
                return res.status(400).json({ message: 'Imported list could not be resolved. The batch may have been deleted.' });
            }
            const leads = await AdLead.find({
                  importBatchId: resolvedBatchId,
                  clientId: req.user.clientId,
                  ...marketingOptQ,
                }).lean();
                campaign.audience = leads.map((l) => ({
                  phone: l.phoneNumber,
                  email: l.email,
                  name: l.name || '',
                  _id: l._id,
                }));
        }
        campaign.audienceCount = campaign.audience.length;
    }

    const rawAudience = campaign.audience || [];
    let filteredAudience;
    if (isEmailChannel) {
      filteredAudience = rawAudience.filter((row) => Boolean(normalizeEmail(row?.email)));
      const droppedNoEmail = rawAudience.length - filteredAudience.length;
      if (droppedNoEmail > 0) {
        log.warn(`[Campaign ${campaign._id}] Dropped ${droppedNoEmail} contact(s) with missing email.`);
        campaign.audience = filteredAudience;
        campaign.audienceCount = filteredAudience.length;
      }
      if (filteredAudience.length === 0) {
        campaign.status = 'FAILED';
        await campaign.save();
        return res.status(400).json({ message: 'No contacts with a valid email were found in this audience.' });
      }
    } else {
      filteredAudience = rawAudience.filter((row) => {
        const raw = row?.phone || row?.phoneNumber || row?.number || row?.mobile || '';
        return Boolean(normalizePhone(raw));
      });
      const droppedNoPhone = rawAudience.length - filteredAudience.length;
      if (droppedNoPhone > 0) {
        log.warn(`[Campaign ${campaign._id}] Dropped ${droppedNoPhone} contact(s) with missing/invalid phone numbers.`);
        campaign.audience = filteredAudience;
        campaign.audienceCount = filteredAudience.length;
      }
      if (filteredAudience.length === 0) {
        campaign.status = 'FAILED';
        await campaign.save();
        return res.status(400).json({ message: 'No contacts with a valid phone number were found in this audience.' });
      }
    }

    if (campaign.campaignType === 'RE_PERMISSION') {
      const rpFiltered = await filterAudienceByOptStatus(req.user.clientId, filteredAudience, ['unknown', 'pending']);
      campaign.audience = rpFiltered.rows;
      campaign.audienceCount = rpFiltered.rows.length;
      campaign.marketingOptInExcludedCount = rpFiltered.excluded;
      if (rpFiltered.rows.length === 0) {
        campaign.status = 'FAILED';
        await campaign.save();
        return res.status(400).json({
          message: 'No unknown/pending contacts available for re-permission campaign.',
          excluded: rpFiltered.excluded || 0,
        });
      }
    }

    const optFiltered = await filterAudienceForMarketingOptIn(
      req.user.clientId,
      campaign.campaignType === 'RE_PERMISSION' ? campaign.audience : filteredAudience,
      campaign
    );
    campaign.marketingOptInExcludedCount = optFiltered.excluded;
    campaign.audience = optFiltered.rows;
    campaign.audienceCount = optFiltered.rows.length;

    if (optFiltered.rows.length === 0) {
      campaign.status = 'FAILED';
      await campaign.save();
      return res.status(400).json({
        message: isEmailChannel
          ? 'No email contacts in this audience after removing opted-out addresses.'
          : 'No WhatsApp contacts in this audience after removing opted-out numbers.',
      });
    }

    const candidateTemplateName = req.body.templateName || actualTemplateName || campaign.templateName;
    if (candidateTemplateName && !isEmailChannel) {
        const synced = client.syncedMetaTemplates || [];
        const tpl = synced.find(t => t?.name === candidateTemplateName);
        const mappedVariables = Object.keys(campaign.variableMapping || {})
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => campaign.variableMapping[k]);
        const preflight = validateTemplateEligibility({
          template: tpl,
          contextPurpose: 'campaign',
          providedVariables: mappedVariables,
          strict: true
        });
        if (!preflight.ok) {
          log.warn('[CampaignStart][TemplatePreflightFailed]', {
            clientId: req.user.clientId,
            campaignId: String(campaign._id),
            templateName: candidateTemplateName,
            contextPurpose: 'campaign',
            missingVariables: preflight.missingVariables,
            requiredVariableCount: preflight.requiredVariableCount,
            reasons: preflight.reasons
          });
          campaign.status = 'FAILED';
          await campaign.save();
          return res.status(400).json({
            message: preflight.reasons.join(' '),
            missingVariables: preflight.missingVariables,
            requiredVariableCount: preflight.requiredVariableCount,
          });
        }
    }

    const rows = optFiltered.rows;

    // Shuffle rows for random AB distribution
    for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
    }

    if (campaign.status === 'QUEUED' && !campaign.scheduledAt) {
      campaign.scheduledAt = new Date();
    }
    if (campaign.status === 'SCHEDULED' && !campaign.scheduledAt) {
      campaign.scheduledAt = new Date();
    }

     if (req.body.isAbTest) {
        campaign.isAbTest = true;
        const holdbackPercent = Math.min(50, Math.max(10, Number(req.body.abTestConfig?.holdbackPercent ?? 20)));
        const holdbackHours = Number(req.body.abTestConfig?.holdbackHours ?? 4);
        campaign.abTestConfig = {
          holdbackPercent,
          winnerMetric: req.body.abTestConfig?.winnerMetric || 'reply_rate',
          holdbackHours,
          autoSendWinner: false,
          holdbackProcessed: false,
        };
        campaign.abVariants = [
          {
            label: 'A',
            templateName: req.body.templateName || campaign.templateName,
            weight: 50,
          },
          {
            label: 'B',
            templateName: req.body.templateTypeB || campaign.templateName,
            weight: 50,
          },
        ];
        if (holdbackHours > 0) {
          campaign.scheduledAt = new Date(Date.now() + holdbackHours * 60 * 60 * 1000);
        }
        await campaign.save();
     }

    campaign.audienceMode = req.body.audienceMode === 'live' ? 'live' : 'snapshot';
    if (req.body.isPredictiveSend || req.body.scheduleStrategy === 'per_contact_optimal') {
      campaign.scheduleStrategy = 'per_contact_optimal';
      campaign.isPredictiveSend = true;
    } else if (req.body.scheduleStrategy === 'fixed') {
      campaign.scheduleStrategy = 'fixed';
      campaign.isPredictiveSend = false;
    }
    await campaign.save();

    if (!campaign.scheduledAt || new Date(campaign.scheduledAt) <= new Date()) {
      const { launchCampaignDispatch } = require('../services/campaignLaunchService');
      const launch = await launchCampaignDispatch(campaign, rows);
      const skipLabel = isEmailChannel ? 'email opted out' : 'WhatsApp opted out';
      const extra =
        optFiltered.excluded > 0 ? ` (${optFiltered.excluded} skipped — ${skipLabel})` : '';
      return res.json({
        success: true,
        message: `Campaign launched for ${launch.inserted} contacts.${extra}`,
        enqueued: launch.enqueued,
        marketingOptInExcluded: optFiltered.excluded || 0,
        campaignType: campaign.campaignType,
      });
    }

    const skipLabel = isEmailChannel ? 'email opted out' : 'WhatsApp opted out';
    const extra =
      optFiltered.excluded > 0 ? ` (${optFiltered.excluded} skipped — ${skipLabel})` : '';
    return res.json({
      success: true,
      message: `Campaign targeting ${rows.length} contacts queued successfully.${extra}`,
      marketingOptInExcluded: optFiltered.excluded || 0,
      campaignType: campaign.campaignType,
    });
  } catch (error) {
    try {
      await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'FAILED' } });
    } catch {}
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   GET /api/campaigns/:clientId/:campaignId/analytics
// @desc    Get detailed performance metrics for a campaign
// @access  Private
router.get('/:clientId/:campaignId/analytics', protect, async (req, res) => {
  try {
    const { clientId, campaignId } = req.params;
    if (!denyUnlessTenant(req, res, clientId)) return;
    const campaign = await Campaign.findOne({ _id: campaignId, clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, analytics: campaign });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   GET /api/campaigns/:campaignId/repermission-funnel
// @desc    Re-permission conversion funnel
router.get('/:campaignId/repermission-funnel', protect, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.campaignId, clientId: req.user.clientId }).lean();
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    if (campaign.campaignType !== 'RE_PERMISSION') {
      return res.status(400).json({ success: false, message: 'Not a re-permission campaign' });
    }
    const sent = await CampaignMessage.countDocuments({ campaignId: campaign._id, clientId: req.user.clientId, status: { $in: ['sent', 'delivered', 'read', 'replied'] } });
    const delivered = await CampaignMessage.countDocuments({ campaignId: campaign._id, clientId: req.user.clientId, status: { $in: ['delivered', 'read', 'replied'] } });
    const opened = await CampaignMessage.countDocuments({ campaignId: campaign._id, clientId: req.user.clientId, status: { $in: ['read', 'replied'] } });
    const confirmedYes = await AdLead.countDocuments({ clientId: req.user.clientId, optInSource: 're_permission_campaign', optStatus: 'opted_in', updatedAt: { $gte: campaign.createdAt } });
    const declinedNo = await AdLead.countDocuments({ clientId: req.user.clientId, optOutSource: 're_permission_campaign', updatedAt: { $gte: campaign.createdAt } });
    const noResponse = Math.max(0, delivered - confirmedYes - declinedNo);
    return res.json({
      success: true,
      funnel: { sent, delivered, opened, confirmedYes, declinedNo, noResponse },
      netNewOptedIn: confirmedYes,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/campaigns/:clientId/ab-test
// @desc    Create an AB Test Campaign
// @access  Private
router.post('/:clientId/ab-test', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!denyUnlessTenant(req, res, clientId)) return;
    // Dummy stub that just creates a campaign marked as AB Test
    // Wait, the client will send variants in body
    const { name, variants } = req.body;
    const campaign = await Campaign.create({
      clientId,
      name,
      templateName: "mixed",
      isAbTest: true,
      abVariants: variants || [],
      status: "DRAFT"
    });
    res.json({ success: true, campaign });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


const META_HEALTH_TIMEOUT_MS = 4500;
const OVERVIEW_AGG_MAX_MS = 12_000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function isThrottledWhatsApp(clientDoc) {
  const until = clientDoc?.complianceConfig?.rateLimits?.whatsapp?.throttledUntil;
  return !!(until && new Date(until) > new Date());
}

async function fetchMetaHealthForOverview(client) {
  const fallback = {
    status: 'HEALTHY',
    tier: 'Tier 1 (1k/day)',
    qualityRating: 'GREEN',
    lastTemplateUpdate: new Date(),
  };
  if (!client?.whatsappToken || !(client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID)) {
    return fallback;
  }
  try {
    const [acc, qual] = await withTimeout(
      Promise.all([WhatsApp.getAccountStatus(client), WhatsApp.getPhoneNumberQuality(client)]),
      META_HEALTH_TIMEOUT_MS,
      null
    );
    if (!acc || !qual) return { ...fallback, status: 'UNKNOWN', qualityRating: 'UNKNOWN' };
    return {
      status: acc.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : qual.status || 'HEALTHY',
      tier: qual.tier || 'Tier 1 (1k/day)',
      qualityRating: qual.qualityRating || 'GREEN',
      lastTemplateUpdate: new Date(),
    };
  } catch (healthErr) {
    log.warn(`[Campaigns] Meta health timeout/error for ${client.clientId}: ${healthErr.message}`);
    return { ...fallback, status: 'UNKNOWN' };
  }
}

// @route   GET /api/campaigns/:clientId/overview
// @desc    Get aggregate campaign metrics and Meta health (?pulse=1 for dashboard badge only)
// @access  Private
router.get('/:clientId/overview', protect, apiCache(60), async (req, res) => {
  try {
    const tenantId = denyUnlessTenant(req, res, req.params.clientId);
    if (!tenantId) return;

    const { client } = await resolveClient(req);
    const clientId = client.clientId;
    const pulseOnly =
      req.query.pulse === '1' || req.query.pulse === 'true' || req.query.mode === 'pulse';

    const clientDoc = await Client.findOne({ clientId })
      .select(
        'complianceConfig whatsappToken phoneNumberId wabaId plan subscriptionPlan'
      )
      .lean();

    const throttledWhatsApp = isThrottledWhatsApp(clientDoc);

    if (pulseOnly) {
      const activeCampaigns = await Campaign.countDocuments({ clientId, status: 'SENDING' }).maxTimeMS(
        4000
      );
      return res.json({
        success: true,
        pulse: true,
        activeCampaigns,
        throttledWhatsApp,
      });
    }

    const [campaigns, statsArray, activeCampaigns] = await Promise.all([
      Campaign.find({ clientId }).sort({ createdAt: -1 }).limit(50).lean().maxTimeMS(8000),
      CampaignMessage.aggregate([
        { $match: { clientId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).option({ maxTimeMS: OVERVIEW_AGG_MAX_MS }),
      Campaign.countDocuments({ clientId, status: 'SENDING' }).maxTimeMS(4000),
    ]);

    const statsMap = statsArray.reduce((acc, curr) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    const totalDelivered = (statsMap.delivered || 0) + (statsMap.read || 0) + (statsMap.replied || 0);
    const totalSent = (statsMap.sent || 0) + totalDelivered;
    const totalRead = (statsMap.read || 0) + (statsMap.replied || 0);
    const totalReplied = statsMap.replied || 0;
    const totalFailed = statsMap.failed || 0;
    const totalCancelled = statsMap.cancelled || 0;

    const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;
    const readRate = totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : 0;
    const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

    const metaHealth = await fetchMetaHealthForOverview(clientDoc || client);

    res.json({
      success: true,
      stats: {
        totalSent,
        totalDelivered,
        totalRead,
        totalReplied,
        totalFailed,
        totalCancelled,
        deliveryRate,
        readRate,
        replyRate,
      },
      metaHealth,
      activeCampaigns,
      throttledWhatsApp,
      recentCampaigns: campaigns.slice(0, 10),
    });
  } catch (error) {
    if (error?.name === 'MongoTimeoutError' || /maxTimeMS/i.test(String(error.message))) {
      return res.status(503).json({
        success: false,
        message: 'Campaign stats are still loading. Try again in a moment.',
        code: 'OVERVIEW_TIMEOUT',
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/campaigns/smart-send
// @desc    Smart broadcast optimization with schedule/throttle execution (DB-queued)
// @access  Private
router.post('/smart-send', protect, async (req, res) => {
    try {
        const { campaignId, config } = req.body;
        if (!campaignId) return res.status(400).json({ success: false, message: 'Campaign ID required' });

        const campaign = await Campaign.findOne({ _id: campaignId, clientId: req.user.clientId });
        if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
        
        campaign.status = 'SENDING';
        campaign.isSmartSend = true;
        campaign.smartSendConfig = config;
        await campaign.save();

        const FollowUpSequence = require('../models/FollowUpSequence');
        const AdLead = require('../models/AdLead');
        const moment = require('moment');

        let rows = [];
        fs.createReadStream(campaign.csvFile)
            .pipe(csv())
            .on('data', (d) => rows.push(d))
            .on('end', async () => {
                 let queuedCount = 0;
                 
                 for (let i = 0; i < rows.length; i++) {
                     const row = rows[i];
                     const phone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
                     if (!phone) continue;
                     
                     const tName = campaign.templateName || req.body.templateName;
                     if (!tName) continue;
                     
                     // Peak hour calculation logic
                     let optimalSendAt = moment().add(Math.floor(Math.random() * 60) + 15, 'minutes'); // default jitter
                     
                     try {
                         const lead = await AdLead.findOne({ phoneNumber: phone, clientId: req.user.clientId });
                         if (lead && lead.lastInteractionAt) {
                             const interactionHour = moment(lead.lastInteractionAt).hour();
                             // Try to target their previous interaction hour today or tomorrow
                             const targetToday = moment().set({ hour: interactionHour, minute: 0, second: 0 });
                             if (targetToday.isAfter(moment())) {
                                 optimalSendAt = targetToday;
                             } else {
                                 optimalSendAt = targetToday.add(1, 'day');
                             }
                         } else {
                             // E.g., assume timezone offset logic here (default to India 10 AM ~ 4 PM staggered)
                             // Fallback: stagger based on list index across the next 6 hours
                             optimalSendAt = moment().add((i % 360) + 10, 'minutes');
                         }
                     } catch(e) {}
                     
                     // Push to DB Queue via FollowUpSequence
                     const seq = new FollowUpSequence({
                         clientId: req.user.clientId,
                         leadId: null, // Lead might not exist yet
                         phone: phone,
                         name: `Smart Broadcast: ${campaign.name}`,
                         status: 'active',
                         steps: [{
                             type: 'whatsapp',
                             templateName: tName,
                             sendAt: optimalSendAt.toDate(),
                             status: 'pending'
                         }]
                     });
                     
                     await seq.save();
                     queuedCount++;
                 }
                 
                 campaign.audienceCount = rows.length;
                 campaign.status = 'COMPLETED'; // Marking the parsing as completed
                 await campaign.save();
                 log.success(`[SmartSend] FINISHED QUEUING ${campaignId} - Queued: ${queuedCount}`);
            });

        // Close request immediately with 200 OK
        res.json({ success: true, message: 'Smart Send is analyzing and queueing via DB Engine.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// @route   POST /api/campaigns/predictive-send
// @desc    Phase 28 - AI-timed delivery using CustomerIntelligence peak hour data
// @access  Private
router.post('/predictive-send', protect, async (req, res) => {
  try {
    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ success: false, message: 'campaignId required' });

    const campaign = await Campaign.findOne({ _id: campaignId, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const client = await Client.findOne({ clientId: req.user.clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Build phone list from CSV or Segment
    let rows = [];
    if (campaign.csvFile) {
      await new Promise((resolve, reject) => {
        fs.createReadStream(campaign.csvFile)
          .pipe(csv())
          .on('data', d => rows.push(d))
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (campaign.segmentId) {
      const Segment = require('../models/Segment');
      const segment = await Segment.findById(campaign.segmentId);
      if (segment) {
        const optQ = shouldRequireMarketingOptIn(campaign) ? mongoMarketingOptInOnly() : {};
        const leads = await AdLead.find({
          ...segment.query,
          clientId: req.user.clientId,
          ...optQ,
        }).lean();
        leads.forEach(l => rows.push({ phone: l.phoneNumber, name: l.name || 'Customer' }));
      }
    }

    const csvPredictiveFiltered = campaign.csvFile
      ? await filterAudienceForMarketingOptIn(req.user.clientId, rows, campaign)
      : null;
    if (csvPredictiveFiltered) {
      rows = csvPredictiveFiltered.rows;
      if (!rows.length) {
        return res.status(400).json({
          success: false,
          message:
            'No predictive recipients after removing opted-out contacts from this list.',
          marketingOptInExcluded: csvPredictiveFiltered.excluded,
        });
      }
    }

    if (rows.length === 0) return res.status(400).json({ success: false, message: 'No recipients found' });

    // Enrich with predictive send windows
    const { getOptimalSendTimes } = require('../utils/commerce/predictiveSend');
    const phones = rows.map(r => normalizePhone(r.phone || r.number || r.mobile || r.recipient || '')).filter(Boolean);
    const sendWindows = await getOptimalSendTimes(req.user.clientId, phones);
    const windowMap = {};
    sendWindows.forEach(w => { windowMap[w.phone] = w; });

    const FollowUpSequence = require('../models/FollowUpSequence');
    const { ensureLeadForSequence } = require('../utils/messaging/ensureLeadForSequence');
    let queued = 0;
    const tName = campaign.templateName;

    for (const row of rows) {
      const phone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      if (!phone || !tName) continue;

      const lead = await ensureLeadForSequence({
        clientId: req.user.clientId,
        phone,
        source: 'predictive_campaign',
      });

      const window = windowMap[phone];
      const sendAt = window?.sendAt || new Date();

      await FollowUpSequence.create({
        clientId: req.user.clientId,
        leadId: lead._id,
        phone: lead.phoneNumber,
        email: lead.email,
        name: `Predictive Broadcast: ${campaign.name}`,
        status: 'active',
        steps: [{
          type: 'whatsapp',
          templateName: tName,
          sendAt,
          status: 'pending',
          metadata: { reason: window?.reason, peakHour: window?.peakHour }
        }]
      });
      queued++;
    }

    campaign.status = 'SCHEDULED';
    campaign.isPredictiveSend = true;
    await campaign.save();

    log.info(`[PredictiveSend] Queued ${queued} messages for campaign ${campaignId}`);
    res.json({
      success: true,
      queued,
      message: `${queued} messages queued with AI-optimized send times.`,
      marketingOptInExcluded: csvPredictiveFiltered?.excluded || 0,
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
