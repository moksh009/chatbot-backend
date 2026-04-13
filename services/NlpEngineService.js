const { NlpManager } = require('node-nlp');
const { LangEn } = require('@nlpjs/lang-en');
const { LangHi } = require('@nlpjs/lang-hi');
const IntentRule = require('../models/IntentRule');
const ActionExecutorService = require('./ActionExecutorService');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const IntentAnalytics = require('../models/IntentAnalytics');
const Conversation = require('../models/Conversation');

/**
 * NlpEngineService
 * Enterprise-grade, zero-cost NLP processing using node-nlp.
 * Handles training and processing of deterministic intents.
 */
class NlpEngineService {
  constructor() {
    this.managers = new Map(); // Stores trained NlpManager instances by clientId
  }

  /**
   * Initializes and trains the NLP model for a specific client.
   * Feeds training phrases from IntentRule collection into the NlpManager.
   */
  async trainClientModel(clientId) {
    try {
      console.log(`[NLPEngine] Starting training for Client: ${clientId}`);
      
      // Initialize manager with required languages
      const manager = new NlpManager({ 
        languages: ['en', 'hi'], 
        forceNER: true,
        nlu: { log: false } 
      });

      // Register language plugins as requested
      manager.container.register('lang-en', new LangEn());
      manager.container.register('lang-hi', new LangHi());

      // Fetch active intents for this client
      const rules = await IntentRule.find({ clientId, isActive: true });

      if (rules.length === 0) {
        console.warn(`[NLPEngine] No active intent rules found for client ${clientId}.`);
        this.managers.set(clientId.toString(), manager);
        return;
      }

      // Add training phrases to the model
      for (const rule of rules) {
        if (!rule.trainingPhrases) continue;
        for (const phrase of rule.trainingPhrases) {
          manager.addDocument('en', phrase, rule.intentName);
          manager.addDocument('hi', phrase, rule.intentName);
        }
      }

      // Train the model
      await manager.train();
      
      // Store in memory
      this.managers.set(clientId.toString(), manager);
      
      console.log(`[NLPEngine] Training complete for ${clientId}. Total intents: ${rules.length}`);
    } catch (error) {
      console.error(`[NLPEngine] Training error for client ${clientId}:`, error);
      throw error;
    }
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
    let manager = this.managers.get(clientId.toString());
    if (!manager) {
      await this.trainClientModel(clientId);
      manager = this.managers.get(clientId.toString());
    }
    return await manager.process(text);
  }

  /**
   * Process aggregated text and execute actions.
   */
  async processIncomingText(clientId, phoneNumber, finalString) {
    try {
      let manager = this.managers.get(clientId.toString());

      if (!manager) {
        await this.trainClientModel(clientId);
        manager = this.managers.get(clientId.toString());
      }

      const result = await manager.process(finalString);
      const { intent, score } = result;

      console.log(`[NLPEngine] Analysis Result: Intent: ${intent} | Score: ${score.toFixed(4)}`);

      // Lower threshold to 0.70 for live updates
      if (score < 0.70 || intent === 'None' || !intent) {
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
        console.log(`[NLPEngine] Confidence threshold passed (>= 0.70). Executing pipeline for intent: ${intent}`);
        
        // Normalize phone for comparison (remove symbols if any)
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        // MODULE 2: Update Conversation with last detected intent context
        try {
          // Try exact match first, then clean match
          let conversation = await Conversation.findOne({ phone: phoneNumber, clientId });
          if (!conversation) {
            conversation = await Conversation.findOne({ phone: cleanPhone, clientId });
          }

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

