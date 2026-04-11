const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const Client = require('../models/Client');
const warrantyService = require('../utils/warrantyService');

/**
 * GET /api/warranty/unassigned-orders
 * @desc Fetch leads/orders that don't have warranties assigned yet
 */
router.get('/unassigned-orders', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        
        // Fetch leads who have placed orders but have 0 warranty records
        const leads = await AdLead.find({
            clientId,
            isOrderPlaced: true,
            $or: [
                { warrantyRecords: { $exists: false } },
                { warrantyRecords: { $size: 0 } }
            ]
        }).limit(50).sort({ lastInteraction: -1 });

        res.json({ success: true, leads });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/warranty/manual-register
 * @desc Manually assign a warranty record to a customer
 */
router.post('/manual-register', protect, async (req, res) => {
    try {
        const { phoneNumber, productName, serialNumber, orderId, duration, purchaseDate } = req.body;
        const clientId = req.user.clientId;
        const client = await Client.findOne({ clientId });

        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const record = await warrantyService.manualRegister(client, phoneNumber, {
            productName,
            serialNumber,
            orderId,
            duration,
            purchaseDate
        });

        res.json({ success: true, record });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/warranty/resend-notification
 * @desc Manually trigger a notification for an existing record
 */
router.post('/resend-notification', protect, async (req, res) => {
    try {
        const { phoneNumber, recordId } = req.body;
        const clientId = req.user.clientId;
        const client = await Client.findOne({ clientId });

        const lead = await AdLead.findOne({ clientId, phoneNumber });
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        const record = lead.warrantyRecords.id(recordId);
        if (!record) return res.status(404).json({ success: false, message: 'Warranty record not found' });

        await warrantyService.sendNotifications(client, phoneNumber, record);

        res.json({ success: true, message: 'Notification dispatched successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
