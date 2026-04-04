const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const WhatsApp = require('../utils/whatsapp');
const { sendEmail } = require('../utils/emailService');
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

const { buildVariableContext, injectVariables } = require('../utils/variableInjector');

// Helper to evaluate step conditions
const evaluateStepCondition = (conditionStr, lead, convo) => {
    if (!conditionStr || conditionStr === "always") return true;
    if (conditionStr === "no_purchase" && lead?.ordersCount > 0) return false;
    // can add more custom conditions here later
    return true;
};

let cronRunning = false;

const scheduleFollowUpSequenceCron = () => {
    // Run every 5 minutes
    cron.schedule("*/5 * * * *", async () => {
        if (cronRunning) { 
            console.log("[SequenceCron] Previous run still active, skipping"); 
            return; 
        }
        cronRunning = true;
        try {
            const now = new Date();
            // Fetch limits mapped to index status and pending checks 
            const sequences = await FollowUpSequence.find({
                status: "active",
                "steps.status": "pending",
                "steps.sendAt": { $lte: now }
            }).limit(500);

            console.log(`[SequenceCron] Found ${sequences.length} sequences with due steps.`);

            for (const seq of sequences) {
                const dueStep = seq.steps.find(s => s.status === "pending" && s.sendAt <= now);
                if (!dueStep) continue;

                const [client, lead] = await Promise.all([
                    Client.findOne({ clientId: seq.clientId }),
                    AdLead.findById(seq.leadId)
                ]);

                if (!client || !lead) {
                    dueStep.status = "failed";
                    dueStep.errorLog = !client ? "Client not found" : "Lead not found";
                    await seq.save();
                    continue;
                }

                if (dueStep.condition && !evaluateStepCondition(dueStep.condition, lead, null)) {
                    dueStep.status = "skipped";
                    dueStep.errorLog = "Condition not met";
                    await seq.save();
                    continue;
                }

                let sentSuccess = false;
                let errorMessage = "";

                // Hydrate content with centralized variable mapping via context
                const ctx = await buildVariableContext(client, seq.phone, null, lead);
                const hydratedContent = injectVariables(dueStep.content, ctx);
                const hydratedSubject = injectVariables(dueStep.subject, ctx);

                if (dueStep.type === 'whatsapp') {
                    if (!client.whatsappToken || !client.phoneNumberId) {
                        errorMessage = "WhatsApp not configured";
                    } else {
                        // Ensure WhatsApp configuration is synced into the client instance for WhatsApp.sendSmartTemplate
                        if (dueStep.templateName) {
                            try {
                                await WhatsApp.sendSmartTemplate(
                                    client, 
                                    seq.phone, 
                                    dueStep.templateName, 
                                    [lead?.name || "there", lead?.email || "-", lead?.city || "-"],
                                    null,
                                    client.languageCode || 'en'
                                );
                                sentSuccess = true;
                            } catch (e) {
                                sentSuccess = false;
                                errorMessage = e.friendlyMessage || e.message || "Failed to send WhatsApp template.";
                            }
                        } else {
                             try {
                                await WhatsApp.sendText(client, seq.phone, hydratedContent);
                                sentSuccess = true;
                             } catch (e) {
                                sentSuccess = false;
                                errorMessage = e.friendlyMessage || e.message || "Failed to send WhatsApp text.";
                             }
                        }
                    }
                } else if (dueStep.type === 'email') {
                    if (!seq.email && !lead?.email) {
                        errorMessage = "No email address for lead";
                    } else {
                        const success = await sendEmail(client, {
                            to: seq.email || lead?.email,
                            subject: hydratedSubject || "A message from our store",
                            html: hydratedContent
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

                const stillPending = seq.steps.some(s => s.status === "pending");
                if (!stillPending) seq.status = "completed";

                await seq.save();
            }
        } catch (err) {
            console.error('❌ Error in follow-up sequence cron:', err);
        } finally {
            cronRunning = false;
        }
    });
};

module.exports = scheduleFollowUpSequenceCron;
