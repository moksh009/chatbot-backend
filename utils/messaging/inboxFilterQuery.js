'use strict';

/**
 * Merge an $or clause into a Mongo query that may already have $or / $and.
 */
function mergeOrIntoQuery(query, orClauses) {
  if (!orClauses?.length) return;
  if (query.$or) {
    query.$and = [{ $or: query.$or }, { $or: orClauses }];
    delete query.$or;
  } else if (query.$and) {
    query.$and.push({ $or: orClauses });
  } else {
    query.$or = orClauses;
  }
}

/** Conversations actively in the support queue (not quiet bot-handled threads). */
const OPEN_INBOX_OR = [
  { requiresAttention: true },
  { status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT', 'WAITING_FOR_INPUT', 'PAUSED', 'new'] } },
  { botStatus: 'paused' },
  { isBotPaused: true },
  { botPaused: true },
  { unreadCount: { $gt: 0 } },
  { assignedTo: { $exists: true, $ne: null } },
];

const NEEDS_HELP_OR = [
  { requiresAttention: true },
  { botStatus: 'paused' },
  { isBotPaused: true },
  { botPaused: true },
  { status: { $in: ['HUMAN_SUPPORT', 'HUMAN_TAKEOVER'] } },
];

/**
 * Apply Live Chat inbox filter to a Conversation query.
 * @param {object} query - Mutable Mongo query
 * @param {string} inboxFilter
 * @param {{ _id?: unknown }} user
 */
function applyInboxFilterToQuery(query, inboxFilter, user) {
  const filter = String(inboxFilter || '').trim();
  if (!filter || filter === 'all') return;

  if (filter === 'assigned_to_me' && user?._id) {
    query.assignedTo = user._id;
    return;
  }

  if (filter === 'needs_help') {
    mergeOrIntoQuery(query, NEEDS_HELP_OR);
    return;
  }

  if (filter === 'open') {
    query.status = { $nin: ['CLOSED', 'OPTED_OUT'] };
    mergeOrIntoQuery(query, OPEN_INBOX_OR);
    return;
  }

  if (filter.startsWith('agent_')) {
    const agentId = filter.slice('agent_'.length);
    if (agentId) query.assignedTo = agentId;
  }
}

function matchesOpenInboxConversation(conv) {
  if (!conv || typeof conv !== 'object') return false;
  if (conv.status === 'CLOSED' || conv.status === 'OPTED_OUT') return false;
  if (conv.requiresAttention) return true;
  if (['HUMAN_TAKEOVER', 'HUMAN_SUPPORT', 'WAITING_FOR_INPUT', 'PAUSED', 'new'].includes(conv.status)) {
    return true;
  }
  if (conv.botStatus === 'paused' || conv.isBotPaused || conv.botPaused) return true;
  if (Number(conv.unreadCount) > 0) return true;
  if (conv.assignedTo) return true;
  return false;
}

function matchesNeedsHelpConversation(conv) {
  if (!conv || typeof conv !== 'object') return false;
  if (conv.requiresAttention) return true;
  if (conv.botStatus === 'paused' || conv.isBotPaused || conv.botPaused) return true;
  if (conv.status === 'HUMAN_SUPPORT' || conv.status === 'HUMAN_TAKEOVER') return true;
  if (conv.lastDetectedIntent === 'support') return true;
  return false;
}

module.exports = {
  OPEN_INBOX_OR,
  NEEDS_HELP_OR,
  mergeOrIntoQuery,
  applyInboxFilterToQuery,
  matchesOpenInboxConversation,
  matchesNeedsHelpConversation,
};
