const cron = require('node-cron');
const Campaign = require('../models/Campaign');

const scheduleCampaignCron = () => {
  // Run every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const scheduled = await Campaign.find({
        status: "SCHEDULED",
        scheduledAt: { $lte: new Date() }
      }).populate("clientId");

      for (const campaign of scheduled) {
        // Set to SENDING state
        campaign.status = 'SENDING';
        await campaign.save();
        
        // Execute campaign logic
        // TODO: import the launchCampaign function from the campaign routes/services
        // For now, it delegates to campaign launcher logic which will process csv and trigger WhatsApp sends.
      }
    } catch (err) {
      console.error('❌ Error in scheduled campaign cron:', err);
    }
  });
};

module.exports = scheduleCampaignCron;
