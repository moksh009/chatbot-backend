const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { protect } = require('../middleware/auth');
const axios = require('axios');

// @route   GET /api/conversations
// @desc    Get all conversations for the client
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { days } = req.query;
    let query = { clientId: req.user.clientId };

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
    const conversation = await Conversation.findOne({ 
      _id: req.params.id, 
      clientId: req.user.clientId 
    }).populate('assignedTo', 'name');

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
    const conversation = await Conversation.findOne({ 
      _id: req.params.id, 
      clientId: req.user.clientId 
    });

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
  const { content } = req.body;
  
  try {
    const conversation = await Conversation.findOne({ 
      _id: req.params.id, 
      clientId: req.user.clientId 
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    // Send to WhatsApp API
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_TOKEN;
    const url = `https://graph.facebook.com/${process.env.API_VERSION || 'v18.0'}/${phoneNumberId}/messages`;

    await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: conversation.phone,
      type: 'text',
      text: { body: content }
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Save to DB
    const newMessage = await Message.create({
      clientId: req.user.clientId,
      conversationId: conversation._id,
      from: 'agent', // Or agent ID/Name
      to: conversation.phone,
      content,
      type: 'text',
      direction: 'outgoing',
      status: 'sent'
    });

    // Update Conversation
    conversation.lastMessage = content;
    conversation.lastMessageAt = Date.now();
    await conversation.save();

    // Emit Socket Event (Assuming io is attached to req.app)
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${req.user.clientId}`).emit('new_message', newMessage);
      io.to(`client_${req.user.clientId}`).emit('conversation_update', conversation);
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
    const conversation = await Conversation.findOne({ 
      _id: req.params.id, 
      clientId: req.user.clientId 
    });

    if (!conversation) return res.status(404).json({ message: 'Not found' });

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
    const conversation = await Conversation.findOne({ 
      _id: req.params.id, 
      clientId: req.user.clientId 
    });

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    conversation.status = 'BOT_ACTIVE';
    conversation.assignedTo = null;
    await conversation.save();

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
