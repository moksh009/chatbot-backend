const cron = require('node-cron');
const Client = require('../models/Client');
// const { generateDailyInsights } = require('../services/insightsService'); // Placeholder

const scheduleInsightsCron = () => {
  // Insights regeneration (daily at midnight)
  cron.schedule("0 0 * * *", async () => {
    try {
      // Find all active clients
      const clients = await Client.find({}); // Add isActive field filtering if it exists
      
      for (const client of clients) {
        console.log(`🧠 Generating insights for client ${client.clientId}`);
        // await generateDailyInsights(client._id);
        
        // Placeholder update 
        client.insights = [
          {
            type: "info",
            message: "Your best response time is between 2-4 PM.",
            actionUrl: "/campaigns",
            estimatedValue: 0,
            generatedAt: new Date()
          }
        ];
        await client.save();
      }
    } catch (err) {
      console.error('❌ Error in Insights cron:', err);
    }
  });
};

module.exports = scheduleInsightsCron;
