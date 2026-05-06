const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/queryHelpers');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const WhatsApp = require('../utils/whatsapp');
const { createMessage } = require('../utils/createMessage');
const ExportJob = require('../models/ExportJob');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { uploadToCloud } = require('../utils/cloudinary');
const { correctAIResponse } = require('../controllers/flowFixController');
const Notification = require('../models/Notification');
const { logAction } = require('../middleware/audit');

const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

router.post('/correct-ai', protect, correctAIResponse);

const upload = multer({ storage: multer.memoryStorage() });

// @route   GET /api/conversations
// @desc    Get all conversations for the client
// @access  Private
router.get('/', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { days, clientId, phone, isImported } = req.query;
    let query = {};
    if (phone) {
      query.phone = phone;
    }

    // Non–super-admins: always JWT tenant. Super-admins: optional `clientId` in query; if omitted, unscoped (all tenants).
    const qClient = clientId && String(clientId).trim() ? String(clientId).trim() : null;
    const activeClientId =
      req.user.role === 'SUPER_ADMIN' ? qClient : req.user.clientId || null;
    const scopeToTenant = req.user.role !== 'SUPER_ADMIN' || !!qClient;

    if (scopeToTenant) {
      if (!activeClientId) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      query.clientId = activeClientId;
    }

    if (days) {
      const date = new Date();
      date.setDate(date.getDate() - parseInt(days));
      query.lastMessageAt = { $gte: date };
    }

    // Filter for imported lists only
    if (isImported === 'true') {
      if (!activeClientId) {
        return res.status(400).json({ success: false, message: 'clientId is required when filtering imported leads' });
      }
      const AdLead = require('../models/AdLead');
      const importedLeads = await AdLead.find({ clientId: activeClientId, source: 'imported' }).select('phoneNumber').lean();
      const importedPhones = importedLeads.map(l => l.phoneNumber);
      if (query.phone) {
        if (!importedPhones.includes(query.phone)) {
           // Provide an unmatchable phone if the specific phone requested isn't imported
           query.phone = '___UNMATCHABLE___';
        }
      } else {
        query.phone = { $in: importedPhones };
      }
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('_id phone customerName lastMessage lastMessageAt channel status unreadCount assignedTo isBotPaused botPaused requiresAttention attentionReason lastDetectedIntent summary')
        .populate('assignedTo', 'name')
        .lean(),
      Conversation.countDocuments(query)
    ]);

    // Enterprise Enrichment: Bulk fetch all leads in one query instead of N+1
    const AdLead = require('../models/AdLead');
    const phones = conversations.map(c => c.phone).filter(Boolean);
    const leads = phones.length > 0
      ? await AdLead.find({ clientId: conversations[0]?.clientId, phoneNumber: { $in: phones } })
          .select('phoneNumber leadScore cartStatus checkoutInitiatedCount addToCartCount isOrderPlaced tags')
          .lean()
      : [];
    const leadMap = new Map(leads.map(l => [l.phoneNumber, l]));

    const enrichedConversations = conversations.map(conv => {
      const lead = leadMap.get(conv.phone);
      if (lead) {
        let derivedIntent = 'Browsing';
        if (lead.cartStatus === 'abandoned') derivedIntent = 'Cart Abandoned';
        else if (lead.checkoutInitiatedCount > 0 && !lead.isOrderPlaced) derivedIntent = 'High Intent';
        else if (lead.addToCartCount > 0) derivedIntent = 'Browsing with Intent';
        else if (lead.cartStatus === 'recovered') derivedIntent = 'Recovered Cart';
        return { ...conv, leadScore: lead.leadScore, derivedLeadState: derivedIntent, leadTags: lead.tags };
      }
      return conv;
    });

    res.json({
      success: true,
      data: enrichedConversations,
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

// @route   POST /api/conversations/:id/email
// @desc    Send a manual email to the customer
// @access  Private
const { sendEmailMessage } = require('../utils/emailIntegration');
router.post('/:id/email', protect, async (req, res) => {
  try {
    const { subject, text, html } = req.body;
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const toEmail = conversation.email || conversation.phone; // Fallback if email not set but phone is an email address
    if (!toEmail || !toEmail.includes('@')) {
      return res.status(400).json({ message: 'Customer does not have a valid email address associated with this conversation.' });
    }

    const result = await sendEmailMessage(client, toEmail, subject, text, html);
    
    // Update conversation last message
    conversation.lastMessage = subject ? `Email: ${subject}` : text.substring(0, 50);
    conversation.lastMessageAt = new Date();
    conversation.unreadCount = 0;
    await conversation.save();

    res.json({ success: true, message: result });
  } catch (error) {
    console.error('[Conversations] Email send error:', error);
    res.status(500).json({ message: error.message || 'Failed to send email' });
  }
});

// @route   GET /api/conversations/:id
// @desc    Get single conversation details
// @access  Private
router.get('/:id', protect, logPersonalDataAccess, async (req, res) => {
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
router.get('/:id/messages', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before; // ISO timestamp
    const queryPayload = { conversationId: conversation._id };
    
    if (before) {
      queryPayload.timestamp = { $lt: new Date(before) };
    }

    const messages = await Message.find(queryPayload)
      .sort({ timestamp: -1 }) // Get newest first for pagination
      .limit(limit)
      .lean();

    res.json({
      messages: messages.reverse(), // Return in chronological order for UI
      nextCursor: messages.length === limit ? messages[0].timestamp.toISOString() : null,
      hasMore: messages.length === limit,
      meta: {
        customerPhone: conversation.phone,
        customerName: conversation.customerName,
        botStatus: conversation.botStatus || 'active'
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// ✅ Phase 2: Live Chat Mega-Payload (Full Context)
// Fetches conversation, 50 messages, lead intent, orders, and wallet in 1 round trip
router.get('/:id/full-context', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.clientId;
    
    // 1. Fetch main conversation
    let conversation = await Conversation.findOne({ _id: id, clientId })
      .select('phone customerName status botPaused botStatus unreadCount channel assignedTo summary lastDetectedIntent requiresAttention attentionReason clientId')
      .lean();
      
    if (!conversation) {
      // Allow super admins to view via direct ID if needed
      if (req.user.role === 'SUPER_ADMIN') {
         const saConv = await Conversation.findOne({ _id: id }).lean();
         if (!saConv) return res.status(404).json({ message: 'Conversation not found' });
         conversation = saConv;
      } else {
         return res.status(404).json({ message: 'Conversation not found' });
      }
    }
    
    const phone = conversation.phone;
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    
    // 2. Load all secondary data concurrently
    const [messages, lead, orders, wallet, activeSequence, notes] = await Promise.all([
      // Messages
      Message.find({ conversationId: id })
        .sort({ timestamp: -1 })
        .limit(50)
        .select('content type direction status timestamp mediaUrl metadata from to voiceTranscript originalText')
        .lean()
        .then(msgs => ({
          messages: msgs.reverse(),
          nextCursor: msgs.length === 50 ? msgs[0].timestamp.toISOString() : null,
          hasMore: msgs.length === 50
        })),
        
      // Lead Data
      (async () => {
         const AdLead = require('../models/AdLead');
         const l = await AdLead.findOne({ clientId: conversation.clientId || clientId, phoneNumber: phone })
           .select('name email leadScore cartStatus tags intentState source sentimentScore totalSpent lifetimeValue ordersCount lastInteraction isOrderPlaced cartSnapshot addToCartCount checkoutInitiatedCount importBatchId meta inboundIntent warrantyRecords')
           .lean();
         
         if (l) {
            if (l.importBatchId) {
                const ImportSession = require('../models/ImportSession');
                const batch = await ImportSession.findById(l.importBatchId).select('batchName').lean();
                if (batch) l.importSource = batch.batchName;
            } 
            if (!l.importSource && l.meta?.importListName) {
                l.importSource = l.meta.importListName;
            }
         }
         return l;
      })(),
      
      // Orders
      (async () => {
         if (!phoneSuffix) return [];
         const Order = require('../models/Order');
         return Order.find({
           clientId: conversation.clientId || clientId,
           $or: [
             { phone: { $regex: phoneSuffix + '$' } },
             { customerPhone: { $regex: phoneSuffix + '$' } },
             { phone: phone }
           ]
         })
           .sort({ createdAt: -1 })
           .limit(3)
           .select('orderId orderNumber customerName amount totalPrice status paymentMethod isCOD createdAt items')
           .lean()
           .catch(() => []);
      })(),
      
      // Loyalty Wallet
      (async () => {
         try {
           const Wallet = require('../models/CustomerWallet');
           return await Wallet.findOne({ clientId: conversation.clientId || clientId, phone })
             .select('balance tier lifetimePoints')
             .lean();
         } catch { return null; }
      })(),
      
      // FollowUp Active sequence
      (async () => {
         if (!phoneSuffix) return null;
         try {
           const FollowUpSequence = require('../models/FollowUpSequence');
           return await FollowUpSequence.findOne({
             clientId: conversation.clientId || clientId, 
             $or: [
               { phone: { $regex: phoneSuffix + '$' } },
               { phone: phone }
             ],
             status: { $regex: /^(active|pending)$/i }
           })
           .select('name status steps')
           .lean();
         } catch { return null; }
      })(),
      
      // Notes
      (async () => {
         try {
           const ConversationNote = require('../models/ConversationNote');
           return await ConversationNote.find({ conversationId: id }).sort({ createdAt: 1 }).lean();
         } catch { return []; }
      })()
    ]);
    
    // Attach notes for UI backwards compatibility
    if (conversation) {
      conversation.internalNotes = notes || [];
    }
    
    res.json({ 
      conversation, 
      messages: messages.messages, 
      nextCursor: messages.nextCursor, 
      hasMore: messages.hasMore, 
      lead, 
      orders, 
      wallet, 
      activeSequence 
    });
  } catch (error) {
    console.error('[FullContext Error]:', error);
    res.status(500).json({ message: 'Server Error fetching full context' });
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

    // --- Phase 28: Bidirectional Translation (Outgoing) ---
    const { translateText } = require('../utils/translationEngine');
    let finalContent = content;
    let translatedContent = '';
    const translationConfig = client.translationConfig || {};

    if (
      translationConfig.enabled && 
      conversation.detectedLanguage && 
      conversation.detectedLanguage !== 'en' && 
      conversation.detectedLanguage !== (translationConfig.agentLanguage || 'en')
    ) {
      translatedContent = await translateText(content, conversation.detectedLanguage, client?.geminiApiKey || process.env.GEMINI_API_KEY);
      if (translatedContent && translatedContent !== content) {
        finalContent = translatedContent;
      }
    }

    let newMessage;
    if (mediaUrl) {
      const type = mediaType?.toLowerCase() || 'image';
      
      if (type === 'image') {
        await WhatsApp.sendImage(client, conversation.phone, mediaUrl, finalContent);
      } else if (type === 'video') {
        if (WhatsApp.sendVideo) await WhatsApp.sendVideo(client, conversation.phone, mediaUrl, finalContent);
        else await WhatsApp.sendText(client, conversation.phone, `${finalContent}\n\nVideo: ${mediaUrl}`);
      } else if (type === 'document' || type === 'file') {
        if (WhatsApp.sendDocument) await WhatsApp.sendDocument(client, conversation.phone, mediaUrl, finalContent);
        else await WhatsApp.sendText(client, conversation.phone, `${finalContent}\n\nDocument: ${mediaUrl}`);
      } else {
        await WhatsApp.sendText(client, conversation.phone, `${finalContent}\n\nWait: ${mediaUrl}`);
      }

      newMessage = await createMessage({
        clientId: conversation.clientId,
        conversationId: conversation._id, // CRITICAL FIX
        phone: conversation.phone,
        direction: 'outbound',
        type: type === 'file' ? 'document' : type,
        body: content,
        translatedContent: translatedContent,
        detectedLanguage: conversation.detectedLanguage,
        mediaUrl
      });
    } else {
      await WhatsApp.sendText(client, conversation.phone, finalContent);
      newMessage = await createMessage({
        clientId: conversation.clientId,
        conversationId: conversation._id, // CRITICAL FIX
        phone: conversation.phone,
        direction: 'outbound',
        type: 'text',
        body: content,
        translatedContent: translatedContent,
        detectedLanguage: conversation.detectedLanguage
      });
    }

    // Update Conversation
    conversation.lastMessage = content.substring(0, 100);
    conversation.lastMessageAt = Date.now();
    
    // Phase 23: Track Agent Metrics (FRT)
    if (!conversation.firstResponseAt && conversation.firstInboundAt) {
      conversation.firstResponseAt = new Date();
    }
    
    conversation.requiresAttention = false; // Reset attention flag on manual reply
    if (conversation.attentionReason) conversation.attentionReason = '';
    await conversation.save();

    // Update AdLead for CRM consistency
    const AdLead = require('../models/AdLead');
    await AdLead.updateOne(
      { phoneNumber: conversation.phone, clientId: conversation.clientId },
      { 
        $set: { 
          lastMessageContent: content.substring(0, 500),
          lastInteraction: new Date()
        } 
      }
    ).catch(() => {});

    // ═══ Bot Intelligence: Auto-capture agent corrections ═══
    // When a human agent is replying (bot paused/takeover), record as a training case
    // so it appears in Bot Intelligence → Corrections tab
    if (conversation.botPaused || conversation.status === 'HUMAN_TAKEOVER' || conversation.status === 'HUMAN_SUPPORT') {
      try {
        // Find the last BOT outgoing message in this conversation
        const botLastMsg = await Message.findOne({
          conversationId: conversation._id,
          direction: 'outgoing',
          _id: { $ne: newMessage._id } // not the message we just created
        }).sort({ timestamp: -1 }).lean();

        // Find the last user incoming message
        const userLastMsg = await Message.findOne({
          conversationId: conversation._id,
          direction: 'incoming'
        }).sort({ timestamp: -1 }).lean();

        // Only create training case if both exist and the bot message was recent (within last 10 min)
        if (botLastMsg && userLastMsg && botLastMsg.body) {
          const botMsgAge = Date.now() - new Date(botLastMsg.timestamp || botLastMsg.createdAt).getTime();
          if (botMsgAge < 10 * 60 * 1000) { // 10 minutes
            const TrainingCase = require('../models/TrainingCase');
            await TrainingCase.create({
              clientId: conversation.clientId,
              conversationId: conversation._id,
              userMessage: (userLastMsg.body || userLastMsg.content || '').substring(0, 500),
              botResponse: (botLastMsg.body || botLastMsg.content || '').substring(0, 500),
              agentCorrection: content.substring(0, 500),
              phone: conversation.phone,
              status: 'pending'
            }).catch(tcErr => console.error('[TrainingCase] Creation failed:', tcErr.message));
          }
        }
      } catch (tcErr) {
        // Non-critical — don't block the agent reply if this fails
        console.error('[TrainingCase] Auto-capture error:', tcErr.message);
      }
    }

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    const errorData = error.response?.data?.error || error.data || error.message;
    const statusCode = error.status || error.response?.status || 500;

    console.error('Error sending message:', errorData);

    // Map 401/403 to 400 to prevent frontend Interceptor from logging out the user
    // if it's just a WhatsApp configuration issue.
    const finalStatus = [401, 403].includes(statusCode) ? 400 : statusCode;

    res.status(finalStatus).json({
      success: false,
      message: error.friendlyMessage || 'Failed to send message',
      error: errorData
    });
  }
});

// @route   PATCH /api/conversations/:id/bot-status
// @desc    Update bot status (active or paused)
// @access  Private
router.patch('/:id/bot-status', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { clientId, botStatus } = req.body;

    if (!['active', 'paused'].includes(botStatus)) {
      return res.status(400).json({ error: 'botStatus must be "active" or "paused".' });
    }

    const conversation = await Conversation.findOneAndUpdate(
      { _id: id, clientId },
      {
        $set: {
          botStatus,
          botPaused: botStatus === 'paused',
          isBotPaused: botStatus === 'paused',
          updatedAt: new Date()
        }
      },
      { new: true }
    ).select('botStatus phone customerName').lean();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Emit to frontend so all open sessions see the change immediately
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${clientId}`).emit('botStatusChanged', {
        conversationId: id,
        botStatus: conversation.botStatus
      });
    }

    res.json({ botStatus: conversation.botStatus });
  } catch (err) {
    console.error('[PATCH /conversations/:id/bot-status]', err);
    res.status(500).json({ error: 'Failed to update bot status.' });
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
    conversation.botPaused = true;
    conversation.isBotPaused = true;
    conversation.botStatus = 'paused';
    conversation.assignedTo = req.user._id;
    conversation.assignedAt = new Date(); // Ensure assignedAt is set
    conversation.requiresAttention = false; // Reset attention flag on manual takeover
    if (conversation.attentionReason) conversation.attentionReason = '';
    await conversation.save();

    // Task 1.2: Record assignment for historical analytics
    const ConversationAssignment = require('../models/ConversationAssignment');
    await ConversationAssignment.create({
      conversationId: conversation._id,
      clientId: conversation.clientId,
      assignedAgentId: req.user._id,
      assignedAt: conversation.assignedAt
    }).catch(err => console.error('[Analytics] Failed to record takeover assignment:', err.message));

    // Phase R4: Emit bot status change to all connected dashboard tabs
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('bot_status_changed', {
        conversationId: conversation._id,
        status: 'HUMAN_TAKEOVER',
        botPaused: true
      });
    }

    const AdLead = require('../models/AdLead');
    AdLead.pushJourneyEvent(conversation.clientId, conversation.phone, 'human_takeover', { agentId: req.user._id, agentName: req.user.name }).catch(() => {});

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
    conversation.botPaused = false;
    conversation.isBotPaused = false;
    conversation.botStatus = 'active';
    await conversation.save();

    // Phase R4: Emit bot status change to all connected dashboard tabs
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('bot_status_changed', {
        conversationId: conversation._id,
        status: 'BOT_ACTIVE',
        botPaused: false
      });
    }

    const AdLead = require('../models/AdLead');
    AdLead.pushJourneyEvent(conversation.clientId, conversation.phone, 'bot_release', { agentId: req.user._id, agentName: req.user.name }).catch(() => {});

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

// @route   PUT /api/conversations/:id/bot-status
// @desc    Toggle bot status
// @access  Private
router.put('/:id/bot-status', protect, async (req, res) => {
  try {
    const { paused } = req.body;
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $set: {
          botPaused: paused,
          isBotPaused: paused,
          botStatus: paused ? 'paused' : 'active'
        }
      },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('support_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('botStatusChanged', {
        conversationId: String(conversation._id),
        botStatus: conversation.botStatus
      });
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PATCH /api/conversations/:id/assign
// @desc    Assign conversation to an agent (Supports id or phone for new chats)
// @access  Private
router.patch('/:id/assign', protect, async (req, res) => {
  try {
    const { agentId, agentName, phone } = req.body;
    
    let query = {};
    const mongoose = require('mongoose');
    
    // Logic: Try ID first, then fallback to phone + clientId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      query._id = req.params.id;
    } else if (phone) {
      query.phone = phone;
      if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid conversation reference' });
    }

    const update = agentId
      ? { $set: { assignedTo: agentId, assignedAt: new Date(), assignedBy: agentName || req.user.name } }
      : { $unset: { assignedTo: 1, assignedAt: 1, assignedBy: 1 } };

    let conversation = await Conversation.findOneAndUpdate(query, update, { new: true }).populate('assignedTo', 'name email');
    
    // If conversation doesn't exist but we have a phone, it's a "brand new" chat that hasn't been saved yet.
    // Create it on the fly to support immediate assignment.
    if (!conversation && phone) {
      conversation = await Conversation.create({
        phone,
        clientId: query.clientId || req.user.clientId,
        assignedTo: agentId || undefined,
        assignedAt: agentId ? new Date() : undefined,
        assignedBy: agentId ? (agentName || req.user.name) : undefined,
        status: 'HUMAN_TAKEOVER' // Auto takeover if assigned
      });
      conversation = await Conversation.findById(conversation._id).populate('assignedTo', 'name email');
    }

    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    // Task 1.2: Record assignment for historical analytics
    if (agentId) {
      const ConversationAssignment = require('../models/ConversationAssignment');
      await ConversationAssignment.create({
        conversationId: conversation._id,
        clientId: conversation.clientId,
        assignedAgentId: agentId,
        assignedAt: new Date()
      }).catch(err => console.error('[Analytics] Failed to record manual assignment:', err.message));
    }

    // Save persistent notification in database
    if (agentId) {
      await Notification.create({
        clientId: conversation.clientId,
        title: 'New Assignment',
        message: `${agentName || req.user.name} assigned a conversation to you.`,
        type: 'assignment',
        metadata: { conversationId: conversation._id, phone: conversation.phone }
      });
    }

    const io = req.app.get('socketio');
    if (io) {
      const activeClientId = conversation.clientId;
      // Emit task_assigned for the specific agent to receive real-time toast
      if (agentId) {
        io.to(`agent_${agentId}`).emit('task_assigned', {
          agentId,
          message: 'Admin assigned a new conversation to you.',
          conversationId: conversation._id
        });
      }
      
      // ✅ Module 3.5: Broadcast real-time update to update "purple pill" everywhere
      io.to(`client_${activeClientId}`).emit('conversation_update', conversation);
      io.to(`client_${activeClientId}`).emit('conversation_assigned', { 
        conversationId: conversation._id, 
        agentId, 
        agentName: conversation.assignedTo?.name || null 
      });
    }

    res.json({ success: true, conversation });
  } catch (error) {
    console.error('[Assignment] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/conversations/:id/upload-media
// @desc    Upload media to Cloudinary and return URL
// @access  Private
router.post('/:id/upload-media', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const mediaUrl = await uploadToCloud(req.file.buffer, 'chat_media', 'auto');
    res.json({ success: true, mediaUrl });
  } catch (error) {
    console.error('[UploadMedia] Error:', error);
    res.status(500).json({ message: 'Media upload failed' });
  }
});

// @route   POST /api/conversations/correct-ai
// @desc    Log agent correction for AI training
// @access  Private
router.post('/correct-ai', protect, correctAIResponse);

// @route   PATCH /api/conversations/:id/labels
// @desc    Update conversation labels
// @access  Private
router.patch('/:id/labels', protect, async (req, res) => {
  try {
    const { labels } = req.body; // array of strings
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOneAndUpdate(query, { $set: { labels } }, { new: true });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/conversations/:id/notes
// @desc    Add an internal note to a conversation
// @access  Private
router.post('/:id/notes', protect, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ message: 'Note content is required' });

    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.create({
      conversationId: conversation._id,
      clientId: conversation.clientId,
      content: content.trim(),
      authorId: req.user._id,
      authorName: req.user.name || req.user.email,
      createdAt: new Date()
    });

    const io = req.app.get('socketio');
    if (io) io.to(`client_${conversation.clientId}`).emit('internal_note_added', { conversationId: conversation._id, note });

    res.json({ success: true, note, conversation });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   PATCH /api/conversations/:id/notes/:noteId
// @desc    Update an internal note
// @access  Private
router.patch('/:id/notes/:noteId', protect, async (req, res) => {
  try {
    const { content } = req.body;
    const { id, noteId } = req.params;
    
    if (!content?.trim()) return res.status(400).json({ message: 'Note content is required' });

    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.findOne({ _id: noteId, conversationId: id });
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    
    // Authorization: Only the author or a SUPER_ADMIN can edit
    if (req.user.role !== 'SUPER_ADMIN' && note.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this note' });
    }
    
    note.content = content.trim();
    await note.save();
    
    res.json({ success: true, note });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   DELETE /api/conversations/:id/notes/:noteId
// @desc    Delete an internal note
// @access  Private
router.delete('/:id/notes/:noteId', protect, async (req, res) => {
  try {
    const { id, noteId } = req.params;
    
    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.findOne({ _id: noteId, conversationId: id });
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    
    // Authorization: Only the author or a SUPER_ADMIN can delete
    if (req.user.role !== 'SUPER_ADMIN' && note.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this note' });
    }
    
    await ConversationNote.deleteOne({ _id: noteId });
    res.json({ success: true, message: 'Note deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
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
    const client = await Client.findOne({ clientId: conversation.clientId });

    const prompt = `
      Analyze this WhatsApp conversation and provide:
      1. A one-sentence summary of the user's intent or current status.
      2. Their sentiment (choose: "happy", "interested", "frustrated", "neutral").
      
      Return ONLY raw JSON: {"summary": "...", "sentiment": "..."}
      
      CONVERSATION:
      ${chatLog}
    `;

    const aiResponse = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY);

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
      conversationId: conversation._id, // CRITICAL FIX
      phone: conversation.phone,
      direction: 'outbound',
      type: 'template',
      body: `[Template: ${templateName}]`
    });

    conversation.lastMessage = `[Template: ${templateName}]`;
    conversation.lastMessageAt = Date.now();
    conversation.requiresAttention = false; // Reset attention flag on manual template send
    if (conversation.attentionReason) conversation.attentionReason = '';
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

// @route   POST /api/conversations/:id/generate-outreach
// @desc    Generate personalized AI outreach copy (Email/WhatsApp)
// @access  Private
router.post('/:id/generate-outreach', protect, async (req, res) => {
  const { goal, channel = 'email' } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: 1 })
      .limit(20);

    const chatLog = messages.map(m => `${m.from}: ${m.content}`).join('\n');
    const client = await Client.findOne({ clientId: conversation.clientId });
    const { generateText } = require('../utils/gemini');

    const prompt = `
      Act as an expert ecommerce conversion specialist.
      Generate a highly personalized ${channel} outreach message for this customer.
      
      GOAL: ${goal}
      CUSTOMER NAME: ${conversation.customerName || 'Customer'}
      HISTORY:
      ${chatLog}
      
      Requirements:
      1. One compelling subject line (max 10 words).
      2. A concise, persuasive message body.
      3. Tone should be professional, empathetic, and premium.
      
      Return ONLY raw JSON: {"subject": "...", "body": "..."}
    `;

    const aiResponse = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY);
    
    try {
      const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(jsonStr);
      res.json(result);
    } catch (e) {
      // Logic fallback if AI returns plain text
      res.json({ subject: "Personalized Outreach", body: aiResponse });
    }
  } catch (error) {
    console.error("AI Generation Error:", error);
    res.status(500).json({ message: 'AI processing failed' });
  }
});

// @route   POST /api/conversations/:id/send-email
// @desc    Send an email to a lead from LiveChat
// @access  Private
router.post('/:id/send-email', protect, async (req, res) => {
  const { subject, body, toEmail, scheduleDate } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    
    if (!client?.emailUser) {
      return res.status(400).json({ message: 'Email not configured: add sending address and app password in workspace email / SMTP settings.' });
    }

    if (scheduleDate) {
      const ScheduledMessage = require('../models/ScheduledMessage');
      const scheduledMsg = new ScheduledMessage({
        clientId: conversation.clientId,
        phone: toEmail,
        channel: 'email',
        messageType: 'text',
        content: { subject, body, toEmail },
        sendAt: new Date(scheduleDate),
        status: 'pending',
        sourceType: 'follow_up',
        sourceId: conversation._id
      });
      await scheduledMsg.save();
      
      const newMessage = await Message.create({
        clientId: conversation.clientId,
        conversationId: conversation._id,
        from: 'agent',
        to: toEmail,
        content: `[Scheduled Email] ${subject}\n\nScheduled for ${new Date(scheduleDate).toLocaleString()}`,
        status: 'sent',
        channel: 'email',
        messageType: 'text',
        timestamp: new Date()
      });
      
      return res.json({ success: true, message: 'Email scheduled successfully', scheduledMessage: scheduledMsg });
    }

    const emailService = require('../utils/emailService');
    const sent = await emailService.sendEmail(client, {
      to: toEmail,
      subject,
      html: `<div>${body.replace(/\n/g, '<br/>')}</div>`
    });
    if (!sent) {
      return res.status(503).json({ message: 'SMTP send failed. Check workspace email credentials and SMTP host/port (465 recommended).' });
    }

    const newMessage = await Message.create({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      from: 'agent',
      to: conversation.phone,
      content: `[Email] ${subject}\n\n${body}`,
      type: 'email',
      direction: 'outgoing',
      status: 'sent'
    });

    conversation.lastMessage = `[Email] ${subject}`;
    conversation.lastMessageAt = Date.now();
    conversation.requiresAttention = false; // Reset attention flag on manual email send
    if (conversation.attentionReason) conversation.attentionReason = '';
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


/**
 * @route   PUT /api/conversations/:id/resolve
 * @desc    Mark conversation as resolved
 * @access  Private
 */
router.put('/:id/resolve', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    conversation.status = 'BOT_ACTIVE';
    conversation.botPaused = false;
    conversation.isBotPaused = false;
    conversation.resolvedAt = new Date();
    conversation.requiresAttention = false;
    await conversation.save();

    // --- Phase 29: Track 2 AI Quality Scorer ---
    setImmediate(async () => {
      try {
        const { scoreConversation } = require('../utils/qualityScorer');
        await scoreConversation(conversation._id, conversation.clientId);
      } catch (err) {
        console.error('[QualityScorer] Error:', err.message);
      }
    });

    // --- Phase 23: Track 6 CSAT Trigger ---
    const { triggerCSAT } = require('../utils/csatService');
    await triggerCSAT(conversation); 

    const io = req.app.get('socketio');

    if (io) io.to(`client_${conversation.clientId}`).emit('conversation_resolved', conversation);

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ─── GET /api/conversations/:id/export — Export conversation as PDF/JSON/TXT ──
router.get('/:id/export', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { format = 'pdf' } = req.query;
    const conversation = await Conversation.findById(req.params.id).lean();
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: req.params.id })
      .sort({ createdAt: 1 })
      .lean();

    const client = await Client.findOne({ clientId: conversation.clientId }).lean();

    const timestamp = new Date().toISOString().split('T')[0];
    const filename  = `conversation_${conversation.phone}_${timestamp}`;

    // ── JSON export ─────────────────────────────────────────────────────────
    if (format === 'json') {
      res.set('Content-Type', 'application/json');
      res.set('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.send(JSON.stringify({ conversation, messages, exportedAt: new Date() }, null, 2));
    }

    // ── TXT export ──────────────────────────────────────────────────────────
    if (format === 'txt') {
      const lines = [
        `CONVERSATION TRANSCRIPT`,
        `${'─'.repeat(50)}`,
        `Business: ${client?.businessName || conversation.clientId}`,
        `Customer: ${conversation.customerName || 'Unknown'} (${conversation.phone})`,
        `Exported:  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        `${'─'.repeat(50)}`,
        '',
        ...messages.map(m => {
          const ts    = new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
          const from  = m.direction === 'outbound' ? (client?.businessName || 'Bot') : (conversation.customerName || conversation.phone);
          return `[${ts}] ${from}: ${m.content || m.text || '(media)'}`;
        }),
        '',
        `${'─'.repeat(50)}`,
        'Generated by TopEdge AI'
      ];
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}.txt"`);
      return res.send(lines.join('\n'));
    }

    // ── PDF export ──────────────────────────────────────────────────────────
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('TopEdge AI', 40, 40);
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('Conversation Transcript', 40, 65);
    doc.moveTo(40, 85).lineTo(555, 85).strokeColor('#E2E8F0').stroke();

    // Meta info
    doc.fillColor('#111').fontSize(10).font('Helvetica-Bold').text('Customer:', 40, 100, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${conversation.customerName || 'Unknown'} · ${conversation.phone}`, { continued: false });
    doc.font('Helvetica-Bold').fillColor('#111').text('Business:', 40, 118, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${client?.businessName || conversation.clientId}`);
    doc.font('Helvetica-Bold').fillColor('#111').text('Exported:', 40, 136, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    doc.moveTo(40, 160).lineTo(555, 160).strokeColor('#E2E8F0').stroke();

    // Messages
    let y = 175;
    const PAGE_BOTTOM = 730;

    for (const msg of messages) {
      const isOutbound = msg.direction === 'outbound';
      const content    = (msg.content || msg.text || '').substring(0, 500);
      if (!content) continue;

      const senderLabel = isOutbound
        ? (client?.businessName || 'Agent')
        : (conversation.customerName || conversation.phone);
      const ts = new Date(msg.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

      // Page break
      if (y > PAGE_BOTTOM) {
        doc.addPage();
        y = 40;
      }

      // Bubble color
      const bubbleColor = isOutbound ? '#EFF6FF' : '#F8FAFC';
      const borderColor = isOutbound ? '#BFDBFE' : '#E2E8F0';
      const textHeight  = Math.ceil(content.length / 80) * 14 + 30;

      doc.roundedRect(isOutbound ? 140 : 40, y, 375, textHeight, 6)
        .fillAndStroke(bubbleColor, borderColor);

      doc.fillColor('#64748B').fontSize(8)
        .text(`${senderLabel} · ${ts}`, isOutbound ? 145 : 45, y + 8);
      doc.fillColor('#111').fontSize(9.5).font('Helvetica')
        .text(content, isOutbound ? 145 : 45, y + 20, { width: 360, lineGap: 2 });

      y += textHeight + 8;
    }

    // Footer
    doc.moveTo(40, PAGE_BOTTOM + 10).lineTo(555, PAGE_BOTTOM + 10).strokeColor('#E2E8F0').stroke();
    doc.fontSize(8).fillColor('#AAA').text('Generated by TopEdge AI · Confidential', 40, PAGE_BOTTOM + 18, { align: 'center' });

    doc.end();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/conversations/smart-recovery/toggle — enable/disable AI recovery ─
router.post('/smart-recovery/toggle', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    client.smartCartRecovery = !client.smartCartRecovery;
    await client.save();
    res.json({ success: true, smartCartRecovery: client.smartCartRecovery });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/smart-recovery/preview — preview AI messages ──────
router.get('/smart-recovery/preview', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { leadId } = req.query;
    if (!leadId) return res.status(400).json({ success: false, message: 'leadId required' });

    const client = await Client.findOne({ clientId }).lean();
    const AdLead = require('../models/AdLead');
    const lead = await AdLead.findById(leadId).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    if (lead.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { generateSmartRecoveryMessage } = require('../utils/smartCartRecovery');
    const [step1, step2, step3] = await Promise.all([
      generateSmartRecoveryMessage(client, lead, 1),
      generateSmartRecoveryMessage(client, lead, 2),
      generateSmartRecoveryMessage(client, lead, 3)
    ]);

    res.json({ success: true, previews: { step1, step2, step3 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/conversations/bulk-export — Enqueue bulk PDF/JSON/CSV export ────
router.post('/bulk-export', protect, async (req, res) => {
  try {
    const { ids, format = 'pdf' } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ success: false, message: 'No conversations selected' });

    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    
    // Create Export Job
    const job = await ExportJob.create({
      clientId,
      userId: req.user._id,
      type: `conversations_${format}`,
      status: 'pending',
      totalItems: ids.length,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h expiration
    });

    res.json({ success: true, jobId: job._id });

    // ── BACKGROUND PROCESSING ──────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        job.status = 'processing';
        await job.save();

        const exportDir = path.join(__dirname, '../public/exports');
        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

        const filename = `bulk_export_${job._id}.${format}`;
        const filepath = path.join(exportDir, filename);
        
        if (format === 'pdf') {
          const PDFDocument = require('pdfkit');
          const doc = new PDFDocument({ margin: 40, size: 'A4' });
          const stream = fs.createWriteStream(filepath);

          // Register Fonts for Hindi/Gujarati support
          const fontDir = path.join(__dirname, '../utils/fonts');
          const hindiFont = path.join(fontDir, 'NotoSansDevanagari-Regular.ttf');
          const gujaratiFont = path.join(fontDir, 'NotoSansGujarati-Regular.ttf');
          const hasHindi = fs.existsSync(hindiFont);
          const hasGujarati = fs.existsSync(gujaratiFont);

          if (hasHindi) doc.registerFont('Hindi', hindiFont);
          if (hasGujarati) doc.registerFont('Gujarati', gujaratiFont);

          doc.pipe(stream);

          for (let i = 0; i < ids.length; i++) {
            const convoId = ids[i];
            const conversation = await Conversation.findById(convoId).lean();
            if (!conversation) continue;

            const messages = await Message.find({ conversationId: convoId }).sort({ createdAt: 1 }).lean();
            const client = await Client.findOne({ clientId: conversation.clientId }).lean();

            if (i > 0) doc.addPage();

            // Header for each conversation
            doc.fontSize(16).fillColor('#111').text(`Conversation: ${conversation.customerName || conversation.phone}`, { align: 'center' });
            doc.fontSize(10).fillColor('#666').text(`Business: ${client?.businessName || conversation.clientId}`, { align: 'center' });
            doc.moveTo(40, 80).lineTo(555, 80).strokeColor('#EEE').stroke();

            let y = 100;
            for (const m of messages) {
                if (y > 700) { doc.addPage(); y = 40; }
                const isOutbound = m.direction === 'outbound';
                const ts = new Date(m.createdAt).toLocaleTimeString();
                
                // Select font based on script detection (simple regex)
                const content = m.content || '';
                let activeFont = 'Helvetica'; // Fallback
                if (/[\u0900-\u097F]/.test(content) && hasHindi) activeFont = 'Hindi';
                else if (/[\u0A80-\u0AFF]/.test(content) && hasGujarati) activeFont = 'Gujarati';

                doc.fontSize(8).fillColor(isOutbound ? '#4F46E5' : '#10B981').text(`[${ts}] ${isOutbound ? 'Bot' : 'Customer'}:`, 40, y);
                doc.font(activeFont).fontSize(9).fillColor('#333').text(content || '(Media)', 110, y, { width: 440 });
                // Reset font for next parts
                doc.font('Helvetica');
                y += Math.ceil((content || '').length / 90) * 12 + 15;
            }
            
            job.processedItems = i + 1;
            job.progress = Math.round(((i + 1) / ids.length) * 100);
            await job.save();
          }
          doc.end();
          
          await new Promise((resolve) => stream.on('finish', resolve));
        } else if (format === 'json') {
          const data = [];
          for (let i = 0; i < ids.length; i++) {
             const convo = await Conversation.findById(ids[i]).lean();
             const msgs  = await Message.find({ conversationId: ids[i] }).lean();
             data.push({ conversation: convo, messages: msgs });
             job.progress = Math.round(((i + 1) / ids.length) * 100);
             await job.save();
          }
          fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        }

        job.status = 'completed';
        job.fileUrl = `/public/exports/${filename}`;
        job.fileName = filename;
        await job.save();
      } catch (err) {
        console.error(`Export Job ${job._id} Failed:`, err);
        job.status = 'failed';
        job.error = err.message;
        await job.save();
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/export-jobs/:id — Check status and polling ────────
router.get('/export-jobs/:id', protect, async (req, res) => {
  try {
    const job = await ExportJob.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (req.user.role === 'SUPER_ADMIN') {
      return res.json({ success: true, job });
    }
    const tenantId = tenantClientId(req);
    if (!tenantId || job.clientId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/:id/smart-replies — AI Contextual Suggestions ──
router.get('/:id/smart-replies', protect, async (req, res) => {
  try {
    const convoId = req.params.id;
    const conversation = await Conversation.findById(convoId);
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

    // Validate access
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (conversation.clientId !== clientId) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Fetch last 10 messages for context
    const messages = await Message.find({ conversationId: convoId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    
    if (messages.length === 0) {
      return res.json({ success: true, replies: ['Hello! How can I help you today?', 'Hi there!', 'Welcome!'] });
    }

    const contextArr = messages.reverse().map(m => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.content || '(Media)'}`);
    const contextStr = contextArr.join('\n');

    const prompt = `
    You are an AI assistant helping a human customer support agent for "${client.businessName || 'our business'}".
    Below is the recent chat history with the customer (Customer Phone: ${conversation.phone}).
    
    Chat History:
    ${contextStr}

    Based on the context, suggest exactly 3 short, distinct, direct replies the human agent could send RIGHT NOW. 
    They should be conversational, helpful, and under 15 words each.
    Format your response STRICTLY as a JSON array of 3 strings. Example: ["Yes, we have it.", "I will check for you.", "Please provide your order number."]
    Do not include any markdown, backticks, or explanation. Just the raw JSON array.
    `;

    const { generateText } = require('../utils/gemini');
    const aiResponseRaw = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    
    let replies = [];
    if (aiResponseRaw) {
       try {
         const cleaned = aiResponseRaw.replace(/```json/g, '').replace(/```/g, '').trim();
         replies = JSON.parse(cleaned);
       } catch (parseErr) {
         console.error('Smart reply parse error:', parseErr.message, 'Raw:', aiResponseRaw);
       }
    }

    // Fallbacks if AI fails or returns malformed
    if (!Array.isArray(replies) || replies.length < 3) {
       replies = [
         "Let me check that for you.",
         "Could you provide more details?",
         "I understand, give me a moment."
       ];
    }

    res.json({ success: true, replies: replies.slice(0, 3) });
  } catch (err) {
    console.error('SmartReplies Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   POST /api/conversations/:id/ghost-complete
// @desc    Live Copilot Autocomplete for Agent Typings
// @access  Private
router.post('/:id/ghost-complete', protect, async (req, res) => {
  try {
    const convoId = req.params.id;
    const { currentInput } = req.body;
    
    if (!currentInput || currentInput.length < 3) {
      return res.json({ success: true, completion: '' });
    }

    const conversation = await Conversation.findById(convoId);
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    
    // Fetch last 5 messages for context
    const messages = await Message.find({ conversationId: convoId })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
      
    const contextStr = messages.reverse().map(m => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.content || '(Media)'}`).join('\n');

    const prompt = `
    You are an AI Copilot assisting a customer support agent for "${client?.businessName || 'a business'}".
    Here is the recent chat history:
    ${contextStr}

    The agent is currently typing: "${currentInput}"

    Your task: Autocomplete the agent's message.
    CRITICAL RULE: Output ONLY the EXACT text that should FOLLOW the agent's current input. 
    Do NOT repeat what the agent has already typed.
    Do NOT include quotes.
    Keep the completion under 20 words.
    `;

    const { generateText } = require('../utils/gemini');
    let aiResponseRaw = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY, { temperature: 0.1, maxTokens: 40 });
    
    if (aiResponseRaw) {
      // Clean up common AI prefixes that ignore instructions
      const cleaned = aiResponseRaw.replace(/^["']/, '').replace(/["']$/, '').trim();
      return res.json({ success: true, completion: cleaned });
    }
    
    return res.json({ success: true, completion: '' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// GAP 4: Context endpoint to fetch Active Sequences and Campaigns
router.get('/:clientId/:phone/context', protect, logPersonalDataAccess, async (req, res) => {
    try {
        const { clientId, phone } = req.params;
        const FollowUpSequence = require('../models/FollowUpSequence');
        const CampaignMessage = require('../models/CampaignMessage');
        const AdLead = require('../models/AdLead');

        const tenantId = tenantClientId(req);
        if (!tenantId || tenantId !== clientId) {
           return res.status(403).json({ success: false, message: 'Unauthorized client access' });
        }

        const lead = await AdLead.findOne({ clientId, phoneNumber: phone });
        
        // Fetch specific active sequences
        const activeSequences = await FollowUpSequence.find({ 
            clientId, 
            phone, 
            status: { $in: ["active", "pending"] } 
        });
        
        // Fetch recent outbound campaigns sent to lead
        const recentCampaigns = await CampaignMessage.find({ 
            clientId, 
            phone 
        }).sort({ sentAt: -1 }).limit(5);

        res.json({
            success: true,
            lead,
            activeSequences: activeSequences.map(seq => ({
                id: seq._id,
                name: seq.name,
                status: seq.status,
                progress: `${seq.steps.filter(s => s.status === 'sent').length}/${seq.steps.length}`,
                nextSendAt: seq.steps.find(s => s.status === 'pending')?.sendAt
            })),
            recentCampaigns: recentCampaigns.map(camp => ({
                id: camp._id,
                name: camp.campaignName || "Broadcast",
                status: camp.status,
                sentAt: camp.sentAt
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/resolve', protect, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

        const conversation = await Conversation.findOne(query);
        if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

        conversation.status = 'BOT_ACTIVE';
        conversation.requiresAttention = false;
        conversation.botStatus = 'active';
        conversation.botPaused = false;
        conversation.isBotPaused = false;
        conversation.resolvedAt = new Date();

        await conversation.save();

        try {
            const ConversationNote = require('../models/ConversationNote');
            await ConversationNote.create({
                conversationId: conversation._id,
                clientId: conversation.clientId,
                content: `Ticket marked as RESOLVED by ${req.user.name || 'Agent'}. Bot is active for new messages.`,
                authorId: req.user._id,
                authorName: 'System',
                createdAt: new Date()
            });
        } catch (noteErr) {
            console.error('[POST resolve] Note create failed:', noteErr.message);
        }

        try {
            const AdLead = require('../models/AdLead');
            await AdLead.findOneAndUpdate(
                { phoneNumber: conversation.phone, clientId: conversation.clientId },
                { $set: { pendingSupport: false } }
            );
        } catch (err) {}

        const io = req.app.get('socketio');
        if (io) {
            const payload = conversation.toObject ? conversation.toObject() : conversation;
            io.to(`client_${conversation.clientId}`).emit('conversation_update', payload);
            io.to(`client_${conversation.clientId}`).emit('conversationUpdated', {
                conversationId: conversation._id,
                status: conversation.status,
                requiresAttention: conversation.requiresAttention,
                botStatus: conversation.botStatus
            });
            io.to(`client_${conversation.clientId}`).emit('botStatusChanged', {
                conversationId: String(conversation._id),
                botStatus: conversation.botStatus
            });
        }

        res.json({ success: true, conversation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/clear-intent', protect, async (req, res) => {
    try {
        const conversation = await Conversation.findByIdAndUpdate(
            req.params.id,
            { $set: { "lastDetectedIntent.intentName": null, "lastDetectedIntent.confidenceScore": 0, "lastDetectedIntent.detectedAt": null } },
            { new: true }
        );
        res.json({ success: true, lastDetectedIntent: conversation.lastDetectedIntent });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

