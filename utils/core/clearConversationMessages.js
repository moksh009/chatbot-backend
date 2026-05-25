'use strict';

const mongoose = require('mongoose');
const Message = require('../../models/Message');
const Conversation = require('../../models/Conversation');
const { startOfDayIST } = require('./queryHelpers');

const VALID_SCOPES = new Set(['all', 'today', '7d', '30d']);

function getCutoffDate(clearScope) {
  const now = new Date();
  if (clearScope === 'today') return startOfDayIST();
  if (clearScope === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (clearScope === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

/** Match messages whether conversationId was stored as ObjectId or string. */
function conversationMessageFilter(conversation) {
  const id = String(conversation._id);
  const or = [{ conversationId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) {
    or.push({ conversationId: new mongoose.Types.ObjectId(id) });
  }
  return { $or: or };
}

function formatLastMessage(content) {
  if (content == null || content === '') return '';
  if (typeof content === 'string') return content.substring(0, 500);
  try {
    return String(content).substring(0, 500);
  } catch {
    return '';
  }
}

/**
 * Delete messages for a conversation by scope; update lastMessage on conversation.
 */
async function clearConversationMessages({ conversationId, clientId, clearScope, allowAnyClient }) {
  if (!VALID_SCOPES.has(clearScope)) {
    const err = new Error('Invalid clearScope');
    err.statusCode = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(conversationId))) {
    const err = new Error('Invalid conversation id');
    err.statusCode = 400;
    throw err;
  }

  const convQuery = { _id: conversationId };
  if (!allowAnyClient && clientId) {
    convQuery.clientId = clientId;
  } else if (clientId) {
    convQuery.clientId = clientId;
  }

  let conversation = await Conversation.findOne(convQuery);
  if (!conversation && allowAnyClient) {
    conversation = await Conversation.findById(conversationId);
  }
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const messageFilter = conversationMessageFilter(conversation);

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

  const lastMessage = latest ? formatLastMessage(latest.content) : '';
  const lastMessageAt = latest?.timestamp || null;

  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: {
      lastMessage,
      lastMessageAt,
    },
  });

  return {
    deletedScope: clearScope,
    remainingCount: await Message.countDocuments(messageFilter),
    lastMessage,
    lastMessageAt,
  };
}

module.exports = { clearConversationMessages, getCutoffDate, VALID_SCOPES };
