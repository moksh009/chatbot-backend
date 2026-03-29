const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

// Get all notifications for a client
router.get('/', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ success: false, message: "clientId required" });
    
    const notifications = await Notification.find({ clientId }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, notifications });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mark a notification as read
router.patch('/:id/read', async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { status: 'read' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mark all as read
router.post('/read-all', async (req, res) => {
  try {
    const { clientId } = req.body;
    await Notification.updateMany({ clientId, status: 'unread' }, { status: 'read' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete a notification
router.delete('/:id', async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Clear all notifications for a client
router.post('/clear-all', async (req, res) => {
  try {
    const { clientId } = req.body;
    await Notification.deleteMany({ clientId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
