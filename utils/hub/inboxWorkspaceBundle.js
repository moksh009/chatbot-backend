'use strict';

const IGConversation = require('../../models/IGConversation');
const { getConversationsList } = require('../../routes/conversations');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { getCachedClient, CONNECTION_STATUS_SELECT } = require('../core/clientCache');

async function buildInboxFiltersList(clientId) {
  const User = require('../../models/User');
  const teamMembers = await User.find({
    clientId,
    role: { $in: ['agent', 'admin', 'SUPER_ADMIN'] },
    isActive: true,
  })
    .select('_id name email')
    .lean();

  const filters = [
    { id: 'all', label: 'All', type: 'static' },
    { id: 'assigned_to_me', label: 'Assigned to me', type: 'static' },
    { id: 'open', label: 'Open', type: 'static', description: 'Assigned, unread, paused bot, or needs attention' },
    {
      id: 'needs_help',
      label: 'Asking for help',
      type: 'static',
      description:
        'Paused bot, support intent, needs attention, or live handoff (human queue)',
    },
  ];

  for (const member of teamMembers) {
    filters.push({
      id: `agent_${member._id}`,
      label: `Assigned to ${member.name}`,
      type: 'agent',
      agentId: member._id.toString(),
    });
  }

  return filters;
}

async function buildInstagramConversationRows(clientId, { limit = 50 } = {}) {
  const rawIG = await IGConversation.find({ clientId })
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(limit, 100))
    .select('igsid igUsername igProfilePic lastMessageText lastMessageAt isRead channel')
    .lean();

  return rawIG.map((c) => ({
    _id: c._id.toString(),
    customerName: c.igUsername || 'IG User',
    phone: c.igsid,
    lastMessage: c.lastMessageText || '',
    lastMessageAt: c.lastMessageAt,
    channel: 'instagram',
    status: 'BOT_ACTIVE',
    unreadCount: c.isRead ? 0 : 1,
    _isIG: true,
  }));
}

function extractWaConversationRows(waPayload) {
  if (!waPayload) return [];
  if (Array.isArray(waPayload)) return waPayload;
  if (Array.isArray(waPayload.data)) return waPayload.data;
  if (Array.isArray(waPayload.conversations)) return waPayload.conversations;
  return [];
}

function mergeLiveChatConversationRows(waRows, igRows, channelFilter = 'all') {
  const fetchWa = channelFilter !== 'instagram';
  const fetchIg = channelFilter !== 'whatsapp';

  const waList = fetchWa ? waRows : [];
  const igList = fetchIg ? igRows : [];

  const uniqueList = waList.filter(
    (v, i, a) => a.findIndex((t) => (t._id || t.id) === (v._id || v.id)) === i
  );

  return [...uniqueList, ...igList].sort(
    (a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0)
  );
}

/**
 * GET /api/inbox/workspace — Live Chat first-paint bundle.
 */
async function buildInboxWorkspace(user, clientId, options = {}) {
  const {
    search = '',
    inboxFilter = 'all',
    days = null,
    channelFilter = 'all',
    isImported = false,
    importBatchId = null,
    limit = 50,
  } = options;

  const client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);
  const flags = buildConnectionStatusPayload(client);
  const whatsappConnected = !!flags.whatsapp_connected;
  const instagramConnected = !!flags.instagram_connected;

  if (!whatsappConnected && !instagramConnected) {
    return {
      conversations: [],
      filters: [],
      channels: {
        whatsapp: { connected: false, count: 0 },
        instagram: { connected: false, count: 0 },
      },
      pagination: { hasMore: false, nextCursor: null },
      meta: { partial: false, disconnected: true },
    };
  }

  const fetchWa = channelFilter !== 'instagram' && whatsappConnected;
  const fetchIg = channelFilter !== 'whatsapp' && instagramConnected;
  const trimmedSearch = String(search || '').trim();
  const inboxFilterParam =
    inboxFilter && inboxFilter !== 'all' && !String(inboxFilter).startsWith('imported')
      ? inboxFilter
      : '';

  const waQuery = {
    clientId,
    limit,
    search: trimmedSearch.length >= 2 ? trimmedSearch : undefined,
    inboxFilter: inboxFilterParam || undefined,
    days: days || undefined,
    isImported: isImported ? 'true' : undefined,
    importBatchId: importBatchId || undefined,
  };

  const tasks = {
    filters: buildInboxFiltersList(clientId),
    wa: fetchWa ? getConversationsList(user, waQuery) : Promise.resolve(null),
    ig: fetchIg ? buildInstagramConversationRows(clientId, { limit }) : Promise.resolve([]),
  };

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const failedSections = [];
  const result = {};

  keys.forEach((key, i) => {
    if (settled[i].status === 'fulfilled') {
      result[key] = settled[i].value;
    } else {
      result[key] = key === 'filters' ? [] : key === 'ig' ? [] : null;
      failedSections.push(key);
      console.warn(
        `[inbox/workspace] ${key}:`,
        settled[i].reason?.message || settled[i].reason
      );
    }
  });

  const waRows = extractWaConversationRows(result.wa);
  const conversations = mergeLiveChatConversationRows(waRows, result.ig || [], channelFilter);
  const waCount = conversations.filter((c) => c.channel !== 'instagram' && !c._isIG).length;
  const igCount = conversations.filter((c) => c.channel === 'instagram' || c._isIG).length;

  return {
    conversations,
    filters: result.filters || [],
    channels: {
      whatsapp: { connected: whatsappConnected, count: waCount },
      instagram: { connected: instagramConnected, count: igCount },
    },
    pagination: {
      hasMore: Boolean(result.wa?.pagination?.hasMore),
      nextCursor: null,
    },
    meta: {
      partial: failedSections.length > 0,
      failedSections,
      disconnected: false,
    },
  };
}

module.exports = {
  buildInboxWorkspace,
  buildInboxFiltersList,
  mergeLiveChatConversationRows,
};
