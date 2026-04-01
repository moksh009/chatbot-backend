const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const { sendWhatsAppText, sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
const { sendEmail } = require('../utils/emailService');
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

const scheduleFollowUpSequenceCron = () => {
  // Run every 5 minutes for better responsiveness
  cron.schedule("*/5 * * * *", async () => {
    try {
      const now = new Date();
      // Find active sequences with at least one pending step due
      const sequences = await FollowUpSequence.find({
        status: "active",
        "steps.status": "pending",
        "steps.sendAt": { $lte: now }
      });

      console.log(`[SequenceCron] Found ${sequences.length} sequences with due steps.`);

      for (const seq of sequences) {
        // Find the FIRST pending step that is due
        const dueStep = seq.steps.find(
          s => s.status === "pending" && s.sendAt <= now
        );
        if (!dueStep) continue;

        const client = await Client.findOne({ clientId: seq.clientId });
        if (!client) {
            dueStep.status = "failed";
            dueStep.errorLog = "Client not found";
            await seq.save();
            continue;
        }

        let sentSuccess = false;
        let errorMessage = "";

        if (dueStep.type === 'whatsapp') {
            if (!client.whatsappToken || !client.phoneNumberId) {
                errorMessage = "WhatsApp not configured";
            } else {
                const token = decrypt(client.whatsappToken);
                const phoneId = client.phoneNumberId;
                
                if (dueStep.templateName) {
                    const res = await sendWhatsAppTemplate({
                        phoneNumberId: phoneId,
                        to: seq.phone,
                        templateName: dueStep.templateName,
                        token: token
                    });
                    sentSuccess = res.success;
                    errorMessage = res.error || "";
                } else {
                    const res = await sendWhatsAppText({
                        phoneNumberId: phoneId,
                        to: seq.phone,
                        body: dueStep.content,
                        token: token
                    });
                    sentSuccess = res.success;
                    errorMessage = res.error || "";
                }
            }
        } else if (dueStep.type === 'email') {
            if (!seq.email) {
                errorMessage = "No email address for lead";
            } else {
                const success = await sendEmail(client, {
                    to: seq.email,
                    subject: dueStep.subject || "Follow-up",
                    html: dueStep.content
                });
                sentSuccess = success;
                if (!success) errorMessage = "Email sending failed";
            }
        }

        if (sentSuccess) {
          dueStep.status = "sent";
          dueStep.sentAt = new Date();
          dueStep.errorLog = "";
        } else {
          dueStep.status = "failed";
          dueStep.errorLog = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
        }

        // Check if this was the last step
        const stillPending = seq.steps.some(s => s.status === "pending");
        if (!stillPending) {
            seq.status = "completed";
        }

        await seq.save();
      }
    } catch (err) {
      console.error('❌ Error in follow-up sequence cron:', err);
    }
  });
};

module.exports = scheduleFollowUpSequenceCron;
