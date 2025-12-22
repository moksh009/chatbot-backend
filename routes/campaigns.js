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

try {
  fs.mkdirSync('uploads', { recursive: true });
} catch {}

// @route   POST /api/campaigns
// @desc    Create a new campaign (upload CSV)
// @access  Private
router.post('/', protect, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });
    const validCount = rows.reduce((acc, row) => {
      const phone = (row.phone || row.number || row.mobile || row.recipient || '').toString().trim();
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
    campaign.status = 'SENDING';
    await campaign.save();

    const client = await Client.findOne({ clientId: req.user.clientId });
    const phoneNumberId = req.body.phoneNumberId || client?.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
    const accessToken = req.body.accessToken || process.env.WHATSAPP_TOKEN;
    if (!phoneNumberId || !accessToken) {
      return res.status(500).json({ message: 'Messaging credentials not configured' });
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
      const recipientPhone = row.phone || row.number || row.mobile || row.recipient || '';
      if (!recipientPhone) {
        failed++;
        continue;
      }
      try {
        if (templateType === 'birthday') {
          const resp = await sendBirthdayWishWithImage(recipientPhone, accessToken, phoneNumberId);
          if (resp?.success) {
            sent++;
            const dateStr = new Date().toISOString().split('T')[0];
            await DailyStat.updateOne(
              { clientId: req.user.clientId, date: dateStr },
              { $inc: { birthdayRemindersSent: 1 }, $setOnInsert: { clientId: req.user.clientId, date: dateStr } },
              { upsert: true }
            );
          } else {
            failed++;
          }
        } else if (templateType === 'appointment') {
          const appointmentDetails = {
            summary: row.summary || `Appointment: ${row.name || 'Patient'} - Service`,
            doctor: row.doctor || '',
            date: row.date || '',
            time: row.time || ''
          };
          await sendAppointmentReminder(phoneNumberId, accessToken, recipientPhone, appointmentDetails);
          sent++;
          const dateStr = new Date().toISOString().split('T')[0];
          await DailyStat.updateOne(
            { clientId: req.user.clientId, date: dateStr },
            { $inc: { appointmentRemindersSent: 1 }, $setOnInsert: { clientId: req.user.clientId, date: dateStr } },
            { upsert: true }
          );
        } else {
          failed++;
        }
        await new Promise(r => setTimeout(r, 500));
      } catch {
        failed++;
      }
    }

    campaign.stats.sent = (campaign.stats.sent || 0) + sent;
    campaign.audienceCount = total;
    campaign.status = 'COMPLETED';
    await campaign.save();

    res.json({ success: true, campaignId, total, sent, failed, status: campaign.status });
  } catch (error) {
    try {
      await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'FAILED' } });
    } catch {}
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

module.exports = router;
