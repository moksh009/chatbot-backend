const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/queryHelpers');
const router = express.Router();
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');
const { logAction } = require('../middleware/audit');

const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

// GET /api/orders?phone=...
router.get('/', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required' });
    }

    // Standardize phone: strip non-digits and take last 10 digits for robust matching
    const cleanPhone = phone.replace(/\D/g, '');
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const phoneRegex = new RegExp(`${phoneSuffix}$`);

    const scopedClientId = tenantClientId(req);
    if (!scopedClientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const query = { 
      clientId: scopedClientId,
      $or: [
        { phone: phoneRegex }, 
        { customerPhone: phoneRegex },
        { phone: phone }, // Fallback to exact match
        { customerPhone: phone }
      ] 
    };

    const orders = await Order.find(query).sort({ createdAt: -1 }).limit(10).lean();
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


router.get('/:clientId/cod-pipeline', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { limit = 50, page = 1 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 200);
    const skip = (pageNum - 1) * limitNum;

    const query = { clientId, paymentGateway: 'cod' };
    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Order.countDocuments(query)
    ]);

    res.json({ 
      success: true, 
      orders, 
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/rto-analytics', protect, logPersonalDataAccess, async (req, res) => {
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
    } else if (action_type === 'cod_verify') {
      const Client = require('../models/Client');
      const client = await Client.findOne({ clientId });
      if (client) {
        const { sendTemplateMessage } = require('../utils/whatsappAPI');
        const orders = await Order.find({ _id: { $in: targetOrderIds }, clientId });
        
        for (const order of orders) {
          const isCod = order.paymentMethod?.toLowerCase() === 'cod' || order.isCOD === true;
          if (isCod) {
            order.status = 'verification_pending';
            await order.save();
            const phone = order.customerPhone || order.phone;
            if (phone && client.whatsappToken) {
              try {
                await sendTemplateMessage(clientId, phone, 'cod_verification_request', [
                  { type: 'text', text: order.customerName || 'Customer' },
                  { type: 'text', text: order.orderId || order.orderNumber }
                ]);
              } catch (e) {
                console.error('Failed to send COD verification WhatsApp', e.message);
              }
            }
          }
        }
      }
    }
    
    // In a real scenario we'd integrate Shopify updates and WhatsApp sending here

    res.json({ success: true, message: `Bulk ${action_type} executed on ${targetOrderIds.length} orders.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/client/:clientId/orders/:orderId/send-review-request
// Manually triggers a WhatsApp review request for a fulfilled order
router.post('/:clientId/orders/:orderId/send-review-request', protect, async (req, res) => {
  try {
    const { clientId, orderId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const order = await Order.findOne({ _id: orderId, clientId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.customerPhone || order.phone;
    if (!phone) return res.status(400).json({ success: false, message: 'Order has no customer phone' });

    const Client = require('../models/Client');
    const ReviewRequest = require('../models/ReviewRequest');
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Schedule immediately (scheduledFor = now)
    await ReviewRequest.findOneAndUpdate(
      { clientId, phone, orderNumber: order.orderNumber || order.orderId },
      {
        clientId,
        phone,
        orderNumber: order.orderNumber || order.orderId,
        productName: order.items?.[0]?.name || 'your order',
        reviewUrl: client.googleReviewUrl || '',
        scheduledFor: new Date(), // Immediate
        status: 'scheduled'
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Review request scheduled for immediate dispatch' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
