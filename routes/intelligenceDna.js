const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const CustomerIntelligence = require('../models/CustomerIntelligence');
const { tenantClientId } = require('../utils/queryHelpers');

/**
 * GET /api/intelligence/dna/:phone
 * Returns the CustomerIntelligence document for a given phone number.
 */
router.get('/dna/:phone', protect, async (req, res) => {
    try {
        const { phone } = req.params;
        const clientId = tenantClientId(req);

        if (!clientId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Normalize phone — strip non-digits
        const cleanPhone = phone.replace(/\D/g, '');

        // Find the AdLead for this phone
        const lead = await AdLead.findOne({ clientId, $or: [{ phone: cleanPhone }, { phoneNumber: cleanPhone }] }).lean();
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        // Populate Import Batch Name for UI Pill
        if (lead.importBatchId) {
            const ImportSession = require('../models/ImportSession');
            const session = await ImportSession.findById(lead.importBatchId).select('listName').lean();
            if (session) {
                lead.importBatchName = session.listName;
            }
        }

        // Find the Conversation for this phone
        const conversation = await Conversation.findOne({ clientId, phone: cleanPhone }).select('aiDna customerIntelligence metadata lastDetectedIntent').lean();

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
