const express = require('express');
const router = express.Router();
const SupportChat = require('../models/SupportChat');
const Notification = require('../models/Notification');
const Client = require('../models/Client');
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
- "That information is not available yet...": Usually onboarding or missing setup data. Ask user to verify selected workspace/client, complete onboarding, then hard refresh.

INSTRUCTIONS:
- Act like a friendly, helpful, human support agent.
- Keep your answers highly conversational and concise. NEVER output long paragraphs.
- If a response requires multiple steps, break them into short sentences or very brief bullet points.
- Always give at least one concrete next action (exact page path or button).
- If you cannot solve a complex problem after 2 attempts, tell the user: "I've logged this for our technical team. Would you like to talk to a human expert?"
- Always ask if they need further help.

RESPONSE FORMAT:
Return your response in a supportive, premium, human-like tone, optimized for quick reading in a chat interface.
`;

// Get current support chat for a client
router.get('/', protect, async (req, res) => {
  try {
    // Find the most recent non-resolved chat
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } }).sort({ createdAt: -1 });
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

// Create a new support chat (forces resolution of previous)
router.post('/new', protect, async (req, res) => {
  try {
    // Resolve all previous active chats
    await SupportChat.updateMany({ clientId: req.user.clientId, status: { $ne: 'resolved' } }, { status: 'resolved' });
    
    const chat = await SupportChat.create({
      clientId: req.user.clientId,
      clientName: req.user.name || 'User',
      messages: [{ sender: 'ai', text: 'New session started. How can I assist you further?' }]
    });
    
    const io = req.app.get('socketio');
    if (io) {
      io.to('super_admin_room').emit('new_support_activity', chat);
    }
    
    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get chat history for a client
router.get('/history', protect, async (req, res) => {
  try {
    const chats = await SupportChat.find({ clientId: req.user.clientId, status: 'resolved' }).sort({ updatedAt: -1 }).limit(10);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Mark support chat as read by user (clears user unread badge)
router.post('/:id/read_user', protect, async (req, res) => {
  try {
    const chat = await SupportChat.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!chat) return res.status(404).json({ message: 'Chat not found' });
    chat.hasUnreadUser = false;
    await chat.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Send message to Support AI
router.post('/message', protect, async (req, res) => {
  try {
    const { text, imageUrl, mimeType } = req.body;
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } }).sort({ createdAt: -1 });
    
    if (!chat) return res.status(404).json({ message: 'No active support chat' });

    // AI Intent Detection for human handover
    const humanIntents = ['talk to human', 'human support', 'representative', 'customer service', 'human expert', 'speak to someone', 'real person'];
    const userText = String(text || '').trim();
    const hasImage = !!String(imageUrl || '').trim();
    if (!userText && !hasImage) {
      return res.status(400).json({ message: 'Message text or image is required' });
    }
    const lowerText = userText.toLowerCase();
    const needsHuman = humanIntents.some(intent => lowerText.includes(intent));

    // Add user message
    chat.messages.push({
      sender: 'user',
      text: userText || '[Image shared]',
      imageUrl: hasImage ? String(imageUrl).trim() : '',
      mimeType: mimeType || ''
    });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadAdmin = true; 
    chat.hasUnreadUser = false; // User just sent a message, so they've seen the chat

    if (needsHuman && chat.status === 'active') {
      chat.status = 'human_requested';
      chat.messages.push({ sender: 'ai', text: 'I understand you\'d like to speak with a human expert. I\'m connecting you now!' });
      
      // Create a System Notification for Super Admins
      await Notification.create({
        clientId: 'TOPEDGE_ADMIN',
        title: 'Support Handoff Triggered',
        message: `${chat.clientName} requested human assistance via AI detection.`,
        type: 'system',
        metadata: { chatId: chat._id, clientId: req.user.clientId }
      });
    } else if (chat.status === 'active') {
      // Only generate AI response if status is active
      const history = chat.messages.map(m => `${m.sender.toUpperCase()}: ${m.text}${m.imageUrl ? ` [image: ${m.imageUrl}]` : ''}`).join('\n');
      const client = await Client.findOne({ clientId: req.user.clientId }).select('businessName businessType platformVars wizardFeatures activeConfig');
      const bizCtx = client ? `
BUSINESS CONTEXT:
- Name: ${client.businessName || 'Unknown'}
- Type: ${client.businessType || 'general'}
- Support Email: ${client.platformVars?.supportEmail || 'not set'}
- WhatsApp Connected: ${client.activeConfig?.whatsappConnected ? 'yes' : 'no'}
` : '';
      const imageHint = hasImage
        ? '\nThe user attached an image. If the image cannot be analyzed directly, acknowledge it and ask one precise follow-up question to proceed.'
        : '';
      const prompt = `${SUPPORT_PROMPT}\n${bizCtx}${imageHint}\n\nCONVERSATION HISTORY:\n${history}\n\nAI:`;
      
      const aiResponse = await generateText(prompt);
      chat.messages.push({ sender: 'ai', text: String(aiResponse || '').trim() || 'I can help with that. Please share one more detail so I can guide you correctly.' });
    }
    
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${req.user.clientId}`).emit('support_update', chat);
      io.to('super_admin_room').emit('new_support_activity', chat);
      if (needsHuman) {
        io.to('super_admin_room').emit('support_handoff_alert', chat);
      }
    }

    res.json(chat);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Human Handoff Request (Manual button)
router.post('/handoff', protect, async (req, res) => {
  try {
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } });
    if (!chat) return res.status(404).json({ message: 'No active support chat' });

    chat.status = 'human_requested';
    chat.messages.push({ sender: 'ai', text: 'I am connecting you with one of our human experts. They will be with you shortly!' });
    chat.hasUnreadAdmin = true;
    await chat.save();

    // Create a System Notification for Super Admins
    await Notification.create({
      clientId: 'TOPEDGE_ADMIN',
      title: 'Support Handoff Required',
      message: `${chat.clientName} requires human assistance in dashboard support.`,
      type: 'system',
      metadata: { chatId: chat._id, clientId: req.user.clientId }
    });

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${req.user.clientId}`).emit('support_update', chat);
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
    const chats = await SupportChat.find().sort({ lastMessageAt: -1 }).limit(50);
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
    chat.hasUnreadAdmin = false; // Admin just replied
    chat.status = 'human_takeover'; 
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

// Admin: Release to AI
router.post('/:id/release', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    chat.status = 'active'; // Reset to active
    chat.messages.push({ sender: 'ai', text: 'Human expert has released control. AI is now back online.' });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadAdmin = false;
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

// Admin: Resolve Chat
router.post('/:id/resolve', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    chat.status = 'resolved';
    chat.messages.push({ sender: 'ai', text: 'This conversation has been marked as resolved. Feel free to start a new chat if you need more help!' });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadAdmin = false;
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

// ── PUBLIC: Widget config (no auth required) ──────────────────────────────
// @route   GET /api/support-chat/config/:clientId
// @desc    Returns public branding info for the chat widget
// @access  Public
router.get('/config/:clientId', async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId }).select('businessName activeConfig.whatsappNumber');
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const name = client.businessName || 'Support';
    res.json({
      businessName: name,
      avatarLetter: name.charAt(0).toUpperCase(),
      greeting: `Hi! Welcome to ${name}. How can we help you today? 👋`
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PUBLIC: Widget lead capture (no auth required) ────────────────────────
// @route   POST /api/support-chat/widget-lead
// @desc    Capture a lead from the website chat widget form
// @access  Public
const AdLead = require('../models/AdLead');
const NotificationService = require('../utils/notificationService');
router.post('/widget-lead', async (req, res) => {
  try {
    const { clientId, name, phone, email, message, source, pageUrl } = req.body;
    if (!clientId || !phone || !message) {
      return res.status(400).json({ message: 'clientId, phone, and message are required' });
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    
    // Upsert lead
    const lead = await AdLead.findOneAndUpdate(
      { phoneNumber: normalizedPhone, clientId },
      {
        $setOnInsert: {
          phoneNumber: normalizedPhone,
          clientId,
          optStatus: 'opted_in',
          optInDate: new Date(),
          optInSource: 'website_widget',
          source: 'Website Widget'
        },
        $set: {
          ...(name  && { name }),
          ...(email && { email }),
          lastInteraction: new Date(),
          'adAttribution.source': 'website_widget',
          'adAttribution.adSourceUrl': pageUrl || ''
        },
        $push: {
          activityLog: {
            action: 'widget_message',
            details: message.substring(0, 200),
            timestamp: new Date()
          }
        }
      },
      { upsert: true, new: true }
    );

    // Notify admin via WhatsApp
    const client = await Client.findOne({ clientId });
    if (client) {
      try {
        await NotificationService.sendAdminAlert(client, {
          customerPhone: normalizedPhone,
          topic: `🌐 New Website Enquiry from ${name || 'a visitor'}`,
          triggerSource: `📄 Page: ${pageUrl || 'Unknown'}\n💬 "${message}"`,
          channel: 'whatsapp'
        });
      } catch (notifErr) {
        console.warn('[WidgetLead] Admin alert failed:', notifErr.message);
      }
    }

    res.json({ success: true, leadId: lead._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PUBLIC: Widget flow retrieval ───────────────────────────────────────────
// @route   GET /api/support-chat/widget-flow/:clientId
// @desc    Returns the active flow for the website widget
// @access  Public
router.get('/widget-flow/:clientId', async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId }).select('visualFlows avatar botName businessName themeColor');
    if (!client) return res.status(404).json({ message: 'Client not found' });

    // Find the primary flow (e.g., first one or one marked as 'active')
    const activeFlow = client.visualFlows?.find(f => f.isActive) || client.visualFlows?.[0];
    
    res.json({
      success: true,
      flow: activeFlow || null,
      branding: {
        botName: client.botName || 'AI Assistant',
        avatar: client.avatar || '',
        businessName: client.businessName || 'Our Store',
        themeColor: client.themeColor || '#7C3AED'
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

