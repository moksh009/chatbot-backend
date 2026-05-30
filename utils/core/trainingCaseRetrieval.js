'use strict';

const TrainingCase = require('../../models/TrainingCase');

async function getRelevantTrainingCases(clientId, userMessage, client, limit = 3) {
  const keywords = String(userMessage || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (!keywords.length) return [];

  const pending = await TrainingCase.find({
    clientId,
    status: 'active',
    $or: keywords.map((k) => ({ userMessage: new RegExp(k, 'i') })),
  })
    .limit(limit)
    .lean();
  return pending;
}

function buildTrainingFewShot(cases) {
  if (!cases?.length) return '';
  const lines = cases.map(
    (c) => `Customer: "${c.userMessage}"\nBetter reply: "${c.agentCorrection || c.correctContent || c.content}"`
  );
  return `\n\nAPPROVED TRAINING EXAMPLES:\n${lines.join('\n\n')}\n`;
}

module.exports = { getRelevantTrainingCases, buildTrainingFewShot };
