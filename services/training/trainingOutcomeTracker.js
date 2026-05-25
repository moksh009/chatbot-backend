'use strict';

const Message = require('../../models/Message');
const TrainingCase = require('../../models/TrainingCase');
const log = require('../../utils/core/logger')('TrainingOutcome');

const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

async function findRecentBotMessagesWithTraining(clientId, phone, since) {
  return Message.find({
    clientId,
    direction: 'outgoing',
    trainingContext: { $exists: true, $ne: [] },
    timestamp: { $gte: since },
    $or: [{ to: phone }, { from: 'BOT' }],
  })
    .sort({ timestamp: -1 })
    .limit(20)
    .select('trainingContext timestamp')
    .lean();
}

async function incrementOutcomes(caseIds, field) {
  const unique = [...new Set(caseIds.map(String).filter(Boolean))];
  if (!unique.length) return;
  await TrainingCase.updateMany(
    { _id: { $in: unique } },
    { $inc: { [field]: 1 } }
  );
}

async function applyOutcome(clientId, phone, type) {
  const since = new Date(Date.now() - OUTCOME_WINDOW_MS);
  const msgs = await findRecentBotMessagesWithTraining(clientId, phone, since);
  if (!msgs.length) return;
  const caseIds = [];
  for (const m of msgs) {
    for (const id of m.trainingContext || []) caseIds.push(id);
  }
  if (!caseIds.length) return;
  const field = type === 'positive' ? 'helpfulCount' : 'lessHelpfulCount';
  await incrementOutcomes(caseIds, field);
}

async function recordPositiveOutcome(clientId, phone) {
  try {
    await applyOutcome(clientId, phone, 'positive');
  } catch (e) {
    log.warn(`recordPositiveOutcome: ${e.message}`);
  }
}

async function recordNegativeOutcome(clientId, phone) {
  try {
    await applyOutcome(clientId, phone, 'negative');
  } catch (e) {
    log.warn(`recordNegativeOutcome: ${e.message}`);
  }
}

async function recordOrderPositiveOutcome(clientId, phone) {
  return recordPositiveOutcome(clientId, phone);
}

async function recordSentimentOutcome(clientId, phone, score) {
  if (score > 70) return recordPositiveOutcome(clientId, phone);
  if (score < 30) return recordNegativeOutcome(clientId, phone);
}

module.exports = {
  recordPositiveOutcome,
  recordNegativeOutcome,
  recordOrderPositiveOutcome,
  recordSentimentOutcome,
  OUTCOME_WINDOW_MS,
};
