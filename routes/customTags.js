const express = require('express');
const router = express.Router();
const CustomUsageTag = require('../models/CustomUsageTag');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { apiCache } = require('../middleware/apiCache');
const {
  MAX_TAGS_PER_WORKSPACE,
  removeTagFromAllTemplates,
} = require('../utils/meta/templateUsageTags');

router.get('/', protect, apiCache(60), async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.query.clientId || tenantId;
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const tags = await CustomUsageTag.find({ clientId }).sort({ name: 1 }).lean();
    return res.json({
      success: true,
      tags,
      limit: MAX_TAGS_PER_WORKSPACE,
      count: tags.length,
    });
  } catch (err) {
    console.error('[custom-tags list]', err);
    return res.status(500).json({ error: 'Failed to list usage tags.' });
  }
});

router.post('/', protect, async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    const { clientId, name } = req.body || {};
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'Tag name is required.' });
    }
    if (trimmed.length > 50) {
      return res.status(400).json({ error: 'Tag name cannot exceed 50 characters.' });
    }
    const count = await CustomUsageTag.countDocuments({ clientId });
    if (count >= MAX_TAGS_PER_WORKSPACE) {
      return res.status(400).json({
        error: 'You have reached the maximum of 20 usage tags. Delete an unused tag to create a new one.',
      });
    }
    const existing = await CustomUsageTag.findOne({
      clientId,
      name: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    }).lean();
    if (existing) {
      return res.json({ success: true, tag: existing, existing: true });
    }
    const tag = await CustomUsageTag.create({ clientId, name: trimmed });
    return res.status(201).json({ success: true, tag });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A tag with this name already exists.' });
    }
    console.error('[custom-tags create]', err);
    return res.status(500).json({ error: 'Failed to create usage tag.' });
  }
});

router.delete('/:id', protect, async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.query.clientId || tenantId;
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const tag = await CustomUsageTag.findOne({ _id: req.params.id, clientId });
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found.' });
    }
    await removeTagFromAllTemplates(clientId, tag.name);
    await CustomUsageTag.deleteOne({ _id: tag._id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[custom-tags delete]', err);
    return res.status(500).json({ error: 'Failed to delete usage tag.' });
  }
});

module.exports = router;
