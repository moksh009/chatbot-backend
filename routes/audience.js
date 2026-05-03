const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const ImportSession = require('../models/ImportSession');
const { tenantClientId } = require('../utils/queryHelpers');

// @route   GET /api/audience/import-batches
// @desc    Get all completed import batches for a client
// @access  Private
router.get('/import-batches', protect, async (req, res) => {
  try {
    const cid = tenantClientId(req);
    if (!cid) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const batches = await ImportSession.find({ 
      clientId: cid, 
      status: 'completed' 
    })
    .sort({ createdAt: -1 })
    .select('batchName batchId filename successCount newPhones createdAt status')
    .lean();

    // Map to expected frontend format
    const formattedBatches = batches.map(b => ({
      _id: b._id,
      batchId: b.batchId,
      batchName: b.batchName || b.filename,
      filename: b.filename,
      successCount: b.successCount,
      newCount: b.newPhones ? b.newPhones.length : 0,
      createdAt: b.createdAt
    }));

    res.json({ success: true, batches: formattedBatches });
  } catch (err) {
    console.error('[Audience] Fetch import batches error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch import batches' });
  }
});

module.exports = router;
