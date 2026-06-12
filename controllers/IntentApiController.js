const mongoose = require('mongoose');
const IntentRule = require('../models/IntentRule');
const NlpEngineService = require('../services/NlpEngineService');
const IntentAnalytics = require('../models/IntentAnalytics');
const { CONFIDENCE_THRESHOLD } = require('../utils/core/nlpConfig');
const ClientModel = require('../models/Client');
const { callAIJSON } = require('../utils/core/aiGateway');
const { tenantClientId } = require('../utils/core/queryHelpers');

/**
 * IntentApiController
 * Manages Intent Rules and triggers on-demand NLP retraining.
 * Provides the bridge between the Dashboard UI and the local NLP Brain.
 */

/**
 * Helper: Resolve tenant client id (JWT for normal users; super-admins may target via query/body/params).
 */
function resolveClientId(req) {
  return tenantClientId(req);
}

/**
 * NEW 1: Detects overlapping training phrases between intents.
 */
async function detectIntentConflicts(clientId, newIntentId, newPhrases) {
  const allOtherIntents = await IntentRule.find({
    clientId, isActive: true, _id: { $ne: newIntentId }
  }).select('intentName trainingPhrases');

  const conflicts = [];
  for (const other of allOtherIntents) {
    const overlapping = newPhrases.filter(p =>
      other.trainingPhrases.some(op =>
        op.toLowerCase().includes(p.toLowerCase()) ||
        p.toLowerCase().includes(op.toLowerCase())
      )
    );
    if (overlapping.length > 0) {
      conflicts.push({
        conflictsWith: other.intentName,
        phrases: overlapping
      });
    }
  }
  return conflicts;
}

/**
 * TASK 2: Creates or updates an Intent Rule and triggers a dynamic retraining.
 */
exports.upsertIntent = async (req, res) => {
  try {
    const { intentId, intentName, trainingPhrases, actions, languageConfig, antiIntentPhrases } = req.body;
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Client identity missing.' });
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

    // NEW 1: Check for phrase conflicts
    const conflicts = await detectIntentConflicts(clientId, rule._id, cleanPhrases);

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

    // 3. Response with optional conflict warnings
    res.status(200).json({ 
      success: true, 
      message: conflicts.length > 0
        ? `Intent created but ${conflicts.length} potential phrase conflict(s) detected.`
        : 'Intent synchronized. Brain is optimizing in the background.',
      rule,
      warnings: conflicts.length > 0 ? conflicts : undefined
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
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    const intents = await IntentRule.find({ clientId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, intents });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch intents' });
  }
};

/**
 * BUG 3 FIX: Returns stats matching frontend field expectations.
 */
exports.getIntentStats = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    
    const [activeIntents, analyticsStats] = await Promise.all([
      IntentRule.countDocuments({ clientId, isActive: true }),
      IntentAnalytics.find({ clientId }).sort({ date: -1 }).limit(30)
    ]);

    // Calculate totals from analytics
    const totals = analyticsStats.reduce((acc, curr) => ({
      totalProcessed: acc.totalProcessed + curr.totalMessagesProcessed,
      totalMatched: acc.totalMatched + curr.intentsMatched,
      totalFallback: acc.totalFallback + (curr.fallbackCount || 0)
    }), { totalProcessed: 0, totalMatched: 0, totalFallback: 0 });

    const accuracy =
      totals.totalProcessed > 0
        ? parseFloat(((totals.totalMatched / totals.totalProcessed) * 100).toFixed(1))
        : null;

    res.status(200).json({
      success: true,
      stats: {
        activeIntents,
        pendingPhrases: 0,
        totalLearningHits: totals.totalMatched,
        accuracy,
        totalProcessed: totals.totalProcessed,
      },
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
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Client identity missing.' });
    }

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
 * GAP 2: Toggle intent active/inactive without deleting.
 */
exports.toggleIntent = async (req, res) => {
  try {
    const { intentId } = req.params;
    const { isActive } = req.body;
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const rule = await IntentRule.findOneAndUpdate(
      { _id: intentId, clientId },
      { $set: { isActive: !!isActive } },
      { new: true }
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: 'Intent not found.' });
    }

    // Background retrain
    setImmediate(async () => {
      try {
        await NlpEngineService.trainClientModel(clientId);
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('intent_training_complete', {
            success: true,
            message: `Intent "${rule.intentName}" ${isActive ? 'activated' : 'deactivated'}.`
          });
        }
      } catch (err) {
        console.error('[IntentToggle] Background training failed:', err.message);
      }
    });

    res.status(200).json({ success: true, rule, message: `Intent ${isActive ? 'activated' : 'deactivated'}.` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to toggle intent.' });
  }
};

/**
 * MODULE 1: THE EPHEMERAL INTENT SIMULATOR (Sandbox)
 */
exports.simulateIntent = async (req, res) => {
  try {
    const { text } = req.body;
    const clientId = resolveClientId(req);

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

    // 2. Fetch associated Actions only if score passes unified threshold
    let simulatedActions = [];

    if (score >= CONFIDENCE_THRESHOLD && intent && intent !== 'None') {
      const rule = await IntentRule.findOne({ clientId, intentName: intent });
      if (rule) {
        simulatedActions = rule.actions;
      }
    }

    res.status(200).json({
      success: true,
      originalText: text,
      detectedIntent: intent,
      confidenceScore: score,
      simulatedActions,
      savedToInbox: false
    });

  } catch (error) {
    console.error('[IntentSimulator] Simulation Critical Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Critical error during intent simulation.' 
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

    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Client ID required for generation.' });
    }

    const prompt = `You are an expert NLP training data architect for a professional customer service chatbot.
The user wants to detect the following INTENT in customer messages: "${description}".

Your task is to generate training data that will be used to train a weight-based NLP engine.
Variety is critical. Do not repeat words or structures if possible.

Generate exactly:
1. "intentPhrases": 15 diverse phrases where a customer EXPRESSES this intent.
2. "antiIntentPhrases": 8 phrases where a customer uses SIMILAR vocabulary but DOES NOT HAVE this intent (e.g., asking about something unrelated, or expressing the opposite).

Linguistic Requirements:
- Language: English & Hinglish/Hindi (Mix 50/50).
- Style: WhatsApp conversational (short, informal).

Return ONLY valid JSON and NOTHING ELSE. No markdown fences.
Expected Structure:
{
  "intentPhrases": ["...", "..."],
  "antiIntentPhrases": ["...", "..."]
}`;

    console.log(`[IntentGeneration] AI generation started for: "${description.substring(0, 50)}"`);
    let generatedData;
    try {
      const result = await callAIJSON({
        clientId,
        feature: 'other',
        prompt,
        maxTokens: 1500,
        temperature: 0.8,
        fast: true,
      });
      generatedData = result.data;
    } catch (aiErr) {
      if (aiErr.code === 'AI_NOT_CONFIGURED') {
        return res.status(403).json({
          success: false,
          message: 'Configure your Gemini API key in AI Brain → AI Setup.',
        });
      }
      return res.status(504).json({
        success: false,
        error: 'The AI service is currently unresponsive or timed out. Please try again in a few moments.',
      });
    }

    if (!generatedData) {
      return res.status(504).json({ 
        success: false, 
        error: 'The AI service is currently unresponsive or timed out. Please try again in a few moments.' 
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
    const statusCode = error.message?.includes('invalid') ? 422 : 503;
    res.status(statusCode).json({ 
      success: false, 
      error: 'AI Generation Failed: ' + (error.message || 'The service is temporarily unavailable.') 
    });
  }
};
