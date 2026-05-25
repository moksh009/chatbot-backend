const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { apiCache } = require('../middleware/apiCache');

const LEAD_FIND_MAX_MS = parseInt(process.env.DNA_LEAD_FIND_MAX_MS || '8000', 10) || 8000;

/**
 * GET /api/intelligence/dna/:phone
 * Lead + conversation row for the contact details panel (cached briefly — was ~15–20s wall time under DB contention when uncached).
 */
router.get('/dna/:phone', protect, apiCache(45), async (req, res) => {
    try {
        const { phone } = req.params;
        const clientId = tenantClientId(req);

        if (!clientId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const cleanPhone = phone.replace(/\D/g, '');

        const [leadPrimary, conversation] = await Promise.all([
            AdLead.findOne({ clientId, phoneNumber: cleanPhone })
                .maxTimeMS(LEAD_FIND_MAX_MS)
                .lean(),
            Conversation.findOne({ clientId, phone: cleanPhone })
                .select('aiDna lastDetectedIntent')
                .maxTimeMS(LEAD_FIND_MAX_MS)
                .lean(),
        ]);

        let lead = leadPrimary;
        if (!lead && cleanPhone.length > 10) {
            const tail = cleanPhone.slice(-10);
            lead = await AdLead.findOne({ clientId, phoneNumber: tail })
                .maxTimeMS(4000)
                .lean();
        }

        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        if (lead.importBatchId) {
            const ImportSession = require('../models/ImportSession');
            const session = await ImportSession.findById(lead.importBatchId).select('listName').maxTimeMS(3000).lean();
            if (session) {
                lead.importBatchName = session.listName;
            }
        }

        res.json({ 
            lead,
            aiDna: conversation?.aiDna || null,
            lastIntent: conversation?.lastDetectedIntent || null
        });
    } catch (err) {
        console.error('[/api/intelligence/dna] Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch DNA details' });
    }
});

module.exports = router;
