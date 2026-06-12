const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const logger = require('./logger')("Gemini");
const { geminiBreaker } = require('./circuitBreaker');
const {
    AiProviderError,
    classifyAiError,
    isNonTransientAiError,
    isQuotaOrBillingError,
} = require('./aiProviderErrors');

// Dynamically load Vertex AI for enterprise GCP credit usage
let VertexAI;
try {
    VertexAI = require("@google-cloud/vertexai").VertexAI;
} catch (e) {
    logger.warn("VertexAI SDK not found. Fallback to AI Studio for all calls.");
}

/** Live WhatsApp / tenant bot — fast + cheap */
const BOT_MODEL_FAST =
  process.env.GEMINI_BOT_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash-lite";

/** Platform dashboard / batch jobs — higher quality */
const PLATFORM_MODEL =
  process.env.GEMINI_VERTEX_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";


const AI_BOT_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS || 12000);
const AI_BATCH_TIMEOUT_MS = Number(process.env.AI_BATCH_TIMEOUT_MS || 35000);

// Cache AI Studio clients to avoid memory leaks
const studioClientCache = new Map();

function getStudioClient(apiKey) {
    if (!apiKey) return null;
    if (!studioClientCache.has(apiKey)) {
        studioClientCache.set(apiKey, new GoogleGenerativeAI(apiKey));
    }
    return studioClientCache.get(apiKey);
}

// Initialize Vertex AI for the Platform (Uses GCP Credits)
let vertexPlatformInstance = null;
let vertexDeprecationLogged = false;
let vertexDisabledUntilMs = 0;
const VERTEX_AUTH_BACKOFF_MS = Number(process.env.VERTEX_AUTH_BACKOFF_MS || 10 * 60 * 1000);

function getVertexInstance() {
    if (Date.now() < vertexDisabledUntilMs) return null;
    if (vertexPlatformInstance) return vertexPlatformInstance;

    const projectId = process.env.GCP_PROJECT_ID;
    const region    = process.env.GCP_REGION || 'us-central1';

    if (VertexAI && projectId) {
        try {
            const config = {
                project: projectId,
                location: region
            };

            if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
                try {
                    const keyData = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
                    config.googleAuthOptions = { credentials: keyData };
                    logger.info("Using GCP Service Account from environment variable.");
                } catch (parseErr) {
                    logger.error("Failed to parse GCP_SERVICE_ACCOUNT_KEY as JSON:", parseErr.message);
                }
            }

            vertexPlatformInstance = new VertexAI(config);
            if (!vertexDeprecationLogged) {
              vertexDeprecationLogged = true;
              logger.warn(
                "VertexAI SDK is deprecated — platform calls still work; migrate to @google/genai when upgrading dependencies."
              );
            }
            logger.info(`✅ Vertex AI initialized for project: ${projectId} (${region})`);
            return vertexPlatformInstance;
        } catch (err) {
            logger.error("❌ Vertex AI Initialization Failed:", err.message);
        }
    }
    return null;
}

function isKeyValid(key) {
    if (!key || typeof key !== 'string') return false;
    const trimmed = key.trim();
    if (trimmed.length < 30) return false;
    if (!trimmed.startsWith("AIza")) return false;
    if (trimmed.includes("ENTER_YOUR") || trimmed.includes("YOUR_API_KEY") || trimmed.includes("GEMINI_KEY")) return false;
    return true;
}

function resolveModel(options = {}) {
    if (options.model) return options.model;
    if (options.isPlatform) return PLATFORM_MODEL;
    return options.fast ? BOT_MODEL_FAST : BOT_MODEL_FAST;
}

async function safeBreakerCall(fn) {
    try {
        return await geminiBreaker.call(fn, {
            shouldCountFailure: (err) => !isNonTransientAiError(err),
        });
    } catch (err) {
        throw classifyAiError(err, { provider: 'gemini' });
    }
}

function throwGeminiFailure(lastError, options = {}) {
    if (lastError) {
        throw classifyAiError(lastError, { provider: 'gemini', ...options });
    }
    throw new AiProviderError('AI_EMPTY_RESPONSE', { provider: 'gemini', ...options });
}

/**
 * generateText - Core hybrid wrapper.
 * Routes to Vertex AI if it's the platform key, otherwise AI Studio.
 */
async function generateText(prompt, apiKey, options = {}) {
    const {
        maxTokens   = 1024,
        temperature = 0.7,
        timeout     = options.timeout ?? (options.fast ? AI_BOT_TIMEOUT_MS : AI_BATCH_TIMEOUT_MS),
        maxRetries  = 2,
        isPlatform  = false,
        noEnvFallback = false,
        fast        = false,
        model       = null,
        systemInstruction = null,
        responseMimeType  = null,
    } = options;

    let activeKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const platformKey = process.env.GEMINI_API_KEY?.trim();

    if (!activeKey) {
        if (noEnvFallback) {
            return null;
        }
        activeKey = platformKey;
    }

    const vertexInstance = getVertexInstance();
    const useVertex = (isPlatform || activeKey === platformKey) && !!vertexInstance;
    const activeModel = model || resolveModel({ isPlatform, fast });

    if (!useVertex && noEnvFallback && !isKeyValid(activeKey)) {
        return null;
    }

    try {
    return await safeBreakerCall(async () => {
    const safePrompt = String(prompt)
        .replace(/ignore (previous|all) instructions/gi, "[filtered]")
        .replace(/system prompt/gi, "[filtered]")
        .substring(0, 15000);

    const generationConfig = {
        maxOutputTokens: maxTokens,
        temperature,
    };
    if (responseMimeType) {
        generationConfig.responseMimeType = responseMimeType;
    }

    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            let result;

            if (useVertex && attempt === 1) {
                const modelConfig = {
                    model: activeModel,
                    generationConfig,
                };
                if (systemInstruction) {
                    modelConfig.systemInstruction = systemInstruction;
                }
                const vertexModel = vertexInstance.getGenerativeModel(modelConfig);

                result = await Promise.race([
                    vertexModel.generateContent(safePrompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Vertex timeout")), timeout))
                ]);

                const response = result.response;
                if (response.candidates && response.candidates.length > 0) {
                    return response.candidates[0].content.parts[0].text?.trim() || null;
                }
                return (typeof response.text === 'function' ? response.text().trim() : null);

            } else {
                const currentKey = (attempt > 1 && useVertex) ? platformKey : activeKey;

                if (!isKeyValid(currentKey)) {
                    return null;
                }

                const genAI = getStudioClient(currentKey);
                const modelConfig = {
                    model: activeModel,
                    generationConfig,
                };
                if (systemInstruction) {
                    modelConfig.systemInstruction = systemInstruction;
                }
                const studioModel = genAI.getGenerativeModel(modelConfig);

                result = await Promise.race([
                    studioModel.generateContent(safePrompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeout))
                ]);

                return result.response.text()?.trim() || null;
            }

        } catch (err) {
            lastError = err;
            const msg = err.message || "";

            if (useVertex && attempt === 1 && isKeyValid(platformKey)) {
                logger.warn(`Vertex AI failed, falling back to AI Studio: ${msg}`);
                if (/Unable to authenticate|GoogleAuthError|permission|auth/i.test(msg)) {
                    vertexDisabledUntilMs = Date.now() + VERTEX_AUTH_BACKOFF_MS;
                    logger.warn(
                      `Vertex temporarily disabled for ${Math.round(VERTEX_AUTH_BACKOFF_MS / 1000)}s due to auth failure`
                    );
                }
                continue;
            }

            if (msg.includes("404") || msg.includes("not found")) {
                logger.error(`Model ${activeModel} not found. Attempt ${attempt}`);
                break;
            }
            if (msg.includes("429") || msg.includes("RATE_LIMIT") || msg.includes("quota")) {
                const waitMs = Math.pow(2, attempt) * 1000;
                logger.warn(`Rate limited. Waiting ${waitMs}ms before retry ${attempt}`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            if (msg.includes("timeout")) {
                logger.warn(`Timeout on attempt ${attempt}`);
                continue;
            }
            if (msg.includes("API_KEY_INVALID") || msg.includes("invalid")) {
                logger.error(`Invalid API key. Removing from cache.`);
                studioClientCache.delete(activeKey);
                break;
            }
            logger.error(`Attempt ${attempt} failed:`, msg);
        }
    }

    logger.error("All AI attempts exhausted:", lastError?.message);
    return null;
    });
    } catch (err) {
        logger.error("Gemini generateText failed:", err.userMessage || err.message);
        return null;
    }
}

async function generateJSON(prompt, apiKey, options = {}) {
    const result = await generateText(prompt, apiKey, {
        ...options,
        temperature: 0.1,
        responseMimeType: options.responseMimeType || "application/json",
    });
    if (!result) return null;

    try {
        const clean = result
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/gi, "")
            .trim();
        return JSON.parse(clean);
    } catch (err) {
        logger.error("JSON parse failed. Start of result:", result.slice(0, 100));
        return null;
    }
}

async function generateTextFast(prompt, apiKey, options = {}) {
    return generateText(prompt, apiKey, {
        ...options,
        fast: true,
        timeout: options.timeout ?? AI_BOT_TIMEOUT_MS,
        maxRetries: options.maxRetries ?? 1,
        temperature: options.temperature ?? 0.1,
    });
}

async function generateMultimodal(apiKey, parts, options = {}) {
    const {
        timeout = AI_BATCH_TIMEOUT_MS,
        maxRetries = 1,
        noEnvFallback = false,
        fast = false,
        model = null,
    } = options;

    const activeKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!activeKey && noEnvFallback) return null;
    const key = activeKey || process.env.GEMINI_API_KEY?.trim();
    if (!isKeyValid(key)) return null;

    const activeModel = model || resolveModel({ fast });

    return safeBreakerCall(async () => {
        const genAI = getStudioClient(key);
        const studioModel = genAI.getGenerativeModel({
            model: activeModel,
            generationConfig: {
                maxOutputTokens: options.maxTokens || 1024,
                temperature: options.temperature ?? 0.2,
            },
        });

        let lastError;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                const result = await Promise.race([
                    studioModel.generateContent({ contents: [{ role: "user", parts }] }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeout)),
                ]);
                return result.response.text()?.trim() || null;
            } catch (err) {
                lastError = err;
                if (String(err.message || "").includes("timeout") && attempt <= maxRetries) continue;
                break;
            }
        }
        logger.error("Multimodal AI failed:", lastError?.message);
        return null;
    }).catch((err) => {
        logger.error("Gemini multimodal failed:", err.userMessage || err.message);
        return null;
    });
}

function getGeminiModel(apiKey, modelName) {
    const genAI = getStudioClient(apiKey);
    if (!genAI) return null;
    return genAI.getGenerativeModel({ model: modelName || BOT_MODEL_FAST });
}

async function platformGenerateText(prompt, options = {}) {
    return generateText(prompt, process.env.GEMINI_API_KEY, { ...options, isPlatform: true });
}

async function platformGenerateJSON(prompt, options = {}) {
    return generateJSON(prompt, process.env.GEMINI_API_KEY, { ...options, isPlatform: true });
}

async function botGenerateText(prompt, clientApiKey, options = {}) {
    if (!clientApiKey?.trim()) return null;
    return generateText(prompt, clientApiKey, { ...options, fast: true });
}

async function botGenerateJSON(prompt, clientApiKey, options = {}) {
    if (!clientApiKey?.trim()) return null;
    return generateJSON(prompt, clientApiKey, { ...options, fast: true });
}

function extractUsageMetadata(result) {
    try {
        const meta = result?.response?.usageMetadata;
        if (!meta) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const inputTokens = meta.promptTokenCount || 0;
        const outputTokens = meta.candidatesTokenCount || 0;
        return {
            inputTokens,
            outputTokens,
            totalTokens: meta.totalTokenCount || inputTokens + outputTokens,
        };
    } catch (_) {
        return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
}

/**
 * Same as generateText but returns { content, usage } for metering.
 */
async function generateTextWithUsage(prompt, apiKey, options = {}) {
    const {
        maxTokens   = 1024,
        temperature = 0.7,
        timeout     = options.timeout ?? (options.fast ? AI_BOT_TIMEOUT_MS : AI_BATCH_TIMEOUT_MS),
        maxRetries  = 2,
        isPlatform  = false,
        noEnvFallback = false,
        fast        = false,
        model       = null,
        systemInstruction = null,
        responseMimeType  = null,
    } = options;

    let activeKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const platformKey = process.env.GEMINI_API_KEY?.trim();

    if (!activeKey) {
        if (noEnvFallback) {
            throw new AiProviderError('AI_NOT_CONFIGURED', { provider: 'gemini', operation: 'generate' });
        }
        activeKey = platformKey;
    }

    const vertexInstance = getVertexInstance();
    const useVertex = (isPlatform || activeKey === platformKey) && !!vertexInstance;
    const activeModel = model || resolveModel({ isPlatform, fast });

    if (!useVertex && noEnvFallback && !isKeyValid(activeKey)) {
        throw new AiProviderError('AI_INVALID_KEY', { provider: 'gemini', operation: 'generate' });
    }

    return safeBreakerCall(async () => {
        const safePrompt = String(prompt)
            .replace(/ignore (previous|all) instructions/gi, "[filtered]")
            .replace(/system prompt/gi, "[filtered]")
            .substring(0, 15000);

        const generationConfig = {
            maxOutputTokens: maxTokens,
            temperature,
        };
        if (responseMimeType) {
            generationConfig.responseMimeType = responseMimeType;
        }

        let lastError;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                let result;

                if (useVertex && attempt === 1) {
                    const modelConfig = { model: activeModel, generationConfig };
                    if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
                    const vertexModel = vertexInstance.getGenerativeModel(modelConfig);
                    result = await Promise.race([
                        vertexModel.generateContent(safePrompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Vertex timeout")), timeout)),
                    ]);
                } else {
                    const currentKey = (attempt > 1 && useVertex) ? platformKey : activeKey;
                    if (!isKeyValid(currentKey)) {
                        throw new AiProviderError('AI_INVALID_KEY', { provider: 'gemini', operation: 'generate' });
                    }

                    const genAI = getStudioClient(currentKey);
                    const modelConfig = { model: activeModel, generationConfig };
                    if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
                    const studioModel = genAI.getGenerativeModel(modelConfig);
                    result = await Promise.race([
                        studioModel.generateContent(safePrompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeout)),
                    ]);
                }

                const response = result.response;
                let content = null;
                if (response.candidates && response.candidates.length > 0) {
                    content = response.candidates[0].content.parts[0].text?.trim() || null;
                }
                if (!content && typeof response.text === 'function') {
                    content = response.text()?.trim() || null;
                }

                return {
                    content,
                    usage: extractUsageMetadata(result),
                };
            } catch (err) {
                lastError = err;
                const msg = err.message || "";
                if (useVertex && attempt === 1 && isKeyValid(platformKey)) {
                    logger.warn(`Vertex AI failed, falling back to AI Studio: ${msg}`);
                    continue;
                }
                if (isQuotaOrBillingError(err)) {
                    throw classifyAiError(err, { provider: 'gemini', operation: 'generate' });
                }
                if (msg.includes("429") || msg.includes("RATE_LIMIT") || msg.includes("quota")) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                    continue;
                }
                if (msg.includes("timeout")) continue;
                if (msg.includes("API_KEY_INVALID") || msg.includes("invalid")) {
                    studioClientCache.delete(activeKey);
                    throw classifyAiError(err, { provider: 'gemini', operation: 'generate' });
                }
            }
        }
        logger.error("All AI attempts exhausted:", lastError?.message);
        throwGeminiFailure(lastError, { operation: 'generate' });
    });
}

function resolveEmbeddingModel() {
    const raw = String(process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim();
    const deprecated = new Set([
        'text-embedding-004',
        'embedding-001',
        'models/text-embedding-004',
        'models/embedding-001',
        'gemini-embedding-exp-03-07',
    ]);
    if (deprecated.has(raw) || deprecated.has(raw.replace(/^models\//, ''))) {
        logger.warn(`GEMINI_EMBEDDING_MODEL=${raw} is retired — using gemini-embedding-001`);
        return 'gemini-embedding-001';
    }
    return raw.replace(/^models\//, '');
}

const EMBEDDING_MODEL = resolveEmbeddingModel();
const EMBEDDING_DIM = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 3072);
const EMBED_BATCH_SIZE = Math.min(32, Math.max(4, Number(process.env.GEMINI_EMBED_BATCH_SIZE || 16)));

function buildEmbedRequest(text, taskType = 'RETRIEVAL_DOCUMENT') {
    const req = {
        content: { parts: [{ text: String(text || '').trim().slice(0, 8000) }] },
        taskType,
    };
    if (EMBEDDING_DIM && EMBEDDING_DIM !== 3072) {
        req.outputDimensionality = EMBEDDING_DIM;
    }
    return req;
}

function parseEmbedResponse(data, modelLabel) {
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`Empty embedding response from ${modelLabel}`);
    }
    return { embedding: values, dimensions: values.length };
}

/**
 * Primary embedding path — Gemini v1beta REST (matches current API docs).
 */
async function embedContentRest(text, apiKey, options = {}) {
    const model = (options.model || EMBEDDING_MODEL).replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
    const input = String(text || '').trim().slice(0, 8000);
    if (!input) throw new Error('Empty text — nothing to embed');

    const { data } = await axios.post(
        url,
        buildEmbedRequest(input, options.taskType),
        {
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            timeout: options.timeout || 20000,
        }
    );
    return parseEmbedResponse(data, model);
}

async function batchEmbedContentsRest(texts, apiKey, options = {}) {
    const model = (options.model || EMBEDDING_MODEL).replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
    const inputs = (texts || [])
        .map((t) => String(t || '').trim().slice(0, 8000))
        .filter(Boolean);
    if (!inputs.length) throw new Error('No text chunks to embed');

    const batchSize = options.batchSize || EMBED_BATCH_SIZE;
    const all = [];

    for (let offset = 0; offset < inputs.length; offset += batchSize) {
        const slice = inputs.slice(offset, offset + batchSize);
        const { data } = await axios.post(
            url,
            {
                requests: slice.map((input) => buildEmbedRequest(input, options.taskType)),
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                timeout: options.timeout || 45000,
            }
        );
        const embeddings = data?.embeddings || [];
        if (embeddings.length !== slice.length) {
            throw new Error(`Batch embedding incomplete (${embeddings.length}/${slice.length}) for ${model}`);
        }
        for (let i = 0; i < embeddings.length; i++) {
            const values = embeddings[i]?.values;
            if (!Array.isArray(values) || !values.length) {
                throw new Error(`Empty embedding for chunk ${offset + i + 1}`);
            }
            all.push({ embedding: values, dimensions: values.length });
        }
    }
    return all;
}

async function embedText(text, apiKey, options = {}) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!isKeyValid(key)) {
        throw new AiProviderError('AI_INVALID_KEY', { provider: 'gemini', operation: 'embed' });
    }

    return safeBreakerCall(async () => {
        try {
            return await embedContentRest(text, key, options);
        } catch (restErr) {
            if (isQuotaOrBillingError(restErr)) {
                throw classifyAiError(restErr, { provider: 'gemini', operation: 'embed' });
            }
            logger.warn(`Gemini REST embed failed (${restErr.message}) — trying SDK fallback`);
            const genAI = getStudioClient(key);
            const model = genAI.getGenerativeModel({ model: options.model || EMBEDDING_MODEL });
            const result = await Promise.race([
                model.embedContent(buildEmbedRequest(text, options.taskType)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Embedding timeout')), options.timeout || 20000)),
            ]);
            return parseEmbedResponse({ embedding: result?.embedding }, EMBEDDING_MODEL);
        }
    });
}

/**
 * Embed many chunks in batched Gemini REST calls (1 round-trip per batch).
 */
async function embedTextsBatch(texts, apiKey, options = {}) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!isKeyValid(key)) {
        throw new AiProviderError('AI_INVALID_KEY', { provider: 'gemini', operation: 'embed' });
    }

    return safeBreakerCall(async () => {
        try {
            return await batchEmbedContentsRest(texts, key, options);
        } catch (restErr) {
            if (isQuotaOrBillingError(restErr)) {
                throw classifyAiError(restErr, { provider: 'gemini', operation: 'embed' });
            }
            logger.warn(`Gemini REST batch embed failed (${restErr.message}) — trying SDK fallback`);
            const genAI = getStudioClient(key);
            const model = genAI.getGenerativeModel({ model: options.model || EMBEDDING_MODEL });
            const inputs = (texts || [])
                .map((t) => String(t || '').trim().slice(0, 8000))
                .filter(Boolean);
            const requests = inputs.map((input) => buildEmbedRequest(input, options.taskType));
            const result = await Promise.race([
                model.batchEmbedContents({ requests }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Batch embedding timeout')), options.timeout || 45000)),
            ]);
            const embeddings = result?.embeddings || [];
            if (embeddings.length !== inputs.length) {
                throw new Error(`Batch embedding incomplete (${embeddings.length}/${inputs.length} chunks)`);
            }
            return embeddings.map((item, i) => {
                const values = item?.values;
                if (!Array.isArray(values) || !values.length) {
                    throw new Error(`Empty embedding for chunk ${i + 1}`);
                }
                return { embedding: values, dimensions: values.length };
            });
        }
    });
}

module.exports = {
    getGeminiModel,
    getStudioClient,
    generateText,
    generateJSON,
    generateTextFast,
    generateTextWithUsage,
    generateMultimodal,
    embedText,
    embedTextsBatch,
    platformGenerateText,
    platformGenerateJSON,
    botGenerateText,
    botGenerateJSON,
    isKeyValid,
    BOT_MODEL_FAST,
    PLATFORM_MODEL,
    EMBEDDING_MODEL,
    EMBEDDING_DIM,
    AI_BOT_TIMEOUT_MS,
    AI_BATCH_TIMEOUT_MS,
};
