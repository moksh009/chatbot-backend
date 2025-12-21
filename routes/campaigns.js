const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
const { protect } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const csv = require('csv-parser');

// @route   POST /api/campaigns
// @desc    Create a new campaign (upload CSV)
// @access  Private
router.post('/', protect, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    const campaign = await Campaign.create({
      clientId: req.user.clientId,
      name: req.body.name,
      templateName: req.body.templateName,
      status: 'DRAFT',
      csvFile: req.file.path
    });

    // Parse CSV to get audience count (async background process ideally)
    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        campaign.audienceCount = results.length;
        await campaign.save();
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

module.exports = router;
