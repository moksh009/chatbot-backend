const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const log = require('../utils/core/logger');
const { logActivity } = require('../utils/core/activityLogger');

const IDLE_HOURS = Number(process.env.AUTO_RESUME_IDLE_HOURS || 3);
const BATCH_SIZE = Number(process.env.AUTO_RESUME_BATCH_SIZE || 100);

function idleCutoff() {
  const d = new Date();
  d.setHours(d.getHours() - IDLE_HOURS);
  return d;
}

async function notifyCustomerBotResumed(clientId, phone) {
  try {
    const Client = require('../models/Client');
    const WhatsApp = require('../utils/meta/whatsapp');
    const client = await Client.findOne({ clientId }).lean();
    if (!client) return;
    const brand = client.businessName || client.name || 'us';
    await WhatsApp.sendText(
      client,
      phone,
      `Hi! Our team stepped away — the assistant is back online to help you with ${brand}. Reply anytime.`
    );
  } catch (err) {
    log.warn('[AutoResumeBotCron] Customer notify failed', { phone, error: err.message });
  }
}

async function runAutoResumeBotTick() {
  try {
    const cutoff = idleCutoff();
    let resumedCount = 0;
    let lastId = null;

    for (;;) {
      const query = {
        status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] },
      };
      if (lastId) query._id = { $gt: lastId };

      const conversations = await Conversation.find(query)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .lean();

      if (!conversations.length) break;

      for (const conv of conversations) {
        lastId = conv._id;

        const lastAgentMsg = await Message.findOne({
          conversationId: conv._id,
          direction: 'outgoing',
          agentId: { $ne: null },
        })
          .sort({ timestamp: -1 })
          .select('timestamp createdAt')
          .lean();

        const lastActivityTime =
          lastAgentMsg?.timestamp ||
          lastAgentMsg?.createdAt ||
          conv.assignedAt ||
          conv.lastMessageAt;

        if (!lastActivityTime || new Date(lastActivityTime) >= cutoff) continue;

        await Conversation.findByIdAndUpdate(conv._id, {
          status: 'BOT_ACTIVE',
          botPaused: false,
          isBotPaused: false,
          botStatus: 'active',
          assignedTo: null,
          assignedAt: null,
          assignedBy: null,
          requiresAttention: false,
        });

        resumedCount++;
        await notifyCustomerBotResumed(conv.clientId, conv.phone);

        await logActivity(conv.clientId, {
          type: 'CONVERSATION',
          status: 'info',
          title: 'Bot auto-resumed',
          message: `Bot auto-resumed for ${conv.phone} after ${IDLE_HOURS}h of agent inactivity.`,
          icon: 'Bot',
          url: `/conversations/${conv._id}`,
          metadata: { conversationId: conv._id, phone: conv.phone },
        });
      }

      if (conversations.length < BATCH_SIZE) break;
    }

    if (resumedCount > 0) {
      log.info(
        `[AutoResumeBotCron] Auto-resumed ${resumedCount} conversations (${IDLE_HOURS}h idle).`
      );
    }
  } catch (error) {
    log.error('[AutoResumeBotCron] Error running cron:', { error: error.message });
  }
}

const autoResumeBotCron = () => {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  cron.schedule('*/15 * * * *', runAutoResumeBotTick);
};

autoResumeBotCron.runTick = runAutoResumeBotTick;
module.exports = autoResumeBotCron;
