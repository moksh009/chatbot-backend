const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const { translateConditionsToQuery } = require('../services/SegmentQueryBuilder');

/**
 * GET /api/segments
 */
router.get('/', protect, async (req, res) => {
    try {
        const segments = await Segment.find({ clientId: req.user.clientId }).sort({ createdAt: -1 });
        res.json(segments);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch segments.' });
    }
});

/**
 * POST /api/segments
 * Deterministic creation via condition array.
 */
router.post('/', protect, async (req, res) => {
    const { name, description, conditions } = req.body;
    const clientId = req.user.clientId;

    if (!name || !conditions || !Array.isArray(conditions)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing mandatory fields: name and conditions (array) are required.' 
        });
    }

    try {
        // 1. Translate UI conditions to Mongo Query
        const generatedQuery = translateConditionsToQuery(conditions);
        
        // 2. Perform live count for the segment
        const count = await AdLead.countDocuments({ ...generatedQuery, clientId });
        
        // 3. Persist Segment
        const segment = new Segment({
            clientId,
            name,
            description: description || `Built with ${conditions.length} automatic rules.`,
            conditions,
            query: generatedQuery,
            lastCount: count,
            lastCountAt: new Date()
        });
        
        await segment.save();
        res.status(201).json(segment);

    } catch (err) {
        console.error('[Segments] Deterministic Create Error:', err);
        res.status(400).json({ 
            success: false, 
            error: 'Schema violation or parsing error: ' + err.message 
        });
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
        res.status(500).json({ success: false, error: 'Failed to process segment leads.' });
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
        res.status(500).json({ success: false, error: 'Failed to delete segment.' });
    }
});

/**
 * POST /api/segments/preview
 * Previews leads matching the given conditions without saving the segment
 */
router.post('/preview', protect, async (req, res) => {
    const { conditions } = req.body;
    const clientId = req.user.clientId;

    if (!conditions || !Array.isArray(conditions)) {
        return res.status(400).json({ success: false, error: 'Conditions array is required.' });
    }

    try {
        const generatedQuery = translateConditionsToQuery(conditions);
        const count = await AdLead.countDocuments({ ...generatedQuery, clientId });
        const leads = await AdLead.find({ ...generatedQuery, clientId }).limit(10).select('name phoneNumber email lastInteraction');

        res.json({ success: true, count, leads });
    } catch (err) {
        console.error('[Segments] Preview Error:', err);
        res.status(400).json({ success: false, error: 'Failed to preview segment: ' + err.message });
    }
});

module.exports = router;
