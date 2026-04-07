const cron = require('node-cron');
const Client = require('../models/Client');
const Conversation = require('../models/Conversation');
const Competitor = require('../models/Competitor');
const CustomerIntelligence = require('../models/CustomerIntelligence');
const { computeDNA } = require('../utils/customerIntelligence');
const { scoreConversation } = require('../utils/qualityScorer');
const { forecastDemand, formatForecastMessage } = require('../utils/demandForecaster');
const { fetchCompetitorPrice } = require('../utils/competitorMonitor');
const { sendWhatsAppText } = require('../utils/dualBrainEngine');
const logger = require('../utils/logger')('IntelligenceCron');

/**
 * 2 AM Daily: Recompute DNA for high-frequency or active leads.
 * Also triggers Inventory Forecast (7:30 AM IST).
 */
cron.schedule('0 2 * * *', async () => {
  logger.info('Starting daily DNA and Forecast cycle...');
  try {
    const clients = await Client.find({ isActive: true }).lean();
    
    for (const client of clients) {
      // 1. DNA Recomputation
      const apiKey = client.geminiApiKey || process.env.GEMINI_API_KEY;
      if (apiKey) {
        const activeDNAs = await CustomerIntelligence.find({
          clientId: client.clientId,
          updatedAt: { $gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }).limit(500);

        for (const dna of activeDNAs) {
          await computeDNA(client.clientId, dna.phone, apiKey);
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // 2. Inventory Forecast (7:30 AM IST)
      const forecasts = await forecastDemand(client);
      if (forecasts && forecasts.length > 0) {
        const critical = forecasts.filter(f => f.urgency === 'critical' || f.urgency === 'out_of_stock');
        if (critical.length > 0 && client.adminPhone) {
          const message = formatForecastMessage(forecasts, client.businessName);
          await sendWhatsAppText(client, client.adminPhone, message);
        }
      }
    }
  } catch (error) {
    logger.error('Daily 2AM Cron Critical Error:', error.message);
  }
});

/**
 * Every 30 Minutes: Quality Scoring for resolved conversations.
 */
cron.schedule('*/30 * * * *', async () => {
  try {
    const recentResolved = await Conversation.find({
      status: 'resolved',
      updatedAt: { $gte: new Date(Date.now() - 40 * 60000) },
      'qualityScore.totalScore': { $exists: false }
    }).limit(50).lean();

    for (const convo of recentResolved) {
      await scoreConversation(convo._id, convo.clientId);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { logger.error('Quality Scoring cron failed:', err.message); }
});

/**
 * 1:30 AM UTC (7:00 AM IST): Competitor Price Monitor.
 */
cron.schedule('30 1 * * *', async () => {
  try {
    const clients = await Client.find({ isActive: true }).select('clientId geminiApiKey').lean();
    for (const client of clients) {
      const competitors = await Competitor.find({ clientId: client.clientId, isActive: true });
      for (const comp of competitors) {
        for (const prod of comp.products) {
          const price = await fetchCompetitorPrice(prod, client.geminiApiKey || process.env.GEMINI_API_KEY);
          if (price) {
            prod.lastKnownPrice = price;
            prod.lastCheckedAt = new Date();
            prod.priceHistory.push({ price, checkedAt: new Date() });
            if (prod.priceHistory.length > 30) prod.priceHistory.shift();
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        await comp.save();
      }
    }
  } catch (err) { logger.error('Competitor Monitor cron failed:', err.message); }
});

/**
 * 9 AM Daily: Churn Risk analysis.
 */
cron.schedule('0 9 * * *', async () => {
  try {
    const threshold = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const atRisk = await CustomerIntelligence.find({
      updatedAt: { $lt: threshold },
      churnRiskScore: { $lt: 80 }
    });

    for (const dna of atRisk) {
      dna.churnRiskScore = Math.min(100, (dna.churnRiskScore || 0) + 20);
      await dna.save();
    }
  } catch (err) { logger.error('Churn analysis failed:', err.message); }
});
