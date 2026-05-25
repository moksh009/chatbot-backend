'use strict';

const TrainingCase = require('../../models/TrainingCase');
const { generateText } = require('./gemini');

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedText(text, client) {
  const key = client?.ai?.geminiKey || client?.geminiApiKey || process.env.GEMINI_API_KEY;
  const prompt = `Return ONLY a JSON array of 32 numbers between -1 and 1 representing embedding for: "${String(text).slice(0, 200)}"`;
  try {
    const raw = await generateText(prompt, key);
    const arr = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    if (Array.isArray(arr) && arr.length >= 8) return arr.slice(0, 32);
  } catch (_) {}
  return null;
}

async function getRelevantTrainingCases(clientId, userMessage, client, limit = 3) {
  const active = await TrainingCase.find({ clientId, status: 'active' }).limit(50).lean();
  if (!active.length) {
    const keywords = String(userMessage || '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const pending = await TrainingCase.find({
      clientId,
      status: 'active',
      $or: keywords.map((k) => ({ userMessage: new RegExp(k, 'i') })),
    })
      .limit(limit)
      .lean();
    return pending;
  }
  const queryEmb = await embedText(userMessage, client);
  if (!queryEmb) return active.slice(0, limit);
  const scored = active
    .map((c) => ({
      ...c,
      similarity: cosineSimilarity(queryEmb, c.embedding || []),
    }))
    .sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

function buildTrainingFewShot(cases) {
  if (!cases?.length) return '';
  const lines = cases.map(
    (c) => `Customer: "${c.userMessage}"\nBetter reply: "${c.agentCorrection}"`
  );
  return `\n\nAPPROVED TRAINING EXAMPLES:\n${lines.join('\n\n')}\n`;
}

module.exports = { getRelevantTrainingCases, buildTrainingFewShot, embedText };
