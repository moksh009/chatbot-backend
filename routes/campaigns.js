const express = require('express');
const mongoose = require('mongoose');
const { resolveClient, tenantClientId } = require('../utils/queryHelpers');
const router = express.Router();
const TaskQueueService = require('../services/TaskQueueService');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const csv = require('csv-parser');
const Client = require('../models/Client');
const { sendBirthdayWishWithImage } = require('../utils/sendBirthdayMessage');
const { sendAppointmentReminder } = require('../utils/sendAppointmentReminder');
const DailyStat = require('../models/DailyStat');
const WhatsApp = require('../utils/whatsapp');
const { createMessage } = require('../utils/createMessage');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const log = require('../utils/logger')('Campaigns');
const { incrementStat } = require('../utils/statCacheEngine');
const { resolveImportBatchObjectId } = require('../utils/importBatchResolver');
const {
  filterAudienceForMarketingOptIn,
  filterAudienceByOptStatus,
  mongoMarketingOptInOnly,
  mongoNotOptedOut,
  shouldRequireMarketingOptIn,
  canSendToContact,
  evaluateAudiencePolicySummary,
} = require('../utils/marketingConsent');
const { validateTemplateEligibility } = require('../utils/templateEligibility');

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
      if (phone) {
        audience.push({
           phone,
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

        await incrementUsage(client._id, 'campaigns', 1);

        const campaign = await Campaign.create({
            clientId: req.user.clientId,
            name: name || `Hot Leads Targeting`,
            status: 'DRAFT',
            audienceCount: count || 0,
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
    skipMarketingOptInFilter: req.body.skipMarketingOptInFilter === true,
  };

  const finalLeadIds = leadIds || (leadId ? [leadId] : []);

  if (finalLeadIds.length === 0 || !templateName) {
    return res.status(400).json({ success: false, message: 'leadIds and templateName are required' });
  }

  if (finalLeadIds.length > 250) {
    return res.status(400).json({ success: false, message: 'Maximum 250 recipients allowed for quick broadcast' });
  }

  try {
    const client = await Client.findOne({ clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const template = (client.syncedMetaTemplates || []).find((t) => t?.name === templateName);
    const preflight = validateTemplateEligibility({
      template,
      contextPurpose: 'campaign',
      strict: strictValidation !== false
    });
    if (!preflight.ok) {
      log.warn('[QuickSend][TemplatePreflightFailed]', {
        clientId,
        templateName,
        contextPurpose: 'campaign',
        missingVariables: preflight.missingVariables,
        requiredVariableCount: preflight.requiredVariableCount,
        reasons: preflight.reasons
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

    const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');

    let successCount = 0;
    let failCount = 0;
    let skippedOptIn = 0;

    // Process with small stagger to avoid burst limits
    for (const lead of leads) {
      const eligibility = await canSendToContact(clientId, lead, quickCampaign.templateCategory);
      if (!eligibility.canSend) {
        skippedOptIn++;
        continue;
      }
      try {
        await sendWhatsAppTemplate({
          phoneNumberId: client.phoneNumberId,
          to: lead.phoneNumber,
          templateName,
          languageCode: 'en',
          components: [],
          token: client.whatsappToken,
          clientId: client.clientId
        });

        // Update Lead activity log
        await AdLead.findByIdAndUpdate(lead._id, {
          $push: {
            activityLog: {
              action: 'quick_message_sent',
              details: `Sent template: ${templateName}`,
              timestamp: new Date()
            }
          }
        });
        successCount++;
      } catch (err) {
        log.error(`[QuickSend] Failed for ${lead.phoneNumber}:`, err.message);
        failCount++;
      }
      
      // Stagger
      if (finalLeadIds.length > 1) {
        await new Promise(r => setTimeout(r, 200)); 
      }
    }

    // Enterprise Fix: Update StatCache atomically
    await incrementStat(clientId, { totalConversations: successCount });

    res.json({ 
      success: true, 
      message: `Broadcast complete. Success: ${successCount}, Failed: ${failCount}${skippedOptIn ? `, Skipped (not opted_in): ${skippedOptIn}` : ''}`,
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
      if (!acc[cId]) acc[cId] = { sent: 0, delivered: 0, read: 0, replied: 0 };
      
      const status = curr._id.status;
      if (status === 'sent') acc[cId].sent += curr.count;
      if (status === 'delivered') acc[cId].delivered += curr.count;
      if (status === 'read') acc[cId].read += curr.count;
      if (status === 'replied') acc[cId].replied += curr.count;
      
      return acc;
    }, {});

    const enrichedCampaigns = campaigns.map(c => {
      const stats = statsMap[c._id.toString()] || { sent: 0, delivered: 0, read: 0, replied: 0 };
      // Note: Delivered should include Read and Replied for funnel logic
      const totalDelivered = stats.delivered + stats.read + stats.replied;
      const totalRead = stats.read + stats.replied;
      const totalSent = stats.sent + totalDelivered;
      
      return {
        ...c,
        sentCount: totalSent,
        deliveredCount: totalDelivered,
        readCount: totalRead,
        repliedCount: stats.replied,
        stats: {
          sent: totalSent,
          delivered: totalDelivered,
          read: totalRead,
          replied: stats.replied
        }
      };
    });

    res.json(enrichedCampaigns);
  } catch (error) {
    console.error('[Campaigns] List error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   POST /api/campaigns/start
// @desc    Start a CSV campaign and send messages
// @access  Private
router.post('/start', protect, async (req, res) => {
  const { campaignId, templateType } = req.body;
  if (!campaignId || !templateType) {
    return res.status(400).json({ message: 'campaignId and templateType are required' });
  }
  try {
    const campaign = await Campaign.findOne({ _id: campaignId, clientId: req.user.clientId });
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    
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
        actualTemplateName = client.config?.templates?.appointment || 'appointment_reminder_1';
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
    campaign.skipMarketingOptInFilter = req.body.skipMarketingOptInFilter === true;
    const marketingOptQ = shouldRequireMarketingOptIn(campaign)
      ? mongoMarketingOptInOnly()
      : mongoNotOptedOut();
    
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
                campaign.audience = leads.map(l => ({ phone: l.phoneNumber, name: l.name || '', ...l }));
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
                campaign.audience = leads.map(l => ({ phone: l.phoneNumber, name: l.name || '', ...l }));
        }
        campaign.audienceCount = campaign.audience.length;
    }

    // Drop rows missing a phone number — they cannot receive a WhatsApp template.
    // (Without this filter the cron will still log a noisy "Invalid phone" failure
    // for every empty row, and audienceCount drifts away from real reach.)
    const rawAudience = campaign.audience || [];
    const filteredAudience = rawAudience.filter(row => {
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
        message:
          'No WhatsApp marketing–eligible contacts (opt_status must be opted_in). Collect opt-in via your website embed or chats, widen your segment, or use the advanced override only if you have provable consent.',
      });
    }

    // Validate the chosen template is actually APPROVED on Meta — otherwise every
    // send will be rejected by the Meta API and the user just sees "FAILED".
    const candidateTemplateName = req.body.templateName || actualTemplateName || campaign.templateName;
    if (candidateTemplateName) {
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
        
        // ENTERPRISE 10/10/80 SPLIT LOGIC
        const testSizePct = 20; // 10% for A, 10% for B
        const holdbackSizePct = 80;
        
        campaign.abTestConfig = { 
          testSizePercentage: testSizePct, 
          winnerMetric: req.body.abTestConfig?.winnerMetric || 'reply_rate', 
          holdbackHours: req.body.abTestConfig?.holdbackHours || 2, 
          autoSendWinner: true, 
          holdbackProcessed: false 
        };

        campaign.abVariants = [
          { label: 'A', templateName: req.body.templateName || campaign.templateName, recipientCount: Math.floor(rows.length * 0.1) },
          { label: 'B', templateName: req.body.templateTypeB, recipientCount: Math.floor(rows.length * 0.1) }
        ];

        // Set evaluation time
        campaign.scheduledAt = new Date(Date.now() + (campaign.abTestConfig.holdbackHours * 60 * 60 * 1000));
        
        await campaign.save();
     }

    await campaign.save();

    const extra =
      optFiltered.excluded > 0
        ? ` (${optFiltered.excluded} skipped — not WhatsApp opted_in)`
        : '';
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
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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


// @route   GET /api/campaigns/:clientId/overview
// @desc    Get aggregate campaign metrics and Meta health
// @access  Private
router.get('/:clientId/overview', protect, async (req, res) => {
  try {
    const { client } = await resolveClient(req);
    const clientId = client.clientId;
    const campaigns = await Campaign.find({ clientId }).sort({ createdAt: -1 }).lean();
    const CampaignMessage = require('../models/CampaignMessage');

    // Aggregate stats from CampaignMessage for ground-truth data
    const statsArray = await CampaignMessage.aggregate([
      { $match: { clientId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]);

    const statsMap = statsArray.reduce((acc, curr) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    const totalDelivered = (statsMap['delivered'] || 0) + (statsMap['read'] || 0) + (statsMap['replied'] || 0);
    const totalSent = (statsMap['sent'] || 0) + totalDelivered;
    const totalRead = (statsMap['read'] || 0) + (statsMap['replied'] || 0);
    const totalReplied = statsMap['replied'] || 0;

    const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;
    const readRate = totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : 0;
    const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

    // Meta Health (Real Integration with Cloud API)
    let metaHealth = {
      status: 'HEALTHY',
      tier: 'Tier 1 (1k/day)',
      qualityRating: 'GREEN',
      lastTemplateUpdate: new Date()
    };

    try {
      const client = await Client.findOne({ clientId }).select('_id plan subscriptionPlan whatsappToken phoneNumberId wabaId metaAdAccountId metaAdsToken role').lean();
      if (client?.whatsappToken && (client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID)) {
        const [acc, qual] = await Promise.all([
          WhatsApp.getAccountStatus(client),
          WhatsApp.getPhoneNumberQuality(client)
        ]);
        metaHealth = {
          status: acc.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : (qual.status || 'HEALTHY'),
          tier: qual.tier || 'Tier 1 (1k/day)',
          qualityRating: qual.qualityRating || 'GREEN',
          lastTemplateUpdate: new Date()
        };
      }
    } catch (healthErr) {
      console.warn(`[Campaigns] Could not fetch Meta health for ${clientId}:`, healthErr.message);
    }

    res.json({
      success: true,
      stats: {
        totalSent,
        totalDelivered,
        totalRead,
        totalReplied,
        deliveryRate,
        readRate,
        replyRate
      },
      metaHealth,
      recentCampaigns: campaigns.slice(0, 10)

    });
  } catch (error) {
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
            'No predictive recipients after WhatsApp marketing opt-in filter. Collect opted_in contacts via your storefront embed or chat, upload a list with documented consent, or use the compliance override only when legally appropriate.',
          marketingOptInExcluded: csvPredictiveFiltered.excluded,
        });
      }
    }

    if (rows.length === 0) return res.status(400).json({ success: false, message: 'No recipients found' });

    // Enrich with predictive send windows
    const { getOptimalSendTimes } = require('../utils/predictiveSend');
    const phones = rows.map(r => normalizePhone(r.phone || r.number || r.mobile || r.recipient || '')).filter(Boolean);
    const sendWindows = await getOptimalSendTimes(req.user.clientId, phones);
    const windowMap = {};
    sendWindows.forEach(w => { windowMap[w.phone] = w; });

    const FollowUpSequence = require('../models/FollowUpSequence');
    let queued = 0;
    const tName = campaign.templateName;

    for (const row of rows) {
      const phone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      if (!phone || !tName) continue;

      const window = windowMap[phone];
      const sendAt = window?.sendAt || new Date();

      await FollowUpSequence.create({
        clientId: req.user.clientId,
        phone,
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

// @route   GET /api/campaigns/templates
// @desc    Get synced Meta templates for the client
// @access  Private
router.get('/templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const contextPurpose = String(req.query.contextPurpose || 'campaign').toLowerCase();
    const approvedTemplates = (client.syncedMetaTemplates || []).filter((t) => {
      const statusOk = String(t?.status || '').toUpperCase() === 'APPROVED';
      if (!statusOk) return false;
      const primary = String(t?.primaryPurpose || 'utility').toLowerCase();
      const secondary = Array.isArray(t?.secondaryPurposes)
        ? t.secondaryPurposes.map((p) => String(p || '').toLowerCase())
        : [];
      return primary === contextPurpose || secondary.includes(contextPurpose) || primary === 'utility';
    });
    res.json({ success: true, templates: approvedTemplates });
  } catch (err) {
    console.error('[CampaignTemplates] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
});

// @route   GET /api/campaigns/audience-estimate
// @desc    Get estimated reach for a segment or source
router.get('/audience-estimate', protect, async (req, res) => {
    const { source, segmentId, importBatchId } = req.query;
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
            // Frontend may pass ImportSession.batchId (BATCH_*) OR ImportSession._id.
            // Resolve to the actual ObjectId before querying AdLead — otherwise
            // Mongoose throws CastError and the whole request 500s.
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
        }

        res.json({ success: true, count });
    } catch (err) {
        console.error('[AudienceEstimate] Error:', err);
        // Don't crash the campaign builder UI just because the count failed —
        // return zero so the frontend can still render and the user can retry.
        res.json({ success: true, count: 0, warning: 'estimate_failed' });
    }
});

// @route   GET /api/campaigns/audience-preview
// @desc    Compliance preview for selected audience + template category
router.get('/audience-preview', protect, async (req, res) => {
  try {
    const cid = req.user.clientId;
    const { segmentId, importBatchId, templateCategory = 'MARKETING' } = req.query;
    let leads = [];

    if (segmentId) {
      const segment = await Segment.findOne({ _id: segmentId, clientId: cid }).lean();
      if (!segment) return res.status(404).json({ success: false, message: 'Segment not found' });
      leads = await AdLead.find({ clientId: cid, ...segment.query })
        .select('optStatus optInSource')
        .lean();
    } else if (importBatchId) {
      const resolved = await resolveImportBatchObjectId(importBatchId, cid);
      if (!resolved) return res.status(404).json({ success: false, message: 'Import batch not found' });
      leads = await AdLead.find({ clientId: cid, importBatchId: resolved })
        .select('optStatus optInSource')
        .lean();
    } else {
      leads = await AdLead.find({ clientId: cid }).select('optStatus optInSource').lean();
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

module.exports = router;
