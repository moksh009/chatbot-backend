const cron = require('node-cron');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const WhatsApp = require('../utils/whatsapp');
const { sendEmail } = require('../utils/emailService');
const Client = require('../models/Client');

const { buildVariableContext, injectVariables } = require('../utils/variableInjector');

// Helper to evaluate step conditions (strings must match FollowUpSequenceModal options)
const evaluateStepCondition = (conditionStr, lead) => {
    if (!conditionStr || conditionStr === 'always') return true;
    if (conditionStr === 'no_purchase' && (lead?.ordersCount || 0) > 0) return false;
    const score = lead?.leadScore ?? 0;
    const orders = lead?.ordersCount || 0;
    const cartVal = Number(lead?.cartValue || 0);
    const snapTotal = Number(lead?.cartSnapshot?.totalPrice || 0);
    const hasOpenCart = cartVal > 0 || snapTotal > 0 || (lead?.cartSnapshot?.items?.length || 0) > 0;

    if (conditionStr === 'lead_score_min_50') return score >= 50;
    if (conditionStr === 'lead_score_min_70') return score >= 70;
    if (conditionStr === 'lead_score_min_80') return score >= 80;
    if (conditionStr === 'has_placed_order') return orders >= 1;
    if (conditionStr === 'has_open_cart') return hasOpenCart;
    return true;
};

const isWhatsAppLikeStep = (t) => t && t !== 'email';

/**
 * Send one sequence step (WhatsApp-like or email). Mutates nothing except via return.
 */
async function dispatchSequenceStep({ dueStep, seq, client, lead, ctx }) {
    let sentSuccess = false;
    let errorMessage = '';

    const hydratedContent = injectVariables(dueStep.content || '', ctx);
    const hydratedSubject = injectVariables(dueStep.subject || '', ctx);

    if (isWhatsAppLikeStep(dueStep.type)) {
        if (!client.whatsappToken || !client.phoneNumberId) {
            errorMessage = 'WhatsApp not configured';
        } else {
            let finalContent = hydratedContent;
            const useAI = client.smartCartRecovery && seq.name?.toLowerCase().includes('recovery');

            if (useAI) {
                try {
                    const { generateSmartRecoveryMessage } = require('../utils/smartCartRecovery');
                    const stepIndex = seq.steps.indexOf(dueStep) + 1;
                    const aiMessage = await generateSmartRecoveryMessage(client, lead, stepIndex);
                    if (aiMessage) {
                        finalContent = aiMessage;
                        console.log(`[SequenceCron] 🔮 Using AI Smart Recovery message for ${seq.phone} (Step ${stepIndex})`);
                    }
                } catch (aiErr) {
                    console.error('[SequenceCron] Smart Recovery AI failed, falling back to static:', aiErr.message);
                }
            }

            let mediaUrl = null;
            if (dueStep.mediaType === 'static') {
                mediaUrl = dueStep.mediaUrl;
            } else if (dueStep.mediaType === 'dynamic') {
                mediaUrl = lead.cartSnapshot?.items?.[0]?.image || lead.cartSnapshot?.items?.[0]?.url;
                if (!mediaUrl && client.nicheData?.defaultProductImage) {
                    mediaUrl = client.nicheData.defaultProductImage;
                }
            }

            if (dueStep.templateName && !useAI) {
                try {
                    let templateParams = [lead?.name || 'there'];

                    if (seq.type === 'loyalty_reminder') {
                        templateParams = [
                            lead?.name || 'there',
                            ctx.loyalty_balance || '0',
                            ctx.loyalty_cash_value || '₹0',
                            ctx.loyalty_tier || 'Bronze',
                        ];
                    } else if (seq.type === 'review_request') {
                        templateParams = [
                            lead?.name || 'there',
                            dueStep.productName || lead?.cartSnapshot?.items?.[0]?.title || 'your purchase',
                        ];
                    } else if (seq.type === 'warranty_resend' || seq.type === 'warranty_certificate') {
                        templateParams = [
                            lead?.name || 'there',
                            ctx.warranty_id || '-',
                            ctx.warranty_expiry || '-',
                        ];
                    } else {
                        templateParams = [lead?.name || 'there', lead?.email || '-', lead?.city || '-'];
                    }

                    await WhatsApp.sendSmartTemplate(
                        client,
                        seq.phone,
                        dueStep.templateName,
                        templateParams,
                        mediaUrl || null,
                        client.languageCode || 'en'
                    );
                    sentSuccess = true;
                } catch (e) {
                    sentSuccess = false;
                    errorMessage = e.friendlyMessage || e.message || 'Failed to send WhatsApp template.';
                }
            } else {
                try {
                    if (mediaUrl) {
                        await WhatsApp.sendImage(client, seq.phone, mediaUrl, finalContent);
                    } else {
                        await WhatsApp.sendText(client, seq.phone, finalContent);
                    }
                    sentSuccess = true;
                } catch (e) {
                    sentSuccess = false;
                    errorMessage = e.friendlyMessage || e.message || 'Failed to send WhatsApp text.';
                }
            }
        }
    } else if (dueStep.type === 'email') {
        if (!seq.email && !lead?.email) {
            errorMessage = 'No email address for lead';
        } else {
            const success = await sendEmail(client, {
                to: seq.email || lead?.email,
                subject: hydratedSubject || 'A message from our store',
                html: hydratedContent,
            });
            sentSuccess = success;
            if (!success) errorMessage = 'Email sending failed';
        }
    }

    if (sentSuccess) {
        dueStep.status = 'sent';
        dueStep.sentAt = new Date();
        dueStep.errorLog = '';
    } else {
        dueStep.status = 'failed';
        dueStep.errorLog = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
    }

    return { sentSuccess };
}

let cronRunning = false;

const scheduleFollowUpSequenceCron = () => {
    cron.schedule('*/5 * * * *', async () => {
        if (cronRunning) {
            console.log('[SequenceCron] Previous run still active, skipping');
            return;
        }
        cronRunning = true;
        try {
            const now = new Date();
            const sequences = await FollowUpSequence.find({
                status: 'active',
                steps: { $elemMatch: { status: 'pending', sendAt: { $lte: now } } },
            }).limit(500);

            console.log(`[SequenceCron] Found ${sequences.length} sequences with due steps.`);

            if (sequences.length === 0) {
                cronRunning = false;
                return;
            }

            const uniqueClientIds = [...new Set(sequences.map((s) => s.clientId))];
            const uniqueLeadIds = [...new Set(sequences.map((s) => s.leadId).filter(Boolean))];

            const [clientDocs, leadDocs] = await Promise.all([
                Client.find({ clientId: { $in: uniqueClientIds } }).lean(),
                AdLead.find({ _id: { $in: uniqueLeadIds } }),
            ]);

            const clientMap = new Map(clientDocs.map((c) => [c.clientId, c]));
            const leadMap = new Map(leadDocs.map((l) => [String(l._id), l]));

            for (const seq of sequences) {
                const dueEntries = seq.steps
                    .map((s, idx) => ({ s, idx }))
                    .filter(({ s }) => s.status === 'pending' && s.sendAt <= now)
                    .sort((a, b) => a.idx - b.idx);

                if (dueEntries.length === 0) continue;

                const client = clientMap.get(seq.clientId);
                const lead = leadMap.get(String(seq.leadId));

                if (!client || !lead) {
                    for (const { s } of dueEntries) {
                        s.status = 'failed';
                        s.errorLog = !client ? 'Client not found' : 'Lead not found';
                    }
                    await seq.save();
                    continue;
                }

                if (lead?.optedOut || lead?.tags?.includes('opt_out') || lead?.tags?.includes('unsubscribed') || lead?.tags?.includes('blocked')) {
                    seq.status = 'cancelled';
                    seq.steps.forEach((s) => {
                        if (s.status === 'pending') {
                            s.status = 'skipped';
                            s.errorLog = 'Lead opted out';
                        }
                    });
                    await seq.save();
                    if (seq.leadId) {
                        await AdLead.findByIdAndUpdate(seq.leadId, { $set: { 'metaData.hasActiveSequence': false } }).catch(() => {});
                    }
                    console.log(`[SequenceCron] 🛑 Skipped sequence ${seq._id} for ${seq.phone} — lead opted out`);
                    continue;
                }

                if (seq.cancelOnReply) {
                    const Message = require('../models/Message');
                    const replyCount = await Message.countDocuments({
                        clientId: seq.clientId,
                        from: seq.phone,
                        direction: 'incoming',
                        timestamp: { $gte: seq.createdAt },
                    });
                    if (replyCount > 0) {
                        seq.status = 'cancelled';
                        seq.steps.forEach((s) => {
                            if (s.status === 'pending') {
                                s.status = 'skipped';
                                s.errorLog = 'Lead replied (Auto-cancelled)';
                            }
                        });
                        await seq.save();
                        console.log(`[SequenceCron] 🛑 Cancelled sequence ${seq._id} for ${seq.phone} — lead replied`);
                        continue;
                    }
                }

                const ctx = await buildVariableContext(client, seq.phone, null, lead);
                let brokeForRecovery = false;

                for (const { s: dueStep } of dueEntries) {
                    if (dueStep.condition && !evaluateStepCondition(dueStep.condition, lead)) {
                        dueStep.status = 'skipped';
                        dueStep.errorLog = 'Condition not met';
                        continue;
                    }

                    await dispatchSequenceStep({ dueStep, seq, client, lead, ctx });

                    if (seq.name?.toLowerCase().includes('recovery') && lead?.ordersCount > 0) {
                        seq.status = 'cancelled';
                        seq.steps.forEach((s) => {
                            if (s.status === 'pending') {
                                s.status = 'cancelled';
                                s.errorLog = 'Customer Purchased - Auto Cancelled';
                            }
                        });

                        if (lead.cartStatus !== 'purchased') {
                            lead.cartStatus = 'purchased';
                            lead.leadScore = (lead.leadScore || 0) + 50;
                            lead.tags = [...new Set([...(lead.tags || []), 'customer', 'converted'])];
                            await lead.save();
                        }

                        await seq.save();
                        console.log(`[SequenceCron] 🛑 Cancelled recovery seq ${seq._id} for ${seq.phone} - Customer purchased!`);
                        brokeForRecovery = true;
                        break;
                    }
                }

                if (!brokeForRecovery) {
                    const stillPending = seq.steps.some((s) => s.status === 'pending');
                    if (!stillPending && seq.status !== 'cancelled') {
                        const allTerminal = seq.steps.every((s) =>
                            ['sent', 'failed', 'skipped', 'cancelled'].includes(s.status)
                        );
                        if (allTerminal) {
                            if (seq.name?.toLowerCase().includes('recovery') && lead?.ordersCount === 0) {
                                lead.tags = [...new Set([...(lead.tags || []), 'recovery_failed'])];
                                await lead.save();
                            }
                            seq.status = 'completed';
                            if (seq.leadId) {
                                await AdLead.findByIdAndUpdate(seq.leadId, { $set: { 'metaData.hasActiveSequence': false } }).catch(() => {});
                            }
                        }
                    }
                    await seq.save();
                }

                await new Promise((r) => setTimeout(r, 200));
            }
        } catch (err) {
            console.error('❌ Error in follow-up sequence cron:', err);
        } finally {
            cronRunning = false;
        }
    });
};

module.exports = scheduleFollowUpSequenceCron;
