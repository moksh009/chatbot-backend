'use strict';

const crypto = require('crypto');
const KnowledgeDocument = require('../../models/KnowledgeDocument');
const Client = require('../../models/Client');
const { embedText, EMBEDDING_DIM } = require('./gemini');
const { embedTextOpenAI } = require('./openaiProvider');
const { resolveApiKeyForClient } = require('../../services/ai/aiWalletService');
const { getAppRedis } = require('./redisFactory');
const { callAI, logEmbeddingUsage } = require('./aiGateway');

const QUERY_CACHE_TTL_SEC = 300;
const MIN_VECTOR_SCORE = 0.12;

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
  if (!resolved.configured) return null;

  let embedding = null;
  if (resolved.provider === 'openai') {
    const result = await embedTextOpenAI(query, resolved.apiKey);
    embedding = result?.embedding || null;
  } else {
    const result = await embedText(query, resolved.apiKey);
    embedding = result?.embedding || null;
  }
  if (!embedding) return null;

  await logEmbeddingUsage(clientId, query.length, true, null, resolved.provider);

  await setCachedEmbedding(clientId, query, embedding);
  return embedding;
}

async function embedDocumentChunks(clientId, chunks) {
  const resolved = await resolveApiKeyForClient(clientId);
  if (!resolved.configured) {
    throw new Error('AI_NOT_CONFIGURED');
  }
  const embedded = [];
  for (let i = 0; i < chunks.length; i++) {
    let result = null;
    if (resolved.provider === 'openai') {
      result = await embedTextOpenAI(chunks[i], resolved.apiKey);
    } else {
      result = await embedText(chunks[i], resolved.apiKey);
    }
    if (!result?.embedding) {
      await logEmbeddingUsage(clientId, chunks[i].length, false, 'EMBED_FAILED', resolved.provider);
      throw new Error(`Embedding failed at chunk ${i}`);
    }
    await logEmbeddingUsage(clientId, chunks[i].length, true, null, resolved.provider);
    embedded.push({
      text: chunks[i],
      embedding: result.embedding,
      chunkIndex: i,
    });
  }
  return embedded;
}

function expandQueryTokens(query) {
  const base = tokenizeQuery(query);
  const extra = [];
  for (const t of base) {
    if (t.endsWith('s') && t.length > 4) extra.push(t.slice(0, -1));
    if (t.endsWith('ies')) extra.push(t.slice(0, -3) + 'y');
  }
  return [...new Set([...base, ...extra])];
}

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\w\s₹]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !['what', 'which', 'your', 'have', 'does', 'the', 'and', 'for'].includes(t));
}

function snippetAround(text, token, maxLen = 420) {
  const src = String(text || '');
  const idx = src.toLowerCase().indexOf(String(token || '').toLowerCase());
  if (idx < 0) return src.slice(0, maxLen);
  const start = Math.max(0, idx - 120);
  return `${start > 0 ? '…' : ''}${src.slice(start, start + maxLen).trim()}${start + maxLen < src.length ? '…' : ''}`;
}

async function keywordRetrieve(clientId, query, topK = 5) {
  const tokens = expandQueryTokens(query);
  const qLower = String(query || '').toLowerCase().trim();

  const docs = await KnowledgeDocument.find({
    clientId,
    status: 'active',
    content: { $exists: true, $ne: '' },
  }).lean();

  const scored = [];
  for (const doc of docs) {
    const hay = String(doc.content || '').toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (hay.includes(t)) hits += 1;
    }
    if (qLower.length > 8 && hay.includes(qLower.slice(0, Math.min(qLower.length, 48)))) {
      hits += 2;
    }
    if (hits === 0) continue;
    const firstHit = tokens.find((t) => hay.includes(t)) || tokens[0] || qLower.slice(0, 20);
    scored.push({
      score: hits / Math.max(tokens.length, 1),
      text: snippetAround(doc.content, firstHit),
      documentId: doc._id,
      title: doc.title,
      chunkIndex: 0,
      mode: 'keyword',
    });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length) return scored.slice(0, topK);

  // Last resort: surface active docs so tests work before embeddings finish.
  const fallback = docs.slice(0, topK).map((doc) => ({
    score: 0.08,
    text: snippetAround(doc.content, qLower.slice(0, 24) || 'the', 480),
    documentId: doc._id,
    title: doc.title,
    chunkIndex: 0,
    mode: 'keyword',
  }));
  return fallback;
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

function productChunksForQuery(products, query) {
  if (!products.length) return [];
  const q = String(query || '').toLowerCase();
  const isProductQuestion = /product|sell|catalog|item|sku|price|buy|stock|available/.test(q);
  if (!isProductQuestion) return [];

  const lines = products.slice(0, 40).map((p) => {
    const price = p.price != null && p.price !== '' ? ` — ₹${p.price}` : '';
    const desc = p.description ? `: ${String(p.description).slice(0, 120)}` : '';
    const url = p.url ? ` (${p.url})` : '';
    return `${p.name}${price}${desc}${url}`;
  });

  return [{
    score: 0.95,
    text: lines.join('\n'),
    documentId: 'product_catalog',
    title: 'Product catalog',
    chunkIndex: 0,
    mode: 'catalog',
  }];
}

async function vectorRetrieve(clientId, query, topK = 5) {
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

async function retrieveKnowledge(clientId, query, topK = 3) {
  const [vectorHits, keywordHits, products] = await Promise.all([
    vectorRetrieve(clientId, query, topK).catch(() => []),
    keywordRetrieve(clientId, query, topK),
    buildProductCatalog(clientId),
  ]);

  const catalogHits = productChunksForQuery(products, query);
  const merged = [...catalogHits, ...vectorHits];

  for (const kw of keywordHits) {
    const dup = merged.some((m) => String(m.documentId) === String(kw.documentId) && m.text === kw.text);
    if (!dup) merged.push(kw);
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, Math.max(topK, catalogHits.length ? 6 : topK));
}

async function getKnowledgeTestDiagnostics(clientId) {
  const [active, draft, pending, failed, complete] = await Promise.all([
    KnowledgeDocument.countDocuments({ clientId, status: 'active' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'draft' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'pending' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'failed' }),
    KnowledgeDocument.countDocuments({ clientId, status: 'active', embeddingStatus: 'complete' }),
  ]);
  const gemini = await resolveApiKeyForClient(clientId);
  const products = await buildProductCatalog(clientId);

  const diagnostics = [];
  if (draft > 0) diagnostics.push(`${draft} document(s) still in draft — activate them to include in retrieval.`);
  if (pending > 0) diagnostics.push(`${pending} active document(s) still processing — refresh in a moment.`);
  if (failed > 0) diagnostics.push(`${failed} document(s) failed embedding — use Re-embed on the document row.`);
  if (!gemini.configured) diagnostics.push('Connect an API key in AI Setup for vector search and AI-generated answers. Keyword search still works.');
  if (active === 0 && products.length === 0) diagnostics.push('Import website pages or add documents to build knowledge.');

  return { active, draft, pending, failed, complete, geminiConfigured: gemini.configured, productCount: products.length, diagnostics };
}

async function processDocumentEmbedding(documentId) {
  const doc = await KnowledgeDocument.findById(documentId);
  if (!doc) return;

  await KnowledgeDocument.updateOne(
    { _id: documentId },
    { $set: { embeddingStatus: 'pending', updatedAt: new Date() } }
  );

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
            embeddingStatus: 'complete',
            embeddingProvider: 'keyword',
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
          characterCount: doc.content.length,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    const isConfig = err.message === 'AI_NOT_CONFIGURED' || err.code === 'AI_NOT_CONFIGURED';
    await KnowledgeDocument.updateOne(
      { _id: documentId },
      {
        $set: {
          embeddingStatus: isConfig ? 'complete' : 'failed',
          embeddingProvider: isConfig ? 'keyword' : undefined,
          characterCount: doc.content.length,
          updatedAt: new Date(),
        },
      }
    );

    if (!isConfig) {
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
}

async function runKnowledgeTest(clientId, question) {
  const diagnosticsMeta = await getKnowledgeTestDiagnostics(clientId);
  const products = await buildProductCatalog(clientId);
  const chunks = await retrieveKnowledge(clientId, question, 5);
  const context = chunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n\n');

  let answer = null;
  let hint = null;

  if (!context && diagnosticsMeta.diagnostics.length) {
    hint = diagnosticsMeta.diagnostics.join(' ');
  }

  const anyAi = await resolveApiKeyForClient(clientId);
  if (context && anyAi.configured) {
    const result = await callAI({
      clientId,
      feature: 'knowledge_test',
      systemPrompt: 'Answer using ONLY the provided knowledge chunks and product catalog. If the answer is not in the context, say clearly that you do not have that information yet. List product names when asked about products.',
      prompt: `KNOWLEDGE CHUNKS:\n${context}\n\nQUESTION: ${question}\n\nANSWER:`,
      maxTokens: 500,
      temperature: 0.2,
    });
    answer = result.content;
  } else if (context && !anyAi.configured) {
    hint = 'Add a Gemini or OpenAI key in AI Setup to generate an AI answer. Retrieved context is shown below.';
  }

  const retrievalMode = [
    chunks.some((c) => c.mode === 'catalog') && 'catalog',
    chunks.some((c) => c.mode === 'vector') && 'vector',
    chunks.some((c) => c.mode === 'keyword') && 'keyword',
  ].filter(Boolean).join('+') || 'none';

  const productsUsed = chunks.some((c) => c.mode === 'catalog')
    ? products.slice(0, 12)
    : [];

  return {
    chunks,
    answer,
    hasContext: chunks.length > 0,
    hint,
    diagnostics: diagnosticsMeta.diagnostics,
    retrievalMode,
    productsUsed,
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
  buildProductCatalog,
  syncProductCatalogDocument,
  keywordRetrieve,
};
