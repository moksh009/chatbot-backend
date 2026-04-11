"use strict";
const AdLead = require("../models/AdLead");

/**
 * Builds the atomic aggregation pipeline for lead scoring.
 */
function buildScoringPipeline(incrementFields = {}, stringUpdates = {}, rtoUpdate = {}) {
  const stage1SetFields = {};

  // Stage 1: Increments
  for (const [field, inc] of Object.entries(incrementFields)) {
    stage1SetFields[field] = { $add: [{ $ifNull: [`$${field}`, 0] }, inc] };
  }

  // Stage 1: String/Date updates
  for (const [field, val] of Object.entries(stringUpdates)) {
    stage1SetFields[field] = (val instanceof Date) ? val : val;
  }

  // Stage 1: RTO Risk
  if (rtoUpdate.isRtoRisk) {
    stage1SetFields.isRtoRisk = true;
  }

  // Stage 2: Scoring Logic (Strict 0-100)
  const stage2Score = {
    $switch: {
      branches: [
        { case: { $gte: ["$ordersCount", 5] }, then: 100 },
        { case: { $gte: ["$ordersCount", 2] }, then: 85 },
        { case: { $eq: ["$ordersCount", 1] }, then: 70 },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "abandoned"] },
              { $gt: ["$inboundMessageCount", 10] }
            ]
          },
          then: 50
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $gt: ["$addToCartCount", 0] },
              { $ne: ["$cartStatus", "abandoned"] }
            ]
          },
          then: 30
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$addToCartCount", 0] },
              { $gt: ["$linkClicks", 0] }
            ]
          },
          then: 10
        }
      ],
      default: 0
    }
  };

  // Stage 2: Intent State Logic
  const stage2Intent = {
    $switch: {
      branches: [
        { case: { $gte: ["$ordersCount", 5] }, then: "VIP" },
        { case: { $gte: ["$ordersCount", 2] }, then: "Repeat Customer" },
        { case: { $eq: ["$ordersCount", 1] }, then: "Customer" },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "abandoned"] },
              { $gt: ["$inboundMessageCount", 10] }
            ]
          },
          then: "High Intent"
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $gt: ["$addToCartCount", 0] },
              { $ne: ["$cartStatus", "abandoned"] }
            ]
          },
          then: "Considering"
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$addToCartCount", 0] },
              { $gt: ["$linkClicks", 0] }
            ]
          },
          then: "Browsing"
        }
      ],
      default: "Cold"
    }
  };

  // Stage 2: Tag Cleanup (Mutually Exclusive)
  const stage2Tags = {
    $switch: {
      branches: [
        {
          case: { $eq: ["$isRtoRisk", true] },
          then: {
            $setUnion: [
              { $setDifference: [{ $ifNull: ["$tags", []] }, ["customer", "repeat-buyer", "loyal", "warm", "checkout-initiated", "cart-abandoned"]] },
              ["rto-risk"]
            ]
          }
        },
        {
          case: { $gt: ["$ordersCount", 0] },
          then: {
            $setUnion: [
              { $setDifference: [{ $ifNull: ["$tags", []] }, ["checkout-initiated", "cart-abandoned", "warm", "rto-risk"]] },
              ["customer"]
            ]
          }
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "abandoned"] }
            ]
          },
          then: {
            $setUnion: [
              { $setDifference: [{ $ifNull: ["$tags", []] }, ["customer", "checkout-initiated", "warm"]] },
              ["cart-abandoned"]
            ]
          }
        },
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "checkout_started"] }
            ]
          },
          then: {
            $setUnion: [
              { $setDifference: [{ $ifNull: ["$tags", []] }, ["customer", "cart-abandoned"]] },
              ["checkout-initiated"]
            ]
          }
        }
      ],
      default: { $ifNull: ["$tags", []] }
    }
  };

  // Stage 2: Time Waster Flag
  const stage2TimeWaster = {
    $cond: {
      if: { $and: [{ $gt: ["$inboundMessageCount", 40] }, { $eq: ["$ordersCount", 0] }] },
      then: true,
      else: { $ifNull: ["$isTimeWaster", false] }
    }
  };

  const pipeline = [];

  if (Object.keys(stage1SetFields).length > 0) {
    pipeline.push({ $set: stage1SetFields });
  }

  pipeline.push({
    $set: {
      leadScore: stage2Score,
      intentState: stage2Intent,
      tags: stage2Tags,
      isTimeWaster: stage2TimeWaster,
      lastScoredAt: new Date()
    }
  });

  return pipeline;
}

/**
 * Universal wrapper for updating leads atomically.
 */
async function updateLeadWithScoring(phoneNumber, clientId, incrementFields = {}, stringUpdates = {}, booleanUpdates = {}, options = { new: true, upsert: false }) {
  try {
    const pipeline = buildScoringPipeline(incrementFields, stringUpdates, booleanUpdates);

    const updatedLead = await AdLead.findOneAndUpdate(
      { phoneNumber, clientId },
      pipeline, 
      options
    );

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
  let processed = 0;
  let page = 0;
  const pageSize = 100;

  while (true) {
    const leads = await AdLead.find({ clientId })
      .select("_id isRtoRisk")
      .skip(page * pageSize)
      .limit(pageSize)
      .lean();

    if (!leads.length) break;

    const bulkOps = leads.map(lead => ({
      updateOne: {
        filter: { _id: lead._id },
        update: buildScoringPipeline({}, {}, { isRtoRisk: lead.isRtoRisk })
      }
    }));

    await AdLead.bulkWrite(bulkOps, { ordered: false });
    processed += leads.length;
    page++;
  }

  return processed;
}

module.exports = { buildScoringPipeline, updateLeadWithScoring, recomputeAllScores };
