const express = require('express');
const router = express.Router();
const WhatsAppFlow = require('../models/WhatsAppFlow');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const axios = require('axios');
const log = require('../utils/logger')('WhatsAppFlows');
const { checkLimit } = require('../utils/planLimits');

/**
 * POST /api/whatsapp-flows/sync
 * Syncs flows from Meta Graph API for the client's WABA
 */
router.post('/sync', protect, async (req, res) => {
    const clientId = req.user.clientId;
    try {
        const client = await Client.findOne({ clientId });
        if (!client || !client.whatsappToken || !client.wabaId) {
            return res.status(403).json({ error: 'WhatsApp WABA / Token not configured.' });
        }
        
        // --- Phase 23: Track 8 - Billing Enforcement (WA Flows) ---
        const limitCheck = await checkLimit(client._id, 'waflows');
        if (!limitCheck.allowed) {
            return res.status(403).json({ success: false, message: limitCheck.reason });
        }

        const response = await axios.get(`https://graph.facebook.com/v18.0/${client.wabaId}/flows`, {
            params: { access_token: client.whatsappToken, fields: 'id,name,status,categories,validation_errors' }
        });

        const metaFlows = response.data?.data || [];
        const syncedFlows = [];

        for (const meta of metaFlows) {
            const flow = await WhatsAppFlow.findOneAndUpdate(
                { flowId: meta.id, clientId },
                {
                    $set: {
                        name: meta.name,
                        status: meta.status,
                        categories: meta.categories,
                        validationErrors: meta.validation_errors,
                        lastSyncedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );
            syncedFlows.push(flow);
        }

        res.json({ success: true, count: syncedFlows.length, flows: syncedFlows });
    } catch (err) {
        log.error('Sync Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to sync flows from Meta.' });
    }
});

/**
 * GET /api/whatsapp-flows
 */
router.get('/', protect, async (req, res) => {
    try {
        const flows = await WhatsAppFlow.find({ clientId: req.user.clientId }).sort({ createdAt: -1 });
        res.json(flows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch flows.' });
    }
});

module.exports = router;
