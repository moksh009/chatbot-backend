const IntentRule = require('../models/IntentRule');
const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const NlpEngineService = require('../services/NlpEngineService');
const IntentAnalytics = require('../models/IntentAnalytics');

/**
 * Controller for managing Intent Rules and resolving unrecognized phrases.
 */

// 1. Create or Update Intent Rule
exports.upsertIntent = async (req, res) => {
  try {
    const { intentName, trainingPhrases, actions, languageConfig, intentId } = req.body;
    const { clientId } = req.user; // From DashboardAuthMiddleware

    if (!intentName || !trainingPhrases?.length || !actions?.length) {
      return res.status(400).json({ success: false, message: 'Missing required intent fields' });
    }

    let rule;
    if (intentId) {
      rule = await IntentRule.findOneAndUpdate(
        { _id: intentId, clientId },
        { intentName, trainingPhrases, actions, languageConfig },
        { new: true }
      );
    } else {
      rule = await IntentRule.create({
        clientId,
        intentName,
        trainingPhrases,
        actions,
        languageConfig
      });
    }

    // CRITICAL: Instantly trigger model retraining
    await NlpEngineService.trainClientModel(clientId);

    res.status(200).json({ 
      success: true, 
      message: 'Intent saved and model retrained successfully', 
      rule 
    });
  } catch (error) {
    console.error('[IntentApi] Upsert Error:', error);
    res.status(500).json({ success: false, message: 'Failed to save intent' });
  }
};

// 2. Resolve Unrecognized Phrase
exports.resolvePhrase = async (req, res) => {
  try {
    const { phraseId, intentId, action } = req.body;
    const { clientId } = req.user;

    const unrecognized = await UnrecognizedPhrase.findOne({ _id: phraseId, clientId });
    if (!unrecognized) return res.status(404).json({ message: 'Phrase not found' });

    if (action === 'IGNORE') {
      unrecognized.status = 'IGNORED';
      await unrecognized.save();
    } else if (action === 'ASSIGN') {
      const rule = await IntentRule.findOne({ _id: intentId, clientId });
      if (!rule) return res.status(404).json({ message: 'Target intent not found' });

      // Add the phrase to training set
      if (!rule.trainingPhrases.includes(unrecognized.phrase)) {
        rule.trainingPhrases.push(unrecognized.phrase);
        await rule.save();
      }

      unrecognized.status = 'RESOLVED';
      await unrecognized.save();

      // Trigger retraining
      await NlpEngineService.trainClientModel(clientId);
    }

    res.status(200).json({ success: true, message: 'Phrase resolved' });
  } catch (error) {
    console.error('[IntentApi] Resolve Error:', error);
    res.status(500).json({ success: false, message: 'Resolution failed' });
  }
};

// 3. Get Intents for Dashboard
exports.getIntents = async (req, res) => {
  try {
    const { clientId } = req.user;
    const intents = await IntentRule.find({ clientId });
    res.status(200).json({ success: true, intents });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Fetch failed' });
  }
};

// 4. Get Pending Phrases for Training Inbox
exports.getPendingPhrases = async (req, res) => {
  try {
    const { clientId } = req.user;
    const phrases = await UnrecognizedPhrase.find({ clientId, status: 'PENDING' }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, phrases });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Fetch failed' });
  }
};

// 5. Get Brain Stats for Intelligence Hub
exports.getIntentStats = async (req, res) => {
  try {
    const { clientId } = req.user;
    
    const [intentsCount, pendingCount, analytics] = await Promise.all([
      IntentRule.countDocuments({ clientId, isActive: true }),
      UnrecognizedPhrase.countDocuments({ clientId, status: 'PENDING' }),
      IntentAnalytics.find({ clientId })
    ]);

    // Aggregate lifetime matching stats
    let totalProcessed = 0;
    let totalMatched = 0;
    
    analytics.forEach(stat => {
      totalProcessed += (stat.totalMessagesProcessed || 0);
      totalMatched += (stat.intentsMatched || 0);
    });

    const accuracy = totalProcessed > 0 
      ? ((totalMatched / totalProcessed) * 100).toFixed(1) 
      : "100.0"; // New bots start with perfect (theoretical) accuracy

    res.status(200).json({
      success: true,
      stats: {
        activeIntents: intentsCount,
        pendingPhrases: pendingCount,
        totalLearningHits: totalProcessed,
        accuracy: parseFloat(accuracy)
      }
    });
  } catch (error) {
    console.error('[IntentApi] Stats Error:', error);
    res.status(500).json({ success: false, message: 'Stats calculation failed' });
  }
};
