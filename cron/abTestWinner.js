const cron = require('node-cron');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Client = require('../models/Client');
const WhatsApp = require('../utils/whatsapp'); // Use unified helper

/**
 * Runs every 30 minutes to check if any A/B tests have reached their holdback timer.
 * If yes, it calculates the winner and sends the winning variant to the 80% holdout queue.
 */
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Running A/B Test winner evaluation...');
  try {
    // Find active campaigns that are AB tests, have not processed holdouts, and are older than their holdback Hours
    const campaigns = await Campaign.find({
      isAbTest: true,
      'abTestConfig.holdbackProcessed': false,
      status: 'COMPLETED'
    });

    for (const campaign of campaigns) {
      const waitHours = campaign.abTestConfig?.holdbackHours || 4;
      const cutoffTime = new Date(campaign.createdAt.getTime() + waitHours * 60 * 60 * 1000);

      if (new Date() >= cutoffTime) {
        console.log(`[AB Test] Evaluating Campaign ${campaign._id} ...`);
        
        let winnerTemplate = null;
        let winnerLabel = null;
        let highestRate = -1;

        // Determine winner
        const metric = campaign.abTestConfig?.winnerMetric || 'reply_rate';
        for (const variant of campaign.abVariants) {
          let score = 0;
          if (variant.sentCount > 0) {
            if (metric === 'reply_rate') {
              score = variant.repliedCount / variant.sentCount;
            } else if (metric === 'read_rate') {
              score = variant.readCount / variant.sentCount;
            } else if (metric === 'revenue') {
              score = variant.revenue; // Absolute revenue per variant
            }
          }
          if (score > highestRate) {
            highestRate = score;
            winnerTemplate = variant.templateName;
            winnerLabel = variant.label;
          }
        }

        console.log(`[AB Test] Winner is ${winnerLabel} (${winnerTemplate}) with score ${highestRate.toFixed(4)}`);

        // Mark as processed
        campaign.abTestConfig.holdbackProcessed = true;
        campaign.winnerVariant = winnerLabel;
        await campaign.save();

        if (campaign.abTestConfig?.autoSendWinner !== false && winnerTemplate) {
          console.log(`[AB Test] Dispensing winner template to holdout group...`);
          
          const client = await Client.findOne({ clientId: campaign.clientId });
          if (!client) continue;

          // Find holdouts
          const holdouts = await CampaignMessage.find({
            campaignId: campaign._id,
            abVariantLabel: 'holdout',
            status: 'queued'
          });

          let sent = 0;
          let failed = 0;

          for (const msg of holdouts) {
            try {
              const customerName = msg.metadata?.name || 'Customer';
              const respData = await WhatsApp.sendSmartTemplate(
                client, 
                msg.phone, 
                winnerTemplate, 
                [customerName], // Re-inject name variable
                null, // Header image if any (could extract from metadata if saved)
                'en' 
              );
              
              if (respData?.messages?.[0]?.id) {
                msg.status = 'sent';
                msg.messageId = respData.messages[0].id;
                msg.sentAt = new Date();
                sent++;
              } else {
                msg.status = 'failed';
                msg.failedAt = new Date();
                failed++;
              }
              await msg.save();
              await new Promise(resolve => setTimeout(resolve, 250)); // Throttling
            } catch (err) {
              msg.status = 'failed';
              msg.failedAt = new Date();
              await msg.save();
              failed++;
            }
          }

          console.log(`[AB Test] Holdout Send Complete: ${sent} sent, ${failed} failed.`);
          
          // Update campaign stats with holdout sends
          await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { sentCount: sent, failedCount: failed }
          });
        }
      }
    }

  } catch (error) {
    console.error('[Cron] AB Test Evaluation Error:', error.message);
  }
});
