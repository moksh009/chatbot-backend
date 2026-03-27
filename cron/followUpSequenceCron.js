const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const { sendWhatsAppText } = require('../utils/whatsappHelpers'); // or whatever sender exist
// Note: We might need to import specific WhatsApp sending functions from utils or engines.

const scheduleFollowUpSequenceCron = () => {
  // Run every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    try {
      // Find active sequences with pending steps whose sendAt time has passed
      const sequences = await FollowUpSequence.find({
        status: "active",
        "steps.status": "pending",
        "steps.sendAt": { $lte: new Date() }
      }).populate("clientId");

      for (const seq of sequences) {
        // Find the specific due step
        const dueStep = seq.steps.find(
          s => s.status === "pending" && s.sendAt <= new Date()
        );
        if (!dueStep) continue;

        // Fetch client credentials required to send message
        const client = await require('../models/Client').findOne({ clientId: seq.clientId.clientId || seq.clientId });
        if (!client || !client.whatsappToken || !client.phoneNumberId) {
            dueStep.status = "failed";
            await seq.save();
            continue;
        }

        // Send via WhatsApp
        // TODO: Actually send message depending on template/text structure.
        // Assuming plain text for now.
        const token = client.whatsappToken;
        const phoneId = client.phoneNumberId;
        
        try {
          // If body is text
          await sendWhatsAppText({
             phoneNumberId: phoneId,
             to: seq.phone,
             body: dueStep.message,
             token: token
          });
          dueStep.status = "sent";
          dueStep.sentAt = new Date();
        } catch (err) {
          console.error(`❌ FollowUpSequence failed sending to ${seq.phone}:`, err.message);
          dueStep.status = "failed";
        }

        const allDone = seq.steps.every(s => s.status === "sent" || s.status === "failed");
        if (allDone) seq.status = "completed";

        await seq.save();
      }
    } catch (err) {
      console.error('❌ Error in follow-up sequence cron:', err);
    }
  });
};

module.exports = scheduleFollowUpSequenceCron;
