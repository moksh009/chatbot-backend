const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

// Get all routing rules for a client
router.get('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId }).select('routingRules');
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        res.json({ success: true, rules: client.routingRules || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update or completely replace routing rules
router.put('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { rules } = req.body;

        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        if (!Array.isArray(rules)) {
            return res.status(400).json({ success: false, message: 'Rules must be an array' });
        }

        const client = await Client.findOneAndUpdate(
            { clientId },
            { $set: { routingRules: rules } },
            { new: true }
        ).select('routingRules');

        res.json({ success: true, rules: client.routingRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
