const { createLoyaltyDiscount } = require('../utils/shopifyGraphQL');
const { getWallet, redeemPoints } = require('../utils/walletService');
const Client = require('../models/Client');
const log = require('../utils/logger')('LoyaltyController');
const WhatsApp = require('../utils/whatsapp');

/**
 * Redeems points for a Shopify Discount Code and notifies customer.
 */
async function redeemLoyaltyPoints(req, res) {
    const { clientId, phone, amount } = req.body;

    if (!clientId || !phone || !amount) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        const client = await Client.findOne({ clientId });
        if (!client) throw new Error('Client configuration not found');

        const wallet = await getWallet(clientId, phone);
        if (!wallet) return res.status(404).json({ message: 'Customer wallet not found' });

        // Calculate points needed based on client config
        // e.g. 100 points = ₹10. So ₹50 reward = 500 points.
        const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100; 
        const pointsNeeded = amount * pointsPerCurrency;

        if (wallet.balance < pointsNeeded) {
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient points. You need ${pointsNeeded} points for a ₹${amount} reward.` 
            });
        }

        // 1. Generate Unique Code
        const uniqueSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        const discountCode = `LOYALTY-${amount}-${uniqueSuffix}`;

        // 2. Create in Shopify via GraphQL
        const shopifyResult = await createLoyaltyDiscount(clientId, {
            code: discountCode,
            amount: amount,
            daysValid: 90 // 3 months as requested
        });

        if (!shopifyResult.success) {
            throw new Error('Shopify discount creation failed');
        }

        // 3. Deduct points from wallet and record transaction
        const expiryDate = new Date(shopifyResult.expiresAt);
        await redeemPoints(clientId, phone, pointsNeeded, {
            reason: `Redeemed for ₹${amount} discount code: ${discountCode}`,
            expiresAt: expiryDate
        });

        // 4. Send WhatsApp Notification
        try {
            const message = `🎉 *Reward Unlocked!* \n\nHere is your unique discount code: *${discountCode}* \n\nUse it at checkout to get ₹${amount} OFF your next order! 🎁 \n\nExpires on: ${new Date(shopifyResult.endsAt).toLocaleDateString()}`;
            await WhatsApp.sendText(client, phone, message);
            log.info(`Sent loyalty reward WhatsApp to ${phone}`);
        } catch (waErr) {
            log.error(`WhatsApp notification failed for ${phone}:`, waErr.message);
        }

        // 5. Success response
        res.json({
            success: true,
            code: discountCode,
            expiresAt: shopifyResult.endsAt,
            newBalance: wallet.balance - pointsNeeded
        });

    } catch (err) {
        log.error('Redemption error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * Retrieves loyalty config and customer wallet status.
 */
async function getLoyaltyStatus(req, res) {
    const { clientId, phone } = req.query;
    if (!clientId || !phone) return res.status(400).json({ message: 'Missing params' });

    try {
        const wallet = await getWallet(clientId, phone);
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');

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
    redeemLoyaltyPoints,
    getLoyaltyStatus
};
