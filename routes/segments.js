const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * POST /api/segments/ai-generate
 * Generates a MongoDB query from a natural language prompt
 */
router.post('/ai-generate', protect, async (req, res) => {
    const { prompt } = req.body;
    const clientId = req.user.clientId;

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    try {
        const client = await Client.findOne({ clientId });
        
        // Ensure we only use Gemini keys for the Google AI library.
        // openaiApiKey is for OpenAI-specific tasks only.
        const apiKey = client?.geminiApiKey || process.env.GEMINI_API_KEY;
        
        if (!apiKey) {
            return res.status(403).json({ 
                error: 'AI capabilities not configured. Please set your Gemini API key in Settings.' 
            });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        });

        const schemaContext = `
            You are an expert MongoDB query generator. Generate ONLY a valid JSON object representing a MongoDB query for the 'AdLead' collection.
            The AdLead schema has these relevant fields:
            - phoneNumber: (String)
            - name: (String)
            - email: (String)
            - linkClicks: (Number)
            - addToCartCount: (Number)
            - checkoutInitiatedCount: (Number)
            - ordersCount: (Number)
            - totalSpent: (Number)
            - leadScore: (Number)
            - tags: (Array of Strings)
            - cartStatus: (String) ['active', 'abandoned', 'recovered', 'purchased', 'failed']
            - lastInteraction: (Date)
            - createdAt: (Date)
            - adAttribution: { source: String, adId: String, ... } source can be 'meta_ad', 'instagram_ad', 'organic'
            
            INTENT MAPPING:
            - "Spent > 500": { totalSpent: { $gt: 500 } }
            - "Top customers": { totalSpent: { $gte: 2000 }, ordersCount: { $gte: 2 } }
            - "Abandoned": { cartStatus: 'abandoned' }
            - "Active in last week": { lastInteraction: { $gte: "DATE_NOW_MINUS_7_DAYS" } }
            
            RULES:

            1. Return ONLY a valid JSON object. No markdown, no explanation.
            2. The query must be compatible with mongoose find().
            3. For dates, use "$gte" and relative expressions like new Date(Date.now() - X * 24 * 60 * 60 * 1000) will be replaced by YOU with a placeholder string "DATE_NOW_MINUS_X_DAYS" which I will post-process.
            4. Do NOT include clientId in the generated query.
        `;

        const result = await model.generateContent([
            schemaContext,
            `Generate a MongoDB query for this prompt: "${prompt}"`
        ]);

        let responseText = '';
        try {
            responseText = result.response.text().trim();
        } catch (textErr) {
            console.error('[AISegment] Response Blocked or Error:', textErr.message);
            return res.status(500).json({ 
                error: 'AI response was blocked or interrupted. Try a different prompt.' 
            });
        }
        // Clean markdown if present
        if (responseText.startsWith('```json')) responseText = responseText.replace(/```json|```/g, '').trim();
        else if (responseText.startsWith('```')) responseText = responseText.replace(/```/g, '').trim();

        // Parse and validate
        let queryObj;
        try {
            queryObj = JSON.parse(responseText);
        } catch (e) {
            console.error('[AISegment] Parse Error:', responseText);
            return res.status(500).json({ error: 'AI generated an invalid query. Please try rephrasing.' });
        }

        // Post-process "DATE_NOW_MINUS_X_DAYS" if any
        const processDates = (obj) => {
            for (let key in obj) {
                if (typeof obj[key] === 'string' && obj[key].startsWith('DATE_NOW_MINUS_')) {
                    const days = parseInt(obj[key].match(/\d+/)[0]);
                    const date = new Date();
                    date.setDate(date.getDate() - days);
                    obj[key] = date;
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    processDates(obj[key]);
                }
            }
        };
        processDates(queryObj);

        // Preview count
        const count = await AdLead.countDocuments({ ...queryObj, clientId });

        res.json({ success: true, query: queryObj, estimatedCount: count });
    } catch (err) {
        console.error('[AISegment] AI Error:', err.message);
        res.status(500).json({ error: 'Failed to generate segment.' });
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
