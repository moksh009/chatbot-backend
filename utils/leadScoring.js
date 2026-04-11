"use strict";
const AdLead = require("../models/AdLead");
const logger  = require("./logger");

/**
 * buildScoringPipeline(incrementFields, stringUpdates, pushFields, rtoUpdate)
 *
 * Returns a MongoDB Aggregation Pipeline Update array.
 * This is a MongoDB 4.2+ feature — the update argument is an array.
 * ALL scoring, tagging, and flag logic runs atomically in ONE DB operation.
 *
 * @param {Object} incrementFields - Fields to increment BEFORE scoring runs
 * @param {Object} stringUpdates - String/value fields to set
 * @param {Object} pushFields - Items to push into arrays (e.g. { activityLog: { action: '...' } })
 * @param {Object} rtoUpdate - Pass { isRtoRisk: true } when an RTO event detected
 */
function buildScoringPipeline(incrementFields = {}, stringUpdates = {}, pushFields = {}, rtoUpdate = {}) {

  // Stage 1: Apply increments, string updates, and pushes atomically
  // This runs BEFORE the score is calculated so the score sees the NEW values
  const stage1SetFields = {};

  for (const [field, inc] of Object.entries(incrementFields)) {
    stage1SetFields[field] = { $add: [{ $ifNull: [`$${field}`, 0] }, inc] };
  }

  for (const [field, val] of Object.entries(stringUpdates)) {
    // For Date values — pass as ISO string, convert here
    stage1SetFields[field] = (val instanceof Date) ? val : val;
  }

  for (const [field, val] of Object.entries(pushFields)) {
    stage1SetFields[field] = { 
      $concatArrays: [{ $ifNull: [`$${field}`, []] }, [val]] 
    };
  }

  if (rtoUpdate.isRtoRisk) {
    stage1SetFields.isRtoRisk = true;
  }

  // Stage 2: Calculate the capped 0-100 score using $switch
  // Evaluated top to bottom — first match wins
  const stage2Score = {
    $switch: {
      branches: [

        // Tier 100: VIP Buyer — 5+ orders
        {
          case: { $gte: ["$ordersCount", 5] },
          then: 100
        },

        // Tier 85: Repeat Buyer — 2-4 orders
        {
          case: { $gte: ["$ordersCount", 2] },
          then: 85
        },

        // Tier 70: First Time Buyer — exactly 1 order
        {
          case: { $eq: ["$ordersCount", 1] },
          then: 70
        },

        // Tier 50: High Intent Cart Abandoner
        // No orders + cart abandoned + 10+ inbound messages
        {
          case: {
            $and: [
              { $eq:  ["$ordersCount", 0] },
              { $eq:  ["$cartStatus", "abandoned"] },
              { $gt:  ["$inboundMessageCount", 10] }
            ]
          },
          then: 50
        },

        // Tier 30: Cart Initiator — added to cart but not abandoned
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

        // Tier 10: Window Shopper — clicked links but no cart action
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
      // Tier 0: Cold / New — everything else
      default: 0
    }
  };

  // Stage 2: Calculate intentState string (mirrors score tiers exactly)
  const stage2Intent = {
    $switch: {
      branches: [
        { case: { $gte: ["$ordersCount", 5] }, then: "VIP" },
        { case: { $gte: ["$ordersCount", 2] }, then: "Repeat Customer" },
        { case: { $eq:  ["$ordersCount", 1] }, then: "Customer" },
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

  // Stage 2: Tag cleanup — mutually exclusive tags only
  // Logic: build the tag array so only the CURRENT correct tag exists
  // Uses $setUnion to add, $setDifference to remove
  const stage2Tags = {
    $switch: {
      branches: [

        // RTO risk — remove customer tag, add rto-risk
        {
          case: { $eq: ["$isRtoRisk", true] },
          then: {
            $setUnion: [
              { $setDifference: ["$tags", ["customer", "repeat-buyer", "loyal", "warm", "checkout-initiated", "cart-abandoned"]] },
              ["rto-risk"]
            ]
          }
        },

        // Customer — remove all intent tags, keep only "customer"
        {
          case: { $gt: ["$ordersCount", 0] },
          then: {
            $setUnion: [
              { $setDifference: ["$tags", ["checkout-initiated", "cart-abandoned", "warm", "rto-risk"]] },
              ["customer"]
            ]
          }
        },

        // Cart abandoned — mark accordingly
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "abandoned"] }
            ]
          },
          then: {
            $setUnion: [
              { $setDifference: ["$tags", ["customer", "checkout-initiated", "warm"]] },
              ["cart-abandoned"]
            ]
          }
        },

        // Checkout initiated
        {
          case: {
            $and: [
              { $eq: ["$ordersCount", 0] },
              { $eq: ["$cartStatus", "checkout_started"] }
            ]
          },
          then: {
            $setUnion: [
              { $setDifference: ["$tags", ["customer", "cart-abandoned"]] },
              ["checkout-initiated"]
            ]
          }
        }
      ],

      // Default — keep existing tags, no change
      default: { $ifNull: ["$tags", []] }
    }
  };

  // Stage 2: Warning flags — high inbound + no purchase = time waster
  const stage2TimeWaster = {
    $cond: {
      if:   { $and: [{ $gt: ["$inboundMessageCount", 40] }, { $eq: ["$ordersCount", 0] }] },
      then: true,
      else: { $ifNull: ["$isTimeWaster", false] }
    }
  };

  // Build the final pipeline stages
  const pipeline = [];

  // Stage 1 only added if there are increments, string updates, or pushes
  if (Object.keys(stage1SetFields).length > 0) {
    pipeline.push({ $set: stage1SetFields });
  }

  // Stage 2: Scoring + tagging + flags (reads values after stage 1 increments)
  pipeline.push({
    $set: {
      leadScore:   stage2Score,
      intentState: stage2Intent,
      tags:        stage2Tags,
      isTimeWaster:stage2TimeWaster,
      lastScoredAt:new Date()
    }
  });

  return pipeline;
}

/**
 * updateLeadWithScoring — the ONLY function that should update lead data.
 * Use this everywhere instead of direct AdLead.findOneAndUpdate calls.
 *
 * @param {string} phoneNumber - Lead's phone number
 * @param {string} clientId    - MongoDB ObjectId string of the client
 * @param {Object} incrementFields - { addToCartCount: 1 } etc.
 * @param {Object} stringUpdates   - { cartStatus: "abandoned" } etc.
 * @param {Object} pushFields      - { activityLog: { action: '...' } } etc.
 * @param {Object} rtoUpdate       - { isRtoRisk: true } for RTO events
 * @returns {Object} Updated lead document
 */
async function updateLeadWithScoring(phoneNumber, clientId, incrementFields = {}, stringUpdates = {}, pushFields = {}, rtoUpdate = {}) {
  try {
    const pipeline = buildScoringPipeline(incrementFields, stringUpdates, pushFields, rtoUpdate);

    const updatedLead = await AdLead.findOneAndUpdate(
      { phoneNumber, clientId },
      pipeline,  // ← Array pipeline = atomic aggregation update (MongoDB 4.2+)
      {
        new:    true,   // Return the updated document
        upsert: true    // Allow upsert here if we want to create leads on-the-fly from webhooks
      }
    );

    return updatedLead;
  } catch (err) {
    logger.error("[LeadScoring] Update failed:", err.message, { phoneNumber, clientId });
    return null;
  }
}

/**
 * recomputeAllScores — run nightly cron to fix any stale scores.
 * Processes in batches of 100 to avoid memory spikes.
 */
async function recomputeAllScores(clientId) {
  logger.info(`[LeadScoring] Starting full recompute for ${clientId}`);
  let processed = 0;
  let page      = 0;
  const pageSize = 100;

  while (true) {
    const leads = await AdLead.find({ clientId })
      .select("_id phoneNumber ordersCount addToCartCount cartStatus inboundMessageCount linkClicks isRtoRisk")
      .skip(page * pageSize)
      .limit(pageSize)
      .lean();

    if (!leads.length) break;

    // Use bulkWrite for maximum efficiency
    const bulkOps = leads.map(lead => ({
      updateOne: {
        filter: { _id: lead._id },
        update: buildScoringPipeline({}, {}, { isRtoRisk: lead.isRtoRisk })
      }
    }));

    await AdLead.bulkWrite(bulkOps, { ordered: false });
    processed += leads.length;
    page++;

    logger.info(`[LeadScoring] Recomputed ${processed} leads...`);
    await new Promise(r => setTimeout(r, 50)); // yield to event loop
  }

  logger.info(`[LeadScoring] Recompute complete. Total: ${processed}`);
  return processed;
}

module.exports = { buildScoringPipeline, updateLeadWithScoring, recomputeAllScores };
