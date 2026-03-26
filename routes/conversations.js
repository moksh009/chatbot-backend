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

// @route   POST /api/conversations/:id/summarize
// @desc    Summarize conversation using AI
// @access  Private
router.post('/:id/summarize', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: 1 })
      .limit(50);
    
    if (messages.length === 0) {
      return res.json({ summary: "No messages found to summarize.", sentiment: "neutral" });
    }

    const chatLog = messages.map(m => `${m.from}: ${m.content}`).join('\n');
    
    const { generateText } = require('../utils/gemini');
    
    const prompt = `
      Analyze this WhatsApp conversation and provide:
      1. A one-sentence summary of the user's intent or current status.
      2. Their sentiment (choose: "happy", "interested", "frustrated", "neutral").
      
      Return ONLY raw JSON: {"summary": "...", "sentiment": "..."}
      
      CONVERSATION:
      ${chatLog}
    `;
    
    const aiResponse = await generateText(prompt);
    
    try {
      // Clean potential markdown formatting from AI
      const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(jsonStr);
      res.json(result);
    } catch (e) {
      console.error("AI JSON Parse Error:", aiResponse);
      res.json({ summary: aiResponse, sentiment: "neutral" });
    }
  } catch (error) {
    console.error("Summarization Error:", error);
    res.status(500).json({ message: 'AI processing failed', error: error.message });
  }
});

// @route   POST /api/conversations/:id/send-template
// @desc    Send a Meta WhatsApp Template to a lead
// @access  Private
router.post('/:id/send-template', protect, async (req, res) => {
  const { templateName, languageCode = 'en', components = [] } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    const phoneNumberId = client?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = client?.whatsappToken || process.env.WHATSAPP_TOKEN;

    if (!phoneNumberId || !token) {
      return res.status(500).json({ message: 'WhatsApp credentials not configured' });
    }

    const url = `https://graph.facebook.com/${process.env.API_VERSION || 'v18.0'}/${phoneNumberId}/messages`;
    const waPayload = {
      messaging_product: 'whatsapp',
      to: conversation.phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components
      }
    };

    await axios.post(url, waPayload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Save outbound message sync
    const newMessage = await Message.create({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      from: 'agent',
      to: conversation.phone,
      content: `[Template: ${templateName}]`,
      type: 'template',
      direction: 'outgoing',
      status: 'sent'
    });

    conversation.lastMessage = `[Template: ${templateName}]`;
    conversation.lastMessageAt = Date.now();
    await conversation.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    console.error('Template Send Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to send template', error: error.message });
  }
});

// @route   POST /api/conversations/:id/send-email
// @desc    Send an email to a lead from LiveChat
// @access  Private
router.post('/:id/send-email', protect, async (req, res) => {
  const { subject, body, toEmail } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    if (!client?.emailUser || !client?.emailAppPassword) {
      return res.status(400).json({ message: 'Email SMTP not configured for this client' });
    }

    const emailService = require('../utils/emailService');
    await emailService.sendEmail(client, {
      to: toEmail,
      subject,
      html: `<div>${body.replace(/\n/g, '<br/>')}</div>`
    });

    // Save outbound message as "email" type
    const newMessage = await Message.create({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      from: 'agent',
      to: conversation.phone,
      content: `[Email] ${subject}`,
      type: 'email',
      direction: 'outgoing',
      status: 'sent'
    });

    conversation.lastMessage = `[Email] ${subject}`;
    conversation.lastMessageAt = Date.now();
    await conversation.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    console.error('Email Send Error:', error.message);
    res.status(500).json({ message: 'Failed to send email' });
  }
});

module.exports = router;
