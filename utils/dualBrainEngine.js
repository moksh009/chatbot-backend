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
const ProcessingLock = require('../models/ProcessingLock');
const redisClient = require('./redisClient');
const InboundDeduplication = require('../models/InboundDeduplication');
const log = require("./logger")('DualBrain');
const { generateText, getGeminiModel } = require('./gemini');
const { createMessage } = require("./createMessage");
const { injectVariables, buildVariableContext, injectNodeVariables, injectVariablesLegacy } = require("./variableInjector");
const { findMatchingFlow, findFlowStartNode } = require("./triggerEngine");
const { evaluateRules, executeRuleActions } = require("./rulesEngine");
const { evaluateRouting } = require("./routingEngine");
const { sendEmail } = require("./emailService");
const { checkLimit, incrementUsage } = require("../utils/planLimits");
const { detectLanguage, translateToUserLanguage, normalizeIntent, getLanguageInstructions } = require("./languageEngine");
const { analyzeSentiment } = require("./sentimentEngine");
const { extractOrderDetails } = require("./orderParser"); // Phase 28 Track 5
const { executeNativeOrder } = require("./orderCreator"); // Phase 28 Track 5
const TrainingCase = require("../models/TrainingCase");
const BotAnalytics = require("../models/BotAnalytics");
const { buildPersonaSystemPrompt, applyPersonaPostProcess } = require("./personaEngine"); // Phase 29 Track 3
const { getRelevantExamples, buildFewShotPrompt } = require("./trainingEngine"); // Phase 29 Track 4
const { generatePaymentLink } = require("./paymentLinkGenerator"); // Phase 29 Track 7
const MessageBufferService = require('../services/MessageBufferService');
const { resolveAndSaveMedia } = require('./whatsappMedia');
const WhatsAppUtils = require('./whatsapp');
const messageBuffer = require('./messageBuffer');
const { parseWhatsAppPayload } = require("./parseWhatsAppPayload");
const { normalizeHandleId, findInteractiveEdgeForButtonAcrossGraph } = require("./graphButtonRouting");
const { logFlowEvent } = require("./flowObservability");


const SESSION_LOCK_TIMEOUT = 10000; // 10 seconds (Fallback for TTL)

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
  sendSmartTemplate: (...args) => sendWhatsAppSmartTemplate(...args),
  sendFlow: (...args) => sendWhatsAppFlow(...args),
  // Catalog methods — delegated to WhatsAppUtils module
  sendCatalog: (...args) => WhatsAppUtils.sendCatalog(...args),
  sendMultiProduct: (...args) => WhatsAppUtils.sendMultiProduct(...args),
  sendAudio: (...args) => WhatsAppUtils.sendAudio ? WhatsAppUtils.sendAudio(...args) : Promise.resolve(),
};


const { generateVoiceReply } = require("./voiceReply");

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

async function getFlowGraphForConversation(client, convo) {
  const fallbackNodes = flattenFlowNodes(client.flowNodes || []);
  const fallbackEdges = client.flowEdges || [];
  if (!convo?.activeFlowId) {
    return { nodes: fallbackNodes, edges: fallbackEdges };
  }

  const activeFlowId = String(convo.activeFlowId);

  // 1) Prefer WhatsAppFlow collection — read PUBLISHED state only
  try {
    const WhatsAppFlow = require("../models/WhatsAppFlow");
    let flowDoc = null;
    if (/^[a-f\d]{24}$/i.test(activeFlowId)) {
      flowDoc = await WhatsAppFlow.findById(activeFlowId).lean();
    }
    if (!flowDoc) {
      flowDoc = await WhatsAppFlow.findOne({
        clientId: client.clientId,
        $or: [{ flowId: activeFlowId }, { _id: activeFlowId }]
      }).lean();
    }
    if (flowDoc) {
      // CRITICAL: Read from publishedNodes/publishedEdges (immutable snapshot)
      // Never read from draft nodes — prevents live edits from affecting running bots
      const pubNodes = flowDoc.publishedNodes || [];
      const pubEdges = flowDoc.publishedEdges || [];
      if (pubNodes.length > 0) {
        return { nodes: flattenFlowNodes(pubNodes), edges: pubEdges };
      }
      // If publishedNodes is empty but nodes exists, this flow was never published properly
      // Fall back to nodes with a warning (backwards compatibility for pre-migration flows)
      if (flowDoc.nodes?.length) {
        log.warn(`[FlowGraph] Flow ${activeFlowId} has no publishedNodes — using draft nodes as fallback. Please re-publish.`);
        return { nodes: flattenFlowNodes(flowDoc.nodes), edges: flowDoc.edges || [] };
      }
    }
  } catch (_) {
    // non-fatal, continue to in-memory flow lookup
  }

  // 2) Fallback to visualFlows held on client settings
  const visualFlow = (client.visualFlows || []).find(f => String(f.id) === activeFlowId);
  if (visualFlow?.nodes?.length) {
    return { nodes: flattenFlowNodes(visualFlow.nodes || []), edges: visualFlow.edges || [] };
  }

  return { nodes: fallbackNodes, edges: fallbackEdges };
}

const { normalizePhone } = require("./helpers");

/**
 * Phase 21: Universal Flow Executor
 * Starts a visual flow for a user, handling convo/lead setup and extra context (like commentId).
 */
/**
 * Walk a published flow starting at `currentNodeId` (used by Shopify commerce webhooks).
 * Reloads conversation + builds variable context so {{placeholders}} resolve correctly.
 */
async function walkFlow({ client, phone, flow, currentNodeId, convo, lead, userMessage, suppressConversationPersistence = false }) {
  const io = global.io;
  const channel = 'whatsapp';
  const normalizedPhone = normalizePhone(phone);
  const nodes = flattenFlowNodes(flow.nodes || []);
  const edges = flow.edges || [];

  const Conversation = require('../models/Conversation');
  const AdLead = require('../models/AdLead');

  const freshConvo = await Conversation.findById(convo._id);
  if (!freshConvo) {
    log.error('[walkFlow] Conversation not found');
    return false;
  }

  let freshLead = lead;
  if (freshLead?._id) {
    freshLead = await AdLead.findById(freshLead._id).lean() || freshLead;
  }
  if (!freshLead || !freshLead.phoneNumber) {
    freshLead = await AdLead.findOne({ phoneNumber: normalizedPhone, clientId: client.clientId }).lean();
  }

  const ctx = await buildVariableContext(client, normalizedPhone, freshConvo, freshLead);
  freshConvo._variableContext = ctx;

  const parsedMessage = {
    from: normalizedPhone,
    phone: normalizedPhone,
    channel,
    _variableContext: ctx,
    type: 'text',
    text: userMessage ? { body: userMessage } : { body: '' },
    suppressConversationPersistence: !!suppressConversationPersistence
  };

  if (!suppressConversationPersistence) {
    await Conversation.findByIdAndUpdate(freshConvo._id, {
      activeFlowId: flow._id || flow.id || flow.flowId || null,
      lastInteraction: new Date()
    });
  } else {
    await Conversation.findByIdAndUpdate(freshConvo._id, { lastInteraction: new Date() });
  }

  return executeNode(
    currentNodeId,
    nodes,
    edges,
    client,
    freshConvo,
    freshLead,
    normalizedPhone,
    io,
    channel,
    parsedMessage
  );
}

async function runFlow(client, from, flow, startNodeId, extraContext = {}) {
  const channel = extraContext.channel || 'whatsapp';
  const phone = channel === 'whatsapp' ? normalizePhone(from) : from;
  const io = global.io;

  try {
    // 1. Ensure Convo & Lead exist
    let convo = await Conversation.findOneAndUpdate(
      { phone, clientId: client.clientId },
      {
        $setOnInsert: { phone, clientId: client.clientId, lastStepId: null, botPaused: false, status: 'BOT_ACTIVE' },
        $set: { lastInteraction: new Date() }
      },
      { upsert: true, new: true }
    );

    let lead = await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      { 
        $setOnInsert: { phoneNumber: phone, clientId: client.clientId, optStatus: 'opted_in', optInDate: new Date(), optInSource: extraContext.triggerSource || 'flow' },
        $set: { lastInteraction: new Date() }
      },
      { upsert: true, new: true }
    );

    // 2. Build Context
    const variableContext = await buildVariableContext(client, phone, convo, lead);
    const parsedMessage = {
      from,
      channel,
      _variableContext: variableContext,
      commentId: extraContext.commentId
    };

    // 3. Execute
    log.info(`Manual runFlow: Executing ${flow.name || flow.id} starting at ${startNodeId}`);
    
    // Save active flow state
    await Conversation.findByIdAndUpdate(convo._id, { activeFlowId: flow._id || flow.id });
    
    return await executeNode(startNodeId, flattenFlowNodes(flow.nodes), flow.edges, client, convo, lead, from, io, channel, parsedMessage);
  } catch (err) {
    log.error(`runFlow Error:`, { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE REPLACEMENT UTILITY
// ─────────────────────────────────────────────────────────────────────────────
function replaceVariables(text, client, lead, convo) {
  return injectVariablesLegacy(text, { lead, client, convo, order: convo?.metadata?.lastOrder });
}

async function handleWhatsAppMessage(from, message, phoneNumberId, profileName = '') {
  let client;
  try {
    // 0. Find Client first to scope the session lock
    client = await Client.findOne({ phoneNumberId });
    if (!client) {
        log.warn(`Client not found for phoneId: ${phoneNumberId}`);
        return;
    }

    // NOTE: Lock and Deduplication moved into runDualBrainEngine so ALL entry points are protected.
    // (Ecommerce, Salon, Turfs, etc. all call runDualBrainEngine directly)

    const parsed = await parseWhatsAppPayload(message);
    if (!parsed) {
      return;
    }
    log.info(`[DualBrain] Processing ${from}: "${(parsed.text?.body || parsed.interactive?.button_reply?.title || '').substring(0, 50)}" type=${parsed.type || message.type}`);

    // --- PHASE 23: Track 5 - Meta Flow Response (nfm_reply) ---
    if (parsed.interactive?.type === 'nfm_reply') {
        const flowResponse = parsed.interactive.nfm_reply;
        log.info(`🌊 Flow Submission detected from ${from}`, { response: flowResponse.response_json });
        
        try {
            const data = JSON.parse(flowResponse.response_json || '{}');
            const lead = await AdLead.findOneAndUpdate(
                { phoneNumber: from, clientId: client.clientId },
                { 
                    $set: { lastInteraction: new Date() },
                    $set: { capturedData: { ...( (await AdLead.findOne({phoneNumber: from, clientId: client.clientId}))?.capturedData || {} ), ...data } },
                    $push: { activityLog: { action: 'whatsapp_flow_submitted', details: `Submitted Meta Flow ID: ${flowResponse.flow_id}` } }
                },
                { upsert: true, new: true }
            );

            // Increment Analytics Completion
            await DailyStat.findOneAndUpdate(
                { clientId: client.clientId, date: new Date().toISOString().split('T')[0] },
                { $inc: { flowsCompleted: 1 } },
                { upsert: true }
            );

            // Find next node in flow
            const convo = await Conversation.findOne({ phone: from, clientId: client.clientId });
            if (convo && convo.lastStepId) {
                const flowNodes = client.flowNodes || [];
                const flowEdges = client.flowEdges || [];
                const nextEdge = flowEdges.find(e => e.source === convo.lastStepId);
                if (nextEdge) {
                    return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, from, global.io);
                }
            }
        } catch (err) {
            log.error('Flow processing error:', { error: err.message });
        }
        return;
    }

    // Resolve Media IDs if present (Phase 28 Track 2)
    const mediaObj = parsed.image || parsed.audio || parsed.video || parsed.document;
    if (mediaObj && mediaObj.id) {
        parsed.mediaUrl = await resolveAndSaveMedia(mediaObj.id, client);
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
      channel: 'whatsapp',
      referral: message.referral,
      profileName,
      mediaUrl: parsed.mediaUrl
    };


    // run engine (lock and deduplication handled inside)
    await runDualBrainEngine(parsedMessage, client);
  } catch (err) {
    log.error(`handleWhatsAppMessage Error:`, { from, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────
function isGreeting(text) {
    const greetings = ['hi', 'hello', 'hey', 'hola', 'namaste', 'greetings', 'start', 'menu'];
    return greetings.includes(text.toLowerCase().trim());
}

async function checkIntent(userText, intentDescription, apiKey) {
  try {
    const prompt = `You are an intent classifier.
User Message: "${userText}"
Intent Description: "${intentDescription}"
Does the user message match the intent description? Reply ONLY with "YES" or "NO".`;
    const response = await generateText(prompt, apiKey);
    if (response && response.toUpperCase().includes('YES')) {
      return true;
    }
  } catch (err) {
    log.warn(`AI Intent detection failed: ${err.message}`);
  }
  return false;
}

async function analyzeConversationIntelligence(client, phone, convo) {
   try {
       const CI = require('./customerIntelligence');
       if (CI && CI.analyzeConversation) {
           await CI.analyzeConversation(client.clientId, phone, convo._id);
       }
   } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE — called by ALL niche engines
// Returns: true if message was handled
// ─────────────────────────────────────────────────────────────────────────────
async function runDualBrainEngine(parsedMessage, client) {
  const rawPhone = parsedMessage.from;
  const channel  = parsedMessage.channel || 'whatsapp';
  const phone    = channel === 'whatsapp' ? normalizePhone(rawPhone) : rawPhone;
  const io       = global.io;
  const messageId = parsedMessage.messageId;

  // 1. SESSION LOCK — Atomic upsert with ownership ID
  // Uses findOneAndUpdate with $setOnInsert to atomically claim the lock.
  // The _lockOwnerId ensures only the owning request can release it.
  const _lockStartTime = Date.now();
  const crypto = require('crypto');
  const _lockOwnerId = crypto.randomUUID();
  const lockKey = `lock:session:${client.clientId}:${phone}`;
  try {
      if (redisClient && redisClient.status === 'ready') {
          // Redis atomic lock (30s TTL)
          const acquired = await redisClient.set(lockKey, _lockOwnerId, 'NX', 'EX', 30);
          if (!acquired) {
              log.warn(`[Lock] Session locked for ${phone} by another request. Skipping.`);
              return true;
          }
      } else {
          // Fallback to MongoDB if Redis is unavailable
          const existingLock = await ProcessingLock.findOneAndUpdate(
            { phone, clientId: client.clientId },
            { $setOnInsert: { phone, clientId: client.clientId, _lockOwnerId, lockedAt: new Date() } },
            { upsert: true, new: true, lean: true }
          );
          if (existingLock._lockOwnerId !== _lockOwnerId) {
            log.warn(`[Lock] Session locked for ${phone} by another request. Skipping.`);
            return true;
          }
      }
  } catch (lockErr) {
      if (lockErr.code === 11000) {
        log.warn(`[Lock] Session locked for ${phone} (duplicate key). Skipping.`);
        return true;
      }
      log.error(`[Lock] Unexpected lock error for ${phone}:`, lockErr.message);
      return true;
  }

  try {
    const profileName = parsedMessage.profileName || '';
    const inboundText = parsedMessage.text?.body || parsedMessage.interactive?.button_reply?.title || parsedMessage.interactive?.list_reply?.title || '';
    const txtLower = inboundText.toLowerCase().trim();

    // --- Name Priority Guard (Enterprise) ---
    // If the lead was imported via CSV or manually renamed, do NOT overwrite customerName with WhatsApp profile.
    let shouldSetCustomerName = !!profileName;
    if (profileName) {
      const existingLeadForName = await AdLead.findOne(
        { phoneNumber: phone, clientId: client.clientId },
        { isNameCustom: 1, nameSource: 1, name: 1 }
      ).lean();
      if ((existingLeadForName?.isNameCustom || existingLeadForName?.nameSource === 'imported') && existingLeadForName?.name) {
        shouldSetCustomerName = false; // Preserve the CSV/manual name
      }
    }

    // --- GAP-GEN-3: COMMERCE AUTOMATION ISOLATION ---
    // If this is an ecommerce event, route it to the isolated WhatsAppFlow automation
    // (suppressConversationPersistence so lastStepId / activeFlowId stay on the main journey).
    const triggerTypes = ['order_placed', 'abandoned_cart', 'order_fulfilled'];
    if (triggerTypes.includes(parsedMessage?.type)) {
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      const Conversation = require('../models/Conversation');
      const automationFlow = await WhatsAppFlow.findOne({
        clientId: client.clientId,
        isAutomation: true,
        automationTrigger: parsedMessage.type,
        status: 'PUBLISHED'
      }).lean();
      if (automationFlow && (automationFlow.nodes || []).length > 0) {
        log.info(`[Automation] Routing ${parsedMessage.type} to isolated automation flow for ${phone}`);
        const nodes = automationFlow.publishedNodes?.length ? automationFlow.publishedNodes : automationFlow.nodes;
        const edges = automationFlow.publishedEdges?.length ? automationFlow.publishedEdges : automationFlow.edges;
        const trig = nodes.find((n) => n.type === 'trigger');
        const firstEdge = (edges || []).find((e) => e.source === trig?.id);
        const startId = firstEdge?.target;
        if (startId) {
          let convoAuto = await Conversation.findOne({ phone, clientId: client.clientId });
          if (!convoAuto) {
            convoAuto = await Conversation.create({
              phone,
              clientId: client.clientId,
              channel: 'whatsapp',
              status: 'active',
              lastStepId: null,
              source: `auto/${parsedMessage.type}`,
            });
          }
          const leadAuto = await AdLead.findOne({ phoneNumber: phone, clientId: client.clientId }).lean();
          await walkFlow({
            client,
            phone,
            flow: { _id: automationFlow._id, flowId: automationFlow.flowId, nodes, edges },
            currentNodeId: startId,
            convo: convoAuto,
            lead: leadAuto || { phoneNumber: phone },
            userMessage: `__event:${parsedMessage.type}__`,
            suppressConversationPersistence: true,
          });
        }
        return true;
      }
    }

    // --- STEP 0: SESSION UPSERT (Mandatory for Keywords) ---
    let convo = await Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        {
          $setOnInsert: { phone, clientId: client.clientId, lastStepId: null, botPaused: false, status: 'BOT_ACTIVE' },
          $inc: { unreadCount: 1 },
          $set: { 
            lastInteraction: new Date(),
            ...(shouldSetCustomerName && { customerName: profileName })
          }
        },
        { upsert: true, new: true }
    );

    let lead = await AdLead.findOneAndUpdate(
        { phoneNumber: phone, clientId: client.clientId },
        { 
          $setOnInsert: { phoneNumber: phone, clientId: client.clientId, source: parsedMessage.referral ? 'Meta Ad' : 'Direct' },
          $set: { 
            lastInteraction: new Date(),
            lastInboundAt: new Date(),
            lastMessageContent: inboundText || `[${parsedMessage.type || 'Message'}]`,
            ...(shouldSetCustomerName && { name: profileName, nameSource: 'whatsapp' })
          }
        },
        { upsert: true, new: true }
    );

    // --- STEP 1: KEYWORD-FIRST BYPASS (Priority 1.0) ---
    // Instant triggers for "hi", "menu", etc. bypass AI overhead.
    if (inboundText && !convo.botPaused) {
        const KeywordTrigger = require('../models/KeywordTrigger');
        const triggers = await KeywordTrigger.find({ clientId: client.clientId, isActive: true });
        
        const matchedTrigger = triggers.find(t => {
            if (t.type === 'exact') return txtLower === t.keyword.toLowerCase();
            return txtLower.includes(t.keyword.toLowerCase()); // fuzzy/contains
        });

        if (matchedTrigger) {
            log.info(`[KeywordEngine] Instant match: ${matchedTrigger.keyword}. Bypassing AI.`);
            
            if (matchedTrigger.actionType === 'trigger_flow') {
                const flow = (client.visualFlows || []).find(f => f.id === matchedTrigger.targetId);
                if (flow) {
                    const startNode = findMatchingFlow(flattenFlowNodes(flow.nodes), inboundText) || findFlowStartNode(flattenFlowNodes(flow.nodes));
                    if (startNode) {
                        return await runFlow(client, phone, flow, startNode.id, { triggerSource: 'keyword' });
                    }
                }
            } else if (matchedTrigger.actionType === 'send_template') {
                const tpl = (client.messageTemplates || []).find(t => t.id === matchedTrigger.targetId);
                if (tpl && tpl.templateName) {
                    await sendWhatsAppTemplate({
                        phoneNumberId: client.phoneNumberId,
                        to: phone,
                        io,
                        clientConfig: client,
                        templateName: tpl.templateName,
                        languageCode: 'en_US'
                    });
                    return true;
                }
            }
        }
    }

    // --- STEP 2: SELECTIVE AI INGESTION (Phase 30) ---
    // Only call detection/translation if not handled by a keyword.
    const { detectLanguage, translateText } = require('./translationEngine');
    let detectedLanguage = 'en';
    
    if (inboundText && inboundText.length > 2) {
        try {
            detectedLanguage = await detectLanguage(inboundText, client?.geminiApiKey || process.env.GEMINI_API_KEY);
            parsedMessage.detectedLanguage = detectedLanguage;
        } catch (err) {
            log.warn('[Language] Detection skipped (Invalid Key/Timeout)');
        }
    }

  // ── PHASE 23: Track 5 — WhatsApp Flow Responses ──────────────────────────
  if (parsedMessage.type === 'interactive' && parsedMessage.interactive?.type === 'nfm_reply') {
      const flowDataStr = parsedMessage.interactive.nfm_reply?.response_json;
      if (flowDataStr) {
          try {
              const flowData = JSON.parse(flowDataStr);
              log.info(`[DualBrain] 🌊 Flow Response Received from ${phone}:`, flowData);
              
              // 1. Sync flow data to AdLead attributes
              const updates = {};
              for (const [key, val] of Object.entries(flowData)) {
                  if (['email', 'name', 'city', 'requirement', 'phone'].includes(key.toLowerCase())) {
                      updates[key.toLowerCase()] = val;
                  }
                  updates[`metadata.${key}`] = val;
              }
              
              const lead = await AdLead.findOneAndUpdate(
                  { phoneNumber: phone, clientId: client.clientId },
                  { $set: { ...updates, lastInteraction: new Date() } },
                  { upsert: true, new: true }
              );

              await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: 'Flow Completed' } });

              // --- Phase 23: Track 1 & 2 - Sequence Cancellation on Reply ---
              const FollowUpSequence = require('../models/FollowUpSequence');
              await FollowUpSequence.updateMany(
                  { clientId: client.clientId, leadId: lead._id, status: 'active' },
                  { $set: { status: 'cancelled', cancellationReason: 'User replied to flow' } }
              );

              if (io) io.to(`client_${client.clientId}`).emit('flow_completed', { phone, flowData });

              // Increment Analytics
              try {
                  const today = new Date().toISOString().split('T')[0];
                  await DailyStat.findOneAndUpdate(
                      { clientId: client.clientId, date: today },
                      { $inc: { flowsCompleted: 1 } },
                      { upsert: true }
                  );
              } catch (err) { log.error('[Analytics] Flow completion error:', { error: err.message }); }

              // 2. Transition to next node if in an active flow
              const convo = await Conversation.findOne({ phone, clientId: client.clientId });
              if (convo?.activeFlowId && convo?.lastStepId) {
                  const WhatsAppFlow = require("../models/WhatsAppFlow");
                  const flow = await WhatsAppFlow.findOne({ _id: convo.activeFlowId });
                  
                  if (flow) {
                      const flowNodes = flattenFlowNodes(flow.nodes || []);
                      const flowEdges = flow.edges || [];
                      
                      const autoEdge = flowEdges.find(e => 
                          e.source === convo.lastStepId && 
                          (!e.sourceHandle || e.sourceHandle === 'bottom' || e.sourceHandle === 'a')
                      );

                      if (autoEdge) {
                          log.info(`[FlowEngine] Flow logic resuming: ${convo.lastStepId} → ${autoEdge.target}`);
                          return await executeNode(
                              autoEdge.target, flowNodes, flowEdges,
                              client, convo, lead, phone, io, channel, parsedMessage
                          );
                      }
                  }
              }
              
              // 3. Fallback confirmation
              await sendWhatsAppText(client, phone, "Thank you! I've received your information.");
              analyzeConversationIntelligence(client, phone, convo);
              return true;
          } catch (e) {
              log.error('Flow Parse Error:', { error: e.message });
          }
      }
  }

  // STEP 2.4: Track Customer Intelligence (Phase 28 Track 2)
  if (lead && lead._id) {
    const CI = require('./customerIntelligence');
    CI.trackInteraction(client.clientId, phone, lead._id).catch(() => {});
  }

  // STEP 2.5: PHASE 25 - Referral Tracking & Fulfillment
  const incomingText = Object.keys(parsedMessage.text || {}).length ? parsedMessage.text.body || '' : '';
  const refCodeMatch = incomingText.match(/ref_([A-Z0-9]{6})/i);
  if (refCodeMatch && refCodeMatch[1]) {
    const ReferralEngine = require('./referralEngine');
    await ReferralEngine.processReferral(refCodeMatch[1], lead);
  }

  // --- Phase 28: Track 3 - Multilingual Translation (Incoming Context) ---
  const translationConfig = client.translationConfig || {};
  if (
      translationConfig.enabled && 
      inboundText && 
      detectedLanguage !== (translationConfig.agentLanguage || 'en')
  ) {
      const translated = await translateText(inboundText, translationConfig.agentLanguage || 'en', client?.geminiApiKey || process.env.GEMINI_API_KEY);
      if (translated && translated !== inboundText) {
          parsedMessage.translatedContent = translated;
          parsedMessage.originalText = inboundText;
      }
  }

  // STEP 3: Save inbound message to DB + emit to dashboard
  // Do not block first bot reply on heavy sentiment/intent enrichment.
  saveInboundMessage(phone, client.clientId, parsedMessage, io, channel, convo._id).catch((err) => {
    log.error('Deferred inbound save failed:', { error: err.message });
  });

  // STEP 3.5: SUBSCRIPTION LIMIT CHECK (Phase 23)
  const limits = await checkLimit(client._id, 'messages');
  if (!limits.allowed) {
      log.warn(`Limit Reached for ${client.clientId}. Halting DualBrain Engine processing.`);
      return true; 
  }
  // Track this transaction 
  await incrementUsage(client._id, 'messages', 1);

  // ── PHASE 30: Custom QR Scan Matching (Enterprise) ────────────────────────────────
  const qrRefMatch = incomingText.match(/(\(Ref:\s*(QR_[a-zA-Z0-9_]+)\))/i);
  if (qrRefMatch && qrRefMatch[2]) {
    const qrRefId = qrRefMatch[2].toUpperCase();
    const QRCodeModel = require('../models/QRCode');
    const scannedQr = await QRCodeModel.findOne({ shortCode: qrRefId, clientId: client._id });
    
    if (scannedQr) {
      log.info(`[DualBrain] 📷 QR Scan Detected for lead ${lead.phoneNumber}: ${scannedQr.name}`);
      
      // Update analytics
      await QRCodeModel.findByIdAndUpdate(scannedQr._id, { $inc: { scansTotal: 1 } });
      
      // CRM Integration: Tag the user
      const tagsToAdd = scannedQr.config?.tags || [];
      if (scannedQr.config?.utmSource) tagsToAdd.push(`Source: ${scannedQr.config.utmSource}`);
      tagsToAdd.push(`Scanned_${qrRefId}`);
      if (tagsToAdd.length > 0) {
        await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: { $each: tagsToAdd } } });
      }

      // FIX THE DEAD END: Award Instant Scan Points (Loyalty Hub)
      try {
        const walletService = require('./walletService');
        // Award 50 bonus points for stickiness
        await walletService.awardPoints(
          client.clientId, 
          phone, 
          'qr_scan_bonus', 
          50, 
          `Scanned Campaign QR: ${qrRefId}`
        );
        log.info(`[Loyalty] Awarded 50 points to ${phone} for scanning ${qrRefId}`);
      } catch (loyaltyErr) {
        log.error(`[Loyalty] Failed to award scan points:`, loyaltyErr.message);
      }

      // Fire webhook
      const { fireWebhookEvent } = require('./webhookDelivery');
      fireWebhookEvent(client.clientId, 'qr.scanned', { phone: lead.phoneNumber, qrCode: scannedQr.name, shortCode: scannedQr.shortCode });

      // Check for Direct-To-Flow logic
      if (scannedQr.config?.flowId && scannedQr.config.flowId !== '') {
        log.info(`[QR Logic] Redirecting ${lead.phoneNumber} to flow ${scannedQr.config.flowId}`);
        const targetFlow = (client.visualFlows || []).find(f => f.id === scannedQr.config.flowId);
        if (targetFlow) {
           const { findFlowStartNode } = require('./triggerEngine');
           const startNodeId = findFlowStartNode(targetFlow.nodes || []);
           if (startNodeId) {
              await sendWhatsAppText(client, phone, scannedQr.config?.welcomeMessage || `🎉 Welcome! We just added 50 VIP Points to your wallet for scanning that code! Loading ${scannedQr.name}...`);
              // Run the target flow directly
              return await runFlow(client, phone, targetFlow, startNodeId, { channel, triggerSource: `QR_${scannedQr.shortCode}` });
           }
        }
      } 
      
      // Standard reply
      const welcomeMsg = scannedQr.config?.welcomeMessage || `🎉 Welcome! We just added 50 VIP Points to your wallet for scanning that code! Type "WALLET" to check your balance.`;
      await sendWhatsAppText(client, phone, welcomeMsg);
      return true;
    }
  }

  // ── PHASE 20: Build Variable Context ONCE per message ────────────────────
  // This is passed to executeNode so variables are injected into all nodes
  let variableContext = {};
  try {
    variableContext = await buildVariableContext(client, phone, convo, lead);
  } catch (vcErr) {
    log.warn('buildVariableContext failed:', { error: vcErr.message });
  }
  // Store on parsedMessage so all downstream functions can access it
  parsedMessage._variableContext = variableContext;

  // ── PHASE 25: Track 7 — AI PRICE NEGOTIATION (Priority 0.7) ────────────────
  const NegotiationEngine = require('./negotiationEngine');
  if (NegotiationEngine.isNegotiationAttempt(incomingText)) {
      log.info(`[DualBrain] 🤖 Negotiation triggered for lead ${lead.phoneNumber}`);
      const negotiatedResponse = await NegotiationEngine.processNegotiation(client, lead, incomingText, convo, phone);
      if (negotiatedResponse) {
          await sendWhatsAppText(client, phone, negotiatedResponse);
          // Preempt further processing since we're handling the objection
          return true;
      }
  }

  // ── PHASE 22: EVALUATE AUTOMATION RULES ────────────────────────────────────
  const rulesActions = evaluateRules(client.automationRules, parsedMessage.text?.body, variableContext);
  if (rulesActions && rulesActions.length > 0) {
    const results = await executeRuleActions(rulesActions, client, phone, {});
    let ruleIntercepted = false;

    for (const msg of results.messages) {
      if (msg.startsWith('[TEMPLATE]')) {
        const tName = msg.replace('[TEMPLATE]', '').trim();
        await sendWhatsAppTemplate(client, phone, tName, [variableContext.first_name || '']);
      } else {
        await sendWhatsAppText(client, phone, msg);
      }
      ruleIntercepted = true;
    }

    if (results.tags && results.tags.length > 0) {
      await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: { $each: results.tags } } });
    }

    if (results.enrollSequences && results.enrollSequences.length > 0) {
      // Basic enrollment implementation for rules
      const FollowUpSequence = require('../models/FollowUpSequence');
      for (const seqId of results.enrollSequences) {
         try {
           const seqData = require('../data/sequenceTemplates').find(t => t.id === seqId);
           if (seqData) {
               const mappedSteps = seqData.steps.map(s => {
                  return {
                     type: s.type || 'whatsapp',
                     templateName: s.templateName,
                     content: s.content,
                     delayValue: s.delayValue,
                     delayUnit: s.delayUnit,
                     sendAt: new Date(Date.now() + (s.delayValue || 0) * 60000), // simplified
                     status: "pending"
                  };
               });
               await FollowUpSequence.create({
                  clientId: client.clientId,
                  leadId: lead._id,
                  phone: lead.phoneNumber,
                  name: seqData.name,
                  steps: mappedSteps
               });
           }
         } catch(e) {}
      }
    }

    if (results.pauseBot) {
       await Conversation.findByIdAndUpdate(convo._id, { botPaused: true, isBotPaused: true, botStatus: 'paused' });
       ruleIntercepted = true;
    }
    
    if (results.scoreAdjustments !== 0) {
       await AdLead.findByIdAndUpdate(lead._id, { $inc: { leadScore: results.scoreAdjustments } });
    }
    
    if (results.webhooks && results.webhooks.length > 0) {
       const axios = require('axios');
       for (const url of results.webhooks) {
          axios.post(url, { lead, convo, client, event: 'automation_rule_trigger' }).catch(e => log.error(`Webhook failed: ${url}`, e));
       }
    }

    // Phase 22 Routing Handoff trigger
    if (results.handoff) {
       // Just flag for routing engine processing (done later in phase 22)
       convo.assignedAgent = results.handoff;
       await Conversation.findByIdAndUpdate(convo._id, { assignedAgent: results.handoff });
    }

    if (ruleIntercepted) {
      log.info(`Rules Engine Intercepted message processing for ${phone}`);
      return true; 
    }
  }

  // ── PHASE 22: ROUTING ENGINE EVALUATION ──────────────────────────────────
  if (client.routingRules && client.routingRules.length > 0) {
     const routingDirective = evaluateRouting(client.routingRules, variableContext);
     if (routingDirective) {
        let assigned = null;
        if (routingDirective.type === 'specific') {
           assigned = routingDirective.agentId;
        } else if (routingDirective.type === 'round_robin' && routingDirective.agentIds?.length > 0) {
           // Round Robin Implementation: Fetch all assigned agents and find oldest lastAssignedTimestamp
           const User = require('../models/User');
           const agents = await User.find({ _id: { $in: routingDirective.agentIds } }).sort({ lastAssignedTimestamp: 1 });
           if (agents.length > 0) {
              const selectedAgent = agents[0];
              assigned = selectedAgent._id.toString();
              await User.findByIdAndUpdate(assigned, { lastAssignedTimestamp: new Date() });
           }
        }
        if (assigned && convo.assignedAgent !== assigned) {
           convo.assignedAgent = assigned;
           await Conversation.findByIdAndUpdate(convo._id, { assignedAgent: assigned });
           if (io) io.to(`client_${client.clientId}`).emit('agent_assigned', { phone, agentId: assigned });
        }
     }
  }
  
  // --- SMART ALERT DETECTION: "Call Now" ---
  // --- SMART ALERT DETECTION: "Call Now" & Escalation (Phase 21) ---
  // --- PHASE 21: DUAL-BRAIN PRIORITY KEYWORDS (OPT-IN/OUT) ---
  const userTextRaw   = (parsedMessage.text?.body || '').trim();
  const userTextLower = userTextRaw.toLowerCase();
  
  // ── PHASE 29: Track 7 — WALLET & PAYMENT COMMANDS (Priority -0.5) ──────────
  // ── PHASE 27 — LOYALTY & REWARDS COMMANDS (Priority -0.5) ──────────────────
  const loyaltyKeywords = ['wallet', 'points', 'redeem', 'rewards', 'point'];
  const isLoyaltyIntent = loyaltyKeywords.some(k => userTextLower.includes(k));
  
  if (isLoyaltyIntent || (parsedMessage.type === 'interactive' && parsedMessage.interactive?.button_reply?.id?.startsWith('loyalty_'))) {
    const { getLoyaltyStatus, redeemLoyaltyPoints } = require('../controllers/loyaltyController');
    const walletService = require('./walletService');
    const wallet = await walletService.getWallet(client.clientId, phone);

    // Handle Button Clicks (Redemption)
    if (parsedMessage.type === 'interactive' && parsedMessage.interactive?.button_reply?.id?.startsWith('loyalty_redeem_')) {
        const amount = parseInt(parsedMessage.interactive.button_reply.id.split('_').pop());
        log.info(`[Loyalty] User clicked redeem button for ₹${amount}`, { phone });
        
        // Wrap for express-like req/res compatibility if needed, or call controller logic directly
        const mockReq = { body: { clientId: client.clientId, phone, amount } };
        const mockRes = { 
            json: (data) => sendWhatsAppText(client, phone, `✅ *Success!* Your code *${data.code}* is ready. Use it for ₹${data.amount || amount} OFF!`),
            status: () => ({ json: (data) => sendWhatsAppText(client, phone, `❌ ${data.message}`) })
        };
        await require('../controllers/loyaltyController').redeemLoyaltyPoints(mockReq, mockRes);
        return true;
    }

    // Handle Balance Inquiry
    const balance = wallet?.balance || 0;
    const tier = wallet?.tier || 'Bronze';
    const currencyUnit = client.loyaltyConfig?.currencyUnit || 100;
    const pointsPerCurrency = client.loyaltyConfig?.pointsPerCurrency || 100;
    const cashValue = (balance / pointsPerCurrency).toFixed(0);

    let message = `🎁 *Your Loyalty Hub*\n\n`;
    message += `💰 Balance: *${balance} Points*\n`;
    message += `✨ Tier: *${tier}*\n`;
    message += `🎫 Value: *₹${cashValue} Credits*\n\n`;

    if (balance >= pointsPerCurrency * 10) { // Min ₹10 to show redeem
        message += `Ready to treat yourself? Click a button below to redeem your points for an instant discount code! 👇`;
        
        const buttons = [
            { id: 'loyalty_redeem_50', title: 'Redeem ₹50' },
            { id: 'loyalty_redeem_100', title: 'Redeem ₹100' }
        ];
        // Only show ₹100 if they have enough
        const finalButtons = balance >= pointsPerCurrency * 100 ? buttons : [buttons[0]];

        await sendWhatsAppInteractive(client, phone, {
            type: 'button',
            body: { text: message },
            action: { buttons: finalButtons.map(b => ({ type: 'reply', reply: b })) }
        });
    } else {
        message += `Earn more points by shopping! For every ₹${currencyUnit} spent, you get 10 points. 🛍️`;
        await sendWhatsAppText(client, phone, message);
    }
    return true;
  }

  // Legacy Reputation Hub early-exit removed: Review routing is now handled natively
  // by tryGraphTraversal via the 'positive' and 'negative' sourceHandles.

  if (['pay'].includes(userTextLower)) {
    if (userTextLower === 'pay' && convo.metadata?.lastOrder) {
      const payLink = await generatePaymentLink(client, lead, convo.metadata.lastOrder);
      await sendWhatsAppText(client, phone, `💳 *Complete your payment:*\n\nYour order #${convo.metadata.lastOrder.orderNumber} is ready. Total: ₹${convo.metadata.lastOrder.totalPrice}\n\nLink: ${payLink}\n\n_Valid for 30 minutes._`);
      return true;
    }
    // Wallet/Redeem existing logic would go here
  }
  
  const optOutKeywords = ['stop', 'unsubscribe', 'opt out', 'optout', 'cancel', 'quit', 'end', 'remove me', 'do not contact', 'halt', 'block bot'];
  const optInKeywords  = ['start', 'yes', 'subscribe', 'opt in', 'optin', 'resume', 'unpause'];

  // Double opt-in confirmation gate (must run before routing/flows).
  if (userTextLower === 'yes' || parsedMessage?.buttonReplyId === 'confirm_optin') {
    const pendingLead = await AdLead.findOne({
      phoneNumber: phone,
      clientId: client.clientId,
      optStatus: 'pending',
      pendingOptInExpiry: { $gt: new Date() },
    });
    if (pendingLead) {
      pendingLead.optStatus = 'opted_in';
      pendingLead.optInDate = new Date();
      pendingLead.optInMethod = 'double';
      pendingLead.pendingOptInCode = '';
      pendingLead.pendingOptInExpiry = null;
      pendingLead.whatsappMarketingEligible = true;
      pendingLead.optInHistory = pendingLead.optInHistory || [];
      pendingLead.optInHistory.unshift({
        event: 'confirmed',
        action: 'confirmed',
        source: 'double_opt_in',
        method: 'double',
        timestamp: new Date(),
      });
      await pendingLead.save();
      const welcome = client?.growthWidgetConfig?.welcomeMessage || `Welcome to ${client.businessName || 'our brand'} WhatsApp updates!`;
      await sendWhatsAppText(client, phone, welcome);
      return true;
    }
  }

  if (userTextLower === 'no') {
    const pendingLead = await AdLead.findOne({
      phoneNumber: phone,
      clientId: client.clientId,
      optStatus: 'pending',
      pendingOptInExpiry: { $gt: new Date() },
    });
    if (pendingLead) {
      pendingLead.optStatus = 'opted_out';
      pendingLead.optOutDate = new Date();
      pendingLead.optOutSource = 'double_opt_in_decline';
      pendingLead.pendingOptInCode = '';
      pendingLead.pendingOptInExpiry = null;
      pendingLead.whatsappMarketingEligible = false;
      pendingLead.optInHistory = pendingLead.optInHistory || [];
      pendingLead.optInHistory.unshift({
        event: 'opted_out',
        action: 'opted_out',
        source: 'double_opt_in_decline',
        timestamp: new Date(),
      });
      await pendingLead.save();
      await sendWhatsAppText(client, phone, "Understood. You won't receive marketing updates.");
      return true;
    }
  }

  // Re-permission campaign button / keyword confirmation
  const rePermissionYes = ['repermission_yes', 're_permission_yes', 'yes_sign_me_up', 'yes sign me up'];
  const rePermissionNo = ['repermission_no', 're_permission_no', 'no_thanks', 'no thanks'];
  const inboundButtonId = String(parsedMessage?.interactive?.button_reply?.id || '').toLowerCase().trim();
  if (rePermissionYes.includes(inboundButtonId) || userTextLower === 'yes sign me up') {
    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId, optStatus: { $in: ['unknown', 'pending', 'opted_out'] } },
      {
        $set: {
          optStatus: 'opted_in',
          optInDate: new Date(),
          optInMethod: 'single',
          optInSource: 're_permission_campaign',
          whatsappMarketingEligible: true,
        },
        $push: {
          optInHistory: {
            event: 'opted_in',
            action: 'opted_in',
            source: 're_permission_campaign',
            method: 'single',
            timestamp: new Date(),
          },
        },
      }
    );
    await sendWhatsAppText(client, phone, client?.growthWidgetConfig?.welcomeMessage || "You're subscribed to WhatsApp updates. Thank you!");
    return true;
  }
  if (rePermissionNo.includes(inboundButtonId) || userTextLower === 'no thanks') {
    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      {
        $set: {
          optStatus: 'opted_out',
          optOutDate: new Date(),
          optOutSource: 're_permission_campaign',
          whatsappMarketingEligible: false,
        },
        $push: {
          optInHistory: {
            event: 'opted_out',
            action: 'opted_out',
            source: 're_permission_campaign',
            timestamp: new Date(),
          },
        },
      }
    );
    try {
      const SuppressionList = require('../models/SuppressionList');
      await SuppressionList.findOneAndUpdate(
        { clientId: client.clientId, phone },
        { $set: { reason: 'opted_out', source: 're_permission_campaign', addedAt: new Date() } },
        { upsert: true }
      );
    } catch (_) {}
    await sendWhatsAppText(client, phone, "Understood. We won't send marketing updates.");
    return true;
  }

  if (optOutKeywords.some(k => userTextLower === k || userTextLower.startsWith(`${k} `))) {
    log.info(`🛑 Opt-out detected for ${phone}. Pausing bot.`);
    
    await Conversation.findByIdAndUpdate(convo._id, { 
       botPaused: true, 
       isBotPaused: true, 
       botStatus: 'paused',
       status: 'OPTED_OUT' 
    });

    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      { 
        $set: { 
          optStatus: 'opted_out', 
          optOutDate: new Date(), 
          optOutSource: 'keyword_stop',
          optOutReason: 'user_keyword',
          optOutKeyword: userTextRaw 
        },
        $addToSet: { tags: 'Opted Out' },
        $push: {
          optInHistory: {
            event: 'opted_out',
            action: 'opted_out',
            timestamp: new Date(),
            source: 'user_keyword',
            note: `User sent: "${userTextRaw}"`
          }
        }
      }
    );
    try {
      const SuppressionList = require('../models/SuppressionList');
      await SuppressionList.findOneAndUpdate(
        { clientId: client.clientId, phone },
        {
          $set: {
            reason: 'opted_out',
            source: 'keyword_stop',
            addedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (_) {}

    // Broadcast update
    if (io) io.to(`client_${client.clientId}`).emit('lead_opted_out', { phone });

    await sendWhatsAppText(client, phone, "You've been unsubscribed. You will no longer receive automated messages. Reply START anytime to re-subscribe.");
    
    // Notify Admin
    const NotificationService = require('./notificationService');
    await NotificationService.sendAdminAlert(client, {
      customerPhone: phone,
      topic: "🔕 USER OPTED OUT",
      triggerSource: `User sent "${userTextRaw}". Bot is now PAUSED for this user.`,
      channel: 'both'
    });
    return true; // Stop execution
  }

  if (optInKeywords.some(k => userTextLower === k)) {
    log.info(`✅ Opt-in detected for ${phone}. Resuming bot.`);
    
    await Conversation.findByIdAndUpdate(convo._id, { 
      botPaused: false, 
      isBotPaused: false, 
      status: 'BOT_ACTIVE' 
    });

    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      { 
        $set: { 
          optStatus: 'opted_in', 
          optInDate: new Date(), 
          optInSource: 'keyword',
          optInMethod: 'single',
        },
        $pull: { tags: 'Opted Out' },
        $addToSet: { tags: 'Opted In' },
        $push: {
          optInHistory: {
            event: 'opted_in',
            action: 're_opted_in',
            timestamp: new Date(),
            source: 'user_keyword'
          }
        }
      }
    );
    try {
      const SuppressionList = require('../models/SuppressionList');
      await SuppressionList.deleteOne({ clientId: client.clientId, phone });
    } catch (_) {}

    // Broadcast update
    if (io) io.to(`client_${client.clientId}`).emit('lead_opted_in', { phone });

    await sendWhatsAppText(client, phone, "Welcome back! Automations have been resumed. How can I help you today?");
    return true; // Stop execution
  }

  const userText = userTextLower;
  const escalationKeywords = [
    // Phone/call requests
    'call me', 'call now', 'want to talk', 'need a call', 'phone call', 'speak to a human', 'support agent', 'give me a call', 'call karo', 'callback',
    // Human requests
    'talk to human', 'talk to person', 'talk to agent', 'real person',
    'customer care', 'customer support', 'support team',
    'insaan se baat', 'banda chahiye',
    // Frustration signals
    'not happy', 'very bad', 'worst service', 'frustrated', 'where is my order',
    'money back', 'refund', 'complaint', 'escalate'
  ];

  if (escalationKeywords.some(k => userText.includes(k))) {
      const NotificationService = require('./notificationService');
      
      const DashboardLink = `https://dash.topedgeai.com/live-chat?phone=${encodeURIComponent(phone)}`;
      const cartInfo = parseInt(lead?.addToCartCount) > 0 ? `Total Carts: ${lead.addToCartCount}` : 'No carts yet';
      const orderInfo = lead?.isOrderPlaced ? `Orders: ${lead.ordersCount} | Spent: ${lead.totalSpent}` : 'No orders yet';

      await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          topic: "🚨 AGENT REQUEST — Attention Needed",
          triggerSource: `💬 "${userText}"\n👤 ${lead?.name || 'Unknown'}\n🛒 ${cartInfo}\n📦 ${orderInfo}\n🔗 ${DashboardLink}`,
          channel: 'both'
      });
      if (io) {
          io.to(`client_${client.clientId}`).emit('attention_required', {
              phone,
              reason: "Lead requested human intervention — prioritize!",
              priority: 'high'
          });
      }
      // Optional: Pause bot or mark for takeover
      await Conversation.findByIdAndUpdate(convo._id, { status: 'HUMAN_TAKEOVER', requiresAttention: true });
      try {
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { pendingSupport: true } }
        );
      } catch (err) {}
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

  // STEP 4: Human Takeover or Manual Mode Checks
  const handoffMode = client.handoffMode || 'AUTO';
  const handoffTimeoutMin = client.handoffTimeout || 30;

  // Check if a human recently replied (Hybrid Mode)
  if (handoffMode === 'HYBRID' || convo.status === 'HUMAN_SUPPORT') {
    const lastHumanMsg = await Message.findOne({ 
      conversationId: convo._id, 
      direction: 'outbound',
      sender: { $ne: 'assistant' } // Not bot
    }).sort({ createdAt: -1 });

    if (lastHumanMsg) {
      const minutesSinceHuman = (new Date() - new Date(lastHumanMsg.createdAt)) / 60000;
      if (minutesSinceHuman < handoffTimeoutMin) {
        log.info(`⏸️ Hybrid Handoff: Human replied ${minutesSinceHuman.toFixed(1)}m ago. Bot silent.`);
        return true;
      }
    }
  }

  const pausedOrHuman =
    convo.botPaused || ["HUMAN_TAKEOVER", "HUMAN_SUPPORT", "OPTED_OUT"].includes(convo.status);
  if (pausedOrHuman) {
    const t = (userText || "").trim();
    const resumeKeywords = /^(menu|hi|hello|hey|start|help|main menu)$/i;
    const canResumeFromHandoff =
      ["HUMAN_SUPPORT", "HUMAN_TAKEOVER"].includes(convo.status) && resumeKeywords.test(t);
    if (canResumeFromHandoff) {
      log.info(`[DualBrain] Resuming bot after handoff for ${phone} (keyword: "${t}")`);
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          botPaused: false,
          isBotPaused: false,
          botStatus: "active",
          status: "BOT_ACTIVE",
          requiresAttention: false,
          attentionReason: "",
          lastStepId: null,
          waitingForVariable: null,
          captureResumeNodeId: null,
        },
      });
      convo.botPaused = false;
      convo.isBotPaused = false;
      convo.botStatus = "active";
      convo.status = "BOT_ACTIVE";
      convo.requiresAttention = false;
      convo.lastStepId = null;
    } else if (convo.status === "OPTED_OUT") {
      log.info(`⏸️ Opted out for ${phone}. Skipping.`);
      analyzeConversationIntelligence(client, phone, convo);
      return true;
    } else {
      log.info(`⏸️ Bot paused for ${phone} (Status: ${convo.status}). Skipping.`);
      analyzeConversationIntelligence(client, phone, convo);
      return true;
    }
  }

  // MANUAL MODE: Only respond if an EXPLICIT trigger is matched

  if (handoffMode === 'MANUAL') {
    const trigger = findMatchingFlow(userText, client.flowNodes, client.flowEdges);
    if (!trigger) {
      log.info(`🙊 Manual Mode: No trigger match for "${userText}". Bot silent.`);
      return true;
    }
  }

  // ── PRIORITY -1: GLOBAL INTERRUPT KEYWORDS ───────────────────────────────
  // SAFETY NET: Before any flow processing, check if user is requesting abort.
  // This prevents users from being trapped in infinite loops or multi-step flows.
  const _globalInterruptKeywords = {
    optOut: ['stop', 'unsubscribe', 'opt out', 'halt', 'block bot'],
    humanHandoff: ['talk to human', 'talk to agent', 'talk to person', 'agent', 'human', 'real person', 'customer care', 'support']
  };
  const _isInActiveFlow = !!(convo.lastStepId || convo.status === 'WAITING_FOR_INPUT');
  if (_isInActiveFlow && userTextLower) {
    // Check opt-out interrupts
    if (_globalInterruptKeywords.optOut.some(k => userTextLower === k)) {
      log.info(`🛑 [GlobalInterrupt] Opt-out "${userTextLower}" detected mid-flow for ${phone}. Aborting flow.`);
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: { botPaused: true, isBotPaused: true, botStatus: 'paused', status: 'OPTED_OUT', lastStepId: null, waitingForVariable: null, captureResumeNodeId: null }
      });
      await sendWhatsAppText(client, phone, "You've been unsubscribed. You will no longer receive automated messages. Reply START anytime to re-subscribe.");
      return true;
    }
    // Check human handoff interrupts
    if (_globalInterruptKeywords.humanHandoff.some(k => userTextLower.includes(k))) {
      log.info(`🙋 [GlobalInterrupt] Human request "${userTextLower}" detected mid-flow for ${phone}. Aborting flow.`);
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          status: 'HUMAN_TAKEOVER',
          requiresAttention: true,
          botPaused: true,
          isBotPaused: true,
          botStatus: 'paused',
          lastStepId: null,
          waitingForVariable: null,
          captureResumeNodeId: null
        }
      });
      if (io) {
        io.to(`client_${client.clientId}`).emit('attention_required', { phone, reason: 'User requested human agent mid-flow', priority: 'high' });
        Conversation.findById(convo._id).then((fresh) => {
          if (fresh) io.to(`client_${client.clientId}`).emit('conversation_update', fresh.toObject());
        }).catch(() => {});
        io.to(`client_${client.clientId}`).emit('botStatusChanged', {
          conversationId: String(convo._id),
          botStatus: 'paused'
        });
      }
      await sendWhatsAppText(client, phone, "I'm connecting you with a member of our team right now. Please hold! 👤");
      return true;
    }
  }

  // ── PRIORITY 0: CAPTURE MODE ─────────────────────────────────────────────
  // If bot is waiting for text input from this user, handle it NOW.
  if (convo.status === 'WAITING_FOR_INPUT' && convo.waitingForVariable) {
    const lastInteraction = convo.updatedAt || convo.lastMessageAt || new Date();
    const hoursSinceLast = (new Date() - new Date(lastInteraction)) / 3600000;
    
    // Safeguard 4: 24-hour TTL check
    if (hoursSinceLast > 24) {
      log.info(`⏰ Capture state expired (24h+). Clearing wait state for ${phone}.`);
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: { status: 'BOT_ACTIVE', waitingForVariable: null, captureResumeNodeId: null, captureRetries: 0 }
      });
      // Fall through to normal processing (treat as fresh intent)
    } else {
      const capturedText = (parsedMessage.text?.body || '').trim();
      if (!capturedText) return true; // Wait for actual text

      const varName = convo.waitingForVariable;
      // BUG FIX: Use WhatsAppFlow collection (same as cron fix) instead of legacy client.flowNodes
      const { nodes: _capNodes, edges: _capEdges } = await getFlowGraphForConversation(client, convo);
      const flatNodes = _capNodes;
      const captureNode = flatNodes.find(n => n.id === convo.lastStepId);
      
      // Safeguard 2: Validation Logic
      const expectedType = captureNode?.data?.expectedType || 'string';
      const validationErrorMsg = captureNode?.data?.validationErrorMessage || "Please provide a valid response.";
      const maxRetries = captureNode?.data?.maxRetries || 3;
      
      let isValid = true;
      if (expectedType === 'number') isValid = !isNaN(Number(capturedText));
      else if (expectedType === 'email') isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(capturedText);
      else if (expectedType === 'phone') isValid = /^\+?[\d\s-]{8,20}$/.test(capturedText);
      else if (expectedType === 'date')  isValid = !isNaN(Date.parse(capturedText));

      if (!isValid) {
        const retries = (convo.captureRetries || 0) + 1;
        log.info(`⚠️ Validation failed for ${varName} (Type: ${expectedType}). Attempt: ${retries}/${maxRetries}`);
        
        if (retries >= maxRetries) {
          // Safeguard 1: Infinite Loop Trap -> Escalate
          log.warn(`🚨 Max retries (${maxRetries}) reached for ${phone}. Escalating to human.`);
          await Conversation.findByIdAndUpdate(convo._id, {
            $set: {
              status: 'HUMAN_SUPPORT',
              botPaused: true,
              isBotPaused: true,
              botStatus: 'paused',
              requiresAttention: true,
              attentionReason: 'Validation failed — human support',
              waitingForVariable: null,
              captureResumeNodeId: null,
              captureRetries: 0
            }
          });
          await WhatsApp.sendText(client, phone, "I'm having trouble understanding. Let me connect you with a member of our team! 👤");
        } else {
          await Conversation.findByIdAndUpdate(convo._id, { $inc: { captureRetries: 1 } });
          await WhatsApp.sendText(client, phone, validationErrorMsg);
        }
        return true; // Still waiting
      }

      // Successful capture
      const updatedMetadata = { ...(convo.metadata || {}), [varName]: capturedText };
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          metadata:            updatedMetadata,
          status:              'BOT_ACTIVE',
          waitingForVariable:  null,
          captureResumeNodeId: null,
          captureRetries:      0,
          lastStepId:          convo.captureResumeNodeId || convo.lastStepId || null
        }
      });
      
      // Persist to AdLead
      try {
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { [`capturedData.${varName}`]: capturedText } }
        );
      } catch (_) {}

      log.info(`✅ Captured "${capturedText}" → "${varName}". Resuming flow...`);

      // Resume from captureResumeNodeId
      if (convo.captureResumeNodeId) {
        const freshConvo = await Conversation.findById(convo._id);
        freshConvo.metadata = updatedMetadata;
        return await executeNode(
          convo.captureResumeNodeId, flatNodes, _capEdges,
          client, freshConvo, lead, phone, io, channel, parsedMessage
        );
      }
      return true;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Phase 17: Check for Flow Delay
  if (convo.flowPausedUntil && new Date() < convo.flowPausedUntil) {
    log.info(`⏳ Flow still paused for ${phone}. Responding via AI or skipping...`);
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

  // ── PHASE 25: Track 7 — AI PRICE NEGOTIATION (Priority 0.7) ────────────────
  if (parsedMessage.text?.body && client.negotiationSettings?.enabled) {
    const { processNegotiation } = require('./negotiationEngine');
    const negResult = await processNegotiation(client, convo, phone, parsedMessage.text.body, lead);
    if (negResult.handled) {
      if (negResult.reply) {
        await sendWhatsAppText(client, phone, negResult.reply);
      }
      return true; // Stop traversal, AI negotiated
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── PHASE 20: TRIGGER ENGINE — Route to correct visualFlow ───────────────
  // Only fires when user is NOT already mid-flow (no lastStepId)
  const isUserMidFlow = convo.lastStepId && convo.lastStepId.trim();
  if (!isUserMidFlow) {

    // ── PHASE 24: QR CODE DETECTION (runs FIRST — highest priority on fresh conversations) ──
    // Pattern: QR_[A-F0-9]{8} (e.g. "QR_A1B2C3D4")
    const rawText = (parsedMessage.text?.body || '').trim();
    const qrPattern = /^QR_[A-F0-9]{8}$/i;
    if (qrPattern.test(rawText)) {
      try {
        const QRCode = require('../models/QRCode');
        const QRScan = require('../models/QRScan');
        const qr = await QRCode.findOne({ shortCode: rawText.toUpperCase(), isActive: true }).lean();
        if (qr) {
          log.info(`📱 QR code scanned by ${phone}: ${rawText}`);

          // Track scan — compound index prevents duplicate unique scans
          const isUnique = !(await QRScan.exists({ qrCodeId: qr._id, phone }));
          await QRScan.findOneAndUpdate(
            { qrCodeId: qr._id, phone },
            { $setOnInsert: { qrCodeId: qr._id, phone, scannedAt: new Date() } },
            { upsert: true }
          );
          await require('../models/QRCode').findByIdAndUpdate(qr._id, {
            $inc: { scansTotal: 1, ...(isUnique ? { scansUnique: 1 } : {}) }
          });

          // Tag the lead
          await AdLead.findOneAndUpdate(
            { phoneNumber: phone, clientId: client.clientId },
            {
              $addToSet: { tags: `qr:${qr.name}` },
              $set: { 'meta.lastQRCode': rawText, 'meta.lastQRCodeName': qr.name }
            }
          );

          // Fire webhook event (fire-and-forget)
          try {
            const { fireWebhookEvent } = require('./webhookDelivery');
            const clientDoc = await Client.findOne({ clientId: client.clientId });
            fireWebhookEvent(clientDoc._id, 'qr.scanned', {
              phone, qrCode: qr.name, shortCode: rawText, isFirstScan: isUnique
            });
          } catch (_) {}

          // Apply discount if configured
          if (qr.config?.discountCode) {
            await AdLead.findOneAndUpdate(
              { phoneNumber: phone, clientId: client.clientId },
              { $set: { activeDiscountCode: qr.config.discountCode } }
            );
          }

          // Execute attached flow if present
          if (qr.config?.flowId) {
            const attachedFlow = (client.visualFlows || []).find(f => f.id === qr.config.flowId);
            if (attachedFlow && attachedFlow.nodes?.length) {
              const qrFlowNodes = flattenFlowNodes(attachedFlow.nodes);
              const qrStartNode = findFlowStartNode(qrFlowNodes, attachedFlow.edges || []);
              if (qrStartNode) {
                await Conversation.findByIdAndUpdate(convo._id, { activeFlowId: attachedFlow.id });
                const freshConvo = await Conversation.findById(convo._id);
                return await executeNode(qrStartNode, qrFlowNodes, attachedFlow.edges || [], client, freshConvo, lead, phone, io, channel);
              }
            }
          }

          // Send welcome message if no flow attached
          if (qr.config?.welcomeMessage) {
            await sendWhatsAppText(client, phone, qr.config.welcomeMessage);
            return true;
          }
          // Fall through to normal flow processing if no flow/message configured
        }
      } catch (qrErr) {
        log.error('QR detection error:', { error: qrErr.message });
        // Non-fatal — fall through
      }
    }

    // ── PHASE 24: META ADS FLOW ROUTING (after QR, before triggerEngine) ──
    // If fresh conversation AND lead came from a Meta Ad, check for attached flow
    if (!convo.lastStepId) {
      try {
        const adId = lead?.adAttribution?.adId;
        if (adId) {
          const MetaAd = require('../models/MetaAd');
          const clientDoc = await Client.findOne({ clientId: client.clientId });
          const metaAd = await MetaAd.findOne({ clientId: clientDoc?._id, metaAdId: adId }).lean();

          if (metaAd) {
            // Send custom welcome message if set
            if (metaAd.customWelcomeMessage) {
              await sendWhatsAppText(client, phone, metaAd.customWelcomeMessage);
            }

            // Execute attached flow
            if (metaAd.attachedFlowId) {
              const adFlow = (client.visualFlows || []).find(f => f.id === metaAd.attachedFlowId);
              if (adFlow && adFlow.nodes?.length) {
                const adFlowNodes = flattenFlowNodes(adFlow.nodes);
                const adStartNode = findFlowStartNode(adFlowNodes, adFlow.edges || []);
                if (adStartNode) {
                  log.info(`🎯 Meta Ad flow: routing ${phone} to flow "${adFlow.name}" from ad "${metaAd.adName}"`);
                  await Conversation.findByIdAndUpdate(convo._id, { activeFlowId: adFlow.id });
                  const freshConvo = await Conversation.findById(convo._id);
                  return await executeNode(adStartNode, adFlowNodes, adFlow.edges || [], client, freshConvo, lead, phone, io, channel);
                }
              }
            }

            // Update ad TopEdge stats (increment lead count)
            await MetaAd.findByIdAndUpdate(metaAd._id, {
              $inc: { 'topedgeStats.leadsCount': 1 }
            });
          }
        }
      } catch (adErr) {
        log.error('Meta Ad routing error:', { error: adErr.message });
        // Non-fatal — fall through to normalflow
      }
    }

    try {
      const match = await findMatchingFlow(parsedMessage, client, convo);
      if (match && !match.isLegacy && match.flow) {
        const flow       = match.flow;
        const flowNodes  = flattenFlowNodes(flow.nodes || []);
        const flowEdges  = flow.edges || [];
        const startNodeId = findFlowStartNode(flowNodes, flowEdges);

        log.info(`[TriggerEngine] Matched flow "${flow.name || flow.id}" via ${match.triggerType}. Starting at node: ${startNodeId}`);

        if (startNodeId && flowNodes.length) {
          // Track which flow is now active
          await Conversation.findByIdAndUpdate(convo._id, {
            activeFlowId: flow.id || null,
            lastMessageAt: new Date()
          });
          const freshConvo = await Conversation.findById(convo._id);
          return await executeNode(
            startNodeId, flowNodes, flowEdges,
            client, freshConvo, lead, phone, io, channel
          );
        }
      }
    } catch (triggerErr) {
      log.error('[TriggerEngine] Error matching flow:', { error: triggerErr.message });
      // Fall through to regular graph traversal
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // STEP 5: PRIORITY 1 — Graph Traversal
  const graphHandled = await tryGraphTraversal(parsedMessage, client, convo, lead, phone, io, channel);
  if (graphHandled) return true;

  // STEP 6: PRIORITY 2 — Keyword Fallback
  const keywordHandled = await tryKeywordFallback(parsedMessage, client, convo, phone, channel);
  if (keywordHandled) return true;

  // STEP 7: PRIORITY 3 — Gemini AI Fallback
  // Only use AI if there is text body. Otherwise, let the caller handle it.
  if (parsedMessage.text?.body) {
    await runAIFallback(parsedMessage, client, phone, lead, channel, convo);
    analyzeConversationIntelligence(client, phone, convo);
    return true;
  }
  
  // Return false so the engine can process legacy interactive IDs
  analyzeConversationIntelligence(client, phone, convo);
    return false;
  } catch (err) {
      log.error(`[DualBrain] Critical Engine Error for ${phone}:`, err.message);
      return false;
  } finally {
      // Release distributed lock — only if WE own it
      try {
          if (redisClient && redisClient.status === 'ready') {
              // Atomically verify ownership and delete
              const script = `
                  if redis.call("get",KEYS[1]) == ARGV[1] then
                      return redis.call("del",KEYS[1])
                  else
                      return 0
                  end
              `;
              await redisClient.eval(script, 1, lockKey, _lockOwnerId);
          } else {
              await ProcessingLock.deleteOne({ phone, clientId: client.clientId, _lockOwnerId });
          }
      } catch (releaseErr) {
          log.error(`[Lock] Release failed for ${phone}:`, releaseErr.message);
      }
      // TTL Safety: Warn if engine run approached the 30-second lock timeout
      const _lockElapsed = Date.now() - _lockStartTime;
      if (_lockElapsed > 25000) {
        log.warn(`[Lock] ⚠️ Engine took ${_lockElapsed}ms for ${phone} — close to 30s TTL limit!`);
      }
      log.info(`[DualBrain] Completed for ${phone} in ${Date.now() - _lockStartTime}ms`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 1: GRAPH TRAVERSAL
// ─────────────────────────────────────────────────────────────────────────────
async function tryGraphTraversal(parsedMessage, client, convo, lead, phone, io, channel = 'whatsapp') {
  const { nodes: flowNodes, edges: flowEdges } = await getFlowGraphForConversation(client, convo);

  log.info(`[Graph] Traversal start. currentStep=${convo.lastStepId || 'none'}, flowNodes=${flowNodes.length}, flowEdges=${flowEdges.length}`);
  if (!flowNodes.length) return false;

  // BUG 1 FIX: Construct incomingTrigger from parsedMessage — was previously
  // undefined, causing a fatal ReferenceError on any unwired button click.
  const incomingTrigger = {
    buttonId: parsedMessage.interactive?.button_reply?.id
           || parsedMessage.interactive?.list_reply?.id
           || parsedMessage.button?.payload
           || null
  };

  const currentStepId   = convo.lastStepId;
  const userText        = (parsedMessage.text?.body || '').trim();
  const userTextLower   = userText.toLowerCase();

  const buttonId = parsedMessage.interactive?.button_reply?.id 
                || parsedMessage.interactive?.list_reply?.id 
                || parsedMessage.button?.payload 
                || '';

  // Ecommerce webhook events should only be routed via the trigger engine, not graph traversal
  // Graph traversal requires an actual user interaction
  const isEcommerceEvent = !userText && !buttonId && 
    (parsedMessage?.type === 'order_placed' || parsedMessage?.type === 'abandoned_cart' || 
     parsedMessage?.type === 'order_fulfilled' || parsedMessage?.referral?.ctwa_clid === undefined);
  
  if (isEcommerceEvent && !currentStepId) {
    log.info(`[Graph] Skipping traversal for ecommerce event with no user text for ${phone}`);
    return false;
  }

  // A) GLOBAL KEYWORD / ROLE JUMP
  // Guard: Only run keyword/role jump if there is actual user text to match.
  // Empty text from ecommerce webhooks must NEVER trigger a keyword jump.
  let jumpNode = null;
  if (userTextLower && userTextLower.length > 0) {
    jumpNode = flowNodes.find(n => {
      const role = String(n.data?.role || '').toLowerCase();
      // Support BOTH array and comma-string keyword formats
      const keywordsRaw = n.data?.keywords;
      let keywords;
      if (Array.isArray(keywordsRaw)) {
        keywords = keywordsRaw.map(k => String(k).toLowerCase().trim()).filter(Boolean);
      } else {
        keywords = String(keywordsRaw || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
      }
      return (role && userTextLower === role) || (keywords.length > 0 && keywords.includes(userTextLower));
    });
  }

  if (jumpNode) {
    log.info(`Graph: Jumping to node ${jumpNode.id} based on keyword/role match "${userTextLower}"`);
    return await executeNode(jumpNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // B) Handle CAPTURE_INPUT Node
  const currentNode = flowNodes.find(n => n.id === currentStepId);
  if (currentNode && (currentNode.type === 'capture_input' || currentNode.type === 'CaptureNode')) {
    const varName = currentNode.data?.variable || 'last_input';
    log.info(`Capture: Saving "${userText}" to variable "${varName}" for convo ${phone}`);
    const updatedMetadata = { ...(convo.metadata || {}), [varName]: userText };
    await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
    convo.metadata = updatedMetadata;

    await AdLead.findByIdAndUpdate(lead._id, {
      $set: { [`capturedData.${varName}`]: userText },
      $push: {
        captureHistory: {
          field: varName,
          value: userText,
          capturedAt: new Date(),
          flowNodeId: currentNode.id
        }
      }
    });

    // Update local lead object so subsequent nodes see it
    lead.capturedData = { ...(lead.capturedData || {}), [varName]: userText };

    const nextEdge = flowEdges.find(e => e.source === currentStepId);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
    return true; 
  }

  // C) User is in the middle of a flow
  let matchingEdge = null;
  let edgeMatchMode = null;
  const sourceEdges = flowEdges.filter(e => e.source === currentStepId);
  const bid = normalizeHandleId(buttonId).toLowerCase();

  // First priority: explicit button/list selections
  if (bid) {
    matchingEdge = sourceEdges.find((e) => {
      const sid = normalizeHandleId(e.sourceHandle || '').toLowerCase();
      if (sid && sid === bid) return true;
      if (e.trigger?.type === 'button') {
        return normalizeHandleId(e.trigger.value || '').toLowerCase() === bid;
      }
      return false;
    });
    // DEBUG: Log button ID mismatch for diagnostics
    if (!matchingEdge) {
      const availableHandles = sourceEdges.map(e => normalizeHandleId(e.sourceHandle || '')).filter(Boolean);
      log.warn(`[Graph] Button ID mismatch: incoming="${bid}", available sourceHandles=[${availableHandles.join(', ')}], currentStep=${currentStepId}`);
    }
    if (matchingEdge) edgeMatchMode = 'interactive';
  }

  // C.1) Stale interactive: user tapped a button/list on an older bubble while lastStepId moved on.
  if (bid && !matchingEdge) {
    const resolved = findInteractiveEdgeForButtonAcrossGraph(flowNodes, flowEdges, buttonId, currentStepId);
    if (resolved) {
      matchingEdge = resolved;
      edgeMatchMode = 'interactive_cross_step';
      log.info(`[Graph] Resolved cross-step interactive: button "${bid}" via source ${resolved.source} → ${resolved.target} (edge ${resolved.id})`);
    }
  }

  // Second priority: typed text keyword/sourceHandle matches
  if (!matchingEdge && userTextLower) {
    matchingEdge = sourceEdges.find((e) => {
      const sid = normalizeHandleId(e.sourceHandle || '').toLowerCase();
      if (sid && (sid === userTextLower || userTextLower === sid)) return true;
      if (e.trigger?.type === 'keyword') return userTextLower.includes(String(e.trigger.value || '').toLowerCase());
      return false;
    });
    if (matchingEdge) edgeMatchMode = 'text_match';
  }

  // Last priority: auto-forward edge only when there is no explicit user selection
  if (!matchingEdge && !bid) {
    const autoHandles = ['a', 'bottom', 'output', 'default', null, undefined, ''];
    matchingEdge = sourceEdges.find((e) => !e.trigger && autoHandles.includes(normalizeHandleId(e.sourceHandle)));
    if (matchingEdge) edgeMatchMode = 'auto_default';
  }

  // GAP FIX: Fallback edge
  if (!matchingEdge && currentStepId) {
    matchingEdge = flowEdges.find(e => e.source === currentStepId && normalizeHandleId(e.sourceHandle) === 'fallback');
    if (matchingEdge) edgeMatchMode = 'fallback';
  }

  // BUG 1 FIX: Unwired Button -> AI Fallback natively
  if (!matchingEdge && incomingTrigger.buttonId) {
    log.info(`[Button Route] Unwired button clicked: ${incomingTrigger.buttonId} (${userText}). Routing to AI Fallback natively.`);
    await logFlowEvent({
      clientId: client.clientId,
      flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
      nodeId: currentStepId || 'unknown',
      nodeType: currentNode?.type || 'unknown',
      phone,
      action: 'failure',
      metadata: {
        reason: 'unwired_button',
        input: incomingTrigger.buttonId,
        channel
      }
    });
    // Store button text inside parsedMessage to ensure AI context receives it
    if (!parsedMessage.text) parsedMessage.text = {};
    if (!parsedMessage.text.body) {
         parsedMessage.text.body = parsedMessage.interactive?.button_reply?.title || parsedMessage.interactive?.list_reply?.title || parsedMessage.button?.text || userText || incomingTrigger.buttonId;
    }
    try {
      return await runAIFallback(parsedMessage, client, phone, lead, channel, convo);
    } catch (aiErr) {
      log.error('[Graph] AI fallback failed for unwired button:', { error: aiErr.message });
      return false;
    }
  }

  if (matchingEdge) {
    log.info(`Graph: edge match from ${currentStepId} → ${matchingEdge.target}`);
    await logFlowEvent({
      clientId: client.clientId,
      flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
      nodeId: currentStepId || matchingEdge.source || 'unknown',
      nodeType: currentNode?.type || 'unknown',
      phone,
      action: 'edge_transition',
      metadata: {
        toNodeId: matchingEdge.target,
        sourceHandle: matchingEdge.sourceHandle || null,
        targetHandle: matchingEdge.targetHandle || null,
        mode: edgeMatchMode || 'matched'
      }
    });
    return await executeNode(matchingEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // D) GLOBAL RESET / GREETING / AI INTENT
  if (!incomingTrigger.buttonId) {
      // 1. Check Keywords — ONLY if user actually typed something
      let matchingTrigger = null;
      if (userTextLower && userTextLower.length > 0) {
        matchingTrigger = flowNodes.find(n => {
          if (n.type !== 'trigger' && n.type !== 'TriggerNode') return false;
          // Support BOTH new format (keywords array) and legacy format (keyword string)
          const keywordsArray = Array.isArray(n.data?.keywords)
            ? n.data.keywords.map(k => String(k).toLowerCase().trim()).filter(Boolean)
            : String(n.data?.keyword || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
          return keywordsArray.length > 0 && keywordsArray.includes(userTextLower);
        });
      }
      
      // 2. AI Intent Detection Fallback (Priority 1B)
      if (!matchingTrigger && userText.length > 3) {
          const intentNodes = flowNodes.filter(n => (n.type === 'trigger' || n.type === 'TriggerNode') && n.data?.triggerType === 'intent' && n.data?.intentDescription);
          const apiKey = client.geminiApiKey || client.config?.geminiApiKey;
          
          if (intentNodes.length > 0 && apiKey) {
              log.info(`AI Intent: Checking ${intentNodes.length} intent triggers for "${userText}"`);
              // limit to first 3 intent nodes to prevent excessive API calls
              for (const node of intentNodes.slice(0, 3)) {
                  const matched = await checkIntent(userText, node.data.intentDescription, apiKey);
                  if (matched) {
                      log.info(`AI Intent: Matched intent "${node.data.intentDescription}" for node ${node.id}`);
                      matchingTrigger = node;
                      break; 
                  }
              }
          }
      }

      if (matchingTrigger) {
          log.info(`Graph: Triggering node ${matchingTrigger.id}`);
          return await executeNode(matchingTrigger.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
      }
      
      // If none matched, check for basic greeting reset — ONLY when text is present
      if (userTextLower && (isGreeting(userTextLower) || userTextLower === 'start' || userTextLower === 'menu')) {
          const firstTrigger = flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode');
          if (firstTrigger) {
              log.info(`Graph: Greeting reset to node ${firstTrigger.id}`);
              return await executeNode(firstTrigger.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
          }
      }
  }

  // E) No currentStepId — Fresh Start
  if (!currentStepId) {
    const startNode = flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode') || flowNodes.find(n => n.data?.role === 'welcome') || flowNodes[0];
    if (startNode) {
      log.info(`Graph: Starting fresh from node ${startNode.id}`);
      return await executeNode(startNode.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
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
      if (handleEdge) return await executeNode(handleEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
    }
  }
  
  log.info(`Graph: no match from ${currentStepId} for "${userText || incomingTrigger.buttonId}"`);
  if (currentStepId) {
    await logFlowEvent({
      clientId: client.clientId,
      flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
      nodeId: currentStepId,
      nodeType: currentNode?.type || 'unknown',
      phone,
      action: 'dropoff',
      metadata: {
        reason: 'no_matching_edge',
        input: userText || incomingTrigger.buttonId || null,
        channel
      }
    });
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE A SPECIFIC NODE
// ─────────────────────────────────────────────────────────────────────────────
async function executeNode(nodeId, flowNodes, flowEdges, client, convo, lead, phone, io, channel = 'whatsapp', parsedMessage = {}) {
  const execStartedAt = Date.now();
  const rawNode = flowNodes.find(n => n.id === nodeId);
  if (!rawNode) { log.warn(`[Exec] Node ${nodeId} not found in ${flowNodes.length} nodes`); return false; }
  log.info(`[Exec] Node ${nodeId} type=${rawNode.type} label="${(rawNode.data?.label || '').substring(0, 30)}"`);

  // Phase 20: Inject variables into node data before sending
  // This resolves {{customer_name}}, {{order_id}}, etc. in all text fields
  let node = rawNode;
  try {
    // Build context fresh if not already built (fallback for legacy paths)
    const ctx = convo?._variableContext || await buildVariableContext(client, phone, convo, lead);
    node = injectNodeVariables(rawNode, ctx);
  } catch (varErr) {
    log.warn('Variable injection failed for node', { nodeId, error: varErr.message });
    node = rawNode; // fallback to raw node
  }

  // ✅ Phase R3: Atomic node visit counter — was replacing entire flowNodes[] array on every message
  // Old: const updatedNodes = incrementNodeVisit(...); await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes })
  // New: Targeted $inc on exactly one node — O(1) not O(N) writes
  // Targeted visit count tracking on WhatsAppFlow collection
  try {
    const WhatsAppFlow = require("../models/WhatsAppFlow");
    if (convo?.activeFlowId) {
      await WhatsAppFlow.updateOne(
        { _id: convo.activeFlowId, "nodes.id": nodeId },
        { $inc: { "nodes.$.data.visitCount": 1 } }
      ).catch(() => {});
    }
    
    // Fallback/Legacy tracking on Client model
    await Client.updateOne(
      { _id: client._id, "flowNodes.id": nodeId },
      { $inc: { "flowNodes.$.data.visitCount": 1 } }
    ).catch(() => {});
  } catch (err) {
    log.error(`Visit tracking failed for node ${nodeId}:`, { error: err.message });
  }

  await logFlowEvent({
    clientId: client.clientId,
    flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
    nodeId,
    nodeType: node.type,
    phone,
    action: 'entry',
    metadata: { channel }
  });


  let sent = true;
  try {
    sent = await withTimeout(
      sendNodeContent(node, client, phone, lead, convo, channel, parsedMessage),
      6000, 
      `Node Content (${node.type})`
    );
  } catch (timeoutErr) {
    log.error(`[NodeTimeout] ${nodeId} timed out. Sending Text Fallback.`);
    await logFlowEvent({
      clientId: client.clientId,
      flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
      nodeId,
      nodeType: node.type,
      phone,
      action: 'timeout',
      metadata: {
        latencyMs: Date.now() - execStartedAt,
        reason: timeoutErr?.message || 'send_timeout',
        channel
      }
    });
    // Emergency Text Fallback to keep conversation moving
    await sendWhatsAppText(client, phone, node.data?.text || node.data?.body || "Resuming our conversation... Choose an option below.");
  }

  // Phase 17: Save Last Node Visited
  await Conversation.findByIdAndUpdate(convo._id, {
    lastNodeVisited: {
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.data?.label || node.type,
      visitedAt: new Date()
    }
  });

  if (!sent && node.type !== 'logic' && node.type !== 'delay' && node.type !== 'set_variable' && node.type !== 'shopify_call' && node.type !== 'http_request' && node.type !== 'webhook' && node.type !== 'link' && node.type !== 'restart' && node.type !== 'trigger' && node.type !== 'TriggerNode' && node.type !== 'automation' && node.type !== 'abandoned_cart' && node.type !== 'cod_prepaid' && node.type !== 'warranty_check') {
    await logFlowEvent({
      clientId: client.clientId,
      flowId: convo?.activeFlowId || convo?.metadata?.activeFlowId,
      nodeId,
      nodeType: node.type,
      phone,
      action: 'failure',
      metadata: {
        reason: 'send_failed',
        latencyMs: Date.now() - execStartedAt,
        channel
      }
    });
    return false;
  }

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
      if (leftValue === undefined) leftValue = (lead?.capturedData?.[variable] || convo?.metadata?.[variable]) ?? '';
    } else if (condition) {
      if (condition.includes('cart_total')) leftValue = lead?.cartValue || convo?.metadata?.cartValue || 0;
      else if (condition === 'has_phone') leftValue = !!phone;
    }

    const compValue = value !== undefined ? value : (condition?.match(/[\d.]+/) || [0])[0];
    const strLeft = Array.isArray(leftValue) ? leftValue.join(',') : String(leftValue ?? '');
    const strRight = String(compValue ?? '');
    const toNum = (v) => {
      const n = parseFloat(String(v ?? ''));
      return Number.isFinite(n) ? n : NaN;
    };
    const exists = leftValue !== undefined && leftValue !== null && String(leftValue) !== '';
    const op = String(operator || 'equals').toLowerCase();
    let result = false;
    try {
      switch (op) {
        case 'eq':
        case 'equals':
          result = strLeft.toLowerCase() === strRight.toLowerCase();
          break;
        case 'neq':
        case 'not_equals':
          result = strLeft.toLowerCase() !== strRight.toLowerCase();
          break;
        case 'gt':
        case 'greater_than': {
          const l = toNum(leftValue); const r = toNum(compValue);
          result = Number.isFinite(l) && Number.isFinite(r) ? l > r : false;
          break;
        }
        case 'lt':
        case 'less_than': {
          const l = toNum(leftValue); const r = toNum(compValue);
          result = Number.isFinite(l) && Number.isFinite(r) ? l < r : false;
          break;
        }
        case 'gte': {
          const l = toNum(leftValue); const r = toNum(compValue);
          result = Number.isFinite(l) && Number.isFinite(r) ? l >= r : false;
          break;
        }
        case 'lte': {
          const l = toNum(leftValue); const r = toNum(compValue);
          result = Number.isFinite(l) && Number.isFinite(r) ? l <= r : false;
          break;
        }
        case 'contains':
          result = strLeft.toLowerCase().includes(strRight.toLowerCase());
          break;
        case 'not_contains':
          result = !strLeft.toLowerCase().includes(strRight.toLowerCase());
          break;
        case 'starts_with':
          result = strLeft.toLowerCase().startsWith(strRight.toLowerCase());
          break;
        case 'ends_with':
          result = strLeft.toLowerCase().endsWith(strRight.toLowerCase());
          break;
        case 'in':
          result = strRight.split(',').map(v => v.trim()).includes(strLeft);
          break;
        case 'exists':
          result = exists;
          break;
        case 'not_exists':
          result = !exists;
          break;
        case 'regex_match':
          try { result = new RegExp(strRight).test(strLeft); } catch { result = false; }
          break;
        default:
          result = strLeft.toLowerCase() === strRight.toLowerCase();
          break;
      }
    } catch {
      result = false;
    }

    log.info(`Logic: ${variable}(${leftValue}) ${operator} ${compValue} → ${result ? 'TRUE' : 'FALSE'}`);
    const targetHandle = result ? 'true' : 'false';
    const nextEdge = flowEdges.find(e =>
      e.source === nodeId && (e.sourceHandle === targetHandle || normalizeHandleId(e.sourceHandle) === targetHandle)
    );
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
    return true;
  }

  if (node.type === 'delay') {
    const rawDuration = node.data?.duration ?? node.data?.waitValue ?? 1;
    const rawUnit = String(node.data?.unit || node.data?.waitUnit || 'minutes').toLowerCase();
    const duration = Math.max(1, Number(rawDuration) || 1);
    const unitMs =
      rawUnit.startsWith('sec') ? 1000 :
      rawUnit.startsWith('hour') ? 60 * 60 * 1000 :
      rawUnit.startsWith('day') ? 24 * 60 * 60 * 1000 :
      60 * 1000;
    const wakeupAt = new Date(Date.now() + duration * unitMs);

    if (!parsedMessage?.suppressConversationPersistence) {
      await Conversation.findByIdAndUpdate(convo._id, {
        status: 'DELAYED',
        scheduledResumeAt: wakeupAt,
        lastStepId: nodeId,
        lastInteraction: new Date()
      });
    }

    log.info(`[FlowEngine] Delay node scheduled resume for ${phone} at ${wakeupAt.toISOString()}`);
    return true;
  }

  // --- ENTERPRISE NODE LOGIC (Structural & Pro) ---

  // 1. Sequence Node: Series of messages with delays
  if (node.type === 'sequence') {
    const steps = node.data?.steps || [];
    if (steps.length > 0) {
      const FollowUpSequence = require('../models/FollowUpSequence');
      const mappedSteps = steps.map((s, idx) => ({
        type: channel,
        content: s.text,
        delayValue: s.delay || 0,
        delayUnit: 'minutes',
        sendAt: new Date(Date.now() + (s.delay || 0) * 60000),
        status: "pending",
        order: idx
      }));

      await FollowUpSequence.create({
        clientId: client.clientId,
        leadId: lead?._id,
        phone,
        name: `Sequence from node ${node.id}`,
        steps: mappedSteps
      });
      log.info(`[FlowEngine] Sequence enrolled for ${phone} with ${steps.length} steps.`);
    }
  }

  // 2. Segment Node: CRM-based branching
  if (node.type === 'segment') {
    const segments = node.data?.segments || [];
    let selectedSegment = 'fallback';

    for (const seg of segments) {
      let match = false;
      const score = lead?.leadScore || 0;
      const purchaseCount = lead?.ordersCount || 0;
      const totalSpend = lead?.totalSpent || 0;

      if (seg.type === 'vip' && score > 500) match = true;
      else if (seg.type === 'returning' && purchaseCount > 1) match = true;
      else if (seg.type === 'high_spend' && totalSpend > 5000) match = true;
      else if (seg.type === 'new' && !purchaseCount) match = true;

      if (match) {
        selectedSegment = seg.id;
        break;
      }
    }

    const nextEdge = flowEdges.find(e => e.source === nodeId && normalizeHandleId(e.sourceHandle) === selectedSegment);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // 3. Review Node: Send review buttons and wait for rating
  if (node.type === 'review') {
    // Send the review prompt with rating buttons (handled by sendNodeContent case 'review')
    await sendNodeContent(node, client, phone, lead, convo, channel, parsedMessage);
    
    // Set lastStepId so that when the user taps a rating button,
    // tryGraphTraversal will match the button_reply.id ('positive' or 'negative')
    // against outgoing edges from this node.
    await Conversation.findByIdAndUpdate(convo._id, { 
      lastStepId: nodeId,
      lastNodeAt: new Date()
    });
    
    log.info(`[FlowEngine] Review node ${nodeId}: Waiting for rating from ${phone}`);
    return true; // Halt traversal — button click resumes via tryGraphTraversal
  }

  // 4. Abandoned Cart Node
  if (node.type === 'abandoned_cart') {
    // Visual entry point for cart recovery. Usually triggered by shopify check.
    // If reached in flow (e.g. via direct link), we just proceed to recovery logic.
    const { handleNodeAction } = require('./nodeActions');
    await handleNodeAction('CART_RECOVERY_START', node, client, phone, convo, lead);
  }

  // 5. COD to Prepaid Node
  if (node.type === 'cod_prepaid') {
    const { handleNodeAction } = require('./nodeActions');
    await handleNodeAction('CONVERT_COD_TO_PREPAID', node, client, phone, convo, lead);
  }

  // --- ENTERPRISE & COMMERCE NODES (Phase 3) ---

  // 6. Payment Link Node
  if (node.type === 'payment_link') {
    const { handleNodeAction } = require('./nodeActions');
    await handleNodeAction('GENERATE_PAYMENT', node, client, phone, convo, lead);
  }

  // 7. Loyalty Action Node
  if (node.type === 'loyalty_action' || node.type === 'loyalty') {
    const { handleNodeAction } = require('./nodeActions');
    const action = node.data?.actionType || 'GIVE_LOYALTY';

    if (action === 'REDEEM_POINTS') {
      const walletService = require('./walletService');
      const { normalizePhone } = require('./helpers');
      const cleanPhone = normalizePhone(phone);
      const balance = await walletService.getBalance(client.clientId, cleanPhone);
      const required = node.data?.pointsRequired || 100;
      const targetHandle = balance >= required ? 'success' : 'fail';
      if (balance >= required) {
        await handleNodeAction(action, node, client, phone, convo, lead);
      }
      const nextEdge = flowEdges.find(
        (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === targetHandle
      );
      if (nextEdge) {
        return await executeNode(
          nextEdge.target,
          flowNodes,
          flowEdges,
          client,
          convo,
          lead,
          phone,
          io,
          channel,
          parsedMessage
        );
      }
      return true;
    }

    await handleNodeAction(action, node, client, phone, convo, lead);
  }

  // 8. Order Action Node — with context validation for returns
  if (node.type === 'order_action') {
    const { handleNodeAction } = require('./nodeActions');
    const action = node.data?.actionType || 'CHECK_ORDER_STATUS';
    
    // SAFETY: INITIATE_RETURN requires order context
    if (action === 'INITIATE_RETURN' || action === 'CANCEL_ORDER') {
      const orderId = convo?.metadata?.order_id || convo?.metadata?.lastOrderId || convo?.metadata?.return_order_id;
      if (!orderId) {
        log.warn(`[FlowEngine] ${action} attempted without order context for ${phone}`);
        await sendWhatsAppText(client, phone, "Please check your order status first so I can identify which order to process. 📋");
        // Halt traversal — don't auto-forward without required context
        return true;
      }
    }
    
    await handleNodeAction(action, node, client, phone, convo, lead);
  }

  // 9. Warranty Check Node — branching driven by Order + warranty window (see nodeActions WARRANTY_CHECK)
  if (node.type === 'warranty_check' || node.type === 'warranty_lookup') {
    const { handleNodeAction } = require('./nodeActions');
    const Conversation = require('../models/Conversation');
    await handleNodeAction('WARRANTY_CHECK', node, client, phone, convo, lead);

    const fresh = await Conversation.findById(convo._id).select('metadata').lean();
    const meta = fresh?.metadata || convo.metadata || {};
    let targetHandle = 'none';
    if (meta._warranty_branch === 'active') targetHandle = 'active';
    else if (meta._warranty_branch === 'expired') targetHandle = 'expired';

    if (!meta._warranty_branch) {
      const cleanPhone = require('./helpers').normalizePhone(phone);
      const leadRecord = await AdLead.findOne({ phoneNumber: cleanPhone, clientId: client.clientId }).lean();
      const records = leadRecord?.warrantyRecords || [];
      const serialQuery = (convo?.metadata?.lookup_serial || '').trim().toLowerCase();
      if (records.length > 0) {
        if (serialQuery) {
          const matches = records.filter((r) => (r.serialNumber || '').toLowerCase() === serialQuery);
          if (matches.length > 0) {
            const isExpired = new Date(matches[0].expiryDate) < new Date();
            targetHandle = isExpired ? 'expired' : 'active';
          }
        } else {
          const activeOnes = records.filter((r) => new Date(r.expiryDate) > new Date());
          targetHandle = activeOnes.length > 0 ? 'active' : 'expired';
        }
      }
    }

    const nextEdge = flowEdges.find(
      (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === targetHandle
    );
    if (nextEdge) {
      return await executeNode(
        nextEdge.target,
        flowNodes,
        flowEdges,
        client,
        convo,
        lead,
        phone,
        io,
        channel,
        parsedMessage
      );
    }
  }

  // 10. Intent Trigger Node (Execution part)
  if (node.type === 'intent_trigger') {
      // Usually an entry point, but if reached in flow, we just proceed.
      const nextEdge = flowEdges.find(e => e.source === nodeId);
      if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // 6. Schedule Node: Business Hours check (with timezone support)
  if (node.type === 'schedule') {
    const { openTime = "10:00", closeTime = "19:00", days = [1, 2, 3, 4, 5], timezone } = node.data || {};
    
    // Use client timezone if set, otherwise server timezone
    const tz = timezone || client.timezone || 'Asia/Kolkata';
    let now;
    try {
      // Use Intl to get timezone-aware date components (no external dependency)
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
      });
      const parts = formatter.formatToParts(new Date());
      const hourPart = parts.find(p => p.type === 'hour')?.value || '00';
      const minutePart = parts.find(p => p.type === 'minute')?.value || '00';
      const dayPart = parts.find(p => p.type === 'weekday')?.value;
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      now = { hours: parseInt(hourPart), minutes: parseInt(minutePart), day: dayMap[dayPart] ?? new Date().getDay() };
    } catch (_) {
      // Invalid timezone — fall back to server time
      const d = new Date();
      now = { hours: d.getHours(), minutes: d.getMinutes(), day: d.getDay() };
    }
    
    const currentHHMM = now.hours.toString().padStart(2, '0') + ":" + now.minutes.toString().padStart(2, '0');
    
    const isDayOpen = days.includes(now.day);
    const isTimeOpen = currentHHMM >= openTime && currentHHMM < closeTime;
    const isOpen = isDayOpen && isTimeOpen;
    
    const targetHandle = isOpen ? 'open' : 'closed';
    
    log.info(`[FlowEngine] Schedule check: ${currentHHMM} (tz=${tz}) on Day ${now.day} → ${isOpen ? 'OPEN' : 'CLOSED'}`);
    const nextEdge = flowEdges.find(e => e.source === nodeId && normalizeHandleId(e.sourceHandle) === targetHandle);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // 7. Persona Node: Tone shifting
  if (node.type === 'persona') {
    const persona = node.data?.personaType || 'Concierge';
    await Conversation.findByIdAndUpdate(convo._id, { 'metadata.activePersona': persona });
    log.info(`[FlowEngine] Persona shifted to ${persona} for ${phone}`);
    const nextEdge = flowEdges.find(e => e.source === nodeId);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
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
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Phase 17: Tag Lead Node
  if (node.type === 'tag_lead' || node.type === 'TagNode') {
    const { action, tag } = node.data || {}; // action: 'add' or 'remove'
    if (tag && lead) {
       const update = action === 'remove' ? { $pull: { tags: tag } } : { $addToSet: { tags: tag } };
       await AdLead.findByIdAndUpdate(lead._id, update);
       log.info(`TagNode: ${action} tag "${tag}" for lead ${lead._id}`);
    }
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Phase 21: Admin Alert Node — dual-channel (WhatsApp template + fallback text, SMTP email) via NotificationService
  if (node.type === 'admin_alert' || node.type === 'AdminAlertNode') {
    const { topic, alertChannel, priority, triggerSource } = node.data || {};
    const rawTopic = topic || "Human support request";
    const alertMsg = replaceVariables(String(rawTopic), client, lead, convo);

    const rawAdminPhone =
      (node.data?.phone && String(node.data.phone)) ||
      client.adminPhone ||
      client.adminPhoneNumber ||
      client.platformVars?.adminWhatsappNumber ||
      client.adminAlertWhatsapp ||
      "";
    const adminWaDigits = replaceVariables(String(rawAdminPhone), client, lead, convo).replace(/\D/g, "");

    const meta = convo?.metadata || {};
    const customerQuery =
      meta.support_query ||
      meta.supportQuery ||
      lead?.capturedData?.support_query ||
      (parsedMessage?.text?.body ? String(parsedMessage.text.body).trim() : "") ||
      "";

    // 1. Mark conversation as needing attention (does not pause bot — handoff nodes handle pause)
    await Conversation.findByIdAndUpdate(convo._id, {
      requiresAttention: true,
      attentionReason: alertMsg,
      lastInteraction: new Date(),
    });

    // 2. Emit real-time socket event to dashboard
    if (io) {
      io.to(`client_${client.clientId}`).emit("admin_alert", {
        type: "escalation",
        topic: alertMsg,
        priority: priority || "high",
        phone,
        conversationId: String(convo._id),
        leadName: lead?.name || "Customer",
        timestamp: new Date(),
      });
      io.to(`client_${client.clientId}`).emit("attention_required", {
        phone,
        conversationId: String(convo._id),
        reason: alertMsg,
        priority: priority || "high",
      });
    }

    // 3–4. WhatsApp (Meta utility template + text fallback) + email — honors client.adminAlertPreferences unless node overrides
    try {
      const NotificationService = require("./notificationService");
      await NotificationService.sendAdminAlert(client, {
        customerPhone: phone,
        topic: alertMsg,
        triggerSource: triggerSource || "WhatsApp flow",
        channel: alertChannel,
        adminPhoneOverride: adminWaDigits.length >= 10 ? adminWaDigits : undefined,
        customerQuery,
      });
    } catch (err) {
      log.error(`AdminAlert dispatch failed: ${err.message}`);
    }

    log.info(`AdminAlert triggered for ${phone}: ${alertMsg}`);
    
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Enterprise Expansion: Warranty Lookup Engine
  if (node.type === 'warranty_lookup') {
    const serialQuery = (convo?.metadata?.lookup_serial || '').trim().toLowerCase();
    const { normalizePhone } = require('./helpers');
    const cleanPhone = normalizePhone(phone);
    
    // Fetch real records from DB
    const leadRecord = await AdLead.findOne({ phoneNumber: cleanPhone, clientId: client.clientId }).lean();
    const records = leadRecord?.warrantyRecords || [];
    
    let message = '';
    
    if (serialQuery) {
        // Search by Serial (Intelligent Match: Full or last N digits, case-insensitive)
        // Match against Serial Number or Order ID
        const matches = records.filter(r => {
            const sn = (r.serialNumber || "").toLowerCase();
            const oid = (r.orderId || "").toLowerCase();
            return sn === serialQuery || 
                   oid === serialQuery ||
                   (serialQuery.length >= 4 && sn.endsWith(serialQuery));
        });

        if (matches.length === 1) {
            const match = matches[0];
            const expiryDate = new Date(match.expiryDate);
            const isExpired = new Date() > expiryDate;
            const dateStr = expiryDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            
            if (isExpired) {
                message = `⚠️ *Warranty Expired*\n\nYour product *${match.productName}* (${match.serialNumber}) was covered until ${dateStr}. Please contact support for repair options.`;
            } else {
                message = `✅ *Active Warranty Found*\n\nProduct: *${match.productName}*\nSerial: *${match.serialNumber}*\nValid Until: *${dateStr}*\n\nYou are fully protected! 🛡️`;
                if (client.brand?.warrantySupportPhone) {
                    message += `\n\nSupport: ${client.brand.warrantySupportPhone}`;
                }
            }
        } else if (matches.length > 1) {
            message = `📋 *Multiple Matches Found*\n\nI found ${matches.length} products matching "${serialQuery}":\n\n${matches.map(r => `• *${r.productName}*\n  SN: ${r.serialNumber} | Exp: ${new Date(r.expiryDate).toLocaleDateString()}`).join('\n\n')}\n\n_Please provide the full serial number for details on a specific unit._`;
        } else {
            message = `❌ *Serial Not Found*\n\nI couldn't find a warranty record for *${serialQuery}*. Please ensure the serial number is correct.`;
        }
    } else {
        // Just show all active warranties if no serial provided
        const activeOnes = records.filter(r => new Date(r.expiryDate) > new Date());
        if (activeOnes.length > 0) {
            message = `📋 *Your Active Warranties*\n\n${activeOnes.map(r => `• ${r.productName} (${r.serialNumber})\n  Exp: ${new Date(r.expiryDate).toLocaleDateString()}`).join('\n')}`;
        } else {
            message = `📋 *Warranty Status*\n\nYou don't have any active warranties registered with this phone number. 🛡️`;
        }
    }
    
    await WhatsApp.sendText(client, phone, message);
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'output'));
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Phase 17: Delay / Wait Node
  if (node.type === 'delay' || node.type === 'WaitNode') {
    let { duration, unit, waitValue, waitUnit } = node.data; // Support both formats
    duration = duration ?? waitValue ?? 1;
    unit     = unit     ?? waitUnit  ?? 'minutes';
    let delayMs = 60000; // default 1 min
    
    if (typeof duration === 'string' && !unit) {
      const val = parseInt(duration);
      if (duration.endsWith('m')) delayMs = val * 60000;
      else if (duration.endsWith('h')) delayMs = val * 3600000;
      else if (duration.endsWith('d')) delayMs = val * 86400000;
      else if (duration.endsWith('s')) delayMs = val * 1000;
    } else {
      if (unit === 'minutes') delayMs = duration * 60000;
      else if (unit === 'hours') delayMs = duration * 3600000;
      else if (unit === 'seconds') delayMs = duration * 1000;
      else if (unit === 'days') delayMs = duration * 86400000;
    }

    const resumeAt = new Date(Date.now() + delayMs);
    await Conversation.findByIdAndUpdate(convo._id, { 
      flowPausedUntil: resumeAt,
      pausedAtNodeId: nodeId 
    });
    
    log.info(`⏳ Flow paused for ${phone} until ${resumeAt.toISOString()}`);
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

  // 9. Link Node (Jump to Flow)
  if (node.type === 'link') {
    const { targetFolderId, passVariables } = node.data || {};
    if (targetFolderId) {
      log.info(`[FlowEngine] Link node triggered: Jumping to flow ${targetFolderId} for ${phone}`);
      
      let targetFlowNodes = [];
      let targetFlowEdges = [];
      
      // 1. Try WhatsAppFlow (New Standard)
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      try {
        const targetFlowDoc = await WhatsAppFlow.findOne({
          clientId: client.clientId,
          flowId: targetFolderId,
          status: 'PUBLISHED'
        }).lean();
        if (targetFlowDoc) {
          targetFlowNodes = targetFlowDoc.publishedNodes?.length ? targetFlowDoc.publishedNodes : (targetFlowDoc.nodes || []);
          targetFlowEdges = targetFlowDoc.publishedEdges?.length ? targetFlowDoc.publishedEdges : (targetFlowDoc.edges || []);
        }
      } catch (_) { /* ignore */ }
      
      // 2. Try Legacy visualFlows Fallback
      if (targetFlowNodes.length === 0 && client.visualFlows) {
        const legacyFlow = client.visualFlows.find(f => f.id === targetFolderId || f._id?.toString() === targetFolderId);
        if (legacyFlow) {
          targetFlowNodes = legacyFlow.nodes || [];
          targetFlowEdges = legacyFlow.edges || [];
        }
      }
      
      if (targetFlowNodes.length > 0) {
        const startNode = targetFlowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode');
        if (startNode) {
          const nextMeta = passVariables ? { ...(convo.metadata || {}) } : {};
          await Conversation.findByIdAndUpdate(convo._id, { activeFlowId: targetFolderId, lastStepId: null, metadata: nextMeta });
          return await executeNode(startNode.id, targetFlowNodes, targetFlowEdges, client, convo, lead, phone, io, channel, parsedMessage);
        }
      } else {
         log.warn(`[FlowEngine] Link node failed: Target flow ${targetFolderId} not found or empty`);
      }
    }
  }

  // USP Section: Shopify-Native AI Actions
  if (node.type === 'shopify_call' || node.type === 'ShopifyNode') {
    const { action, query, variable } = node.data;
    const { getShopifyClient, withShopifyRetry } = require("./shopifyHelper");
    const resolvedQuery = replaceVariables(query || '', client, lead, convo);
    let resultData = null;

    try {

      // --- USP 1: DYNAMIC PRODUCT CARDS (Shopify API with KB fallback) ---
      if (action === 'PRODUCT_CARD') {
        let product = null;
        
        // Try Shopify API first
        try {
          const fetchedProduct = await withShopifyRetry(client.clientId, async (shopify) => {
            const searchQuery = resolvedQuery || '';
            const endpoint = searchQuery
              ? `/products.json?limit=5&title=${encodeURIComponent(searchQuery)}`
              : '/products.json?limit=10&status=active';
            const res = await shopify.get(endpoint);
            const products = res.data.products || [];
            if (products.length === 0) return null;
            return products[Math.floor(Math.random() * products.length)];
          });
          if (fetchedProduct) product = fetchedProduct;
        } catch (shopErr) {
          log.warn(`[PRODUCT_CARD] Shopify API failed, falling back to KB: ${shopErr.message}`);
        }

        if (product) {
          // Shopify product — send with image if available
          const imgUrl = product.image?.src || product.images?.[0]?.src;
          const price = product.variants?.[0]?.price || product.price || 'N/A';
          const currency = product.variants?.[0]?.currency || '₹';
          const productUrl = `https://${client.shopifyDomain || 'store'}/products/${product.handle}`;
          const msg = `🛍️ *${product.title}*\n\n${(product.body_html || '').replace(/<[^>]*>/g, '').substring(0, 120)}...\n\n*Price:* ${currency} ${price}\n\n🔗 ${productUrl}`;
          
          if (imgUrl) {
            await WhatsApp.sendImage(client, phone, imgUrl, msg);
          } else {
            await sendWhatsAppText(client, phone, msg);
          }
          resultData = { product: product.title, price, handle: product.handle, status: 'sent' };
        } else {
          // Fallback to local knowledge base
          const kbProducts = client.knowledgeBase?.products || [];
          if (kbProducts.length > 0) {
            const rand = kbProducts[Math.floor(Math.random() * kbProducts.length)];
            const msg = `Check this out! 🛍️\n\n*${rand.name}*\n${rand.description?.substring(0, 100)}...\n\n*Price:* ₹${rand.price}\n\nLink: ${rand.url || 'Visit our store'}`;
            await sendWhatsAppText(client, phone, msg);
            resultData = { product: rand.name, status: 'sent' };
          } else {
            await sendWhatsAppText(client, phone, "I'd love to show you our products, but our catalog is being updated. Check back soon! 🛒");
          }
        }
      } 
      
      // --- USP 2: REAL-TIME ORDER TRACKING (Multi-format phone search) ---
      else if (action === 'ORDER_STATUS' || action === 'get_order' || action === 'CHECK_ORDER_STATUS') {
        resultData = await withShopifyRetry(client.clientId, async (shopify) => {
          // Try multiple phone formats — Shopify stores vary
          const phoneDigits = phone.replace(/\D/g, '');
          const phoneLast10 = phoneDigits.slice(-10);
          const phoneFormats = [
            phone.replace('+', ''),           // 91XXXXXXXXXX
            phoneLast10,                       // XXXXXXXXXX
            `+${phoneDigits}`,                 // +91XXXXXXXXXX
            phoneDigits                        // raw digits
          ];

          let order = null;
          for (const ph of phoneFormats) {
            try {
              const res = await shopify.get(`/orders.json?status=any&limit=1&phone=${encodeURIComponent(ph)}`);
              if (res.data.orders?.length > 0) {
                order = res.data.orders[0];
                break;
              }
            } catch (_) { continue; }
          }

          if (!order) {
            const silentLookup = !!node.data?.silent;
            if (!silentLookup) {
              await sendWhatsAppText(client, phone,
                "I couldn't find any orders linked to your number. " +
                "Please share your order ID (e.g. #1042) and I'll look it up!"
              );
            }
            // Save to metadata for logic node branching
            await Conversation.findByIdAndUpdate(convo._id, {
              'metadata.shopify_order_found': 'false'
            });
            // Route to not_found edge if configured
            const noOrderEdge = flowEdges.find(e => e.source === nodeId &&
              (normalizeHandleId(e.sourceHandle) === 'not_found' ||
               normalizeHandleId(e.sourceHandle) === 'no_order' ||
               normalizeHandleId(e.sourceHandle) === 'error'));
            if (noOrderEdge) {
              return await executeNode(noOrderEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
            }
            return { error: 'No order found for this number' };
          }

          const statusEmoji = {
            pending: '⏳', confirmed: '✅', processing: '🔄',
            shipped: '🚚', delivered: '🎉', cancelled: '❌', refunded: '💰'
          };
          const fulfillStatus = order.fulfillment_status || order.financial_status || 'Confirmed';
          const emoji = statusEmoji[fulfillStatus.toLowerCase()] || '📦';
          const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
          const items = lineItems.map(i => `• ${i.title} × ${i.quantity}`).join('\n');
          const firstItemTitle = String(lineItems[0]?.title || '').trim();
          const tracking = order.fulfillments?.[0]?.tracking_url;
          const payGw = (order.payment_gateway_names || []).join(', ') || order.processing_method || '';

          const silentLookup = !!node.data?.silent;
          if (!silentLookup) {
            let msg = `${emoji} *Order #${order.order_number}*\n\n`;
            msg += `Status: *${fulfillStatus.toUpperCase()}*\n`;
            msg += `Items:\n${items || 'N/A'}\n`;
            msg += `Total: *${order.currency} ${parseFloat(order.total_price).toFixed(2)}*`;
            if (tracking) msg += `\n\n📍 Track: ${tracking}`;
            if (order.order_status_url) msg += `\n🔗 Details: ${order.order_status_url}`;

            await sendWhatsAppText(client, phone, msg);
          }

          // Save order data to metadata
          const orderData = {
            orderNumber: order.order_number, orderId: order.id,
            status: fulfillStatus, totalPrice: order.total_price,
            trackingUrl: tracking || null, currency: order.currency,
            itemsSummary: items || '',
            payment_method: payGw,
          };
          const fsRaw = String(order.fulfillment_status || "").toLowerCase();
          const hasFulfillment = Array.isArray(order.fulfillments) && order.fulfillments.length > 0;
          const isShippedLike =
            fsRaw === "fulfilled" ||
            fsRaw === "partial" ||
            fsRaw === "shipped" ||
            (hasFulfillment && fsRaw !== "restocked");
          const mergedMeta = {
            ...(convo.metadata || {}),
            lastOrder: orderData,
            shopify_order_found: "true",
            shopify_order_id: order.id,
            order_number: order.name ? String(order.name) : `#${order.order_number}`,
            order_status: fulfillStatus,
            payment_method: payGw,
            is_shipped: isShippedLike ? "true" : "false",
            first_product_title: firstItemTitle,
            last_order_items_count: String(lineItems.length || 0),
          };
          await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: mergedMeta } });
          convo.metadata = mergedMeta;

          return orderData;
        });
      }

      else if (action === 'CANCEL_ORDER') {
        const { handleNodeAction } = require('./nodeActions');
        await handleNodeAction('CANCEL_ORDER', node, client, phone, convo, lead);
        resultData = { status: 'cancel_requested' };
      }

      else if (action === 'ORDER_REFUND_STATUS') {
        const { handleNodeAction } = require('./nodeActions');
        await handleNodeAction('ORDER_REFUND_STATUS', node, client, phone, convo, lead);
        resultData = { status: 'refund_status_checked' };
      }

      // --- USP 3: DYNAMIC AI DISCOUNTS ---
      else if (action === 'CREATE_DISCOUNT') {
        resultData = await withShopifyRetry(client.clientId, async (shopify) => {
          const code = `VIP${Math.floor(1000 + Math.random() * 9000)}`;
          const ruleRes = await shopify.post('/price_rules.json', {
            price_rule: {
              title: `AI_Generated_${code}`,
              target_type: "line_item",
              target_selection: "all",
              allocation_method: "across",
              value_type: "percentage",
              value: "-10.0",
              customer_selection: "all",
              starts_at: new Date().toISOString()
            }
          });
          const ruleId = ruleRes.data.price_rule.id;
          await shopify.post(`/price_rules/${ruleId}/discount_codes.json`, {
            discount_code: { code }
          });

          await sendWhatsAppText(client, phone, `🎁 Surprise! Use code *${code}* for 10% OFF your next order! Valid for the next 24 hours only. ⚡️`);
          
          // Save discount code to lead record
          if (lead?._id) {
            await AdLead.findByIdAndUpdate(lead._id, {
              $set: { activeDiscountCode: code, discountIssuedAt: new Date() }
            }).catch(() => {});
          }
          
          return { code, discount: '10%' };
        });
      }

      // --- USP 4: COD TO PREPAID CONVERSION (Interactive buttons) ---
      else if (action === 'COD_TO_PREPAID') {
        const { createCODPaymentLink } = require("./razorpay");
        const AdOrder = require("../models/AdOrder");
        const latestOrder = await AdOrder.findOne({ customerPhone: phone, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        
        if (latestOrder && latestOrder.paymentMethod === 'cod') {
          const rzpLink = await createCODPaymentLink(latestOrder, client);
          const bodyText = `Hey! We noticed you chose COD for Order #${latestOrder.orderNumber}. 💳\n\nPre-pay now to get *Priority Shipping* + a surprise gift! 🎁`;
          
          // Send as interactive CTA URL button
          const interactive = {
            type: 'cta_url',
            action: {
              name: 'cta_url',
              parameters: {
                display_text: 'Pay Now ✨',
                url: rzpLink.short_url
              }
            }
          };
          await WhatsApp.sendInteractive(client, phone, interactive, bodyText);
          resultData = { link: rzpLink.short_url, status: 'sent' };
        } else {
          await sendWhatsAppText(client, phone, "All your orders are already paid. No COD orders pending! ✅");
          log.info(`[COD_TO_PREPAID] No eligible COD order found for ${phone}`);
        }
      }

      // Save to variable if requested
      if (variable && resultData) {
        const updatedMetadata = {
          ...(convo.metadata || {}),
          [variable]: resultData,
          [`${variable}_title`]: resultData?.title || resultData?.product || '',
          [`${variable}_price`]: resultData?.price || '',
          [`${variable}_url`]: resultData?.url || resultData?.link || ''
        };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }

      // Silent / graph-driven order lookup: follow explicit `success` edge to a message node
      if (
        (action === "ORDER_STATUS" || action === "get_order" || action === "CHECK_ORDER_STATUS") &&
        resultData &&
        typeof resultData === "object" &&
        resultData.orderId
      ) {
        const succEdge = flowEdges.find(
          (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === "success"
        );
        if (succEdge) {
          return await executeNode(
            succEdge.target,
            flowNodes,
            flowEdges,
            client,
            convo,
            lead,
            phone,
            io,
            channel,
            parsedMessage
          );
        }
      }
    } catch (err) {
      log.error(`Shopify Action ${action} Failed:`, { error: err.message });
      await sendWhatsAppText(client, phone, "I'm having a bit of trouble connecting to the store right now. Please try again in a minute! 🔄");
    }
  }

  // HTTP Request Node — with success/error edge routing
  if (node.type === 'http_request' || node.type === 'HttpRequestNode') {
    const { url, method, body, variable, headers: customHeaders } = node.data;
    let httpSuccess = false;
    try {
      const resolvedUrl = replaceVariables(url, client, lead, convo);
      // Parse body safely — PropertiesPanel stores it as a raw JSON string
      let resolvedBody = null;
      if (body) {
        try {
          resolvedBody = JSON.parse(replaceVariables(body, client, lead, convo));
        } catch (parseErr) {
          log.warn(`[HttpNode] Body JSON parse failed, sending as raw string: ${parseErr.message}`);
          resolvedBody = replaceVariables(body, client, lead, convo);
        }
      }
      // Parse headers — PropertiesPanel stores as JSON string, but could be an object
      let parsedHeaders = {};
      if (customHeaders) {
        if (typeof customHeaders === 'string') {
          try { parsedHeaders = JSON.parse(customHeaders); } catch (_) {
            log.warn('[HttpNode] Headers JSON parse failed, using empty headers');
          }
        } else if (typeof customHeaders === 'object') {
          parsedHeaders = customHeaders;
        }
      }
      const resp = await axios({
        url: resolvedUrl,
        method: method || 'GET',
        data: resolvedBody,
        headers: parsedHeaders,
        timeout: 10000
      });
      // Store response data in variable context
      if (variable) {
        const updatedMetadata = { ...(convo.metadata || {}), [variable]: resp.data, [`${variable}_status`]: resp.status };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }
      const metaWithHttp = { ...(convo.metadata || {}), http_status: resp.status, http_success: String(resp.status < 400), http_error: '' };
      await Conversation.findByIdAndUpdate(convo._id, { metadata: metaWithHttp });
      convo.metadata = metaWithHttp;
      httpSuccess = true;
      log.info(`[HttpNode] ${method || 'GET'} ${resolvedUrl} → ${resp.status}`);
    } catch (err) {
      log.error("[HttpNode] Request failed:", { url, error: err.message, status: err.response?.status });
      // Store error in variable context for downstream nodes
      if (variable) {
        const updatedMetadata = { ...(convo.metadata || {}), [`${variable}_error`]: err.message, [`${variable}_status`]: err.response?.status || 0 };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }
      const metaWithHttp = { ...(convo.metadata || {}), http_status: err.response?.status || 0, http_success: 'false', http_error: err.message || 'request_failed' };
      await Conversation.findByIdAndUpdate(convo._id, { metadata: metaWithHttp });
      convo.metadata = metaWithHttp;
    }
    // Route to success or error edge
    const targetHandle = httpSuccess ? 'success' : 'error';
    const nextEdge = flowEdges.find(e => e.source === nodeId && normalizeHandleId(e.sourceHandle) === targetHandle);
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
    // Fallback: default edge
    const defaultEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    if (defaultEdge) return await executeNode(defaultEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Webhook Node — async event call with optional wait/branch
  if (node.type === 'webhook') {
    const data = node.data || {};
    const targetUrl = replaceVariables(data.webhookUrl || data.url || '', client, lead, convo);
    const method = (data.method || 'POST').toUpperCase();
    const variable = data.variable || 'webhook_response';
    const waitForResponse = !!data.waitForResponse;
    let webhookSuccess = false;

    if (!targetUrl) {
      log.warn('[WebhookNode] Missing webhook URL');
    } else {
      try {
        const payload = {
          clientId: client.clientId,
          phone,
          leadId: lead?._id?.toString?.() || null,
          conversationId: convo?._id?.toString?.() || null,
          nodeId: node.id,
          nodeType: node.type,
          timestamp: new Date().toISOString(),
          metadata: convo?.metadata || {}
        };
        const timeoutMs = waitForResponse ? 12000 : 4000;
        const resp = await axios({
          url: targetUrl,
          method,
          data: payload,
          headers: { 'Content-Type': 'application/json' },
          timeout: timeoutMs
        });
        webhookSuccess = true;
        if (variable) {
          const updatedMetadata = {
            ...(convo.metadata || {}),
            [variable]: resp.data,
            [`${variable}_status`]: resp.status
          };
          await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
          convo.metadata = updatedMetadata;
        }
      } catch (err) {
        log.error('[WebhookNode] Request failed:', {
          nodeId: node.id,
          url: targetUrl,
          error: err.message,
          status: err.response?.status
        });
        if (variable) {
          const updatedMetadata = {
            ...(convo.metadata || {}),
            [`${variable}_error`]: err.message,
            [`${variable}_status`]: err.response?.status || 0
          };
          await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
          convo.metadata = updatedMetadata;
        }
      }
    }

    const targetHandle = webhookSuccess ? 'success' : 'error';
    const routedEdge = flowEdges.find(e => e.source === nodeId && normalizeHandleId(e.sourceHandle) === targetHandle);
    if (routedEdge) return await executeNode(routedEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
    const defaultEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    if (defaultEdge) return await executeNode(defaultEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  if (node.type === 'livechat') {
    await Conversation.findByIdAndUpdate(convo._id, { 
      status: 'HUMAN_SUPPORT', 
      botPaused: true, 
      isBotPaused: true,
      botStatus: 'paused',
      requiresAttention: true,
      attentionReason: '🙋 Human support requested via flow',
      lastInteraction: new Date()
    });
    // Emit real-time socket alert so agents see the handoff instantly
    if (io) {
      io.to(`client_${client.clientId}`).emit('admin_alert', {
        type: 'human_handoff',
        topic: '🙋 Human support requested',
        phone,
        leadName: lead?.name || 'Customer',
        timestamp: new Date()
      });
      Conversation.findById(convo._id).then((fresh) => {
        if (fresh) io.to(`client_${client.clientId}`).emit('conversation_update', fresh.toObject());
      }).catch(() => {});
      io.to(`client_${client.clientId}`).emit('botStatusChanged', {
        conversationId: String(convo._id),
        botStatus: 'paused'
      });
    }
    log.info(`[FlowEngine] LiveChat handoff: bot paused for ${phone}`);
  }

  // Update lastStepId logic (skipped for isolated commerce automations)
  const isWaitNode = (node.type === 'capture_input' || node.type === 'CaptureNode');
  const action = node.data?.action;
  const _suppress = !!parsedMessage?.suppressConversationPersistence;

  if (!_suppress) {
    if (action === "AI_FALLBACK" || node.type === 'logic') {
      await Conversation.findByIdAndUpdate(convo._id, { lastStepId: convo.lastStepId, lastInteraction: new Date() });
    } else {
      await Conversation.findByIdAndUpdate(convo._id, { lastStepId: nodeId, lastInteraction: new Date() });
    }
  }

  // Auto-forward or enter WAIT state
  if (isWaitNode) {
    // Correctly enter WAITING_FOR_INPUT state
    const targetVar = node.data?.variable || 'last_input';
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    
    log.info(`⏳ Node ${nodeId} entering wait state for variable "${targetVar}"`);
    if (!_suppress) {
      await Conversation.findByIdAndUpdate(convo._id, {
        status: 'WAITING_FOR_INPUT',
        waitingForVariable: targetVar,
        captureResumeNodeId: nextEdge ? nextEdge.target : null,
        captureRetries: 0,
        lastStepId: nodeId
      });
    }
  } else if (node.type !== 'logic' && node.type !== 'restart') {
    const autoEdge = flowEdges.find(e => e.source === nodeId && (!e.trigger || e.trigger?.type === 'auto') && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'bottom' || e.sourceHandle === 'output'));
    if (autoEdge) {
      setTimeout(async () => {
        const freshConvo = await Conversation.findById(convo._id);
        await executeNode(autoEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, io, channel, parsedMessage);
      }, 600);
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND NODE CONTENT — handles all node types
// ─────────────────────────────────────────────────────────────────────────────
async function sendNodeContent(node, client, phone, lead = null, convo = null, channel = 'whatsapp', parsedMessage = {}) {
  const { type, data } = node;
  const options = { commentId: parsedMessage?.commentId };
  const _sanitizeOutbound = (v, fallback = "") => {
    const s = String(v ?? "").trim();
    if (!s || s === "null" || s === "undefined" || s === "[object Object]") return fallback;
    return s;
  };
  if (node.data?.action && !['shopify_call', 'http_request', 'logic', 'delay', 'trigger', 'cod_prepaid', 'loyalty_action', 'loyalty', 'warranty_check', 'warranty_lookup', 'order_action', 'segment', 'ab_test', 'abandoned_cart', 'review'].includes(type)) {
    const { handleNodeAction } = require("./nodeActions");
    handleNodeAction(node.data.action, node, client, phone, convo, lead).catch((err) => {
      log.error(`Action Error (${node.data.action}):`, { error: err.message });
    });
  }

  switch (type) {
    case 'image': {
      const imageUrl = data.imageUrl || '';
      const caption = data.caption || '';
      if (!imageUrl) return true;
       else {
        await WhatsApp.sendImage(client, phone, imageUrl, caption);
      }
      return true;
    }

    case 'folder': return true;

    case 'capture_input':
    case 'CaptureNode': {
      let body = data.text || data.body || data.question || data.label || 'Please provide the requested information:';
      // Variables already hydrated via deepInject in executeNode
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);
      const capOut = _sanitizeOutbound(body, "Please reply with the details we asked for above.");
      await WhatsApp.sendText(client, phone, capOut.substring(0, 4096));
      return true;
    }

    case 'flow':
    case 'FlowNode':
    case 'whatsapp_flow': {
      await sendWhatsAppFlow(client, phone, data.header, data.body || data.text, data.flowId, data.buttonLabel || data.flowCta, data.screen);
      return true;
    }
    case 'message':
    case 'MessageNode':
    case 'livechat': {
      let body = data.text || data.body || (type === 'livechat' ? 'Connecting you to a human...' : '');
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);
      const safeBody = String(body || '').trim();
      if (!safeBody || safeBody === 'null' || safeBody === 'undefined') {
        log.warn('[sendNodeContent] Empty message body after translation — sending safe fallback');
        await WhatsApp.sendText(client, phone, 'Thanks for your message — tap *menu* anytime to see options.');
        return true;
      }
      const clipped = safeBody.substring(0, 4096);
      const imgRaw = (data.imageUrl || '').trim();
      const imgOk = imgRaw && /^https?:\/\//i.test(imgRaw);
      if (imgOk) {
        await WhatsApp.sendImage(client, phone, imgRaw, clipped.substring(0, 1024));
      } else {
        await WhatsApp.sendText(client, phone, clipped);
      }
      return true;
    }

    case 'review': {
      let body = data.text || data.body || 'How was your experience with us?';
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);
      const interactive = {
        type: 'button',
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'positive', title: 'Great' } },
            { type: 'reply', reply: { id: 'negative', title: 'Need Help' } }
          ]
        }
      };
      await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
      return true;
    }

    case 'interactive':
    case 'InteractiveNode': {
      let body = data.text || data.body || 'Please Choose:';
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);
      body = _sanitizeOutbound(body, "Please choose an option below.");

      if (data.btnUrlLink) {
        let interactive = {
          type: 'cta_url',
          action: {
            name: 'cta_url',
            parameters: { display_text: (data.btnUrlTitle || 'Visit').substring(0, 20), url: data.btnUrlLink }
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
        return true;
      }

      const buttonsList = Array.isArray(data.buttonsList) && data.buttonsList.length > 0
        ? data.buttonsList
        : (data.buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

      // Fix: Don't fall back to text if we have sections (List mode)
      if (!buttonsList.length && (!data.sections || data.sections.length === 0)) {
        await WhatsApp.sendText(client, phone, String(body).substring(0, 4096));
        return true;
      }

      if (data.interactiveType === 'list' || (data.sections && data.sections.length > 0)) {
        let sections;
        let totalRows = 0;
        if (data.sections && data.sections.length > 0) {
          sections = data.sections.map(section => {
            const rows = (section.rows || []).slice(0, 10 - totalRows).map(row => {
              const descRaw = row.description != null ? String(row.description).trim() : "";
              const descOk =
                descRaw &&
                descRaw !== "null" &&
                descRaw !== "undefined" &&
                descRaw !== "-";
              return {
                id: String(row.id || row.title || "opt").substring(0, 200),
                title: (row.title || "Option").substring(0, 24),
                ...(descOk ? { description: descRaw.substring(0, 72) } : {}),
              };
            });
            totalRows += rows.length;
            return {
              title: (section.title || 'Options').substring(0, 24),
              rows
            };
          }).filter(s => s.rows.length > 0);
        } else {
          sections = [{
            title: 'Options',
            rows: buttonsList.slice(0, 10).map(btn => ({
              id: String(btn.id || btn.title || 'opt').substring(0, 200),
              title: (btn.title || 'Option').substring(0, 24)
            }))
          }];
        }

        let interactive = {
          type: 'list',
          action: {
            button: (data.buttonText || 'Open Menu').substring(0, 20),
            sections
          }
        };
        if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
        else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
        await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
        return true;
      }

      let interactive = {
        type: 'button',
        action: {
          buttons: buttonsList.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: {
              id: String(btn.id || btn.title || 'opt').substring(0, 256),
              title: (btn.title || 'Option').substring(0, 20)
            }
          }))
        }
      };
      if (data.imageUrl) interactive.header = { type: 'image', image: { link: data.imageUrl } };
      else if (data.header) interactive.header = { type: 'text', text: data.header.substring(0, 60) };
      await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
      return true;
    }

    case 'template':
    case 'TemplateNode': {
      const templateName = data.templateName || data.metaTemplateName;
      if (!templateName) {
        log.warn(`[Template] Node ${node?.id} has no templateName — skipping`);
        return false;
      }
      
      const rawVars = data.variables || data.templateVars;
      let templateVars = [];
      if (Array.isArray(rawVars)) {
          templateVars = rawVars;
      } else if (typeof rawVars === 'string') {
          templateVars = rawVars.split(',').map(v => v.trim()).filter(Boolean);
      }
      
      const headerImage = data.headerImageUrl || null;
      
      try {
        await WhatsApp.sendSmartTemplate(
            client, 
            phone, 
            templateName, 
            templateVars, 
            headerImage, 
            data.languageCode || 'en'
        );
      } catch (templateErr) {
        log.error(`[Template] META_REJECT: Template "${templateName}" failed for ${phone}: ${templateErr.message}`);
        try {
          await WhatsApp.sendText(client, phone, String(data.fallbackText || "We're updating our systems — please check back shortly! 🙏").substring(0, 4096));
        } catch (_) { }
        return false;
      }
      return true;
    }

    case 'email': {
      const recipient = replaceVariables(lead?.email || data.recipientEmail || '', client, lead, convo);
      if (!recipient || !(client.emailUser || client.emailFrom)) {
        log.warn(`[Email] No recipient or email config — skipping email node`);
        if (convo?._id) {
          const updatedMetadata = { ...(convo.metadata || {}), email_sent: 'false', email_error: 'missing_email_config' };
          await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
          convo.metadata = updatedMetadata;
        }
        return true;
      }
      try {
        let subject = replaceVariables(data.subject || 'Update', client, lead, convo);
        let emailBody = replaceVariables(data.body || '', client, lead, convo);
        await emailService.sendEmail(client, { to: recipient, subject, html: emailBody.replace(/\n/g, '<br/>') });
        log.info(`[Email] Sent to ${recipient} — subject: "${subject}"`);
        if (convo?._id) {
          const updatedMetadata = { ...(convo.metadata || {}), email_sent: 'true', email_error: '' };
          await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
          convo.metadata = updatedMetadata;
        }
      } catch (emailErr) {
        log.error(`[Email] SMTP failure for ${recipient}: ${emailErr.message}`);
        if (convo?._id) {
          const updatedMetadata = { ...(convo.metadata || {}), email_sent: 'false', email_error: emailErr.message || 'smtp_error' };
          await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
          convo.metadata = updatedMetadata;
        }
      }
      return true;
    }

    case 'catalog': {
      const { catalogType, productId, productIds, body, header, footer } = data;
      const bodyText = String(body || data.text || "Check out our collection!").substring(0, 1024);
      
      if (catalogType === 'multi') {
        const ids = (productIds || '').split(',').map(id => id.trim()).filter(Boolean);
        const sections = [{ title: 'Our Picks', product_items: ids.map(id => ({ product_retailer_id: id })) }];
        await WhatsApp.sendMultiProduct(client, phone, (header || 'Catalog').substring(0, 60), bodyText, sections);
      } else {
        await WhatsApp.sendCatalog(client, phone, bodyText, (footer || '').substring(0, 60), catalogType === 'single' ? productId : null);
      }
      return true;
    }

    case 'trigger': return true;
    case 'logic': return true;
    case 'set_variable': return true;
    case 'shopify_call': return true;
    case 'http_request': return true;
    case 'webhook': return true;
    case 'tag_lead': return true;
    case 'admin_alert': return true;
    case 'jump': return true;
    case 'link': return true;
    case 'restart': return true;
    case 'automation': {
      // Automation nodes are trigger-type entry points for commerce events.
      // When reached in-flow, they are pass-through nodes.
      log.info(`[FlowEngine] Automation node hit in-flow for ${phone}`);
      return true;
    }
    case 'abandoned_cart': {
      // Entry point node — no direct message.
      // Real cart recovery messages come from 'message' nodes downstream via delay chain.
      log.info(`[FlowEngine] Abandoned cart entry: queuing recovery sequence for ${phone}`);
      return true;
    }
    case 'cod_prepaid': {
      const discountAmount = data.discountAmount || 50;
      const bodyText = data.text || `💳 Save ₹${discountAmount} and get faster delivery by paying online now!`;
      const interactive = {
        type: 'button',
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'paid', title: '✅ Pay Online' } },
            { type: 'reply', reply: { id: 'cod',  title: '❌ Keep COD' } }
          ]
        }
      };
      await WhatsApp.sendInteractive(client, phone, interactive, String(bodyText).substring(0, 1024));
      return true;
    }
    case 'warranty_check':
    case 'warranty_lookup': {
      // This node is purely a logic branch — no user message sent directly.
      // The branching in executeNode routes to active/expired/none message nodes.
      return true;
    }

    default:
      log.warn(`Skipping send content for node type: ${type}`);
      return true;
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
    if (!kw || !kw.word) continue;
    if (!text.includes(kw.word.toLowerCase())) continue;

    switch (kw.action) {
      case 'restart_flow': {
        log.info(`Keyword: restart_flow for "${text}"`);
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });

        // --- PHASE 17 SAAS BILLING ENFORCEMENT ---
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
        const usage = await BillingService.checkLimit(client.clientId, 'aiCallsMade');
        if (!usage.allowed) {
            if (global.NotificationService) {
                await global.NotificationService.sendAdminAlert(client.clientId, `SaaS Limit Reached: ${usage.current}/${usage.limit} AI calls used.`, 'email');
            }
            return { text: "Our AI assistant is temporarily resting. A human teammate will be with you shortly.", status: 'HUMAN_TAKEOVER' };
        }
        await BillingService.incrementUsage(client.clientId, 'aiCallsMade');
        await BillingService.incrementUsage(client.clientId, 'messagesSent');
        const welcomeNodeId = client.simpleSettings?.welcomeStartNodeId;
        const flowNodes = client.flowNodes || [];
        const flowEdges = client.flowEdges || [];
        const freshConvo = { ...convo.toObject(), lastStepId: null };
        const lead = await AdLead.findOne({ phoneNumber: phone, clientId: client.clientId });
        if (welcomeNodeId) return await executeNode(welcomeNodeId, flowNodes, flowEdges, client, freshConvo, lead, phone, global.io);
        const firstTrigger = flowNodes.find(n => n.type === 'trigger');
        if (firstTrigger) {
          const startEdge = flowEdges.find(e => e.source === firstTrigger.id);
          if (startEdge) return await executeNode(startEdge.target, flowNodes, flowEdges, client, freshConvo, lead, phone, global.io);
        }
        break;
      }
      case 'track_order': await handleUniversalOrderTracking(client, phone); return true;
      case 'initiate_return': {
        const { handleNodeAction } = require('./nodeActions');
        await handleNodeAction('INITIATE_RETURN', {}, client, phone, convo, lead);
        return true;
      }
      case 'escalate': await handleUniversalEscalate(client, phone, convo); return true;
      case 'cancel_flow':
        await Conversation.findByIdAndUpdate(convo._id, { lastStepId: null });
        await WhatsApp.sendText(client, phone, "Flow reset. Type 'Hi' to start over. 😊");
        return true;
    }
  }
  return false;
}

async function runAIFallback(parsedMessage, client, phone, lead, channel = 'whatsapp', convo = null) {
  let text = parsedMessage.text?.body;
  if (!text) {
      if (parsedMessage.type === 'interactive') {
          text = parsedMessage.interactive?.button_reply?.title || parsedMessage.interactive?.list_reply?.title;
      } else if (parsedMessage.type === 'button') {
          text = parsedMessage.button?.text;
      }
  }
  if (!text) return false;

  try {
    const callIntentRegex = /\b(call|phone|talk|speak|representative|human|agent|person|connect|callback|calling)\b/i;
    if (callIntentRegex.test(text)) {
      await NotificationService.sendAdminAlert(client, { customerPhone: phone, topic: 'Customer Requesting Call/Human', triggerSource: 'AI Active Listener' });
      await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $set: { status: 'HUMAN_TAKEOVER', lastInteraction: new Date() } });
      await sendWhatsAppText(client, phone, `I've just notified our team that you'd like to speak with someone. A representative will reach out to you shortly! 📞✨`);
      return true;
    }

    // --- PHASE 28: NATIVE ORDER TAKING (TRACK 5) ---
    const orderSettings = client.waOrderTaking || { enabled: false };
    const leadState = lead?.capturedData?.orderTakingState || 'idle';

    // A. State Breakout Logic (Sanity Check)
    if (leadState === 'awaiting_address' && text.length > 3) {
      const breakoutRegex = /\b(return|refund|cancel|help|support|agent|human|stop|who are you|what is)\b/i;
      if (breakoutRegex.test(text) || text.length > 100) {
        log.info(`[NativeOrder] State breakout detected for ${phone}. Clearing pending order.`);
        await AdLead.updateOne({ _id: lead._id }, { 
          $set: { "capturedData.orderTakingState": 'idle', "capturedData.pendingOrderItems": null } 
        });
        // Continue to normal AI flow below
      } else {
        // Assume this IS the address
        log.info(`[NativeOrder] Address captured for ${phone}`);
        const pendingItems = lead.capturedData?.pendingOrderItems;
        const paymentMethod = lead.capturedData?.pendingPaymentMethod || 'cod';

        if (pendingItems && Array.isArray(pendingItems)) {
          const result = await executeNativeOrder(client, phone, pendingItems, text, paymentMethod);
          if (result.success) {
            await AdLead.updateOne({ _id: lead._id }, { 
              $set: { "capturedData.orderTakingState": 'idle', "capturedData.pendingOrderItems": null, address: text } 
            });
            let confirmMsg = `✅ *Order Confirmed!* #${result.order.orderNumber}\n\n`;
            confirmMsg += result.order.items.map(i => `• ${i.name} (x${i.quantity})`).join('\n');
            confirmMsg += `\n\n💰 *Total:* ₹${result.order.totalPrice}`;
            
            if (result.paymentLink) {
              confirmMsg += `\n\n💳 *Complete Payment:* ${result.paymentLink}`;
            } else if (result.order.isCOD) {
              confirmMsg += `\n\n🏠 *Payment:* Cash on Delivery`;
            }
            
            await sendWhatsAppText(client, phone, confirmMsg);
            return true;
          }
        }
      }
    }

    // B. Order Intent Detection
    if (orderSettings.enabled && !leadState.startsWith('awaiting_')) {
      const orderIntentRegex = /\b(buy|order|purchase|want|get|send|need|pack|add to my order)\b/i;
      if (orderIntentRegex.test(text)) {
        log.info(`[NativeOrder] Detecting products in message: "${text}"`);
        const products = client.nicheData?.products || [];
        const apiKey = client.geminiApiKey || client.config?.geminiApiKey || process.env.GEMINI_API_KEY;
        const parsed = await extractOrderDetails(text, products, apiKey);

        if (parsed.isOrderIntent && Array.isArray(parsed.items) && parsed.items.length > 0) {
          log.info(`[NativeOrder] Valid items parsed: ${parsed.items.length}`);
          
          // Check for address
          const shippingAddress = parsed.address || lead?.address;
          const paymentMethod = parsed.paymentMethod === 'unspecified' ? (orderSettings.acceptCOD ? 'cod' : 'online') : parsed.paymentMethod;

          if (shippingAddress && shippingAddress.length > 5) {
            const result = await executeNativeOrder(client, phone, parsed.items, shippingAddress, paymentMethod);
            if (result.success) {
              let confirmMsg = `✅ *Order Confirmed!* #${result.order.orderNumber}\n\n`;
              confirmMsg += result.order.items.map(i => `• ${i.name} (x${i.quantity})`).join('\n');
              confirmMsg += `\n\n💰 *Total:* ₹${result.order.totalPrice}`;
              
              if (result.paymentLink) {
                confirmMsg += `\n\n💳 *Complete Payment:* ${result.paymentLink}`;
              } else if (result.order.isCOD) {
                confirmMsg += `\n\n🏠 *Payment:* Cash on Delivery`;
              }
              
              await sendWhatsAppText(client, phone, confirmMsg);
              return true;
            }
          } else {
            // Missing Address -> Enter State
            log.info(`[NativeOrder] Address missing, entering awaiting_address state for ${phone}`);
            await AdLead.updateOne({ _id: lead._id }, { 
              $set: { 
                "capturedData.orderTakingState": 'awaiting_address', 
                "capturedData.pendingOrderItems": parsed.items,
                "capturedData.pendingPaymentMethod": paymentMethod
              } 
            });
            await sendWhatsAppText(client, phone, `Great choice! I've noted down your items. 🛍️\n\n*Where should we ship this to?* Please provide your full delivery address.`);
            return true;
          }
        }
      }
    }

    // Billing: Check and Increment AI usage
    const usage = await checkLimit(client.clientId, 'aiCallsMade');
    if (!usage.allowed) {
        if (global.NotificationService) {
            await global.NotificationService.sendAdminAlert(client.clientId, `SaaS Limit Reached: ${usage.current}/${usage.limit} AI calls used.`, 'email');
        }
        return false;
    }
    await incrementUsage(client.clientId, 'aiCallsMade');
    await incrementUsage(client.clientId, 'messagesSent');

    let discountCode = client.nicheData?.globalDiscountCode || 'OFF10';

    if (client.aiUseGeneratedDiscounts && Array.isArray(client.generatedDiscounts) && client.generatedDiscounts.length > 0) {
      const latestDiscount = client.generatedDiscounts[client.generatedDiscounts.length - 1];
      if (latestDiscount?.code) discountCode = latestDiscount.code;
    }

    const isHesitating = /price|expensive|cost|discount|offer|deal|cheap|money/i.test(text);
    const bargainingInstruction = isHesitating 
        ? `The customer seems hesitant about price. You are authorized to offer a one-time discount code: "${discountCode}". Use it to close the deal!`
        : `If the customer asks for a deal, you can mention code "${discountCode}".`;

    const detectedLang = parsedMessage._detectedLanguage || convo?.detectedLanguage || 'en';
    const langInstruction = getLanguageInstructions(detectedLang);
    
    // Structured Knowledge Architecture
    const productCatalog = (client.nicheData?.products || [])
      .map(p => `- ${p.title}: ₹${p.price}. ${p.description || ''} ${p.url ? `Link: ${p.url}` : ''}`)
      .join('\n');
    
    const policyStore = client.nicheData?.policies || "Standard 7-day return policy applies unless specified.";
    // Phase 29 Track 3: AI Persona
    const persona = client.ai?.persona;
    const systemPrompt = buildPersonaSystemPrompt(client, client.nicheData?.aiPromptContext);
    
    // Phase 29 Track 4: AI Training (Few-Shot Retrieval)
    const examples = await getRelevantExamples(client.clientId, text);
    const fewShot = buildFewShotPrompt(examples);
    
    // ✅ Phase R3: Fetch REAL conversation history — convo.messages doesn't exist on Conversation schema
    // Was always [] causing AI to have zero memory of the ongoing conversation
    let recentMessageHistory = '';
    try {
      const recentMsgs = await Message.find({ conversationId: convo._id })
        .sort({ timestamp: -1 })
        .limit(5)
        .lean();
      recentMessageHistory = recentMsgs
        .reverse()
        .map(m => `${m.direction === 'incoming' ? 'Customer' : 'Bot'}: ${m.content || '[media]'}`)
        .join('\n');
    } catch (histErr) {
      log.warn('[AI] Failed to fetch message history:', histErr.message);
    }
    
    // Personalization Context
    const personalization = `
CUSTOMER CONTEXT:
- Name: ${lead.name || 'Friend'}
- Last Order: ${convo.metadata?.lastOrder?.orderNumber || 'None'}
- Cart Status: ${lead.cartStatus || 'Empty'}
- Loyalty Points: ${lead. LoyaltyPoints || 0}
`.trim();

    const prompt = `${systemPrompt}

${personalization}

KNOWLEDGE BASE:
[Products]
${productCatalog || "General inquiry handling."}

[Policies & FAQ]
${policyStore}

${fewShot}

INSTRUCTIONS:
1. RESPONSE STYLE: Concise (under 50 words) and helpful.
2. DISCOUNTS: ${bargainingInstruction}
3. MULTILINGUAL: ${langInstruction}
4. ESCALATION: If the customer asks for a human, is angry, or you cannot answer, say: "I'm connecting you to our specialist now. ⏳"
5. GOAL: Guide the user towards a purchase or booking.

CONVERSATION HISTORY (Last 5):
${recentMessageHistory}

CUSTOMER MESSAGE:
"${text}"

REPLY:
`;

    // --- PHASE 30: LOG AI START ---
    try {
      await BotAnalytics.create({
        clientId: client.clientId,
        phoneNumber: phone,
        event: 'AI_START',
        metadata: { text: text.substring(0, 100) }
      });
    } catch (_) {}

    let reply;
    try {
      const apiKeyToUse = client.geminiApiKey;
      if (!apiKeyToUse) {
        log.warn(`[AI Fallback] No Gemini API key for ${client.clientId}`);
        throw new Error("No API Key");
      }
      reply = await withTimeout(
        generateText(prompt, apiKeyToUse), 
        8000, 
        "Gemini AI Fallback Generation"
      );
    } catch (aiErr) {
      log.error(`[AI Fallback] Error resolving AI Fallback reply for ${client.clientId}:`, { error: aiErr.message });
      
      // If AI fails but we haven't matched a flow, we shouldn't necessarily PAUSE the bot
      // unless it's a critical system failure. We'll send a polite fallback and stay in BOT_ACTIVE.
      const isKeyError = aiErr.message.includes('API key') || aiErr.message.includes('No API Key');
      const isGeminiDown = aiErr.message.includes('404') || aiErr.message.includes('timed out') 
                         || aiErr.message.includes('timeout') || isKeyError;
      
      // GAP-GEN-4 FIX: Clear lastStepId so the user can restart fresh on next message.
      // Without this, the conversation stays pinned to the ai_fallback node which has
      // no outgoing edges, creating an infinite loop on every subsequent message.
      if (isGeminiDown) {
        await Conversation.findOneAndUpdate(
          { phone, clientId: client.clientId },
          { $set: { lastStepId: null, status: 'BOT_ACTIVE' } }
        );
        log.info(`[AI Fallback] Cleared lastStepId for ${phone} due to Gemini failure — user can restart fresh.`);
      }

      if (!isKeyError && global.NotificationService) {
         await global.NotificationService.sendAdminAlert(client, { customerPhone: phone, topic: 'AI Gateway Timeout/Failure', triggerSource: 'runAIFallback' });
         // Only escalate to HUMAN_TAKEOVER on actual logic/timeout errors, not missing keys
         await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $set: { status: 'HUMAN_TAKEOVER', lastInteraction: new Date() } });
      }

      const fallMsg = isKeyError 
        ? "I'm currently undergoing some maintenance. Please try again in 5 minutes or type 'Menu' to see my options!"
        : "I'm having trouble connecting to my AI brain right now. Let me transfer you to a human agent!";
      
      await sendWhatsAppText(client, phone, fallMsg);
      return true; // Halt standard flow but don't necessarily kill the bot status
    }
    
    // --- PHASE 30: LOG AI SUCCESS ---
    try {
      await BotAnalytics.create({
        clientId: client.clientId,
        phoneNumber: phone,
        event: 'AI_SUCCESS',
        metadata: { replyLength: reply.length }
      });
    } catch (_) {}
    
    // Phase 29 Track 3: Post-Process Persona Consistency
    reply = applyPersonaPostProcess(reply, persona);

    await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $set: { consecutiveFailedMessages: 0 } });
    
    // Phase 26: Voice Reply Logic
    const isVoiceInput = parsedMessage.type === 'audio' || parsedMessage.type === 'voice';
    const voiceEnabled = client.ai?.voiceRepliesEnabled || client.voiceRepliesEnabled;
    const voiceMode = client.ai?.voiceReplyMode || 'mirror';

    if (voiceEnabled && (voiceMode === 'always' || (voiceMode === 'mirror' && isVoiceInput))) {
      const voiceUrl = await generateVoiceReply(reply, client.ai?.voiceReplyLanguage || 'en-IN');
      if (voiceUrl) {
        await sendWhatsAppAudio(client, phone, voiceUrl);
        return;
      }
    }

    await sendWhatsAppText(client, phone, reply);
  } catch (err) {
    log.error('AI Fallback error:', { error: err.message });
    // --- PHASE 30: LOG AI FAILURE ---
    try {
      await BotAnalytics.create({
        clientId: client.clientId,
        phoneNumber: phone,
        event: 'AI_FAILURE',
        metadata: { error: err.message, text: text.substring(0, 50) }
      });
    } catch (_) {}

    const updatedConvo = await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $inc: { consecutiveFailedMessages: 1 } }, { new: true });
    if (updatedConvo && updatedConvo.consecutiveFailedMessages >= 3) {
      await handleUniversalEscalate(client, phone, updatedConvo);
      return;
    }
    await sendWhatsAppText(client, phone, "I'm having a bit of trouble understanding. Let me check with my team! 😊");
  }
}

async function sendWhatsAppText(client, phone, body, channel = 'whatsapp') {

  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const translated = await translateToUserLanguage(body, convo?.detectedLanguage, client);
    const bodyContent = String(translated || body).substring(0, 4096);
    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: bodyContent }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'text', bodyContent, res.data.messages[0].id);
  } catch (err) { log.error('sendText error:', { error: err.response?.data?.error?.message || err.message }); }
}

async function sendWhatsAppImage(client, phone, imageUrl, caption) {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const translatedCaption = await translateToUserLanguage(caption, convo?.detectedLanguage, client);
    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: imageUrl, caption: String(translatedCaption || caption).substring(0, 1024) }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'image', translatedCaption || caption || '[Image]', res.data.messages[0].id);
  } catch (err) { log.error('sendImage error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppAudio(client, phone, audioUrl) {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { link: audioUrl }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'audio', '[Voice Note]', res.data.messages[0].id);
  } catch (err) { log.error('sendAudio error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppInteractive(client, phone, interactive, bodyText = '') {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return false;

  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const lang = convo?.detectedLanguage;

    if (lang && lang !== 'en') {
        if (interactive.body?.text) interactive.body.text = await translateToUserLanguage(interactive.body.text, lang, client);
        if (interactive.header?.text) interactive.header.text = await translateToUserLanguage(interactive.header.text, lang, client);
        if (interactive.action?.buttons) {
            for (const btn of interactive.action.buttons) {
                if (btn.reply?.title) {
                    const transTitle = await translateToUserLanguage(btn.reply.title, lang, client);
                    btn.reply.title = transTitle.substring(0, 20);
                }
            }
        }
        if (interactive.action?.sections) {
            for (const sec of interactive.action.sections) {
                if (sec.title) sec.title = (await translateToUserLanguage(sec.title, lang, client)).substring(0, 24);
                if (sec.rows) {
                    for (const row of sec.rows) {
                        if (row.title) row.title = (await translateToUserLanguage(row.title, lang, client)).substring(0, 24);
                        if (row.description) row.description = (await translateToUserLanguage(row.description, lang, client)).substring(0, 72);
                    }
                }
            }
        }
    }

    if (!interactive.body?.text) {
      interactive.body = {
        text: String(bodyText || 'Please choose an option').substring(0, 1024)
      };
    }

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive
    };

    if (interactive.footer) {
      data.interactive.footer = { text: (interactive.footer.text || interactive.footer || '').substring(0, 60) };
    }

    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'interactive', interactive.body?.text || '[Interactive]', res.data.messages[0].id);
    return true;
  } catch (err) {
    const errorData = err.response?.data || err.message;
    log.error('sendInteractive error:', { 
        clientId: client.clientId,
        phone,
        error: errorData,
        payload: JSON.stringify(data, null, 2)
    });
    // Graceful fallback to plain text so user still gets a response.
    try {
      let fallbackText = interactive?.body?.text || bodyText || 'Please choose:';
      const options = [];
      if (interactive.action?.buttons) {
        interactive.action.buttons.forEach(b => options.push(b.reply?.title));
      } else if (interactive.action?.sections) {
        interactive.action.sections.forEach(s => {
          s.rows?.forEach(r => options.push(r.title));
        });
      }

      if (options.length > 0) {
        fallbackText += "\n\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
        fallbackText += "\n\n_Reply with the name or number._";
      }

      await sendWhatsAppText(client, phone, fallbackText);
    } catch (_) {}
    return false;
  }
}

async function sendWhatsAppTemplate(client, phone, templateName, languageCode, components = []) {
  const token = client.whatsappToken;
  const phoneNumberId = client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  
  try {
    let finalLang = languageCode;
    if (!finalLang) {
      const convo = await Conversation.findOne({ phone, clientId: client.clientId });
      finalLang = convo?.detectedLanguage || 'en';
    }

    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: templateName, language: { code: finalLang }, components }
    }, { headers: { Authorization: `Bearer ${token}` } });
    
    await saveOutboundMessage(phone, client.clientId, 'template', `[Template: ${templateName}]`, res.data.messages[0].id);
  } catch (err) { log.error('sendTemplate error:', { error: err.response?.data || err.message }); }
}

async function sendWhatsAppSmartTemplate(client, phone, templateName, variables = [], headerImage = null, languageCode = 'en') {
  try {
    const res = await WhatsAppUtils.sendSmartTemplate(client, phone, templateName, variables, headerImage, languageCode);
    if (res && res.messages && res.messages[0]) {
      await saveOutboundMessage(
        phone, 
        client.clientId, 
        'template', 
        `[SmartTemplate: ${templateName}]`, 
        res.messages[0].id
      );
    }
    return res;
  } catch (err) {
    if ((err.message || "").includes("132001")) {
      log.warn(`[DualBrain] Template ${templateName} failed (Missing). Fallback was triggered in WhatsApp utility.`);
      return;
    }
    log.error('sendSmartTemplate error:', { 
        clientId: client.clientId, 
        templateName, 
        error: err.response?.data || err.message 
    });
  }
}

async function sendWhatsAppFlow(client, phone, header, body, flowId, flowCta, screen) {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;

  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const lang = convo?.detectedLanguage;

    let finalHeader = (header || '').substring(0, 60);
    let finalBody = (body || 'Tap below to open the form and continue.').substring(0, 1024);
    let finalCta = (flowCta || 'Get Started').substring(0, 20);

    if (lang && lang !== 'en') {
        finalHeader = (await translateToUserLanguage(header, lang, client)).substring(0, 60);
        finalBody = (await translateToUserLanguage(body, lang, client)).substring(0, 1024);
        finalCta = (await translateToUserLanguage(flowCta, lang, client)).substring(0, 20);
    }

    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: {
        type: 'flow',
        header: { type: 'text', text: finalHeader || 'Action Required' },
        body: { text: finalBody },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: `flow_${Date.now()}_${phone}`,
            flow_id: flowId || '1244048577247022',
            flow_cta: finalCta || 'Get Started',
            flow_action: 'navigate',
            flow_action_payload: { screen: screen || 'MAIN_SCREEN' }
          }
        }
      }
    }, { headers: { Authorization: `Bearer ${token}` } });

    await saveOutboundMessage(phone, client.clientId, 'interactive', `[WhatsApp Flow] ${finalHeader}`, res.data.messages[0].id);

    // Increment Analytics
    try {
        const today = new Date().toISOString().split('T')[0];
        await DailyStat.findOneAndUpdate(
            { clientId: client.clientId, date: today },
            { $inc: { flowsSent: 1 } },
            { upsert: true }
        );
    } catch (err) { log.error('[Analytics] Flow send error:', { error: err.message }); }
  } catch (err) { 
    log.error('sendFlow error:', { error: err.response?.data || err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE R4: MESSAGE PERSISTENCE + SOCKET EMISSION
// These functions were called throughout the engine but never defined,
// causing silent ReferenceErrors. This is the root cause of the Severity-1
// bug where inbound/bot messages never appeared in Live Chat without refresh.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save an inbound (customer) message to the Message collection and emit
 * real-time events to all connected dashboard clients.
 *
 * @param {string} phone        - Customer phone number
 * @param {string} clientId     - Tenant client ID
 * @param {object} parsedMessage - Parsed webhook payload from handleWhatsAppMessage
 * @param {object} io           - Socket.io server instance (global.io)
 * @param {string} channel      - 'whatsapp' | 'instagram'
 * @param {string} conversationId - Mongoose ObjectId of the Conversation document
 */
async function saveInboundMessage(phone, clientId, parsedMessage, io, channel = 'whatsapp', conversationId) {
  try {
    // Extract text content from various message types
    const body = parsedMessage.text?.body
      || parsedMessage.interactive?.button_reply?.title
      || parsedMessage.interactive?.list_reply?.title
      || parsedMessage.caption
      || (parsedMessage.type === 'image' ? '[Image]' : '')
      || (parsedMessage.type === 'audio' || parsedMessage.type === 'voice' ? '[Voice Note]' : '')
      || (parsedMessage.type === 'video' ? '[Video]' : '')
      || (parsedMessage.type === 'document' ? '[Document]' : '')
      || (parsedMessage.type === 'sticker' ? '[Sticker]' : '')
      || '';

    const savedMessage = await createMessage({
      clientId,
      conversationId,
      phone,
      from: phone,
      to: 'BOT',
      direction: 'inbound',
      type: parsedMessage.type || 'text',
      body,
      messageId: parsedMessage.messageId || parsedMessage.id || '',
      mediaUrl: parsedMessage.mediaUrl || null,
      channel,
      translatedContent: parsedMessage.translatedContent || '',
      detectedLanguage: parsedMessage.detectedLanguage || 'en',
      originalText: parsedMessage.originalText || '',
      voiceTranscript: parsedMessage.voiceTranscript || ''
    });

    // Emit real-time events to dashboard
    if (io && clientId) {
      const updatedConvo = await Conversation.findById(conversationId)
        .populate('assignedTo', 'name')
        .lean();

      io.to(`client_${clientId}`).emit('new_message', savedMessage);
      if (updatedConvo) {
        io.to(`client_${clientId}`).emit('conversation_update', updatedConvo);
      }
    }

    return savedMessage;
  } catch (err) {
    log.error('[saveInboundMessage] Failed:', { phone, clientId, error: err.message });
    throw err;
  }
}

/**
 * Save an outbound (bot/system) message to the Message collection and emit
 * real-time events to all connected dashboard clients.
 *
 * @param {string} phone    - Customer phone number
 * @param {string} clientId - Tenant client ID
 * @param {string} type     - Message type: 'text' | 'image' | 'audio' | 'interactive' | 'template'
 * @param {string} body     - Message content/caption
 * @param {string} wamid    - WhatsApp message ID from Graph API response
 * @param {string} channel  - 'whatsapp' | 'instagram'
 */
async function saveOutboundMessage(phone, clientId, type, body, wamid, channel = 'whatsapp') {
  try {
    // Look up conversation for the conversationId foreign key
    const convo = await Conversation.findOne({ phone, clientId })
      .select('_id')
      .lean();

    const savedMessage = await createMessage({
      clientId,
      conversationId: convo?._id || null,
      phone,
      from: 'BOT',
      to: phone,
      direction: 'outbound',
      type: type || 'text',
      body: body || '',
      messageId: wamid || '',
      channel
    });

    // Emit real-time events to dashboard
    const io = global.io;
    if (io && clientId) {
      const updatedConvo = await Conversation.findOne({ phone, clientId })
        .populate('assignedTo', 'name')
        .lean();

      io.to(`client_${clientId}`).emit('new_message', savedMessage);
      if (updatedConvo) {
        io.to(`client_${clientId}`).emit('conversation_update', updatedConvo);
      }
    }

    return savedMessage;
  } catch (err) {
    log.error('[saveOutboundMessage] Failed:', { phone, clientId, type, error: err.message });
    // Don't throw — outbound save failures should not crash the bot reply flow
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE EXPORTS — Single source of truth
// All legacy duplicate functions (previously at bottom of file) have been
// removed. masterWebhook.js must use handleWhatsAppMessage or runDualBrainEngine.
// ─────────────────────────────────────────────────────────────────────────────
/** Commerce / webhook entry: same as walkFlow with persistence suppressed by default. */
async function executeAutomationFlow(opts) {
  return walkFlow({ suppressConversationPersistence: true, ...opts });
}

module.exports = {
  handleWhatsAppMessage,
  runDualBrainEngine,
  runFlow,
  walkFlow,
  executeAutomationFlow,
  executeNode,
  sendNodeContent,
  saveInboundMessage,
  saveOutboundMessage,
};

