'use strict';

const Conversation = require('../../models/Conversation');

/** Max credible agent reply after escalation (30 min). */
const MAX_AGENT_RESPONSE_MS = 30 * 60 * 1000;

/**
 * Shared filter — matches Live Chat "Asking for help" / inbox needs_help.
 */
function buildNeedsHumanHelpQuery(clientId) {
  return {
    clientId,
    status: { $nin: ['CLOSED', 'OPTED_OUT'] },
    $or: [
      { status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] } },
      { requiresAttention: true },
      { botStatus: 'paused' },
      { lastDetectedIntent: 'support' },
    ],
  };
}

/**
 * True when a thread still needs agent action (re-opened after resolve counts as open).
 */
function isActionablyOpen(conversation) {
  if (!conversation) return false;
  const st = String(conversation.status || '');
  if (st === 'CLOSED' || st === 'OPTED_OUT') return false;

  const needsHuman =
    st === 'HUMAN_TAKEOVER' ||
    st === 'HUMAN_SUPPORT' ||
    conversation.requiresAttention === true ||
    conversation.botStatus === 'paused' ||
    conversation.lastDetectedIntent === 'support';

  if (!needsHuman) return false;
  if (!conversation.resolvedAt) return true;

  const lastMs = new Date(conversation.lastMessageAt || 0).getTime();
  const resMs = new Date(conversation.resolvedAt).getTime();
  if (!Number.isFinite(lastMs) || !Number.isFinite(resMs)) return true;
  return lastMs > resMs + 60_000;
}

function dedupeConversationsByPhone(conversations) {
  const map = new Map();
  for (const c of conversations || []) {
    const key = String(c.phone || c._id);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, c);
      continue;
    }
    const prevT = new Date(prev.lastMessageAt || 0).getTime();
    const curT = new Date(c.lastMessageAt || 0).getTime();
    if (curT >= prevT) map.set(key, c);
  }
  return [...map.values()];
}

/**
 * Open threads that need human action — one row per customer phone (latest thread).
 */
async function fetchOpenSupportConversations(clientId, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 40, 1), 100);
  const rows = await Conversation.find(buildNeedsHumanHelpQuery(clientId))
    .sort({ requiresAttention: -1, lastMessageAt: -1 })
    .limit(limit * 4)
    .select(
      '_id phone customerName lastMessage lastMessageAt status requiresAttention attentionReason assignedTo resolvedAt escalationRequestedAt'
    )
    .populate('assignedTo', 'name email')
    .lean();

  return dedupeConversationsByPhone(rows)
    .filter(isActionablyOpen)
    .sort((a, b) => {
      if (a.requiresAttention && !b.requiresAttention) return -1;
      if (!a.requiresAttention && b.requiresAttention) return 1;
      return new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
    })
    .slice(0, limit)
    .map((c) => ({
      _id: c._id,
      phone: c.phone,
      customerName: c.customerName || c.phone || 'Customer',
      lastMessage: c.lastMessage || '',
      lastMessageAt: c.lastMessageAt,
      status: c.status,
      requiresAttention: !!c.requiresAttention,
      attentionReason: c.attentionReason || '',
      escalationRequestedAt: c.escalationRequestedAt || null,
      assignedTo: c.assignedTo
        ? { _id: c.assignedTo._id, name: c.assignedTo.name }
        : null,
      reopened: Boolean(
        c.resolvedAt &&
          c.lastMessageAt &&
          new Date(c.lastMessageAt).getTime() > new Date(c.resolvedAt).getTime()
      ),
    }));
}

/**
 * When a thread re-escalates, clear resolvedAt so metrics treat it as open again.
 */
function buildReopenAttentionUpdate(setFields = {}) {
  const fields = { ...setFields };
  if (fields.requiresAttention === undefined) fields.requiresAttention = true;
  return {
    $set: fields,
    $unset: { resolvedAt: '' },
  };
}

/**
 * Support pipeline aligned with Live Chat + dashboard queue.
 */
async function getSupportPipelineCounts(clientId, since) {
  const windowQuery = {
    clientId,
    updatedAt: { $gte: since },
  };

  const [resolvedInWindow, openList, awaitingInput, humanStatusInWindow] = await Promise.all([
    Conversation.countDocuments({
      clientId,
      resolvedAt: { $gte: since, $ne: null },
    }),
    fetchOpenSupportConversations(clientId, { limit: 100 }),
    Conversation.countDocuments({
      ...windowQuery,
      status: 'WAITING_FOR_INPUT',
      $or: [{ resolvedAt: null }, { resolvedAt: { $exists: false } }],
    }),
    Conversation.countDocuments({
      ...windowQuery,
      status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT'] },
      $or: [{ resolvedAt: null }, { resolvedAt: { $exists: false } }],
    }),
  ]);

  const openCount = openList.length;
  const totalSupportTouches = await Conversation.countDocuments({
    clientId,
    updatedAt: { $gte: since },
    $or: [
      { resolvedAt: { $gte: since, $ne: null } },
      { escalationRequestedAt: { $gte: since, $ne: null } },
      { assignedTo: { $exists: true, $ne: null } },
      { requiresAttention: true },
      { status: { $in: ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT', 'WAITING_FOR_INPUT'] } },
    ],
  });

  const pipelineTotal = Math.max(totalSupportTouches, resolvedInWindow + openCount);

  return {
    total: pipelineTotal,
    resolved: resolvedInWindow,
    open: openCount,
    awaitingInput,
    humanTakeover: humanStatusInWindow,
    openConversations: openList,
  };
}

function capResponseTimeMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, MAX_AGENT_RESPONSE_MS);
}

function medianMs(values) {
  const nums = (values || []).filter((v) => v != null && Number.isFinite(v) && v >= 0);
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  MAX_AGENT_RESPONSE_MS,
  buildNeedsHumanHelpQuery,
  buildReopenAttentionUpdate,
  isActionablyOpen,
  dedupeConversationsByPhone,
  fetchOpenSupportConversations,
  getSupportPipelineCounts,
  capResponseTimeMs,
  medianMs,
};
