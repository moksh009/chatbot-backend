"use strict";

const express = require('express');
const router = express.Router();
const InstagramAutomation = require('../models/InstagramAutomation');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const axios = require('axios');

// GET all automations for a client
router.get('/:clientId', protect, async (req, res) => {
  try {
    const automations = await InstagramAutomation.find({ clientId: req.params.clientId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, automations });
  } catch (error) {
    console.error('[IG Auto] Fetch Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch automations' });
  }
});

// POST new automation
router.post('/:clientId', protect, async (req, res) => {
  try {
    const { name, trigger, actions, isActive } = req.body;
    const newAuto = new InstagramAutomation({
      clientId: req.params.clientId,
      name: name || 'New Automation',
      trigger,
      actions,
      isActive: isActive !== undefined ? isActive : false,
      status: isActive ? 'live' : 'draft',
      stats: { totalSends: 0, uniqueSends: 0, linkClicks: 0, buttonClicks: 0 }
    });
    
    await newAuto.save();
    res.status(201).json({ success: true, automation: newAuto });
  } catch (error) {
    console.error('[IG Auto] Create Error:', error);
    res.status(500).json({ success: false, error: 'Failed to create automation' });
  }
});

// PUT update automation
router.put('/:clientId/:autoId', protect, async (req, res) => {
  try {
    const { name, trigger, actions, isActive } = req.body;
    const updateData = { name, trigger, actions, updatedAt: new Date() };
    if (isActive !== undefined) {
      updateData.isActive = isActive;
      updateData.status = isActive ? 'live' : 'draft';
    }

    const updated = await InstagramAutomation.findByIdAndUpdate(
      req.params.autoId,
      { $set: updateData },
      { new: true }
    );
    res.status(200).json({ success: true, automation: updated });
  } catch (error) {
    console.error('[IG Auto] Update Error:', error);
    res.status(500).json({ success: false, error: 'Failed to update automation' });
  }
});

// DELETE automation
router.delete('/:clientId/:autoId', protect, async (req, res) => {
  try {
    await InstagramAutomation.findByIdAndDelete(req.params.autoId);
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    console.error('[IG Auto] Delete Error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete automation' });
  }
});

// POST toggle active status
router.post('/:clientId/:autoId/toggle', protect, async (req, res) => {
  try {
    const auto = await InstagramAutomation.findById(req.params.autoId);
    if (!auto) return res.status(404).json({ success: false, error: 'Not found' });
    
    auto.isActive = !auto.isActive;
    auto.status = auto.isActive ? 'live' : 'paused';
    await auto.save();
    res.status(200).json({ success: true, automation: auto });
  } catch (error) {
    console.error('[IG Auto] Toggle Error:', error);
    res.status(500).json({ success: false, error: 'Failed to toggle status' });
  }
});

// GET user's IG posts/reels from Meta API
router.get('/:clientId/posts/fetch', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client || !client.instagramAccessToken || !client.instagramAccountId) {
      return res.status(400).json({ success: false, error: 'Instagram not properly connected.' });
    }

    // Fetch media from Instagram Graph API
    const url = \`https://graph.facebook.com/v21.0/\${client.instagramAccountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count&access_token=\${client.instagramAccessToken}&limit=24\`;
    
    const response = await axios.get(url);
    if (response.data && response.data.data) {
      res.status(200).json({ success: true, posts: response.data.data });
    } else {
      res.status(200).json({ success: true, posts: [] });
    }
  } catch (error) {
    console.error('[IG Fetch Posts] Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch Instagram posts from Meta API' });
  }
});

module.exports = router;
