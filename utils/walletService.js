const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const { normalizePhone } = require('./helpers');
const log = require('./logger')('WalletService');

function resolveTierFromThresholds(lifetimePoints, loyaltyConfig = {}) {
    const score = Number(lifetimePoints || 0);
    const t = loyaltyConfig?.tierThresholds || {};
    const bronze = Number(t.bronze ?? 0);
    const silver = Number(t.silver ?? 500);
    const gold = Number(t.gold ?? 2000);
    const platinum = Number(t.platinum ?? 5000);

    if (score >= platinum) return 'Platinum';
    if (score >= gold) return 'Gold';
    if (score >= silver) return 'Silver';
    if (score >= bronze) return 'Bronze';
    return 'Bronze';
}

async function appendLedgerTx({ clientId, phone, orderId = '', type, amount, reason, balanceAfter }) {
    try {
        await LoyaltyTransaction.create({
            clientId,
            phone: normalizePhone(phone),
            orderId: orderId ? String(orderId) : undefined,
            type,
            amount: Number(amount || 0),
            reason: String(reason || '').slice(0, 300),
            balanceAfter: Number(balanceAfter || 0),
            timestamp: new Date()
        });
    } catch (err) {
        log.error('Failed to append loyalty ledger tx', { error: err.message, clientId, phone, type, orderId });
    }
}

/**
 * Calculates and awards loyalty points based on order value and client-specific config.
 * Handles tier upgrades and wallet persistence.
 */
async function processOrderForLoyalty(clientId, phone, orderAmount, orderId) {
    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig wizardFeatures onboardingData');
        if (!client) return null;

        const { isLoyaltyEnabled } = require('./featureFlags');
        if (!isLoyaltyEnabled(client)) {
            log.debug(`[Loyalty] Skipping points — loyalty disabled for ${clientId}`);
            return { skipped: true, reason: 'loyalty_disabled' };
        }

        // Use config defaults if loyalty hasn't been explicitly configured yet
        const config = client.loyaltyConfig || {
            isEnabled: true, currencyUnit: 100, pointsPerUnit: 10, pointsPerCurrency: 100, expiryDays: 90
        };

        // ENENTERPRISE HARDENING: Robust phone normalization to match AdLead records
        const { normalizePhone } = require('./helpers');
        const cleanPhone = normalizePhone(phone);

        
        // IDEMPOTENCY GUARD: Don't award points twice for the same order
        const existingWallet = await CustomerWallet.findOne({ 
            clientId, phone: cleanPhone, 
            'transactions.orderId': orderId,
            'transactions.type': 'earn'
        });
        if (existingWallet) {
            log.info(`Skipping duplicate points for order ${orderId} on ${phone}`);
            return { skipped: true };
        }

        // 1. Calculate points: (Amount / Unit) * PointsPerUnit
        // e.g. (1000 / 100) * 10 = 100 points
        const currencyUnit = Math.max(config.currencyUnit || 100, 1); // Prevent division by zero
        const pointsPerUnit = config.pointsPerUnit || 10;
        const pointsToAward = Math.floor((orderAmount / currencyUnit) * pointsPerUnit);

        if (pointsToAward <= 0) {
            log.info(`Zero points calculated for order ${orderId} (Amount: ${orderAmount})`);
            return null;
        }

        // 2. Update or create wallet
        const wallet = await CustomerWallet.findOneAndUpdate(
            { phone: cleanPhone, clientId },
            { 
               $inc: { balance: pointsToAward, lifetimePoints: pointsToAward },
               $setOnInsert: { phone: cleanPhone, clientId }
            },
            { upsert: true, new: true }
        );

        // 3. Record transaction
        wallet.transactions.push({
            type: 'earn',
            amount: pointsToAward,
            reason: `Order #${orderId} reward`,
            orderId,
            timestamp: new Date()
        });

        // 4. Update tiers (single logic path using client thresholds)
        wallet.tier = resolveTierFromThresholds(wallet.lifetimePoints, config);

        await wallet.save();
        await appendLedgerTx({
            clientId,
            phone: cleanPhone,
            orderId,
            type: 'earn',
            amount: pointsToAward,
            reason: `Order #${orderId} reward`,
            balanceAfter: wallet.balance
        });
        
        // Layer 2: Sync to AdLead for O(1) leaderboard querying
        await AdLead.findOneAndUpdate(
            { phoneNumber: cleanPhone, clientId },
            { $set: { loyaltyPoints: wallet.balance, loyaltyTier: wallet.tier } },
            { upsert: false } // Only update if lead exists
        );

        log.info(`Awarded ${pointsToAward} points to ${cleanPhone} for client ${clientId}`);

        return { pointsAwarded: pointsToAward, newBalance: wallet.balance, tier: wallet.tier };
    } catch (err) {
        log.error('Loyalty processing failed', { error: err.message, clientId, phone });
        return null;
    }
}

/**
 * Retrieves customer wallet balance and tier.
 */
async function getWallet(clientId, phone) {
    const clean = normalizePhone(phone);
    return await CustomerWallet.findOne({ clientId, phone: clean }).lean();
}

/**
 * Redeems points for a discount/reward.
 */
async function redeemPoints(clientId, phone, pointsToRedeem, metadata = 'Redemption') {
    const clean = normalizePhone(phone);
    const wallet = await CustomerWallet.findOne({ clientId, phone: clean });
    if (!wallet || wallet.balance < pointsToRedeem) {
        throw new Error('Insufficient points balance');
    }

    const reason = typeof metadata === 'string' ? metadata : metadata.reason;
    const expiresAt = typeof metadata === 'object' ? metadata.expiresAt : null;

    wallet.balance -= pointsToRedeem;
    wallet.transactions.push({
        type: 'redeem',
        amount: -pointsToRedeem,
        reason,
        expiresAt,
        timestamp: new Date()
    });

    await wallet.save();
    await appendLedgerTx({
        clientId,
        phone: clean,
        orderId: typeof metadata === 'object' ? metadata.orderId || '' : '',
        type: 'redeem',
        amount: -pointsToRedeem,
        reason,
        balanceAfter: wallet.balance
    });
    
    // Layer 2: Sync to AdLead for O(1) leaderboard querying
    await AdLead.findOneAndUpdate(
        { phoneNumber: clean, clientId },
        { $set: { loyaltyPoints: wallet.balance, loyaltyTier: wallet.tier } },
        { upsert: false } // Only update if lead exists
    );

    return wallet.balance;
}

/**
 * Reverses loyalty points previously awarded for an order (Refund/Cancellation logic).
 * Deducts points from current balance and marks the specific transaction as reversed.
 */
async function reverseOrderPoints(clientId, orderId) {
    try {
        // Find the wallet that contains a transaction for this orderId
        const wallet = await CustomerWallet.findOne({ 
            clientId, 
            'transactions.orderId': orderId,
            'transactions.type': 'earn'
        });

        if (!wallet) {
            log.warn(`No loyalty transaction found to reverse for order ${orderId}`, { clientId });
            return null;
        }

        // Find the specific 'earn' transaction for this order
        const earnTx = wallet.transactions.find(tx => tx.orderId === orderId && tx.type === 'earn' && !tx.isReversed);
        if (!earnTx) {
            log.warn(`Order ${orderId} already reversed or no active 'earn' tx found`, { clientId });
            return null;
        }

        const pointsToDeduct = earnTx.amount;

        // Deduct from balance (careful not to go below zero unless that's intended)
        wallet.balance = Math.max(0, wallet.balance - pointsToDeduct);
        
        // Mark transaction as reversed to prevent double reversal
        earnTx.isReversed = true;
        earnTx.reason = `(REVERSED) ${earnTx.reason}`;

        // Add a reversal audit transaction
        wallet.transactions.push({
            type: 'adjust',
            amount: -pointsToDeduct,
            reason: `Refund/Cancellation reversal for #${orderId}`,
            orderId,
            timestamp: new Date()
        });

        await wallet.save();
        await appendLedgerTx({
            clientId,
            phone: wallet.phone,
            orderId,
            type: 'adjust',
            amount: -pointsToDeduct,
            reason: `Refund/Cancellation reversal for #${orderId}`,
            balanceAfter: wallet.balance
        });
        
        // Layer 2: Sync to AdLead for O(1) leaderboard querying
        await AdLead.findOneAndUpdate(
            { phoneNumber: wallet.phone, clientId },
            { $set: { loyaltyPoints: wallet.balance, loyaltyTier: wallet.tier } },
            { upsert: false } // Only update if lead exists
        );

        log.info(`Reversed ${pointsToDeduct} points for order ${orderId} from ${wallet.phone}`);

        return { pointsDeducted: pointsToDeduct, newBalance: wallet.balance };
    } catch (err) {
        log.error('Point reversal failed', { error: err.message, clientId, orderId });
        return null;
    }
}

/**
 * Current points balance for a phone (normalized). Used by flows + dualBrainEngine branching.
 */
async function getBalance(clientId, phone) {
    const clean = normalizePhone(phone);
    const w = await CustomerWallet.findOne({ clientId, phone: clean }).lean();
    return w?.balance ?? 0;
}

/**
 * Manual / flow reward — adds points and syncs AdLead when present.
 */
async function addPoints(clientId, phone, points, reason = 'Flow reward') {
    const clean = normalizePhone(phone);
    const n = Math.max(0, Math.floor(Number(points) || 0));
    if (n <= 0) return 0;

    const wallet = await CustomerWallet.findOneAndUpdate(
        { phone: clean, clientId },
        { $inc: { balance: n, lifetimePoints: n }, $setOnInsert: { phone: clean, clientId } },
        { upsert: true, new: true }
    );

    wallet.transactions.push({
        type: 'earn',
        amount: n,
        reason: String(reason).slice(0, 200),
        timestamp: new Date()
    });

    const client = await Client.findOne({ clientId }).select('loyaltyConfig').lean();
    wallet.tier = resolveTierFromThresholds(wallet.lifetimePoints, client?.loyaltyConfig || {});

    await wallet.save();
    await appendLedgerTx({
        clientId,
        phone: clean,
        type: 'earn',
        amount: n,
        reason: String(reason).slice(0, 200),
        balanceAfter: wallet.balance
    });

    await AdLead.findOneAndUpdate(
        { phoneNumber: clean, clientId },
        { $set: { loyaltyPoints: wallet.balance, loyaltyTier: wallet.tier } },
        { upsert: false }
    ).catch(() => {});

    return wallet.balance;
}

/**
 * Deduct points (alias for redeemPoints — used by nodeActions REDEEM path).
 */
async function deductPoints(clientId, phone, points, reason = 'Redemption') {
    return redeemPoints(clientId, normalizePhone(phone), points, reason);
}

module.exports = {
    processOrderForLoyalty,
    getWallet,
    getBalance,
    addPoints,
    deductPoints,
    redeemPoints,
    reverseOrderPoints
};
