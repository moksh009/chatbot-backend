const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const log = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');

const autoResumeBotCron = () => {
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        try {
            const oneHourAgo = new Date();
            oneHourAgo.setHours(oneHourAgo.getHours() - 1);

            // Find conversations currently assigned to a human
            const conversations = await Conversation.find({
                status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] }
            });

            if (conversations.length === 0) return;

            let resumedCount = 0;

            for (const conv of conversations) {
                // Find the last message sent by an agent in this conversation
                const lastAgentMsg = await Message.findOne({
                    conversationId: conv._id,
                    sender: 'agent'
                }).sort({ createdAt: -1 });

                const lastActivityTime = lastAgentMsg ? lastAgentMsg.createdAt : conv.assignedAt;

                // If last activity is older than 1 hour (or no activity and assigned > 1hr ago)
                if (lastActivityTime && lastActivityTime < oneHourAgo) {
                    conv.status = 'BOT_ACTIVE';
                    conv.botPaused = false;
                    conv.isBotPaused = false;
                    conv.botStatus = 'active';
                    conv.assignedTo = null;
                    conv.assignedAt = null;
                    conv.assignedBy = null;
                    conv.requiresAttention = false;
                    
                    await conv.save();
                    resumedCount++;

                    // Log activity
                    await logActivity(conv.clientId, {
                        type: 'CONVERSATION',
                        status: 'info',
                        title: 'Bot Auto-Resumed',
                        message: `Bot auto-resumed for ${conv.phone} due to 1 hour of agent inactivity.`,
                        icon: 'Bot',
                        url: `/conversations/${conv._id}`,
                        metadata: { conversationId: conv._id, phone: conv.phone }
                    });
                }
            }

            if (resumedCount > 0) {
                log.info(`[AutoResumeBotCron] Auto-resumed ${resumedCount} conversations due to agent inactivity.`);
            }

        } catch (error) {
            log.error('[AutoResumeBotCron] Error running cron:', { error: error.message });
        }
    });
};

module.exports = autoResumeBotCron;
