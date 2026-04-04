const express = require('express');
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

    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const activeClientId = req.user.role === 'SUPER_ADMIN' && clientId ? clientId : req.user.clientId;

    if (req.user.role !== 'SUPER_ADMIN' || (req.user.role === 'SUPER_ADMIN' && clientId)) {
      if (['delitech_smarthomes', 'code_clinic_v1'].includes(activeClientId)) {
        query.clientId = { $in: ['code_clinic_v1', 'delitech_smarthomes'] };
      } else {
        query.clientId = activeClientId;
      }
    }
    // If SUPER_ADMIN but no clientId provided, they see everything or we could default.
    // Let's default to everything for SUPER_ADMIN if no clientId is passed.

    if (days) {
      const date = new Date();
      date.setDate(date.getDate() - parseInt(days));
      query.lastMessageAt = { $gte: date };
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
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
        conversationId: conversation._id, // CRITICAL FIX
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
        conversationId: conversation._id, // CRITICAL FIX
        phone: conversation.phone,
        direction: 'outbound',
        type: 'text',
        body: content
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
    conversation.requiresAttention = false; // Reset attention flag on manual takeover
    if (conversation.attentionReason) conversation.attentionReason = '';
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
      { $set: { botPaused: paused } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('support_update', conversation);
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PATCH /api/conversations/:id/assign
// @desc    Assign conversation to an agent
// @access  Private
router.patch('/:id/assign', protect, async (req, res) => {
  try {
    const { agentId, agentName } = req.body;
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const update = agentId
      ? { $set: { assignedTo: agentId, assignedAt: new Date(), assignedBy: agentName || req.user.name } }
      : { $unset: { assignedTo: 1, assignedAt: 1, assignedBy: 1 } };

    const conversation = await Conversation.findOneAndUpdate(query, update, { new: true }).populate('assignedTo', 'name email');
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const io = req.app.get('socketio');
    if (io) io.to(`client_${conversation.clientId}`).emit('conversation_assigned', { conversationId: conversation._id, agentId, agentName });

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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

    const note = {
      content: content.trim(),
      authorId: req.user._id,
      authorName: req.user.name || req.user.email,
      createdAt: new Date()
    };

    const conversation = await Conversation.findOneAndUpdate(
      query,
      { $push: { internalNotes: note } },
      { new: true }
    );
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const io = req.app.get('socketio');
    if (io) io.to(`client_${conversation.clientId}`).emit('internal_note_added', { conversationId: conversation._id, note });

    res.json({ success: true, note, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

    const aiResponse = await generateText(prompt);
    
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

    conversation.status = 'CLOSED';
    conversation.resolvedAt = new Date();
    conversation.requiresAttention = false;
    await conversation.save();

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
router.get('/:id/export', protect, async (req, res) => {
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
    const clientId = req.user.role === 'SUPER_ADMIN' ? req.body.clientId : req.user.clientId;
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
    const clientId = req.user.clientId;
    const { leadId } = req.query;
    if (!leadId) return res.status(400).json({ success: false, message: 'leadId required' });

    const client = await Client.findOne({ clientId }).lean();
    const AdLead = require('../models/AdLead');
    const lead = await AdLead.findById(leadId).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

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

    const clientId = req.user.role === 'SUPER_ADMIN' ? req.body.clientId : req.user.clientId;
    
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
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;


