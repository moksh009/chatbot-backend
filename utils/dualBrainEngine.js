"use strict";

const axios        = require("axios");
const Conversation = require("../models/Conversation");
const AdLead       = require("../models/AdLead");
const Message      = require("../models/Message");
const DailyStat    = require("../models/DailyStat");
const Client       = require("../models/Client");
const emailService = require("./emailService");
const log = require("./logger")('DualBrain');
const { generateText, getGeminiModel } = require('./gemini');
const { createMessage } = require("./createMessage");

/**
 * WHATSAPP & INSTAGRAM NAMESPACE WRAPPERS
 * Since there are multiple sendNodeContent calls to 'WhatsApp.sendX', 
 * we map them to the local sendWhatsAppX helpers defined below.
 * We define them here with arrow functions to avoid hoisting issues 
 * with the function declarations defined lower in the file.
 */
const WhatsApp = {
  sendText: (...args) => sendWhatsAppText(...args),
  sendImage: (...args) => sendWhatsAppImage(...args),
  sendInteractive: (...args) => sendWhatsAppInteractive(...args),
  sendTemplate: (...args) => sendWhatsAppTemplate(...args),
  sendFlow: (...args) => sendWhatsAppFlow(...args),
};

const Instagram = {
  sendText: (...args) => sendInstagramText(...args),
  sendImage: (...args) => sendInstagramImage(...args),
  sendInteractive: (...args) => sendInstagramInteractive(...args),
};

const { sendInstagramReply, sendInstagramMessage } = require("./omnichannel");

// ─────────────────────────────────────────────────────────────────────────────
// FLOW BUILDER HELPERS — handle nested folders/groups
// ─────────────────────────────────────────────────────────────────────────────

function flattenFlowNodes(nodes) {
  const flat = [];
  
  function traverse(nodeList) {
    if (!Array.isArray(nodeList)) return;
    for (const node of nodeList) {
      // Add the node itself (if it's an actual conversation node)
      if (node.type && node.type !== "folder" && node.type !== "group") {
        flat.push(node);
      }
      // Recurse into children/nodes inside folder
      if (node.children && Array.isArray(node.children)) {
        traverse(node.children);
      }
      // ReactFlow GroupNode pattern — nodes inside data.nodes
      if (node.data?.nodes && Array.isArray(node.data.nodes)) {
        traverse(node.data.nodes);
      }
      // Some builders store sub-nodes in node.nodes
      if (node.nodes && Array.isArray(node.nodes)) {
        traverse(node.nodes);
      }
    }
  }
  
  traverse(nodes);
  return flat;
}

function incrementNodeVisit(nodes, nodeId) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map(node => {
    if (node.id === nodeId) {
      return {
        ...node,
        data: { ...node.data, visitCount: (node.data?.visitCount || 0) + 1 }
      };
    }
    // Recurse into children
    if (node.children) {
      return { ...node, children: incrementNodeVisit(node.children, nodeId) };
    }
    if (node.data?.nodes) {
      return { ...node, data: { ...node.data, nodes: incrementNodeVisit(node.data.nodes, nodeId) } };
    }
    if (node.nodes) {
      return { ...node, nodes: incrementNodeVisit(node.nodes, nodeId) };
    }
    return node;
  });
}

const { normalizePhone } = require("./helpers");

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE REPLACEMENT UTILITY
// ─────────────────────────────────────────────────────────────────────────────
function replaceVariables(text, client, lead, convo) {
  if (!text) return text;
  let result = text;
  
  // Standardize variables for both WhatsApp/IG content and Email templates
  const vars = {
    '{{name}}': lead?.name || 'Customer',
    '{name}': lead?.name || 'Customer',
    '{{product_list}}': (client.nicheData?.products || []).map(p => `• *${p.title}* - ${p.price}\n  Link: ${p.url}`).join('\n\n') || 'No products available currently.',
    '{{buy_url}}': client.nicheData?.storeUrl || 'https://google.com',
    '{{order_status_summary}}': convo?.metadata?.lastOrderStatus || 'No recent orders found.',
    '{{id}}': lead?.phoneNumber || '',
    '{id}': lead?.phoneNumber || ''
  };

  Object.entries(vars).forEach(([key, val]) => {
    result = result.replace(new RegExp(key, 'g'), val);
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE — called by ALL niche engines
// Returns: true if message was handled
// ─────────────────────────────────────────────────────────────────────────────
async function runDualBrainEngine(parsedMessage, client) {
  const rawPhone = parsedMessage.from;
  const channel = parsedMessage.channel || 'whatsapp';
  
  // Normalize phone for consistency
  const phone = channel === 'whatsapp' ? normalizePhone(rawPhone) : rawPhone;
  
  const io    = global.io;
  const profileName = parsedMessage.profileName || '';

  // STEP 1: Upsert conversation state
  let convo = await Conversation.findOneAndUpdate(
    { phone, clientId: client.clientId },
    {
      $setOnInsert: { phone, clientId: client.clientId, lastStepId: null, botPaused: false, status: 'BOT_ACTIVE' },
      $inc: { unreadCount: 1 },
      $set: { 
        lastInteraction: new Date(),
        ...(profileName && { customerName: profileName })
      }
    },
    { upsert: true, new: true }
  );

  // STEP 2: Upsert lead
  let lead = await AdLead.findOneAndUpdate(
    { phoneNumber: phone, clientId: client.clientId },
    { 
      $setOnInsert: { phoneNumber: phone, clientId: client.clientId },
      $set: { 
        ...(profileName && { name: profileName }), // Sync WhatsApp name
        lastInteraction: new Date()
      }
    },
    { upsert: true, new: true }
  );

  // STEP 3: Save inbound message to DB + emit to dashboard
  await saveInboundMessage(phone, client.clientId, parsedMessage, io, channel, convo._id);

  // STEP 0.1: Check if client is active
  if (!client.isActive) {
    log.warn(`[DualBrain] Skipping message for INACTIVE client ${client.clientId}`);
    return true;
  }

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
      await WhatsApp.sendText(client, phone, "Sorry, I couldn't understand the voice note. Please type your message. 🙏");
      await createMessage({ clientId: client.clientId, phone, direction: 'outbound', type: 'text', body: "Transcription failed message" });
      return true;
    }
  }

  // STEP 5: PRIORITY 1 — Graph Traversal
  const graphHandled = await tryGraphTraversal(parsedMessage, client, convo, lead, phone, io, channel);
  if (graphHandled) return true;

  // STEP 6: PRIORITY 2 — Keyword Fallback
  const keywordHandled = await tryKeywordFallback(parsedMessage, client, convo, phone, channel);
  if (keywordHandled) return true;

  // STEP 7: PRIORITY 3 — Gemini AI Fallback
  // Only use AI if there is text body. Otherwise, let the caller handle it.
  if (parsedMessage.text?.body) {
    await runAIFallback(parsedMessage, client, phone, lead, channel);
    return true;
  }
  
  // Return false so the engine can process legacy interactive IDs
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 1: GRAPH TRAVERSAL
// ─────────────────────────────────────────────────────────────────────────────
async function tryGraphTraversal(parsedMessage, client, convo, lead, phone, io, channel = 'whatsapp') {
  const rawNodes  = client.flowNodes || [];
  const rawEdges  = client.flowEdges || [];
  const flowNodes = flattenFlowNodes(rawNodes); 
  const flowEdges = rawEdges;

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
    // Heatmap: Increment visit
    await trackNodeVisit(client, jumpNode.id);
    return await executeNode(jumpNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // --- NEW: Global Reset (If user says 'hi' or 'start', always try to find a trigger node) ---
  if (isGreeting(userText) || userText === 'start' || userText === 'menu') {
      const triggerNode = findTriggerNode(userText, flowNodes);
      if (triggerNode) {
          console.log(`[DualBrain] Graph: Resetting to trigger node ${triggerNode.id} based on greeting "${userText}"`);
          await trackNodeVisit(client, triggerNode.id);
          return await executeNode(triggerNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
      }
  }

  // B) No currentStepId (or it looks like a phone number) — guard + find trigger/start node
  const looksLikePhone = currentStepId && /^\d{7,}$/.test(String(currentStepId));
  if (!currentStepId || looksLikePhone) {
    if (looksLikePhone) {
      console.warn(`[DualBrain] Graph: lastStepId "${currentStepId}" looks like a phone number — resetting`);
      await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
    }
    // Try keyword greeting trigger first
    const incomingText = (userText || '').toLowerCase().trim();
    const triggerNode = flowNodes.find(n => {
      if (n.type !== 'trigger' && n.type !== 'TriggerNode') return false;
      const keyword = (n.data?.keyword || n.data?.label || 'hi').toLowerCase();
      return incomingText.includes(keyword) || 
             keyword === 'start' || 
             keyword === '*';
    });
    const startNode = triggerNode ||
      flowNodes.find(n => n.data?.role === 'welcome') ||
      flowNodes.find(n => n.data?.isStartNode === true) ||
      flowNodes[0];
    if (startNode) {
      console.log(`[DualBrain] Graph: Starting fresh from node ${startNode.id}`);
      await trackNodeVisit(client, startNode.id);
      return await executeNode(startNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    }
    return false;
  }

  // C) User is in the middle of a flow — find matching edge from currentStep
  const matchingEdge = flowEdges.find(e => {
    if (e.source !== currentStepId) return false;

    // No trigger = auto edge. (Default message nodes use 'a' for their bottom port)
    if (!e.trigger && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'bottom')) return true;

    // Match by sourceHandle (button id from React Flow)
    if (e.sourceHandle) {
      const sid = e.sourceHandle.toLowerCase();
      const bid = (incomingTrigger.buttonId || '').toLowerCase();
      const txt = userText;
      return sid === bid || sid === txt || txt === sid;
    }
    
    // NEW: Handle complex button payloads (e.g. from Meta)
    const buttonPayload = incomingTrigger.buttonId || '';
    if (buttonPayload && e.sourceHandle && buttonPayload.includes(e.sourceHandle)) return true;

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
          return await executeNode(handleEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
        }
      }
    }
    console.log(`[DualBrain] Graph: no matching edge from ${currentStepId} for "${userText || incomingTrigger.buttonId}"`);
    return false;
  }

  console.log(`[DualBrain] Graph: edge match from ${currentStepId} → ${matchingEdge.target}`);
  await trackNodeVisit(client, matchingEdge.target);
  return await executeNode(matchingEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE A SPECIFIC NODE
// ─────────────────────────────────────────────────────────────────────────────
async function executeNode(nodeId, flowNodes, flowEdges, client, convo, lead, phone, io, channel = 'whatsapp') {
  const node = flowNodes.find(n => n.id === nodeId);
  if (!node) { console.warn(`[DualBrain] Node ${nodeId} not found`); return false; }

  // Increment visitCount for Flow Convergence Analytics
  try {
    const updatedNodes = incrementNodeVisit(client.flowNodes || [], nodeId);
    await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes });
    // Update local reference for this execution chain
    client.flowNodes = updatedNodes;
  } catch (err) {
    console.error(`[DualBrain] Failed to increment visit count for node ${nodeId}:`, err.message);
  }

  const sent = await sendNodeContent(node, client, phone, lead, convo, channel);
  if (!sent && node.type !== 'logic' && node.type !== 'delay') return false;

  const action = node.data?.action;

  // --- SPECIAL NODE LOGIC (Automated Traversal) ---
  if (node.type === 'logic') {
    const condition = node.data?.condition || '';
    let result = false;
    
    // Simple evaluation engine (can be expanded)
    if (condition.includes('cart_total')) {
      const threshold = parseInt(condition.match(/\d+/)[0]) || 0;
      const cartValue = lead?.cartValue || convo?.metadata?.cartValue || 0;
      result = cartValue > threshold;
    } else if (condition === 'has_phone') {
      result = !!phone;
    } else if (condition === "channel == 'instagram'") {
      result = channel === 'instagram';
    }
    
    const targetHandle = result ? 'true' : 'false';
    const nextEdge = flowEdges.find(e => e.source === nodeId && e.sourceHandle === targetHandle);
    
    if (nextEdge) {
      console.log(`[DualBrain] Logic Check Result: ${result} -> Jumping to ${nextEdge.target}`);
      return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    }
  }

  if (node.type === 'livechat') {
    // Force set conversation status to HUMAN_SUPPORT
    await Conversation.findByIdAndUpdate(convo._id, { status: 'HUMAN_SUPPORT' });
    console.log(`[DualBrain] LiveChat Handover: Pausing bot for phone ${phone}`);
    // Optional: Follow fallback edge after delay if no human joins (advanced)
  }

  // Update lastStepId logic
  if (action === "AI_FALLBACK" || node.type === 'logic') {
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
  const autoEdge = flowEdges.find(e => e.source === nodeId && (!e.trigger || e.trigger?.type === 'auto') && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'bottom'));
  if (autoEdge) {
    setTimeout(async () => {
      const freshConvo = await Conversation.findById(convo._id);
      await executeNode(autoEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, io, channel);
    }, 800);
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND NODE CONTENT — handles all node types
// ─────────────────────────────────────────────────────────────────────────────
async function sendNodeContent(node, client, phone, lead = null, convo = null, channel = 'whatsapp') {
  const { type, data } = node;

  switch (type) {
    case 'image': {
      const imageUrl = data.imageUrl || '';
      const caption = data.caption || '';
      if (!imageUrl) return true;
      if (channel === 'instagram') {
        await Instagram.sendImage(client, phone, imageUrl, caption);
      } else {
        await WhatsApp.sendImage(client, phone, imageUrl, caption);
      }
      return true;
    }

    case 'folder': {
      // Folders are logical containers. They don't send content.
      return true;
    }

    case 'flow':
    case 'FlowNode': {
      await sendWhatsAppFlow(client, phone, data.header, data.body || data.text, data.flowId, data.flowCta, data.screen);
      return true;
    }
    case 'message':
    case 'MessageNode':
    case 'livechat': {
      let body = data.text || data.body || (type === 'livechat' ? 'Connecting you to a human...' : '');
      body = replaceVariables(body, client, lead, convo);
      
      if (channel === 'instagram') {
        if (data.imageUrl) {
          await Instagram.sendImage(client, phone, data.imageUrl, body);
        } else {
          await Instagram.sendText(client, phone, body);
        }
      } else if (data.imageUrl) {
        await WhatsApp.sendImage(client, phone, data.imageUrl, body);
      } else {
        await WhatsApp.sendText(client, phone, body);
      }
      return true;
    }

    case 'interactive':
    case 'InteractiveNode': {
      let body = data.text || data.body || 'Please Choose:';
      body = replaceVariables(body, client, lead, convo);

      // --- BRANCH A: CTA URL Button (Meta Template alternative) ---
      if (data.btnUrlLink) {
        if (channel === 'instagram') {
            // Instagram supports buttons via Generic Template/Buttons
            await Instagram.sendInteractive(client, phone, {
                type: 'button',
                text: body,
                buttons: [{ type: 'web_url', url: data.btnUrlLink, title: (data.btnUrlTitle || 'Visit Website').substring(0, 20) }]
            });
            return true;
        }
        let interactive = {
          type: 'cta_url',
          action: {
            name: 'cta_url',
            parameters: {
              display_text: (data.btnUrlTitle || 'Visit Website').substring(0, 20),
              url: data.btnUrlLink
            }
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await WhatsApp.sendInteractive(client, phone, interactive, body);
        return true;
      }

      // --- BRANCH B: Standard Reply Buttons or List ---
      const buttonsList = Array.isArray(data.buttonsList) && data.buttonsList.length > 0
        ? data.buttonsList
        : (data.buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

      if (!buttonsList.length) {
        if (channel === 'instagram') await Instagram.sendText(client, phone, body);
        else await WhatsApp.sendText(client, phone, body);
        return true;
      }

      if (channel === 'instagram') {
        // Automatically map WhatsApp List/Buttons to Instagram Quick Replies
        await Instagram.sendInteractive(client, phone, {
            type: 'quick_reply',
            text: body,
            buttons: buttonsList.map(btn => ({
                id: (btn.id || btn.title || 'opt').toLowerCase().replace(/\s+/g, '_'),
                title: (btn.title || btn.label || 'Option').substring(0, 20)
            }))
        });
        return true;
      }

      // Standard reply buttons or List
      if (data.interactiveType === 'list') {
        let interactive = {
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

        await WhatsApp.sendInteractive(client, phone, interactive, body);
        return true;
      }

      let interactive = {
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

      await WhatsApp.sendInteractive(client, phone, interactive, body);
      return true;
    }

    case 'template':
    case 'TemplateNode': {
      if (channel === 'instagram') {
        const fallback = data.instagramFallback || data.text || data.body || data.label || `[Template: ${data.templateName || data.metaTemplateName}]`;
        await sendInstagramReply(client, phone, fallback);
        return true;
      }

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
        const rawParams = data.variables.split(',').map(v => v.trim()).filter(Boolean);
        if (rawParams.length) {
          const processedParams = rawParams.map(p => ({
            type: 'text',
            text: replaceVariables(p, client, lead, convo).substring(0, 1024)
          }));
          components.push({ type: 'body', parameters: processedParams });
        }
      }

      await WhatsApp.sendTemplate(client, phone, templateName, data.languageCode || 'en', components);
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

    case 'trigger':
      // Trigger node has no outbound message content, just traverse to children
      return true;

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
      case 'initiate_return': {
        const { handleNodeAction } = require('./nodeActions');
        await handleNodeAction('INITIATE_RETURN', {}, client, phone, convo, lead);
        return true;
      }
      case 'escalate':
        await handleUniversalEscalate(client, phone, convo);
        return true;
      case 'cancel_flow':
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
        await WhatsApp.sendText(client, phone, "Flow reset. Type 'Hi' to start over. 😊");
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

  try {
    const ctaHint = client.nicheData?.ctaButtonText || 'Get Started';
    const discountCode = client.nicheData?.globalDiscountCode || 'OFF10';
    
    // Check if user is asking about price or hesitation
    const isHesitating = /price|expensive|cost|discount|offer|deal|cheap|money/i.test(text);
    
    const bargainingInstruction = isHesitating 
        ? `The customer seems hesitant about price. You are authorized to offer a one-time discount code: "${discountCode}". Use it to close the deal!`
        : `If the customer asks for a deal, you can mention code "${discountCode}".`;

    const knowledgeBase = (client.nicheData?.products || []).map(p => `PRODUCT: ${p.title} - ${p.price}. LINK: ${p.url}`).join('\n') || 'General product information available.';

    const prompt = [
      client.nicheData?.aiPromptContext || 'You are a friendly sales assistant.',
      knowledgeBase,
      `INSTRUCTIONS:
- Keep response under 3 sentences.
- Be warm and conversational.
- ${bargainingInstruction}
- End by steering toward: "${ctaHint}"
- If unsure, say: "Let me connect you to our team."`,
      `Customer: ${text}`
    ].join('\n\n');

    const reply = await generateText(prompt, client.geminiApiKey || client.config?.geminiApiKey);
    await WhatsApp.sendText(client, phone, reply);
    await createMessage({ clientId: client.clientId, phone, direction: 'outbound', type: 'text', body: reply, metadata: { is_ai_reply: true } });
    console.log(`[DualBrain] AI Fallback (${isHesitating ? 'Bargaining' : 'Info'}) used for "${text.substring(0, 50)}..."`);
  } catch (err) {
    console.error('[DualBrain] AI Fallback error:', err.message);
    await WhatsApp.sendText(client, phone, "I didn't quite understand that. Type 'Hi' to see how I can help! 😊");
    await createMessage({ clientId: client.clientId, phone, direction: 'outbound', type: 'text', body: "AI error fallback" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP API HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function sendReply(client, phone, body, channel = 'whatsapp') {
  return await sendWhatsAppText(client, phone, body, channel);
}

async function sendWhatsAppText(client, phone, body, channel = 'whatsapp') {
  if (channel === 'instagram') {
    try {
      const resp = await sendInstagramReply(client, phone, body);
      await saveOutboundMessage(phone, client.clientId, 'text', body, resp.message_id || '', 'instagram');
      return resp;
    } catch (err) {
      console.error('[DualBrain] IG sendReply error:', err.message);
      return;
    }
  }

  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'text', text: { body }
    }, { headers: { Authorization: `Bearer ${token}` } });
    
    await saveOutboundMessage(phone, client.clientId, 'text', body, res.data.messages[0].id);
  } catch (err) { console.error('[DualBrain] sendText error:', err.response?.data?.error?.message || err.message); }
}

async function sendWhatsAppImage(client, phone, imageUrl, caption) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: imageUrl, caption }
    }, { headers: { Authorization: `Bearer ${token}` } });
    
    await saveOutboundMessage(phone, client.clientId, 'image', caption || '[Image]', res.data.messages[0].id);
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
    const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'interactive', sanitizedBody, res.data.messages[0].id);
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
    const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: templateName, language: { code: languageCode }, components }
    }, { headers: { Authorization: `Bearer ${token}` } });
    
    await saveOutboundMessage(phone, client.clientId, 'template', `[Template: ${templateName}]`, res.data.messages[0].id);
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
// INSTAGRAM API HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function sendInstagramText(client, phone, text) {
  try {
    const res = await sendInstagramMessage(client, phone, { text });
    await saveOutboundMessage(phone, client.clientId, 'text', text, res.message_id || '', 'instagram');
    return true;
  } catch (err) {
    console.error('[DualBrain] IG sendText error:', err.message);
    return false;
  }
}

async function sendInstagramImage(client, phone, imageUrl, caption) {
  try {
    // IG supports image attachments. If there's a caption, we send it as a separate text message first
    // because IG attachments don't natively support captions like WhatsApp in the same payload.
    if (caption) {
      await sendInstagramText(client, phone, caption);
    }
    
    const res = await sendInstagramMessage(client, phone, {
      attachment: {
        type: 'image',
        payload: { url: imageUrl }
      }
    });
    
    await saveOutboundMessage(phone, client.clientId, 'image', caption || '[Image]', res.message_id || '', 'instagram');
    return true;
  } catch (err) {
    console.error('[DualBrain] IG sendImage error:', err.message);
    return false;
  }
}

async function sendInstagramInteractive(client, phone, interactive) {
  const { type, text, buttons } = interactive;
  
  try {
    let payload = { text };
    
    if (type === 'quick_reply') {
      payload.quick_replies = buttons.slice(0, 13).map(btn => ({
        content_type: 'text',
        title: (btn.title || btn.label ||'Option').substring(0, 20),
        payload: btn.id || btn.title?.toLowerCase().replace(/\s+/g, '_')
      }));
    } else if (type === 'button') {
      // Instagram 'button' type usually uses a generic template for multiple buttons
      payload = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [{
              title: text.substring(0, 80) || 'Please Choose:',
              buttons: buttons.slice(0, 3).map(btn => {
                if (btn.type === 'web_url') {
                  return { type: 'web_url', url: btn.url, title: btn.title.substring(0, 20) };
                }
                return { type: 'postback', title: btn.title.substring(0, 20), payload: btn.id || btn.title };
              })
            }]
          }
        }
      };
    }
    
    const res = await sendInstagramMessage(client, phone, payload);
    await saveOutboundMessage(
      phone, 
      client.clientId, 
      'interactive', 
      text || '[Interactive]', 
      res.message_id || '', 
      'instagram',
      { interactive: { type, action: { buttons: buttons.map(b => ({ reply: { title: b.title || b.label, id: b.id } })) } } }
    );
    return true;
  } catch (err) {
    console.error('[DualBrain] IG sendInteractive error:', err.message);
    return false;
  }
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
async function saveInboundMessage(phone, clientId, parsedMessage, io, channel = "whatsapp", conversationId = null) {
  const content =
    parsedMessage.text?.body ||
    parsedMessage.interactive?.button_reply?.title ||
    parsedMessage.interactive?.list_reply?.title ||
    `[${parsedMessage.type || 'unknown'}]`;
  try {
    // If conversationId not provided, try to find it
    let finalConvoId = conversationId;
    if (!finalConvoId) {
      const c = await Conversation.findOne({ phone, clientId });
      finalConvoId = c?._id;
    }

    // Message schema normalized via createMessage
    const msg = await createMessage({
      clientId,
      conversationId: finalConvoId, // CRITICAL FIX
      phone,
      direction: 'inbound',
      type:      parsedMessage.type || 'text',
      body:      content,
      messageId: parsedMessage.messageId || '',
      channel:   channel, 
      rawData:   parsedMessage
    });
    await Conversation.findOneAndUpdate(
      { phone, clientId },
      { 
        $set: { 
          lastMessage: content.substring(0, 100), 
          lastMessageAt: new Date(),
          channel: channel // Ensure conversation channel is updated/set
        } 
      }
    );
    if (io) io.to(`client_${clientId}`).emit('new_message', msg);
    return msg;
  } catch (err) {
    console.error('[DualBrain] saveInboundMessage error:', err.message);
    return null; // never crash the engine on a save failure
  }
}

async function saveOutboundMessage(phone, clientId, type, content, messageId, channel = "whatsapp", metadata = {}) {
  try {
    const convo = await Conversation.findOne({ phone, clientId });
    
    const msg = await createMessage({
      clientId,
      conversationId: convo?._id, // CRITICAL FIX
      phone,
      direction: 'outbound',
      type,
      body:      content,
      messageId: messageId || '',
      channel:   channel || 'whatsapp',
      metadata:  metadata
    });
    // We don't usually update lastMessage on outbound in the engine (it's updated by webhook usually)
    // but doing it here ensures the UI stays snappy if webhook is slow
    await Conversation.findOneAndUpdate(
      { phone, clientId },
      { 
        $set: { 
          lastMessage: `Bot: ${content.substring(0, 90)}`, 
          lastMessageAt: new Date(),
          channel: channel || 'whatsapp'
        } 
      }
    );
    const io = global.io;
    if (io) io.to(`client_${clientId}`).emit('new_message', msg);
    return msg;
  } catch (err) {
    console.error('[DualBrain] saveOutboundMessage error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function extractTrigger(parsedMessage) {
  return {
    buttonId: parsedMessage.interactive?.button_reply?.id || 
              parsedMessage.interactive?.list_reply?.id || 
              parsedMessage.button?.payload || 
              null,
    text: parsedMessage.text?.body || null,
    type: parsedMessage.type
  };
}

async function trackNodeVisit(client, nodeId) {
  try {
    const updatedNodes = incrementNodeVisit(client.flowNodes, nodeId);
    await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes });

    // Also emit to dashboard for real-time heatmap if needed
    const io = global.io;
    if (io) io.to(`client_${client.clientId}`).emit('heatmap_update', { nodeId });
  } catch (err) {
    console.error('[DualBrain] Heatmap tracking error:', err.message);
  }
}

function findTriggerNode(text, flowNodes) {
    const txt = (text || '').toLowerCase().trim();
    const isG = isGreeting(txt);
    
    // Helper to check if a keyword data (string or array) matches the input text
    const matchesKeyword = (kwData, input) => {
        if (!kwData) return false;
        const keywords = String(kwData).toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
        return keywords.some(k => input === k || (k !== '*' && input.includes(k)) || (k === '*' && input.length > 0));
    };

    // 1. Find exact/partial match in keywords
    const exact = flowNodes.find(n => {
        if (n.type !== 'trigger' && n.type !== 'TriggerNode') return false;
        return matchesKeyword(n.data?.keyword, txt);
    });
    if (exact) return exact;

    // 2. Find fallback by label or wildcard
    const trigger = flowNodes.find(n => {
        if (n.type !== 'trigger' && n.type !== 'TriggerNode') return false;
        const lbl = (n.data?.label || '').toLowerCase().trim();
        const kw = (n.data?.keyword || '').toLowerCase().trim();
        
        const isWild = kw === '*' || lbl === '*';
        const isGreetingMatch = isG && (kw === '' || kw === 'hi' || kw === 'start' || lbl.includes('entry') || lbl.includes('trigger') || lbl === 'hi' || lbl === 'start');
        
        return isWild || isGreetingMatch;
    });

    return trigger || flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode');
}

function isGreeting(text) {
  return /^(hi|hello|hey|namaste|start|hola|hii|hey there|menu|options)\b/i.test((text || '').trim());
}

module.exports = { 
    runDualBrainEngine, 
    executeNode, 
    sendNodeContent, 
    sendWhatsAppText, 
    sendWhatsAppInteractive, 
    sendWhatsAppTemplate, 
    sendWhatsAppImage,
    trackNodeVisit,
    saveInboundMessage,
    saveOutboundMessage,
    isGreeting,
    replaceVariables
};
