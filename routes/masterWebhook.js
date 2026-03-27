const express = require('express');
const router = express.Router();
const { discoverClientByPhoneId } = require('../utils/clientDiscovery');
const genericAppointmentEngine = require('./engines/genericAppointment');
const genericEcommerceEngine = require('./engines/genericEcommerce');
const { runDualBrainEngine } = require('../utils/dualBrainEngine');

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
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        
        // Extract metadata
        const phoneNumberId = value?.metadata?.phone_number_id;
        const messages = value?.messages?.[0];
        
        if (!phoneNumberId || !messages) {
            return res.status(200).end(); // Acknowledge status updates etc
        }

        // DISCOVER CLIENT
        const client = await discoverClientByPhoneId(phoneNumberId);
        
        if (!client) {
            console.warn(`[MasterWebhook] Received message for unknown phoneId: ${phoneNumberId}`);
            // Fallback: If this is the hardcoded 'code_clinic' number, we could manually route
            // But better to have it in the database.
            return res.status(200).end();
        }

        console.log(`[MasterWebhook] Routing to Client: ${client.clientId} (${client.name}) | Type: ${client.businessType}`);

        // Set up the request object to look like what the engines expect
        req.clientConfig = client;
        
        // ROUTE BY BUSINESS TYPE OR FLOW DATA
        const { businessType, flowNodes } = client;

        // If client has Visual Flow Data, prioritize DualBrainEngine (The Dynamic Engine)
        if (flowNodes && flowNodes.length > 0) {
            console.log(`[MasterWebhook] Client ${client.clientId} has Visual Flow. Running DualBrain...`);
            
            // Standardize parsed message for DualBrain
            const parsedMessage = {
                ...messages,
                from: messages.from,
                profileName: value?.contacts?.[0]?.profile?.name || '',
                messageId: messages.id
            };
            
            const handled = await runDualBrainEngine(parsedMessage, client);
            if (handled) return res.status(200).end();
        }

        // Fallback to Niche Engines if not handled by Visual Flow
        if (businessType === 'ecommerce') {
            await genericEcommerceEngine.handleWebhook(req, res);
        } else if (businessType === 'salon' || businessType === 'clinic') {
            await genericAppointmentEngine.handleWebhook(req, res);
        } else {
            // Ultimate Fallback: DualBrain even without nodes (to handle basic greetings/AI if enabled)
            const parsedMessage = {
                ...messages,
                from: messages.from,
                profileName: value?.contacts?.[0]?.profile?.name || '',
                messageId: messages.id
            };
            await runDualBrainEngine(parsedMessage, client);
            res.status(200).end();
        }

    } catch (err) {
        console.error('[MasterWebhook] Critical Error:', err.message);
        res.status(200).end(); // Always acknowledge to avoid Retries from Meta
    }
});

module.exports = router;
