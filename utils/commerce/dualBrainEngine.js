"use strict";

const axios        = require("axios");
const Conversation = require("../../models/Conversation");
const { buildReopenAttentionUpdate } = require('../core/supportConversationMetrics');
const AdLead       = require("../../models/AdLead");
const Message      = require("../../models/Message");
const DailyStat    = require("../../models/DailyStat");
const Client       = require("../../models/Client");
const emailService = require('../core/emailService');
const NotificationService = require('../core/notificationService');
const BillingService = require('./billingService');
const ProcessingLock = require('../../models/ProcessingLock');
const redisClient = require('../core/redisClient');
const InboundDeduplication = require('../../models/InboundDeduplication');
const log = require('../core/logger')('DualBrain');
const { generateText, getGeminiModel, AI_BOT_TIMEOUT_MS } = require('../core/gemini');
const { createMessage } = require('../core/createMessage');
const { injectVariables, buildVariableContext, injectNodeVariables, injectVariablesLegacy } = require('../core/variableInjector');
const {
  findMatchingFlow,
  findGreetingFlowFast,
  findFlowStartNode,
  isGreetingLikeText,
  shouldAllowGreetingKeywordTrigger,
  isExplicitFlowResetText,
} = require('../flow/triggerEngine');
const {
  getCachedFlowGraph,
  getCachedFlowGraphAsync,
  setCachedFlowGraph,
} = require('../flow/flowGraphCache');
const { createTimer } = require('../core/perfLogger');
const { shouldAttemptAICall, shouldAttemptAICallAsync } = require('../core/aiGuards');
const {
  beginEngineRun,
  getEngineRunId,
  abortEngineRun,
  isEngineRunAborted,
  markOutboundSent,
  wasOutboundSent,
  endEngineRun,
} = require('../core/engineRunRegistry');
const { findMatchingRule } = require('../core/rulesEngine');
const { evaluateRouting } = require('./routingEngine');
const { sendEmail } = require('../core/emailService');
const { checkLimit, incrementUsage } = require('../core/planLimits');
const { detectLanguage, translateToUserLanguage, normalizeIntent, getLanguageInstructions } = require('../core/languageEngine');
const { analyzeSentiment } = require('../core/sentimentEngine');
const { extractOrderDetails } = require('./orderParser'); // Phase 28 Track 5
const { executeNativeOrder } = require('./orderCreator'); // Phase 28 Track 5
const BotAnalytics = require("../../models/BotAnalytics");
const { buildPersonaSystemPrompt, applyPersonaPostProcess, resolveQuickFaqReply, buildQuickFaqDirective } = require('../core/personaEngine'); // Phase 29 Track 3
const { getRelevantExamples, buildFewShotPrompt } = require('../core/trainingEngine'); // Phase 29 Track 4
const { generatePaymentLink } = require('./paymentLinkGenerator'); // Phase 29 Track 7
const MessageBufferService = require('../../services/MessageBufferService');
const { resolveAndSaveMedia } = require('../meta/whatsappMedia');
const WhatsAppUtils = require('../meta/whatsapp');
const messageBuffer = require('../core/messageBuffer');
const { parseWhatsAppPayload } = require('../meta/parseWhatsAppPayload');
const { normalizeHandleId, findInteractiveEdgeForButtonAcrossGraph } = require('../flow/graphButtonRouting');
const { logFlowEvent } = require('../flow/flowObservability');
const { buildInteractiveHeaderFromNodeData } = require('../meta/waInteractiveHeader');
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
} = require('../meta/clientWhatsAppCreds');
const { discoverClientByPhoneId } = require('../core/clientDiscovery');
const { resolveClientGeminiKey } = require('../core/clientGeminiKey');
const NodeCache = require("node-cache");
const keywordTriggerCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

/** Resolved Meta / WA catalog id (same precedence as catalog send path). */
function getClientCatalogIdString(client) {
  return String(
    client.facebookCatalogId ||
      client.waCatalogId ||
      client.metaCatalogId ||
      client.commerceBotSettings?.facebookCatalogId ||
      client.commerceBotSettings?.waCatalogId ||
      client.platformVars?.facebookCatalogId ||
      client.platformVars?.waCatalogId ||
      process.env.META_CATALOG_ID ||
      ''
  ).trim();
}

const SESSION_LOCK_TIMEOUT = 10000; // 10 seconds (Fallback for TTL)
/** Hard cap for one inbound WhatsApp turn (Render free tier must stay well under this) */
const DUAL_BRAIN_BUDGET_MS =
  parseInt(process.env.DUAL_BRAIN_BUDGET_MS || '22000', 10) || 22000;
const REDIS_SESSION_LOCK_TTL_SEC = 60;

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
  sendProductList: (...args) => WhatsAppUtils.sendProductList(...args),
  sendSingleProduct: (...args) => WhatsAppUtils.sendSingleProduct(...args),
  sendMpmMarketingTemplate: (...args) => WhatsAppUtils.sendMpmMarketingTemplate(...args),
  sendAudio: (...args) => WhatsAppUtils.sendAudio ? WhatsAppUtils.sendAudio(...args) : Promise.resolve(),
};


const { generateVoiceReply } = require('../meta/voiceReply');

// ─────────────────────────────────────────────────────────────────────────────
// FLOW BUILDER HELPERS — handle nested folders/groups
// ─────────────────────────────────────────────────────────────────────────────

/** Canvas-only types — excluded from runtime traversal (large flows stay fast). */
const RUNTIME_SKIP_NODE_TYPES = new Set(["folder", "group", "sticky", "comment"]);

function flattenFlowNodes(nodes) {
  const flat = [];
  
  function traverse(nodeList) {
    if (!Array.isArray(nodeList)) return;
    for (const node of nodeList) {
      // Add the node itself (if it's an actual conversation node)
      if (node.type && !RUNTIME_SKIP_NODE_TYPES.has(node.type)) {
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
  const { resolveFlowGraphByRef, resolvePrimaryFlowGraph } = require('../flow/flowGraphResolver');

  if (convo?.activeFlowId) {
    const activeFlowId = String(convo.activeFlowId);
    const cached =
      (await getCachedFlowGraphAsync(client.clientId, activeFlowId)) ||
      getCachedFlowGraph(client.clientId, activeFlowId);
    if (cached?.nodes?.length) {
      return { nodes: cached.nodes, edges: cached.edges || [] };
    }

    const loaded = await resolveFlowGraphByRef(client.clientId, activeFlowId);
    if (loaded?.nodes?.length) {
      const graph = { nodes: loaded.nodes, edges: loaded.edges || [] };
      setCachedFlowGraph(client.clientId, activeFlowId, {
        ...graph,
        flowId: loaded.id,
        name: loaded.name,
      });
      return graph;
    }
  }

  const primary = await resolvePrimaryFlowGraph(client.clientId);
  if (primary.nodes?.length) {
    return { nodes: primary.nodes, edges: primary.edges || [] };
  }

  return { nodes: [], edges: [] };
}

/** Load flow graph by flowId (published preferred; falls back to draft / visualFlows / legacy). */
async function loadPublishedFlowByRef(clientId, flowRef) {
  if (!clientId || !flowRef) return null;
  const cached =
    (await getCachedFlowGraphAsync(clientId, flowRef)) ||
    getCachedFlowGraph(clientId, flowRef);
  if (cached?.nodes?.length) {
    return {
      id: cached.flowId || String(flowRef),
      name: cached.name || "",
      nodes: cached.nodes,
      edges: cached.edges || [],
    };
  }

  const { resolveFlowGraphByRef } = require('../flow/flowGraphResolver');
  const loaded = await resolveFlowGraphByRef(clientId, flowRef);
  if (!loaded?.nodes?.length) return null;

  setCachedFlowGraph(clientId, flowRef, {
    nodes: loaded.nodes,
    edges: loaded.edges,
    flowId: loaded.id,
    name: loaded.name,
  });

  return {
    id: loaded.id,
    name: loaded.name || "",
    nodes: loaded.nodes,
    edges: loaded.edges || [],
  };
}

const { normalizePhone } = require('../core/helpers');

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

  const Conversation = require('../../models/Conversation');
  const AdLead = require('../../models/AdLead');

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

async function handleWhatsAppMessage(arg1, arg2, phoneNumberId, profileName = '') {
  let from;
  let message;
  if (arg1 && typeof arg1 === 'object' && (arg1.type || arg1.id) && typeof arg2 === 'string') {
    message = arg1;
    from = arg2;
  } else {
    from = arg1;
    message = arg2;
  }

  let client;
  try {
    // 0. Find Client first to scope the session lock (root + nested whatsapp + WABA)
    client = await discoverClientByPhoneId(phoneNumberId);
    if (!client) {
        log.warn(`Client not found for phoneId: ${phoneNumberId}`);
        return;
    }

    // NOTE: Lock and Deduplication moved into runDualBrainEngine so ALL entry points are protected.
    // (Ecommerce, Salon, Turfs, etc. all call runDualBrainEngine directly)

    // Single Meta message object (not the full webhook POST body)
    const parsed = message;
    if (!parsed?.from && !from) {
      return;
    }
    log.info(`[DualBrain] Processing ${from}: "${(parsed.text?.body || parsed.interactive?.button_reply?.title || buildInboundBody(parsed)).substring(0, 50)}" type=${parsed.type || 'unknown'}`);

    // --- PHASE 23: Track 5 - Meta Flow Response (nfm_reply) ---
    if (parsed.interactive?.type === 'nfm_reply') {
        const flowResponse = parsed.interactive.nfm_reply;
        log.info(`🌊 Flow Submission detected from ${from}`, { response: flowResponse.response_json });
        
        try {
            const data = JSON.parse(flowResponse.response_json || '{}');
            const prevLead = await AdLead.findOne({ phoneNumber: from, clientId: client.clientId })
              .select('capturedData')
              .lean();
            const mergedCaptured = { ...(prevLead?.capturedData || {}), ...data };
            const lead = await AdLead.findOneAndUpdate(
                { phoneNumber: from, clientId: client.clientId },
                {
                  $set: {
                    lastInteraction: new Date(),
                    capturedData: mergedCaptured
                  },
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

            const convo = await Conversation.findOne({ phone: from, clientId: client.clientId });
            if (convo?.lastStepId) {
                const { nodes: flowNodes, edges: flowEdges } = await getFlowGraphForConversation(client, convo);
                const nextEdge = flowEdges.find((e) => e.source === convo.lastStepId);
                if (nextEdge && flowNodes.length) {
                    return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, from, global.io);
                }
            }
        } catch (err) {
            log.error('Flow processing error:', { error: err.message });
        }
        return;
    }

    // Resolve Media IDs if present (Phase 28 Track 2)
    const mediaObj = parsed.image || parsed.audio || parsed.video || parsed.document || parsed.sticker;
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
      sticker: message.sticker,
      reaction: message.reaction,
      location: message.location,
      contacts: message.contacts,
      order: message.order,
      caption:
        message.image?.caption ||
        message.video?.caption ||
        message.document?.caption ||
        '',
      channel: 'whatsapp',
      referral: message.referral,
      profileName,
      mediaUrl: parsed.mediaUrl,
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

/** Slim product list for AI prompts — keyword-ranked, max N items */
function buildRelevantProductSnippet(products, queryText, maxItems = 8) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return '';
  const q = String(queryText || '').toLowerCase();
  const scored = list.map((p) => {
    const title = String(p.title || p.name || '').toLowerCase();
    let score = 0;
    for (const w of q.split(/\s+/)) {
      if (w.length > 2 && title.includes(w)) score += 1;
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked =
    scored.filter((x) => x.score > 0).slice(0, maxItems).map((x) => x.p).length > 0
      ? scored.filter((x) => x.score > 0).slice(0, maxItems).map((x) => x.p)
      : list.slice(0, maxItems);
  return picked
    .map((p) => `- ${p.title || p.name}: ₹${p.price}. ${p.description || ''} ${p.url ? `Link: ${p.url}` : ''}`)
    .join('\n');
}

async function checkIntent(userText, intentDescription, clientId) {
  try {
    const prompt = `You are an intent classifier.
User Message: "${userText}"
Intent Description: "${intentDescription}"
Does the user message match the intent description? Reply ONLY with "YES" or "NO".`;
    const { callAI } = require('../core/aiGateway');
    const result = await callAI({
      clientId,
      feature: 'other',
      prompt,
      maxTokens: 8,
      temperature: 0,
      fast: true,
    });
    if (result?.content && result.content.toUpperCase().includes('YES')) {
      return true;
    }
  } catch (err) {
    log.warn(`AI Intent detection failed: ${err.message}`);
  }
  return false;
}

async function analyzeConversationIntelligence(client, phone, convo) {
   try {
       const CI = require('../core/customerIntelligence');
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
  const engineTimer = createTimer('DualBrain.runEngine', `${client?.clientId}:${phone}`);
  engineTimer.checkpoint('engine_invoked', { messageId, channel });

  // 1. SESSION LOCK — Atomic upsert with ownership ID
  // Uses findOneAndUpdate with $setOnInsert to atomically claim the lock.
  // The _lockOwnerId ensures only the owning request can release it.
  const _lockStartTime = Date.now();
  const crypto = require('crypto');
  const _lockOwnerId = crypto.randomUUID();
  const lockKey = `lock:session:${client.clientId}:${phone}`;
  const engineRunId = beginEngineRun(client.clientId, phone);
  try {
      if (redisClient && redisClient.status === 'ready') {
          // Redis atomic lock (30s TTL)
          const acquired = await redisClient.set(lockKey, _lockOwnerId, 'NX', 'EX', REDIS_SESSION_LOCK_TTL_SEC);
          if (!acquired) {
              log.warn(`[Lock] Session locked for ${phone} — will retry via inbound queue.`);
              try {
                const { enqueueInboundEngineRetry } = require('../messaging/inboundEngineQueue');
                await enqueueInboundEngineRetry({
                  clientId: client.clientId,
                  phone,
                  parsedMessage,
                });
              } catch (_) { /* fallback to in-memory queue */ }
              engineTimer.finish('lock_busy_redis');
              endEngineRun(client.clientId, phone);
              return false;
          }
          engineTimer.checkpoint('lock acquired (redis)');
      } else {
          // Fallback to MongoDB if Redis is unavailable
          const existingLock = await ProcessingLock.findOneAndUpdate(
            { phone, clientId: client.clientId },
            { $setOnInsert: { phone, clientId: client.clientId, _lockOwnerId, lockedAt: new Date() } },
            { upsert: true, new: true, lean: true }
          );
          if (existingLock._lockOwnerId !== _lockOwnerId) {
            log.warn(`[Lock] Session locked for ${phone} — will retry via inbound queue.`);
            try {
              const { enqueueInboundEngineRetry } = require('../messaging/inboundEngineQueue');
              await enqueueInboundEngineRetry({
                clientId: client.clientId,
                phone,
                parsedMessage,
              });
            } catch (_) { /* fallback */ }
            engineTimer.finish('lock_busy_mongo');
            endEngineRun(client.clientId, phone);
            return false;
          }
          engineTimer.checkpoint('lock acquired (mongo)');
      }
  } catch (lockErr) {
      if (lockErr.code === 11000) {
        log.warn(`[Lock] Session locked for ${phone} (duplicate key) — will retry via inbound queue.`);
        endEngineRun(client.clientId, phone);
        return false;
      }
      log.error(`[Lock] Unexpected lock error for ${phone}:`, lockErr.message);
      return true;
  }

  const runEngineBody = async () => {
    const perf = createTimer('DualBrain.runEngineBody', `${client.clientId}:${phone}`);
    perf.checkpoint('runEngineBody_start');
    const profileName = parsedMessage.profileName || '';
    const inboundText = parsedMessage.text?.body || parsedMessage.interactive?.button_reply?.title || parsedMessage.interactive?.list_reply?.title || '';
    const txtLower = inboundText.toLowerCase().trim();
    const inboundGeminiKey = resolveClientGeminiKey(client);
    const tenantAiEnabled = await shouldAttemptAICallAsync('tenant', client);

    // --- Name guard + session upserts in parallel ---
    const parallelTasks = [
      Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        {
          $setOnInsert: {
            phone,
            clientId: client.clientId,
            lastStepId: null,
            botPaused: false,
            status: "BOT_ACTIVE",
          },
          $inc: { unreadCount: 1 },
          $set: {
            lastInteraction: new Date(),
            ...(profileName && { customerName: profileName }),
          },
        },
        { upsert: true, new: true, lean: true }
      ),
      AdLead.findOneAndUpdate(
        { phoneNumber: phone, clientId: client.clientId },
        {
          $setOnInsert: {
            phoneNumber: phone,
            clientId: client.clientId,
            source: parsedMessage.referral ? "Meta Ad" : "Direct",
          },
          $set: {
            lastInteraction: new Date(),
            lastInboundAt: new Date(),
            lastMessageContent: inboundText || `[${parsedMessage.type || "Message"}]`,
            ...(profileName && { name: profileName, nameSource: "whatsapp" }),
          },
        },
        { upsert: true, new: true, lean: true }
      ),
    ];
    if (profileName) {
      parallelTasks.push(
        AdLead.findOne(
          { phoneNumber: phone, clientId: client.clientId },
          { isNameCustom: 1, nameSource: 1, name: 1 }
        ).lean()
      );
    }
    const parallelResults = await Promise.all(parallelTasks);
    let convo = parallelResults[0];
    let lead = parallelResults[1];
    let shouldSetCustomerName = !!profileName;
    if (profileName && parallelResults[2]) {
      const existingLeadForName = parallelResults[2];
      if (
        (existingLeadForName?.isNameCustom || existingLeadForName?.nameSource === "imported") &&
        existingLeadForName?.name
      ) {
        shouldSetCustomerName = false;
        await Promise.all([
          Conversation.updateOne(
            { _id: convo._id },
            { $unset: { customerName: "" } }
          ).catch(() => {}),
          AdLead.updateOne(
            { _id: lead._id },
            { $unset: { name: "", nameSource: "" } }
          ).catch(() => {}),
        ]);
      }
    }
    perf.checkpoint("session_upserted");

    // If a user messages us again after opting out, treat that inbound as renewed consent.
    // This is tenant-scoped and applies only to WhatsApp inbound traffic.
    if (channel === "whatsapp") {
      const waConsentStatus = String(
        lead?.channelConsent?.whatsapp?.status || lead?.optStatus || ""
      ).toLowerCase();
      const wasOptedOut = waConsentStatus === "opted_out";
      if (wasOptedOut) {
        try {
          const now = new Date();
          await Promise.all([
            AdLead.updateOne(
              { _id: lead._id },
              {
                $set: {
                  optStatus: "opted_in",
                  whatsappMarketingEligible: true,
                  optOutDate: null,
                  optOutSource: "",
                  optOutReason: "",
                  optOutKeyword: "",
                  "channelConsent.whatsapp.status": "opted_in",
                  "channelConsent.whatsapp.source": "inbound_message",
                  "channelConsent.whatsapp.lastUpdated": now,
                  "channelConsent.whatsapp.timestamp": now,
                  "channelConsent.whatsapp.unsubscribeAt": null,
                },
                $push: {
                  optInHistory: {
                    event: "opted_in",
                    action: "opted_in",
                    source: "inbound_message",
                    method: "single",
                    timestamp: now,
                    note: "Auto re-opt-in on inbound user message",
                  },
                },
              }
            ),
            Conversation.updateOne(
              { _id: convo._id },
              {
                $set: {
                  botPaused: false,
                  isBotPaused: false,
                  botStatus: "active",
                  status: "BOT_ACTIVE",
                  requiresAttention: false,
                },
              }
            ),
            SuppressionList.deleteOne({ clientId: client.clientId, phone }),
          ]);

          lead.optStatus = "opted_in";
          if (!lead.channelConsent) lead.channelConsent = {};
          if (!lead.channelConsent.whatsapp) lead.channelConsent.whatsapp = {};
          lead.channelConsent.whatsapp.status = "opted_in";
          convo.botPaused = false;
          convo.status = "BOT_ACTIVE";
          convo.isBotPaused = false;
          convo.botStatus = "active";

          log.info(
            `[DualBrain] Auto re-opted-in on inbound for ${client.clientId}:${phone}`
          );
        } catch (reoptErr) {
          log.warn(
            `[DualBrain] Auto re-opt-in failed for ${client.clientId}:${phone}: ${reoptErr.message}`
          );
        }
      }
    }

    // Resolve media IDs for live chat preview (image/video/audio/document/sticker)
    if (channel === 'whatsapp' && !parsedMessage.mediaUrl) {
      const mediaObj =
        parsedMessage.image ||
        parsedMessage.audio ||
        parsedMessage.video ||
        parsedMessage.document ||
        parsedMessage.sticker;
      if (mediaObj?.id) {
        try {
          parsedMessage.mediaUrl = await resolveAndSaveMedia(mediaObj.id, client);
        } catch (mediaErr) {
          log.warn('[DualBrain] Media resolve failed:', { error: mediaErr.message });
        }
      }
    }

    // ── LIVE CHAT FAST PATH: persist + socket emit before language/AI/rules ──
    try {
      await saveInboundMessage(phone, client.clientId, parsedMessage, io, channel, convo._id, convo);
      parsedMessage._liveChatPersisted = true;
      perf.checkpoint("message_saved_early");
    } catch (earlySaveErr) {
      log.error("[InboundSave] Early persist failed:", { error: earlySaveErr.message });
    }

    // ── EARLY GREETING FAST PATH (before translation, rules, heavy flow loads) ──
    const isEarlyGreeting =
      inboundText &&
      !convo.botPaused &&
      !parsedMessage.interactive?.button_reply &&
      !parsedMessage.interactive?.list_reply &&
      (isGreeting(txtLower) || isGreetingLikeText(inboundText)) &&
      shouldAllowGreetingKeywordTrigger(inboundText, convo) &&
      txtLower.length <= 48 &&
      convo.status !== "HUMAN_SUPPORT" &&
      convo.status !== "HUMAN_TAKEOVER";

    if (isEarlyGreeting) {
      try {
        const waMsgId = parsedMessage?.id || parsedMessage?.messageId;
        if (waMsgId && channel === "whatsapp") {
          setImmediate(() => {
            const whatsapp = require('../meta/whatsapp');
            whatsapp.markRead(client, waMsgId).catch(() => {});
          });
        }

        const match = await findGreetingFlowFast(client, convo, inboundText, channel);
        perf.checkpoint("flow_match_greeting");

        if (match?.startNodeId) {
          const loaded = await loadPublishedFlowByRef(client.clientId, match.flowId);
          if (loaded?.nodes?.length) {
            const flowNodes = loaded.nodes;
            const flowEdges = loaded.edges || [];
            const resolvedActiveFlowId = loaded.id || match.flowId;

            if (!parsedMessage._liveChatPersisted) {
              try {
                await saveInboundMessage(
                  phone,
                  client.clientId,
                  parsedMessage,
                  io,
                  channel,
                  convo._id,
                  convo
                );
              } catch (err) {
                log.error("[InboundSave] Failed:", { error: err.message });
              }
            }

            await Conversation.findByIdAndUpdate(convo._id, {
              activeFlowId: resolvedActiveFlowId,
              lastStepId: null,
              lastMessageAt: new Date(),
            });

            const freshConvo = await Conversation.findById(convo._id);

            if (!isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
              const handled = await executeNode(
                match.startNodeId,
                flowNodes,
                flowEdges,
                client,
                freshConvo,
                lead,
                phone,
                io,
                channel,
                parsedMessage
              );
              if (handled !== false) {
                perf.checkpoint("greeting_sent");
                perf.finish();
                setImmediate(() =>
                  analyzeConversationIntelligence(client, phone, freshConvo)
                );
                return true;
              }
            }
          } else {
            log.warn(
              `[DualBrain] Greeting flow ${match.flowId} missing published graph — falling through`
            );
          }
        } else {
          const isNewConvo =
            !convo?.lastStepId ||
            !convo?.lastMessageAt ||
            convo.status === "new";
          if (isNewConvo) {
            const quickWelcome =
              client?.nicheData?.welcomeMessage ||
              client?.growthWidgetConfig?.welcomeMessage ||
              `Hi! 👋 Thanks for messaging ${client.businessName || "us"}. How can we help you today?`;
            await sendWhatsAppText(client, phone, quickWelcome, "whatsapp", {
              skipTranslation: true,
              skipConvoLookup: true,
            });
            perf.checkpoint("greeting_instant_fallback");
            perf.finish();
            return true;
          }
        }
      } catch (fpErr) {
        log.warn("[DualBrain] Early greeting path skipped:", fpErr.message);
      }
    }

    // --- GAP-GEN-3: COMMERCE AUTOMATION ISOLATION ---
    // If this is an ecommerce event, route it to the isolated WhatsAppFlow automation
    // (suppressConversationPersistence so lastStepId / activeFlowId stay on the main journey).
    const triggerTypes = ['order_placed', 'abandoned_cart', 'order_fulfilled'];
    if (triggerTypes.includes(parsedMessage?.type)) {
      const WhatsAppFlow = require('../../models/WhatsAppFlow');
      const Conversation = require('../../models/Conversation');
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

    // --- STEP 1: KEYWORD TRIGGERS (Settings → Keyword triggers) ---
    // Moved to *after* Smart message rules (automationRules) so hub rules can win
    // when they send a reply or pause — see block after PHASE 22 rules evaluation.

    // --- STEP 2: SELECTIVE AI INGESTION (Phase 30) ---
    // Only call detection/translation if not handled by a keyword.
    const { detectLanguage, translateText } = require('../core/translationEngine');
    let detectedLanguage = 'en';

    if (inboundText && inboundText.length > 2 && tenantAiEnabled) {
        try {
            detectedLanguage = await perf.time('language detection', () =>
              detectLanguage(inboundText, inboundGeminiKey)
            );
            parsedMessage.detectedLanguage = detectedLanguage;
            perf.checkpoint('language detected', { lang: detectedLanguage });
        } catch (err) {
            perf.log(`language detection skipped: ${err.message}`);
        }
    } else {
        perf.log(`language detection skipped (ai=${tenantAiEnabled}, len=${inboundText?.length || 0})`);
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
              const FollowUpSequence = require('../../models/FollowUpSequence');
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
                  const WhatsAppFlow = require("../../models/WhatsAppFlow");
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
    const CI = require('../core/customerIntelligence');
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
      const translated = await translateText(
        inboundText,
        translationConfig.agentLanguage || 'en',
        inboundGeminiKey || ''
      );
      if (translated && translated !== inboundText) {
          parsedMessage.translatedContent = translated;
          parsedMessage.originalText = inboundText;
      }
  }

  // STEP 3: Ensure inbound row exists for automation rules (early save may have run above).
  if (!parsedMessage._liveChatPersisted) {
    try {
      await saveInboundMessage(phone, client.clientId, parsedMessage, io, channel, convo._id, convo);
    } catch (err) {
      log.error('[InboundSave] Failed:', { error: err.message });
    }
  }
  perf.checkpoint("message_saved");

  // STEP 3.5: SUBSCRIPTION LIMIT CHECK (Phase 23)
  const limits = await perf.time('plan limit check', () => checkLimit(client._id, 'messages'));
  perf.checkpoint('plan limit checked', { allowed: limits.allowed });
  if (!limits.allowed) {
      log.warn(`Limit Reached for ${client.clientId}. Halting DualBrain Engine processing.`);
      try {
        await sendWhatsAppText(
          client,
          phone,
          "We've reached our WhatsApp message limit for this billing period. Please contact the store team directly — they'll reply as soon as possible."
        );
      } catch (limitNotifyErr) {
        log.warn(`[Limit] Could not notify ${phone}:`, limitNotifyErr.message);
      }
      return true;
  }
  // Track this transaction 
  await incrementUsage(client._id, 'messages', 1);

  // ── PHASE 30: Custom QR Scan Matching (Enterprise) ────────────────────────────────
  const qrRefMatch = incomingText.match(/(\(Ref:\s*(QR_[a-zA-Z0-9_]+)\))/i);
  if (qrRefMatch && qrRefMatch[2]) {
    const qrRefId = qrRefMatch[2].toUpperCase();
    const QRCodeModel = require('../../models/QRCode');
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

      // Fire webhook
      const { fireWebhookEvent } = require('../core/webhookDelivery');
      fireWebhookEvent(client.clientId, 'qr.scanned', { phone: lead.phoneNumber, qrCode: scannedQr.name, shortCode: scannedQr.shortCode });

      // Check for Direct-To-Flow logic
      if (scannedQr.config?.flowId && scannedQr.config.flowId !== '') {
        log.info(`[QR Logic] Redirecting ${lead.phoneNumber} to flow ${scannedQr.config.flowId}`);
        const targetFlow =
          (await loadPublishedFlowByRef(client.clientId, scannedQr.config.flowId)) ||
          (client.visualFlows || []).find((f) => f.id === scannedQr.config.flowId);
        if (targetFlow) {
           const { findFlowStartNode } = require('../flow/triggerEngine');
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
      if (negotiatedResponse?.handled && negotiatedResponse.reply) {
          await sendWhatsAppText(client, phone, negotiatedResponse.reply);
          // Preempt further processing since we're handling the objection
          return true;
      }
  }

  // ── PHASE 22: EVALUATE AUTOMATION RULES (ordered actions; optional Flow Builder passthrough) ──
  let inboundCountPostSave = 0;
  try {
    inboundCountPostSave = await Message.countDocuments({
      conversationId: convo._id,
      direction: 'inbound',
    });
  } catch (cntErr) {
    log.warn('[DualBrain] inbound count for rules failed:', cntErr.message);
  }
  const ruleEvalContext = { ...variableContext, _inboundCountPostSave: inboundCountPostSave };
  const { findMatchingTrigger } = require('../../services/keywordResolver');
  const triggerMatch = await findMatchingTrigger({
    client,
    clientId: client.clientId,
    message: parsedMessage.text?.body,
    context: ruleEvalContext,
  });
  const matchedRule = triggerMatch?.type === 'behavior' ? triggerMatch.match : null;
  if (matchedRule?.actions?.length) {
    const moment = require('moment');
    const SEQUENCE_TEMPLATES = require('../../data/sequenceTemplates');
    const FollowUpSequence = require('../../models/FollowUpSequence');
    const axios = require('axios');

    // Only continue into Flow Builder / graph when explicitly opted in (checkbox ON).
    // Undefined/false = exclusive (matches Rules UI: "Leave off so this rule alone handles…").
    const continueToFlow = matchedRule.continueToFlowAfterActions === true;
    let ruleIntercepted = false;

    const emitLeadTags = async () => {
      const fresh = await AdLead.findById(lead._id).select('tags').lean();
      if (fresh && io) {
        io.to(`client_${client.clientId}`).emit('lead_tags_updated', {
          phone: lead.phoneNumber,
          leadId: String(lead._id),
          tags: fresh.tags || [],
        });
      }
    };

    const normalizeSeqUnit = (u) => {
      const raw = String(u || 'm').toLowerCase();
      if (raw === 'm' || raw === 'min' || raw === 'mins') return 'm';
      if (raw === 'h' || raw === 'hr' || raw === 'hour' || raw === 'hours') return 'h';
      if (raw === 'd' || raw === 'day' || raw === 'days') return 'd';
      return 'm';
    };

    const mapTemplateToSteps = (seqData) => {
      let cursor = moment();
      return (seqData.steps || []).map((s) => {
        const unit = normalizeSeqUnit(s.delayUnit);
        const val = Number(s.delayValue) || 0;
        const addUnit = unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : 'days';
        cursor = cursor.clone().add(val, addUnit);
        return {
          type: 'whatsapp',
          templateName: s.templateName || '',
          content: s.content || '',
          delayValue: val,
          delayUnit: unit,
          sendAt: cursor.toDate(),
          status: 'pending',
        };
      });
    };

    for (const action of matchedRule.actions) {
      try {
        switch (action.type) {
          case 'send_message':
            if (action.text) {
              await sendWhatsAppText(client, phone, action.text);
              ruleIntercepted = true;
            }
            break;
          case 'send_template':
            if (action.templateName) {
              await sendWhatsAppSmartTemplate(
                client,
                phone,
                action.templateName,
                [variableContext.first_name || 'Customer'],
                null,
                variableContext.detectedLanguage || 'en'
              );
              ruleIntercepted = true;
            }
            break;
          case 'add_tag':
            if (action.tag) {
              const { normalizeLeadTagForAdd, applyNeedHelpTag } = require('./needHelpTag');
              const normalized = normalizeLeadTagForAdd(action.tag);
              if (normalized === 'Need help') {
                await applyNeedHelpTag(client.clientId, phone);
              } else if (normalized) {
                await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: normalized } });
              }
              await emitLeadTags();
            }
            break;
          case 'pause_bot':
            await Conversation.findByIdAndUpdate(convo._id, {
              botPaused: true,
              isBotPaused: true,
              botStatus: 'paused',
            });
            if (io) {
              io.to(`client_${client.clientId}`).emit('bot_status_changed', {
                conversationId: convo._id,
                botPaused: true,
                status: 'paused',
              });
            }
            ruleIntercepted = true;
            break;
          case 'enroll_sequence':
            if (action.sequenceId) {
              try {
                const {
                  isDeprecatedSequenceTemplateId,
                  isLegacyNicheAutomationBlocked,
                } = require('../../config/ecommerceOnlyPolicy');
                if (
                  isLegacyNicheAutomationBlocked() &&
                  isDeprecatedSequenceTemplateId(action.sequenceId)
                ) {
                  log.warn('[RulesEngine] Skipped deprecated sequence', { sequenceId: action.sequenceId });
                  break;
                }
                const seqData = SEQUENCE_TEMPLATES.find((t) => t.id === action.sequenceId);
                if (seqData) {
                  const mappedSteps = mapTemplateToSteps(seqData);
                  const { ensureLeadForSequence } = require('../messaging/ensureLeadForSequence');
                  const seqLead =
                    lead?._id
                      ? lead
                      : await ensureLeadForSequence({
                          clientId: client.clientId,
                          phone: lead?.phoneNumber || from,
                          source: 'rules_engine',
                        });
                  await FollowUpSequence.create({
                    clientId: client.clientId,
                    leadId: seqLead._id,
                    phone: seqLead.phoneNumber || lead?.phoneNumber || from,
                    email: seqLead.email,
                    name: seqData.name || 'Automation sequence',
                    type: 'custom',
                    steps: mappedSteps,
                  });
                }
              } catch (seqErr) {
                log.warn('[RulesEngine] enroll_sequence failed', seqErr.message);
              }
            }
            break;
          case 'assign_agent':
            if (action.agentId) {
              convo.assignedAgent = action.agentId;
              await Conversation.findByIdAndUpdate(convo._id, { assignedAgent: action.agentId });
            }
            break;
          case 'execute_webhook':
            if (action.webhookUrl) {
              axios.post(action.webhookUrl, { lead, convo, client, event: 'automation_rule_trigger' }).catch((e) => log.error(`Webhook failed: ${action.webhookUrl}`, e));
            }
            break;
          case 'adjust_score':
            if (action.score) {
              await AdLead.findByIdAndUpdate(lead._id, { $inc: { leadScore: action.score } });
            }
            break;
          default:
            break;
        }
      } catch (actErr) {
        log.error('[RulesEngine] action failed', actErr.message);
      }
    }

    if (ruleIntercepted && !continueToFlow) {
      log.info(`Rules Engine intercepted message processing for ${phone} (exclusive mode)`);
      return true;
    }
    if (ruleIntercepted && continueToFlow) {
      log.info(`Rules Engine ran actions for ${phone}; continuing to flows / AI (continueToFlowAfterActions)`);
    }
  }

  // Product restock watch — confirm pending OOS notify offer
  if (inboundText && convo?.metadata?.pendingProductWatch) {
    try {
      const { isAffirmativeReply, upsertProductWatch, resolveLeadId } = require('../../services/productWatch/captureProductWatch');
      if (isAffirmativeReply(inboundText)) {
        const pw = convo.metadata.pendingProductWatch;
        const leadId = (await resolveLeadId(client.clientId, phone)) || lead?._id;
        await upsertProductWatch({
          clientId: client.clientId,
          leadId,
          phone,
          sku: pw.sku,
          productName: pw.productName,
          productUrl: pw.productUrl,
          variantId: pw.variantId,
          productId: pw.productId,
        });
        await Conversation.findByIdAndUpdate(convo._id, { $unset: { 'metadata.pendingProductWatch': '' } });
        await sendWhatsAppText(
          client,
          phone,
          `You're on the list! We'll WhatsApp you when *${pw.productName || 'this item'}* is back in stock.`
        );
        return true;
      }
    } catch (pwErr) {
      log.warn(`[ProductWatch] capture failed: ${pwErr.message}`);
    }
  }

  // --- STEP 1b: KEYWORD TRIGGERS (canonical via keywordResolver) ---
  if (inboundText && !convo.botPaused) {
    let matchedTrigger = null;
    if (triggerMatch?.type === 'keyword') {
      matchedTrigger = triggerMatch.match;
    } else if (!matchedRule) {
      const retry = await findMatchingTrigger({
        client,
        clientId: client.clientId,
        message: inboundText,
        context: ruleEvalContext,
      });
      if (retry?.type === 'keyword') matchedTrigger = retry.match;
    }

    if (matchedTrigger) {
      log.info(`[KeywordEngine] Match after rules: ${matchedTrigger.keyword}.`);

      if (matchedTrigger.actionType === 'trigger_flow') {
        const flow =
          (await loadPublishedFlowByRef(client.clientId, matchedTrigger.targetId)) ||
          (client.visualFlows || []).find((f) => f.id === matchedTrigger.targetId);
        if (flow) {
          const flat = flattenFlowNodes(flow.nodes || []);
          const startNodeId = findFlowStartNode(flat, flow.edges || []);
          if (startNodeId) {
            return await runFlow(client, phone, flow, startNodeId, {
              triggerSource: "keyword",
            });
          }
        }
      } else if (matchedTrigger.actionType === 'send_template') {
        const { resolveClientTemplate } = require('../core/clientTemplateLookup');
        const tpl = await resolveClientTemplate(client, { id: matchedTrigger.targetId });
        const tplName = tpl?.templateName || tpl?.name;
        if (tplName) {
          const { sendByName } = require('../../services/templateSender');
          const sent = await sendByName({
            clientId: client.clientId,
            phone,
            templateName: tplName,
            contextData: {},
          });
          if (sent?.whatsapp?.sent) return true;
          await sendWhatsAppTemplate({
            phoneNumberId: client.phoneNumberId,
            to: phone,
            io,
            clientConfig: client,
            templateName: tplName,
            languageCode: tpl.language || 'en_US',
          });
          return true;
        }
      }
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
           const User = require('../../models/User');
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
  
  // ── RTO Protection Suite: COD confirm + NDR rescue (WhatsApp button taps) ──
  if (parsedMessage.type === 'interactive' && parsedMessage.interactive?.button_reply?.id) {
    const rtoBid = String(parsedMessage.interactive.button_reply.id);
    if (rtoBid === 'cod_yes' || rtoBid === 'cod_no') {
      const rtoProtectionService = require('./rtoProtectionService');
      const handled = await rtoProtectionService.handleFlowCodButton({ client, phone, buttonId: rtoBid });
      if (handled) return true;
    }
    if (rtoBid.startsWith('rto_cod_confirm_') || rtoBid.startsWith('rto_cod_cancel_')) {
      const rtoProtectionService = require('./rtoProtectionService');
      if (!rtoProtectionService.rtoCfg(client).requireCodConfirmation) {
        await sendWhatsAppText(
          client,
          phone,
          'COD confirmation on WhatsApp is turned off for this store. For order help, reply *menu*.'
        );
        return true;
      }
      await rtoProtectionService.handleCodConfirmationButton({ client, phone, buttonId: rtoBid });
      return true;
    }
    if (rtoBid.startsWith('rto_ndr_alt_') || rtoBid.startsWith('rto_ndr_addr_')) {
      const rtoProtectionService = require('./rtoProtectionService');
      await rtoProtectionService.handleNdrRescueButton({ client, phone, buttonId: rtoBid });
      return true;
    }
    if (rtoBid.startsWith('cart_btn_') || /^cart_recovery/i.test(rtoBid)) {
      try {
        const { recordCartRecoveryClick } = require('./cartRecoveryAttemptService');
        await recordCartRecoveryClick({
          clientId: client.clientId,
          phone,
          clickType: 'button',
        });
      } catch (_) {
        /* non-fatal */
      }
    }
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
  
  const defaultOptOutKeywords = [
    'stop',
    'unsubscribe',
    'opt out',
    'optout',
    'cancel',
    'no',
    'quit',
    'end',
    'remove me',
    'do not contact',
    'halt',
    'block bot',
    'nahi',
    'band karo',
    'band karo.',
  ];
  const customStopKeywords = Array.isArray(client?.growthCompliance?.stopKeywords)
    ? client.growthCompliance.stopKeywords
        .map((k) => String(k || '').trim().toLowerCase())
        .filter(Boolean)
    : [];
  const optOutKeywords = [...new Set([...defaultOptOutKeywords, ...customStopKeywords])];
  const optInKeywords  = ['start', 'yes', 'subscribe', 'opt in', 'optin', 'resume', 'unpause'];
  const {
    buildKeywordOptInSetFields,
    buildKeywordOptInHistoryEntry,
  } = require('./marketingOptStatusRules');

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
      await sendWhatsAppText(client, phone, "Understood. You won't receive marketing updates.", 'whatsapp', { complianceExempt: true });
      return true;
    }
  }

  // Re-permission campaign button / keyword confirmation
  const rePermissionYes = ['repermission_yes', 're_permission_yes', 'yes_sign_me_up', 'yes sign me up'];
  const rePermissionNo = ['repermission_no', 're_permission_no', 'no_thanks', 'no thanks'];
  const rawInboundId =
    parsedMessage?.interactive?.button_reply?.id ||
    parsedMessage?.interactive?.list_reply?.id ||
    '';
  const inboundButtonId = String(rawInboundId).toLowerCase().trim();

  if (/^csat_\d_/i.test(String(rawInboundId))) {
    try {
      const Conversation = require('../../models/Conversation');
      const { handleCSATResponse } = require('../core/csatService');
      const convo = await Conversation.findOne({ clientId: client.clientId, phone }).sort({ updatedAt: -1 });
      if (convo) {
        const reply = await handleCSATResponse(convo._id, rawInboundId);
        if (reply) {
          await sendWhatsAppText(client, phone, reply);
          return true;
        }
      }
    } catch (csatErr) {
      log.warn(`[DualBrain] CSAT handler skipped: ${csatErr.message}`);
    }
  }

  if (rePermissionYes.includes(inboundButtonId) || userTextLower === 'yes sign me up') {
    const { buildKeywordOptInSetFields, buildKeywordOptInHistoryEntry } = require('./marketingOptStatusRules');
    const updatedLead = await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      {
        $set: buildKeywordOptInSetFields(),
        $push: {
          optInHistory: {
            ...buildKeywordOptInHistoryEntry(),
            source: 're_permission_campaign',
          },
        },
      },
      { new: true }
    );
    if (!updatedLead) {
      log.warn(`[DualBrain] Re-permission opt-in: lead not found for ${phone}`);
      return true;
    }
    await sendWhatsAppText(client, phone, client?.growthWidgetConfig?.welcomeMessage || "You're subscribed to WhatsApp updates. Thank you!", 'whatsapp', { complianceExempt: true });
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
      const SuppressionList = require('../../models/SuppressionList');
      await SuppressionList.findOneAndUpdate(
        { clientId: client.clientId, phone },
        { $set: { reason: 'opted_out', source: 're_permission_campaign', addedAt: new Date() } },
        { upsert: true }
      );
    } catch (_) {}
    await sendWhatsAppText(client, phone, "Understood. We won't send marketing updates.", 'whatsapp', { complianceExempt: true });
    return true;
  }

  if (optOutKeywords.some(k => userTextLower === k || userTextLower.startsWith(`${k} `))) {
    log.info(`🛑 Opt-out detected for ${phone}. Running global kill switch.`);

    const { executeGlobalOptOut } = require('./optOutKillSwitch');
    await executeGlobalOptOut({
      client,
      phone,
      source: 'keyword_stop',
      keyword: userTextRaw,
      conversationId: convo._id,
      sendConfirmation: true,
      io,
    });

    const NotificationService = require('../core/notificationService');
    await NotificationService.sendAdminAlert(client, {
      customerPhone: phone,
      conversationId: convo._id,
      topic: '🔕 USER OPTED OUT',
      triggerSource: `User sent "${userTextRaw}". Bot is now PAUSED; pending jobs cancelled.`,
      channel: 'both',
    });
    return true;
  }

  if (optInKeywords.some(k => userTextLower === k)) {
    const updatedLead = await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      {
        $set: buildKeywordOptInSetFields(),
        $pull: { tags: 'Opted Out' },
        $addToSet: { tags: 'Opted In' },
        $push: {
          optInHistory: buildKeywordOptInHistoryEntry(),
        },
      },
      { new: true }
    );
    if (!updatedLead) {
      log.warn(`[DualBrain] Keyword opt-in could not find lead for ${phone}`);
      return true;
    }
    log.info(`✅ Opt-in detected for ${phone}. Resuming bot.`);

    await Conversation.findByIdAndUpdate(convo._id, {
      botPaused: false,
      isBotPaused: false,
      status: 'BOT_ACTIVE'
    });
    try {
      const SuppressionList = require('../../models/SuppressionList');
      await SuppressionList.deleteOne({ clientId: client.clientId, phone });
    } catch (_) {}

    // Broadcast update
    if (io) io.to(`client_${client.clientId}`).emit('lead_opted_in', { phone });

    await sendWhatsAppText(client, phone, "Welcome back! Automations have been resumed. How can I help you today?", 'whatsapp', { complianceExempt: true });
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
      const NotificationService = require('../core/notificationService');
      
      const DashboardLink = `https://dash.topedgeai.com/live-chat?phone=${encodeURIComponent(phone)}`;
      const cartInfo = parseInt(lead?.addToCartCount) > 0 ? `Total Carts: ${lead.addToCartCount}` : 'No carts yet';
      const orderInfo = lead?.isOrderPlaced ? `Orders: ${lead.ordersCount} | Spent: ${lead.totalSpent}` : 'No orders yet';

      await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          conversationId: convo._id,
          topic: "🚨 AGENT REQUEST — Attention Needed",
          triggerSource: `💬 "${userText}"\n👤 ${lead?.name || 'Unknown'}\n🛒 ${cartInfo}\n📦 ${orderInfo}\n🔗 ${DashboardLink}`,
          channel: 'both',
          customerQuery: userText,
      });
      if (io) {
          io.to(`client_${client.clientId}`).emit('attention_required', {
              phone,
              reason: "Lead requested human intervention — prioritize!",
              priority: 'high'
          });
      }
      // Optional: Pause bot or mark for takeover
      await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({ status: 'HUMAN_TAKEOVER' }));
      try {
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { pendingSupport: true } }
        );
        const { applyNeedHelpTag } = require('./needHelpTag');
        await applyNeedHelpTag(client.clientId, phone);
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
    // Rules like pause_bot set botPaused while status stays BOT_ACTIVE — users were stranded with no reply.
    const canResumeFromPausedBot =
      convo.botPaused &&
      resumeKeywords.test(t) &&
      convo.status !== "OPTED_OUT";
    if (canResumeFromHandoff || canResumeFromPausedBot) {
      log.info(`[DualBrain] Resuming bot for ${phone} (keyword: "${t}", handoff=${!!canResumeFromHandoff}, paused=${!!canResumeFromPausedBot})`);
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
      await sendWhatsAppText(client, phone, "You've been unsubscribed. You will no longer receive automated messages. Reply START anytime to re-subscribe.", 'whatsapp', { complianceExempt: true });
      try {
        const { recordNegativeOutcome } = require('../../services/training/trainingOutcomeTracker');
        await recordNegativeOutcome(client.clientId, phone);
      } catch (_) {}
      return true;
    }
    // Check human handoff interrupts
    if (_globalInterruptKeywords.humanHandoff.some(k => userTextLower.includes(k))) {
      log.info(`🙋 [GlobalInterrupt] Human request "${userTextLower}" detected mid-flow for ${phone}. Aborting flow.`);
      await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({
        status: 'HUMAN_TAKEOVER',
        botPaused: true,
        isBotPaused: true,
        botStatus: 'paused',
        lastStepId: null,
        waitingForVariable: null,
        captureResumeNodeId: null,
      }));
      try {
        const { applyNeedHelpTag } = require('./needHelpTag');
        await applyNeedHelpTag(client.clientId, phone);
      } catch (_) { /* non-fatal */ }
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
      try {
        const { recordNegativeOutcome } = require('../../services/training/trainingOutcomeTracker');
        await recordNegativeOutcome(client.clientId, phone);
      } catch (_) {}
      await sendWhatsAppText(client, phone, "I'm connecting you with a member of our team right now. Please hold! 👤");
      return true;
    }
  }

  // ── PRIORITY 0: CAPTURE MODE ─────────────────────────────────────────────
  // If bot is waiting for text input from this user, handle it NOW.
  if (convo.status === 'WAITING_FOR_INPUT' && convo.waitingForVariable) {
    const captureAnchor = convo.captureStartedAt || convo.lastInteraction || convo.updatedAt || convo.lastMessageAt || new Date();
    const hoursSinceCapture = (new Date() - new Date(captureAnchor)) / 3600000;
    
    // Safeguard 4: 24-hour TTL from capture start (not stale conversation.updatedAt)
    if (hoursSinceCapture > 24) {
      log.info(`⏰ Capture state expired (24h+). Clearing wait state for ${phone}.`);
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          status: 'BOT_ACTIVE',
          waitingForVariable: null,
          captureResumeNodeId: null,
          captureStartedAt: null,
          captureRetries: 0,
        }
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
          await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({
              status: 'HUMAN_SUPPORT',
              botPaused: true,
              isBotPaused: true,
              botStatus: 'paused',
              attentionReason: 'Validation failed — human support',
              waitingForVariable: null,
              captureResumeNodeId: null,
              captureRetries: 0,
            }));
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
          captureStartedAt:    null,
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
        const QRCode = require('../../models/QRCode');
        const QRScan = require('../../models/QRScan');
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
          await require('../../models/QRCode').findByIdAndUpdate(qr._id, {
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
            const { fireWebhookEvent } = require('../core/webhookDelivery');
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
          const MetaAd = require('../../models/MetaAd');
          const clientDoc = await Client.findOne({ clientId: client.clientId });
          const metaAd = await MetaAd.findOne({ clientId: clientDoc?._id, metaAdId: adId }).lean();

          if (metaAd) {
            // Send custom welcome message if set
            if (metaAd.customWelcomeMessage) {
              await sendWhatsAppText(client, phone, metaAd.customWelcomeMessage);
            }

            // Execute attached flow
            if (metaAd.attachedFlowId) {
              const adFlow =
                (await loadPublishedFlowByRef(client.clientId, metaAd.attachedFlowId)) ||
                (client.visualFlows || []).find((f) => f.id === metaAd.attachedFlowId);
              if (adFlow?.nodes?.length) {
                const adFlowNodes = flattenFlowNodes(adFlow.nodes);
                const adStartNode = findFlowStartNode(adFlowNodes, adFlow.edges || []);
                if (adStartNode) {
                  log.info(`🎯 Meta Ad flow: routing ${phone} to flow "${adFlow.name}" from ad "${metaAd.adName}"`);
                  await Conversation.findByIdAndUpdate(convo._id, {
                    activeFlowId: adFlow.id || metaAd.attachedFlowId,
                  });
                  const freshConvo = await Conversation.findById(convo._id);
                  return await executeNode(
                    adStartNode,
                    adFlowNodes,
                    adFlow.edges || [],
                    client,
                    freshConvo,
                    lead,
                    phone,
                    io,
                    channel
                  );
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
      const match = await perf.time('trigger engine: findMatchingFlow', () =>
        findMatchingFlow(parsedMessage, client, convo)
      );
      perf.checkpoint('trigger engine: flow matched', {
        flowId: match?.flowId,
        triggerType: match?.triggerType,
      });
      if (match && match.isLegacy && match.flow?.nodes?.length) {
        const flowNodes = flattenFlowNodes(match.flow.nodes);
        const flowEdges = match.flow.edges || [];
        const startNodeId = match.startNodeId || findFlowStartNode(flowNodes, flowEdges);
        if (startNodeId && flowNodes.length) {
          await Conversation.findByIdAndUpdate(convo._id, {
            activeFlowId: "legacy_main",
            lastMessageAt: new Date(),
          });
          const freshConvo = await Conversation.findById(convo._id);
          return await executeNode(
            startNodeId,
            flowNodes,
            flowEdges,
            client,
            freshConvo,
            lead,
            phone,
            io,
            channel
          );
        }
      }

      if (match && !match.isLegacy && match.flow) {
        const flowRef =
          match.flowId || match.flow.flowId || (match.flow._id != null ? String(match.flow._id) : match.flow.id);
        let loaded = flowRef ? await loadPublishedFlowByRef(client.clientId, flowRef) : null;
        if (!loaded?.nodes?.length && flowRef) {
          const { resolveFlowGraphByRef } = require('../flow/flowGraphResolver');
          loaded = await resolveFlowGraphByRef(client.clientId, flowRef);
        }
        const flowNodes = loaded?.nodes?.length
          ? loaded.nodes
          : flattenFlowNodes(
              (match.flow.publishedNodes?.length ? match.flow.publishedNodes : match.flow.nodes) || []
            );
        const flowEdges = loaded?.edges?.length
          ? loaded.edges
          : (match.flow.publishedEdges?.length ? match.flow.publishedEdges : match.flow.routingEdges) ||
            match.flow.edges ||
            [];
        const startNodeId = match.startNodeId || findFlowStartNode(flowNodes, flowEdges);

        log.info(
          `[TriggerEngine] Matched flow "${match.flow.name || flowRef}" via ${match.triggerType}. Starting at node: ${startNodeId}` +
            (match.triggerNodeId ? ` (trigger ${match.triggerNodeId})` : "")
        );

        if (startNodeId && flowNodes.length) {
          const resolvedActiveFlowId = flowRef || loaded?.id || null;
          await Conversation.findByIdAndUpdate(convo._id, {
            activeFlowId: resolvedActiveFlowId,
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
  if (graphHandled) {
    perf.checkpoint("graph_traversed");
    perf.finish();
    return true;
  }

  // STEP 6: PRIORITY 2 — Keyword Fallback
  const keywordHandled = await tryKeywordFallback(parsedMessage, client, convo, phone, channel);
  if (keywordHandled) return true;

  // STEP 6b: Dashboard NLP intents — low-confidence free text becomes a Training Inbox row with conversation thread.
  if (parsedMessage.text?.body && convo?._id) {
    const trimmedIntentProbe = String(parsedMessage.text.body || '').trim();
    if (trimmedIntentProbe.length > 2) {
      try {
        const NlpEngineService = require('../../services/NlpEngineService');
        await NlpEngineService.enqueueWhatsAppTrainingGapIfUnhandled(
          client.clientId,
          phone,
          trimmedIntentProbe,
          convo._id
        );
      } catch (gapErr) {
        log.warn('[DualBrain] Training Inbox NLP bridge failed:', { error: gapErr.message });
      }
    }
  }

  // STEP 7: PRIORITY 3 — Gemini AI Fallback
  if (parsedMessage.text?.body && tenantAiEnabled) {
    perf.checkpoint("before_ai_fallback");
    const aiOk = await runAIFallback(parsedMessage, client, phone, lead, channel, convo);
    analyzeConversationIntelligence(client, phone, convo);
    if (!aiOk) {
      await sendWhatsAppText(
        client,
        phone,
        "Thanks for your message! Type *menu* or *hi* anytime to see options again."
      );
    }
    return true;
  }

  if (parsedMessage.text?.body) {
    await sendWhatsAppText(
      client,
      phone,
      "Thanks for your message! Type *menu* or *hi* anytime to see options again."
    );
    perf.finish();
    return true;
  }

  perf.finish();
  setImmediate(() => analyzeConversationIntelligence(client, phone, convo));
    return false;
  };

  try {
    const result = await withTimeout(runEngineBody(), DUAL_BRAIN_BUDGET_MS, 'DualBrain');
    engineTimer.finish(result ? 'handled' : 'not_handled');
    return result;
  } catch (err) {
    if (String(err.message || '').includes('timed out')) {
      abortEngineRun(client.clientId, phone);
      log.error(`[DualBrain] Hard timeout (${DUAL_BRAIN_BUDGET_MS}ms) for ${phone} on ${client.clientId}`);
      engineTimer.finish('timeout');
      return true;
    }
    log.error(`[DualBrain] Critical Engine Error for ${phone}:`, err.message);
    engineTimer.finish(`error: ${err.message}`);
    return false;
  } finally {
      endEngineRun(client.clientId, phone);
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
      if (_lockElapsed > DUAL_BRAIN_BUDGET_MS) {
        log.warn(`[Lock] ⚠️ Engine took ${_lockElapsed}ms for ${phone} — exceeded ${DUAL_BRAIN_BUDGET_MS}ms budget (deploy timeouts + Shopify 12s cap if still slow).`);
      } else if (_lockElapsed > 15000) {
        log.warn(`[Lock] Engine took ${_lockElapsed}ms for ${phone} — investigate Shopify/Gemini nodes in flow.`);
      }
      log.info(`[DualBrain] Completed for ${phone} in ${Date.now() - _lockStartTime}ms`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY 1: GRAPH TRAVERSAL
// ─────────────────────────────────────────────────────────────────────────────
async function tryGraphTraversal(parsedMessage, client, convo, lead, phone, io, channel = 'whatsapp') {
  if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
    log.warn(`[Graph] Skipping traversal — engine run aborted (timeout)`);
    return false;
  }
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

  if (buttonId && /^(resend|resend_checkout)$/i.test(String(buttonId))) {
    try {
      const { resendCheckoutToCustomer } = require('./commerceCheckoutService');
      const result = await resendCheckoutToCustomer(client, phone, convo, lead);
      if (result.ok) {
        log.info(`[Graph] Resent checkout link to ${phone}`);
        return true;
      }
    } catch (resendErr) {
      log.warn(`[Graph] resend checkout failed: ${resendErr.message}`);
    }
  }

  if (buttonId && String(buttonId).startsWith("collection_")) {
    const selId = String(buttonId).replace(/^collection_/, "");
    const md = { ...(convo.metadata || {}), selectedCollectionId: selId, checkout_url: convo.metadata?.checkout_url };
    await Conversation.findByIdAndUpdate(convo._id, {
      $set: {
        metadata: md,
        lastBrowsedCollectionId: selId,
        lastBrowsedCollectionAt: new Date()
      }
    });
    convo.metadata = md;
  }

  if (buttonId && /^cat_/i.test(String(buttonId))) {
    const selId = String(buttonId).replace(/^cat_/i, "");
    const md = {
      ...(convo.metadata || {}),
      selectedCollectionId: selId,
      selected_collection_id: selId,
      last_interactive_list_id: String(buttonId),
    };
    await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: md } });
    convo.metadata = md;
  }

  if (buttonId && /^order_/i.test(String(buttonId))) {
    const oid = String(buttonId).replace(/^order_/i, "");
    const orders = Array.isArray(convo.metadata?.customer_orders) ? convo.metadata.customer_orders : [];
    const pick = orders.find((o) => String(o.id) === String(oid));
    const fs = String(pick?.fulfillment_status || "").toLowerCase();
    const shipped = /fulfilled|shipped|delivered|out_for_delivery|in_transit/.test(fs);
    const md = {
      ...(convo.metadata || {}),
      selected_order_id: oid,
      selected_order_name: pick?.name || buttonId,
      selected_order_status: fs,
      is_shipped: shipped ? "true" : "false",
    };
    await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: md } });
    convo.metadata = md;
  }

  if (buttonId && /^help_/i.test(String(buttonId))) {
    const helpLabels = {
      help_not_received: "Order not received",
      help_damaged: "Damaged / wrong item",
      help_return: "Return / exchange",
      help_install: "Installation help",
      help_other: "Other issue",
    };
    const md = {
      ...(convo.metadata || {}),
      help_issue_type: helpLabels[String(buttonId)] || String(buttonId),
    };
    await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: md } });
    convo.metadata = md;
  }

  if (buttonId && /^reason_/i.test(String(buttonId))) {
    const reasonMap = {
      reason_wrong: "Ordered by mistake",
      reason_price: "Found a better price",
      reason_delay: "Delivery too slow",
      reason_address: "Wrong address",
      reason_mind: "Changed my mind",
      reason_other: "Other reason",
    };
    const md = {
      ...(convo.metadata || {}),
      cancel_reason: reasonMap[String(buttonId)] || String(buttonId),
    };
    await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: md } });
    convo.metadata = md;
  }

  if (buttonId && /^mod_/i.test(String(buttonId))) {
    const modMap = {
      mod_address: "Delivery address",
      mod_phone: "Contact number",
      mod_variant: "Size / variant",
      mod_other: "Other modification",
    };
    const md = {
      ...(convo.metadata || {}),
      modify_type: modMap[String(buttonId)] || String(buttonId),
      modification_type: String(buttonId),
    };
    await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: md } });
    convo.metadata = md;
  }

  // Ecommerce webhook events should only be routed via the trigger engine, not graph traversal
  // Graph traversal requires an actual user interaction
  const isEcommerceEvent = !userText && !buttonId && 
    (parsedMessage?.type === 'order_placed' || parsedMessage?.type === 'abandoned_cart' || 
     parsedMessage?.type === 'order_fulfilled' || parsedMessage?.referral?.ctwa_clid === undefined);
  
  if (isEcommerceEvent && !currentStepId) {
    log.info(`[Graph] Skipping traversal for ecommerce event with no user text for ${phone}`);
    return false;
  }

  // A0) Flow canvas trigger nodes (track order, warranty, hi, menu, …)
  if (userTextLower && userTextLower.length > 0) {
    const { findKeywordTriggerEntry } = require('../flow/triggerEngine');
    const triggerEntry = findKeywordTriggerEntry(userText, flowNodes, flowEdges, channel);
    if (triggerEntry?.startNodeId) {
      log.info(
        `[Graph] Trigger keyword "${userText}" → ${triggerEntry.startNodeId} (from ${triggerEntry.triggerNodeId})`
      );
      return await executeNode(
        triggerEntry.startNodeId,
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
    if (!resolveClientGeminiKey(client)) {
      log.info("[Graph] Unwired button — no merchant Gemini key, skipping AI fallback");
      return false;
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

          if (intentNodes.length > 0) {
              log.info(`AI Intent: Checking ${intentNodes.length} intent triggers for "${userText}"`);
              for (const node of intentNodes.slice(0, 3)) {
                  const matched = await checkIntent(userText, node.data.intentDescription, client.clientId);
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
      
      // If none matched, check for explicit menu/start or stale-session greeting reset
      const allowGraphGreetingReset =
        userTextLower &&
        (isExplicitFlowResetText(userTextLower) ||
          (isGreeting(userTextLower) && shouldAllowGreetingKeywordTrigger(userText, convo)));
      if (allowGraphGreetingReset) {
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

  // Fallback: map typed text/number to interactive options (buttons + list rows)
  if (currentNode?.type === 'interactive') {
    const sourceEdgesForNode = flowEdges.filter((e) => e.source === currentStepId);
    const numericChoice = Number.parseInt(userText, 10);
    const isNumericChoice = Number.isInteger(numericChoice) && numericChoice > 0;
    const normalizeTitle = (v = '') =>
      String(v || '')
        .toLowerCase()
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const options = [];
    const btns = Array.isArray(currentNode.data?.buttonsList) ? currentNode.data.buttonsList : [];
    btns.forEach((b) => {
      options.push({
        id: normalizeHandleId(b?.id || b?.title || ''),
        title: String(b?.title || ''),
      });
    });

    const sections = Array.isArray(currentNode.data?.sections) ? currentNode.data.sections : [];
    sections.forEach((section) => {
      (Array.isArray(section?.rows) ? section.rows : []).forEach((row) => {
        options.push({
          id: normalizeHandleId(row?.id || row?.title || ''),
          title: String(row?.title || ''),
        });
      });
    });

    if (options.length) {
      let picked = null;
      if (isNumericChoice && numericChoice <= options.length) {
        picked = options[numericChoice - 1];
      } else {
        const normalizedInput = normalizeTitle(userTextLower);
        picked = options.find((opt) => {
          const optId = normalizeHandleId(opt.id || '').toLowerCase();
          const optTitle = normalizeTitle(opt.title);
          return normalizedInput === optTitle || normalizedInput === optId;
        });
      }

      if (picked) {
        const handleEdge = sourceEdgesForNode.find(
          (e) => normalizeHandleId(e.sourceHandle || '').toLowerCase() === normalizeHandleId(picked.id || '').toLowerCase()
        );
        if (handleEdge) {
          log.info(`[Graph] Matched typed interactive choice "${userText}" to handle "${picked.id}" on ${currentStepId}`);
          return await executeNode(handleEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
        }
      }
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
  if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
    log.warn(`[Exec] Skipping node ${nodeId} — engine run aborted (timeout)`);
    return false;
  }
  const execStartedAt = Date.now();
  const rawNode = flowNodes.find(n => n.id === nodeId);
  const nodeTimer = createTimer(`executeNode:${rawNode?.type || 'unknown'}`, `node=${nodeId}`);
  if (rawNode?.data?.isAiResponse) {
    nodeTimer.log('isAiResponse=true — may call Gemini');
  }
  if (!rawNode) {
    log.warn(`[Exec] Node ${nodeId} not found in ${flowNodes.length} nodes — recovering to hub`);
    const hubId =
      flowNodes.find((n) => n.id === "n_main_menu")?.id ||
      flowNodes.find(
        (n) =>
          n.type === "interactive" &&
          Array.isArray(n.data?.buttonsList) &&
          n.data.buttonsList.length > 0
      )?.id ||
      null;
    if (!hubId) {
      log.warn(`[Exec] No hub node available for recovery`);
      return false;
    }
    if (convo?._id) {
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: {
          lastStepId: hubId,
          captureResumeNodeId: null,
          waitingForVariable: null,
          status: "BOT_ACTIVE",
        },
      }).catch(() => {});
    }
    const freshConvo = convo?._id ? await Conversation.findById(convo._id) : convo;
    return executeNode(hubId, flowNodes, flowEdges, client, freshConvo || convo, lead, phone, io, channel, parsedMessage);
  }
  log.info(`[Exec] Node ${nodeId} type=${rawNode.type} label="${(rawNode.data?.label || '').substring(0, 30)}"`);

  // Phase 20: Inject variables into node data before sending
  // This resolves {{customer_name}}, {{order_id}}, etc. in all text fields
  let node = rawNode;
  try {
    let ctx = convo?._variableContext || await buildVariableContext(client, phone, convo, lead);
    if (rawNode.type === "message" && rawNode.data?.isAiResponse) {
      const staticFallback = String(
        rawNode.data?.text || rawNode.data?.message || rawNode.data?.body || ""
      ).trim();
      const userIssue = String(ctx.customer_issue || ctx.last_input || "").trim();
      const faqResolved = resolveQuickFaqReply(client, userIssue, client.ai?.persona);
      let reply = '';
      let ragBlocked = false;

      if (faqResolved.direct) {
        reply = faqResolved.reply;
      } else {
        const { retrieveKnowledge, getActiveKnowledgeHealth, notifyRagFailure, isRagUnavailableError } = require('../core/ragEngine');
        const health = await getActiveKnowledgeHealth(client.clientId);
        let ragContext = '';
        if (health.active > 0) {
          try {
            const ragChunks = await retrieveKnowledge(client.clientId, userIssue, 3);
            ragContext = ragChunks.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n');
          } catch (ragErr) {
            if (isRagUnavailableError(ragErr)) {
              await notifyRagFailure(client.clientId, ragErr.reason);
              ctx.ai_response = staticFallback || "Our knowledge base is temporarily unavailable. Please try again shortly.";
              ctx.ai_needs_human = "true";
              ragBlocked = true;
            } else {
              throw ragErr;
            }
          }
        }
        if (!ragBlocked) {
          const systemPrompt = buildPersonaSystemPrompt(
            client,
            ragContext ? `RETRIEVED KNOWLEDGE:\n${ragContext}` : (client.nicheData?.aiPromptContext || "")
          );
          const prompt =
            `Customer says: "${userIssue}"${buildQuickFaqDirective(faqResolved.faqMatch)}\n` +
            `Reply in under 280 characters for WhatsApp. Match your tone. Use FAQ and retrieved knowledge when they answer the question.\n` +
            `If you cannot answer from the context above, reply exactly: NEEDS_HUMAN`;
          try {
            const { callAI } = require('../core/aiGateway');
            const aiResult = await Promise.race([
              callAI({
                clientId: client.clientId,
                feature: 'whatsapp_bot',
                systemPrompt,
                prompt,
                maxTokens: 120,
                temperature: 0.35,
                fast: true,
              }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), AI_BOT_TIMEOUT_MS)),
            ]);
            reply = aiResult?.content || "";
          } catch (_) {
            reply = "";
          }
        }
      }

      if (!ragBlocked) {
        const clean = faqResolved.direct ? reply : applyPersonaPostProcess(String(reply || "").trim(), client.ai?.persona);
        const needs = !clean || clean.toUpperCase().includes("NEEDS_HUMAN");
        ctx.ai_response = needs ? staticFallback : clean.slice(0, 500);
        ctx.ai_needs_human = needs && !staticFallback ? "true" : "false";
        await Conversation.findByIdAndUpdate(convo._id, {
          $set: {
            "metadata.ai_response": ctx.ai_response,
            "metadata.ai_needs_human": ctx.ai_needs_human,
          },
        }).catch(() => {});
      } else {
        await Conversation.findByIdAndUpdate(convo._id, {
          $set: {
            "metadata.ai_response": ctx.ai_response,
            "metadata.ai_needs_human": ctx.ai_needs_human,
          },
        }).catch(() => {});
      }
    }
    node = injectNodeVariables(rawNode, ctx);
    if (node?.data) {
      const { sanitizeNodeMediaData } = require('../flow/sanitizeFlowMedia');
      node = { ...node, data: sanitizeNodeMediaData(node.data) };
    }
  } catch (varErr) {
    log.warn('Variable injection failed for node', { nodeId, error: varErr.message });
    node = rawNode; // fallback to raw node
  }

  if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
    return false;
  }

  // ✅ Phase R3: Atomic node visit counter — was replacing entire flowNodes[] array on every message
  // Old: const updatedNodes = incrementNodeVisit(...); await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes })
  // New: Targeted $inc on exactly one node — O(1) not O(N) writes
  // Targeted visit count tracking on WhatsAppFlow collection
  try {
    const WhatsAppFlow = require("../../models/WhatsAppFlow");
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


  // Apex: catalog nodes with apexDualMethod skip outbound when no Meta catalog id — branch on no_catalog edge (Method 2).
  if (node.type === 'catalog' && (node.data || {}).apexDualMethod && !getClientCatalogIdString(client)) {
    const noCat = flowEdges.find(
      (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === 'no_catalog'
    );
    if (noCat) {
      return await executeNode(
        noCat.target,
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

  let sent = true;
  try {
    const nodeTimeoutMs = node?.type === 'interactive' ? 8000 : 5000;
    sent = await withTimeout(
      sendNodeContent(node, client, phone, lead, convo, channel, parsedMessage),
      nodeTimeoutMs,
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
    if (!isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
      await sendWhatsAppText(
        client,
        phone,
        node.data?.text || node.data?.body || "Resuming our conversation... Choose an option below."
      );
    }
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

  if (!sent && node.type === 'catalog' && (node.data || {}).apexDualMethod) {
    const noCat = flowEdges.find(
      (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === 'no_catalog'
    );
    if (noCat) {
      return await executeNode(
        noCat.target,
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
      const FollowUpSequence = require('../../models/FollowUpSequence');
      const mappedSteps = steps.map((s, idx) => ({
        type: channel,
        content: s.text,
        delayValue: s.delay || 0,
        delayUnit: 'minutes',
        sendAt: new Date(Date.now() + (s.delay || 0) * 60000),
        status: "pending",
        order: idx
      }));

      const { ensureLeadForSequence } = require('../messaging/ensureLeadForSequence');
      const seqLead =
        lead?._id
          ? lead
          : await ensureLeadForSequence({
              clientId: client.clientId,
              phone,
              source: 'flow_sequence_node',
            });

      await FollowUpSequence.create({
        clientId: client.clientId,
        leadId: seqLead._id,
        phone: seqLead.phoneNumber || phone,
        email: seqLead.email,
        name: `Sequence from node ${node.id}`,
        steps: mappedSteps,
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

  // 3. Abandoned Cart Node
  if (node.type === 'abandoned_cart') {
    // Visual entry point for cart recovery. Usually triggered by shopify check.
    // If reached in flow (e.g. via direct link), we just proceed to recovery logic.
    const { handleNodeAction } = require('../flow/nodeActions');
    await handleNodeAction('CART_RECOVERY_START', node, client, phone, convo, lead);
  }

  // 5. COD to Prepaid Node
  if (node.type === 'cod_prepaid') {
    const { handleNodeAction } = require('../flow/nodeActions');
    await handleNodeAction('CONVERT_COD_TO_PREPAID', node, client, phone, convo, lead);
  }

  // --- ENTERPRISE & COMMERCE NODES (Phase 3) ---

  // 6. Payment Link Node
  if (node.type === 'payment_link') {
    const { handleNodeAction } = require('../flow/nodeActions');
    await handleNodeAction('GENERATE_PAYMENT', node, client, phone, convo, lead);
  }

  // 7. Order Action Node — with context validation for returns
  if (node.type === 'order_action') {
    const { handleNodeAction } = require('../flow/nodeActions');
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

    if (action === 'CHECK_ORDER_STATUS') {
      const fresh = await Conversation.findById(convo._id).select('metadata').lean();
      const found = String(fresh?.metadata?.last_order_lookup_found || '') === 'true';
      if (found) {
        const succEdge = flowEdges.find(
          (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === 'success'
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
      if (!found) {
        const noEdge = flowEdges.find(
          (e) =>
            e.source === nodeId &&
            ['no_order', 'not_found', 'error'].includes(normalizeHandleId(e.sourceHandle))
        );
        if (noEdge) {
          return await executeNode(
            noEdge.target,
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
    }
  }
  // 9. Warranty Check / Lookup — branches active | expired | none (see nodeActions WARRANTY_CHECK)
  if (node.type === 'warranty_check' || node.type === 'warranty_lookup') {
    const { handleNodeAction } = require('../flow/nodeActions');
    const Conversation = require('../../models/Conversation');
    await handleNodeAction('WARRANTY_CHECK', node, client, phone, convo, lead);

    const fresh = await Conversation.findById(convo._id).select('metadata').lean();
    const meta = fresh?.metadata || convo.metadata || {};
    let targetHandle = 'none';
    if (meta._warranty_branch === 'active') targetHandle = 'active';
    else if (meta._warranty_branch === 'expired') targetHandle = 'expired';

    if (!meta._warranty_branch) {
      const cleanPhone = require('../core/helpers').normalizePhone(phone);
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
       const { normalizeLeadTagForAdd, applyNeedHelpTag, NEED_HELP_TAG } = require('./needHelpTag');
       const normalized = normalizeLeadTagForAdd(tag) || tag;
       if (action === 'remove') {
         const pullTags = normalized === NEED_HELP_TAG
           ? [NEED_HELP_TAG, 'Human', 'human', 'pending-human']
           : [tag, normalized];
         await AdLead.findByIdAndUpdate(lead._id, { $pull: { tags: { $in: pullTags } } });
       } else if (normalized === NEED_HELP_TAG) {
         await applyNeedHelpTag(client.clientId, phone);
       } else {
         await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: normalized } });
       }
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
    await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({
      attentionReason: alertMsg,
      lastInteraction: new Date(),
    }));

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
      const NotificationService = require('../core/notificationService');
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
    const { normalizePhone } = require('../core/helpers');
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
      const WhatsAppFlow = require('../../models/WhatsAppFlow');
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
    const { getShopifyClient, withShopifyRetry } = require('../shopify/shopifyHelper');
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
      
      // --- USP 2: ORDER TRACKING (Shopify + local Order — shared resolver) ---
      else if (action === 'ORDER_STATUS' || action === 'get_order' || action === 'CHECK_ORDER_STATUS') {
        const { resolveLatestOrderContext, resolveOrderContextByIdentifier } = require('./orderLookupService');
        const silentLookup = !!node.data?.silent;
        const variable = node.data?.variable;
        const qVar = node.data?.queryVariable;
        const identifier = qVar ? String(convo?.metadata?.[qVar] || "").trim() : "";
        let r;
        try {
          if (identifier) {
            r = await resolveOrderContextByIdentifier({ client, phone, identifier });
          } else {
            r = await resolveLatestOrderContext({ client, phone });
          }
        } catch (lookupErr) {
          log.error(`[shopify_call] CHECK_ORDER_STATUS resolver threw: ${lookupErr.message}`);
          const prevMeta = { ...(convo.metadata || {}) };
          if (variable) {
            prevMeta[variable] = null;
            prevMeta[`${variable}_error`] = lookupErr.message || "lookup_failed";
          }
          await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: prevMeta } });
          convo.metadata = prevMeta;
          r = { found: false, mergedMeta: prevMeta, userMessage: null };
        }
        const mergedMeta = { ...(convo.metadata || {}), ...(r.mergedMeta || {}) };
        await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: mergedMeta } });
        convo.metadata = mergedMeta;

        if (!r.found) {
          if (!silentLookup && r.userMessage) {
            await sendWhatsAppText(client, phone, r.userMessage);
          }
          const noOrderEdge = flowEdges.find(
            (e) =>
              e.source === nodeId &&
              (normalizeHandleId(e.sourceHandle) === "not_found" ||
                normalizeHandleId(e.sourceHandle) === "no_order" ||
                normalizeHandleId(e.sourceHandle) === "error")
          );
          if (noOrderEdge) {
            return await executeNode(
              noOrderEdge.target,
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
          resultData = { error: "No order found for this number" };
        } else {
          if (!silentLookup && r.userMessage) {
            await sendWhatsAppText(client, phone, r.userMessage);
          }
          resultData = r.orderData;
        }
      }

      else if (action === "GET_CUSTOMER_ORDERS") {
        const qVar = node.data?.queryVariable || "cancel_identifier";
        const identifier = String(convo?.metadata?.[qVar] || "").trim();
        const { withShopifyRetry } = require('../shopify/shopifyHelper');
        let ordersPayload = [];
        const profileName =
          (lead?.name || convo?.customerName || convo?.metadata?.customer_name || "").trim();
        const profileFirst = profileName.split(/\s+/)[0] || "";
        let mergedExtra = {
          customer_orders: [],
          customer_name: profileFirst || "there",
          order_list_text: "",
        };
        try {
          const { withTimeout: opTimeout } = require('../core/asyncTimeout');
          await opTimeout(
            withShopifyRetry(client.clientId, async (shopify) => {
            const digits = identifier.replace(/\D/g, "");
            let orders = [];
            if (digits.length >= 10) {
              const res = await shopify.get(
                `/orders.json?status=any&limit=5&phone=${encodeURIComponent(digits)}`
              );
              orders = res.data.orders || [];
            } else if (identifier) {
              const res = await shopify.get(
                `/orders.json?status=any&limit=5&name=${encodeURIComponent(identifier.replace(/^#/, ""))}`
              );
              orders = res.data.orders || [];
            }
            ordersPayload = (orders || []).slice(0, 5).map((o) => ({
              id: o.id,
              name: o.name || `#${o.order_number}`,
              order_number: o.order_number,
              total_price: o.total_price,
              currency: o.currency,
              fulfillment_status: o.fulfillment_status,
              financial_status: o.financial_status,
              line_items: o.line_items || [],
              created_at: o.created_at,
            }));
            mergedExtra.customer_orders = ordersPayload;
            const shopifyFirst = (orders[0]?.customer?.first_name || "").trim();
            mergedExtra.shopify_customer_first_name = shopifyFirst;
            if (!profileFirst && shopifyFirst) {
              mergedExtra.customer_name = shopifyFirst;
            }
            mergedExtra.order_list_text = ordersPayload
              .map((o, i) => `${i + 1}. ${o.name} — ${o.currency} ${o.total_price}`)
              .join("\n");
          }),
            6000,
            "GET_CUSTOMER_ORDERS"
          );
        } catch (ge) {
          log.warn(`[shopify_call] GET_CUSTOMER_ORDERS: ${ge.message}`);
        }
        const prevMeta = { ...(convo.metadata || {}), ...mergedExtra };
        if (variable) {
          prevMeta[variable] = ordersPayload;
        }
        await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: prevMeta } });
        convo.metadata = prevMeta;
        resultData = { orders: ordersPayload };
      }

      else if (action === 'CANCEL_ORDER') {
        const { handleNodeAction } = require('../flow/nodeActions');
        await handleNodeAction('CANCEL_ORDER', node, client, phone, convo, lead);
        resultData = { status: 'cancel_requested' };
      }

      else if (action === 'ORDER_REFUND_STATUS') {
        const { handleNodeAction } = require('../flow/nodeActions');
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
        const { createCODPaymentLink } = require('./razorpay');
        const Order = require("../../models/Order");
        const latestOrder = await Order.findOne({ customerPhone: phone, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        
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
      const silentLookup = !!(node?.data && node.data.silent);
      const isOrderLookup =
        action === "ORDER_STATUS" || action === "get_order" || action === "CHECK_ORDER_STATUS";
      if (!(silentLookup && isOrderLookup)) {
        await sendWhatsAppText(
          client,
          phone,
          "I'm having a bit of trouble connecting to the store right now. Please try again in a minute! 🔄"
        );
      }
      if (isOrderLookup && node?.data?.variable) {
        const v = String(node.data.variable).trim();
        const cleared = { ...(convo.metadata || {}), [v]: null, [`${v}_error`]: err.message || "lookup_failed" };
        await Conversation.findByIdAndUpdate(convo._id, { $set: { metadata: cleared } });
        convo.metadata = cleared;
      }
      const errEdge = flowEdges.find(
        (e) => e.source === nodeId && normalizeHandleId(e.sourceHandle) === "error"
      );
      if (errEdge) {
        return await executeNode(
          errEdge.target,
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
      if (isOrderLookup) {
        const noOrderEdge = flowEdges.find(
          (e) =>
            e.source === nodeId &&
            (normalizeHandleId(e.sourceHandle) === "no_order" ||
              normalizeHandleId(e.sourceHandle) === "not_found")
        );
        if (noOrderEdge) {
          return await executeNode(
            noOrderEdge.target,
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
    await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({
      status: 'HUMAN_SUPPORT',
      botPaused: true,
      isBotPaused: true,
      botStatus: 'paused',
      attentionReason: '🙋 Human support requested via flow',
      lastInteraction: new Date(),
    }));
    try {
      const { applyNeedHelpTag } = require('./needHelpTag');
      await applyNeedHelpTag(client.clientId, phone);
    } catch (_) { /* non-fatal */ }
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
        captureStartedAt: new Date(),
        captureRetries: 0,
        lastStepId: nodeId
      });
    }
  } else if (node.type !== 'logic' && node.type !== 'restart' && node.type !== 'livechat') {
    const nodeData = node.data || {};
    const waitsForUserChoice =
      node.type === 'interactive' ||
      node.type === 'InteractiveNode' ||
      (Array.isArray(nodeData.buttonsList) && nodeData.buttonsList.length > 0) ||
      (Array.isArray(nodeData.sections) &&
        nodeData.sections.some((s) => (s.rows || []).length > 0)) ||
      nodeData.dynamicSections === true;
    const autoEdge = waitsForUserChoice
      ? null
      : flowEdges.find(
          (e) =>
            e.source === nodeId &&
            (!e.trigger || e.trigger?.type === 'auto') &&
            (!e.sourceHandle ||
              e.sourceHandle === 'a' ||
              e.sourceHandle === 'bottom' ||
              e.sourceHandle === 'output')
        );
    if (autoEdge && !isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
      const chainSync =
        node.type === 'shopify_call' ||
        node.type === 'ShopifyNode' ||
        node.type === 'set_variable' ||
        node.type === 'SetVariableNode';
      if (chainSync) {
        const freshConvo = await Conversation.findById(convo._id);
        if (freshConvo && !isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) {
          return await executeNode(
            autoEdge.target,
            flowNodes,
            flowEdges,
            client,
            freshConvo,
            lead,
            phone,
            io,
            channel,
            parsedMessage
          );
        }
      } else {
        const autoRunId = getEngineRunId(client.clientId, phone);
        setTimeout(async () => {
          if (isEngineRunAborted(client.clientId, phone, autoRunId)) return;
          const freshConvo = await Conversation.findById(convo._id);
          if (!freshConvo || isEngineRunAborted(client.clientId, phone, autoRunId)) return;
          await executeNode(
            autoEdge.target,
            flowNodes,
            flowEdges,
            client,
            freshConvo,
            lead,
            phone,
            io,
            channel,
            parsedMessage
          );
        }, 400);
      }
    }
  }

  nodeTimer.checkpoint('node_exec_complete', {
    type: node?.type,
    latencyMs: Date.now() - execStartedAt,
  });
  nodeTimer.finish('success');
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
  if (node.data?.action && !['shopify_call', 'http_request', 'logic', 'delay', 'trigger', 'cod_prepaid', 'warranty_check', 'warranty_lookup', 'order_action', 'segment', 'ab_test', 'abandoned_cart', 'review', 'tag_lead', 'TagNode', 'livechat'].includes(type)) {
    const { handleNodeAction } = require('../flow/nodeActions');
    handleNodeAction(node.data.action, node, client, phone, convo, lead).catch((err) => {
      log.error(`Action Error (${node.data.action}):`, { error: err.message });
    });
  }

  switch (type) {
    case 'image': {
      const imageUrl = String(data.imageUrl || '').trim();
      const caption = data.caption || '';
      const captionTrim = String(caption).trim();
      const imgOk = imageUrl && /^https?:\/\//i.test(imageUrl);
      if (!imgOk) {
        if (captionTrim) {
          await WhatsApp.sendText(client, phone, captionTrim.substring(0, 4096));
        }
        return true;
      }
      await WhatsApp.sendImage(client, phone, imageUrl, caption);
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
      if (data.isAiResponse && String(convo?.metadata?.ai_needs_human || "") === "true") {
        return true;
      }
      if (data.sendWarrantyPdf) {
        try {
          const { handleNodeAction } = require('../flow/nodeActions');
          await handleNodeAction("SEND_WARRANTY_PDF", node, client, phone, convo, lead);
        } catch (wpErr) {
          log.warn(`[sendNodeContent] warranty PDF: ${wpErr.message}`);
        }
        return true;
      }
      let body = data.handoffMessage || data.text || data.body || (type === 'livechat' ? '👋 Connecting you to our team…\nA support agent will be with you shortly.' : '');
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
        const ctaHdr = buildInteractiveHeaderFromNodeData(data);
        if (ctaHdr) interactive.header = ctaHdr;
        const sent = await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
        return sent !== false;
      }

      const buttonsList = Array.isArray(data.buttonsList) && data.buttonsList.length > 0
        ? data.buttonsList
        : (data.buttons || '').split(',').map(b => b.trim()).filter(Boolean).map(b => ({ id: b.toLowerCase().replace(/\s+/g, '_'), title: b }));

      // Fix: Don't fall back to text if we have sections (List mode)
      if (!buttonsList.length && (!data.sections || data.sections.length === 0)) {
        const sent = await WhatsApp.sendText(client, phone, String(body).substring(0, 4096));
        return sent !== false;
      }

      if (data.interactiveType === 'list' || (data.sections && data.sections.length > 0)) {
        let sections;
        let totalRows = 0;
        let sourceSections = Array.isArray(data.sections) ? data.sections : [];
        if (data.dynamicSections && data.dynamicSectionsVariable && convo) {
          try {
            const dynKey = data.dynamicSectionsVariable;
            let customerOrders =
              convo.metadata?.[dynKey] ||
              convo.metadata?.customer_orders ||
              [];
            if (typeof customerOrders === "string") {
              try {
                customerOrders = JSON.parse(customerOrders);
              } catch (_) {
                customerOrders = [];
              }
            }
            if (!Array.isArray(customerOrders)) customerOrders = [];
            const dynRows = customerOrders.slice(0, 10).map((order) => {
              const title = String(order.name || order.order_number || `#${order.id}`).substring(0, 24);
              const li0 = order.line_items?.[0];
              const desc = li0
                ? `${String(li0.title || "").substring(0, 36)} — ${order.currency || "₹"}${order.total_price}`
                : `${order.currency || "₹"}${order.total_price}`;
              return {
                id: `order_${order.id}`,
                title,
                description: String(desc).substring(0, 72),
              };
            });
            if (dynRows.length) {
              sourceSections = [{ title: data.dynamicSectionTitle || "Your orders", rows: dynRows }];
            }
          } catch (de) {
            log.warn(`[interactive] dynamicSections failed: ${de.message}`);
          }
        }
        if (sourceSections && sourceSections.length > 0) {
          sections = sourceSections.map(section => {
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
        } else if (buttonsList.length > 0) {
          sections = [{
            title: 'Options',
            rows: buttonsList.slice(0, 10).map(btn => ({
              id: String(btn.id || btn.title || 'opt').substring(0, 200),
              title: (btn.title || 'Option').substring(0, 24)
            }))
          }];
        } else {
          sections = [];
        }

        const rowCount = (sections || []).reduce((n, s) => n + (s.rows?.length || 0), 0);
        if (!sections?.length || rowCount === 0) {
          const noOrdersText =
            convo.metadata?.order_list_text ||
            "We couldn't find any recent orders for that number. Please double-check your order ID or phone number and try again.";
          await sendWhatsAppText(client, phone, String(noOrdersText).substring(0, 4096));
          return true;
        }

        let interactive = {
          type: 'list',
          action: {
            button: String(
              data.menuButtonLabel || data.buttonText || 'View options'
            ).trim().substring(0, 20) || 'View options',
            sections
          }
        };
        const listHdr = buildInteractiveHeaderFromNodeData(data);
        if (listHdr) interactive.header = listHdr;
        const sent = await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
        return sent !== false;
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
      const btnHdr = buildInteractiveHeaderFromNodeData(data);
      if (btnHdr) interactive.header = btnHdr;
      const sent = await WhatsApp.sendInteractive(client, phone, interactive, String(body).substring(0, 1024));
      return sent !== false;
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
        await emailService.sendEmail(client, {
          to: recipient,
          subject,
          html: emailBody.replace(/\n/g, '<br/>'),
          intent: 'marketing',
          contactId: lead?._id?.toString?.() || lead?.id || null,
        });
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
      const ShopifyProduct = require("../../models/ShopifyProduct");
      const catalogId = getClientCatalogIdString(client);
      const bodyText = String(data.body || data.text || "Check out our collection!").substring(0, 1024);
      const ct = data.catalogType || "full";

      if (!catalogId) {
        if (data.apexDualMethod) {
          log.info(`[catalog] apexDualMethod + no catalog id — skipping hint (flow uses no_catalog edge)`);
          return true;
        }
        const storeHint = client.shopDomain ? `https://${String(client.shopDomain).replace(/^https?:\/\//, "")}` : "our store";
        await WhatsApp.sendText(
          client,
          phone,
          `Browse our store: ${storeHint}\n\nTo enable in-chat catalog cards: go to Settings -> Commerce, paste your Meta Catalog ID, then click "Import from Shopify" in WA Catalog.`
        );
        return true;
      }

      if (ct === "single" || ct === "single_product") {
        const pid = data.productRetailerId || data.productId;
        if (!pid) {
          await WhatsApp.sendText(client, phone, bodyText);
          return true;
        }
        await WhatsApp.sendSingleProduct(client, phone, {
          body: bodyText,
          catalogId,
          productRetailerId: pid
        });
        return true;
      }

      // mpm_template: tenant-agnostic — all inputs come from node.data (flow JSON / Flow Builder).
      // Any client may use multi | full | collection | mpm_template side by side; no client id branching here.
      if (ct === "mpm_template") {
        let mpmData = { ...data };
        let templateName = mpmData.metaTemplateName || mpmData.templateName || mpmData.mpmTemplateName;
        let ids = String(mpmData.productIds || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .filter((id) => !/^SHOPIFY_/i.test(id));
        let thumb = String(mpmData.thumbnailProductRetailerId || ids[0] || "").trim();

        if (!templateName || !thumb || !ids.length) {
          try {
            const { enrichMpmNodeDataFromDb } = require('../flow/flowMpmPatch');
            const enriched = await enrichMpmNodeDataFromDb(client.clientId, { id: node?.id, data: mpmData });
            if (enriched) {
              mpmData = enriched;
              templateName = mpmData.metaTemplateName || mpmData.templateName || mpmData.mpmTemplateName;
              ids = String(mpmData.productIds || "")
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean)
                .filter((id) => !/^SHOPIFY_/i.test(id));
              thumb = String(mpmData.thumbnailProductRetailerId || ids[0] || "").trim();
              log.info(`[catalog] MPM node ${node?.id} enriched from DB (${ids.length} products)`);
            }
          } catch (enrichErr) {
            log.warn(`[catalog] MPM enrich failed: ${enrichErr.message}`);
          }
        }

        if (!templateName || !thumb || !ids.length) {
          if (catalogId && ids.length) {
            log.warn(
              `[catalog] mpm_template missing approved template — falling back to product_list for node ${node?.id || ""}`
            );
            try {
              await WhatsApp.sendProductList(client, phone, {
                header: (mpmData.header || "Catalog").substring(0, 60),
                body: bodyText,
                footer: (mpmData.footer || "Tap to view items").substring(0, 60),
                catalogId,
                sections: [
                  {
                    title: String(mpmData.sectionTitle || "Our Picks").substring(0, 24),
                    product_items: ids.map((id) => ({ product_retailer_id: id })),
                  },
                ],
              });
              return true;
            } catch (plErr) {
              log.warn(`[catalog] product_list fallback failed: ${plErr.message}`);
            }
          }
          log.warn(`[catalog] mpm_template missing templateName, thumbnail, or productIds — node ${node?.id || ""}`);
          if (data.apexDualMethod) return false;
          await WhatsApp.sendText(client, phone, bodyText.substring(0, 4096));
          return true;
        }

        let bodyVariables = undefined;
        if (Array.isArray(data.mpmBodyVariables)) {
          bodyVariables = data.mpmBodyVariables.map((x) => String(x));
        } else if (typeof data.mpmBodyVariables === "string" && data.mpmBodyVariables.trim()) {
          bodyVariables = data.mpmBodyVariables.split(",").map((s) => s.trim());
        }

        const mpmHeaderText =
          data.mpmHeaderText != null && String(data.mpmHeaderText).trim() !== ""
            ? String(data.mpmHeaderText).trim()
            : String(ids.length);

        try {
          const { sendMpmInBatches } = require('../meta/mpmBatchSend');
          await sendMpmInBatches(WhatsApp, client, phone, {
            templateName,
            languageCode: mpmData.languageCode || "en",
            bodyVariables,
            headerImage: mpmData.headerImageUrl || mpmData.mpmHeaderImage || null,
            thumbnailProductRetailerId: thumb,
            productIds: ids,
            sectionTitle: mpmData.sectionTitle || mpmData.header,
            mpmButtonIndex: mpmData.mpmButtonIndex,
            delayMs: ids.length > 10 ? 900 : 0,
          });
        } catch (mpmErr) {
          log.error(`[catalog] sendMpmMarketingTemplate failed: ${mpmErr.message}`);
          if (catalogId && ids.length) {
            try {
              await WhatsApp.sendProductList(client, phone, {
                header: (mpmData.header || "Catalog").substring(0, 60),
                body: bodyText,
                footer: (mpmData.footer || "Tap to view items").substring(0, 60),
                catalogId,
                sections: [
                  {
                    title: String(mpmData.sectionTitle || "Our Picks").substring(0, 24),
                    product_items: ids.map((id) => ({ product_retailer_id: id })),
                  },
                ],
              });
              return true;
            } catch (plErr) {
              log.warn(`[catalog] product_list fallback failed: ${plErr.message}`);
            }
          }
          if (data.apexDualMethod) return false;
          await sendWhatsAppText(client, phone, bodyText.substring(0, 4096));
        }
        return true;
      }

      if (ct === "multi" || ct === "multi_legacy") {
        const ids = String(data.productIds || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        const sections = [
          {
            title: String(data.sectionTitle || "Our Picks").substring(0, 24),
            product_items: ids.map((id) => ({ product_retailer_id: id }))
          }
        ];
        try {
          await WhatsApp.sendProductList(client, phone, {
            header: (data.header || "Catalog").substring(0, 60),
            body: bodyText,
            footer: data.footer,
            catalogId,
            sections
          });
        } catch (plErr) {
          log.error(`[catalog] sendProductList failed: ${plErr.message}`);
          if (data.apexDualMethod) return false;
          await sendWhatsAppText(client, phone, bodyText.substring(0, 4096));
        }
        return true;
      }

      if (ct === "collection") {
        let collId = data.collectionId;
        if (data.useSelectedCollection && convo?.metadata?.selectedCollectionId) {
          collId = convo.metadata.selectedCollectionId;
        }
        const maxItems = Math.min(30, Math.max(1, Number(data.maxItems || data.limit || 20) || 20));
        const q = { clientId: client.clientId, collectionIds: String(collId), inStock: true };
        let products = await ShopifyProduct.find(q).limit(maxItems).lean();
        if (!products.length && collId) {
          products = await ShopifyProduct.find({ clientId: client.clientId, inStock: true }).limit(maxItems).lean();
        }
        if (!products.length) {
          await WhatsApp.sendText(
            client,
            phone,
            "This collection is currently empty. Please sync products from the dashboard."
          );
          return true;
        }
        await WhatsApp.sendProductList(client, phone, {
          header: String(data.header || "Our Collection").substring(0, 60),
          body: bodyText,
          footer: data.footer,
          catalogId,
          sections: [
            {
              title: String(data.sectionTitle || "Products").substring(0, 24),
              product_items: products.map((p) => ({ product_retailer_id: String(p.shopifyVariantId) }))
            }
          ]
        });
        return true;
      }

      if (ct === "multi_collection") {
        const configs = Array.isArray(data.collections) ? data.collections : [];
        const sections = [];
        let budget = 30;
        for (const c of configs.slice(0, 10)) {
          if (budget <= 0) break;
          const per = Math.max(1, Math.floor(budget / Math.max(1, configs.length)));
          const take = Math.min(per, budget);
          const prods = await ShopifyProduct.find({
            clientId: client.clientId,
            collectionIds: String(c.collectionId || c.id),
            inStock: true
          })
            .limit(take)
            .lean();
          if (prods.length) {
            sections.push({
              title: String(c.title || "Products").substring(0, 24),
              product_items: prods.map((p) => ({ product_retailer_id: String(p.shopifyVariantId) }))
            });
            budget -= prods.length;
          }
        }
        if (!sections.length) {
          await WhatsApp.sendCatalog(client, phone, bodyText, (data.footer || "").substring(0, 60), null);
          return true;
        }
        await WhatsApp.sendProductList(client, phone, {
          header: String(data.header || "Our Products").substring(0, 60),
          body: bodyText,
          footer: data.footer,
          catalogId,
          sections
        });
        return true;
      }

      const thumb = data.thumbnailProductId || data.productId || null;
      await WhatsApp.sendCatalog(client, phone, bodyText, (data.footer || "").substring(0, 60), thumb);
      return true;
    }

    case "cart_handler": {
      let tpl =
        data.checkoutMessage ||
        client.commerceBotSettings?.checkoutMessage ||
        "Complete your checkout 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}";
      let total = convo?.lastCheckoutValue ?? 0;
      let link = convo?.lastCheckoutUrl || convo?.metadata?.checkout_url || "";
      const currency = convo?.pendingCart?.items?.[0]?.currency || "INR";
      if (!link && convo?.pendingCart?.items?.length) {
        try {
          const { generateCheckoutForOrder } = require('./commerceCheckoutService');
          const bundle = await generateCheckoutForOrder(client, phone, convo.pendingCart.items);
          link = bundle.shortUrl || bundle.fullUrl || "";
          total = Number(bundle.totalValue) || total;
          if (convo?._id && link) {
            await Conversation.findByIdAndUpdate(convo._id, {
              $set: {
                lastCheckoutUrl: link,
                lastCheckoutShortCode: bundle.shortCode,
                lastCheckoutValue: total,
                "metadata.checkout_url": link,
              },
            });
          }
        } catch (cartErr) {
          log.warn(`[cart_handler] checkout regenerate failed: ${cartErr.message}`);
        }
      }
      tpl = injectVariables(String(tpl), {
        checkout_url: link,
        cart_total: Number(total).toLocaleString("en-IN"),
        currency,
        item_count: String(convo?.pendingCart?.items?.length || 0),
        first_name: (lead?.name || "there").split(/\s+/)[0]
      });
      await WhatsApp.sendText(client, phone, tpl.substring(0, 4096));
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

/** Keyword action `track_order` — uses same resolver as flows + order_action. */
async function handleUniversalOrderTracking(client, phone, convo) {
  const { resolveLatestOrderContext } = require('./orderLookupService');
  try {
    const r = await resolveLatestOrderContext({ client, phone });
    const prev = convo?.metadata || {};
    if (convo?._id && r.mergedMeta) {
      await Conversation.findByIdAndUpdate(convo._id, {
        $set: { metadata: { ...prev, ...r.mergedMeta } },
      });
    }
    if (r.userMessage) await sendWhatsAppText(client, phone, r.userMessage);
  } catch (err) {
    log.error("[track_order] lookup failed", { message: err.message });
    await sendWhatsAppText(
      client,
      phone,
      "We could not look up your order right now. Please share your *order ID* or try again in a few minutes."
    );
  }
}

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
      case 'track_order': await handleUniversalOrderTracking(client, phone, convo); return true;
      case 'initiate_return': {
        const { handleNodeAction } = require('../flow/nodeActions');
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
        const { resolveApiKeyForClient } = require('../services/ai/aiWalletService');
        const aiWallet = await resolveApiKeyForClient(client.clientId);
        if (!aiWallet.configured) {
          log.warn(`[NativeOrder] Skipping order NLP — no merchant Gemini key for ${client.clientId}`);
        } else {
        const parsed = await extractOrderDetails(text, products, client.clientId);

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
    }

    const { resolveApiKeyForClient } = require('../services/ai/aiWalletService');
    const aiResolved = await resolveApiKeyForClient(client.clientId);
    if (!aiResolved.configured) {
      log.warn(`[AI Fallback] No configured BYO AI key for ${client.clientId} — skipping AI.`);
      return false;
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
      const { deriveDiscountStatus } = require('./discountCodes');
      const latestActive = [...client.generatedDiscounts]
        .reverse()
        .find((d) => d?.code && deriveDiscountStatus(d) === 'active');
      if (latestActive?.code) discountCode = latestActive.code;
    }

    const isHesitating = /price|expensive|cost|discount|offer|deal|cheap|money/i.test(text);
    const bargainingInstruction = isHesitating 
        ? `The customer seems hesitant about price. You are authorized to offer a one-time discount code: "${discountCode}". Use it to close the deal!`
        : `If the customer asks for a deal, you can mention code "${discountCode}".`;

    const detectedLang = parsedMessage._detectedLanguage || convo?.detectedLanguage || 'en';
    const langInstruction = getLanguageInstructions(detectedLang);
    
    const productCatalog = buildRelevantProductSnippet(client.nicheData?.products || [], text, 8);
    const policyStore = String(client.nicheData?.policies || "Standard 7-day return policy applies unless specified.").slice(0, 600);

    const faqResolved = resolveQuickFaqReply(client, text, client.ai?.persona);
    let reply;

    if (faqResolved.direct) {
      reply = faqResolved.reply;
    } else {
    const { retrieveKnowledge, getActiveKnowledgeHealth, notifyRagFailure, isRagUnavailableError } = require('../core/ragEngine');
    const health = await getActiveKnowledgeHealth(client.clientId);
    let ragContext = '';
    if (health.active > 0) {
      try {
        const ragChunks = await retrieveKnowledge(client.clientId, text, 3);
        ragContext = ragChunks
          .map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`)
          .join('\n');
      } catch (ragErr) {
        if (isRagUnavailableError(ragErr)) {
          await notifyRagFailure(client.clientId, ragErr.reason);
          await sendWhatsAppText(
            client,
            phone,
            "I'm unable to access our knowledge base right now. Our team will follow up with you shortly."
          );
          return true;
        }
        throw ragErr;
      }
    }

    const faqMatch = faqResolved.faqMatch;

    const systemPrompt = buildPersonaSystemPrompt(client, client.nicheData?.aiPromptContext);

    const examples = await getRelevantExamples(client.clientId, text, 3);
    let fewShot = buildFewShotPrompt(examples);
    try {
      const { detectProductIntent, lookupProduct } = require('./liveProductLookup');
      const intent = detectProductIntent(text);
      if (intent) {
        let storeKey = '';
        try {
          const Order = require('../../models/Order');
          const lastOrder = await Order.findOne({ clientId: client.clientId, customerPhone: phone })
            .sort({ createdAt: -1 })
            .select('storeKey')
            .lean();
          storeKey = lastOrder?.storeKey || '';
        } catch (_) {}
        const lookup = await lookupProduct(client.clientId, intent.productHint, { storeKey });
        if (lookup.found) {
          const storeLabel = lookup.storeLabel ? ` at ${lookup.storeLabel}` : '';
          fewShot += `\n\nLIVE PRODUCT DATA${storeLabel}: ${lookup.live.title} price=${lookup.live.price} inStock=${lookup.live.inStock} freshness=${lookup.live.freshness}`;
          if (intent.type === 'inventory_check' && lookup.live.inStock === false) {
            const sku = lookup.product?.sku || lookup.product?.id || lookup.live.sku;
            await Conversation.findOneAndUpdate(
              { phone, clientId: client.clientId },
              {
                $set: {
                  'metadata.pendingProductWatch': {
                    sku: String(sku),
                    productName: lookup.live.title || lookup.product?.title,
                    productUrl: lookup.product?.url || '',
                    variantId: lookup.product?.variantId,
                    productId: lookup.product?.id,
                  },
                },
              }
            );
            fewShot +=
              '\n\nThis product is OUT OF STOCK. Offer to notify when back in stock and ask the customer to reply YES.';
          }
        }
      }
    } catch (_) {}
    
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
`.trim();

    const prompt = `${personalization}

KNOWLEDGE BASE:
${ragContext ? `[Retrieved knowledge]\n${ragContext}\n\n` : ''}[Products]
${productCatalog || "General inquiry handling."}

[Policies]
${policyStore}
${buildQuickFaqDirective(faqMatch)}

${fewShot}

INSTRUCTIONS:
1. RESPONSE STYLE: Concise (under 50 words) and helpful.
2. DISCOUNTS: ${bargainingInstruction}
3. MULTILINGUAL: ${langInstruction}
4. ESCALATION: If the customer asks for a human, is angry, or you cannot answer, say: "I'm connecting you to our specialist now. ⏳"
5. GOAL: Guide the user towards a purchase or booking.
6. Use retrieved knowledge when it directly answers the customer; do not invent facts outside provided context.

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

    try {
      const { callAI } = require('../core/aiGateway');
      const aiResult = await withTimeout(
        callAI({
          clientId: client.clientId,
          feature: 'whatsapp_bot',
          systemPrompt,
          prompt,
          temperature: 0.35,
          fast: true,
          model: aiResolved.model,
        }),
        AI_BOT_TIMEOUT_MS,
        "Gemini AI Fallback Generation"
      );
      reply = aiResult?.content;
      if (!reply) {
        throw new Error("Gemini AI returned empty response");
      }
    } catch (aiErr) {
      if (aiErr.code === 'AI_NOT_CONFIGURED' || aiErr.message === 'AI_NOT_CONFIGURED') {
        return false;
      }
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

    reply = applyPersonaPostProcess(reply, persona);
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
    
    await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $set: { consecutiveFailedMessages: 0 } });
    
    // Phase 26: Voice Reply Logic
    const isVoiceInput = parsedMessage.type === 'audio' || parsedMessage.type === 'voice';
    const voiceEnabled = client.ai?.voiceRepliesEnabled || client.voiceRepliesEnabled;
    const voiceMode = client.ai?.voiceReplyMode || 'mirror';

    if (voiceEnabled && (voiceMode === 'always' || (voiceMode === 'mirror' && isVoiceInput))) {
      const voiceUrl = await generateVoiceReply(reply, client.ai?.voiceReplyLanguage || 'en-IN');
      if (voiceUrl) {
        await sendWhatsAppAudio(client, phone, voiceUrl);
        return true;
      }
    }

    await sendWhatsAppText(client, phone, reply, 'whatsapp', {
      trainingContext: [],
    });
    return true;
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
      return true;
    }
    await sendWhatsAppText(client, phone, "I'm having a bit of trouble understanding. Let me check with my team! 😊");
    return true;
  }
}

async function sendWhatsAppText(client, phone, body, channel = 'whatsapp', opts = {}) {
  if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) return false;

  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) return false;
  try {
    let detectedLang = opts.detectedLanguage || 'en';
    if (!opts.skipConvoLookup) {
      const convo = await Conversation.findOne(
        { phone, clientId: client.clientId },
        { detectedLanguage: 1, _id: 1 }
      ).lean();
      detectedLang = convo?.detectedLanguage || detectedLang;
      opts.conversationId = opts.conversationId || convo?._id;
    }
    const translated = opts.skipTranslation
      ? body
      : await translateToUserLanguage(body, detectedLang, client);
    let bodyContent = String(translated || body || '').trim();
    if (!bodyContent || bodyContent === 'null' || bodyContent === 'undefined' || bodyContent === '[object Object]') {
      bodyContent = 'Thanks for your message — tap *menu* anytime to see options.';
    }
    bodyContent = bodyContent.substring(0, 4096);

    const { dispatchBotEnvelope } = require('../messaging/botEnvelopeDispatch');
    const env = await dispatchBotEnvelope({
      client,
      phone,
      payload: { text: bodyContent },
      opts: { ...opts, messageId: opts.inboundMessageId, source: 'dualBrainEngine:sendText', complianceExempt: opts.complianceExempt === true },
    });
    if (env?.handled) {
      if (env.sent && env.messageId) {
        await saveOutboundMessage(phone, client.clientId, 'text', bodyContent, env.messageId, channel, {
          trainingContext: opts.trainingContext,
        });
        markOutboundSent(client.clientId, phone);
      } else if (env.blocked || env.reason) {
        log.warn(`[sendText] Blocked/unsent for ${client.clientId}:${phone} (${env.reason || 'blocked'})`);
      }
      return !!env.sent;
    }
  } catch (err) { log.error('sendText error:', { error: err.response?.data?.error?.message || err.message }); }
  return false;
}

async function sendWhatsAppImage(client, phone, imageUrl, caption) {
  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) return;
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const translatedCaption = await translateToUserLanguage(caption, convo?.detectedLanguage, client);
    const cap = String(translatedCaption || caption).substring(0, 1024);

    const { dispatchBotEnvelope } = require('../messaging/botEnvelopeDispatch');
    const env = await dispatchBotEnvelope({
      client,
      phone,
      payload: { media: { type: 'image', url: imageUrl }, text: cap },
      opts: { conversationId: convo?._id, source: 'dualBrainEngine:sendImage' },
    });
    if (env?.handled) {
      if (env.sent && env.messageId) {
        await saveOutboundMessage(phone, client.clientId, 'image', cap || '[Image]', env.messageId);
      }
      return;
    }
  } catch (err) { log.error('sendImage error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppAudio(client, phone, audioUrl) {
  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) return;
  try {
    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { link: audioUrl }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'audio', '[Voice Note]', res.data.messages[0].id);
  } catch (err) { log.error('sendAudio error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppInteractive(client, phone, interactive, bodyText = '', _retried = false) {
  if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone))) return false;

  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) return false;

  const { sanitizeInteractivePayload } = require('../flow/sanitizeFlowMedia');
  sanitizeInteractivePayload(interactive);

  if (interactive?.type === "list") {
    const listSections = interactive.action?.sections || [];
    const listRows = listSections.reduce((n, s) => n + (s.rows?.length || 0), 0);
    if (!listSections.length || listRows === 0) {
      const fallback =
        String(bodyText || interactive.body?.text || "").trim() ||
        "We couldn't load options right now. Please try again in a moment.";
      await sendWhatsAppText(client, phone, fallback.substring(0, 4096));
      return true;
    }
  }

  let payloadData = null;
  try {
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
    payloadData = data;

    if (interactive.footer) {
      data.interactive.footer = { text: (interactive.footer.text || interactive.footer || '').substring(0, 60) };
    }

    const { dispatchBotEnvelope } = require('../messaging/botEnvelopeDispatch');
    const env = await dispatchBotEnvelope({
      client,
      phone,
      payload: { interactive, text: interactive.body?.text || bodyText },
      opts: { source: 'dualBrainEngine:sendInteractive' },
    });
    if (env?.handled) {
      if (env.sent && env.messageId) {
        await saveOutboundMessage(
          phone,
          client.clientId,
          'interactive',
          interactive.body?.text || '[Interactive]',
          env.messageId
        );
        markOutboundSent(client.clientId, phone);
      } else if (env.blocked || env.reason) {
        log.warn(`[sendInteractive] Blocked/unsent for ${client.clientId}:${phone} (${env.reason || 'blocked'})`);
      }
      return env.sent || env.duplicate;
    }

    return false;
  } catch (err) {
    const errorData = err.response?.data || err.message;
    const errCode = err.response?.data?.error?.code;

    if (!_retried && interactive?.header) {
      log.warn(`[sendInteractive] Retrying without header for ${phone} (${errCode || err.message})`);
      const stripped = { ...interactive };
      delete stripped.header;
      return sendWhatsAppInteractive(client, phone, stripped, bodyText, true);
    }

    log.error('sendInteractive error:', {
        clientId: client.clientId,
        phone,
        error: errorData,
        payload: payloadData ? JSON.stringify(payloadData, null, 2) : '[unavailable]'
    });

    if (isEngineRunAborted(client.clientId, phone, getEngineRunId(client.clientId, phone)) || wasOutboundSent(client.clientId, phone)) {
      return false;
    }

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
  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) return;
  
  try {
    let finalLang = languageCode;
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    if (!finalLang) {
      finalLang = convo?.detectedLanguage || 'en';
    }

    const { dispatchBotEnvelope } = require('../messaging/botEnvelopeDispatch');
    const env = await dispatchBotEnvelope({
      client,
      phone,
      payload: {
        templateName,
        templateLanguage: finalLang,
        components: Array.isArray(components) ? components : [],
      },
      opts: { conversationId: convo?._id, source: 'dualBrainEngine:sendTemplate' },
    });
    if (env?.handled) {
      if (env.sent && env.messageId) {
        await saveOutboundMessage(phone, client.clientId, 'template', `[Template: ${templateName}]`, env.messageId);
      }
      return;
    }
  } catch (err) { log.error('sendTemplate error:', { error: err.response?.data || err.message }); }
}

async function sendWhatsAppSmartTemplate(client, phone, templateName, variables = [], headerImage = null, languageCode = 'en') {
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId }).lean();
    const params = [];
    if (Array.isArray(variables) && variables.length) {
      params.push({
        type: 'body',
        parameters: variables.map((v) => ({ type: 'text', text: String(v) })),
      });
    }
    if (headerImage) {
      params.push({
        type: 'header',
        parameters: [{ type: 'image', image: { link: headerImage } }],
      });
    }

    const { dispatchBotEnvelope } = require('../messaging/botEnvelopeDispatch');
    const env = await dispatchBotEnvelope({
      client,
      phone,
      payload: {
        templateName,
        templateLanguage: languageCode || 'en',
        components: params,
      },
      opts: { conversationId: convo?._id, source: 'dualBrainEngine:sendSmartTemplate' },
    });
    if (env?.handled) {
      if (env.sent && env.messageId) {
        await saveOutboundMessage(
          phone,
          client.clientId,
          'template',
          `[SmartTemplate: ${templateName}]`,
          env.messageId
        );
      }
      return env.sent ? { messages: [{ id: env.messageId }] } : null;
    }

    return null;
  } catch (err) {
    if (
      (err.message || "").includes("132001") ||
      (err.message || "").includes("132000") ||
      (err.message || "").includes("132012")
    ) {
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
  const token = getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
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
function buildInboundBody(parsedMessage) {
  if (!parsedMessage || typeof parsedMessage !== 'object') return 'Message';

  const type = String(parsedMessage.type || '').toLowerCase();

  const textBody = parsedMessage.text?.body || parsedMessage.body || '';
  if (textBody) return textBody;

  const btnTitle = parsedMessage.interactive?.button_reply?.title;
  if (btnTitle) return btnTitle;

  const listTitle = parsedMessage.interactive?.list_reply?.title;
  if (listTitle) return listTitle;

  const nfm = parsedMessage.interactive?.nfm_reply;
  if (nfm) {
    if (nfm.body) return nfm.body;
    try {
      const payload = typeof nfm.response_json === 'string'
        ? JSON.parse(nfm.response_json)
        : nfm.response_json;
      if (payload && typeof payload === 'object') {
        const values = Object.values(payload).filter((v) => typeof v === 'string' && v.trim());
        if (values.length) return values.join(' · ');
      }
    } catch (_) { /* ignore malformed flow JSON */ }
    return nfm.name ? `Form response (${nfm.name})` : 'Form response';
  }

  const legacyBtn = parsedMessage.button?.text || parsedMessage.button?.payload;
  if (legacyBtn) return legacyBtn;

  const caption =
    parsedMessage.caption ||
    parsedMessage.image?.caption ||
    parsedMessage.video?.caption ||
    parsedMessage.document?.caption;
  if (caption) return caption;

  if (parsedMessage.voiceTranscript) return parsedMessage.voiceTranscript;

  const reaction = parsedMessage.reaction;
  if (reaction?.emoji) {
    return reaction.emoji;
  }

  const loc = parsedMessage.location;
  if (loc) {
    const label = loc.name || loc.address || '';
    const coords =
      loc.latitude != null && loc.longitude != null
        ? `${loc.latitude}, ${loc.longitude}`
        : '';
    const parts = [label, coords].filter(Boolean);
    return parts.length ? `Location: ${parts.join(' · ')}` : 'Shared location';
  }

  const contacts = parsedMessage.contacts;
  if (Array.isArray(contacts) && contacts.length) {
    const names = contacts
      .map((c) => c.name?.formatted_name || c.name?.first_name)
      .filter(Boolean);
    return names.length ? `Contact: ${names.join(', ')}` : 'Shared contact';
  }

  const order = parsedMessage.order;
  if (order) {
    const count = order.product_items?.length || 0;
    return count ? `Catalog order (${count} item${count === 1 ? '' : 's'})` : 'Catalog order';
  }

  if (type === 'document' && parsedMessage.document?.filename) {
    return parsedMessage.document.filename;
  }

  const typeLabels = {
    image: 'Photo',
    audio: 'Voice message',
    voice: 'Voice message',
    video: 'Video',
    document: 'Document',
    sticker: 'Sticker',
    unsupported: 'Unsupported message',
    location: 'Shared location',
    contacts: 'Shared contact',
    reaction: 'Reaction',
    order: 'Catalog order',
  };
  if (typeLabels[type]) return typeLabels[type];

  return 'Unsupported message';
}

function emitLiveChatInboundEvents(io, clientId, conversationId, savedMessage, convoLean) {
  if (!io || !clientId) return;
  io.to(`client_${clientId}`).emit('new_message', savedMessage);
  const preview = (savedMessage.content || savedMessage.body || '').substring(0, 100);
  const ts = savedMessage.timestamp || new Date();
  const patch = {
    _id: conversationId,
    clientId,
    phone: convoLean?.phone,
    customerName: convoLean?.customerName,
    lastMessage: preview,
    lastMessageAt: ts,
    lastInteraction: ts,
    unreadCount: convoLean?.unreadCount,
    status: convoLean?.status,
    botPaused: convoLean?.botPaused,
  };
  io.to(`client_${clientId}`).emit('conversation_update', patch);
}

async function saveInboundMessage(
  phone,
  clientId,
  parsedMessage,
  io,
  channel = 'whatsapp',
  conversationId,
  convoLean = null
) {
  try {
    const body = buildInboundBody(parsedMessage);
    const waMsgId = String(parsedMessage.messageId || parsedMessage.id || '').trim();

    if (waMsgId) {
      const existing = await Message.findOne({ messageId: waMsgId })
        .select('_id conversationId clientId content body timestamp direction type channel messageId')
        .lean();
      if (existing) {
        emitLiveChatInboundEvents(io, clientId, conversationId, existing, convoLean);
        return existing;
      }
    }

    const savedMessage = await createMessage({
      clientId,
      conversationId,
      phone,
      from: phone,
      to: 'BOT',
      direction: 'inbound',
      type: parsedMessage.type || 'text',
      body,
      messageId: waMsgId,
      mediaUrl: parsedMessage.mediaUrl || null,
      channel,
      translatedContent: parsedMessage.translatedContent || '',
      detectedLanguage: parsedMessage.detectedLanguage || 'en',
      originalText: parsedMessage.originalText || '',
      voiceTranscript: parsedMessage.voiceTranscript || '',
    });

    emitLiveChatInboundEvents(io, clientId, conversationId, savedMessage, convoLean);
    setImmediate(() => {
      const { runSentimentScoring } = require('../../services/sentiment/runSentimentScoring');
      runSentimentScoring(savedMessage._id).catch(() => {});
    });
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
async function saveOutboundMessage(phone, clientId, type, body, wamid, channel = 'whatsapp', extra = {}) {
  markOutboundSent(clientId, phone);
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
      channel,
      trainingContext: extra.trainingContext,
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

/**
 * WhatsApp catalog order webhook: build per-user checkout link + send message.
 * Multi-tenant: clientDoc.shopDomain + variant IDs from that store's catalog sync.
 */
async function handleWhatsAppCatalogOrder(clientDoc, phone, orderData = {}) {
  const { generateCheckoutForOrder } = require('./commerceCheckoutService');
  const items = Array.isArray(orderData.product_items) ? orderData.product_items : [];
  if (!items.length) {
    log.warn("[CatalogOrder] No product_items on order payload");
    return { shortUrl: "", checkoutUrl: "", totalPrice: 0, shortCode: "" };
  }

  const bundle = await generateCheckoutForOrder(clientDoc, phone, items);
  await deliverCartCheckoutFromFlow(clientDoc, phone, orderData, {
    shortUrl: bundle.shortUrl,
    checkoutUrl: bundle.fullUrl,
    shortCode: bundle.shortCode,
    totalPrice: bundle.totalValue,
    currency: bundle.currency,
  });

  log.info(
    `[CatalogOrder] Checkout for ${clientDoc.clientId} / ${phone}: ${bundle.shortUrl ? "short link" : "direct"} (${items.length} items)`
  );

  return {
    shortUrl: bundle.shortUrl || bundle.fullUrl || "",
    checkoutUrl: bundle.fullUrl || "",
    totalPrice: Number(bundle.totalValue) || 0,
    shortCode: bundle.shortCode || "",
    currency: bundle.currency || "INR",
  };
}

/**
 * After commerceCheckoutService builds permalink + CheckoutLink, send cart_handler or default checkout text.
 * Called from masterWebhook (order.type === 'order').
 */
async function deliverCartCheckoutFromFlow(client, phone, orderData, checkoutBundle) {
  const normalizedPhone = normalizePhone(phone);
  const items = orderData?.product_items || [];
  const total = Number(checkoutBundle?.totalPrice) || 0;
  const currency = items[0]?.currency || "INR";
  const shortUrl = checkoutBundle?.shortUrl || checkoutBundle?.checkoutUrl || "";

  let convo = await Conversation.findOneAndUpdate(
    { phone: normalizedPhone, clientId: client.clientId },
    {
      $set: {
        pendingCart: { catalogId: orderData?.catalog_id, items, addedAt: new Date() },
        lastCheckoutUrl: shortUrl,
        lastCheckoutShortCode: checkoutBundle?.shortCode,
        lastCheckoutValue: total,
        lastCheckoutAt: new Date(),
        "metadata.checkout_url": shortUrl,
        "metadata.cart_total": String(total),
        "metadata.currency": currency,
        "metadata.item_count": String(items.length)
      }
    },
    { new: true, upsert: true }
  );

  const lead = await AdLead.findOne({ phoneNumber: normalizedPhone, clientId: client.clientId }).lean();

  const { nodes: flowNodes, edges: flowEdges } = await getFlowGraphForConversation(client, convo);
  const flatNodes = flattenFlowNodes(flowNodes);
  const cartEdge = (flowEdges || []).find(
    (e) => e.source === convo?.lastStepId && e.sourceHandle === "cart"
  );
  if (cartEdge) {
    const target = flatNodes.find((n) => n.id === cartEdge.target);
    if (target && target.type === "cart_handler") {
      const ctx = await buildVariableContext(client, normalizedPhone, convo, lead);
      Object.assign(ctx, {
        checkout_url: shortUrl,
        cart_total: String(total),
        currency,
        item_count: String(items.length)
      });
      const hydrated = injectNodeVariables(target, ctx);
      await sendNodeContent(hydrated, client, normalizedPhone, lead, convo, "whatsapp", {});
      return true;
    }
  }

  const tpl =
    client.commerceBotSettings?.checkoutMessage ||
    `Complete your checkout 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}`;
  const out = injectVariables(String(tpl), {
    checkout_url: shortUrl,
    cart_total: String(total),
    currency,
    item_count: String(items.length),
    first_name: (lead?.name || "there").split(/\s+/)[0]
  });
  await sendWhatsAppText(client, normalizedPhone, out);
  return true;
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
  handleWhatsAppCatalogOrder,
  deliverCartCheckoutFromFlow,
  loadPublishedFlowByRef,
};

