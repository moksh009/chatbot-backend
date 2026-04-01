"use strict";

const axios        = require("axios");
const Conversation = require("../models/Conversation");
const AdLead       = require("../models/AdLead");
const Message      = require("../models/Message");
const DailyStat    = require("../models/DailyStat");
const Client       = require("../models/Client");
const emailService = require("./emailService");
const NotificationService = require("./notificationService");
const BillingService = require('./billingService');
const log = require("./logger")('DualBrain');
const { generateText, getGeminiModel } = require('./gemini');
const { createMessage } = require("./createMessage");
const { injectVariables } = require("./variableInjector");

// Phase 17: Concurrency & Robustness
const processingLocks = new Map(); // phone -> timestamp
const SESSION_LOCK_TIMEOUT = 10000; // 10 seconds

/**
 * Helper to wrap promises with a timeout
 */
async function withTimeout(promise, ms, label = "Operation") {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

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
  const flat = flattenFlowNodes(nodes);
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

// ─────────────────────────────────────────────────────────────────────────────
// HANDLE ID NORMALIZER — strips ReactFlow group/folder prefixes from handle IDs
// e.g. "group_123__button_buy" → "button_buy"
// ─────────────────────────────────────────────────────────────────────────────
function normalizeHandleId(handleId) {
  if (!handleId) return handleId;
  const parts = handleId.split('__');
  return parts[parts.length - 1];
}

const { normalizePhone } = require("./helpers");

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE REPLACEMENT UTILITY
// ─────────────────────────────────────────────────────────────────────────────
function replaceVariables(text, client, lead, convo) {
  return injectVariables(text, { lead, client, convo, order: convo?.metadata?.lastOrder });
}

/**
 * Phase 17: Entry Point for Webhook Messages
 * Handles locking, client discovery, and final deduplication.
 */
async function handleWhatsAppMessage(from, message, phoneNumberId) {
  // 1. Session Lock to prevent race conditions
  if (processingLocks.has(from)) {
    const lockTime = processingLocks.get(from);
    if (Date.now() - lockTime < SESSION_LOCK_TIMEOUT) {
      console.warn(`🔒 Session locked for ${from}. Skipping rapid message.`);
      return;
    }
  }
  processingLocks.set(from, Date.now());

  try {
    const { discoverClientByPhoneId } = require("./clientDiscovery");
    const { parseWhatsAppPayload } = require("./parseWhatsAppPayload");

    // Discover client
    const client = await discoverClientByPhoneId(phoneNumberId);
    if (!client) {
      console.warn(`[DualBrain] Unknown phoneId: ${phoneNumberId}`);
      return;
    }

    // Parse the payload into engine format
    // (In masterWebhook we did some rough parsing, here we ensure consistency)
    const parsedMessage = {
      from,
      phone: from,
      messageId: message.id,
      timestamp: message.timestamp,
      type: message.type,
      phoneNumberId,
      text: message.text,
      interactive: message.interactive,
      button: message.button,
      image: message.image,
      audio: message.audio,
      video: message.video,
      document: message.document,
      channel: 'whatsapp'
    };

    // run engine
    await runDualBrainEngine(parsedMessage, client);

  } catch (err) {
    console.error(`[DualBrain] handleWhatsAppMessage Error:`, err.message);
  } finally {
    // Release lock
    processingLocks.delete(from);
  }
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
  
  // --- SMART ALERT DETECTION: "Call Now" ---
  const userText = (parsedMessage.text?.body || '').toLowerCase().trim();
  const callKeywords = ['call me', 'call now', 'want to talk', 'need a call', 'phone call', 'speak to a human', 'support agent'];
  if (callKeywords.some(k => userText.includes(k))) {
      const NotificationService = require('./notificationService');
      await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          topic: "📞 Lead requested a call",
          triggerSource: `Keyword: "${userText}"`,
          channel: 'both'
      });
      if (io) {
          io.to(`client_${client.clientId}`).emit('attention_required', {
              phone,
              reason: "Lead requested a call — prioritize!",
              priority: 'high'
          });
      }
      // Optional: Pause bot or mark for takeover
      await Conversation.findByIdAndUpdate(convo._id, { status: 'HUMAN_TAKEOVER', requiresAttention: true });
  }

  // Phase 17: Deduplication Update
  // Mark this message as processed to prevent duplicate engine runs
  if (parsedMessage.messageId) {
    await Conversation.findByIdAndUpdate(convo._id, {
      $addToSet: { processedMessageIds: parsedMessage.messageId }
    });
  }

  // STEP 0.1: Check if client is active
  if (!client.isActive) {
    log.warn(`[DualBrain] Skipping message for INACTIVE client ${client.clientId}`);
    return true;
  }

  // STEP 4: Human Takeover — bot is paused
  if (convo.botPaused || convo.status === 'HUMAN_TAKEOVER') {
    return true;
  }

  // ── PRIORITY 0: CAPTURE MODE ─────────────────────────────────────────────
  // If bot is waiting for text input from this user, capture it NOW before
  // anything else (keywords, AI fallback, etc.) can swallow the message.
  if (convo.status === 'WAITING_FOR_INPUT' && convo.waitingForVariable) {
    const capturedText = (parsedMessage.text?.body || '').trim();
    if (capturedText) {
      const varName = convo.waitingForVariable;
      const updatedMetadata = { ...(convo.metadata || {}), [varName]: capturedText };
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          metadata:            updatedMetadata,
          status:              'BOT_ACTIVE',
          waitingForVariable:  null,
          captureResumeNodeId: null,
          lastStepId:          convo.captureResumeNodeId || convo.lastStepId
        }
      });
      // Also persist to AdLead so {{varName}} can be used anywhere
      try {
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { [`capturedData.${varName}`]: capturedText } }
        );
      } catch (_) {}

      console.log(`[DualBrain] Priority0: captured "${capturedText}" → variable "${varName}" — resuming from ${convo.captureResumeNodeId}`);

      // Resume the flow from captureResumeNodeId
      if (convo.captureResumeNodeId) {
        const resumeConvo = await Conversation.findById(convo._id);
        resumeConvo.metadata = updatedMetadata;
        const flatNodes = flattenFlowNodes(client.flowNodes || []);
        return await executeNode(
          convo.captureResumeNodeId, flatNodes, client.flowEdges || [],
          client, resumeConvo, lead, phone, io, channel
        );
      }
      return true; // captured but no resume node
    }
    return true; // no text to capture, ignore
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Phase 17: Check for Flow Delay
  if (convo.flowPausedUntil && new Date() < convo.flowPausedUntil) {
    console.log(`⏳ Flow still paused for ${phone}. Responding via AI or skipping...`);
    // If user messages DURING a delay, we can either ignore or respond via AI
    // For now, we skip to avoid disrupting the scheduled flow
    return true;
  }
  
  // Clear delay if past time
  if (convo.flowPausedUntil && new Date() >= convo.flowPausedUntil) {
    await Conversation.findByIdAndUpdate(convo._id, { $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 } });
  }

  // STEP 4B: Handle voice notes — transcribe → re-process as text
  if (parsedMessage.type === 'audio') {
    const transcription = await transcribeVoiceNote(parsedMessage, client);
    if (transcription) {
      parsedMessage = { ...parsedMessage, type: 'text', text: { body: transcription }, _transcribedFrom: 'audio' };
    } else {
      await WhatsApp.sendText(client, phone, "Sorry, I couldn't understand the voice note. Please type your message. 🙏");
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
  const userText        = (parsedMessage.text?.body || '').trim();
  const userTextLower   = userText.toLowerCase();

  // A) GLOBAL KEYWORD / ROLE JUMP
  const jumpNode = flowNodes.find(n => {
    const role = (n.data?.role || '').toLowerCase();
    const keywords = (n.data?.keywords || '').toLowerCase().split(',').map(k => k.trim());
    return (role && userTextLower === role) || (keywords.length > 0 && keywords.includes(userTextLower));
  });

  if (jumpNode) {
    console.log(`[DualBrain] Graph: Jumping to node ${jumpNode.id} based on keyword/role match "${userTextLower}"`);
    await trackNodeVisit(client, jumpNode.id);
    return await executeNode(jumpNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // B) Handle CAPTURE_INPUT Node
  const currentNode = flowNodes.find(n => n.id === currentStepId);
  if (currentNode && (currentNode.type === 'capture_input' || currentNode.type === 'CaptureNode')) {
    const varName = currentNode.data?.variable || 'last_input';
    console.log(`[DualBrain] Capture: Saving "${userText}" to variable "${varName}" for convo ${phone}`);
    const updatedMetadata = { ...(convo.metadata || {}), [varName]: userText };
    await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
    convo.metadata = updatedMetadata;

    const nextEdge = flowEdges.find(e => e.source === currentStepId);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    return true; 
  }

  // C) User is in the middle of a flow
  let matchingEdge = flowEdges.find(e => {
    if (e.source !== currentStepId) return false;
    // Auto-forward edge: no trigger and no real button handle (or handle is a/bottom/output)
    const autoHandles = ['a', 'bottom', 'output', 'default', null, undefined, ''];
    if (!e.trigger && autoHandles.includes(normalizeHandleId(e.sourceHandle))) return true;
    if (e.sourceHandle) {
      const sid = normalizeHandleId(e.sourceHandle).toLowerCase();
      const bid = normalizeHandleId(incomingTrigger.buttonId || '').toLowerCase();
      const txt = userTextLower;
      return sid === bid || sid === txt || txt === sid;
    }
    if (e.trigger?.type === 'button') return normalizeHandleId(incomingTrigger.buttonId || '').toLowerCase() === normalizeHandleId(e.trigger.value).toLowerCase();
    if (e.trigger?.type === 'keyword') return userTextLower.includes(e.trigger.value.toLowerCase());
    return false;
  });

  // GAP FIX: Fallback edge
  if (!matchingEdge && currentStepId) {
    matchingEdge = flowEdges.find(e => e.source === currentStepId && normalizeHandleId(e.sourceHandle) === 'fallback');
  }

  if (matchingEdge) {
    console.log(`[DualBrain] Graph: edge match from ${currentStepId} → ${matchingEdge.target}`);
    await trackNodeVisit(client, matchingEdge.target);
    return await executeNode(matchingEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // D) GLOBAL RESET / GREETING
  if (!incomingTrigger.buttonId && (isGreeting(userTextLower) || userTextLower === 'start' || userTextLower === 'menu')) {
      const triggerNode = flowNodes.find(n => (n.type === 'trigger' || n.type === 'TriggerNode') && (n.data?.keyword || '').toLowerCase().split(',').map(k => k.trim()).includes(userTextLower));
      if (triggerNode) {
          console.log(`[DualBrain] Graph: Resetting to trigger node ${triggerNode.id}`);
          await trackNodeVisit(client, triggerNode.id);
          return await executeNode(triggerNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
      }
  }

  // E) No currentStepId — Fresh Start
  if (!currentStepId) {
    const startNode = flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode') || flowNodes.find(n => n.data?.role === 'welcome') || flowNodes[0];
    if (startNode) {
      console.log(`[DualBrain] Graph: Starting fresh from node ${startNode.id}`);
      await trackNodeVisit(client, startNode.id);
      return await executeNode(startNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    }
  }

  // Fallback: Check if the user's text matches a button title
  if (currentNode?.type === 'interactive') {
    const btns = currentNode.data?.buttonsList || [];
    const matchedBtn = btns.find(b => b.title?.toLowerCase() === userTextLower);
    if (matchedBtn) {
      const handleEdge = flowEdges.find(e =>
        e.source === currentStepId &&
        (normalizeHandleId(e.sourceHandle) === (matchedBtn.id || matchedBtn.title?.toLowerCase().replace(/\s+/g, '_')))
      );
      if (handleEdge) return await executeNode(handleEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    }
  }
  
  console.log(`[DualBrain] Graph: no match from ${currentStepId} for "${userText || incomingTrigger.buttonId}"`);
  return false;
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

  const sent = await withTimeout(
    sendNodeContent(node, client, phone, lead, convo, channel),
    8000, 
    `Node Content (${node.type})`
  );

  // Phase 17: Save Last Node Visited
  await Conversation.findByIdAndUpdate(convo._id, {
    lastNodeVisited: {
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.data?.label || node.type,
      visitedAt: new Date()
    }
  });

  if (!sent && node.type !== 'logic' && node.type !== 'delay' && node.type !== 'set_variable' && node.type !== 'shopify_call' && node.type !== 'http_request' && node.type !== 'link' && node.type !== 'restart') return false;

  // --- SPECIAL NODE LOGIC (Automated Traversal) ---
  if (node.type === 'logic') {
    const { condition, operator, value, variable } = node.data || {};

    // Resolve the left-hand value from multiple possible contexts
    let leftValue = '';
    if (variable) {
      // Support dot-path: e.g. "lead.leadScore", "metadata.captured_email"
      const parts = variable.split('.');
      const ctx = { lead, convo, metadata: convo.metadata || {} };
      leftValue = parts.reduce((obj, k) => (obj != null ? obj[k] : undefined), ctx);
      if (leftValue === undefined) leftValue = convo.metadata?.[variable] ?? '';
    } else if (condition) {
      if (condition.includes('cart_total')) leftValue = lead?.cartValue || convo?.metadata?.cartValue || 0;
      else if (condition === 'has_phone') leftValue = !!phone;
      else if (condition === "channel == 'instagram'") leftValue = channel === 'instagram';
    }

    const compValue = value !== undefined ? value : (condition?.match(/[\d.]+/) || [0])[0];
    let result = false;
    switch (operator) {
      case 'eq':
      case 'equals':        result = String(leftValue ?? '').toLowerCase() === String(compValue).toLowerCase(); break;
      case 'neq':
      case 'not_equals':    result = String(leftValue ?? '').toLowerCase() !== String(compValue).toLowerCase(); break;
      case 'gt':
      case 'greater_than':  result = Number(leftValue) > Number(compValue); break;
      case 'lt':
      case 'less_than':     result = Number(leftValue) < Number(compValue); break;
      case 'gte':           result = Number(leftValue) >= Number(compValue); break;
      case 'lte':           result = Number(leftValue) <= Number(compValue); break;
      case 'contains':      result = String(leftValue ?? '').toLowerCase().includes(String(compValue).toLowerCase()); break;
      case 'not_contains':  result = !String(leftValue ?? '').toLowerCase().includes(String(compValue).toLowerCase()); break;
      case 'exists':        result = leftValue !== undefined && leftValue !== null && leftValue !== ''; break;
      case 'not_exists':    result = leftValue === undefined || leftValue === null || leftValue === ''; break;
      case 'in':            result = String(compValue).split(',').map(v => v.trim()).includes(String(leftValue ?? '')); break;
      case 'starts_with':   result = String(leftValue ?? '').toLowerCase().startsWith(String(compValue).toLowerCase()); break;
      case 'ends_with':     result = String(leftValue ?? '').toLowerCase().endsWith(String(compValue).toLowerCase()); break;
      default:              result = String(leftValue ?? '').toLowerCase() === String(compValue).toLowerCase(); break;
    }

    console.log(`[DualBrain] Logic: ${variable}(${leftValue}) ${operator} ${compValue} → ${result ? 'TRUE' : 'FALSE'}`);
    const targetHandle = result ? 'true' : 'false';
    const nextEdge = flowEdges.find(e =>
      e.source === nodeId && (e.sourceHandle === targetHandle || normalizeHandleId(e.sourceHandle) === targetHandle)
    );
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    return true;
  }

  // Phase 17: AB Test Node
  if (node.type === 'ab_test' || node.type === 'ABTestNode') {
    // Persistent split based on phone number hash
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(phone).digest('hex');
    const firstChar = hash.charAt(0);
    const variant = parseInt(firstChar, 16) < 8 ? 'A' : 'B'; // 50/50 split
    
    await Conversation.findByIdAndUpdate(convo._id, { abVariant: variant });
    const nextEdge = flowEdges.find(e => e.source === nodeId && e.sourceHandle === variant.toLowerCase());
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // Phase 17: Tag Lead Node
  if (node.type === 'tag_lead' || node.type === 'TagNode') {
    const { action, tag } = node.data; // action: 'add' or 'remove'
    if (tag && lead) {
       const update = action === 'remove' ? { $pull: { tags: tag } } : { $addToSet: { tags: tag } };
       await AdLead.findByIdAndUpdate(lead._id, update);
    }
  }

  // Phase 17: Delay / Wait Node
  if (node.type === 'delay' || node.type === 'WaitNode') {
    const { duration, unit } = node.data; // duration: 5, unit: 'minutes'
    let delayMs = 60000; // default 1 min
    if (unit === 'minutes') delayMs = duration * 60000;
    else if (unit === 'hours') delayMs = duration * 3600000;
    else if (unit === 'seconds') delayMs = duration * 1000;

    const resumeAt = new Date(Date.now() + delayMs);
    await Conversation.findByIdAndUpdate(convo._id, { 
      flowPausedUntil: resumeAt,
      pausedAtNodeId: nodeId 
    });
    
    console.log(`⏳ Flow paused for ${phone} until ${resumeAt.toISOString()}`);
    return true; // Stop traversal here, cron will resume
  }

  // New: Set Variable Node
  if (node.type === 'set_variable' || node.type === 'SetVariableNode') {
    const { variable, value } = node.data;
    const processedValue = replaceVariables(value, client, lead, convo);
    const updatedMetadata = { ...(convo.metadata || {}), [variable]: processedValue };
    await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
    convo.metadata = updatedMetadata;
  }

  // New: Shopify Call Node
  if (node.type === 'shopify_call' || node.type === 'ShopifyNode') {
    const { action, query, variable } = node.data;
    const { getShopifyClient } = require("./shopifyHelper");
    try {
      const shopify = getShopifyClient(client);
      let data = null;
      if (action === 'search_products') data = await shopify.searchProducts(query);
      else if (action === 'get_order') data = await shopify.getOrderStatus(query || phone);
      
      if (variable) {
        const updatedMetadata = { ...(convo.metadata || {}), [variable]: data };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }
    } catch (err) { console.error("[DualBrain] Shopify Node Error:", err.message); }
  }

  // New: HTTP Request Node
  if (node.type === 'http_request' || node.type === 'HttpRequestNode') {
    const { url, method, body, variable } = node.data;
    try {
      const resp = await axios({
        url: replaceVariables(url, client, lead, convo),
        method: method || 'GET',
        data: body ? JSON.parse(replaceVariables(body, client, lead, convo)) : null,
        timeout: 5000
      });
      if (variable) {
        const updatedMetadata = { ...(convo.metadata || {}), [variable]: resp.data };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }
    } catch (err) { console.error("[DualBrain] HTTP Node Error:", err.message); }
  }

  if (node.type === 'livechat') {
    await Conversation.findByIdAndUpdate(convo._id, { status: 'HUMAN_SUPPORT' });
  }

  // Update lastStepId logic
  const isWaitNode = (node.type === 'capture_input' || node.type === 'CaptureNode');
  const action = node.data?.action;

  if (action === "AI_FALLBACK" || node.type === 'logic') {
    await Conversation.findByIdAndUpdate(convo._id, { lastStepId: convo.lastStepId, lastInteraction: new Date() });
  } else {
    await Conversation.findByIdAndUpdate(convo._id, { lastStepId: nodeId, lastInteraction: new Date() });
  }

  // Auto-forward if not a wait node or logic node (logic already handled)
  if (!isWaitNode && node.type !== 'logic') {
    const autoEdge = flowEdges.find(e => e.source === nodeId && (!e.trigger || e.trigger?.type === 'auto') && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'bottom'));
    if (autoEdge) {
      setTimeout(async () => {
        const freshConvo = await Conversation.findById(convo._id);
        await executeNode(autoEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, io, channel);
      }, 600);
    }
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

    case 'folder': return true;

    case 'capture_input':
    case 'CaptureNode': {
      let body = data.text || data.body || data.label || 'Please provide the requested information:';
      body = replaceVariables(body, client, lead, convo);
      if (channel === 'instagram') await Instagram.sendText(client, phone, body);
      else await WhatsApp.sendText(client, phone, body);
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
        if (data.imageUrl) await Instagram.sendImage(client, phone, data.imageUrl, body);
        else await Instagram.sendText(client, phone, body);
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

      if (data.btnUrlLink) {
        if (channel === 'instagram') {
            await Instagram.sendInteractive(client, phone, {
                type: 'button',
                text: body,
                buttons: [{ type: 'web_url', url: data.btnUrlLink, title: (data.btnUrlTitle || 'Visit').substring(0, 20) }]
            });
            return true;
        }
        let interactive = {
          type: 'cta_url',
          action: {
            name: 'cta_url',
            parameters: { display_text: (data.btnUrlTitle || 'Visit').substring(0, 20), url: data.btnUrlLink }
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await WhatsApp.sendInteractive(client, phone, interactive, body);
        return true;
      }

      const buttonsList = Array.isArray(data.buttonsList) && data.buttonsList.length > 0
        ? data.buttonsList
        : (data.buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

      if (!buttonsList.length) {
        if (channel === 'instagram') await Instagram.sendText(client, phone, body);
        else await WhatsApp.sendText(client, phone, body);
        return true;
      }

      if (channel === 'instagram') {
        await Instagram.sendInteractive(client, phone, {
            type: 'quick_reply',
            text: body,
            buttons: buttonsList.map(btn => ({
                id: (btn.id || btn.title).toLowerCase().replace(/\s+/g, '_'),
                title: (btn.title || 'Option').substring(0, 20)
            }))
        });
        return true;
      }

      if (data.interactiveType === 'list') {
        let interactive = {
          type: 'list',
          action: {
            button: 'Select',
            sections: [{ title: 'Options', rows: buttonsList.slice(0, 10).map(btn => ({ id: (btn.id || btn.title).toLowerCase().replace(/\s+/g, '_'), title: (btn.title || 'Opt').substring(0, 24) })) }]
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await WhatsApp.sendInteractive(client, phone, interactive, body);
        return true;
      }

      let interactive = {
        type: 'button',
        action: { buttons: buttonsList.slice(0, 3).map(btn => ({ type: 'reply', reply: { id: (btn.id || btn.title).toLowerCase().replace(/\s+/g, '_'), title: (btn.title || 'Opt').substring(0, 20) } })) }
      };
      if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
      else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
      await WhatsApp.sendInteractive(client, phone, interactive, body);
      return true;
    }

    case 'template':
    case 'TemplateNode': {
      const templateName = data.templateName || data.metaTemplateName;
      if (!templateName) return false;
      const components = [];
      if (data.headerImageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: data.headerImageUrl } }] });
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
      const recipient = lead?.email || data.recipientEmail;
      if (!recipient || !client.emailUser) return true;
      let subject = replaceVariables(data.subject || 'Update', client, lead, convo);
      let body = replaceVariables(data.body || '', client, lead, convo);
      await emailService.sendEmail(client, { to: recipient, subject, html: body.replace(/\n/g, '<br/>') });
      return true;
    }

    case 'trigger': return true;
    case 'logic': return true;
    case 'set_variable': return true;
    case 'shopify_call': return true;
    case 'http_request': return true;
    case 'tag_lead': return true;
    case 'admin_alert': return true;
    case 'jump': return true;
    case 'link': return true;
    case 'restart': return true;

    default:
      console.warn(`[DualBrain] Skipping send content for node type: ${type}`);
      return true;
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

        // --- PHASE 17 SAAS BILLING ENFORCEMENT ---
        const usage = await BillingService.checkLimit(client.clientId, 'aiCallsMade');
        if (!usage.allowed) {
            console.warn(`[DualBrainEngine] Billing Limit Reached for client: ${client.clientId}. Total AI calls: ${usage.current}/${usage.limit}`);
            // Fallback: Notify Admin instead of allowing AI to run
            if (global.NotificationService) {
                await global.NotificationService.sendAdminAlert(client.clientId, `SaaS Limit Reached: ${usage.current}/${usage.limit} AI calls used. AI responses paused for ${client.clientId}.`, 'email');
            }
            return {
                text: "Our AI assistant is temporarily resting due to high volume. A human teammate will be with you shortly.",
                status: 'HUMAN_TAKEOVER'
            };
        }
        
        // Track the attempt
        await BillingService.incrementUsage(client.clientId, 'aiCallsMade');
        await BillingService.incrementUsage(client.clientId, 'messagesSent');

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
async function runAIFallback(parsedMessage, client, phone, lead, channel = 'whatsapp') {
  const text = parsedMessage.text?.body;
  if (!text) return false;

  try {
    // ── Active Listener: "Call Now" Detection ──
    const callIntentRegex = /\b(call|phone|talk|speak|representative|human|agent|person|connect|callback|calling)\b/i;
    if (callIntentRegex.test(text)) {
      console.log(`[DualBrain] Active Listener: Detect "Call Now" intent for ${phone}`);
      
      // 1. Notify Admin
      await NotificationService.sendAdminAlert(client, {
        customerPhone: phone,
        topic: 'Customer Requesting Call/Human',
        triggerSource: 'AI Active Listener (Intent: Call Now)'
      });

      // 2. Update Conversation Status
      await Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        { $set: { status: 'HUMAN_TAKEOVER', lastInteraction: new Date() } }
      );

      // 3. Inform Customer
      const callReply = `I've just notified our team that you'd like to speak with someone. A representative will reach out to you or call you shortly! 📞✨`;
      await WhatsApp.sendText(client, phone, callReply, channel);
      return true;
    }
    // ─────────────────────────────────────────────
    
    // ── Dynamic Discount: use the most recently generated code if the AI toggle is ON ──
    let discountCode = client.nicheData?.globalDiscountCode || 'OFF10';
    if (client.aiUseGeneratedDiscounts && Array.isArray(client.generatedDiscounts) && client.generatedDiscounts.length > 0) {
      const latestDiscount = client.generatedDiscounts[client.generatedDiscounts.length - 1];
      if (latestDiscount?.code) {
        discountCode = latestDiscount.code;
        console.log(`[DualBrain] AI using dynamic discount code: ${discountCode}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    
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
    
    // Phase 18: Log Unanswered Question
    if (!client.unansweredQuestions) client.unansweredQuestions = [];
    client.unansweredQuestions.push({
      question: text,
      phone: phone,
      aiResponse: reply,
      askedAt: new Date(),
      status: 'pending'
    });
    if (client.unansweredQuestions.length > 50) client.unansweredQuestions.shift();
    await Client.findByIdAndUpdate(client._id, { unansweredQuestions: client.unansweredQuestions });

    // Clear failure counter on success
    await Conversation.findOneAndUpdate(
      { phone, clientId: client.clientId },
      { $set: { consecutiveFailedMessages: 0 } }
    );

    await WhatsApp.sendText(client, phone, reply, channel);
    console.log(`[DualBrain] AI Fallback (${isHesitating ? 'Bargaining' : 'Info'}) used for "${text.substring(0, 50)}..."`);
  } catch (err) {
    console.error('[DualBrain] AI Fallback error:', err.message);

    // Phase 17: Consecutive Failure Tracking
    const updatedConvo = await Conversation.findOneAndUpdate(
      { phone, clientId: client.clientId },
      { $inc: { consecutiveFailedMessages: 1 } },
      { new: true }
    );

    if (updatedConvo.consecutiveFailedMessages >= 3) {
      log.warn(`🚨 3 consecutive AI failures for ${phone}. Escalating to human.`);
      await handleUniversalEscalate(client, phone, updatedConvo);
      return;
    }

    await WhatsApp.sendText(client, phone, "I'm having a bit of trouble understanding. Let me check with my team! 😊");
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
    handleWhatsAppMessage,
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
