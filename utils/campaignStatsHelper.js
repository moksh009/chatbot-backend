const Message = require('../models/Message');
const Campaign = require('../models/Campaign');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const log = require('./logger')('CampaignStats');

/**
 * Updates campaign performance metrics based on WhatsApp status updates (delivered, read, failed).
 */
async function updateCampaignStats(parsedStatus, client) {
    const { messageId, status, timestamp } = parsedStatus;
    
    try {
        // 1. Find the message and its associated campaign
        const message = await Message.findOneAndUpdate(
            { messageId: messageId },
            { status: status },
            { new: true }
        );

        if (!message || !message.campaignId) {
            // Not a campaign message, just a regular chat message
            return;
        }

        const campaignId = message.campaignId;
        const updateField = {};
        
        // Map status to campaign stats fields
        if (status === 'delivered') {
            updateField['stats.delivered'] = 1;
            updateField['deliveredCount'] = 1;
        } else if (status === 'read') {
            updateField['stats.read'] = 1;
            updateField['readCount'] = 1;
        } else if (status === 'failed') {
            // Optional: track failures
        }

        if (Object.keys(updateField).length > 0) {
            await Campaign.findByIdAndUpdate(campaignId, { $inc: updateField });
            log.info(`Updated Campaign ${campaignId} stats: ${status} for msg ${messageId}`);
        }

    } catch (err) {
        log.error(`Error updating campaign stats for ${messageId}:`, err.message);
    }
}

/**
 * Basic Revenue Attribution logic.
 * Checks if a lead recently received a campaign message before placing an order.
 */
async function attributeRevenueToCampaign(order, lead) {
    try {
        if (!lead || !order) return;

        // Find the most recent campaign message sent to this lead (within the last 24 hours)
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        const recentCampaignMsg = await Message.findOne({
            to: lead.phoneNumber,
            clientId: lead.clientId,
            campaignId: { $exists: true },
            timestamp: { $gte: dayAgo },
            direction: 'outgoing'
        }).sort({ timestamp: -1 });

        if (recentCampaignMsg && recentCampaignMsg.campaignId) {
            const campaignId = recentCampaignMsg.campaignId;
            
            await Campaign.findByIdAndUpdate(campaignId, {
                $inc: {
                    attributedRevenue: order.amount || order.totalPrice || 0,
                    attributedOrders: 1,
                    'stats.converted': 1
                }
            });
            
            log.info(`Attributed ₹${order.amount} to Campaign ${campaignId} for Order ${order.orderId}`);
            return campaignId;
        }
    } catch (err) {
        log.error('Revenue Attribution Error:', err.message);
    }
    return null;
}

module.exports = {
    updateCampaignStats,
    attributeRevenueToCampaign
};
