const express = require('express');
const router = express.Router();
const SupportChat = require('../models/SupportChat');
const Notification = require('../models/Notification');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { generateText } = require('../utils/gemini');
const { sendEmail } = require('../utils/emailService');

const { buildDocsContextForPrompt, appendDocLinks } = require('../constants/docsKnowledgeBase');

const SUPPORT_PROMPT = `
You are Oli — TopEdge AI success coach for Indian ecommerce teams using our WhatsApp automation dashboard.

TONE:
- Warm, human, confident. Like a helpful colleague—not a manual.
- Be concise but always finish what you start—never stop mid-sentence or after "1." without the steps.
- Use plain language. No jargon unless the user used it first.

STRUCTURE (when explaining how-to):
1. One-line answer to what they asked.
2. Numbered steps (2–5 complete steps) with exact UI paths (e.g. Settings → Integrations).
3. Optional: "📖 Title: /docs/..." on its own last line when a doc page fits.

PRODUCT MAP:
- Dashboard (/): metrics and onboarding checklist.
- Live Chat (/conversations): inbox, human takeover, release bot.
- Flow Builder (/flow-builder): visual WhatsApp automations.
- Meta Manager (/meta-manager): templates, AI drafts, catalogue, Meta flows.
- Order messages (/shopify-automation-center): COD, cart recovery, shipped—needs Shopify + approved templates.
- Campaigns (/marketing-hub): broadcasts to segments.
- Settings (/settings): Integrations (WhatsApp, Shopify), Features toggles, brand, team.
- Plans & billing (/billing): trial and plan tiers.

DOCUMENTATION INDEX (link when relevant—path only, no domain):
${buildDocsContextForPrompt()}

COMMON FIXES:
- Shopify token expired → Settings → Integrations → reconnect Shopify.
- Template rejected → Meta Manager; fix category/copy; sync again.
- Bot silent → Live Chat: check human takeover; release to bot.
- Automation not sending → approved template + Shopify connected + feature ON in Settings → Features.

RULES:
- Never invent features. If unsure, say what to check and link /docs/troubleshooting.
- After 2 failed attempts, offer human: "Want me to connect you with our team?"
- Do not use markdown headers or bold—plain text only for chat.
`;

function looksIncompleteSupportReply(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 12) return true;
  if (/:\s*1\.\s*$/.test(t)) return true;
  if (/here(?:'s| is) how[^.]*:\s*1\.\s*$/i.test(t)) return true;
  if (/(?:^|\n)\d+\.\s*$/.test(t)) return true;
  return false;
}

function formatSupportReply(raw) {
  const fallback = 'I can help with that.\nPlease share one more detail so I can guide you correctly.';
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return fallback;

  const MAX_BODY_CHARS = 1400;
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  let lines = normalized.split('\n').map((p) => p.trim()).filter(Boolean);

  const docLines = lines.filter((l) => /\/docs[\w\-/#?=.]*/.test(l) || l.startsWith('📖'));
  let bodyLines = lines.filter((l) => !/\/docs[\w\-/#?=.]*/.test(l) && !l.startsWith('📖'));

  // Single long paragraph → split numbered steps so nothing is dropped mid-list
  if (bodyLines.length === 1 && /\d+\.\s/.test(bodyLines[0])) {
    const split = bodyLines[0]
      .split(/(?:(?<=\S)\s+)(?=\d+\.\s)/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (split.length > 1) bodyLines = split;
  }

  let body = bodyLines.join('\n');
  if (body.length > MAX_BODY_CHARS) {
    const cut = body.slice(0, MAX_BODY_CHARS);
    const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
    body = (lastBreak > 200 ? cut.slice(0, lastBreak) : cut).trimEnd() + '…';
  }

  const footer = docLines.slice(0, 2).join('\n');
  const out = footer ? `${body}\n\n${footer}` : body;
  return out || fallback;
}

// Get current support chat for a client
router.get('/', protect, async (req, res) => {
  try {
    // Find the most recent non-resolved chat
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } }).sort({ createdAt: -1 });
    if (!chat) {
      chat = await SupportChat.create({
        clientId: req.user.clientId,
        clientName: req.user.name || 'User',
        requesterUserId: String(req.user._id || ''),
        requesterEmail: req.user.email || '',
        requesterName: req.user.name || 'User',
        messages: [{ sender: 'ai', text: 'Hello! I am your TopEdge AI Success Expert. How can I help you grow your store today?' }]
      });
    } else {
      // Keep requester identity fresh if user profile changed
      chat.requesterUserId = chat.requesterUserId || String(req.user._id || '');
      chat.requesterEmail = chat.requesterEmail || req.user.email || '';
      chat.requesterName = chat.requesterName || req.user.name || 'User';
      await chat.save();
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
      requesterUserId: String(req.user._id || ''),
      requesterEmail: req.user.email || '',
      requesterName: req.user.name || 'User',
      messages: [{ sender: 'ai', text: 'New session started. How can I assist you further?' }]
    });
    
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${req.user.clientId}`).emit('support_update', chat);
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

// Mark support chat as read by admin (clears admin unread badge)
router.post('/:id/read_admin', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });
    chat.hasUnreadAdmin = false;
    await chat.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Send message to Support AI
router.post('/message', protect, async (req, res) => {
  try {
    const { text, imageUrl, mimeType, requesterEmail } = req.body;
    let chat = await SupportChat.findOne({ clientId: req.user.clientId, status: { $ne: 'resolved' } }).sort({ createdAt: -1 });
    
    if (!chat) return res.status(404).json({ message: 'No active support chat' });
    chat.requesterUserId = chat.requesterUserId || String(req.user._id || '');
    chat.requesterEmail = chat.requesterEmail || req.user.email || String(requesterEmail || '').trim();
    chat.requesterName = chat.requesterName || req.user.name || 'User';

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
      
      const genOpts = { isPlatform: true, maxTokens: 768, temperature: 0.55 };
      let aiResponse = await generateText(prompt, null, genOpts);
      if (looksIncompleteSupportReply(aiResponse)) {
        const retryPrompt = `${prompt}\n\nYour previous reply was cut off before finishing the steps. Reply again with the FULL answer — complete every numbered step.`;
        const retry = await generateText(retryPrompt, null, genOpts);
        if (retry && !looksIncompleteSupportReply(retry)) aiResponse = retry;
      }
      const replyText = appendDocLinks(formatSupportReply(aiResponse), userText);
      chat.messages.push({ sender: 'ai', text: replyText });
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
    const { text, sendEmailCopy = true, emailSubject } = req.body;
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    const replyMessage = {
      sender: 'admin',
      text,
      delivery: {
        channel: sendEmailCopy ? 'chat+email' : 'chat',
        status: sendEmailCopy ? 'pending' : 'skipped',
        deliveryAt: null,
        messageId: '',
        error: ''
      }
    };
    chat.messages.push(replyMessage);
    chat.hasUnreadUser = true;
    chat.hasUnreadAdmin = false; // Admin just replied
    chat.status = 'human_takeover'; 
    chat.lastMessageAt = Date.now();

    let emailDelivery = { attempted: false, sent: false, reason: 'disabled' };
    if (sendEmailCopy) {
      emailDelivery = { attempted: true, sent: false, reason: '' };
      try {
        if (!chat.requesterEmail) {
          emailDelivery.reason = 'missing_requester_email';
          const last = chat.messages[chat.messages.length - 1];
          if (last?.delivery) {
            last.delivery.status = 'failed';
            last.delivery.error = 'No requester email found';
          }
        } else {
          const client = await Client.findOne({ clientId: chat.clientId });
          if (!client) {
            emailDelivery.reason = 'client_not_found';
            const last = chat.messages[chat.messages.length - 1];
            if (last?.delivery) {
              last.delivery.status = 'failed';
              last.delivery.error = 'Client config not found for email';
            }
          } else {
            const subject = String(emailSubject || `Support Reply · ${chat.clientName || chat.clientId}`);
            const html = `
              <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
                <p>Hello${chat.requesterName ? ` ${chat.requesterName}` : ''},</p>
                <p>Our support team replied to your request:</p>
                <div style="padding:12px 14px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:10px;white-space:pre-wrap">${String(text || '')}</div>
                <p style="margin-top:14px;color:#475569">You can also continue this conversation directly inside your TopEdge AI dashboard support chat.</p>
                <p>Best,<br/>TopEdge Support</p>
              </div>
            `;
            const ok = await sendEmail(client, {
              to: chat.requesterEmail,
              subject,
              html
            });
            const last = chat.messages[chat.messages.length - 1];
            if (last?.delivery) {
              last.delivery.status = ok ? 'sent' : 'failed';
              last.delivery.deliveryAt = new Date();
              last.delivery.messageId = ok ? `support_${Date.now()}` : '';
              last.delivery.error = ok ? '' : 'Email provider send returned false';
            }
            emailDelivery.sent = !!ok;
            emailDelivery.reason = ok ? '' : 'provider_send_failed';
          }
        }
      } catch (emailErr) {
        emailDelivery.reason = emailErr.message || 'email_exception';
        const last = chat.messages[chat.messages.length - 1];
        if (last?.delivery) {
          last.delivery.status = 'failed';
          last.delivery.error = emailDelivery.reason;
        }
      }
    }
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${chat.clientId}`).emit('support_update', chat);
    }

    res.json({ ...chat.toObject(), emailDelivery });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Take over conversation (human control, AI paused)
router.post('/:id/takeover', protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    const note = String(req.body?.message || '').trim();
    chat.status = 'human_takeover';
    chat.messages.push({
      sender: 'ai',
      text: note || 'A human support specialist has joined this conversation. They will assist you shortly.',
    });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadUser = true;
    chat.hasUnreadAdmin = false;
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${chat.clientId}`).emit('support_update', chat);
      io.to('super_admin_room').emit('support_update', chat);
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

    const customMessage = String(req.body?.message || '').trim();
    const releaseNote = String(req.body?.internalNote || '').trim();

    chat.status = 'active';
    chat.messages.push({
      sender: 'ai',
      text:
        customMessage ||
        'Thanks for chatting with our team. I\'m back online — ask me anything about your dashboard.',
    });
    chat.lastMessageAt = Date.now();
    chat.hasUnreadUser = true;
    chat.hasUnreadAdmin = false;
    if (releaseNote) {
      if (!Array.isArray(chat.adminNotes)) chat.adminNotes = [];
      chat.adminNotes.push({ text: releaseNote, createdAt: new Date() });
    }
    await chat.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${chat.clientId}`).emit('support_update', chat);
      io.to('super_admin_room').emit('support_update', chat);
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

const {
  pickWebsiteWidgetForPublic,
  mergeWebsiteWidgetConfig,
} = require('../utils/websiteWidgetDefaults');

function resolveClientBranding(client) {
  const pv = client.platformVars || {};
  const name =
    client.brand?.businessName ||
    pv.brandName ||
    client.businessName ||
    client.name ||
    'Support';
  const agent = client.ai?.persona?.name || client.botName || 'Support team';
  const wa = String(
    pv.supportWhatsapp ||
      pv.supportPhone ||
      client.adminPhone ||
      client.brand?.adminPhone ||
      ''
  ).replace(/\D/g, '');
  const widgetCfg = mergeWebsiteWidgetConfig(client.websiteChatWidgetConfig);
  return {
    businessName: widgetCfg.headerTitle || name,
    avatarLetter: String(widgetCfg.headerTitle || name).charAt(0).toUpperCase(),
    agentName: agent,
    supportWhatsApp: wa,
    greeting: widgetCfg.greeting || `Hi — you've reached ${name}. How can we help?`,
    supportHint:
      widgetCfg.headerSubtitle || 'We read every message and reply as soon as we can.',
    logoUrl: widgetCfg.logoUrl || client.businessLogo || '',
  };
}

function resolveWebsiteFlow(client) {
  const cfg = mergeWebsiteWidgetConfig(client.websiteChatWidgetConfig);
  const flows = client.visualFlows || [];
  let flow = null;
  if (cfg.flowId) {
    flow = flows.find((f) => String(f.id) === String(cfg.flowId));
  }
  if (!flow) {
    flow = flows.find((f) => f.platform === 'website' && f.isActive);
  }
  if (!flow && cfg.experience === 'guided') {
    flow = flows.find((f) => f.isActive);
  }
  if (!flow) return null;
  const nodes =
    (flow.publishedNodes && flow.publishedNodes.length ? flow.publishedNodes : flow.nodes) || [];
  const edges =
    (flow.publishedEdges && flow.publishedEdges.length ? flow.publishedEdges : flow.edges) || [];
  return {
    id: flow.id,
    name: flow.name,
    platform: flow.platform,
    nodes,
    edges,
    isActive: !!flow.isActive,
  };
}

// ── PUBLIC: Widget config (no auth required) ──────────────────────────────
// @route   GET /api/support-chat/config/:clientId
// @desc    Returns public branding info for the chat widget
// @access  Public
router.get('/config/:clientId', async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId })
      .select(
        'businessName name adminPhone brand.businessName brand.adminPhone businessLogo botName platformVars websiteChatWidgetConfig ai.persona.name'
      )
      .lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });
    res.json(resolveClientBranding(client));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   GET /api/support-chat/widget-config/:clientId
// @desc    Merged branding + widget appearance for embed script / iframe
// @access  Public
router.get('/widget-config/:clientId', async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId })
      .select(
        'clientId businessName name adminPhone brand businessLogo botName platformVars websiteChatWidgetConfig visualFlows ai.persona.name'
      )
      .lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const branding = resolveClientBranding(client);
    const widget = pickWebsiteWidgetForPublic(client.websiteChatWidgetConfig);
    const activeFlow = resolveWebsiteFlow(client);

    res.json({
      clientId: client.clientId,
      branding,
      widget,
      hasPublishedFlow: !!(activeFlow && activeFlow.nodes?.length),
      activeFlowId: activeFlow?.id || null,
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
    const client = await Client.findOne({ clientId: req.params.clientId })
      .select('visualFlows websiteChatWidgetConfig businessName botName businessLogo ai.persona.name')
      .lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const flow = resolveWebsiteFlow(client);
    const widget = pickWebsiteWidgetForPublic(client.websiteChatWidgetConfig);
    const branding = resolveClientBranding(client);

    res.json({
      success: true,
      flow: flow
        ? {
            id: flow.id,
            name: flow.name,
            platform: flow.platform,
            nodes: flow.nodes,
            edges: flow.edges,
          }
        : null,
      branding: {
        botName: branding.agentName,
        businessName: branding.businessName,
        avatar: branding.logoUrl,
        themeColor: widget.theme,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

