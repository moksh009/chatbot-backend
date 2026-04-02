const express = require('express');
const router = express.Router();
const SupportChat = require('../models/SupportChat');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const { generateText } = require('../utils/gemini');

const SUPPORT_PROMPT = `
You are the TopEdge AI Expert Support Assistant. Your goal is to help dashboard users (Indian Ecommerce shop owners) resolve technical issues and understand features.

DASHBOARD KNOWLEDGE:
1. Overview: Real-time insights into orders, revenue, and customer sentiment.
2. Live Chats: Manage WhatsApp/Instagram/Email conversations. "Action Needed" indicates a bot couldn't answer.
3. Analytics: ROI tracking, RTO (Return to Origin) reduction metrics, and lead conversion rates.
4. Shopify Hub: Connect your store to sync products, orders, and recover abandoned carts.
5. Campaigns: Send bulk WhatsApp marketing messages to segments.
6. Flow Builder: Drag-and-drop builder to create automated chat journeys.
7. Templates: Official Meta-approved templates for WhatsApp.

COMMON ERRORS & SOLUTIONS:
- "Shopify Token Expired": Go to Settings > Shopify and re-authenticate.
- "WhatsApp Template Rejected": Ensure no marketing jargon in service templates. Try a different category.
- "Bot not responding": Ensure the conversation status is "BOT_ACTIVE" and not "HUMAN_TAKEOVER".

INSTRUCTIONS:
- Act like a friendly, helpful, human support agent.
- Keep your answers highly conversational and concise. NEVER output long paragraphs.
- If a response requires multiple steps, break them into short sentences or very brief bullet points.
- If you cannot solve a complex problem after 2 attempts, tell the user: "I've logged this for our technical team. Would you like to talk to a human expert?"
- Always ask if they need further help.

RESPONSE FORMAT:
Return your response in a supportive, premium, human-like tone, optimized for quick reading in a chat interface.
`;

// Get current support chat for a client
router.get('/', protect, async (req, res) => {
  try {
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } });
    if (!chat) {
      chat = await SupportChat.create({
        clientId: req.user.clientId,
        clientName: req.user.name || 'User',
        messages: [{ sender: 'ai', text: 'Hello! I am your TopEdge AI Success Expert. How can I help you grow your store today?' }]
      });
    }
    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Send message to Support AI
router.post('/message', protect, async (req, res) => {
  try {
    const { text } = req.body;
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } });
    
    if (!chat) return res.status(404).json({ message: 'No active support chat' });

    // Add user message
    chat.messages.push({ sender: 'user', text });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadAdmin = true; // Admin should see new activity

    // Generate AI response
    const history = chat.messages.map(m => `${m.sender.toUpperCase()}: ${m.text}`).join('\n');
    const prompt = `${SUPPORT_PROMPT}\n\nCONVERSATION HISTORY:\n${history}\n\nAI:`;
    
    const aiResponse = await generateText(prompt);
    chat.messages.push({ sender: 'ai', text: aiResponse });
    
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${req.user.clientId}`).emit('support_update', chat);
      // Notify super admins in their room
      io.to('super_admin_room').emit('new_support_activity', chat);
    }

    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Human Handoff Request
router.post('/handoff', protect, async (req, res) => {
  try {
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } });
    if (!chat) return res.status(404).json({ message: 'No active support chat' });

    chat.status = 'human_requested';
    chat.messages.push({ sender: 'ai', text: 'I am connecting you with one of our human experts. They will be with you shortly!' });
    await chat.save();

    // Create a System Notification for Super Admins
    await Notification.create({
      clientId: 'TOPEDGE_ADMIN', // Internal identifier for us
      title: 'Support Handoff Required',
      message: `${chat.clientName} requires human assistance in dashboard support.`,
      type: 'system',
      metadata: { chatId: chat._id, clientId: req.user.clientId }
    });

    const io = req.app.get('socketio');
    if (io) {
      io.to('super_admin_room').emit('support_handoff_alert', chat);
    }

    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Super Admin: Get all support chats
router.get('/all', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const chats = await SupportChat.find().sort({ lastMessageAt: -1 });
    res.json(chats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin Reply
router.post('/:id/reply', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const { text } = req.body;
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    chat.messages.push({ sender: 'admin', text });
    chat.hasUnreadUser = true;
    chat.lastMessageAt = Date.now();
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${chat.clientId}`).emit('support_update', chat);
    }

    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
