const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { checkLimit, incrementUsage } = require('../utils/planLimits');

/**
 * GET /api/segments
 */
router.get('/', protect, async (req, res) => {
    try {
        const segments = await Segment.find({ clientId: req.user.clientId }).sort({ createdAt: -1 });
        res.json(segments);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch segments.' });
    }
});

/**
 * POST /api/segments
 */
router.post('/', protect, async (req, res) => {
    const { name, description, query, prompt } = req.body;
    
    // Recursive date string to Date object converter
    const parseQueryDates = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        
        for (const key in obj) {
            if (typeof obj[key] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj[key])) {
                const date = new Date(obj[key]);
                if (!isNaN(date.getTime())) {
                    obj[key] = date;
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                parseQueryDates(obj[key]);
            }
        }
        return obj;
    };

    try {
        const sanitizedQuery = parseQueryDates(query || {});
        
        // Security: Force clientId
        delete sanitizedQuery.clientId;
        
        const count = await AdLead.countDocuments({ ...sanitizedQuery, clientId: req.user.clientId });
        
        const segment = new Segment({
            clientId: req.user.clientId,
            name,
            description,
            query: sanitizedQuery,
            prompt,
            lastCount: count,
            lastCountAt: new Date()
        });
        
        await segment.save();
        res.json(segment);
    } catch (err) {
        console.error('[Segments] Create Error:', err);
        res.status(500).json({ error: 'Failed to save segment. ' + err.message });
    }
});

/**
 * GET /api/segments/:id/leads
 * Fetches leads matching the segment query for preview/processing
 */
router.get('/:id/leads', protect, async (req, res) => {
    try {
        const segment = await Segment.findOne({ _id: req.params.id, clientId: req.user.clientId });
        if (!segment) return res.status(404).json({ error: 'Segment not found' });

        const count = await AdLead.countDocuments({ ...segment.query, clientId: req.user.clientId });
        const leads = await AdLead.find({ ...segment.query, clientId: req.user.clientId }).limit(100); // Preview limit

        res.json({ success: true, count, leads });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process segment leads.' });
    }
});

/**
 * DELETE /api/segments/:id
 */
router.delete('/:id', protect, async (req, res) => {
    try {
        await Segment.findOneAndDelete({ _id: req.params.id, clientId: req.user.clientId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete segment.' });
    }
});

module.exports = router;
