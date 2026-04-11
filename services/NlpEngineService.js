const { NlpManager } = require('node-nlp');
const IntentRule = require('../models/IntentRule');
const ActionExecutorService = require('./ActionExecutorService');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase'); // Shared in Phase 5
const IntentAnalytics = require('../models/IntentAnalytics'); // Shared in Phase 9

class NlpEngineService {
  constructor() {
    this.managers = new Map(); // Maps clientId to NlpManager
  }

  /**
   * Initializes or refreshes the NLP manager for a specific client.
   */
  async trainClientModel(clientId) {
    try {
      console.log(`[NLPEngine] Training model for client: ${clientId}`);
      
      const manager = new NlpManager({ languages: ['en', 'hi'], forceNER: true });
      
      // Fetch active intent rules for this client
      const rules = await IntentRule.find({ clientId, isActive: true });

      if (rules.length === 0) {
        console.warn(`[NLPEngine] No active intent rules found for client: ${clientId}`);
        this.managers.set(clientId.toString(), manager);
        return;
      }

      // Add training phrases to the manager
      for (const rule of rules) {
        for (const phrase of rule.trainingPhrases) {
          manager.addDocument(rule.languageConfig[0] || 'en', phrase, rule.intentName);
        }
      }

      await manager.train();
      this.managers.set(clientId.toString(), manager);
      
      console.log(`[NLPEngine] Model trained successfully for client: ${clientId} with ${rules.length} intents.`);
    } catch (error) {
      console.error(`[NLPEngine] Training error for client ${clientId}:`, error);
      throw error;
    }
  }

  /**
   * Processes incoming aggregated text through the NLP model.
   */
  async processIncomingText(clientId, phoneNumber, finalString) {
    try {
      let manager = this.managers.get(clientId.toString());
      
      // If manager isn't in memory, try to train it instantly
      if (!manager) {
        await this.trainClientModel(clientId);
        manager = this.managers.get(clientId.toString());
      }

      const response = await manager.process(finalString);
      const { intent, score, language } = response;

      console.log(`[NLPEngine] Client ${clientId} | Phone ${phoneNumber} | Intent: ${intent} | Score: ${score}`);

      // Phase 9: Atomic Analytics Tracking
      this.trackAnalytics(clientId, score).catch(err => console.error('[Analytics] Error:', err));

      if (score < 0.80 || intent === 'None') {
        console.log(`[NLPEngine] Confidence too low (${score}). Logging unrecognized phrase.`);
        
        // Phase 5/8: Log to UnrecognizedPhrase collection
        await UnrecognizedPhrase.create({
          clientId,
          phrase: finalString,
          language: language || 'unknown',
          phoneNumber,
          status: 'PENDING'
        });

        // Optional: Emit socket event for real-time dashboard updates
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('unrecognized_phrase_added', { phrase: finalString });
        }
        
        return;
      }

      // If confidence is high, execute actions
      await ActionExecutorService.executeIntentActions(clientId, phoneNumber, intent);

    } catch (error) {
      console.error('[NLPEngine] Process incoming text error:', error);
    }
  }

  /**
   * Lightweight analytics tracking (Phase 9)
   */
  async trackAnalytics(clientId, score) {
    try {
      const todayDate = new Date().toISOString().split('T')[0];
      const update = { $inc: { totalMessagesProcessed: 1 } };
      
      if (score >= 0.80) {
        update.$inc.intentsMatched = 1;
      } else {
        update.$inc.fallbackCount = 1;
      }

      await IntentAnalytics.findOneAndUpdate(
        { clientId, date: todayDate },
        update,
        { upsert: true, new: true }
      );
    } catch (err) {
      // Non-blocking error
    }
  }
}

module.exports = new NlpEngineService();
