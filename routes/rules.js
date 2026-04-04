const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

// Get all rules for a client
router.get('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId }).select('automationRules');
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        res.json({ success: true, rules: client.automationRules || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update or completely replace automation rules
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
            { $set: { automationRules: rules } },
            { new: true }
        ).select('automationRules');

        res.json({ success: true, rules: client.automationRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Toggle rule active status
router.patch('/:clientId/:ruleId/toggle', protect, async (req, res) => {
    try {
        const { clientId, ruleId } = req.params;
        const { isActive } = req.body;

        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        let updated = false;
        const newRules = (client.automationRules || []).map(r => {
            if (r.id === ruleId) {
                updated = true;
                return { ...r, isActive: !!isActive };
            }
            return r;
        });

        if (!updated) {
            return res.status(404).json({ success: false, message: 'Rule not found' });
        }

        client.automationRules = newRules;
        await client.save();

        res.json({ success: true, rules: client.automationRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete a rule
router.delete('/:clientId/:ruleId', protect, async (req, res) => {
    try {
        const { clientId, ruleId } = req.params;

        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        client.automationRules = (client.automationRules || []).filter(r => r.id !== ruleId);
        await client.save();

        res.json({ success: true, rules: client.automationRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
