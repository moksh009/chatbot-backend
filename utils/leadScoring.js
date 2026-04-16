"use strict";
const AdLead = require("../models/AdLead");

/**
 * Lead Scoring Weight Matrix (Phase 3 Enterprise Standards)
 */
const SCORING_WEIGHTS = {
  INBOUND_MESSAGE: 2,        // +2 per message
  LINK_CLICK: 5,             // +5 per CTA link click
  PRODUCT_VIEW: 3,           // +3 per catalog view
  ADD_TO_CART: 15,           // +15 per ATC
  CHECKOUT_INITIATED: 35,    // +35 per Checkout Attempt
  ORDER_COMPLETED: 50,       // Reset/Conversion High Point
  APPOINTMENT_BOOKED: 40,    // High intent conversion
  POSITIVE_SENTIMENT: 10,    // AI detected positive sentiment
  NEGOTIATION_ATTEMPT: 20    // High interest indicator
};

const SCORE_CAP = 100;

/**
 * Builds the atomic aggregation pipeline for lead scoring.
 * Integrates with AI Intent and Sentiment data.
 */
function buildScoringPipeline(incrementFields = {}, stringUpdates = {}, booleanUpdates = {}, extraData = {}) {
  const stage1SetFields = {};

  // Stage 0: Basic Increments
  for (const [field, inc] of Object.entries(incrementFields)) {
    stage1SetFields[field] = { $add: [{ $ifNull: [`$${field}`, 0] }, inc] };
  }

  // Stage 0: Basic Attribute Updates
  for (const [field, val] of Object.entries(stringUpdates)) {
    stage1SetFields[field] = val;
  }

  // Stage 0: Advanced NLP Integration (Sentiment/Intent)
  if (extraData.sentimentScore !== undefined) stage1SetFields.sentimentScore = extraData.sentimentScore;
  if (extraData.inboundIntent) stage1SetFields.inboundIntent = extraData.inboundIntent;

  // Logic Phase: calculateLeadScore
  const calculateLeadScore = {
    $min: [
      SCORE_CAP,
      {
        $add: [
          // Basic engagement (Messages capped at 20 pts)
          { $min: [20, { $multiply: [{ $ifNull: ["$inboundMessageCount", 0] }, SCORING_WEIGHTS.INBOUND_MESSAGE] }] },
          // High intent triggers
          { $multiply: [{ $ifNull: ["$linkClicks", 0] }, SCORING_WEIGHTS.LINK_CLICK] },
          { $multiply: [{ $ifNull: ["$addToCartCount", 0] }, SCORING_WEIGHTS.ADD_TO_CART] },
          { $multiply: [{ $ifNull: ["$checkoutInitiatedCount", 0] }, SCORING_WEIGHTS.CHECKOUT_INITIATED] },
          // Appointment Bonus
          { $multiply: [{ $ifNull: ["$appointmentsBooked", 0] }, SCORING_WEIGHTS.APPOINTMENT_BOOKED] },
          // Sentiment Bonus (if > 80 sentiment, add 10 points)
          { $cond: [{ $gt: [{ $ifNull: ["$sentimentScore", 50] }, 80] }, SCORING_WEIGHTS.POSITIVE_SENTIMENT, 0] },
          // Manual VIP override via tags
          { $cond: [{ $in: ["VIP", { $ifNull: ["$tags", []] }] }, 50, 0] }
        ]
      }
    ]
  };

  // Logic Phase: deriveIntentState (Phase 3: NLP-First)
  const deriveIntentState = {
    $cond: [
      { $and: [{ $ne: [{ $ifNull: ["$inboundIntent", ""] }, ""] }, { $ne: ["$inboundIntent", "general"] }] },
      { $toUpper: "$inboundIntent" }, // Prioritize NLP detected intent
      {
        $switch: {
          branches: [
            { case: { $gte: [calculateLeadScore, 90] }, then: "HOT (VIP)" },
            { case: { $gte: [calculateLeadScore, 70] }, then: "HOT" },
            { case: { $gte: [calculateLeadScore, 40] }, then: "WARM" },
            { case: { $gte: [calculateLeadScore, 10] }, then: "ENGAGED" },
            { case: { $and: [{ $eq: ["$cartStatus", "abandoned"] }, { $lt: [calculateLeadScore, 70] }] }, then: "ABANDONED" }
          ],
          default: "COLD"
        }
      }
    ]
  };

  const pipeline = [];
  if (Object.keys(stage1SetFields).length > 0) {
    pipeline.push({ $set: stage1SetFields });
  }

  pipeline.push({
    $set: {
      leadScore: calculateLeadScore,
      intentState: deriveIntentState,
      lastScoredAt: new Date()
    }
  });

  return pipeline;
}

/**
 * Universal wrapper for updating leads atomically with the new scoring engine.
 */
async function updateLeadWithScoring(phoneNumber, clientId, incrementFields = {}, stringUpdates = {}, extraData = {}) {
  try {
    const pipeline = buildScoringPipeline(incrementFields, stringUpdates, {}, extraData);

    const updatedLead = await AdLead.findOneAndUpdate(
      { phoneNumber, clientId },
      pipeline, 
      { new: true, upsert: true }
    );

    // If score crossed threshold to HOT, emit real-time pulse
    if (updatedLead && updatedLead.leadScore >= 70) {
        const { logPulse } = require('./activityLogger');
        await logPulse(clientId, {
            type: 'SYSTEM',
            title: 'High Intent Detected', 
            message: `Lead ${phoneNumber} just crossed score threshold: ${updatedLead.leadScore}`, 
            status: 'success', 
            metadata: { leadId: updatedLead._id, score: updatedLead.leadScore }
        });
    }

    return updatedLead;
  } catch (err) {
    console.error("[LeadScoring] Update failed:", err.message);
    return null;
  }
}

/**
 * Recomputes scores for all leads for a specific client.
 */
async function recomputeAllScores(clientId) {
  const leads = await AdLead.find({ clientId });
  let processed = 0;
  for (const lead of leads) {
      await updateLeadWithScoring(lead.phoneNumber, clientId, {}, {});
      processed++;
  }
  return processed;
}

module.exports = { buildScoringPipeline, updateLeadWithScoring, recomputeAllScores };
