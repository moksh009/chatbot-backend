const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
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
    // Check subscription plan (using new 'plan' field, fallback to subscriptionPlan for legacy)
    const client = await Client.findOne({ clientId: req.user.clientId });
    const isV1 = client?.plan === 'CX Agent (V1)' || client?.subscriptionPlan === 'v1';
    if (!client || isV1) {
      // Clean up uploaded file
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(403).json({ message: 'Marketing Broadcasting (CSV Upload) is locked for CX Agent (V1). Please upgrade to V2.' });
    }

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

// @route   GET /api/campaigns
// @desc    List campaigns
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ clientId: req.user.clientId }).sort({ createdAt: -1 });
    res.json(campaigns);
  } catch (error) {
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
    if (!campaign.csvFile) return res.status(400).json({ message: 'No CSV file attached to campaign' });
    log.info(`Campaign START: campaignId=${campaignId} | clientId=${req.user.clientId} | templateType=${templateType}`);
    campaign.status = 'SENDING';
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

    await new Promise((resolve, reject) => {
      fs.createReadStream(campaign.csvFile)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    total = rows.length;
    for (const row of rows) {
      const recipientPhone = normalizePhone(row.phone || row.number || row.mobile || row.recipient || '');
      if (!recipientPhone) { failed++; continue; }
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
          const components = req.body.templateComponents || [];
          
          // Auto-inject default header image if required and missing
          if (components.length === 0) {
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
          
          const respData = await WhatsApp.sendTemplate(client, recipientPhone, tName, req.body.languageCode || 'en', components);
          const metaMsgId = respData?.messages?.[0]?.id;

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
          sent++;
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

module.exports = router;
