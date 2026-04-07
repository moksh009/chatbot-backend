const cron = require('node-cron');
const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
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
}

module.exports = scheduleLoyaltyUrgency;
