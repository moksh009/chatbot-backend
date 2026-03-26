"use strict";

const axios        = require("axios");
const Conversation = require("../models/Conversation");
const AdLead       = require("../models/AdLead");
const Message      = require("../models/Message");
const DailyStat    = require("../models/DailyStat");
const emailService = require("./emailService");
const log = require("./logger")('DualBrain');
const { generateText, getGeminiModel } = require('./gemini');

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE — called by ALL niche engines
// Returns: true if message was handled
// ─────────────────────────────────────────────────────────────────────────────
async function runDualBrainEngine(parsedMessage, client) {
  const phone = parsedMessage.from;
  const io    = global.io;

  // STEP 1: Upsert conversation state
  let convo = await Conversation.findOneAndUpdate(
    { phone, clientId: client.clientId },
    {
      $setOnInsert: { phone, clientId: client.clientId, lastStepId: null, botPaused: false, status: 'BOT_ACTIVE' },
      $inc: { unreadCount: 1 },
      $set: { lastInteraction: new Date() }
    },
    { upsert: true, new: true }
  );

  // STEP 2: Upsert lead
  let lead = await AdLead.findOneAndUpdate(
    { phoneNumber: phone, clientId: client.clientId },
    { $setOnInsert: { phoneNumber: phone, clientId: client.clientId } },
    { upsert: true, new: true }
  );

  // STEP 3: Save inbound message to DB + emit to dashboard
  await saveInboundMessage(phone, client.clientId, parsedMessage, io);

  // STEP 4: Human Takeover — bot is paused
  if (convo.botPaused || convo.status === 'HUMAN_TAKEOVER') {
    if (io) io.to(`client_${client.clientId}`).emit('new_message', {
      phone, direction: 'inbound',
      content: parsedMessage.text?.body || '[non-text]',
      timestamp: new Date(), botPaused: true
    });
    return true;
  }

  // STEP 4B: Handle voice notes — transcribe → re-process as text
  if (parsedMessage.type === 'audio') {
    const transcription = await transcribeVoiceNote(parsedMessage, client);
    if (transcription) {
      parsedMessage = { ...parsedMessage, type: 'text', text: { body: transcription }, _transcribedFrom: 'audio' };
    } else {
      await sendWhatsAppText(client, phone, "Sorry, I couldn't understand the voice note. Please type your message. 🙏");
      return true;
    }
  }

  // STEP 5: PRIORITY 1 — Graph Traversal
  const graphHandled = await tryGraphTraversal(parsedMessage, client, convo, lead, phone, io);
  if (graphHandled) return true;

  // STEP 6: PRIORITY 2 — Keyword Fallback
  const keywordHandled = await tryKeywordFallback(parsedMessage, client, convo, phone);
  if (keywordHandled) return true;

  // STEP 7: PRIORITY 3 — Gemini AI Fallback
  // Only use AI if there is text body. Otherwise, let the caller handle it.
  if (parsedMessage.text?.body) {
    await runAIFallback(parsedMessage, client, phone, lead);
    return true;
  }
  
  // Return false so the engine can process legacy interactive IDs
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 1: GRAPH TRAVERSAL
// ─────────────────────────────────────────────────────────────────────────────
async function tryGraphTraversal(parsedMessage, client, convo, lead, phone, io) {
  const flowNodes = client.flowNodes || [];
  const flowEdges = client.flowEdges || [];

  if (!flowNodes.length) return false;

  const currentStepId   = convo.lastStepId;
  const incomingTrigger = extractTrigger(parsedMessage);
  const userText        = (parsedMessage.text?.body || '').toLowerCase().trim();

  // A) GLOBAL KEYWORD / ROLE JUMP
  // Check if user is trying to jump to a specific topic (e.g. "Pricing", "Products")
  const jumpNode = flowNodes.find(n => {
    const role = (n.data?.role || '').toLowerCase();
    const keywords = (n.data?.keywords || '').toLowerCase().split(',').map(k => k.trim());
    const isExactRole = role && userText === role;
    const isKeywordMatch = keywords.length > 0 && keywords.includes(userText);
    return isExactRole || isKeywordMatch;
  });

  if (jumpNode) {
    console.log(`[DualBrain] Graph: Jumping to node ${jumpNode.id} based on keyword/role match "${userText}"`);
    return await executeNode(jumpNode.id, flowNodes, flowEdges, client, convo, lead, phone, io);
  }

  // B) No currentStepId (or it looks like a phone number) — guard + find trigger/start node
  const looksLikePhone = currentStepId && /^\d{7,}$/.test(String(currentStepId));
  if (!currentStepId || looksLikePhone) {
    if (looksLikePhone) {
      console.warn(`[DualBrain] Graph: lastStepId "${currentStepId}" looks like a phone number — resetting`);
      await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
    }
    // Try keyword greeting trigger first
    const triggerNode = flowNodes.find(n =>
      n.type === 'trigger' || n.type === 'TriggerNode'
    );
    const startNode = triggerNode ||
      flowNodes.find(n => n.data?.role === 'welcome') ||
      flowNodes.find(n => n.data?.isStartNode === true) ||
      flowNodes[0];
    if (startNode) {
      console.log(`[DualBrain] Graph: Starting fresh from node ${startNode.id}`);
      return await executeNode(startNode.id, flowNodes, flowEdges, client, convo, lead, phone, io);
    }
    return false;
  }

  // C) User is in the middle of a flow — find matching edge from currentStep
  const matchingEdge = flowEdges.find(e => {
    if (e.source !== currentStepId) return false;

    // No trigger = auto edge
    if (!e.trigger && !e.sourceHandle) return true;

    // Match by sourceHandle (button id from React Flow)
    if (e.sourceHandle) {
      const sid = e.sourceHandle.toLowerCase();
      const bid = (incomingTrigger.buttonId || '').toLowerCase();
      const txt = userText;
      return sid === bid || sid === txt || txt.includes(sid);
    }

    // Match by trigger object (legacy edge format)
    if (e.trigger?.type === 'button') {
      return (incomingTrigger.buttonId || '').toLowerCase() === e.trigger.value.toLowerCase();
    }
    if (e.trigger?.type === 'keyword') {
      return userText.includes(e.trigger.value.toLowerCase());
    }
    if (e.trigger?.type === 'auto') return true;

    return false;
  });

  if (!matchingEdge) {
    // Fallback: Check if the user's text matches a button title in the current node
    const currentNode = flowNodes.find(n => n.id === currentStepId);
    if (currentNode?.type === 'interactive') {
      const btns = currentNode.data?.buttonsList || [];
      const matchedBtn = btns.find(b => b.title?.toLowerCase() === userText);
      if (matchedBtn) {
        const handleEdge = flowEdges.find(e =>
          e.source === currentStepId &&
          (e.sourceHandle === matchedBtn.id || e.sourceHandle === matchedBtn.title?.toLowerCase().replace(/\s+/g, '_'))
        );
        if (handleEdge) {
          console.log(`[DualBrain] Graph: button title match "${userText}" → node ${handleEdge.target}`);
          return await executeNode(handleEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io);
        }
      }
    }
    console.log(`[DualBrain] Graph: no matching edge from ${currentStepId} for "${userText || incomingTrigger.buttonId}"`);
    return false;
  }

  console.log(`[DualBrain] Graph: edge match from ${currentStepId} → ${matchingEdge.target}`);
  return await executeNode(matchingEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE A SPECIFIC NODE
// ─────────────────────────────────────────────────────────────────────────────
async function executeNode(nodeId, flowNodes, flowEdges, client, convo, lead, phone, io) {
  const node = flowNodes.find(n => n.id === nodeId);
  if (!node) { console.warn(`[DualBrain] Node ${nodeId} not found`); return false; }

  const sent = await sendNodeContent(node, client, phone, lead, convo);
  if (!sent) return false;

  const action = node.data?.action;

  // Update lastStepId logic
  if (action === "AI_FALLBACK") {
    // Don't update lastStepId — let AI handle and return here next time
    await Conversation.findByIdAndUpdate(convo._id, { 
      lastStepId: convo.lastStepId,
      lastInteraction: new Date()
    });
  } else {
    // Normal: update lastStepId to this node
    await Conversation.findByIdAndUpdate(convo._id, {
      lastStepId: nodeId,
      lastInteraction: new Date()
    });
  }

  // Emit to dashboard
  if (io) io.to(`client_${client.clientId}`).emit('new_message', {
    phone, direction: 'outbound',
    content: node.data?.text || node.data?.body || '[bot message]',
    timestamp: new Date(), nodeId, nodeType: node.type
  });

  // Auto-forward if there is exactly one outgoing edge with no trigger (auto-edge)
  const autoEdge = flowEdges.find(e => e.source === nodeId && (!e.trigger || e.trigger?.type === 'auto') && !e.sourceHandle);
  if (autoEdge) {
    setTimeout(async () => {
      const freshConvo = await Conversation.findById(convo._id);
      await executeNode(autoEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, io);
    }, 800);
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND NODE CONTENT — handles all node types
// ─────────────────────────────────────────────────────────────────────────────
async function sendNodeContent(node, client, phone, lead = null, convo = null) {
  const { type, data } = node;

  switch (type) {
    case 'image': {
      const imageUrl = data.imageUrl || '';
      const caption = data.caption || '';
      if (!imageUrl) return true;
      await sendWhatsAppImage(client, phone, imageUrl, caption);
      return true;
    }

    case 'flow':
    case 'FlowNode': {
      await sendWhatsAppFlow(client, phone, data.header, data.body || data.text, data.flowId, data.flowCta, data.screen);
      return true;
    }
    case 'message':
    case 'MessageNode': {
      if (data.imageUrl) {
        await sendWhatsAppImage(client, phone, data.imageUrl, data.text || data.body || '');
      } else {
        await sendWhatsAppText(client, phone, data.text || data.body || data.title || '');
      }
      return true;
    }

    case 'interactive':
    case 'InteractiveNode': {
      if (data.actionType === 'url') {
        // CTA URL interactive
        const interactive = {
          type: 'cta_url',
          action: {
            name: 'cta_url',
            parameters: {
              display_text: (data.btnUrlTitle || 'Visit Website').substring(0, 20),
              url: data.btnUrlLink || 'https://google.com'
            }
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await sendWhatsAppInteractive(client, phone, interactive, data.text || data.body || '');
        return true;
      }

      // Standard reply buttons
      const buttonsList = Array.isArray(data.buttonsList) && data.buttonsList.length > 0
        ? data.buttonsList
        : (data.buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

      if (!buttonsList.length) {
        await sendWhatsAppText(client, phone, data.text || data.body || '');
        return true;
      }

      // Standard reply buttons or List
      if (data.interactiveType === 'list') {
        const interactive = {
          type: 'list',
          action: {
            button: 'Select Option',
            sections: [
              {
                title: 'Choose one:',
                rows: buttonsList.slice(0, 10).map(btn => ({
                  id: (btn.id || btn.title || 'opt').toLowerCase().replace(/\s+/g, '_'),
                  title: (btn.title || 'Option').substring(0, 24),
                  description: ''
                }))
              }
            ]
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        if (data.footer) interactive.footer = { text: data.footer.substring(0, 60) };

        await sendWhatsAppInteractive(client, phone, interactive, data.text || data.body || 'Select an option:');
        return true;
      }

      const interactive = {
        type: 'button',
        action: {
          buttons: buttonsList.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: { id: (btn.id || btn.title || 'btn').toLowerCase().replace(/\s+/g, '_'), title: (btn.title || 'Option').substring(0, 20) }
          }))
        }
      };
      if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
      else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
      if (data.footer) interactive.footer = { text: data.footer.substring(0, 60) };

      await sendWhatsAppInteractive(client, phone, interactive, data.text || data.body || 'Choose an option:');
      return true;
    }

    case 'template':
    case 'TemplateNode': {
      const templateName = data.templateName || data.metaTemplateName;
      if (!templateName) return false;

      let headerImageUrl = data.headerImageUrl;
      const tplDef = (client.syncedMetaTemplates || client.waTemplates || []).find(t => t.name === templateName);
      if (tplDef) {
        const needsImage = tplDef.components?.some(c => c.type === 'HEADER' && c.format === 'IMAGE');
        if (needsImage && !headerImageUrl) {
          headerImageUrl = 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&q=80&w=1000';
        }
      }

      const components = [];
      if (headerImageUrl) {
        components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
      }
      if (data.variables) {
        const params = data.variables.split(',').map(v => v.trim()).filter(Boolean);
        if (params.length) {
          components.push({ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) });
        }
      }

      await sendWhatsAppTemplate(client, phone, templateName, data.languageCode || 'en', components);
      return true;
    }

    case 'email': {
      const recipient = lead?.email || (data.recipientEmail);
      if (!recipient) {
        log.warn(`[DualBrain] Skipping email node: no recipient email for lead ${phone}`);
        return true; 
      }

      if (!client.emailUser || !client.emailAppPassword) {
        log.warn(`[DualBrain] Skipping email node: client ${client.clientId} missing SMTP credentials.`);
        return true;
      }

      let subject = data.subject || 'Follow up from ' + (client.name || 'Store');
      let body = data.body || '';

      // Variable Replacement
      const vars = {
        '{name}': lead?.name || 'Customer',
        '{items}': lead?.lastItems || 'your selected items',
        '{total}': lead?.lastTotal || '0',
        '{id}': lead?.phoneNumber || '',
        '{order_id}': lead?.lastOrderId || 'your order'
      };

      Object.entries(vars).forEach(([key, val]) => {
        subject = subject.replace(new RegExp(key, 'g'), val);
        body = body.replace(new RegExp(key, 'g'), val);
      });

      await emailService.sendEmail(client, {
        to: recipient,
        subject,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; line-height: 1.6;">
            ${body.replace(/\n/g, '<br/>')}
            <br/><br/>
            <p style="color: #666; font-size: 12px;">Sent via ${client.name || 'TopEdge AI'}</p>
          </div>
        `
      });
      return true;
    }

    default:
      console.warn(`[DualBrain] Unknown node type: ${type}`);
      return false;
  }

  // After sending the message, check for special actions
  if (node.data?.action) {
    const { handleNodeAction } = require("./nodeActions");
    // Execute action asynchronously
    handleNodeAction(node.data.action, node, client, phone, convo, lead).catch(err => {
      console.error(`[DualBrain] Action Error (${node.data.action}):`, err.message);
    });
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 2: KEYWORD FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
async function tryKeywordFallback(parsedMessage, client, convo, phone) {
  const text     = (parsedMessage.text?.body || '').toLowerCase().trim();
  const keywords = client.simpleSettings?.keywords || [];

  for (const kw of keywords) {
    if (!text.includes(kw.word.toLowerCase())) continue;

    switch (kw.action) {
      case 'restart_flow': {
        console.log(`[DualBrain] Keyword: restart_flow for "${text}"`);
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });

        // Re-run graph with cleared state
        const welcomeNodeId = client.simpleSettings?.welcomeStartNodeId;
        const flowNodes = client.flowNodes || [];
        // const flowNodes = client.flowNodes || []; // Already defined above
        const flowEdges = client.flowEdges || [];
        const freshConvo = { ...convo.toObject(), lastStepId: null };
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: client.clientId });

        if (welcomeNodeId) {
          return await executeNode(welcomeNodeId, flowNodes, flowEdges, client, freshConvo, lead, phone, global.io);
        }
        // Trigger first trigger node
        const firstTrigger = flowNodes.find(n => n.type === 'trigger');
        if (firstTrigger) {
          const startEdge = flowEdges.find(e => e.source === firstTrigger.id);
          if (startEdge) return await executeNode(startEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, global.io);
        }
        break;
      }
      case 'track_order':
        await handleUniversalOrderTracking(client, phone);
        return true;
      case 'escalate':
        await handleUniversalEscalate(client, phone, convo);
        return true;
      case 'cancel_flow':
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
        await sendWhatsAppText(client, phone, "Flow reset. Type 'Hi' to start over. 😊");
        return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 3: GEMINI AI FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
async function runAIFallback(parsedMessage, client, phone, lead) {
  const text = parsedMessage.text?.body;
  if (!text) return false;

  const knowledgeBase = [
    client.systemPrompt || '',
    client.simpleSettings?.knowledgeBase || '',
    client.nicheData?.knowledgeBase || ''
  ].filter(Boolean).join('\n\n');

  if (!knowledgeBase.trim()) {
    await sendWhatsAppText(client, phone, "I didn't quite understand that. Type 'Hi' to see what I can help with! 😊");
    return;
  }

  try {
    const ctaHint = client.nicheData?.ctaButtonText || 'Get Started';
    const prompt = [
      knowledgeBase,
      `INSTRUCTIONS:\n- Keep response under 3 sentences\n- Be warm and conversational\n- End by steering toward: "${ctaHint}"\n- Never make up prices or policies not listed above\n- If unsure, say: "Let me connect you to our team"`,
      `Customer: ${text}`
    ].join('\n\n');

    const reply = await generateText(prompt, client.geminiKey);
    await sendWhatsAppText(client, phone, reply);
    console.log(`[DualBrain] AI Fallback used for "${text.substring(0, 50)}..."`);
  } catch (err) {
    console.error('[DualBrain] AI Fallback error:', err.message);
    await sendWhatsAppText(client, phone, "I didn't quite understand that. Type 'Hi' to see how I can help! 😊");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP API HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsAppText(client, phone, body) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'text', text: { body }
    }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) { console.error('[DualBrain] sendText error:', err.response?.data?.error?.message || err.message); }
}

async function sendWhatsAppImage(client, phone, imageUrl, caption) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: imageUrl, caption }
    }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) { console.error('[DualBrain] sendImage error:', err.response?.data?.error?.message || err.message); }
}

async function sendWhatsAppInteractive(client, phone, interactive, bodyText) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return false;

  const sanitizedBody = (bodyText || '').substring(0, 1024);
  const data = {
    messaging_product: 'whatsapp', to: phone, type: 'interactive',
    interactive: { ...interactive, body: { text: sanitizedBody } }
  };

  // Sanitize footer (no 'type' field)
  if (interactive.footer) data.interactive.footer = { text: (interactive.footer?.text || interactive.footer || '').substring(0, 60) };

  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
    return true;
  } catch (err) {
    console.error('[DualBrain] sendInteractive error:', JSON.stringify(err.response?.data || err.message));
    return false;
  }
}

async function sendWhatsAppTemplate(client, phone, templateName, languageCode = 'en', components = []) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: templateName, language: { code: languageCode }, components }
    }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) { console.error('[DualBrain] sendTemplate error:', err.response?.data || err.message); }
}

async function sendWhatsAppFlow(client, phone, header, body, flowId, flowCta, screen) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: header || 'Action Required' },
        body: { text: body || 'Tap below to open the form and continue.' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: `flow_${Date.now()}`,
            flow_id: flowId || '1244048577247022',
            flow_cta: flowCta || 'Get Started',
            flow_action: 'navigate',
            flow_action_payload: { screen: screen || 'MAIN_SCREEN' }
          }
        }
      }
    }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) { console.error('[DualBrain] sendFlow error:', err.response?.data || err.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// VOICE NOTE TRANSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────
async function transcribeVoiceNote(parsedMessage, client) {
  try {
    const mediaId = parsedMessage.audio?.id;
    if (!mediaId) return null;

    const token = client.whatsappToken;
    const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
    const mediaUrl = mediaRes.data.url;

    const audioRes = await axios.get(mediaUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${token}` } });
    const base64Audio = Buffer.from(audioRes.data).toString('base64');

    const model = getGeminiModel(client.geminiKey);

    const result = await model.generateContent([
      { inlineData: { data: base64Audio, mimeType: 'audio/ogg' } },
      'Transcribe this voice message. Return ONLY the transcription text, nothing else.'
    ]);

    return result.response.text().trim();
  } catch (err) {
    console.error('[DualBrain] Voice transcription error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
async function handleUniversalOrderTracking(client, phone) {
  const Order = require('../models/Order');
  const orders = await Order.find({ phone, clientId: client.clientId }).sort({ createdAt: -1 }).limit(1);
  if (!orders.length) {
    return await sendWhatsAppText(client, phone, "I couldn't find any orders for your number. Please contact us directly.");
  }
  const order = orders[0];
  let msg = `📦 *Order #${order.orderNumber || order._id}*\nStatus: ${order.status || 'Processing'}\n`;
  if (order.trackingUrl) msg += `\nTrack: ${order.trackingUrl}`;
  await sendWhatsAppText(client, phone, msg);
}

async function handleUniversalEscalate(client, phone, convo) {
  await Conversation.findByIdAndUpdate(convo._id, {
    botPaused: true, requiresAttention: true, status: 'HUMAN_TAKEOVER',
    attentionReason: 'Customer requested human support'
  });
  const io = global.io;
  if (io) io.to(`client_${client.clientId}`).emit('attention_required', { phone, reason: 'Human support requested', priority: 'high' });
  await sendWhatsAppText(client, phone, "Connecting you to our team now. Someone will respond shortly! 💬");
  if (client.adminPhone) {
    await sendWhatsAppText(client, client.adminPhone, `👋 Agent needed: ${phone} requested human support. Chat: wa.me/91${phone}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGE SAVER
// ─────────────────────────────────────────────────────────────────────────────
async function saveInboundMessage(phone, clientId, parsedMessage, io) {
  const content =
    parsedMessage.text?.body ||
    parsedMessage.interactive?.button_reply?.title ||
    parsedMessage.interactive?.list_reply?.title ||
    `[${parsedMessage.type || 'unknown'}]`;
  try {
    // Message schema: from, to, direction ('incoming'|'outgoing'), type, content, messageId
    const msg = await Message.create({
      clientId,
      from:      phone,
      to:        'BOT',
      direction: 'incoming',
      type:      parsedMessage.type || 'text',
      content,
      messageId: parsedMessage.messageId || '',
      timestamp: new Date()
    });
    await Conversation.findOneAndUpdate(
      { phone, clientId },
      { $set: { lastMessage: content.substring(0, 100), lastMessageAt: new Date() } }
    );
    if (io) io.to(`client_${clientId}`).emit('new_message', msg);
    return msg;
  } catch (err) {
    console.error('[DualBrain] saveInboundMessage error:', err.message);
    return null; // never crash the engine on a save failure
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function extractTrigger(parsedMessage) {
  return {
    buttonId: parsedMessage.interactive?.button_reply?.id || parsedMessage.interactive?.list_reply?.id || null,
    text: parsedMessage.text?.body || null,
    type: parsedMessage.type
  };
}

function isGreeting(text) {
  return /^(hi|hello|hey|namaste|start|hola|hii|hey there)\b/i.test((text || '').trim());
}

module.exports = { runDualBrainEngine, executeNode, sendNodeContent, sendWhatsAppText, sendWhatsAppInteractive, sendWhatsAppTemplate, sendWhatsAppImage };
