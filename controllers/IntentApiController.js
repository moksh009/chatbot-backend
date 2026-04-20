const IntentRule = require('../models/IntentRule');
const NlpEngineService = require('../services/NlpEngineService');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const IntentAnalytics = require('../models/IntentAnalytics');
const { CONFIDENCE_THRESHOLD } = require('../utils/nlpConfig');

/**
 * IntentApiController
 * Manages Intent Rules and triggers on-demand NLP retraining.
 * Provides the bridge between the Dashboard UI and the local NLP Brain.
 */

/**
 * Helper: Resolve clientId from JWT (preferred) or fallback for super admins.
 * HARDENING 1: Never trust req.body.clientId for non-super-admins.
 */
function resolveClientId(req) {
  if (req.user?.isSuperAdmin) {
    return req.query.clientId || req.body.clientId || req.user?.clientId;
  }
  return req.user?.clientId;
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
 * TASK 3: Resolves a failed phrase by either assigning it to an intent or ignoring it.
 * BUG 8 FIX: ASSIGN now uses background retraining instead of blocking.
 */
exports.resolvePhrase = async (req, res) => {
  try {
    const { phraseId, intentId, action } = req.body;
    const clientId = resolveClientId(req);

    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    // 1. Fetch the unrecognized phrase
    const unrecognized = await UnrecognizedPhrase.findOne({ _id: phraseId, clientId });
    if (!unrecognized) {
      return res.status(404).json({ success: false, message: 'Unrecognized phrase pattern not found.' });
    }

    if (action === 'IGNORE') {
      unrecognized.status = 'IGNORED';
      await unrecognized.save();
      console.log(`[IntentApi] Phrase ${phraseId} marked as IGNORED.`);
    } else if (action === 'ASSIGN') {
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

      // BUG 8 FIX: Retrain in background — same pattern as upsertIntent
      console.log(`[IntentApi] Pattern Assigned. Scheduling background retraining for ${clientId}...`);
      setImmediate(async () => {
        try {
          await NlpEngineService.trainClientModel(clientId);
          if (global.io) {
            global.io.to(`client_${clientId}`).emit('intent_training_complete', {
              success: true, message: 'Phrase learned. Brain optimized.'
            });
          }
        } catch (err) {
          console.error('[ResolvePhrase] Background training failed:', err.message);
        }
      });
    }

    // Respond immediately — don't wait for retraining
    res.status(200).json({ 
        success: true, 
        message: action === 'ASSIGN' ? 'Pattern assigned. Brain optimizing in background.' : 'Pattern ignored successfully.' 
    });

  } catch (error) {
    console.error('[IntentApi] Resolve Error:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve unrecognized loop pattern.' });
  }
};

/**
 * TASK 4 BRIDGE: Fetches PENDING unrecognized phrases with pagination.
 * GAP 10 FIX: Added pagination support.
 */
exports.getPendingPhrases = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const [phrases, total] = await Promise.all([
      UnrecognizedPhrase.find({ clientId, status: 'PENDING' })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      UnrecognizedPhrase.countDocuments({ clientId, status: 'PENDING' })
    ]);

    res.status(200).json({
      success: true,
      phrases,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch pending intelligence gaps.' });
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
    
    // Count active intents and pending phrases
    const [activeIntents, pendingPhrases, analyticsStats] = await Promise.all([
      IntentRule.countDocuments({ clientId, isActive: true }),
      UnrecognizedPhrase.countDocuments({ clientId, status: 'PENDING' }),
      IntentAnalytics.find({ clientId }).sort({ date: -1 }).limit(30)
    ]);

    // Calculate totals from analytics
    const totals = analyticsStats.reduce((acc, curr) => ({
      totalProcessed: acc.totalProcessed + curr.totalMessagesProcessed,
      totalMatched: acc.totalMatched + curr.intentsMatched,
      totalFallback: acc.totalFallback + (curr.fallbackCount || 0)
    }), { totalProcessed: 0, totalMatched: 0, totalFallback: 0 });

    const accuracy = totals.totalProcessed > 0
      ? parseFloat(((totals.totalMatched / totals.totalProcessed) * 100).toFixed(1))
      : 100;

    res.status(200).json({ 
      success: true, 
      stats: {
        activeIntents,
        pendingPhrases,
        totalLearningHits: totals.totalMatched,
        accuracy
      }
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
 * GAP 9: Bulk resolve multiple unrecognized phrases at once.
 * Only triggers ONE background retrain after all assignments complete.
 */
exports.resolveBulk = async (req, res) => {
  try {
    const { phraseIds, action, intentId } = req.body;
    const clientId = resolveClientId(req);

    if (!clientId) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    if (!phraseIds?.length) return res.status(400).json({ success: false, message: 'No phrases selected.' });

    if (action === 'IGNORE') {
      await UnrecognizedPhrase.updateMany(
        { _id: { $in: phraseIds }, clientId },
        { $set: { status: 'IGNORED' } }
      );
    } else if (action === 'ASSIGN') {
      if (!intentId) return res.status(400).json({ message: 'Target intentId required for ASSIGN action.' });

      const rule = await IntentRule.findOne({ _id: intentId, clientId });
      if (!rule) return res.status(404).json({ message: 'Target Intent Rule not found.' });

      // Fetch all phrases to assign
      const phrases = await UnrecognizedPhrase.find({ _id: { $in: phraseIds }, clientId });
      const newPhrases = phrases
        .map(p => p.phrase)
        .filter(p => !rule.trainingPhrases.includes(p));

      if (newPhrases.length > 0) {
        await IntentRule.updateOne(
          { _id: intentId, clientId },
          { $push: { trainingPhrases: { $each: newPhrases } } }
        );
      }

      await UnrecognizedPhrase.updateMany(
        { _id: { $in: phraseIds }, clientId },
        { $set: { status: 'RESOLVED' } }
      );

      // ONE background retrain for all assignments
      setImmediate(async () => {
        try {
          await NlpEngineService.trainClientModel(clientId);
          if (global.io) {
            global.io.to(`client_${clientId}`).emit('intent_training_complete', {
              success: true, message: `${phraseIds.length} phrases learned. Brain optimized.`
            });
          }
        } catch (err) {
          console.error('[ResolveBulk] Background training failed:', err.message);
        }
      });
    }

    res.status(200).json({
      success: true,
      message: `${phraseIds.length} phrases ${action === 'ASSIGN' ? 'assigned' : 'ignored'} successfully.`
    });
  } catch (error) {
    console.error('[IntentApi] Bulk Resolve Error:', error);
    res.status(500).json({ success: false, error: 'Bulk resolve failed.' });
  }
};

/**
 * NEW 3: Suggest intent clusters from unrecognized phrases.
 * Groups PENDING phrases by common word overlap for auto-intent suggestions.
 */
exports.suggestClusters = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const phrases = await UnrecognizedPhrase.find({ clientId, status: 'PENDING' })
      .sort({ createdAt: -1 })
      .limit(200);

    if (phrases.length < 3) {
      return res.status(200).json({ success: true, clusters: [] });
    }

    // Simple word-overlap clustering (2-gram approach)
    const phraseTexts = phrases.map(p => ({
      id: p._id,
      text: p.phrase.toLowerCase().trim(),
      words: p.phrase.toLowerCase().trim().split(/\s+/)
    }));

    const clusters = [];
    const used = new Set();

    for (let i = 0; i < phraseTexts.length; i++) {
      if (used.has(i)) continue;
      const cluster = [phraseTexts[i]];
      used.add(i);

      for (let j = i + 1; j < phraseTexts.length; j++) {
        if (used.has(j)) continue;
        // Check word overlap (at least 2 common words)
        const commonWords = phraseTexts[i].words.filter(w =>
          w.length > 2 && phraseTexts[j].words.includes(w)
        );
        if (commonWords.length >= 2) {
          cluster.push(phraseTexts[j]);
          used.add(j);
        }
      }

      if (cluster.length >= 3) {
        // Generate a suggested name from most common words
        const wordFreq = {};
        cluster.forEach(c => c.words.forEach(w => {
          if (w.length > 2) wordFreq[w] = (wordFreq[w] || 0) + 1;
        }));
        const topWords = Object.entries(wordFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

        clusters.push({
          suggestedName: topWords.join(' ') + ' Query',
          phrases: cluster.map(c => c.text),
          phraseIds: cluster.map(c => c.id),
          count: cluster.length
        });
      }
    }

    res.status(200).json({ success: true, clusters: clusters.slice(0, 5) });
  } catch (error) {
    console.error('[IntentApi] Cluster Suggestion Error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate clusters.' });
  }
};

/**
 * Integration 3: Intent analytics for dashboard charts.
 */
exports.getIntentAnalytics = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const period = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    const startDateStr = startDate.toISOString().split('T')[0];

    const [dailyStats, topIntents] = await Promise.all([
      IntentAnalytics.find({ clientId, date: { $gte: startDateStr } }).sort({ date: 1 }),
      IntentRule.find({ clientId, isActive: true })
        .select('intentName totalTriggerCount lastTriggeredAt')
        .sort({ totalTriggerCount: -1 })
        .limit(10)
    ]);

    const dailyHits = dailyStats.map(d => ({
      date: d.date,
      matched: d.intentsMatched,
      fallback: d.fallbackCount,
      total: d.totalMessagesProcessed
    }));

    const totalProcessed = dailyStats.reduce((s, d) => s + d.totalMessagesProcessed, 0);
    const totalMatched = dailyStats.reduce((s, d) => s + d.intentsMatched, 0);
    const avgConfidence = totalProcessed > 0
      ? parseFloat(((totalMatched / totalProcessed) * 100).toFixed(1))
      : 100;

    res.status(200).json({
      success: true,
      dailyHits,
      topIntents: topIntents.map(i => ({
        intentName: i.intentName,
        count: i.totalTriggerCount || 0,
        lastTriggered: i.lastTriggeredAt
      })),
      avgConfidence
    });
  } catch (error) {
    console.error('[IntentApi] Analytics Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics.' });
  }
};

/**
 * MODULE 1: THE EPHEMERAL INTENT SIMULATOR (Sandbox)
 * Tests trained intents without firing actual webhooks or saving to database.
 * BUG 6 FIX: Uses unified CONFIDENCE_THRESHOLD from nlpConfig.
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

    const clientId = req.user?.clientId || req.query?.clientId || req.body?.clientId;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Client ID required for generation.' });
    }
    
    const Client = require('../models/Client');
    const client = await Client.findOne({ clientId });
    const apiKey = client?.ai?.geminiApiKey || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.warn('[IntentApi] No Gemini API key found for UI generation.');
      return res.status(403).json({ 
        success: false, 
        message: 'AI Generation is currently unavailable. Configure an API key.' 
      });
    }

    const { botGenerateJSON } = require('../utils/gemini');
    
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

    console.log(`[IntentGeneration] Triggering AI generation (botGenerateJSON) for: "${description.substring(0, 50)}..."`);
    const generatedData = await botGenerateJSON(prompt, apiKey, { 
      maxTokens: 4000, 
      temperature: 0.9, 
      maxRetries: 3, 
      timeout: 25000 
    });

    if (!generatedData) {
      return res.status(502).json({ 
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
    const statusCode = error.message?.includes('invalid') ? 422 : 502;
    res.status(statusCode).json({ 
      success: false, 
      error: 'AI Generation Failed: ' + (error.message || 'The service is temporarily unavailable.') 
    });
  }
};
