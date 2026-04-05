const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * POST /api/segments/ai-generate
 * Generates a MongoDB query from a natural language prompt
 */
router.post('/ai-generate', protect, async (req, res) => {
    const { prompt } = req.body;
    const clientId = req.user.clientId;

    // Phase 23: Plan Gating
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const segmentCheck = await checkLimit(client._id, 'aiSegments');
    if (!segmentCheck.allowed) {
        return res.status(403).json({ 
            error: segmentCheck.reason,
            upgradeRequired: true 
        });
    }

    const aiCallsCheck = await checkLimit(client._id, 'aiCalls');
    if (!aiCallsCheck.allowed) {
        return res.status(403).json({ 
            error: aiCallsCheck.reason,
            upgradeRequired: true 
        });
    }

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    try {
        const client = await Client.findOne({ clientId });
        const apiKey = client?.geminiApiKey || process.env.GEMINI_API_KEY;
        
        if (!apiKey) {
            return res.status(403).json({ 
                error: 'AI capabilities not configured. Please set your Gemini API key in Settings.' 
            });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash" 
        });

        const schemaContext = `
            You are an expert MongoDB query generator for an Ecommerce CRM. 
            Generate ONLY a valid JSON object representing a MongoDB query for the 'AdLead' collection.
            
            SCHEMA FIELDS:
            - phoneNumber: (String)
            - name: (String)
            - email: (String)
            - addToCartCount: (Number)
            - checkoutInitiatedCount: (Number)
            - ordersCount: (Number)
            - totalSpent: (Number)
            - leadScore: (Number)
            - tags: (Array of Strings) - Use { tags: { $in: ["VIP"] } } or { tags: "VIP" }
            - cartStatus: (String) ['active', 'abandoned', 'recovered', 'purchased']
            - lastInteraction: (Date)
            - source: (String) ['Meta Ad', 'Direct', 'Shopify Pixel', 'WooCommerce Pixel']
            - adAttribution.source: (String) ['meta_ad', 'instagram_ad', 'organic']
            
            DATE LOGIC:
            - For "last 7 days", use: { "lastInteraction": { "$gte": "NOW_MINUS_7_DAYS" } }
            - For "more than a month ago", use: { "lastInteraction": { "$lt": "NOW_MINUS_30_DAYS" } }
            
            RULES:
            1. Return ONLY the JSON object. No markdown blocks, no preamble.
            2. Do NOT include 'clientId' in the query.
            3. Use MongoDB operators like $gt, $lt, $gte, $lte, $in, $ne.
        `;

        const result = await model.generateContent([
            schemaContext,
            `Prompt: "${prompt}"`
        ]);

        let responseText = result.response.text().trim();
        
        // Clean markdown if present
        if (responseText.includes('```')) {
            responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        }

        // Parse and validate
        let queryObj;
        try {
            const jsonStart = responseText.indexOf('{');
            const jsonEnd = responseText.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                responseText = responseText.substring(jsonStart, jsonEnd + 1);
            }
            queryObj = JSON.parse(responseText);
        } catch (e) {
            return res.status(500).json({ error: 'AI generated an invalid query format.' });
        }

        // Post-process Date Placeholders
        const processDates = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (let key in obj) {
                if (typeof obj[key] === 'string' && obj[key].includes('NOW_MINUS_')) {
                    const match = obj[key].match(/\d+/);
                    if (match) {
                        const days = parseInt(match[0]);
                        const date = new Date();
                        date.setDate(date.getDate() - days);
                        obj[key] = date;
                    }
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    processDates(obj[key]);
                }
            }
        };
        processDates(queryObj);

        // Security: Remove any attempts to query sensitive fields
        delete queryObj.clientId;
        delete queryObj._id;

        const count = await AdLead.countDocuments({ ...queryObj, clientId });

        // Phase 23: Track Usage
        await incrementUsage(client._id, 'aiCallsMade');

        res.json({ success: true, query: queryObj, estimatedCount: count });
    } catch (err) {
        console.error('[AISegment] Error:', err.message);
        res.status(500).json({ error: 'Failed to generate segment via AI.' });
    }
});

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
    try {
        const count = await AdLead.countDocuments({ ...query, clientId: req.user.clientId });
        const segment = new Segment({
            clientId: req.user.clientId,
            name,
            description,
            query,
            prompt,
            lastCount: count,
            lastCountAt: new Date()
        });
        await segment.save();
        res.json(segment);
    } catch (err) {
        res.status(500).json({ error: 'Failed to save segment.' });
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
