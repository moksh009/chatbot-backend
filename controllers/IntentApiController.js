const IntentRule = require('../models/IntentRule');
const NlpEngineService = require('../services/NlpEngineService');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const IntentAnalytics = require('../models/IntentAnalytics');

/**
 * IntentApiController
 * Manages Intent Rules and triggers on-demand NLP retraining.
 * Provides the bridge between the Dashboard UI and the local NLP Brain.
 */

/**
 * TASK 2: Creates or updates an Intent Rule and triggers a dynamic retraining.
 */
exports.upsertIntent = async (req, res) => {
  try {
    const { intentId, intentName, trainingPhrases, actions, languageConfig, antiIntentPhrases } = req.body;
    
    // Support for both middleware-injected client and direct payload (as fallback)
    const clientId = req.user?.clientId || req.body.clientId;

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Client identity is missing' });
    }

    // 1. Validation - Payload must strictly match models/IntentRule.js
    if (!intentName || !trainingPhrases?.length || !actions?.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation Error: Intent name, training phrases, and at least one action are required.' 
      });
    }

    // Clean phrases
    const cleanPhrases = trainingPhrases.filter(p => p && p.trim()).map(p => p.trim());
    const cleanAntiPhrases = (antiIntentPhrases || []).filter(p => p && p.trim()).map(p => p.trim());

    if (cleanPhrases.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one non-empty training phrase is required.' });
    }

    // 2. Database Persistance (Save or Update)
    let rule;
    const ruleData = {
      clientId,
      intentName,
      trainingPhrases: cleanPhrases,
      antiIntentPhrases: cleanAntiPhrases,
      actions,
      languageConfig: languageConfig || ['en', 'hi'],
      isActive: true
    };

    if (intentId) {
      rule = await IntentRule.findOneAndUpdate(
        { _id: intentId, clientId },
        { $set: ruleData },
        { new: true, runValidators: true }
      );
      if (!rule) {
        return res.status(404).json({ success: false, message: 'Intent rule not found for update.' });
      }
    } else {
      rule = await IntentRule.create(ruleData);
    }

     /**
     * CRITICAL ARCHITECTURE RULE: 
     * We trigger retraining but we DON'T block the HTTP response on it.
     * NLP retraining is handled safely in the background.
     */
    console.log(`[IntentApi] Scheduling background retraining for client: ${clientId}...`);
    // Safe background execution
    setImmediate(async () => {
      try {
        await NlpEngineService.trainClientModel(clientId);
        
        // WebSocket notification for real-time UI updates
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('intent_training_complete', { 
            success: true, 
            message: 'Brain optimization complete.',
            timestamp: new Date()
          });
          console.log(`[IntentApi] WebSocket: Notified client ${clientId} of training completion.`);
        }
      } catch (err) {
        console.error('[IntentRetrain] Background training failed:', err.message);
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('intent_training_complete', { 
            success: false, 
            error: err.message 
          });
        }
      }
    });

    // 3. Response
    res.status(200).json({ 
      success: true, 
      message: 'Intent synchronized. Brain is optimizing in the background.', 
      rule 
    });

  } catch (error) {
    console.error('[IntentApi] Upsert Error:', error);
    
    // Handle duplicate key error for intentName
    if (error.code === 11000) {
      return res.status(400).json({ 
        success: false, 
        message: 'An intent with this name already exists for your account.' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Critical error while saving intent: ' + (error.message || 'Internal Server Error')
    });
  }
};

/**
 * Fetches all intent rules for a specific client.
 */
exports.getIntents = async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Client identity is required.' });
    }
    const intents = await IntentRule.find({ clientId });
    res.status(200).json({ success: true, intents });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch intents' });
  }
};

/**
 * TASK 3: Resolves a failed phrase by either assigning it to an intent or ignoring it.
 */
exports.resolvePhrase = async (req, res) => {
  try {
    const { phraseId, intentId, action } = req.body;
    const clientId = req.user?.clientId || req.body.clientId;

    // 1. Fetch the unrecognized phrase
    const unrecognized = await UnrecognizedPhrase.findOne({ _id: phraseId, clientId });
    if (!unrecognized) {
      return res.status(404).json({ success: false, message: 'Unrecognized phrase pattern not found.' });
    }

    if (action === 'IGNORE') {
      // Logic 1: Simply ignore the phrase
      unrecognized.status = 'IGNORED';
      await unrecognized.save();
      console.log(`[IntentApi] Phrase ${phraseId} marked as IGNORED.`);
    } else if (action === 'ASSIGN') {
      // Logic 2: Map to an existing intent rule
      if (!intentId) return res.status(400).json({ message: 'Target intentId required for ASSIGN action.' });

      const rule = await IntentRule.findOne({ _id: intentId, clientId });
      if (!rule) return res.status(404).json({ message: 'Target Intent Rule not found.' });

      // Add the phrase to the training set if not already present
      if (!rule.trainingPhrases.includes(unrecognized.phrase)) {
        rule.trainingPhrases.push(unrecognized.phrase);
        await rule.save();
      }

      unrecognized.status = 'RESOLVED';
      await unrecognized.save();

      /**
       * CRITICAL: Instantly trigger model retraining.
       * This ensures the AI now recognizes this previously unknown phrase.
       */
      console.log(`[IntentApi] Pattern Assigned. Triggering brain optimization for ${clientId}...`);
      await NlpEngineService.trainClientModel(clientId);
    }

    res.status(200).json({ 
        success: true, 
        message: action === 'ASSIGN' ? 'Pattern learned and model optimized.' : 'Pattern ignored successfully.' 
    });

  } catch (error) {
    console.error('[IntentApi] Resolve Error:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve unrecognized loop pattern.' });
  }
};

/**
 * TASK 4 BRIDGE: Fetches all PENDING unrecognized phrases for the Training Inbox.
 */
exports.getPendingPhrases = async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    const phrases = await UnrecognizedPhrase.find({ clientId, status: 'PENDING' }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, phrases });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch pending intelligence gaps.' });
  }
};

/**
 * NEW: Fetches daily ROI analytics for the Automation dashboard.
 */
exports.getIntentStats = async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    
    // Fetch last 30 days of analytics
    const stats = await IntentAnalytics.find({ clientId })
      .sort({ date: -1 })
      .limit(30);

    // Calculate totals for simple ROI display
    const totals = stats.reduce((acc, curr) => ({
      totalProcessed: acc.totalProcessed + curr.totalMessagesProcessed,
      totalMatched: acc.totalMatched + curr.intentsMatched,
      totalFallback: acc.totalFallback + (curr.fallbackCount || 0)
    }), { totalProcessed: 0, totalMatched: 0, totalFallback: 0 });

    res.status(200).json({ 
      success: true, 
      stats,
      totals,
      accuracyRate: totals.totalProcessed ? ((totals.totalMatched / totals.totalProcessed) * 100).toFixed(2) : 0
    });
  } catch (error) {
    console.error('[IntentApi] Stats Error:', error);
    res.status(500).json({ success: false, error: 'Failed to aggregate intelligence metrics.' });
  }
};

/**
 * Deletes an intent rule and triggers retraining.
 */
exports.deleteIntent = async (req, res) => {
  try {
    const { intentId } = req.params;
    
    // Support clientId from query params (needed for Super Admins) or fallback to user's identity
    const clientId = req.query.clientId || req.user?.clientId;

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Unauthorized: Client identity missing.' });
    }

    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(intentId)) {
      return res.status(400).json({ success: false, message: 'Invalid intent identity format.' });
    }

    const result = await IntentRule.deleteOne({ _id: intentId, clientId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Intent not found or already removed.' });
    }
    
    // Retrain model in background safely
    setImmediate(async () => {
      try {
        await NlpEngineService.trainClientModel(clientId);
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('intent_training_complete', { 
            success: true, 
            message: 'Intent removed and brain optimized.' 
          });
        }
      } catch (err) {
        console.error('[IntentDelete] Background training failed:', err.message);
      }
    });

    res.status(200).json({ success: true, message: 'Intent deleted. Brain retraining scheduled.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Deletion failed' });
  }
};

/**
 * MODULE 1: THE EPHEMERAL INTENT SIMULATOR (Sandbox)
 * Tests trained intents without firing actual webhooks or saving to database.
 */
exports.simulateIntent = async (req, res) => {
  try {
    const { text } = req.body;
    const clientId = req.user?.clientId || req.body.clientId;

    if (!text || !clientId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Simulation Error: Client ID and Text are required.' 
      });
    }

    console.log(`[IntentSimulator] Running sandbox test for ${clientId}: "${text}"`);
    
    // 1. Pass text to NLP Engine manager process
    const simulationResult = await NlpEngineService.simulate(clientId, text);
    const { intent, score } = simulationResult;

    // 2. Fetch associated Actions from the IntentRule collection only if score passes threshold
    let simulatedActions = [];
    if (score >= 0.80 && intent && intent !== 'None') {
      const rule = await IntentRule.findOne({ clientId, intentName: intent });
      if (rule) {
        simulatedActions = rule.actions;
      }
    }

    // 3. Return payload without executing ActionExecutor or saving Conversation
    res.status(200).json({
      success: true,
      originalText: text,
      detectedIntent: intent,
      confidenceScore: score,
      simulatedActions
    });

  } catch (error) {
    console.error('[IntentSimulator] Simulation Critical Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Critical error during intent simulation simulation.' 
    });
  }
};

/**
 * MODULE 1: AI-FIRST INTENT GENERATION
 * Generates positive and negative training phrases using LLM.
 */
exports.generateTrainingData = async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) {
      return res.status(400).json({ success: false, message: 'Intent description is required.' });
    }

    // Check for API Key
    if (!process.env.GEMINI_API_KEY) {
      console.warn('[IntentApi] Platform Gemini API key is missing from environment.');
      return res.status(403).json({ 
        success: false, 
        message: 'AI Generation is currently unavailable. System administrator needs to configure the Platform API key.' 
      });
    }

    // Use Gemini for Generation
    const { platformGenerateText } = require('../utils/gemini');
    
    const prompt = `The user wants to detect the following intent in customer messages: "${description}".
Generate exactly 30 positive phrases (customer saying this phrase expressing the intent) and exactly 30 negative anti-phrases (customer using similar vocabulary but explicitly NOT having this intent, or stating everything is fine or asking about completely unrelated issues).
Half of the phrases in BOTH lists must be in modern English, and half must be in Hindi/Hinglish.
Each phrase you generate has to be different and they should have low similarity for better variety with examples to ensure good training spread.
Return as pure JSON matching this exact structure: { "intentPhrases": ["..."], "antiIntentPhrases": ["..."] }`;

    // 1. Extend Timeouts: 30s as requested
    console.log(`[IntentGeneration] Triggering AI generation for: "${description.substring(0, 50)}..."`);
    const rawResponse = await platformGenerateText(prompt, { 
      maxTokens: 4000, 
      temperature: 0.9, 
      maxRetries: 3, 
      timeout: 30000 
    });

    if (!rawResponse) {
      return res.status(502).json({ 
        success: false, 
        error: 'The AI service is currently unresponsive. Please try again in a few moments.' 
      });
    }

    // 2. Regex JSON Sanitization: Robustly strip markdown blocks
    const cleanedText = rawResponse
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // 3. Safe Parsing: Try/Catch with logging
    let generatedData;
    try {
      generatedData = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('[IntentGeneration] JSON Parse Failed!');
      console.error('[IntentGeneration] Cleaned Response:', cleanedText);
      console.error('[IntentGeneration] Raw Response:', rawResponse);
      
      return res.status(422).json({
        success: false,
        error: 'The AI returned an invalid format. We have logged this for review. Please try a more specific description.'
      });
    }

    if (!Array.isArray(generatedData.intentPhrases) || !Array.isArray(generatedData.antiIntentPhrases)) {
      console.error('[IntentGeneration] Invalid JSON structure from AI:', generatedData);
      return res.status(422).json({ 
        success: false, 
        error: 'The AI generated an incompatible data structure. Please refine your description.' 
      });
    }

    res.status(200).json({
      success: true,
      data: {
        intentPhrases: generatedData.intentPhrases,
        antiIntentPhrases: generatedData.antiIntentPhrases
      }
    });

  } catch (error) {
    console.error('[IntentGeneration Error]:', error);
    
    // Distinguish between validation errors and service failures
    const statusCode = error.message?.includes('invalid') ? 422 : 502;
    res.status(statusCode).json({ 
      success: false, 
      error: 'AI Generation Failed: ' + (error.message || 'The brain service is temporarily unavailable.') 
    });
  }
};

