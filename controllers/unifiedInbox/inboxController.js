"use strict";

const Conversation = require('../../models/Conversation');
const IGConversation = require('../../models/IGConversation');
const Client = require('../../models/Client');
const { sendInstagramDMv2 } = require('../../utils/igGraphApi');
const log = require('../../utils/logger')('UnifiedInbox');

/**
 * GET /api/inbox/conversations
 * Merge-sort conversations from WhatsApp + Instagram into a single unified list.
 * 
 * Query params:
 *  - clientId (required)
 *  - channel: 'all' | 'whatsapp' | 'instagram' (default: 'all')
 *  - search: text search on name/phone/username
 *  - limit: number (default: 50)
 *  - skip: number (default: 0)
 */
async function listConversations(req, res) {
  try {
    const clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const channel = req.query.channel || 'all';
    const search = req.query.search || '';
    const filter = req.query.filter || 'all';
    const currentUserId = req.user?.id || req.user?._id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = parseInt(req.query.skip) || 0;

    let whatsappConvos = [];
    let igConvos = [];

    // Fetch WhatsApp conversations
    if (channel === 'all' || channel === 'whatsapp') {
      const waQuery = { clientId };
      if (search) {
        waQuery.$or = [
          { customerName: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ];
      }

      if (filter === 'assigned_to_me') {
        waQuery.assignedTo = currentUserId;
      } else if (filter === 'open') {
        waQuery.status = { $nin: ['CLOSED', 'OPTED_OUT'] };
      } else if (filter === 'needs_help') {
        waQuery.$or = [
          { botStatus: 'paused' },
          { lastDetectedIntent: 'support' },
          { requiresAttention: true }
        ];
      } else if (filter.startsWith('agent_')) {
        const agentId = filter.replace('agent_', '');
        waQuery.assignedTo = agentId;
      }

      const rawWA = await Conversation.find(waQuery)
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .skip(channel === 'whatsapp' ? skip : 0)
        .select('phone customerName lastMessage lastMessageAt unreadCount status channel sentiment assignedTo botStatus')
        .lean();

      whatsappConvos = rawWA.map(c => ({
        _id: c._id.toString(),
        participantId: c.phone,
        participantName: c.customerName || c.phone,
        participantAvatar: null,
        channel: c.channel || 'whatsapp',
        lastMessageText: c.lastMessage || '',
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount || 0,
        status: c.status,
        botStatus: c.botStatus || 'active',
        sentiment: c.sentiment
      }));
    }

    // Fetch Instagram conversations
    if (channel === 'all' || channel === 'instagram') {
      const igQuery = { clientId };
      if (search) {
        igQuery.$or = [
          { igUsername: { $regex: search, $options: 'i' } },
          { igsid: { $regex: search, $options: 'i' } }
        ];
      }

      const rawIG = await IGConversation.find(igQuery)
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .skip(channel === 'instagram' ? skip : 0)
        .select('igsid igUsername igProfilePic lastMessageText lastMessageAt isRead channel')
        .lean();

      igConvos = rawIG.map(c => ({
        _id: c._id.toString(),
        participantId: c.igsid,
        participantName: c.igUsername || `IG User ${c.igsid.slice(-6)}`,
        participantAvatar: c.igProfilePic || null,
        channel: 'instagram',
        lastMessageText: c.lastMessageText || '',
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.isRead ? 0 : 1,
        status: null,
        sentiment: null
      }));
    }

    // Merge and sort chronologically (most recent first)
    let merged = [...whatsappConvos, ...igConvos];
    merged.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

    // Apply pagination to merged result
    if (channel === 'all') {
      merged = merged.slice(skip, skip + limit);
    }

    return res.json({
      success: true,
      conversations: merged,
      total: merged.length,
      hasMore: merged.length === limit
    });

  } catch (err) {
    log.error('[listConversations] Error:', err.message, { stack: err.stack });
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
}

/**
 * GET /api/inbox/filters
 * Returns available static and dynamic (per-agent) filters.
 */
async function getFilters(req, res) {
  try {
    const clientId = req.query.clientId || req.user?.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const User = require('../../models/User');
    const teamMembers = await User.find({
      clientId,
      role: { $in: ['agent', 'admin', 'SUPER_ADMIN'] },
      isActive: true
    }).select('_id name email').lean();

    const filters = [
      { id: 'all', label: 'All', type: 'static' },
      { id: 'assigned_to_me', label: 'Assigned to me', type: 'static' },
      { id: 'open', label: 'Open', type: 'static' },
      { id: 'needs_help', label: 'Asking for help', type: 'static', description: 'Chats where the bot is paused or intent is support' }
    ];

    for (const member of teamMembers) {
      filters.push({
        id: `agent_${member._id}`,
        label: `Assigned to ${member.name}`,
        type: 'agent',
        agentId: member._id.toString()
      });
    }

    res.json({ filters });
  } catch (err) {
    log.error('[getFilters] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch filters.' });
  }
}

/**
 * GET /api/inbox/conversations/:id/messages
 * Channel-aware message fetch. Determines which model to query based on channel param.
 * 
 * Query params:
 *  - channel: 'whatsapp' | 'instagram' (required)
 */
async function getMessages(req, res) {
  try {
    const { id } = req.params;
    const channel = req.query.channel;

    if (!channel) return res.status(400).json({ error: 'channel query param is required' });

    if (channel === 'instagram') {
      const convo = await IGConversation.findById(id)
        .select('messages igsid igUsername igProfilePic')
        .lean();

      if (!convo) return res.status(404).json({ error: 'Conversation not found' });

      const messages = (convo.messages || []).map(m => ({
        _id: m._id.toString(),
        conversationId: id,
        sender: m.role === 'user' ? 'customer' : 'assistant',
        direction: m.role === 'user' ? 'incoming' : 'outgoing',
        content: m.content,
        type: m.messageType || 'text',
        mediaUrl: m.attachmentUrl || null,
        timestamp: m.timestamp,
        status: m.status || 'delivered',
        channel: 'instagram'
      }));

      return res.json({ success: true, messages });
    }

    // WhatsApp — use existing Message model
    const Message = require('../../models/Message');
    const messages = await Message.find({ conversationId: id })
      .sort({ timestamp: 1 })
      .lean();

    const normalized = messages.map(m => ({
      ...m,
      _id: m._id.toString(),
      channel: 'whatsapp'
    }));

    return res.json({ success: true, messages: normalized });

  } catch (err) {
    log.error('[getMessages] Error:', err.message, { stack: err.stack });
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
}

/**
 * PATCH /api/inbox/conversations/:id/read
 * Mark conversation as read on the correct model.
 * 
 * Body: { channel: 'whatsapp' | 'instagram' }
 */
async function markRead(req, res) {
  try {
    const { id } = req.params;
    const channel = req.body.channel;

    if (channel === 'instagram') {
      await IGConversation.findByIdAndUpdate(id, { $set: { isRead: true } });
    } else {
      await Conversation.findByIdAndUpdate(id, { $set: { unreadCount: 0 } });
    }

    return res.json({ success: true });
  } catch (err) {
    log.error('[markRead] Error:', err.message);
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
}

/**
 * POST /api/inbox/conversations/:id/send
 * Send an agent message via WhatsApp or Instagram DM API.
 * 
 * Body: { channel, content, clientId }
 */
async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const { channel, content, clientId } = req.body;

    if (!content || !clientId || !channel) {
      return res.status(400).json({ error: 'content, clientId, and channel are required' });
    }

    if (channel === 'instagram') {
      // Get the conversation to find the recipient IGSID
      const convo = await IGConversation.findById(id).lean();
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });

      // Get the client's IG access token
      const client = await Client.findOne({ clientId }).lean();
      if (!client) return res.status(404).json({ error: 'Client not found' });

      const accessToken = client.instagramAccessToken || client.social?.instagram?.accessToken;
      if (!accessToken) return res.status(422).json({ error: 'Instagram is not connected. Please reconnect in Settings.' });

      // Send via Graph API
      await sendInstagramDMv2(convo.igsid, { text: content }, accessToken, { clientId });

      // Save agent message to conversation
      const newMessage = {
        role: 'assistant',
        content,
        messageType: 'text',
        timestamp: new Date(),
        status: 'sent'
      };

      const updated = await IGConversation.findByIdAndUpdate(id, {
        $push: { messages: newMessage },
        $set: { lastMessageText: content, lastMessageAt: new Date() }
      }, { new: true });

      // Emit real-time update
      if (global.io) {
        global.io.to(`client_${clientId}`).emit('igMessageNew', {
          conversationId: id,
          channel: 'instagram',
          participantId: convo.igsid,
          participantName: convo.igUsername || `IG User ${convo.igsid.slice(-6)}`,
          lastMessageText: content,
          lastMessageAt: new Date().toISOString()
        });
      }

      return res.json({
        success: true,
        message: newMessage
      });
    }

    // WhatsApp — delegate to existing conversation message endpoint
    // This just proxies to the existing /api/conversations/:id/messages POST logic
    const api = require('../../routes/conversations');
    return res.status(400).json({ error: 'Use /api/conversations/:id/messages for WhatsApp messages' });

  } catch (err) {
    log.error('[sendMessage] Error:', err.message, { stack: err.stack });
    return res.status(500).json({ error: 'Failed to send message' });
  }
}

module.exports = {
  listConversations,
  getFilters,
  getMessages,
  markRead,
  sendMessage
};
