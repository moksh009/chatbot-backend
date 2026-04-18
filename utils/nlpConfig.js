/**
 * nlpConfig.js
 * Single source of truth for NLP engine configuration.
 * Imported by both NlpEngineService (live) and IntentApiController (sandbox).
 */
module.exports = {
  CONFIDENCE_THRESHOLD: 0.75,     // Apply to BOTH sandbox and live processing
  TRAINING_LOCK_TIMEOUT: 30000,   // 30s max training wait
  MAX_CACHED_MODELS: 50           // LRU cache limit for in-memory NLP managers
};
