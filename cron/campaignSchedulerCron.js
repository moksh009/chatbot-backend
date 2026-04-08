const cron = require('node-cron');
const Campaign = require('../models/Campaign');

const scheduleCampaignCron = () => {
  // Run every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      // Evaluation Phase: Find AB Tests due for winner selection
      const pendingEvaluations = await Campaign.find({
        isAbTest: true,
        status: "SCHEDULED",
        "abTestConfig.holdbackProcessed": false,
        scheduledAt: { $lte: new Date() }
      });

      for (const campaign of pendingEvaluations) {
        console.log(`[CampaignCron] 🏆 Evaluating winner for Campaign: ${campaign.name}`);
        
        // Find variant with best reply rate
        const variants = campaign.abVariants;
        const winner = variants.reduce((prev, current) => {
          const prevRate = (prev.repliedCount / (prev.sentCount || 1));
          const currentRate = (current.repliedCount / (current.sentCount || 1));
          return currentRate > prevRate ? current : prev;
        });

        console.log(`[CampaignCron] 🎉 Winner is Variant ${winner.label} (${winner.templateName})`);
        campaign.winnerVariant = winner.label;
        campaign.status = 'SENDING_WINNER'; // New state
        await campaign.save();

        // Trigger the winner dispatch logic (usually a separate service or function)
        // Here we would ideally call a 'dispatchToHoldback(campaignId, winner)' function
      }

      // Normal Dispatch Phase
      const scheduled = await Campaign.find({
        status: "SCHEDULED",
        isAbTest: false, // Don't pick up evaluation-pending AB tests as normal ones
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
