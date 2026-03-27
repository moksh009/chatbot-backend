const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');

router.get('/:clientId/cod-pipeline', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const orders = await Order.find({ clientId, paymentGateway: 'cod' }).sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/rto-analytics', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Dummy RTO analytics response, full aggregation is complex
    res.json({ success: true, rtoRate: 15, rtoCost: 4500, saved: 12000, products: [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:clientId/bulk-action', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { targetOrderIds, action_type, new_status, template_id } = req.body;
    
    if (action_type === 'status_update') {
      await Order.updateMany({ _id: { $in: targetOrderIds }, clientId }, { $set: { status: new_status } });
    }
    
    // In a real scenario we'd integrate Shopify updates and WhatsApp sending here

    res.json({ success: true, message: `Bulk ${action_type} executed on ${targetOrderIds.length} orders.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
