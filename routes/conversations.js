const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const WhatsApp = require('../utils/whatsapp');
const { createMessage } = require('../utils/createMessage');

// @route   GET /api/conversations
// @desc    Get all conversations for the client
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { days, clientId, phone } = req.query;
    let query = {};

    if (phone) {
      query.phone = phone;
    }

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
      query.lastMessageAt = { $gte: date };
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const conversations = await Conversation.find(query)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedTo', 'name');
    
    const total = await Conversation.countDocuments(query);

    res.json({
      success: true,
      data: conversations,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
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

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: -1 }) // Get newest first for pagination
      .skip(skip)
      .limit(limit);

    res.json(messages.reverse()); // Return in chronological order for UI
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

    // Resolve client credentials
    const client = await Client.findOne({ clientId: conversation.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    let newMessage;
    if (mediaUrl && (mediaType?.toLowerCase() === 'image')) {
      await WhatsApp.sendImage(client, conversation.phone, mediaUrl, content);
      newMessage = await createMessage({
        clientId: conversation.clientId,
        phone: conversation.phone,
        direction: 'outbound',
        type: 'image',
        body: content,
        mediaUrl
      });
    } else {
      await WhatsApp.sendText(client, conversation.phone, content);
      newMessage = await createMessage({
        clientId: conversation.clientId,
        phone: conversation.phone,
        direction: 'outbound',
        type: 'text',
        body: content
      });
    }

    // Update Conversation
    conversation.lastMessage = content.substring(0, 100);
    conversation.lastMessageAt = Date.now();
    await conversation.save();

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

    await WhatsApp.sendTemplate(client, conversation.phone, templateName, languageCode, components);

    // Save outbound message
    const newMessage = await createMessage({
      clientId: conversation.clientId,
      phone: conversation.phone,
      direction: 'outbound',
      type: 'template',
      body: `[Template: ${templateName}]`
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

// @route   POST /api/conversations/:id/csat
router.post('/:id/csat', protect, async (req, res) => {
  try {
    const { rating } = req.body;
    const conversation = await Conversation.findOne({ _id: req.params.id });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    
    conversation.csatScore = { rating, respondedAt: new Date() };
    await conversation.save();
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   POST /api/conversations/:id/assign
router.post('/:id/assign', protect, async (req, res) => {
  try {
    const { agentId, priority } = req.body;
    const conversation = await Conversation.findOne({ _id: req.params.id });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    
    if (agentId) conversation.assignedTo = agentId;
    if (priority) conversation.priority = priority;
    
    await conversation.save();
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
