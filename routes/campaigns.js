const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
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

try {
  fs.mkdirSync('uploads', { recursive: true });
} catch {}

function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/[^\d]/g, '');
  if (!digits) return '';
  const cc = process.env.DEFAULT_COUNTRY_CODE || '91';
  if (digits.length === 10) return cc + digits;
  return digits;
}

// @route   POST /api/campaigns
// @desc    Create a new campaign (upload CSV)
// @access  Private
router.post('/', protect, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    // Check subscription plan (using new validation limits)
    const client = await Client.findOne({ clientId: req.user.clientId });
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

    const validCount = rows.reduce((acc, row) => {
      const phone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      return phone ? acc + 1 : acc;
    }, 0);

    const campaign = await Campaign.create({
      clientId: req.user.clientId,
      name: req.body.name,
      templateName: req.body.templateName,
      status: 'DRAFT',
      csvFile: req.file.path,
      audienceCount: validCount
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
        const client = await Client.findOne({ clientId: req.user.clientId });

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
        const count = await AdLead.countDocuments({ importBatchId, clientId: req.user.clientId });
        const client = await Client.findOne({ clientId: req.user.clientId });

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
            importBatchId: importBatchId
        });

        res.json(campaign);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create campaign from imported list' });
    }
});

// @route   POST /api/campaigns/from-hot-leads
// @desc    Create a campaign from a list of hot leads
// @access  Private
router.post('/from-hot-leads', protect, async (req, res) => {
    const { name, count } = req.body;
    try {
        const client = await Client.findOne({ clientId: req.user.clientId });
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
      
      return {
        ...c,
        sentCount: stats.sent,
        deliveredCount: totalDelivered,
        readCount: totalRead,
        repliedCount: stats.replied,
        stats: {
          sent: stats.sent,
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
    
    // Support CSV, Segment, and Imported List campaigns
    if (!campaign.csvFile && !campaign.segmentId && !campaign.importBatchId) {
        return res.status(400).json({ message: 'No audience (CSV, Segment, or Imported List) attached to campaign' });
    }

    log.info(`Campaign START: campaignId=${campaignId} | clientId=${req.user.clientId} | templateType=${templateType}`);
    campaign.status = req.body.scheduledDate ? 'SCHEDULED' : 'SENDING';
    if (req.body.scheduledDate) {
        campaign.scheduledAt = new Date(req.body.scheduledDate);
    }
    await campaign.save();

    // Fetch client configuration
    const client = await Client.findOne({ clientId: req.user.clientId });
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
    const rows = [];

    // --- Audience Sourcing (CSV, Segment, or Imported List) ---
    if (campaign.segmentId || campaign.importBatchId) {
        let count = 0;
        if (campaign.segmentId) {
            const segment = await Segment.findById(campaign.segmentId);
            if (segment) count = await AdLead.countDocuments({ ...segment.query, clientId: req.user.clientId });
        } else {
            count = await AdLead.countDocuments({ importBatchId: campaign.importBatchId, clientId: req.user.clientId });
        }
        
        let delayMs = 0;
        if (req.body.scheduledDate) {
            delayMs = new Date(req.body.scheduledDate).getTime() - Date.now();
            if (delayMs < 0) delayMs = 0;
        }

        // Dispatch to background worker for Mongoose cursor streaming
        await TaskQueueService.addTask('BROADCAST_CAMPAIGN', {
            campaignId: campaign._id,
            clientId: req.user.clientId,
            templateType,
            templateName: req.body.templateName,
            templateComponents: req.body.templateComponents,
            variableMapping: req.body.variableMapping,
            languageCode: req.body.languageCode,
            isAbTest: req.body.isAbTest,
            abTestConfig: req.body.abTestConfig,
            templateTypeB: req.body.templateTypeB
        }, { delay: delayMs });
        
        return res.json({ success: true, message: `Campaign targeting ${count} contacts queued for background processing.` });
    } else if (campaign.csvFile) {
        await new Promise((resolve, reject) => {
            fs.createReadStream(campaign.csvFile)
                .pipe(csv())
                .on('data', (data) => rows.push(data))
                .on('end', resolve)
                .on('error', reject);
        });
    }

    // Shuffle rows for random AB distribution
    for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
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
        
        const groupASize = Math.floor(rows.length * 0.1);
        const groupBSize = Math.floor(rows.length * 0.1);
        
        abTestVariantSize = groupASize; // Used in logic below
        abTestVariantBSize = groupASize + groupBSize; 
     }

    let currentIndex = 0;
    for (const row of rows) {
      currentIndex++;
      const recipientPhone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      if (!recipientPhone) { failed++; continue; }
      
      let variantLabel = null;
      let targetTemplateName = req.body.templateName || campaign.templateName;
      let isHoldout = false;
      
      if (req.body.isAbTest) {
        if (currentIndex <= abTestVariantSize) {
          variantLabel = 'A';
        } else if (currentIndex <= abTestVariantBSize) {
          variantLabel = 'B';
          targetTemplateName = req.body.templateTypeB;
        } else {
          isHoldout = true;
          variantLabel = 'holdout';
        }
      }

      if (isHoldout) {
        // Queue for later
        await CampaignMessage.create({
          campaignId: campaign._id,
          clientId: client.clientId,
          phone: recipientPhone,
          status: 'queued',
          abVariantLabel: 'holdout',
          metadata: row // Store full row for variable injection later
        });
        continue;
      }
      try {
        if (templateType === 'birthday') {
          const resp = await sendBirthdayWishWithImage(recipientPhone, null, null, req.user.clientId, actualTemplateName);
          if (resp?.success) sent++; else failed++;
        } else if (templateType === 'appointment') {
          const appointmentDetails = {
            summary: row.summary || `Appointment: ${row.name || 'Patient'} - Service`,
            doctor: row.doctor || row.stylist || row.therapist || row.coach || '',
            date: row.date || '',
            time: row.time || ''
          };
          await sendAppointmentReminder(null, null, recipientPhone, appointmentDetails, req.user.clientId, actualTemplateName);
          sent++;
        } else if (templateType === 'whatsapp') {
          const tName = req.body.templateName || campaign.templateName;
          if (!tName) { failed++; continue; }
          const components = req.body.templateComponents ? JSON.parse(JSON.stringify(req.body.templateComponents)) : [];
          
          if (req.body.variableMapping && Object.keys(req.body.variableMapping).length > 0) {
              const bodyParams = [];
              const sortedKeys = Object.keys(req.body.variableMapping).sort((a,b) => parseInt(a) - parseInt(b));
              
              sortedKeys.forEach(k => {
                  const dataField = req.body.variableMapping[k];
                  let val = row[dataField] || row.capturedData?.[dataField] || '';
                  if (dataField === 'name') val = row.name || 'Customer';
                  bodyParams.push({ type: 'text', text: String(val) });
              });

              if (bodyParams.length > 0) {
                  const existingBodyIndex = components.findIndex(c => c.type === 'body');
                  if (existingBodyIndex !== -1) {
                      components[existingBodyIndex].parameters = bodyParams;
                  } else {
                      components.push({ type: 'body', parameters: bodyParams });
                  }
              }
          }

          // Auto-inject default header image if required and missing
          if (components.length === 0 && (!req.body.variableMapping || Object.keys(req.body.variableMapping).length === 0)) {
              const tplDef = (client.syncedMetaTemplates || []).find(t => t.name === tName);
              if (tplDef) {
                  const headerComp = tplDef.components?.find(c => c.type === 'HEADER' && c.format === 'IMAGE');
                  if (headerComp) {
                      const imgUrl = headerComp.example?.header_handle?.[0] || 'https://images.unsplash.com/photo-1577563908411-5077b6dc7624?q=80&w=2070&auto=format&fit=crop';
                      components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imgUrl } }] });
                  }
                  // Inject name variable if required
                  const bodyComp = tplDef.components?.find(c => c.type === 'BODY');
                  if (bodyComp?.text?.includes('{{1}}')) {
                    components.push({ type: 'body', parameters: [{ type: 'text', text: row.name || 'Customer' }] });
                  }
              }
          }
          
          const respData = await WhatsApp.sendTemplate(client, recipientPhone, targetTemplateName, req.body.languageCode || 'en', components);
          const metaMsgId = respData?.messages?.[0]?.id || respData?.id;

          if (metaMsgId) {
            await CampaignMessage.create({
              campaignId: campaign._id,
              clientId: client.clientId,
              phone: recipientPhone,
              messageId: metaMsgId,
              status: 'sent',
              sentAt: new Date(),
              abVariantLabel: variantLabel
            });
            sent++;
            
            const incQuery = { sentCount: 1 };
            if (variantLabel) incQuery[`abVariants.$[variant].sentCount`] = 1;
            
            await Campaign.findByIdAndUpdate(campaign._id, { $inc: incQuery }, variantLabel ? { arrayFilters: [{ 'variant.label': variantLabel }] } : {});
          } else {
            failed++;
            await Campaign.findByIdAndUpdate(campaign._id, { $inc: { failedCount: 1 } });
          }

          const Message = require('../models/Message');
          await Message.create({
            clientId: client.clientId,
            from: client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID,
            to: recipientPhone,
            direction: 'outgoing',
            type: 'template',
            content: `[Campaign: ${campaign.name}] Template: ${tName}`,
            messageId: metaMsgId,
            status: 'sent',
            campaignId: campaign._id,
            channel: 'whatsapp'
          });
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        failed++;
      }
    }

    campaign.stats.sent = (campaign.stats.sent || 0) + sent;
    campaign.audienceCount = total;
    campaign.status = 'COMPLETED';
    await campaign.save();

    log.success(`Campaign DONE: ${campaignId} | sent=${sent} failed=${failed} total=${total}`);
    res.json({ success: true, campaignId, total, sent, failed, status: campaign.status });
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
    const campaigns = await Campaign.find({ clientId }).sort({ createdAt: -1 });
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

    const totalSent = statsMap['sent'] || 0;
    const totalDelivered = (statsMap['delivered'] || 0) + (statsMap['read'] || 0) + (statsMap['replied'] || 0);
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
      const client = await Client.findOne({ clientId });
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

    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Build phone list from CSV or Segment
    const rows = [];
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
        const leads = await AdLead.find({ ...segment.query, clientId: req.user.clientId });
        leads.forEach(l => rows.push({ phone: l.phoneNumber, name: l.name || 'Customer' }));
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
    res.json({ success: true, queued, message: `${queued} messages queued with AI-optimized send times.` });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   GET /api/campaigns/templates
// @desc    Get synced Meta templates for the client
// @access  Private
router.get('/templates', protect, async (req, res) => {
  try {
    const clientId = req.query.clientId || req.user.clientId;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId }).select('syncedMetaTemplates').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const approvedTemplates = (client.syncedMetaTemplates || []).filter(t => t.status === 'APPROVED');
    res.json({ success: true, templates: approvedTemplates });
  } catch (err) {
    console.error('[CampaignTemplates] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
});

// @route   GET /api/campaigns/audience-estimate
// @desc    Get audience size estimate based on source/segment
// @access  Private
router.get('/audience-estimate', protect, async (req, res) => {
  try {
    const { clientId, source, segmentId, importBatchId } = req.query;
    const cid = clientId || req.user.clientId;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== cid) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    let count = 0;
    if (source === 'all') {
      count = await AdLead.countDocuments({ clientId: cid });
    } else if (source === 'segment' && segmentId) {
      const segment = await Segment.findOne({ _id: segmentId, clientId: cid });
      if (segment) {
        count = await AdLead.countDocuments({ clientId: cid, ...segment.query });
      }
    } else if (source === 'imported' && importBatchId) {
        count = await AdLead.countDocuments({ clientId: cid, importBatchId });
    } else if (source === 'high_intent') {
        count = await AdLead.countDocuments({ clientId: cid, leadScore: { $gt: 70 } });
    }

    res.json({ success: true, count });
  } catch (err) {
    console.error('[AudienceEstimate] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch estimate' });
  }
});

module.exports = router;
