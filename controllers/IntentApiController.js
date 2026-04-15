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

    // 1. Validation
    if (!intentName || !trainingPhrases?.length || !actions?.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation Error: Intent name, at least one phrase, and one action are required.' 
      });
    }

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Client identity is missing' });
    }

    // 2. Database Persistance (Save or Update)
    let rule;
    if (intentId) {
      rule = await IntentRule.findOneAndUpdate(
        { _id: intentId, clientId },
        { intentName, trainingPhrases, actions, languageConfig, antiIntentPhrases },
        { new: true, upsert: true }
      );
    } else {
      rule = await IntentRule.create({
        clientId,
        intentName,
        trainingPhrases,
        antiIntentPhrases,
        actions,
        languageConfig
      });
    }

    /**
     * CRITICAL ARCHITECTURE RULE: 
     * We must instantly retrain the client's NLP model in RAM.
     * We AWAIT the training completion before responding to the frontend.
     * This ensures the bot is synchronized with the dashboard the moment the user clicks "Save".
     */
    console.log(`[IntentApi] Triggering dynamic retraining for client: ${clientId}...`);
    await NlpEngineService.trainClientModel(clientId);

    // 3. Response
    res.status(200).json({ 
      success: true, 
      message: 'Intent saved and NLP brain retrained successfully.', 
      rule 
    });

  } catch (error) {
    console.error('[IntentApi] Upsert Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Critical error while saving intent and retraining brain.' 
    });
  }
};

/**
 * Fetches all intent rules for a specific client.
 */
exports.getIntents = async (req, res) => {
  try {
    const clientId = req.user?.clientId || req.query.clientId;
    const intents = await IntentRule.find({ clientId });
    res.status(200).json({ success: true, intents });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch intents' });
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
    res.status(500).json({ success: false, message: 'Failed to resolve unrecognized loop pattern.' });
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
    res.status(500).json({ success: false, message: 'Failed to fetch pending intelligence gaps.' });
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
    res.status(500).json({ success: false, message: 'Failed to aggregate intelligence metrics.' });
  }
};

/**
 * Deletes an intent rule and triggers retraining.
 */
exports.deleteIntent = async (req, res) => {
  try {
    const { intentId } = req.params;
    const clientId = req.user?.clientId;

    await IntentRule.deleteOne({ _id: intentId, clientId });
    
    // Retrain model since training data has changed
    await NlpEngineService.trainClientModel(clientId);

    res.status(200).json({ success: true, message: 'Intent deleted and brain retrained' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deletion failed' });
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
      message: 'Critical error during intent simulation simulation.' 
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

    // Use Gemini for Generation
    const { platformGenerateJSON } = require('../utils/gemini');
    
    const prompt = `The user wants to detect the following intent in customer messages: "${description}".
Generate exactly 30 positive phrases (customer saying this phrase expressing the intent) and exactly 30 negative anti-phrases (customer using similar vocabulary but explicitly NOT having this intent, or stating everything is fine or asking about completely unrelated issues).
Half of the phrases in BOTH lists must be in modern English, and half must be in Hindi/Hinglish.
Each phrase you generate has to be different and they should have low similarity for better variety with examples to ensure good training spread.
Return as pure JSON matching this exact structure: { "intentPhrases": ["..."], "antiIntentPhrases": ["..."] }`;

    const generatedData = await platformGenerateJSON(prompt, { maxTokens: 4000, temperature: 0.9, maxRetries: 3 });

    if (!generatedData || !generatedData.intentPhrases || !generatedData.antiIntentPhrases) {
      throw new Error('Failed to parse AI generation or empty output.');
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
    res.status(500).json({ success: false, message: 'Failed to generate training data using AI.' });
  }
};

