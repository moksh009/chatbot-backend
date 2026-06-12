'use strict';

const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const { authorizeAdminScope } = require('../middleware/adminAccess');

const router = express.Router();

router.get('/', protect, authorizeAdminScope('viewSupportChats'), async (req, res) => {
  try {
    const rows = await Notification.find({
      $or: [{ clientId: 'TOPEDGE_ADMIN' }, { audience: 'super_admin' }],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const unread = rows.filter((r) => !r.readAt).length;
    res.json({ rows, unread });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:id/read', protect, authorizeAdminScope('viewSupportChats'), async (req, res) => {
  await Notification.findByIdAndUpdate(req.params.id, { readAt: new Date() });
  res.json({ success: true });
});

router.post('/read-all', protect, authorizeAdminScope('viewSupportChats'), async (req, res) => {
  await Notification.updateMany(
    { $or: [{ clientId: 'TOPEDGE_ADMIN' }, { audience: 'super_admin' }], readAt: null },
    { readAt: new Date() }
  );
  res.json({ success: true });
});

module.exports = router;
