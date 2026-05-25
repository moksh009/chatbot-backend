'use strict';

const TrainingCase = require('../../models/TrainingCase');
const ClientPersonaEvolution = require('../../models/ClientPersonaEvolution');
const Client = require('../../models/Client');

async function generateForClient(clientId) {
  const cases = await TrainingCase.find({
    clientId,
    status: { $in: ['approved', 'active'] },
    $or: [{ helpfulCount: { $gt: 0 } }, { lessHelpfulCount: { $gt: 0 } }],
  })
    .sort({ helpfulCount: -1 })
    .limit(50)
    .lean();

  if (cases.length < 20) return null;

  const helpful = cases.filter((c) => (c.helpfulCount || 0) > (c.lessHelpfulCount || 0)).slice(0, 20);
  const poor = cases.filter((c) => (c.lessHelpfulCount || 0) >= (c.helpfulCount || 0)).slice(0, 10);

  const client = await Client.findOne({ clientId }).select('ai.persona ai.systemPrompt').lean();
  const current = client?.ai?.persona?.description || client?.ai?.systemPrompt || '';

  let personaText = current;
  try {
    const { platformGenerateJSON } = require('../../utils/core/gemini');
    const out = await platformGenerateJSON({
      clientId,
      purpose: 'persona_evolution',
      prompt: `Current persona:\n${current}\n\nSuccessful corrections:\n${helpful.map((c) => c.correctContent || c.content).join('\n---\n')}\n\nPoor bot replies:\n${poor.map((c) => c.originalContent).join('\n---\n')}\n\nReturn JSON { "personaText": "updated persona description" } emphasizing what worked and avoiding failures.`,
    });
    personaText = out?.personaText || personaText;
  } catch {
    personaText = `${current}\n\nEmphasize clarity and brevity based on ${helpful.length} successful agent corrections.`;
  }

  const last = await ClientPersonaEvolution.findOne({ clientId }).sort({ version: -1 }).lean();
  const version = (last?.version || 0) + 1;

  return ClientPersonaEvolution.create({
    clientId,
    version,
    personaText,
    previousPersonaText: current,
    basedOn: { trainingCaseIds: cases.map((c) => String(c._id)), messageCount: cases.length },
    status: 'pending',
  });
}

async function runPersonaEvolutionBatch(limit = 20) {
  const clientIds = await TrainingCase.distinct('clientId');
  let generated = 0;
  for (const clientId of clientIds.slice(0, limit)) {
    const count = await TrainingCase.countDocuments({ clientId, status: { $in: ['approved', 'active'] } });
    if (count < 50) continue;
    const doc = await generateForClient(clientId);
    if (doc) generated += 1;
  }
  return generated;
}

module.exports = { runPersonaEvolutionBatch, generateForClient };
