const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/queryHelpers');
const { v4: uuidv4 } = require('uuid');

// Get all routing rules for a client
router.get('/:clientId', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId }).select('routingRules');
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        res.json({ success: true, rules: client.routingRules || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update or completely replace routing rules (bulk)
router.put('/:clientId', protect, async (req, res) => {
    try {
        const { rules } = req.body;
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        if (!Array.isArray(rules)) {
            return res.status(400).json({ success: false, message: 'Rules must be an array' });
        }

        // Ensure each rule has an id
        const enrichedRules = rules.map(r => ({
            ...r,
            id: r.id || uuidv4(),
            isActive: r.isActive !== undefined ? r.isActive : true,
            priority: r.priority || 99
        }));

        const client = await Client.findOneAndUpdate(
            { clientId },
            { $set: { routingRules: enrichedRules } },
            { new: true }
        ).select('routingRules');

        res.json({ success: true, rules: client.routingRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Add a single routing rule
router.post('/:clientId/rules', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const rule = {
            ...req.body,
            id: uuidv4(),
            isActive: true,
            priority: req.body.priority || 99,
            createdAt: new Date()
        };

        const client = await Client.findOneAndUpdate(
            { clientId },
            { $push: { routingRules: rule } },
            { new: true }
        ).select('routingRules');

        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        res.json({ success: true, rule, rules: client.routingRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Toggle a routing rule active/inactive
router.patch('/:clientId/rules/:ruleId/toggle', protect, async (req, res) => {
    try {
        const { ruleId } = req.params;
        const { isActive } = req.body;
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        let updated = false;
        const newRules = (client.routingRules || []).map(r => {
            if (r.id === ruleId) {
                updated = true;
                return { ...r, isActive: !!isActive };
            }
            return r;
        });

        if (!updated) return res.status(404).json({ success: false, message: 'Rule not found' });

        client.routingRules = newRules;
        await client.save();

        res.json({ success: true, rules: client.routingRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete a specific routing rule
router.delete('/:clientId/rules/:ruleId', protect, async (req, res) => {
    try {
        const { ruleId } = req.params;
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const before = (client.routingRules || []).length;
        client.routingRules = (client.routingRules || []).filter(r => r.id !== ruleId);

        if (client.routingRules.length === before) {
            return res.status(404).json({ success: false, message: 'Rule not found' });
        }

        await client.save();
        res.json({ success: true, rules: client.routingRules });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
