"use strict";

const BotAnalytics = require('../models/BotAnalytics');
const TrainingCase = require('../models/TrainingCase');
const Conversation = require('../models/Conversation');

/**
 * INTELLIGENCE FOOTPRINT ENGINE
 * Analyzes bot performance, drop-offs, and required improvements.
 */
async function getBotEfficiency(clientId) {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // 1. AI Score Analysis
        const aiStats = await BotAnalytics.aggregate([
            { $match: { clientId, event: { $in: ['AI_SUCCESS', 'AI_FAILURE'] }, createdAt: { $gte: thirtyDaysAgo } } },
            { $group: { _id: '$event', count: { $sum: 1 } } }
        ]);

        const successes = aiStats.find(s => s._id === 'AI_SUCCESS')?.count || 0;
        const failures = aiStats.find(s => s._id === 'AI_FAILURE')?.count || 0;
        const totalAI = successes + failures;
        const aiAccuracy = totalAI > 0 ? (successes / totalAI) * 100 : 100;

        // 2. Correction Analysis (Human Agent Feedback)
        const corrections = await TrainingCase.countDocuments({ clientId, createdAt: { $gte: thirtyDaysAgo } });

        // 3. Drop-off Analysis (Where users stop responding)
        // We look for conversations where the lastStepId is not null and it was >= 24h ago
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        
        const dropOffs = await Conversation.aggregate([
            { $match: { clientId, lastStepId: { $ne: null }, lastMessageAt: { $lt: oneDayAgo, $gte: thirtyDaysAgo } } },
            { $group: { _id: '$lastStepId', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);

        // 4. Structured Recommendations (The "What to Improve" part)
        const recommendations = [];
        if (aiAccuracy < 90) recommendations.push({ action: 'retrain_ai', priority: 'High', reason: 'AI Accuracy dropped below 90%' });
        if (corrections > 10) recommendations.push({ action: 'review_corrections', priority: 'Medium', reason: `${corrections} manual corrections await review.` });
        
        if (dropOffs.length > 0) {
            recommendations.push({ 
                action: 'optimize_flow', 
                priority: 'High', 
                reason: `Users frequently drop off at node "${dropOffs[0]._id}". Consider simplifying the message.` 
            });
        }

        return {
            accuracy: aiAccuracy.toFixed(1),
            totalAI,
            corrections,
            dropOffs,
            recommendations,
            status: aiAccuracy > 95 ? 'Great' : (aiAccuracy > 80 ? 'Good' : 'Needs Work')
        };
    } catch (err) {
        console.error('[FootprintEngine] Error:', err.message);
        return null;
    }
}

module.exports = { getBotEfficiency };
