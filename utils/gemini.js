const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger")("Gemini");

// Dynamically load Vertex AI for enterprise GCP credit usage
let VertexAI;
try {
    VertexAI = require("@google-cloud/vertexai").VertexAI;
} catch (e) {
    logger.warn("VertexAI SDK not found. Fallback to AI Studio for all calls.");
}

const PLATFORM_MODEL = "gemini-2.0-flash";  
const BOT_MODEL      = "gemini-1.5-flash"; 

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
function getVertexInstance() {
    if (vertexPlatformInstance) return vertexPlatformInstance;
    
    const projectId = process.env.GCP_PROJECT_ID;
    const region    = process.env.GCP_REGION || 'us-central1';
    
    if (VertexAI && projectId) {
        try {
            const config = {
                project: projectId,
                location: region
            };
            
            // Render/Cloud support: If a service account JSON string is provided, use it
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
            logger.info(`✅ Vertex AI initialized for project: ${projectId} (${region})`);
            return vertexPlatformInstance;
        } catch (err) {
            logger.error("❌ Vertex AI Initialization Failed:", err.message);
        }
    }
    return null;
}

/**
 * helper to validate if a string looks like a real Google AI API key.
 */
function isKeyValid(key) {
    if (!key || typeof key !== 'string') return false;
    const trimmed = key.trim();
    if (trimmed.length < 30) return false;
    if (!trimmed.startsWith("AIza")) return false;
    if (trimmed.includes("ENTER_YOUR") || trimmed.includes("YOUR_API_KEY") || trimmed.includes("GEMINI_KEY")) return false;
    return true;
}

/**
 * generateText - Core hybrid wrapper.
 * Routes to Vertex AI if it's the platform key, otherwise AI Studio.
 */
async function generateText(prompt, apiKey, options = {}) {
    const {
        maxTokens   = 1024,
        temperature = 0.7,
        timeout     = 35000,
        maxRetries  = 2,
        isPlatform  = false // Explicit flag for platform calls
    } = options;
    
    // 1. Determine Routing Strategy
    let activeKey = apiKey?.trim();
    const platformKey = process.env.GEMINI_API_KEY?.trim();
    
    // If no key provided, assume platform call
    if (!activeKey) {
        activeKey = platformKey;
    }
    
    // Routing Logic: Use Vertex if it's a platform call (either by flag or by matching the platform key)
    const vertexInstance = getVertexInstance();
    const useVertex = (isPlatform || activeKey === platformKey) && !!vertexInstance;
    
    // Sanitize prompt
    const safePrompt = String(prompt)
        .replace(/ignore (previous|all) instructions/gi, "[filtered]")
        .replace(/system prompt/gi, "[filtered]")
        .substring(0, 15000); // Vertex supports larger prompts

    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            let result;
            
            if (useVertex && attempt === 1) {
                // VERTEX AI EXECUTION (Burn Credits)
                const model = vertexInstance.getGenerativeModel({ 
                    model: PLATFORM_MODEL,
                    generationConfig: { maxOutputTokens: maxTokens, temperature }
                });
                
                result = await Promise.race([
                    model.generateContent(safePrompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Vertex timeout")), timeout))
                ]);
                
                // Extract text from Vertex response
                const response = result.response;
                if (response.candidates && response.candidates.length > 0) {
                    return response.candidates[0].content.parts[0].text?.trim() || null;
                }
                return (typeof response.text === 'function' ? response.text().trim() : null);

            } else {
                // AI STUDIO EXECUTION (Standard Key)
                const currentKey = (attempt > 1 && useVertex) ? platformKey : activeKey;
                
                if (!isKeyValid(currentKey)) {
                    if (attempt === 1 && !useVertex) logger.warn("Invalid API key for AI Studio call.");
                    // If we have no valid key at all, return null
                    if (!isKeyValid(currentKey)) return null;
                }
                
                const genAI = getStudioClient(currentKey);
                const model = genAI.getGenerativeModel({ model: BOT_MODEL });
                
                result = await Promise.race([
                    model.generateContent(safePrompt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeout))
                ]);
                
                return result.response.text()?.trim() || null;
            }
            
        } catch (err) {
            lastError = err;
            const msg = err.message || "";
            
            // Failover: If Vertex failed on attempt 1, immediately retry with AI Studio (if we have a platform key)
            if (useVertex && attempt === 1 && isKeyValid(platformKey)) {
                logger.warn(`Vertex AI failed, falling back to AI Studio: ${msg}`);
                // Switch strategy to AI Studio for the next loop iteration
                // We just continue and the loop handles the retry
                continue; 
            }

            if (msg.includes("404") || msg.includes("not found")) {
                logger.error(`Model not found. Attempt ${attempt}`);
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
}

async function generateJSON(prompt, apiKey, options = {}) {
    const result = await generateText(prompt, apiKey, { ...options, temperature: 0.1 });
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
        timeout: 6000,
        maxRetries: 0,
        temperature: 0.1
    });
}

function getGeminiModel(apiKey) {
    return getStudioClient(apiKey);
}

// ------------------------------------------------------------------
// PLATFORM EXPORTS (Dashboard features, uses Vertex by default)
// ------------------------------------------------------------------
async function platformGenerateText(prompt, options = {}) {
    return generateText(prompt, process.env.GEMINI_API_KEY, { ...options, isPlatform: true });
}

async function platformGenerateJSON(prompt, options = {}) {
    return generateJSON(prompt, process.env.GEMINI_API_KEY, { ...options, isPlatform: true });
}

// ------------------------------------------------------------------
// BOT EXPORTS (Client chatbots, uses provided keys via AI Studio)
// ------------------------------------------------------------------
async function botGenerateText(prompt, clientApiKey, options = {}) {
    if (!clientApiKey?.trim()) return null;
    return generateText(prompt, clientApiKey, options);
}

async function botGenerateJSON(prompt, clientApiKey, options = {}) {
    if (!clientApiKey?.trim()) return null;
    return generateJSON(prompt, clientApiKey, options);
}

module.exports = {
    getGeminiModel,      // for backward compat
    generateText,        // general purpose
    generateJSON,        // structured output
    generateTextFast,    // real-time
    platformGenerateText, // dashboard (vertex)
    platformGenerateJSON, // dashboard (vertex)
    botGenerateText,      // chatbot (client key)
    botGenerateJSON       // chatbot (client key)
};
