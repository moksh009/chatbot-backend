const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const { protect } = require('../middleware/auth');
const CustomerIntelligence = require('../models/CustomerIntelligence');
const { computeDNA, getPersonalizationContext } = require('../utils/customerIntelligence');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');

/**
 * generateAISummaryBackground(clientId, phone, lead)
 * 
 * Runs asynchronously AFTER the initial GET /dna/:phone response.
 * Uses Gemini to generate a 2-sentence behavioral summary and emits 
 * a `dna_updated` socket event so the UI updates in real-time.
 */
async function generateAISummaryBackground(clientId, phone, lead) {
  try {
    const client = await Client.findOne({ clientId }).select('geminiApiKey businessName').lean();
    const apiKey = client?.geminiApiKey || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.warn(`[Intelligence] No Gemini API key for ${clientId}, skipping AI summary.`);
      return;
    }

    // Gather context: recent messages + lead data + orders
    const conversation = await Conversation.findOne({
      clientId,
      $or: [
        { phone },
        { phone: { $regex: phone.replace(/\D/g, '').slice(-10) + '$' } }
      ]
    }).select('_id sentiment').lean();

    let recentMessages = [];
    if (conversation) {
      recentMessages = await Message.find({ conversationId: conversation._id })
        .sort({ timestamp: -1 })
        .limit(20)
        .select('content direction timestamp')
        .lean();
    }

    // Build context string
    const msgContext = recentMessages
      .reverse()
      .map(m => `${m.direction === 'outgoing' ? 'Bot' : 'Customer'}: ${(m.content || '').substring(0, 100)}`)
      .join('\n');

    const leadName = lead?.name || 'Unknown';
    const leadScore = lead?.leadScore ?? 0;
    const orderCount = lead?.ordersCount || 0;
    const totalSpent = lead?.totalSpent || 0;
    const sentiment = conversation?.sentiment || 'Unknown';

    const prompt = `You are a CRM intelligence engine for "${client?.businessName || 'a business'}". Analyze this customer and write exactly 2 SHORT sentences summarizing their behavior and value.

Customer: ${leadName}
Lead Score: ${leadScore}/100
Orders: ${orderCount} (₹${totalSpent} total)
Sentiment: ${sentiment}
Recent conversation:
${msgContext || 'No messages yet.'}

Rules:
- Exactly 2 sentences, no more
- Be specific about behavior patterns
- Mention purchase intent or engagement level
- Professional CRM tone, no emojis`;

    const { platformGenerateText } = require('../utils/gemini');
    const summary = await platformGenerateText(prompt, {
      maxTokens: 150,
      temperature: 0.7,
      timeout: 15000
    });

    if (!summary || summary.length < 10) {
      console.warn(`[Intelligence] AI summary too short for ${phone}, skipping.`);
      return;
    }

    // Clean the summary
    const cleanSummary = summary
      .replace(/```/g, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    // Persist to CustomerIntelligence
    await CustomerIntelligence.findOneAndUpdate(
      { clientId, phone },
      { 
        $set: { 
          aiSummary: cleanSummary,
          lastAnalyzedAt: new Date()
        } 
      },
      { upsert: true }
    );

    // Emit socket event so frontend updates in real-time
    if (global.io) {
      global.io.to(`client_${clientId}`).emit('dna_updated', {
        phone,
        aiSummary: cleanSummary,
        timestamp: new Date()
      });
      console.log(`[Intelligence] AI summary generated and emitted for ${phone.slice(-4)}`);
    }

  } catch (err) {
    // Non-blocking — log and move on
    console.error(`[Intelligence] Background AI summary failed for ${phone}:`, err.message);
  }
}

/**
 * GET /api/intelligence/dna/:phone
 * Returns the full behavioral DNA for a lead IMMEDIATELY,
 * then triggers background AI summary generation.
 */
router.get('/dna/:phone', protect, async (req, res) => {
  try {
    const { phone } = req.params;
    const clientId = req.user.clientId;

    let dna = await CustomerIntelligence.findOne({ clientId, phone })
      .select('aiSummary persona engagementScore buyingSignals ltv potential sourceTags lastAnalyzedAt')
      .lean();

    if (!dna) {
      // Upsert skeletal DNA — return immediately with placeholder
      const newDna = new CustomerIntelligence({ 
        clientId, 
        phone,
        engagementScore: 10,
        aiSummary: 'New lead detected. Behavioral synthesis in progress...'
      });
      await newDna.save();
      dna = newDna.toObject();
    }

    const brief = await getPersonalizationContext(clientId, phone);

    // Return the response IMMEDIATELY
    res.json({ success: true, dna, brief });

    // THEN trigger background AI summary generation (non-blocking)
    // Only regenerate if stale (>1 hour) or placeholder
    const isStale = !dna.lastAnalyzedAt || 
      (Date.now() - new Date(dna.lastAnalyzedAt).getTime()) > 60 * 60 * 1000;
    const isPlaceholder = !dna.aiSummary || dna.aiSummary.includes('in progress');

    if (isStale || isPlaceholder) {
      // Fetch lead for context
      const phoneSuffix = phone.replace(/\D/g, '').slice(-10);
      const lead = await AdLead.findOne({
        clientId,
        phoneNumber: { $regex: phoneSuffix + '$' }
      }).lean();

      setImmediate(() => {
        generateAISummaryBackground(clientId, phone, lead).catch(err => {
          console.error('[Intelligence] Background generation error:', err.message);
        });
      });
    }

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/intelligence/dna/:phone/recompute
 * Force an immediate AI recomputation of the DNA profile.
 */
router.post('/dna/:phone/recompute', protect, async (req, res) => {
  try {
    const { phone } = req.params;
    const clientId = req.user.clientId;

    const client = await Client.findOne({ clientId });
    const apiKey = client?.geminiApiKey || process.env.GEMINI_API_KEY;

    const dna = await computeDNA(clientId, phone, apiKey);
    if (!dna) {
      return res.status(404).json({ success: false, message: 'Could not compute DNA' });
    }

    // Also trigger AI summary refresh
    const lead = await AdLead.findOne({
      clientId,
      phoneNumber: { $regex: phone.replace(/\D/g, '').slice(-10) + '$' }
    }).lean();
    
    setImmediate(() => {
      generateAISummaryBackground(clientId, phone, lead).catch(() => {});
    });

    res.json({ success: true, dna });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/intelligence/footprint
 * Returns the bot efficiency metrics and drop-off analysis.
 */
router.get('/footprint', protect, async (req, res) => {
  try {
    const { getBotEfficiency } = require('../utils/footprintEngine');
    const footprint = await getBotEfficiency(req.user.clientId);
    
    if (!footprint) {
      return res.status(500).json({ success: false, message: 'Failed to analyze footprint' });
    }

    res.json({ success: true, footprint });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
