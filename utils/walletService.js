const CustomerWallet = require('../models/CustomerWallet');
const Client = require('../models/Client');
const log = require('./logger')('WalletService');

/**
 * Calculates and awards loyalty points based on order value and client-specific config.
 * Handles tier upgrades and wallet persistence.
 */
async function processOrderForLoyalty(clientId, phone, orderAmount, orderId) {
    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');
        if (!client || !client.loyaltyConfig?.isEnabled) return null;

        const config = client.loyaltyConfig;
        
        // 1. Calculate points: (Amount / Unit) * PointsPerUnit
        // e.g. (1000 / 100) * 10 = 100 points
        const pointsToAward = Math.floor((orderAmount / (config.currencyUnit || 100)) * (config.pointsPerUnit || 10));

        if (pointsToAward <= 0) return null;

        // 2. Update or create wallet
        const wallet = await CustomerWallet.findOneAndUpdate(
            { phone, clientId },
            { 
               $inc: { balance: pointsToAward, lifetimePoints: pointsToAward },
               $setOnInsert: { phone, clientId }
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

        // 4. Update Tiers (Simple implementation based on lifetime points)
        // Hardcoded tiers for now, can be moved to config later
        if (wallet.lifetimePoints > 5000) wallet.tier = 'Platinum';
        else if (wallet.lifetimePoints > 2000) wallet.tier = 'Gold';
        else if (wallet.lifetimePoints > 500) wallet.tier = 'Silver';
        else wallet.tier = 'Bronze';

        await wallet.save();
        log.info(`Awarded ${pointsToAward} points to ${phone} for client ${clientId}`);

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
async function redeemPoints(clientId, phone, pointsToRedeem, reason = 'Redemption') {
    const wallet = await CustomerWallet.findOne({ clientId, phone });
    if (!wallet || wallet.balance < pointsToRedeem) {
        throw new Error('Insufficient points balance');
    }

    wallet.balance -= pointsToRedeem;
    wallet.transactions.push({
        type: 'redeem',
        amount: -pointsToRedeem,
        reason,
        timestamp: new Date()
    });

    await wallet.save();
    return wallet.balance;
}

module.exports = {
    processOrderForLoyalty,
    getWallet,
    redeemPoints
};
