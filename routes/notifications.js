const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

// Get all notifications for a client
router.get('/', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const notifications = await Notification.find({ clientId }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, notifications });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create a new notification (Manual or System)
// This endpoint allows internal/authorized creation and triggers a broadcast
router.post('/', protect, async (req, res) => {
    try {
        const { title, message, type, metadata } = req.body;
        const clientId = req.user.clientId;

        if (!title || !message) {
            return res.status(400).json({ success: false, message: "Title and message are required" });
        }

        const notification = await Notification.create({
            clientId,
            title,
            message,
            type: type || 'system',
            metadata: metadata || {}
        });

        // Broadcast to specific client room
        const io = req.app.get('socketio');
        if (io) {
            io.to(`client_${clientId}`).emit('new_notification', notification);
            console.log(`[Notification] Broadcasted to client_${clientId}:`, title);
        }

        res.status(201).json({ success: true, notification });
    } catch (err) {
        console.error('[Notification] Create error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Mark a notification as read
router.patch('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
        { _id: req.params.id, clientId: req.user.clientId }, 
        { status: 'read' },
        { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mark all as read
router.post('/read-all', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    await Notification.updateMany({ clientId, status: 'unread' }, { status: 'read' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete a notification
router.delete('/:id', protect, async (req, res) => {
  try {
    const deleted = await Notification.findOneAndDelete({ _id: req.params.id, clientId: req.user.clientId });
    if (!deleted) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Clear all notifications for a client
router.post('/clear-all', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    await Notification.deleteMany({ clientId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
