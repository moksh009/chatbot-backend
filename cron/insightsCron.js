const cron = require('node-cron');
const Client = require('../models/Client');
const DailyStat = require('../models/DailyStat');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');

/**
 * Phase 8: AI Insights Background Cron
 * Generates daily insights per client and caches them in Client.insights[]
 * Runs at 6:30 AM IST (1:00 AM UTC) so data from the previous day is complete.
 * Frontend SmartInsights component reads from cache instead of calling AI live.
 */
const scheduleInsightsCron = () => {
  // Daily at 1:00 AM UTC = 6:30 AM IST
  cron.schedule("0 1 * * *", async () => {
    console.log('🧠 [InsightsCron] Starting daily insight generation...');
    try {
      const clients = await Client.find({}).select('clientId nicheData storeType').lean();

      for (const client of clients) {
        try {
          const insights = await generateInsightsForClient(client.clientId);
          await Client.findOneAndUpdate(
            { clientId: client.clientId },
            { $set: { insights, insightsGeneratedAt: new Date() } }
          );
          console.log(`🧠 [InsightsCron] ✅ Generated ${insights.length} insights for ${client.clientId}`);
        } catch (clientErr) {
          console.error(`🧠 [InsightsCron] ❌ Failed for ${client.clientId}:`, clientErr.message);
        }
      }
      console.log('🧠 [InsightsCron] Completed.');
    } catch (err) {
      console.error('❌ Error in Insights cron:', err);
    }
  });
};

/**
 * Generate insights for a single client using pre-computed data patterns.
 * This avoids Gemini API calls and instead uses rule-based heuristics
 * on DailyStat trends for deterministic, fast insight generation.
 */
async function generateInsightsForClient(clientId) {
  const insights = [];
  const now = new Date();

  // Last 7 days of stats
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const stats = await DailyStat.find({
    clientId,
    date: { $gte: weekAgoStr }
  }).sort({ date: 1 }).lean();

  if (stats.length === 0) {
    insights.push({
      type: 'info',
      icon: '📊',
      message: 'Start engaging customers to unlock performance insights.',
      actionUrl: '/marketing-hub',
      estimatedValue: 0,
      generatedAt: now
    });
    return insights;
  }

  // --- 1. Cart Recovery Performance ---
  const totalCartsSent = stats.reduce((s, d) => s + (d.abandonedCartSent || 0), 0);
  const totalRecovered = stats.reduce((s, d) => s + (d.cartsRecovered || 0), 0);
  const recoveryRate = totalCartsSent > 0 ? ((totalRecovered / totalCartsSent) * 100).toFixed(1) : 0;
  const revenueRecovered = stats.reduce((s, d) => s + (d.cartRevenueRecovered || 0), 0);

  if (totalCartsSent > 0) {
    insights.push({
      type: recoveryRate > 15 ? 'success' : 'warning',
      icon: recoveryRate > 15 ? '🎯' : '⚠️',
      message: `Cart recovery rate is ${recoveryRate}% (${totalRecovered}/${totalCartsSent} recovered). ${recoveryRate > 15 ? 'Great performance!' : 'Consider optimizing your recovery messages.'}`,
      actionUrl: '/audience-hub?tab=abandoned',
      estimatedValue: revenueRecovered,
      generatedAt: now
    });
  }

  // --- 2. COD to Prepaid Conversion ---
  const codConverted = stats.reduce((s, d) => s + (d.codConvertedCount || 0), 0);
  const codRevenue = stats.reduce((s, d) => s + (d.codConvertedRevenue || 0), 0);

  if (codConverted > 0) {
    insights.push({
      type: 'success',
      icon: '💳',
      message: `${codConverted} COD orders converted to prepaid this week, saving ₹${codRevenue.toLocaleString('en-IN')} in potential RTO costs.`,
      actionUrl: '/orders',
      estimatedValue: codRevenue,
      generatedAt: now
    });
  }

  // --- 3. Engagement Trend ---
  const totalChats = stats.reduce((s, d) => s + (d.totalChats || 0), 0);
  const totalMessages = stats.reduce((s, d) => s + (d.totalMessagesExchanged || 0), 0);
  const avgDailyChats = stats.length > 0 ? Math.round(totalChats / stats.length) : 0;

  if (avgDailyChats > 0) {
    // Compare first half vs second half of the week
    const mid = Math.floor(stats.length / 2);
    const firstHalf = stats.slice(0, mid).reduce((s, d) => s + (d.totalChats || 0), 0);
    const secondHalf = stats.slice(mid).reduce((s, d) => s + (d.totalChats || 0), 0);
    const trend = secondHalf > firstHalf ? 'increasing' : secondHalf < firstHalf ? 'decreasing' : 'stable';

    insights.push({
      type: trend === 'increasing' ? 'success' : trend === 'decreasing' ? 'warning' : 'info',
      icon: trend === 'increasing' ? '📈' : trend === 'decreasing' ? '📉' : '➡️',
      message: `Chat volume is ${trend} — averaging ${avgDailyChats} conversations/day with ${totalMessages.toLocaleString()} total messages this week.`,
      actionUrl: '/live-chat',
      estimatedValue: 0,
      generatedAt: now
    });
  }

  // --- 4. Peak Hours Insight ---
  const hourBuckets = {};
  stats.forEach(d => {
    // Use the date to infer day-of-week distribution
    const dayOfWeek = new Date(d.date).getDay();
    hourBuckets[dayOfWeek] = (hourBuckets[dayOfWeek] || 0) + (d.totalChats || 0);
  });
  const peakDay = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (peakDay && peakDay[1] > 0) {
    insights.push({
      type: 'info',
      icon: '⏰',
      message: `Your busiest day is ${dayNames[peakDay[0]]} with ${peakDay[1]} conversations. Consider scheduling broadcasts around peak days for maximum engagement.`,
      actionUrl: '/marketing-hub?tab=campaigns',
      estimatedValue: 0,
      generatedAt: now
    });
  }

  // --- 5. High-Intent Leads Opportunity ---
  const highIntentCount = await AdLead.countDocuments({
    clientId,
    leadScore: { $gte: 70 },
    ordersCount: { $in: [0, null] }
  });

  if (highIntentCount > 0) {
    insights.push({
      type: 'action',
      icon: '🔥',
      message: `${highIntentCount} high-intent leads haven't purchased yet. A targeted broadcast could convert them.`,
      actionUrl: '/audience-hub?segmentScore=70-100',
      estimatedValue: highIntentCount * 500, // estimated ₹500 per conversion
      generatedAt: now
    });
  }

  return insights.slice(0, 6); // Cap at 6 insights
}

module.exports = scheduleInsightsCron;
