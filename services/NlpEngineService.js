const { NlpManager } = require('node-nlp');
const { LangEn } = require('@nlpjs/lang-en');
const { LangHi } = require('@nlpjs/lang-hi');
const IntentRule = require('../models/IntentRule');
const ActionExecutorService = require('./ActionExecutorService');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const IntentAnalytics = require('../models/IntentAnalytics');
const Conversation = require('../models/Conversation');
const path = require('path');
const fs = require('fs');
const { CONFIDENCE_THRESHOLD, MAX_CACHED_MODELS } = require('../utils/nlpConfig');

/**
 * NlpEngineService
 * Enterprise-grade, zero-cost NLP processing using node-nlp.
 * Handles training and processing of deterministic intents.
 */
class NlpEngineService {
  constructor() {
    this.managers = new Map(); // Stores trained NlpManager instances by clientId
    this.trainingLocks = new Set(); // Track clients currently undergoing training
    this.lastAccessed = new Map(); // LRU tracking: clientId → timestamp
  }

  /**
   * LRU eviction — remove least recently used model when cache is full.
   */
  evictLRU() {
    if (this.managers.size < MAX_CACHED_MODELS) return;
    const sorted = [...this.lastAccessed.entries()].sort((a, b) => a[1] - b[1]);
    if (sorted.length > 0) {
      const [lruClientId] = sorted[0];
      this.managers.delete(lruClientId);
      this.lastAccessed.delete(lruClientId);
      console.log(`[NLPEngine] Evicted model for client ${lruClientId} (LRU)`);
    }
  }

  /**
   * Initializes and trains the NLP model for a specific client.
   * Feeds training phrases from IntentRule collection into the NlpManager.
   */
  async trainClientModel(clientId) {
    if (!clientId) return;
    
    // Simple locking to prevent concurrent training for the same client
    if (this.trainingLocks.has(clientId.toString())) {
      console.log(`[NLPEngine] Training already in progress for ${clientId}. Skipping concurrent request.`);
      return;
    }

    try {
      this.trainingLocks.add(clientId.toString());
      console.log(`[NLPEngine] Starting training for Client: ${clientId}`);
      
      // Fetch active intents for this client
      const rules = await IntentRule.find({ clientId, isActive: true });

      // Determine all needed languages from rules
      const allLangs = new Set(['en', 'hi']);
      for (const rule of rules) {
        (rule.languageConfig || []).forEach(l => {
          if (l !== 'hinglish') allLangs.add(l);
        });
      }

      // Initialize manager with required languages
      const manager = new NlpManager({ 
        languages: [...allLangs], 
        forceNER: true,
        nlu: { log: false } 
      });

      // Register language plugins as requested
      manager.container.register('lang-en', new LangEn());
      manager.container.register('lang-hi', new LangHi());

      if (rules.length === 0) {
        console.warn(`[NLPEngine] No active intent rules found for client ${clientId}.`);
        this.managers.set(clientId.toString(), manager);
        this.lastAccessed.set(clientId.toString(), Date.now());
        return;
      }

      // Add training phrases to the model — respect languageConfig
      for (const rule of rules) {
        if (!rule.trainingPhrases) continue;
        const langs = rule.languageConfig?.length > 0 ? rule.languageConfig : ['en', 'hi'];

        for (const phrase of rule.trainingPhrases) {
          if (langs.includes('en') || langs.includes('hinglish')) {
            manager.addDocument('en', phrase, rule.intentName);
          }
          if (langs.includes('hi') || langs.includes('hinglish')) {
            manager.addDocument('hi', phrase, rule.intentName);
          }
        }

        // BUG 4 FIX: Train anti-intent phrases against 'None' class
        for (const antiPhrase of (rule.antiIntentPhrases || [])) {
          if (antiPhrase?.trim()) {
            manager.addDocument('en', antiPhrase, 'None');
            manager.addDocument('hi', antiPhrase, 'None');
          }
        }
      }

      // Train the model
      await manager.train();
      
      // LRU eviction before adding new model
      this.evictLRU();

      // Store in memory
      this.managers.set(clientId.toString(), manager);
      this.lastAccessed.set(clientId.toString(), Date.now());

      // BUG 5 FIX: Persist model to disk for server restart survival
      try {
        const modelDir = path.join(__dirname, '../nlp_models');
        await fs.promises.mkdir(modelDir, { recursive: true });
        const modelPath = path.join(modelDir, `${clientId}.nlp`);
        await manager.save(modelPath, true);
        console.log(`[NLPEngine] Model persisted to disk: ${modelPath}`);
      } catch (saveErr) {
        console.error(`[NLPEngine] Failed to persist model to disk:`, saveErr.message);
      }
      
      console.log(`[NLPEngine] Training complete for ${clientId}. Total intents: ${rules.length}`);
    } catch (error) {
      console.error(`[NLPEngine] Training error for client ${clientId}:`, error);
      throw error;
    } finally {
      this.trainingLocks.delete(clientId.toString());
    }
  }

  /**
   * Load model from disk if available — used when manager not in memory.
   */
  async loadFromDisk(clientId) {
    const modelPath = path.join(__dirname, '../nlp_models', `${clientId}.nlp`);
    if (fs.existsSync(modelPath)) {
      try {
        const loadedManager = new NlpManager({ languages: ['en', 'hi'], nlu: { log: false } });
        await loadedManager.load(modelPath);
        this.evictLRU();
        this.managers.set(clientId.toString(), loadedManager);
        this.lastAccessed.set(clientId.toString(), Date.now());
        console.log(`[NLPEngine] Loaded model from disk for client ${clientId}`);
        return loadedManager;
      } catch (loadErr) {
        console.error(`[NLPEngine] Failed to load model from disk:`, loadErr.message);
      }
    }
    return null;
  }

  /**
   * Get or initialize the NLP manager for a client.
   */
  async getManager(clientId) {
    let manager = this.managers.get(clientId.toString());
    if (manager) {
      this.lastAccessed.set(clientId.toString(), Date.now());
      return manager;
    }

    // Try loading from disk first (BUG 5 FIX)
    manager = await this.loadFromDisk(clientId);
    if (manager) return manager;

    // Train from scratch
    await this.trainClientModel(clientId);
    return this.managers.get(clientId.toString());
  }

  /**
   * Analytics tracking.
   */
  async trackAnalytics(clientId, matched, fallback) {
    try {
      const todayDate = new Date().toISOString().split('T')[0];
      await IntentAnalytics.findOneAndUpdate(
        { clientId, date: todayDate },
        { 
          $inc: { 
            totalMessagesProcessed: 1,
            intentsMatched: matched ? 1 : 0,
            fallbackCount: fallback ? 1 : 0
          } 
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error('[NLPEngine] Analytics Tracking failed:', err.message);
    }
  }

  /**
   * Simulation method (Module 1 helper)
   */
  async simulate(clientId, text) {
    const manager = await this.getManager(clientId);
    return await manager.process(text);
  }

  /**
   * Process aggregated text and execute actions.
   */
  async processIncomingText(clientId, phoneNumber, finalString) {
    try {
      const manager = await this.getManager(clientId);

      const result = await manager.process(finalString);
      const { intent, score } = result;

      console.log(`[NLPEngine] Analysis Result: Intent: ${intent} | Score: ${score.toFixed(4)}`);

      // BUG 6 FIX: Use unified confidence threshold from nlpConfig
      if (score < CONFIDENCE_THRESHOLD || intent === 'None' || !intent) {
        console.warn(`[NLPEngine] Intent confidence too low or UNKNOWN (${score.toFixed(4)}). Logging for review.`);
        this.trackAnalytics(clientId, false, true);

        UnrecognizedPhrase.create({
          clientId,
          phrase: finalString,
          phoneNumber,
          language: result.language || 'unknown',
          status: 'PENDING'
        }).catch(err => console.error('[NLPEngine] Failed to log unrecognized phrase:', err));

        return result;
      }

      this.trackAnalytics(clientId, true, false).catch(() => {});

      if (intent && intent !== 'None') {
        console.log(`[NLPEngine] Confidence threshold passed (>= ${CONFIDENCE_THRESHOLD}). Executing pipeline for intent: ${intent}`);
        
        // GAP 3: Update lastTriggeredAt and totalTriggerCount on IntentRule
        IntentRule.findOneAndUpdate(
          { clientId, intentName: intent },
          { $set: { lastTriggeredAt: new Date() }, $inc: { totalTriggerCount: 1 } }
        ).catch(() => {}); // fire and forget

        // Normalize phone for comparison (ensure it's just digits)
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        
        // Variants to try: exact, clean, 91 prefix, +91 prefix
        const phoneVariants = [
          phoneNumber, 
          cleanPhone, 
          cleanPhone.startsWith('91') ? cleanPhone.slice(2) : '91' + cleanPhone,
          cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone
        ];

        // MODULE 2: Update Conversation with last detected intent context
        try {
          let conversation = await Conversation.findOne({ 
            clientId, 
            phone: { $in: phoneVariants } 
          });


          if (conversation) {
            await Conversation.updateOne(
              { _id: conversation._id },
              { 
                $set: {
                  lastDetectedIntent: {
                    intentName: intent,
                    confidenceScore: score,
                    detectedAt: new Date()
                  }
                }
              }
            );
            console.log(`[NLPEngine] Updated conversation context for ${phoneNumber}`);
          } else {
            console.warn(`[NLPEngine] No conversation found for ${phoneNumber} to update intent context.`);
          }

          // Emit Socket event for real-time UI updates
          if (global.io) {
            console.log(`[NLPEngine] Emitting intentUpdated to room: client_${clientId}`);
            global.io.to(`client_${clientId}`).emit('intentUpdated', {
              phone: phoneNumber,
              conversationId: conversation?._id ? String(conversation._id) : undefined,
              intentName: intent,
              confidenceScore: score,
              detectedAt: new Date()
            });
          } else {
            console.warn('[NLPEngine] global.io not available for emission');
          }
        } catch (dbErr) {
          console.error('[NLPEngine] Failed to update conversation context:', dbErr.message);
        }

        await ActionExecutorService.executeIntentActions(clientId, phoneNumber, intent);
      }

      return result;
    } catch (error) {
      console.error(`[NLPEngine] Processing error for client ${clientId}:`, error);
    }
  }

  /**
   * Healthcheck helper
   */
  getEngineStatus() {
    return {
      activeClients: this.managers.size,
      isInitialized: true,
      timestamp: Date.now()
    };
  }
}

module.exports = new NlpEngineService();
