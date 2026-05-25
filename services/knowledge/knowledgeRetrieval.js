'use strict';

const KnowledgeDocument = require('../../models/KnowledgeDocument');
const { generateText } = require('../../utils/core/gemini');

const CHUNK_SIZE = 500;

function chunkText(text) {
  const parts = String(text || '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > CHUNK_SIZE) {
      if (buf) chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function embedChunk(text, client) {
  const key = client?.ai?.geminiKey || process.env.GEMINI_API_KEY;
  const prompt = `Return ONLY JSON array of 24 floats -1..1 for: "${text.slice(0, 300)}"`;
  try {
    const raw = await generateText(prompt, key);
    return JSON.parse(String(raw).replace(/```json|```/g, '').trim());
  } catch {
    return [];
  }
}

async function ensureDocumentChunks(doc, client) {
  if (doc.chunks?.length) return doc;
  const chunks = chunkText(doc.content || doc.body || '');
  const enriched = [];
  for (let i = 0; i < chunks.length; i += 1) {
    enriched.push({
      index: i,
      text: chunks[i],
      embedding: await embedChunk(chunks[i], client),
    });
  }
  await KnowledgeDocument.updateOne({ _id: doc._id }, { $set: { chunks: enriched } });
  return { ...doc.toObject?.() || doc, chunks: enriched };
}

async function retrieveKnowledge(clientId, query, client, limit = 3) {
  const docs = await KnowledgeDocument.find({ clientId, isActive: { $ne: false } }).limit(20);
  const all = [];
  for (const doc of docs) {
    const withChunks = await ensureDocumentChunks(doc, client);
    for (const ch of withChunks.chunks || []) {
      all.push({ docId: doc._id, title: doc.title, text: ch.text, embedding: ch.embedding });
    }
  }
  const qEmb = await embedChunk(query, client);
  const ranked = all
    .map((c) => ({
      ...c,
      score: qEmb?.length
        ? c.embedding?.reduce((s, v, i) => s + v * (qEmb[i] || 0), 0)
        : c.text.toLowerCase().includes(query.toLowerCase())
        ? 1
        : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  for (const hit of ranked) {
    await KnowledgeDocument.updateOne({ _id: hit.docId }, { $set: { lastUsedAt: new Date() } });
  }
  return ranked;
}

function formatCitations(chunks) {
  if (!chunks?.length) return '';
  const title = chunks[0].title || 'our policy';
  return `\n\n(Based on ${title})`;
}

module.exports = { chunkText, retrieveKnowledge, formatCitations, ensureDocumentChunks };
