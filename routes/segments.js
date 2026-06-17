const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { translateConditionsToQuery } = require('../services/SegmentQueryBuilder');
const { apiCache, clearClientCache } = require('../middleware/apiCache');
const { syncOrderBackedCustomersToAdLeads } = require('../utils/commerce/leadsAnalyticsFacet');

/**
 * GET /api/segments
 */
router.get('/', protect, apiCache(60), async (req, res) => {
    const { createTimer } = require('../utils/core/perfLogger');
    const timer = createTimer('GET /api/segments', req.user?.clientId || '');
    try {
        const clientId = tenantClientId(req);
        const segments = await Segment.find({ clientId })
            .select('_id name description conditions lastCount lastCountAt createdAt updatedAt')
            .sort({ createdAt: -1 })
            .lean();
        timer.finish(`200 ok | count=${segments.length}`);
        res.json(segments);
    } catch (err) {
        timer.finish(`500 ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to fetch segments.' });
    }
});

/**
 * POST /api/segments
 * Deterministic creation via condition array.
 */
router.post('/', protect, async (req, res) => {
    const { name, description, conditions } = req.body;
    const clientId = tenantClientId(req);

    if (!name || !conditions || !Array.isArray(conditions)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing mandatory fields: name and conditions (array) are required.' 
        });
    }

    try {
        const generatedQuery = translateConditionsToQuery(conditions);

        await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});

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
        await clearClientCache(clientId);
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
 * POST /api/segments/refresh-counts
 * Recomputes lastCount for all saved segments (Sync button in Audience hub).
 */
router.post('/refresh-counts', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        const segments = await Segment.find({ clientId }).select('_id query').lean();
        await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});
        const now = new Date();
        let updated = 0;
        for (const seg of segments) {
            const count = await AdLead.countDocuments({ ...(seg.query || {}), clientId });
            await Segment.updateOne(
                { _id: seg._id, clientId },
                { $set: { lastCount: count, lastCountAt: now } }
            );
            updated += 1;
        }
        await clearClientCache(clientId);
        res.json({ success: true, updated });
    } catch (err) {
        console.error('[Segments] Refresh counts error:', err);
        res.status(500).json({ success: false, error: 'Failed to refresh segment counts.' });
    }
});

/**
 * GET /api/segments/:id/leads
 * Fetches leads matching the segment query for preview/processing
 */
router.get('/:id/leads', protect, apiCache(45), async (req, res) => {
    const { createTimer } = require('../utils/core/perfLogger');
    const timer = createTimer('GET /api/segments/:id/leads', req.user?.clientId || '');
    try {
        const clientId = tenantClientId(req);
        const segment = await Segment.findOne({ _id: req.params.id, clientId })
            .select('query name')
            .lean();
        if (!segment) {
            timer.finish('404');
            return res.status(404).json({ error: 'Segment not found' });
        }

        await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});

        const match = { ...segment.query, clientId };
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
        const [count, leads] = await Promise.all([
            AdLead.countDocuments(match),
            AdLead.find(match)
                .sort({ lastInteraction: -1, _id: -1 })
                .limit(limit)
                .select('name phoneNumber email lastInteraction ordersCount leadScore cartStatus totalSpent optStatus optInSource')
                .lean(),
        ]);

        timer.finish(`200 ok | count=${count} page=${leads.length}`);
        res.json({ success: true, count, leads });
    } catch (err) {
        timer.finish(`500 ${err.message}`);
        res.status(500).json({ success: false, error: 'Failed to process segment leads.' });
    }
});

/**
 * DELETE /api/segments/:id
 */
router.delete('/:id', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        await Segment.findOneAndDelete({ _id: req.params.id, clientId });
        await clearClientCache(clientId);
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
    const clientId = tenantClientId(req);

    if (!conditions || !Array.isArray(conditions)) {
        return res.status(400).json({ success: false, error: 'Conditions array is required.' });
    }

    try {
        const generatedQuery = translateConditionsToQuery(conditions);
        await syncOrderBackedCustomersToAdLeads(clientId).catch(() => {});
        const count = await AdLead.countDocuments({ ...generatedQuery, clientId });
        const leads = await AdLead.find({ ...generatedQuery, clientId })
            .limit(12)
            .select('name phoneNumber email lastInteraction ordersCount leadScore cartStatus')
            .lean();

        res.json({ success: true, count, leads });
    } catch (err) {
        console.error('[Segments] Preview Error:', err);
        res.status(400).json({ success: false, error: 'Failed to preview segment: ' + err.message });
    }
});

module.exports = router;
