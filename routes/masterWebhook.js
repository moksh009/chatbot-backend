const express = require('express');
const router = express.Router();
const { discoverClientByPhoneId } = require('../utils/clientDiscovery');
const genericAppointmentEngine = require('./engines/genericAppointment');
const genericEcommerceEngine = require('./engines/genericEcommerce');
const { runDualBrainEngine } = require('../utils/dualBrainEngine');
const { parseWhatsAppPayload } = require('../utils/parseWhatsAppPayload');

// 1. Webhook Verification (GET)
// Meta sends a GET to verify the webhook URL
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = process.env.VERIFY_TOKEN || 'my_verify_token';

    if (mode && token === verifyToken) {
        console.log('✅ Webhook Root Verified');
        return res.status(200).send(challenge);
    }
    res.status(403).end();
});

// 2. Master Webhook Handling (POST)
// ALL incoming messages from Meta hit this root endpoint
router.post('/', async (req, res) => {
    // Send 200 OK immediately as required by Meta
    res.status(200).send('EVENT_RECEIVED');

    try {
        const parsedMessage = parseWhatsAppPayload(req.body);
        if (!parsedMessage) return;

        const phoneNumberId = parsedMessage.phoneNumberId;
        if (!phoneNumberId) return;

        // DISCOVER CLIENT
        const client = await discoverClientByPhoneId(phoneNumberId);
        if (!client) {
            console.warn(`[MasterWebhook] Received message for unknown phoneId: ${phoneNumberId}`);
            return;
        }

        console.log(`[MasterWebhook] Routing to Client: ${client.clientId} (${client.name})`);

        // 1. HANDLE STATUS UPDATES (delivered, read, failed)
        if (parsedMessage.type === 'status_update') {
            const { updateCampaignStats } = require('../utils/campaignStatsHelper');
            await updateCampaignStats(parsedMessage, client);
            return;
        }

        // 2. ROUTE BY FLOW DATA OR BUSINESS TYPE
        if (client.flowNodes && client.flowNodes.length > 0) {
            await runDualBrainEngine(parsedMessage, client);
        } else {
            // Fallback to Niche Engines
            if (client.businessType === 'ecommerce') {
                await genericEcommerceEngine.handleWebhook(req, res);
            } else if (client.businessType === 'salon' || client.businessType === 'clinic') {
                await genericAppointmentEngine.handleWebhook(req, res);
            } else {
                await runDualBrainEngine(parsedMessage, client);
            }
        }

    } catch (err) {
        console.error('[MasterWebhook] Error processing background event:', err.message, err.stack);
    }
});

module.exports = router;
