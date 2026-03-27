const cron = require('node-cron');
const Campaign = require('../models/Campaign');

const scheduleAbTestCron = () => {
  // A/B test winner evaluator (runs hourly)
  cron.schedule("0 * * * *", async () => {
    try {
      const abCampaigns = await Campaign.find({
        isAbTest: true,
        winnerVariant: { $exists: false },
        createdAt: { $lte: new Date(Date.now() - 4 * 60 * 60 * 1000) }
      });
      
      for (const campaign of abCampaigns) {
        if (!campaign.abVariants || campaign.abVariants.length < 2) continue;
        
        const varA = campaign.abVariants.find(v => v.label === "A");
        const varB = campaign.abVariants.find(v => v.label === "B");
        
        if (!varA || !varB) continue;

        // Compare by winner criteria (using repliedCount as default)
        const scoreA = varA.repliedCount || 0;
        const scoreB = varB.repliedCount || 0;
        
        // Winner logic
        const winner = scoreA >= scoreB ? "A" : "B";
        campaign.winnerVariant = winner;
        await campaign.save();
        
        console.log(`🏆 AB Test concluded for ${campaign._id}, winner is variant ${winner}`);
        
        // TODO: Send winner variant to the remaining audience
      }
    } catch (err) {
      console.error('❌ Error in AB Test cron:', err);
    }
  });
};

module.exports = scheduleAbTestCron;
