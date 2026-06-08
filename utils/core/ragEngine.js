'use strict';

const crypto = require('crypto');
const KnowledgeDocument = require('../../models/KnowledgeDocument');
const Client = require('../../models/Client');
const { embedText, embedTextsBatch, EMBEDDING_DIM } = require('./gemini');
const { embedTextOpenAI } = require('./openaiProvider');
const { resolveApiKeyForClient } = require('../../services/ai/aiWalletService');
const { getAppRedis } = require('./redisFactory');
const { callAI } = require('./aiGateway');
const { formatReplyForWhatsApp, resolveQuickFaqReply } = require('./personaEngine');
const { mapRagReasonToUserMessage, isAiProviderError } = require('./aiProviderErrors');

const QUERY_CACHE_TTL_SEC = 300;
const MIN_VECTOR_SCORE = 0.12;
const RAG_NOTIFY_TTL_SEC = 3600;

class RagUnavailableError extends Error {
  constructor(reason, meta = {}) {
    super('RAG_UNAVAILABLE');
    this.name = 'RagUnavailableError';
    this.code = 'RAG_UNAVAILABLE';
    this.reason = reason;
    this.meta = meta;
    this.userMessage = mapRagReasonToUserMessage(reason, meta);
  }
}

function isRagUnavailableError(err) {
  return err?.code === 'RAG_UNAVAILABLE' || err instanceof RagUnavailableError;
}

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

  const resolved = await resolveApiKeyForClient(clientId);
  if (!resolved.configured) {
    throw new RagUnavailableError('ai_not_configured');
  }

  let embedding = null;
  try {
    if (resolved.provider === 'openai') {
      const result = await embedTextOpenAI(query, resolved.apiKey);
      if (!result?.embedding) {
        throw new Error('OpenAI query embedding returned empty');
      }
      embedding = result.embedding;
    } else {
      const result = await embedText(query, resolved.apiKey, { taskType: 'RETRIEVAL_QUERY' });
      embedding = result?.embedding || null;
    }
  } catch (err) {
    const detail = isAiProviderError(err)
      ? err.userMessage
      : (err.message || 'Embedding request failed');
    throw new RagUnavailableError('query_embed_failed', {
      detail,
      provider: err.provider || resolved.provider,
      code: err.code || null,
    });
  }

  if (!embedding?.length) {
    throw new RagUnavailableError('query_embed_failed');
  }

  await setCachedEmbedding(clientId, query, embedding);
  return embedding;
}

async function embedDocumentChunks(clientId, chunks) {
  const resolved = await resolveApiKeyForClient(clientId);
  if (!resolved.configured) {
    throw new Error('AI_NOT_CONFIGURED');
  }

  if (!chunks.length) {
    throw new Error('Document has no embeddable text');
  }

  if (resolved.provider === 'openai') {
    const embedded = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await embedTextOpenAI(chunks[i], resolved.apiKey);
      if (!result?.embedding) {
        throw new Error(`OpenAI embedding failed at chunk ${i + 1} of ${chunks.length}. Check your API key in AI Setup.`);
      }
      embedded.push({
        text: chunks[i],
        embedding: result.embedding,
        chunkIndex: i,
      });
    }
    return embedded;
  }

  try {
    const batch = await embedTextsBatch(chunks, resolved.apiKey, { taskType: 'RETRIEVAL_DOCUMENT' });
    return batch.map((item, i) => ({
      text: chunks[i],
      embedding: item.embedding,
      chunkIndex: i,
    }));
  } catch (err) {
    const hint = 'Check GEMINI_EMBEDDING_MODEL=gemini-embedding-001 in your server env and verify embedding access on your Gemini key.';
    throw new Error(`${err.message || 'Gemini batch embedding failed'}. ${hint}`);
  }
}

async function countVectorReadyDocs(clientId) {
  return KnowledgeDocument.countDocuments({
    clientId,
    status: 'active',
    embeddingStatus: 'complete',
    embeddingProvider: { $nin: ['keyword'] },
    totalChunks: { $gt: 0 },
    'chunks.embedding.0': { $exists: true },
  });
}

async function getActiveKnowledgeHealth(clientId) {
  const [active, vectorReady, pending, processing, failed] = await Promise.all([
    KnowledgeDocument.countDocuments({ clientId, status: 'active' }),
    countVectorReadyDocs(clientId),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'pending' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'processing' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'failed' }),
  ]);
  return { active, vectorReady, pending, processing, failed };
}

async function assertVectorCorpusReady(clientId) {
  const health = await getActiveKnowledgeHealth(clientId);

  if (health.active === 0) {
    throw new RagUnavailableError('no_active_documents', health);
  }
  if (health.pending > 0 || health.processing > 0) {
    throw new RagUnavailableError('embedding_in_progress', health);
  }
  if (health.failed > 0) {
    throw new RagUnavailableError('embedding_failed', health);
  }
  if (health.vectorReady === 0) {
    throw new RagUnavailableError('vector_store_empty', health);
  }
  return health;
}

async function notifyRagFailure(clientId, reason) {
  try {
    const redis = getAppRedis();
    if (redis) {
      const key = `rag:notify:${clientId}`;
      const seen = await redis.get(key);
      if (seen) return;
      await redis.set(key, String(reason || 'unknown'), 'EX', RAG_NOTIFY_TTL_SEC);
    }
    const NotificationService = require('./notificationService');
    await NotificationService.createNotification(clientId, {
      type: 'system',
      title: 'Knowledge Base unavailable',
      message: mapRagReasonToUserMessage(reason),
      metadata: { feature: 'rag', reason: reason || 'unknown' },
    });
  } catch (_) {}
}

async function vectorRetrieveWithEmbedding(clientId, queryEmbedding, topK = 5) {
  const docs = await KnowledgeDocument.find({
    clientId,
    status: 'active',
    embeddingStatus: 'complete',
    embeddingProvider: { $nin: ['keyword'] },
    'chunks.embedding.0': { $exists: true },
  }).lean();

  const scored = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks || []) {
      if (!chunk.embedding?.length) continue;
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score < MIN_VECTOR_SCORE) continue;
      scored.push({
        score,
        text: chunk.text,
        documentId: doc._id,
        title: doc.title,
        chunkIndex: chunk.chunkIndex,
        mode: 'vector',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Strict vector-only retrieval. No keyword, catalog, or raw-text fallbacks.
 * Throws RagUnavailableError if corpus is unhealthy or vector search returns zero hits.
 */
async function retrieveKnowledge(clientId, query, topK = 3, options = {}) {
  const { skipIfNoCorpus = false } = options;
  const health = await getActiveKnowledgeHealth(clientId);

  if (health.vectorReady === 0) {
    if (skipIfNoCorpus || health.active === 0) return [];
  }

  await assertVectorCorpusReady(clientId);

  const queryEmbedding = await embedQuery(clientId, query);
  const vectorHits = await vectorRetrieveWithEmbedding(clientId, queryEmbedding, topK);

  if (!vectorHits.length) {
    throw new RagUnavailableError('zero_vector_hits', { query: String(query).slice(0, 120) });
  }

  return vectorHits;
}

async function buildProductCatalog(clientId) {
  const client = await Client.findOne({ clientId })
    .select('knowledgeBase.products nicheData.products shopDomain businessName')
    .lean();
  if (!client) return [];

  const fromKb = (client.knowledgeBase?.products || []).map((p) => ({
    name: p.name || p.title,
    price: p.price,
    description: p.description,
    url: p.url,
  }));

  const fromNiche = (client.nicheData?.products || []).map((p) => ({
    name: p.title || p.name,
    price: p.price,
    description: p.description || p.body_html,
    url: p.url || (p.handle && client.shopDomain ? `https://${client.shopDomain}/products/${p.handle}` : null),
  }));

  const merged = [...fromKb, ...fromNiche].filter((p) => p.name);
  const seen = new Set();
  return merged.filter((p) => {
    const key = String(p.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getKnowledgeTestDiagnostics(clientId) {
  const health = await getActiveKnowledgeHealth(clientId);
  const draft = await KnowledgeDocument.countDocuments({ clientId, status: 'draft' });
  const gemini = await resolveApiKeyForClient(clientId);
  const products = await buildProductCatalog(clientId);

  const diagnostics = [];
  if (draft > 0) diagnostics.push(`${draft} document(s) still in draft — activate them to include in retrieval.`);
  if (health.pending > 0) diagnostics.push(`${health.pending} active document(s) still embedding — wait or click Re-embed.`);
  if (health.processing > 0) diagnostics.push(`${health.processing} document(s) embedding in progress.`);
  if (health.failed > 0) diagnostics.push(`${health.failed} document(s) failed embedding — fix API key and Re-embed.`);
  if (health.active > 0 && health.vectorReady === 0) {
    diagnostics.push('Vector index is empty — embeddings must complete before AI can answer from documents.');
  }
  if (!gemini.configured) diagnostics.push('Connect an API key in AI Setup — embeddings and vector search require a valid key.');
  if (health.active === 0 && products.length === 0) diagnostics.push('Import website pages or add documents to build knowledge.');

  return {
    active: health.active,
    draft,
    pending: health.pending,
    failed: health.failed,
    complete: health.vectorReady,
    geminiConfigured: gemini.configured,
    productCount: products.length,
    diagnostics,
  };
}

const STALE_PROCESSING_MS = 5 * 60 * 1000;
const STALE_FAIL_MESSAGE = 'Embedding timed out. Verify your API key in AI Setup, then click Re-embed on this document.';

async function failStaleProcessingDocuments(clientId) {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  await KnowledgeDocument.updateMany(
    {
      clientId,
      status: 'active',
      embeddingStatus: 'processing',
      embeddingStartedAt: { $lt: staleBefore },
    },
    {
      $set: {
        embeddingStatus: 'failed',
        embeddingError: STALE_FAIL_MESSAGE,
        updatedAt: new Date(),
      },
    }
  );
}

async function claimDocumentForEmbedding(documentId, { force = false } = {}) {
  const now = new Date();

  if (force) {
    return KnowledgeDocument.findOneAndUpdate(
      {
        _id: documentId,
        status: 'active',
      },
      {
        $set: {
          embeddingStatus: 'processing',
          embeddingError: null,
          embeddingStartedAt: now,
          updatedAt: now,
        },
      },
      { new: true }
    );
  }

  // Only claim fresh pending docs — never auto-retry failed or in-flight processing.
  return KnowledgeDocument.findOneAndUpdate(
    {
      _id: documentId,
      status: 'active',
      embeddingStatus: 'pending',
    },
    {
      $set: {
        embeddingStatus: 'processing',
        embeddingError: null,
        embeddingStartedAt: now,
        updatedAt: now,
      },
    },
    { new: true }
  );
}

async function processDocumentEmbedding(documentId, options = {}) {
  const { force = false } = options;
  const doc = await claimDocumentForEmbedding(documentId, { force });
  if (!doc) return;

  try {
    const resolved = await resolveApiKeyForClient(doc.clientId);
    const chunks = chunkText(doc.content);

    if (!resolved.configured) {
      await KnowledgeDocument.updateOne(
        { _id: documentId },
        {
          $set: {
            chunks: [],
            totalChunks: 0,
            embeddingStatus: 'failed',
            embeddingError: 'Connect a Gemini or OpenAI key in AI Setup to embed documents.',
            characterCount: doc.content.length,
            updatedAt: new Date(),
          },
        }
      );
      return;
    }

    const embedded = await embedDocumentChunks(doc.clientId, chunks);
    await KnowledgeDocument.updateOne(
      { _id: documentId },
      {
        $set: {
          chunks: embedded,
          totalChunks: embedded.length,
          embeddingStatus: 'complete',
          embeddingProvider: resolved.provider || 'gemini',
          embeddingDimensions: embedded[0]?.embedding?.length || EMBEDDING_DIM,
          embeddingError: null,
          characterCount: doc.content.length,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    const errorMessage = String(err.message || 'Embedding failed').slice(0, 500);
    await KnowledgeDocument.updateOne(
      { _id: documentId },
      {
        $set: {
          embeddingStatus: 'failed',
          embeddingError: errorMessage,
          characterCount: doc.content.length,
          updatedAt: new Date(),
        },
      }
    );

    const alreadyFailed = doc.embeddingStatus === 'failed' && doc.embeddingError;
    if (!alreadyFailed) {
      try {
        const NotificationService = require('./notificationService');
        await NotificationService.createNotification(doc.clientId, {
          type: 'system',
          title: 'Knowledge document embedding failed',
          message: `We had trouble processing "${doc.title}" for AI retrieval. Open AI Brain → Knowledge to review.`,
          metadata: { documentId: doc._id, feature: 'knowledge_embedding' },
        });
      } catch (_) {}
    }
  }
}

async function runKnowledgeTest(clientId, question) {
  const client = await Client.findOne({ clientId }).select('ai.persona knowledgeBase.faqs businessName clientId').lean();
  const faqResolved = client ? resolveQuickFaqReply(client, question, client.ai?.persona) : { direct: false };
  if (faqResolved.direct) {
    return {
      chunks: [],
      answer: faqResolved.reply,
      hasContext: true,
      hint: null,
      diagnostics: [],
      retrievalMode: 'faq',
      productsUsed: [],
      matchedFaq: { question: faqResolved.faqMatch.question, direct: true },
    };
  }

  const diagnosticsMeta = await getKnowledgeTestDiagnostics(clientId);
  const chunks = await retrieveKnowledge(clientId, question, 5);
  const context = chunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n\n');

  if (!context?.trim()) {
    throw new RagUnavailableError('empty_context');
  }

  const anyAi = await resolveApiKeyForClient(clientId);
  if (!anyAi.configured) {
    throw new RagUnavailableError('ai_not_configured');
  }

  const result = await callAI({
    clientId,
    feature: 'knowledge_test',
    systemPrompt: 'Answer using ONLY the provided knowledge chunks. If the answer is not in the context, say clearly that you do not have that information yet.',
    prompt: `KNOWLEDGE CHUNKS:\n${context}\n\nQUESTION: ${question}\n\nANSWER:`,
    maxTokens: 500,
    temperature: 0.2,
  });
  const answer = formatReplyForWhatsApp(result.content);

  return {
    chunks,
    answer,
    hasContext: true,
    hint: null,
    diagnostics: diagnosticsMeta.diagnostics,
    retrievalMode: 'vector',
    productsUsed: [],
  };
}

async function syncProductCatalogDocument(clientId) {
  const products = await buildProductCatalog(clientId);
  if (!products.length) {
    return { synced: false, message: 'No products found. Connect Shopify and sync products first.' };
  }

  const lines = products.map((p) => {
    const price = p.price != null && p.price !== '' ? ` — ₹${p.price}` : '';
    const desc = p.description ? `\n  ${String(p.description).slice(0, 200)}` : '';
    const url = p.url ? `\n  ${p.url}` : '';
    return `- ${p.name}${price}${desc}${url}`;
  });

  const content = `Product catalog (${products.length} items)\n\n${lines.join('\n\n')}`.slice(0, 20000);
  const title = 'Product catalog';

  let doc = await KnowledgeDocument.findOne({ clientId, source: 'manual', title }).sort({ updatedAt: -1 });
  if (doc) {
    await KnowledgeDocument.updateOne(
      { _id: doc._id },
      {
        $set: {
          content,
          characterCount: content.length,
          status: 'active',
          embeddingStatus: 'pending',
          chunks: [],
          updatedAt: new Date(),
        },
      }
    );
    doc = await KnowledgeDocument.findById(doc._id);
  } else {
    doc = await KnowledgeDocument.create({
      clientId,
      title,
      content,
      status: 'active',
      source: 'manual',
      characterCount: content.length,
      embeddingStatus: 'pending',
    });
  }

  const { queueDocumentEmbedding } = require('../../workers/knowledgeEmbeddingQueues');
  await queueDocumentEmbedding(doc._id.toString(), clientId);

  return { synced: true, documentId: doc._id, productCount: products.length };
}

async function getKnowledgeStats(clientId) {
  const [activeDocs, allActive, vectorReady] = await Promise.all([
    KnowledgeDocument.countDocuments({ clientId, status: 'active' }),
    KnowledgeDocument.find({ clientId, status: 'active' }).select('characterCount embeddingStatus totalChunks embeddingProvider').lean(),
    countVectorReadyDocs(clientId),
  ]);

  const totalChars = allActive.reduce((sum, d) => sum + (d.characterCount || 0), 0);
  const contextBudgetPct = Math.min(100, Math.round((totalChars / 50000) * 100));

  return {
    activeDocuments: activeDocs,
    totalCharacters: totalChars,
    contextBudgetPct,
    embeddingComplete: vectorReady,
    embeddingTotal: allActive.length,
    vectorReady,
  };
}

module.exports = {
  chunkText,
  cosineSimilarity,
  embedQuery,
  embedDocumentChunks,
  retrieveKnowledge,
  processDocumentEmbedding,
  failStaleProcessingDocuments,
  runKnowledgeTest,
  getKnowledgeStats,
  buildProductCatalog,
  syncProductCatalogDocument,
  countVectorReadyDocs,
  getActiveKnowledgeHealth,
  notifyRagFailure,
  RagUnavailableError,
  isRagUnavailableError,
};
