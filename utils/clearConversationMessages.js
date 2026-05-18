'use strict';

const { startOfDay, subDays } = require('date-fns');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');

const VALID_SCOPES = new Set(['all', 'today', '7d', '30d']);

function getCutoffDate(clearScope) {
  const now = new Date();
  if (clearScope === 'today') return startOfDay(now);
  if (clearScope === '7d') return subDays(now, 7);
  if (clearScope === '30d') return subDays(now, 30);
  return null;
}

/**
 * Delete messages for a conversation by scope; update lastMessage on conversation.
 */
async function clearConversationMessages({ conversationId, clientId, clearScope }) {
  if (!VALID_SCOPES.has(clearScope)) {
    throw new Error('Invalid clearScope');
  }

  const conversation = await Conversation.findOne({ _id: conversationId, clientId });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const messageFilter = { conversationId: conversation._id, clientId };

  if (clearScope === 'all') {
    await Message.deleteMany(messageFilter);
  } else {
    const cutoff = getCutoffDate(clearScope);
    if (cutoff) {
      await Message.deleteMany({
        ...messageFilter,
        timestamp: { $gte: cutoff },
      });
    }
  }

  const latest = await Message.findOne(messageFilter)
    .sort({ timestamp: -1 })
    .select('content timestamp type')
    .lean();

  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: {
      lastMessage: latest?.content || null,
      lastMessageAt: latest?.timestamp || null,
    },
  });

  return {
    deletedScope: clearScope,
    remainingCount: await Message.countDocuments(messageFilter),
    lastMessage: latest?.content || null,
    lastMessageAt: latest?.timestamp || null,
  };
}

module.exports = { clearConversationMessages, getCutoffDate, VALID_SCOPES };
