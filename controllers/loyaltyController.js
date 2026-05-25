const { createLoyaltyDiscount } = require('../utils/shopify/shopifyGraphQL');
const { getWallet, redeemPoints, processOrderForLoyalty } = require('../utils/commerce/walletService');
const { awardLoyaltyPoints, sendReminder } = require('../utils/commerce/loyaltyEngine');
const CustomerWallet = require('../models/CustomerWallet');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const Client = require('../models/Client');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const log = require('../utils/core/logger')('LoyaltyController');
const WhatsApp = require('../utils/meta/whatsapp');

/**
 * GET /api/loyalty/stats
 * Real aggregate stats for the Loyalty Hub dashboard.
 */
// ✅ Phase R2: Fixed clientId ObjectId mismatch in loyalty stats — 2026-04-10
const { resolveClient, resolveClientOrNull, startOfDayIST, tenantClientId } = require('../utils/core/queryHelpers');

async function getLoyaltyStats(req, res) {
    try {
        const { client } = await resolveClientOrNull(req);
        if (!client) {
            return res.json({
                success: true,
                totalPoints: 0,
                activeMembers: 0,
                totalMembers: 0,
                issuedToday: 0,
                totalRedeemed: 0,
                redemptionCount: 0,
                redemptionVelocity: 0,
                recentTransactions: [],
                topCustomers: []
            });
        }

        const today = startOfDayIST();
        const cid = client.clientId;

        // Run all aggregations in parallel for speed
        const [
            walletStats,
            issuedTodayResult,
            redemptionStats,
            recentTransactions,
            topWallets
        ] = await Promise.all([
            // Total points in circulation, active members
            CustomerWallet.aggregate([
                { $match: { clientId: cid } },
                { $group: {
                    _id: null,
                    totalPoints: { $sum: '$balance' },
                    activeMembers: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } },
                    totalMembers: { $sum: 1 }
                }}
            ]).catch(e => { log.error("Wallet Agg Failed:", e.message); return []; }),

            // Points issued today
            LoyaltyTransaction.aggregate([
                { $match: { clientId: cid, type: 'earn', timestamp: { $gte: today } }},
                { $group: { _id: null, issuedToday: { $sum: '$amount' } }}
            ]).catch(e => { log.error("IssuedToday Agg Failed:", e.message); return []; }),

            // Redemption stats
            LoyaltyTransaction.aggregate([
                { $match: { clientId: cid, type: 'redeem' }},
                { $group: {
                    _id: null,
                    totalRedeemed: { $sum: { $abs: '$amount' } },
                    redemptionCount: { $sum: 1 },
                    uniqueRedeemers: { $addToSet: '$phone' }
                }}
            ]).catch(e => { log.error("Redemption Agg Failed:", e.message); return []; }),

            // Recent Transactions
            LoyaltyTransaction.find({ clientId: cid })
                .sort({ timestamp: -1 })
                .limit(10)
                .select('phone type amount reason timestamp -_id')
                .lean()
                .catch(() => []),

            // Top 5 wallets (authoritative source for loyalty balance + lifetime points)
            CustomerWallet.find({ clientId: cid, balance: { $gt: 0 } })
                .sort({ balance: -1 })
                .limit(5)
                .select('phone balance lifetimePoints tier')
                .lean()
                .catch(() => [])
        ]);

        const ws = walletStats[0] || { totalPoints: 0, activeMembers: 0, totalMembers: 0 };
        const rd = redemptionStats[0] || { totalRedeemed: 0, redemptionCount: 0, uniqueRedeemers: [] };
        const issuedToday = issuedTodayResult[0]?.issuedToday || 0;

        const mappedTopCustomers = (topWallets || []).map(c => ({
            phone: c.phone,
            balance: Number(c.balance || 0),
            lifetimePoints: Number(c.lifetimePoints || 0),
            tier: c.tier || 'Bronze'
        }));

        const redemptionVelocity = ws.totalMembers > 0
            ? ((rd.uniqueRedeemers.length / ws.totalMembers) * 100).toFixed(1)
            : 0;

        res.json({
            success: true,
            totalPoints: ws.totalPoints || 0,
            activeMembers: ws.activeMembers || 0,
            totalMembers: ws.totalMembers || 0,
            issuedToday,
            totalRedeemed: rd.totalRedeemed || 0,
            redemptionCount: rd.redemptionCount || 0,
            redemptionVelocity: parseFloat(redemptionVelocity),
            recentTransactions: recentTransactions || [],
            topCustomers: mappedTopCustomers
        });

    } catch (err) {
        log.error('Stats error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to aggregate loyalty stats' });
    }
}

/**
 * GET /api/loyalty/wallet
 * Per-customer wallet with balance, tier, and transaction history.
 */
async function getCustomerWallet(req, res) {
    const { phone } = req.query;
    const resolvedClientId = tenantClientId(req);
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
 * GET /api/loyalty/transactions
 * Global transactions list
 */
async function getLoyaltyTransactions(req, res) {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ message: 'Unauthorized' });

    try {
        let transactions = await LoyaltyTransaction.find({ clientId })
            .sort({ timestamp: -1 })
            .limit(50)
            .lean();

        // Fallback for legacy wallets where transactions were stored only in CustomerWallet.transactions.
        if (!transactions.length) {
            const wallets = await CustomerWallet.find(
                { clientId, transactions: { $exists: true, $ne: [] } },
                { phone: 1, transactions: 1 }
            ).lean();

            transactions = (wallets || [])
                .flatMap((w) => (w.transactions || []).map((t) => ({
                    _id: `${w.phone}_${new Date(t.timestamp || Date.now()).getTime()}_${t.type || 'tx'}`,
                    clientId,
                    phone: w.phone,
                    type: t.type || 'adjust',
                    amount: Number(t.amount || 0),
                    reason: t.reason || '',
                    timestamp: t.timestamp || new Date()
                })))
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, 50);
        }
        
        res.json({ transactions });
    } catch (err) {
        log.error('Transactions fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/backfill
 * One-time admin job: Award points for all historical orders.
 * Idempotent — safe to run multiple times.
 */
async function backfillOrderPoints(req, res) {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ message: 'Unauthorized' });

    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');
        if (!client) return res.status(404).json({ message: 'Client not found.' });

        // Add to Task Queue
        const TaskQueueService = require('../services/TaskQueueService');
        await TaskQueueService.addTask('BACKFILL_LOYALTY', { clientId });

        // Respond immediately
        res.status(202).json({
            success: true,
            message: 'Backfill started in background'
        });
    } catch (err) {
        log.error('Backfill trigger error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/send-reminder
 * Sends a WhatsApp template message to a customer reminding them of their points.
 * Requires a Meta-approved template named 'loyalty_points_reminder'.
 */
async function sendLoyaltyReminderTemplate(req, res) {
    const { phone } = req.body;
    const resolvedClientId = tenantClientId(req);
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

        try {
            const { sendForAutomation } = require('../services/templateSender');
            const sendResult = await sendForAutomation({
                clientId: resolvedClientId,
                phone,
                slotId: 'wizard_loyalty',
                metaName: 'loyalty_points_reminder',
                contextType: 'loyalty',
                trigger: 'loyalty_expiring',
                contextData: {
                    extra: {
                        loyalty_points: String(balance),
                        loyalty_cash_value: `₹${cashValue}`,
                        loyalty_tier: tier,
                        loyalty_expiry_date: expiryDate.toISOString().slice(0, 10),
                    },
                },
            });
            if (!sendResult?.whatsapp?.sent) {
                throw new Error(sendResult?.whatsapp?.reason || 'template_send_failed');
            }
        } catch (templateErr) {
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
    const { phone, amount } = req.body;
    const resolvedClientId = tenantClientId(req);

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
 * POST /api/loyalty/adjust
 * Manual admin adjustment of wallet points.
 */
async function adjustWalletBalance(req, res) {
    const { phone, amount, reason } = req.body;
    const resolvedClientId = tenantClientId(req);

    if (!resolvedClientId || !phone || amount === undefined) {
        return res.status(400).json({ message: 'Missing required parameters' });
    }

    try {
        const normalizedPhone = require('../utils/core/helpers').normalizePhone(phone);
        let wallet = await CustomerWallet.findOne({ clientId: resolvedClientId, phone: normalizedPhone });
        
        if (!wallet) {
            // Create wallet if it doesn't exist
            wallet = await CustomerWallet.create({ 
                clientId: resolvedClientId, 
                phone: normalizedPhone, 
                balance: 0, 
                lifetimePoints: 0 
            });
        }

        const adjustmentAmount = parseInt(amount);
        wallet.balance += adjustmentAmount;
        if (adjustmentAmount > 0) {
            wallet.lifetimePoints += adjustmentAmount;
        }

        wallet.transactions.push({
            type: 'adjust', // mapped from 'adjustment' or 'adjust' in schema
            amount: adjustmentAmount,
            reason: reason || 'Admin manual adjustment',
            timestamp: new Date()
        });

        await wallet.save();
        await LoyaltyTransaction.create({
            clientId: resolvedClientId,
            phone: normalizedPhone,
            type: 'adjust',
            amount: adjustmentAmount,
            reason: reason || 'Admin manual adjustment',
            balanceAfter: wallet.balance,
            timestamp: new Date()
        });

        log.info(`Manual adjustment of ${adjustmentAmount} points for ${phone} (${resolvedClientId})`);
        
        res.json({ 
            success: true, 
            newBalance: wallet.balance, 
            message: `Successfully ${adjustmentAmount >= 0 ? 'added' : 'deducted'} ${Math.abs(adjustmentAmount)} points.` 
        });

    } catch (err) {
        log.error('Adjustment error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/loyalty/generate-reward
 * AI-driven or manual button to generate a specific reward for a customer.
 */
async function generateAIRewardCode(req, res) {
    const { phone, rewardType, customValue } = req.body;
    const resolvedClientId = tenantClientId(req);

    try {
        const client = await Client.findOne({ clientId: resolvedClientId });
        if (!client) return res.status(404).json({ message: 'Client not found' });

        const { isLoyaltyEnabled } = require('../utils/core/featureFlags');
        if (!isLoyaltyEnabled(client)) {
            return res.status(403).json({
                success: false,
                message: 'Loyalty program is turned off for this workspace. Enable it under Audience → Loyalty.',
            });
        }

        const wallet = await getWallet(resolvedClientId, phone);
        
        let amount = customValue || 50; // Default or AI suggested
        
        // If type is 'points_exchange', verify balance
        if (rewardType === 'points_exchange') {
            const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100;
            const pointsNeeded = amount * pointsPerCurrency;
            if (!wallet || wallet.balance < pointsNeeded) {
                return res.status(400).json({ message: 'Insufficient points for this reward' });
            }
        }

        // Generate Code logic (reuse redeem logic but decoupled)
        const uniqueSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        const discountCode = `REWARD-${amount}-${uniqueSuffix}`;

        const shopifyResult = await createLoyaltyDiscount(resolvedClientId, {
            code: discountCode,
            amount: amount,
            daysValid: client.loyaltyConfig?.expiryDays || 30
        });

        if (!shopifyResult.success) throw new Error(shopifyResult.error);

        // Record as transaction if it was an exchange
        if (rewardType === 'points_exchange') {
            const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100;
            await redeemPoints(resolvedClientId, phone, amount * pointsPerCurrency, {
                reason: `Exchanged points for reward: ${discountCode}`
            });
        }

        // Notify via WhatsApp
        const msg = `🎁 *Special Reward for You!*\n\nWe've generated a special discount code just for you: *${discountCode}*\n\nEnjoy ₹${amount} OFF on your next order! 🛍️`;
        await WhatsApp.sendText(client, phone, msg);

        res.json({ success: true, code: discountCode, amount });

    } catch (err) {
        log.error('Reward generation error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/loyalty/status (Legacy - kept for bot compatibility)
 */
async function getLoyaltyStatus(req, res) {
    const { phone } = req.query;
    const resolvedClientId = tenantClientId(req);
    if (!resolvedClientId || !phone) return res.status(400).json({ message: 'Missing params' });

    try {
        const wallet = await getWallet(resolvedClientId, phone);
        const client = await Client.findOne({ clientId: resolvedClientId }).select('loyaltyConfig');

        res.json({
            isEnabled: client?.loyaltyConfig?.isEnabled ?? client?.loyaltyConfig?.enabled ?? false,
            wallet: wallet || { balance: 0, tier: 'Bronze' },
            config: client?.loyaltyConfig || {}
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * Unified customer context for Audience modals (orders, loyalty, warranty).
 */
async function getAudienceContext(req, res) {
    try {
        const { client } = await resolveClient(req);
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });

        const { normalizePhone } = require('../utils/core/helpers');
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ success: false, message: 'Invalid phone' });

        const suffix = cleanPhone.replace(/\D/g, '').slice(-10);
        const phoneRegex = suffix ? new RegExp(`${suffix}$`) : null;
        const orderQuery = phoneRegex
            ? {
                clientId: client.clientId,
                $or: [{ customerPhone: phoneRegex }, { phone: phoneRegex }],
            }
            : { clientId: client.clientId, phone: cleanPhone };

        const orders = await Order.find(orderQuery)
            .sort({ createdAt: -1 })
            .limit(8)
            .select(
                'orderId orderNumber customerName name customerPhone phone items totalPrice status createdAt shopifyOrderId'
            )
            .lean();

        const lead = phoneRegex
            ? await AdLead.findOne({
                clientId: client.clientId,
                $or: [{ phoneNumber: phoneRegex }, { phoneNumber: cleanPhone }],
            })
                .select('name firstName')
                .lean()
            : null;

        const customerName =
            lead?.firstName ||
            lead?.name ||
            orders[0]?.customerName ||
            orders[0]?.name ||
            'Customer';

        const mappedOrders = orders.map((o) => ({
            _id: o._id,
            orderId: o.orderId,
            orderNumber: o.orderNumber || o.orderId,
            productName: o.items?.[0]?.name || 'Order',
            productImage: o.items?.[0]?.image || null,
            totalPrice: o.totalPrice,
            status: o.status,
            createdAt: o.createdAt,
        }));

        let loyalty = null;
        try {
            const wallet = await getWallet(client.clientId, cleanPhone);
            if (wallet) {
                const ppc = client.loyaltyConfig?.pointsPerCurrency || 100;
                loyalty = {
                    balance: wallet.balance || 0,
                    tier: wallet.tier || 'Bronze',
                    cashValue: Math.floor((wallet.balance || 0) / ppc),
                };
            }
        } catch {
            loyalty = null;
        }

        let warranty = null;
        try {
            const WarrantyRecord = require('../models/WarrantyRecord');
            const latestOrder = mappedOrders[0];
            if (latestOrder?.orderId) {
                const rec = await WarrantyRecord.findOne({
                    clientId: client.clientId,
                    shopifyOrderId: String(latestOrder.orderId),
                })
                    .sort({ createdAt: -1 })
                    .lean();
                if (rec) {
                    warranty = {
                        productName: rec.productName,
                        orderId: rec.shopifyOrderId,
                        expiryDate: rec.expiryDate,
                        status: rec.status,
                    };
                }
            }
        } catch {
            warranty = null;
        }

        res.json({
            success: true,
            phone: cleanPhone,
            customerName,
            orders: mappedOrders,
            loyalty,
            warranty,
        });
    } catch (err) {
        log.error('getAudienceContext:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = {
    getLoyaltyStats,
    getCustomerWallet,
    backfillOrderPoints,
    sendLoyaltyReminderTemplate,
    redeemLoyaltyPoints,
    adjustWalletBalance,
    generateAIRewardCode,
    getLoyaltyStatus,
    getAudienceContext,
    getLoyaltyTransactions
};
