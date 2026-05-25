const ScoreTierConfig = require('../../models/ScoreTierConfig');
const AdLead = require('../../models/AdLead');
const {
  evaluateCustomerScore,
  evaluateCustomerScoreDetailed,
  intentStateFromWaterfall,
} = require('../../services/ScoreEvaluationService');
const { buildWaterfallScoreBreakdown } = require('./waterfallScoreBreakdown');

/**
 * Enterprise Scoring — canonical Waterfall Engine (ScoreEvaluationService).
 * Use this module for all score recomputes (webhooks, CRM breakdown, batch jobs).
 */

async function loadTierConfig(clientId) {
  const doc = await ScoreTierConfig.findOne({ clientId }).lean();
  return doc || ScoreTierConfig.getDefaultConfig(clientId);
}

const recalculateLeadScore = async (clientId, phoneNumber) => {
  try {
    const lead = await AdLead.findOne({ clientId, phoneNumber });
    if (!lead) {
      console.warn(`[RECOMPUTE_SCORE] Lead not found: ${phoneNumber} for client ${clientId}`);
      return null;
    }
    const updated = await recomputeLeadScoreDocument(lead);
    return updated?.leadScore ?? null;
  } catch (err) {
    console.error(`[RECOMPUTE_SCORE] Failed for ${phoneNumber}:`, err.message);
    return null;
  }
};

/**
 * Recompute one lead by document or id; persists score, label, waterfall breakdown.
 */
async function recomputeLeadScoreDocument(leadIdOrLead) {
  const lead =
    typeof leadIdOrLead === 'object' && leadIdOrLead?._id
      ? leadIdOrLead
      : await AdLead.findById(leadIdOrLead).lean();
  if (!lead) return null;

  const tierConfig = await loadTierConfig(lead.clientId);
  const evaluation = evaluateCustomerScoreDetailed(lead, tierConfig);
  const breakdown = buildWaterfallScoreBreakdown(lead, evaluation);
  const intentState = breakdown.intent_state || intentStateFromWaterfall(evaluation.score, evaluation.label);

  const updated = await AdLead.findOneAndUpdate(
    { _id: lead._id, clientId: lead.clientId },
    {
      $set: {
        leadScore: evaluation.score,
        scoreLabel: evaluation.label,
        intentState,
        scoreBreakdown: breakdown,
        lastScoredAt: new Date(),
        scoringEngine: 'waterfall',
      },
    },
    { new: true }
  ).lean();

  try {
    const { recomputeLeadPredictions } = require('../../services/predictive/heuristic');
    await recomputeLeadPredictions(updated);
  } catch (_) {
    /* non-blocking */
  }

  return updated;
}

/**
 * Batch recompute all leads for a tenant (Intent Simulator save, deploy hooks).
 */
async function recomputeAllWaterfallScores(clientId) {
  const tierConfig = await loadTierConfig(clientId);
  const totalLeads = await AdLead.countDocuments({ clientId });
  const batchSize = 100;
  let processed = 0;

  for (let skip = 0; skip < totalLeads; skip += batchSize) {
    const leads = await AdLead.find({ clientId }).skip(skip).limit(batchSize).lean();
    const bulkOps = [];

    for (const lead of leads) {
      const evaluation = evaluateCustomerScoreDetailed(lead, tierConfig);
      const breakdown = buildWaterfallScoreBreakdown(lead, evaluation);
      bulkOps.push({
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              leadScore: evaluation.score,
              scoreLabel: evaluation.label,
              intentState: breakdown.intent_state,
              scoreBreakdown: breakdown,
              lastScoredAt: new Date(),
              scoringEngine: 'waterfall',
            },
          },
        },
      });
    }

    if (bulkOps.length) await AdLead.bulkWrite(bulkOps);
    processed += leads.length;

    if (global.io) {
      const percent = totalLeads ? Math.round((processed / totalLeads) * 100) : 100;
      global.io.to(`client_${clientId}`).emit('scoring_recompute_progress', {
        percent,
        processed,
        totalLeads,
      });
    }
  }

  if (global.io) {
    global.io.to(`client_${clientId}`).emit('scoring_recompute_complete', { totalLeads: processed });
  }

  return processed;
}

module.exports = {
  recalculateLeadScore,
  recomputeLeadScoreDocument,
  recomputeAllWaterfallScores,
  evaluateCustomerScore,
  evaluateCustomerScoreDetailed,
  buildWaterfallScoreBreakdown,
};
