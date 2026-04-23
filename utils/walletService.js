const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const log = require('./logger')('WalletService');

/**
 * Calculates and awards loyalty points based on order value and client-specific config.
 * Handles tier upgrades and wallet persistence.
 */
async function processOrderForLoyalty(clientId, phone, orderAmount, orderId) {
    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');
        if (!client) return null;

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

        // 4. Update Tiers
        if (wallet.lifetimePoints > 5000) wallet.tier = 'Platinum';
        else if (wallet.lifetimePoints > 2000) wallet.tier = 'Gold';
        else if (wallet.lifetimePoints > 500) wallet.tier = 'Silver';
        else wallet.tier = 'Bronze';

        await wallet.save();
        
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
    return await CustomerWallet.findOne({ clientId, phone }).lean();
}

/**
 * Redeems points for a discount/reward.
 */
async function redeemPoints(clientId, phone, pointsToRedeem, metadata = 'Redemption') {
    const wallet = await CustomerWallet.findOne({ clientId, phone });
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
    
    // Layer 2: Sync to AdLead for O(1) leaderboard querying
    await AdLead.findOneAndUpdate(
        { phoneNumber: phone, clientId },
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

module.exports = {
    processOrderForLoyalty,
    getWallet,
    redeemPoints,
    reverseOrderPoints
};
