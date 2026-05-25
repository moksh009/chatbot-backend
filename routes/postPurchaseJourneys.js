'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const FollowUpSequence = require('../models/FollowUpSequence');
const { seedPlaybooksForClient } = require('../services/postPurchaseJourneys/seedPlaybooks');

router.get('/:clientId', protect, async (req, res) => {
  try {
    const clientId = req.params.clientId;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const flows = await WhatsAppFlow.find({
      clientId,
      flowType: 'post_purchase_journey',
    }).lean();

    const stats = await FollowUpSequence.aggregate([
      {
        $match: {
          clientId,
          type: 'post_purchase_journey',
        },
      },
      {
        $group: {
          _id: '$playbookKey',
          enrolled: { $sum: 1 },
          sent: {
            $sum: {
              $size: {
                $filter: {
                  input: '$steps',
                  as: 's',
                  cond: { $eq: ['$$s.status', 'sent'] },
                },
              },
            },
          },
        },
      },
    ]);

    const statMap = Object.fromEntries(stats.map((s) => [s._id, s]));

    res.json({
      success: true,
      playbooks: flows.map((f) => ({
        id: f._id,
        flowId: f.flowId,
        playbookKey: f.playbookKey,
        name: f.name,
        status: f.status,
        journeyTrigger: f.journeyTrigger,
        journeyPolicies: f.journeyPolicies,
        performance: statMap[f.playbookKey] || { enrolled: 0, sent: 0 },
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/:clientId/seed', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const n = await seedPlaybooksForClient(clientId);
    res.json({ success: true, created: n });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/:clientId/:flowId/activate', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({
      _id: req.params.flowId,
      clientId: req.params.clientId,
      flowType: 'post_purchase_journey',
    });
    if (!flow) return res.status(404).json({ success: false, message: 'Playbook not found' });
    flow.status = 'PUBLISHED';
    await flow.save();
    res.json({ success: true, status: 'PUBLISHED' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/:clientId/:flowId/pause', protect, requireRole('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({
      _id: req.params.flowId,
      clientId: req.params.clientId,
      flowType: 'post_purchase_journey',
    });
    if (!flow) return res.status(404).json({ success: false, message: 'Playbook not found' });
    flow.status = 'DRAFT';
    await flow.save();
    res.json({ success: true, status: 'DRAFT' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
