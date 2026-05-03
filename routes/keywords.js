const express = require('express');
const router = express.Router();
const KeywordTrigger = require('../models/KeywordTrigger');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/queryHelpers');

// Get all keywords for a client
router.get('/:clientId', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const triggers = await KeywordTrigger.find({ clientId }).sort({ createdAt: -1 });
        res.json({ success: true, triggers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Create a new keyword trigger
router.post('/:clientId', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const { keyword, type, actionType, targetId } = req.body;
        
        const trigger = await KeywordTrigger.create({
            clientId,
            keyword: keyword.toLowerCase(),
            type,
            actionType,
            targetId
        });
        
        res.json({ success: true, trigger });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete a keyword trigger
router.delete('/:clientId/:id', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        await KeywordTrigger.findOneAndDelete({ _id: req.params.id, clientId });
        res.json({ success: true, message: 'Keyword trigger removed' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
