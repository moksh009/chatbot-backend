const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const axios = require('axios');

// @route   GET /api/conversations
// @desc    Get all conversations for the client
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { days, clientId } = req.query;
    let query = {};

    // For non-SUPER_ADMIN, always restrict to their own clientId
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    } else if (clientId) {
      // SUPER_ADMIN can filter by a specific clientId if provided
      query.clientId = clientId;
    }
    // If SUPER_ADMIN but no clientId provided, they see everything or we could default.
    // Let's default to everything for SUPER_ADMIN if no clientId is passed.

    if (days) {
      const date = new Date();
      date.setDate(date.getDate() - parseInt(days));
      query.updatedAt = { $gte: date };
    }

    const conversations = await Conversation.find(query)
      .sort({ lastMessageAt: -1 })
      .populate('assignedTo', 'name');
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   GET /api/conversations/:id
// @desc    Get single conversation details
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query).populate('assignedTo', 'name');

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   GET /api/conversations/:id/messages
// @desc    Get messages for a conversation
// @access  Private
router.get('/:id/messages', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: 1 }); // Oldest first

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   POST /api/conversations/:id/messages
// @desc    Send a message (Agent reply)
// @access  Private
router.post('/:id/messages', protect, async (req, res) => {
  const { content, mediaUrl, mediaType } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    // Resolve client-specific WhatsApp credentials using conversation's clientId
    const client = await Client.findOne({ clientId: conversation.clientId });

    const phoneNumberId =
      client?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONENUMBER_ID;
    const token =
      client?.whatsappToken || process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
      return res.status(500).json({
        message: 'WhatsApp credentials not configured for this client',
      });
    }

    const url = `https://graph.facebook.com/${process.env.API_VERSION || 'v18.0'}/${phoneNumberId}/messages`;

    let waPayload;
    let messageType = 'text';

    if (mediaUrl && (mediaType === 'image' || mediaType === 'IMAGE')) {
      messageType = 'image';
      waPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: conversation.phone,
        type: 'image',
        image: {
          link: mediaUrl,
          caption: content || undefined
        }
      };
    } else if (mediaUrl && (mediaType === 'document' || mediaType === 'file' || mediaType === 'DOCUMENT')) {
      messageType = 'document';
      waPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: conversation.phone,
        type: 'document',
        document: {
          link: mediaUrl,
          caption: content || undefined
        }
      };
    } else {
      messageType = 'text';
      waPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: conversation.phone,
        type: 'text',
        text: { body: content }
      };
    }

    await axios.post(url, waPayload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Save to DB (MUST use conversation.clientId)
    const newMessage = await Message.create({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      from: 'agent',
      to: conversation.phone,
      content,
      type: messageType,
      direction: 'outgoing',
      status: 'sent',
      mediaUrl: mediaUrl || undefined
    });

    // Update Conversation
    conversation.lastMessage = content;
    conversation.lastMessageAt = Date.now();
    await conversation.save();

    // Emit Socket Event (Target the owner of the conversation)
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to send message', error: error.message });
  }
});

// @route   PUT /api/conversations/:id/takeover
// @desc    Agent takes over conversation (pauses bot)
// @access  Private
router.put('/:id/takeover', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Not found' });

    // Check plan using conversation.clientId
    const client = await Client.findOne({ clientId: conversation.clientId });
    if (client && client.plan === 'CX Agent (V1)') {
      return res.status(403).json({ message: 'Human Handoff is locked for CX Agent (v1). Please upgrade to v2.' });
    }

    conversation.status = 'HUMAN_TAKEOVER';
    conversation.assignedTo = req.user._id;
    await conversation.save();

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   PUT /api/conversations/:id/release
// @desc    Release conversation back to bot
// @access  Private
router.put('/:id/release', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    conversation.status = 'BOT_ACTIVE';
    conversation.assignedTo = null;
    await conversation.save();

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   PUT /api/conversations/:id/read
// @desc    Mark conversation as read (reset unreadCount)
// @access  Private
router.put('/:id/read', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    conversation.unreadCount = 0;
    await conversation.save();

    // Emit Socket Event to update other connected clients for this tenant
    // Emit Socket Event to update other connected clients for this tenant
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
