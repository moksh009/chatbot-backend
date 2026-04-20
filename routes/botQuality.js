const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Conversation = require('../models/Conversation');
const BotAnalytics = require('../models/BotAnalytics');
const TrainingCase = require('../models/TrainingCase');

/**
 * @route   GET /api/bot-quality/footprint
 * @desc    Generate AI bot quality footprint metrics.
 *          Replaces the deprecated /api/intelligence/footprint endpoint.
 */
router.get('/footprint', protect, async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    if (!clientId) return res.status(400).json({ success: false, message: 'ClientId required' });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalConversations,
      aiHandledConversations,
      corrections,
      dropOffs
    ] = await Promise.all([
      // Total conversations in last 30 days
      Conversation.countDocuments({ clientId, createdAt: { $gte: thirtyDaysAgo } }),
      // AI-handled conversations (not paused/escalated)
      Conversation.countDocuments({ clientId, createdAt: { $gte: thirtyDaysAgo }, botPaused: { $ne: true } }),
      // Training corrections submitted
      TrainingCase.countDocuments({ clientId, createdAt: { $gte: thirtyDaysAgo } }),
      // Drop-off nodes (where conversations ended without resolution)
      Conversation.aggregate([
        { $match: { clientId, createdAt: { $gte: thirtyDaysAgo }, 'lastNodeVisited.nodeId': { $exists: true } } },
        { $group: { _id: '$lastNodeVisited.nodeLabel', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ])
    ]);

    const accuracy = totalConversations > 0
      ? Math.min(99.9, ((aiHandledConversations / totalConversations) * 100)).toFixed(1)
      : 0;

    const status = accuracy >= 90 ? 'Excellent' : accuracy >= 75 ? 'Good' : accuracy >= 50 ? 'Needs Improvement' : 'Critical';

    const recommendations = [];
    if (corrections > 10) recommendations.push('High correction volume — review intent training phrases.');
    if (accuracy < 75) recommendations.push('Accuracy below threshold — add more training data.');
    if (dropOffs.length > 5) recommendations.push('Multiple drop-off points — audit flow builder paths.');
    if (recommendations.length === 0) recommendations.push('System operating within optimal parameters.');

    res.json({
      success: true,
      footprint: {
        accuracy,
        totalAI: aiHandledConversations,
        totalConversations,
        corrections,
        dropOffs,
        status,
        recommendations
      }
    });
  } catch (err) {
    console.error('[BotQuality] Footprint Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @route   GET /api/bot-quality/conversations/flagged
 * @desc    Get conversations where bot escalated, intent confidence was low, or customer frustrated
 */
router.get('/conversations/flagged', protect, async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    if (!clientId) return res.status(400).json({ success: false, message: 'ClientId required' });

    // Flagged conditions:
    // 1. botPaused = true (escalated to human)
    // 2. Or, last node visited triggered an error/fallback.
    
    // Using a simpler approach to fetch conversations that didn't resolve cleanly
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const flagged = await Conversation.find({
      clientId,
      createdAt: { $gte: thirtyDaysAgo },
      $or: [
        { botPaused: true },
        { status: 'open' } // Assuming open and old = abandoned/frustrated
      ]
    })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

    // Map to the requested frontend structure
    const formatted = flagged.map(conv => ({
      id: conv._id,
      customerName: conv.customerName || conv.phone,
      phone: conv.phone,
      triggerPhrase: conv.lastMessage || 'N/A',
      reason: conv.botPaused ? 'Escalated to Human' : 'Abandoned/Unresolved',
      timestamp: conv.updatedAt
    }));

    res.json({ success: true, conversations: formatted });
  } catch (err) {
    console.error('[BotQuality] Flagged Conversations Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
