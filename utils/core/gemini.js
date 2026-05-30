const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require('./logger')("Gemini");
const { geminiBreaker } = require('./circuitBreaker');

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
        return await geminiBreaker.call(fn);
    } catch (err) {
        const msg = err?.message || "";
        if (msg.includes("[CircuitBreaker]") && msg.includes("OPEN")) {
            logger.warn("Gemini circuit open — skipping AI call");
            return null;
        }
        throw err;
    }
}

/**
 * generateText - Core hybrid wrapper.
 * Routes to Vertex AI if it's the platform key, otherwise AI Studio.
 */
async function generateText(prompt, apiKey, options = {}) {
    const {
        maxTokens   = 1024,
        temperature = 0.7,
        timeout     = options.fast ? AI_BOT_TIMEOUT_MS : AI_BATCH_TIMEOUT_MS,
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
        timeout     = options.fast ? AI_BOT_TIMEOUT_MS : AI_BATCH_TIMEOUT_MS,
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
        if (noEnvFallback) return null;
        activeKey = platformKey;
    }

    const vertexInstance = getVertexInstance();
    const useVertex = (isPlatform || activeKey === platformKey) && !!vertexInstance;
    const activeModel = model || resolveModel({ isPlatform, fast });

    if (!useVertex && noEnvFallback && !isKeyValid(activeKey)) {
        return null;
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
                    if (!isKeyValid(currentKey)) return null;

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
                if (msg.includes("429") || msg.includes("RATE_LIMIT") || msg.includes("quota")) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                    continue;
                }
                if (msg.includes("timeout")) continue;
                if (msg.includes("API_KEY_INVALID") || msg.includes("invalid")) {
                    studioClientCache.delete(activeKey);
                    break;
                }
            }
        }
        logger.error("All AI attempts exhausted:", lastError?.message);
        return null;
    });
}

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
const EMBEDDING_DIM = 768;

async function embedText(text, apiKey, options = {}) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!isKeyValid(key)) return null;

    const input = String(text || '').trim().slice(0, 8000);
    if (!input) return null;

    return safeBreakerCall(async () => {
        try {
            const genAI = getStudioClient(key);
            const model = genAI.getGenerativeModel({ model: options.model || EMBEDDING_MODEL });
            const result = await Promise.race([
                model.embedContent(input),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Embedding timeout')), options.timeout || 15000)),
            ]);
            const values = result?.embedding?.values;
            if (!Array.isArray(values) || values.length === 0) return null;
            return { embedding: values, dimensions: values.length };
        } catch (err) {
            logger.error('embedText failed:', err.message);
            return null;
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
