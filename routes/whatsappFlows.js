const express = require('express');
const router = express.Router();
const WhatsAppFlow = require('../models/WhatsAppFlow');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const axios = require('axios');
const log = require('../utils/core/logger')('WhatsAppFlows');
const { checkLimit } = require('../utils/core/planLimits');
const { apiCache } = require('../middleware/apiCache');
const {
  resolveWhatsAppCredentials,
  isWhatsAppOutboundReady,
  WHATSAPP_CREDENTIAL_SELECT,
} = require('../utils/meta/clientWhatsAppCreds');

function formatFlowForClient(doc) {
    const flowId = String(doc.flowId || doc.id || '');
    const status = String(doc.status || 'DRAFT').toUpperCase();
    return {
        flowId,
        id: flowId,
        name: doc.name || 'Untitled flow',
        status,
        isPublished: status === 'PUBLISHED',
        categories: Array.isArray(doc.categories) ? doc.categories : [],
        validationErrors: doc.validationErrors || [],
        lastSyncedAt: doc.lastSyncedAt || null,
    };
}

function isMetaOAuthError(err) {
    const code = Number(err?.response?.data?.error?.code);
    return code === 190 || code === 102 || code === 10;
}

/**
 * Load decrypted WhatsApp Graph credentials (same precedence as outbound sends).
 */
async function loadWhatsAppGraphCredentials(clientId) {
    const client = await Client.findOne({ clientId }).select(WHATSAPP_CREDENTIAL_SELECT).lean();
    if (!client || !isWhatsAppOutboundReady(client)) {
        const err = new Error('WhatsApp WABA / token not configured. Connect WhatsApp in Settings.');
        err.code = 'WA_NOT_CONFIGURED';
        throw err;
    }
    const { token, wabaId } = resolveWhatsAppCredentials(client);
    return { client, token, wabaId };
}

async function fetchMetaFlowsFromGraph(wabaId, token) {
    const response = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}/flows`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'id,name,status,categories,validation_errors', limit: 100 },
        timeout: 15000,
    });
    return response.data?.data || [];
}

/**
 * GET /api/whatsapp-flows
 * Returns all synced flows for the client (lite list — no nodes/edges)
 */
router.get('/', protect, apiCache(60), async (req, res) => {
    const { createTimer } = require('../utils/core/perfLogger');
    const timer = createTimer('GET /api/whatsapp-flows', req.user?.clientId || '');
    try {
        const clientId = tenantClientId(req);
        if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
        const flows = await WhatsAppFlow.find({ clientId })
            .select('flowId name status categories lastSyncedAt validationErrors')
            .sort({ status: 1, lastSyncedAt: -1 })
            .limit(100)
            .lean();
        timer.finish(`200 ok | count=${flows.length}`);
        res.json(flows.map(formatFlowForClient));
    } catch (err) {
        timer.finish(`500 ${err.message}`);
        log.error('Fetch Flows Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch flows.' });
    }
});

/**
 * POST /api/whatsapp-flows/sync
 * Syncs flows from Meta Graph API for the client's WABA
 */
router.post('/sync', protect, async (req, res) => {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { client, token, wabaId } = await loadWhatsAppGraphCredentials(clientId);

        const limitCheck = await checkLimit(client._id);
        if (!limitCheck.allowed) {
            return res.status(403).json({ success: false, message: limitCheck.reason });
        }

        const metaFlows = await fetchMetaFlowsFromGraph(wabaId, token);
        const syncedFlows = [];

        for (const meta of metaFlows) {
            const flowId = String(meta.id || '');
            if (!flowId) continue;
            const flow = await WhatsAppFlow.findOneAndUpdate(
                { flowId, clientId },
                {
                    $set: {
                        name: meta.name || 'Untitled flow',
                        status: meta.status || 'DRAFT',
                        categories: Array.isArray(meta.categories) ? meta.categories : [],
                        validationErrors: Array.isArray(meta.validation_errors) ? meta.validation_errors : [],
                        lastSyncedAt: new Date(),
                    },
                    $setOnInsert: { clientId, flowId, platform: 'whatsapp' },
                },
                { upsert: true, new: true, runValidators: true }
            );
            syncedFlows.push(flow);
        }

        const formatted = syncedFlows.map((f) => formatFlowForClient(f.toObject ? f.toObject() : f));
        await Client.findOneAndUpdate(
            { clientId },
            { $set: { syncedMetaFlows: formatted } }
        );

        res.json({ success: true, count: formatted.length, flows: formatted });
    } catch (err) {
        if (err.code === 'WA_NOT_CONFIGURED') {
            return res.status(403).json({ error: err.message, isIntegrationAuthError: true });
        }
        const metaErr = err.response?.data?.error;
        log.error('Sync Error:', metaErr || err.message);
        const detail = metaErr?.message || err.message;
        const authError = isMetaOAuthError(err);
        res.status(authError ? 403 : 500).json({
            error: authError
                ? 'WhatsApp token rejected by Meta. Reconnect WhatsApp in Settings → Connections.'
                : 'Failed to sync flows from Meta.',
            detail,
            isIntegrationAuthError: authError,
        });
    }
});

/**
 * POST /api/whatsapp-flows/send
 * Manually sends a flow to a user
 */
router.post('/send', protect, async (req, res) => {
    const { phone, flowId, header, body, cta, screen } = req.body;
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

    if (!phone || !flowId) return res.status(400).json({ error: 'Phone and Flow ID required.' });

    try {
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found.' });

        // Phase 23: Track 8 - Billing Enforcement (WA Flows)
        const limitCheck = await checkLimit(client._id, 'waflows');
        if (!limitCheck.allowed) {
            return res.status(403).json({ success: false, message: limitCheck.reason });
        }

        const { sendWhatsAppFlow } = require('../utils/commerce/dualBrainEngine');
        
        const result = await sendWhatsAppFlow(client, phone, header, body, flowId, cta, screen);
        if (result && result.ok === false) {
            return res.status(400).json({ error: result.message || 'Failed to send flow.', code: result.code });
        }
        res.json({ success: true, message: 'Flow sent successfully.' });
    } catch (err) {
        log.error('Send Flow Error:', err.message);
        res.status(500).json({ error: 'Failed to send flow.' });
    }
});

module.exports = router;
