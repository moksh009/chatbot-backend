const cron = require('node-cron');
const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const log = require('../utils/logger')('LoyaltyCron');
const WhatsApp = require('../utils/whatsapp');

/**
 * Daily Cron Task (Runs at 10 AM)
 * Scans for loyalty rewards expiring in 3 days and sends reminders.
 */
function scheduleLoyaltyUrgency() {
    // 0 10 * * * -> 10:00 AM every day
    cron.schedule('0 10 * * *', async () => {
        log.info('🚀 Starting Loyalty Urgency Scan (Maintenance Check)...');

        try {
            const threeDaysFromNow = new Date();
            threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
            
            // Start of day and end of day for the 3-day target
            const startOfTarget = new Date(threeDaysFromNow.setHours(0,0,0,0));
            const endOfTarget = new Date(threeDaysFromNow.setHours(23,59,59,999));

            // 1. Find wallets with active rewards expiring in our targeted 3-day window
            const wallets = await CustomerWallet.find({
                'transactions': {
                    $elemMatch: {
                        type: 'redeem',
                        isNotified: false,
                        expiresAt: { $gte: startOfTarget, $lte: endOfTarget }
                    }
                }
            });

            log.info(`Found ${wallets.length} wallets with expiring rewards in 3-day window`);

            for (const wallet of wallets) {
                const client = await Client.findOne({ clientId: wallet.clientId });
                if (!client || !client.loyaltyConfig?.isEnabled) continue;

                // Process each expiring transaction in the wallet
                for (const tx of wallet.transactions) {
                    if (tx.type === 'redeem' && !tx.isNotified && tx.expiresAt >= startOfTarget && tx.expiresAt <= endOfTarget) {
                        
                        // Extract code from reason (e.g. "Redeemed for ₹50 discount code: LOYALTY-50-XYZ")
                        const codeMatch = tx.reason.match(/code: ([\w-]+)/);
                        const code = codeMatch ? codeMatch[1] : 'your reward code';

                        log.info(`Sending urgency reminder to ${wallet.phone} for code ${code}`);

                        // 2. Send WhatsApp Reminder
                        try {
                            const message = `👋 Hey! Don't forget your loyalty reward is vanishing soon! \n\nYour code *${code}* expires in just *3 days*. \n\nShop now to save before it's gone: \n🔗 https://${client.shopDomain}`;
                            await WhatsApp.sendText(client, wallet.phone, message);
                            
                            // 3. Mark as notified so we don't spam
                            tx.isNotified = true;
                        } catch (waErr) {
                            log.error(`Urgency WhatsApp failed for ${wallet.phone}:`, waErr.message);
                        }
                    }
                }
                await wallet.save();
            }

            log.info('✅ Loyalty Urgency Scan Completed');
        } catch (err) {
            log.error('Loyalty Cron Error:', err.message);
        }
    });

    // AdLead points expiring soon — driven by wizard onboardingData.features.loyalty
    cron.schedule('30 11 * * *', async () => {
        log.info('🎁 Loyalty expiry reminder scan (AdLead)...');
        try {
            const dayMs = 86400000;
            const clients = await Client.find({
                'onboardingData.features.loyalty.sendReminders': true,
            })
                .select('clientId businessName onboardingData')
                .lean();

            for (const c of clients) {
                const days = Number(c.onboardingData?.features?.loyalty?.reminderDaysBeforeExpiry) || 7;
                const windowEnd = new Date(Date.now() + days * dayMs);
                const client = await Client.findOne({ clientId: c.clientId });
                if (!client) continue;

                const leads = await AdLead.find({
                    clientId: c.clientId,
                    loyaltyPoints: { $gt: 0 },
                    loyaltyExpiresAt: { $gte: new Date(), $lte: windowEnd },
                })
                    .limit(300)
                    .lean();

                for (const L of leads) {
                    const last = L.loyaltyReminderSentAt ? new Date(L.loyaltyReminderSentAt) : null;
                    if (last && Date.now() - last.getTime() < dayMs * 5) continue;
                    try {
                        await WhatsApp.sendText(
                            client,
                            L.phoneNumber,
                            `👋 You have *${L.loyaltyPoints}* loyalty points at *${c.businessName || 'our store'}* — use them before they expire!`
                        );
                        await AdLead.updateOne(
                            { _id: L._id },
                            { $set: { loyaltyReminderSentAt: new Date() } }
                        );
                    } catch (e) {
                        log.warn(`Loyalty reminder failed ${L.phoneNumber}: ${e.message}`);
                    }
                }
            }
            log.info('✅ Loyalty expiry reminder scan done');
        } catch (err) {
            log.error('Loyalty expiry cron error:', err.message);
        }
    });
}

module.exports = scheduleLoyaltyUrgency;
