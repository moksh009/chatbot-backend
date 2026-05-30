'use strict';

const crypto = require('crypto');
const KnowledgeDocument = require('../../models/KnowledgeDocument');
const { embedText, EMBEDDING_DIM } = require('./gemini');
const { resolveApiKeyForClient } = require('../../services/ai/aiWalletService');
const { getAppRedis } = require('./redisFactory');
const { callAI, logEmbeddingUsage } = require('./aiGateway');

const QUERY_CACHE_TTL_SEC = 300;

function chunkText(text, maxChunkSize = 400, overlap = 50) {
  const sentences = String(text || '').match(/[^.!?]+[.!?]+/g) || [String(text || '')];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      const words = current.split(' ');
      current = `${words.slice(-Math.floor(overlap / 5)).join(' ')} ${sentence}`;
    } else {
      current += `${sentence} `;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA?.length || !vecB?.length || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cacheKey(clientId, query) {
  const hash = crypto.createHash('sha256').update(`${clientId}:${query}`).digest('hex');
  return `rag:embed:${hash}`;
}

async function getCachedEmbedding(clientId, query) {
  try {
    const redis = getAppRedis();
    if (!redis) return null;
    const raw = await redis.get(cacheKey(clientId, query));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function setCachedEmbedding(clientId, query, embedding) {
  try {
    const redis = getAppRedis();
    if (!redis || !embedding) return;
    await redis.set(cacheKey(clientId, query), JSON.stringify(embedding), 'EX', QUERY_CACHE_TTL_SEC);
  } catch (_) {}
}

async function embedQuery(clientId, query) {
  const cached = await getCachedEmbedding(clientId, query);
  if (cached) return cached;

  const resolved = await resolveApiKeyForClient(clientId, { requireGemini: true });
  if (!resolved.configured) return null;

  const result = await embedText(query, resolved.apiKey);
  if (!result?.embedding) return null;

  await logEmbeddingUsage(clientId, query.length, true);

  await setCachedEmbedding(clientId, query, result.embedding);
  return result.embedding;
}

async function embedDocumentChunks(clientId, chunks) {
  const resolved = await resolveApiKeyForClient(clientId, { requireGemini: true });
  if (!resolved.configured) {
    throw new Error('AI_NOT_CONFIGURED');
  }
  const embedded = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await embedText(chunks[i], resolved.apiKey);
    if (!result?.embedding) {
      await logEmbeddingUsage(clientId, chunks[i].length, false, 'EMBED_FAILED');
      throw new Error(`Embedding failed at chunk ${i}`);
    }
    await logEmbeddingUsage(clientId, chunks[i].length, true);
    embedded.push({
      text: chunks[i],
      embedding: result.embedding,
      chunkIndex: i,
    });
  }
  return embedded;
}

async function retrieveKnowledge(clientId, query, topK = 3) {
  const queryEmbedding = await embedQuery(clientId, query);
  if (!queryEmbedding) return [];

  const docs = await KnowledgeDocument.find({
    clientId,
    status: 'active',
    embeddingStatus: 'complete',
    'chunks.0': { $exists: true },
  }).lean();

  const scored = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks || []) {
      if (!chunk.embedding?.length) continue;
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      scored.push({
        score,
        text: chunk.text,
        documentId: doc._id,
        title: doc.title,
        chunkIndex: chunk.chunkIndex,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

async function processDocumentEmbedding(documentId) {
  const doc = await KnowledgeDocument.findById(documentId);
  if (!doc) return;

  await KnowledgeDocument.updateOne(
    { _id: documentId },
    { $set: { embeddingStatus: 'pending', updatedAt: new Date() } }
  );

  try {
    const chunks = chunkText(doc.content);
    const embedded = await embedDocumentChunks(doc.clientId, chunks);
    await KnowledgeDocument.updateOne(
      { _id: documentId },
      {
        $set: {
          chunks: embedded,
          totalChunks: embedded.length,
          embeddingStatus: 'complete',
          embeddingProvider: 'gemini',
          embeddingDimensions: embedded[0]?.embedding?.length || EMBEDDING_DIM,
          characterCount: doc.content.length,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    await KnowledgeDocument.updateOne(
      { _id: documentId },
      { $set: { embeddingStatus: 'failed', updatedAt: new Date() } }
    );

    try {
      const NotificationService = require('./notificationService');
      await NotificationService.createNotification(doc.clientId, {
        type: 'system',
        title: 'Knowledge document embedding failed',
        message: `We had trouble processing "${doc.title}" for AI retrieval. Open AI Brain → Knowledge to review.`,
        metadata: { documentId: doc._id, feature: 'knowledge_embedding' },
      });
    } catch (_) {}

    throw err;
  }
}

async function runKnowledgeTest(clientId, question) {
  const chunks = await retrieveKnowledge(clientId, question, 5);
  const context = chunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n\n');

  let answer = null;
  if (context) {
    const result = await callAI({
      clientId,
      feature: 'knowledge_test',
      systemPrompt: 'Answer using ONLY the provided knowledge chunks. If the answer is not in the chunks, say you do not have that information.',
      prompt: `KNOWLEDGE CHUNKS:\n${context}\n\nQUESTION: ${question}\n\nANSWER:`,
      maxTokens: 400,
      temperature: 0.2,
    });
    answer = result.content;
  }

  return { chunks, answer, hasContext: chunks.length > 0 };
}

async function getKnowledgeStats(clientId) {
  const [activeDocs, allActive] = await Promise.all([
    KnowledgeDocument.countDocuments({ clientId, status: 'active' }),
    KnowledgeDocument.find({ clientId, status: 'active' }).select('characterCount embeddingStatus').lean(),
  ]);

  const totalChars = allActive.reduce((sum, d) => sum + (d.characterCount || 0), 0);
  const embeddedComplete = allActive.filter((d) => d.embeddingStatus === 'complete').length;
  const contextBudgetPct = Math.min(100, Math.round((totalChars / 50000) * 100));

  return {
    activeDocuments: activeDocs,
    totalCharacters: totalChars,
    contextBudgetPct,
    embeddingComplete: embeddedComplete,
    embeddingTotal: allActive.length,
  };
}

module.exports = {
  chunkText,
  cosineSimilarity,
  embedQuery,
  embedDocumentChunks,
  retrieveKnowledge,
  processDocumentEmbedding,
  runKnowledgeTest,
  getKnowledgeStats,
};
