"use strict";
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const CustomUsageTag = require('../models/CustomUsageTag');

/**
 * GET /api/tags/:clientId
 * Returns all custom usage tags for the client (for Flow Builder dropdowns)
 */
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const tags = await CustomUsageTag.find({ clientId }, 'name').sort({ name: 1 }).lean();
    const tagNames = tags.map(t => t.name);
    res.json({ success: true, tags: tagNames });
  } catch (err) {
    console.error('[GET /api/tags/:clientId]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch tags' });
  }
});

/**
 * POST /api/tags/:clientId
 * Creates a new tag (idempotent — returns existing if name already exists)
 */
router.post('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Tag name is required' });
    }
    const trimmedName = name.trim().substring(0, 50);
    const tag = await CustomUsageTag.findOneAndUpdate(
      { clientId, name: trimmedName },
      { clientId, name: trimmedName },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, tag: tag.name });
  } catch (err) {
    console.error('[POST /api/tags/:clientId]', err.message);
    res.status(500).json({ success: false, message: 'Failed to create tag' });
  }
});

module.exports = router;
