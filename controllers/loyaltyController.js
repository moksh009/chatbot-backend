const { createLoyaltyDiscount } = require('../utils/shopifyGraphQL');
const { getWallet, redeemPoints, processOrderForLoyalty } = require('../utils/walletService');
const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
const Order = require('../models/Order');
const log = require('../utils/logger')('LoyaltyController');
const WhatsApp = require('../utils/whatsapp');

/**
 * GET /api/loyalty/stats
 * Real aggregate stats for the Loyalty Hub dashboard.
 */
async function getLoyaltyStats(req, res) {
    const clientId = req.query.clientId || req.user?.clientId;
    if (!clientId) return res.status(400).json({ message: 'Missing clientId' });

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Run all aggregations in parallel for speed
        const [
            walletStats,
            issuedTodayResult,
            redemptionStats,
            topCustomers
        ] = await Promise.all([
            // Total points in circulation, active members
            CustomerWallet.aggregate([
                { $match: { clientId } },
                { $group: {
                    _id: null,
                    totalPoints: { $sum: '$balance' },
                    activeMembers: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } },
                    totalMembers: { $sum: 1 }
                }}
            ]),
            // Points issued today
            CustomerWallet.aggregate([
                { $match: { clientId } },
                { $unwind: '$transactions' },
                { $match: { 
                    'transactions.type': 'earn',
                    'transactions.timestamp': { $gte: today }
                }},
                { $group: { _id: null, issuedToday: { $sum: '$transactions.amount' } }}
            ]),
            // Redemption stats
            CustomerWallet.aggregate([
                { $match: { clientId } },
                { $unwind: '$transactions' },
                { $match: { 'transactions.type': 'redeem' } },
                { $group: { 
                    _id: null, 
                    totalRedeemed: { $sum: { $abs: '$transactions.amount' } },
                    redemptionCount: { $sum: 1 },
                    uniqueRedeemers: { $addToSet: '$phone' }
                }}
            ]),
            // Top 5 customers by balance
            CustomerWallet.find({ clientId, balance: { $gt: 0 } })
                .sort({ balance: -1 })
                .limit(5)
                .select('phone balance tier lifetimePoints')
                .lean()
        ]);

        const ws = walletStats[0] || { totalPoints: 0, activeMembers: 0, totalMembers: 0 };
        const rd = redemptionStats[0] || { totalRedeemed: 0, redemptionCount: 0, uniqueRedeemers: [] };
        const issuedToday = issuedTodayResult[0]?.issuedToday || 0;
        
        // Redemption velocity = % of members who have ever redeemed
        const redemptionVelocity = ws.totalMembers > 0 
            ? ((rd.uniqueRedeemers.length / ws.totalMembers) * 100).toFixed(1)
            : 0;

        res.json({
            totalPoints: ws.totalPoints,
            activeMembers: ws.activeMembers,
            totalMembers: ws.totalMembers,
            issuedToday,
            totalRedeemed: rd.totalRedeemed,
            redemptionCount: rd.redemptionCount,
            redemptionVelocity: parseFloat(redemptionVelocity),
            topCustomers
        });
    } catch (err) {
        log.error('Stats error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/loyalty/wallet
 * Per-customer wallet with balance, tier, and transaction history.
 */
async function getCustomerWallet(req, res) {
    const { clientId, phone } = req.query;
    const resolvedClientId = clientId || req.user?.clientId;
    if (!resolvedClientId || !phone) return res.status(400).json({ message: 'Missing clientId or phone' });

    try {
        const wallet = await getWallet(resolvedClientId, phone);
        const client = await Client.findOne({ clientId: resolvedClientId }).select('loyaltyConfig');
        
        res.json({
            wallet: wallet || { balance: 0, tier: 'Bronze', transactions: [], lifetimePoints: 0 },
            config: client?.loyaltyConfig || {}
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/backfill
 * One-time admin job: Award points for all historical orders.
 * Idempotent — safe to run multiple times.
 */
async function backfillOrderPoints(req, res) {
    const clientId = req.body.clientId || req.user?.clientId;
    if (!clientId) return res.status(400).json({ message: 'Missing clientId' });

    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');
        if (!client) return res.status(404).json({ message: 'Client not found.' });

        // Auto-apply defaults if loyaltyConfig not configured yet — never block an admin backfill
        if (!client.loyaltyConfig) {
            client.loyaltyConfig = { isEnabled: true, currencyUnit: 100, pointsPerUnit: 10, pointsPerCurrency: 100, expiryDays: 90 };
        }
        if (!client.loyaltyConfig.isEnabled) {
            // Force-enable for this backfill run so processOrderForLoyalty doesn't skip
            client.loyaltyConfig.isEnabled = true;
        }

        // Fetch up to 1000 paid orders for this client
        const orders = await Order.find({ 
            clientId, 
            status: { $in: ['Paid', 'paid', 'PAID', 'fulfilled', 'Fulfilled'] } 
        }).limit(1000).lean();

        if (orders.length === 0) {
            return res.json({ success: true, processed: 0, awarded: 0, skipped: 0, message: 'No paid orders found.' });
        }

        let awarded = 0;
        let skipped = 0;
        let failed = 0;

        for (const order of orders) {
            const phone = order.phone || order.customerPhone;
            const amount = parseFloat(order.totalPrice || order.amount || 0);
            const orderId = order.orderId || order._id?.toString();

            if (!phone || !amount || !orderId) { failed++; continue; }

            const result = await processOrderForLoyalty(clientId, phone, amount, orderId);
            if (!result) { failed++; continue; }
            if (result.skipped) { skipped++; continue; }
            awarded++;
        }

        log.info(`Backfill complete for ${clientId}: awarded=${awarded}, skipped=${skipped}, failed=${failed}`);
        res.json({ 
            success: true, 
            total: orders.length, 
            awarded, 
            skipped, 
            failed,
            message: `Awarded points to ${awarded} orders. ${skipped} already processed. ${failed} failed.`
        });
    } catch (err) {
        log.error('Backfill error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/send-reminder
 * Sends a WhatsApp template message to a customer reminding them of their points.
 * Requires a Meta-approved template named 'loyalty_points_reminder'.
 */
async function sendLoyaltyReminderTemplate(req, res) {
    const { clientId, phone } = req.body;
    const resolvedClientId = clientId || req.user?.clientId;
    if (!resolvedClientId || !phone) return res.status(400).json({ message: 'Missing clientId or phone' });

    try {
        const client = await Client.findOne({ clientId: resolvedClientId });
        if (!client) return res.status(404).json({ message: 'Client not found' });

        const wallet = await getWallet(resolvedClientId, phone);
        const balance = wallet?.balance || 0;
        const tier = wallet?.tier || 'Bronze';
        const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100;
        const cashValue = Math.floor(balance / pointsPerCurrency);

        if (balance === 0) {
            return res.status(400).json({ message: 'Customer has 0 points. No reminder needed.' });
        }

        // Find nearest expiring transaction (3 months from oldest active earn)
        const oldestEarn = wallet?.transactions
            ?.filter(t => t.type === 'earn' && !t.isReversed)
            ?.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];
        
        const expiryDate = oldestEarn
            ? new Date(new Date(oldestEarn.timestamp).getTime() + 90 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

        const daysLeft = Math.ceil((expiryDate - Date.now()) / (1000 * 60 * 60 * 24));

        // Try to send via template first, fallback to direct text
        try {
            await WhatsApp.sendTemplate(client, phone, 'loyalty_points_reminder', [
                { type: 'text', text: String(balance) },
                { type: 'text', text: `₹${cashValue}` },
                { type: 'text', text: String(Math.max(daysLeft, 1)) },
                { type: 'text', text: tier }
            ]);
        } catch (templateErr) {
            // Fallback if template not yet approved: send as text
            const msg = `🎁 *Loyalty Reminder* \n\nHi! You have *${balance} Points* worth *₹${cashValue}* in your rewards wallet. \n\n⏰ Your points expire in *${Math.max(daysLeft, 1)} days*. Don't let them go to waste!\n\nReply *REDEEM* to get your discount code now. 🛍️`;
            await WhatsApp.sendText(client, phone, msg);
        }

        log.info(`Loyalty reminder sent to ${phone}`);
        res.json({ success: true, balance, cashValue, daysLeft });
    } catch (err) {
        log.error('Reminder error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/redeem
 * Redeems points for a Shopify Discount Code and notifies customer.
 */
async function redeemLoyaltyPoints(req, res) {
    const { clientId, phone, amount } = req.body;
    const resolvedClientId = clientId || req.user?.clientId;

    if (!resolvedClientId || !phone || !amount) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        const client = await Client.findOne({ clientId: resolvedClientId });
        if (!client) throw new Error('Client configuration not found');

        const wallet = await getWallet(resolvedClientId, phone);
        if (!wallet) return res.status(404).json({ message: 'Customer wallet not found' });

        // Calculate points needed based on client config
        const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100;
        const pointsNeeded = amount * pointsPerCurrency;

        if (wallet.balance < pointsNeeded) {
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient points. You need ${pointsNeeded} points for a ₹${amount} reward. You have ${wallet.balance} points.`
            });
        }

        // 1. Generate Unique Code
        const uniqueSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        const discountCode = `LOYALTY-${amount}-${uniqueSuffix}`;

        // 2. Create in Shopify via GraphQL (exact value matching)
        const shopifyResult = await createLoyaltyDiscount(resolvedClientId, {
            code: discountCode,
            amount: amount, // Exact ₹ value matching points
            daysValid: client.loyaltyConfig?.expiryDays || 90
        });

        if (!shopifyResult.success) {
            throw new Error('Shopify discount creation failed: ' + (shopifyResult.error || 'Unknown error'));
        }

        // 3. Deduct points from wallet and record transaction
        const expiryDate = new Date(shopifyResult.expiresAt || shopifyResult.endsAt);
        await redeemPoints(resolvedClientId, phone, pointsNeeded, {
            reason: `Redeemed for ₹${amount} discount code: ${discountCode}`,
            expiresAt: expiryDate
        });

        // 4. Send WhatsApp Notification
        try {
            const expiryStr = expiryDate instanceof Date && !isNaN(expiryDate) 
                ? expiryDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
                : '90 days from today';
            const message = `🎉 *Reward Unlocked!*\n\nHere is your unique discount code:\n*${discountCode}*\n\nUse it at checkout to get ₹${amount} OFF!\n\n⏰ Expires: ${expiryStr}\n\n_Valid on all products. Apply at checkout._`;
            await WhatsApp.sendText(client, phone, message);
        } catch (waErr) {
            log.error(`WhatsApp notification failed for ${phone}:`, waErr.message);
        }

        // 5. Success response
        res.json({
            success: true,
            code: discountCode,
            amount,
            expiresAt: shopifyResult.expiresAt || shopifyResult.endsAt,
            newBalance: wallet.balance - pointsNeeded
        });

    } catch (err) {
        log.error('Redemption error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * GET /api/loyalty/status (Legacy - kept for bot compatibility)
 */
async function getLoyaltyStatus(req, res) {
    const { clientId, phone } = req.query;
    const resolvedClientId = clientId || req.user?.clientId;
    if (!resolvedClientId || !phone) return res.status(400).json({ message: 'Missing params' });

    try {
        const wallet = await getWallet(resolvedClientId, phone);
        const client = await Client.findOne({ clientId: resolvedClientId }).select('loyaltyConfig');

        res.json({
            isEnabled: client?.loyaltyConfig?.isEnabled || false,
            wallet: wallet || { balance: 0, tier: 'Bronze' },
            config: client?.loyaltyConfig || {}
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    getLoyaltyStats,
    getCustomerWallet,
    backfillOrderPoints,
    sendLoyaltyReminderTemplate,
    redeemLoyaltyPoints,
    getLoyaltyStatus
};
