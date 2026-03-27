const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const Client = require('../models/Client');

const scheduleCsatCron = () => {
  // CSAT follow-up (check resolved conversations needing CSAT)
  cron.schedule("*/10 * * * *", async () => {
    try {
      const resolved = await Conversation.find({
        status: "CLOSED", // Maps to 'resolved' in our system or 'CLOSED'
        resolvedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) }, // 5 min after resolve
        csatScore: { $exists: false },
        csatSent: { $ne: true }
      });
      
      for (const convo of resolved) {
        // Find client config to verify CSAT is enabled
        const client = await Client.findOne({ clientId: convo.clientId });
        if (!client) continue;

        // Auto-send CSAT configured checking
        // if (!client.config.autoCsat) continue;

        console.log(`⭐ Sending CSAT to ${convo.phone} for client ${convo.clientId}`);
        // TODO: Actually send the 5-star or Great/Good/Okay/Bad button message
        
        convo.csatSent = true;
        await convo.save();
      }
    } catch (err) {
      console.error('❌ Error in CSAT cron:', err);
    }
  });
};

module.exports = scheduleCsatCron;
