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
  sendFlow: (...args) => sendWhatsAppFlow(...args),
};

const Instagram = {
  sendText: (client, phone, text, options = {}) => sendInstagramText(client, phone, text, options),
  sendImage: (client, phone, imageUrl, caption, options = {}) => sendInstagramImage(client, phone, imageUrl, caption, options),
  sendInteractive: (client, phone, interactive, bodyText, options = {}) => sendInstagramInteractive(client, phone, interactive, bodyText, options),
};

const { sendInstagramReply, sendInstagramMessage } = require("./omnichannel");
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

/**
 * Phase 21: Universal Flow Executor
 * Starts a visual flow for a user, handling convo/lead setup and extra context (like commentId).
 */
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

    // 2.5 Log Journey
    await AdLead.pushJourneyEvent(client.clientId, phone, 'flow_started', { flowId: flow.id, flowName: flow.name });

    // 3. Execute
    log.info(`Manual runFlow: Executing ${flow.name} starting at ${startNodeId}`);
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

    // 1. Session Lock (Atomic via MongoDB)
    try {
      await ProcessingLock.create({ phone: from, clientId: client.clientId });
    } catch (lockErr) {
      log.warn(`Session locked for ${from} (Client: ${client.clientId}). Skipping rapid message.`);
      return;
    }

    const parsed = await parseWhatsAppPayload(message);
    if (!parsed) {
      processingLocks.delete(from);
      return;
    }

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
        } finally {
            processingLocks.delete(from);
        }
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
      channel: 'whatsapp',
      profileName
    };

    // run engine
    await runDualBrainEngine(parsedMessage, client);

  } catch (err) {
    log.error(`handleWhatsAppMessage Error:`, { from, error: err.message });
  } finally {
    // Release MongoDB distributed lock
    try {
      if (typeof client !== 'undefined' && client?.clientId) {
        await ProcessingLock.deleteOne({ phone: from, clientId: client.clientId });
      }
    } catch (releaseErr) {
      log.error(`Lock release failed for ${from}`, { error: releaseErr.message });
    }
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

  // --- Phase 23: Track 7 - Language Intelligence ---
  const inboundText = parsedMessage.text?.body || parsedMessage.interactive?.button_reply?.title || '';
  let detectedLanguage = 'en';
  if (inboundText) {
      try {
          const langResult = await detectLanguage(inboundText);
          detectedLanguage = langResult.languageCode || 'en';
      } catch (err) { log.debug("Language detection failed:", { error: err.message }); }
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
                  const flow = (client.visualFlows || []).find(f => f.id === convo.activeFlowId);
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
  const referral = parsedMessage.referral;
  const adUpdate = referral ? {
    $set: {
      "adAttribution.source": referral.source_type === 'ad' ? 'meta_ad' : 'organic',
      "adAttribution.adId": referral.source_id,
      "adAttribution.adHeadline": referral.headline,
      "adAttribution.adBody": referral.body,
      "adAttribution.adMediaUrl": referral.image_url || referral.video_url,
      "adAttribution.firstMessageAt": new Date()
    }
  } : {};

  let lead = await AdLead.findOneAndUpdate(
    { phoneNumber: phone, clientId: client.clientId },
    { 
      $setOnInsert: { phoneNumber: phone, clientId: client.clientId, source: referral ? 'Meta Ad' : 'Direct' },
      $set: { 
        ...(profileName && { name: profileName }), // Sync WhatsApp name
        lastInteraction: new Date()
      },
      ...adUpdate
    },
    { upsert: true, new: true }
  );

  // STEP 2.5: PHASE 25 - Referral Tracking & Fulfillment
  const incomingText = Object.keys(parsedMessage.text || {}).length ? parsedMessage.text.body || '' : '';
  const refCodeMatch = incomingText.match(/ref_([A-Z0-9]{6})/i);
  if (refCodeMatch && refCodeMatch[1]) {
    const ReferralEngine = require('./referralEngine');
    await ReferralEngine.processReferral(refCodeMatch[1], lead);
  }

  // STEP 3: Save inbound message to DB + emit to dashboard
  await saveInboundMessage(phone, client.clientId, parsedMessage, io, channel, convo._id);

  // STEP 3.5: SUBSCRIPTION LIMIT CHECK (Phase 23)
  const limits = await checkLimit(client._id, 'messages');
  if (!limits.allowed) {
      log.warn(`Limit Reached for ${client.clientId}. Halting DualBrain Engine processing.`);
      return; 
  }
  // Track this transaction 
  await incrementUsage(client._id, 'messages', 1);

  // STEP 3.6: LANGUAGE DETECTION (Phase 23 Track 7)
  const detectedLang = await detectLanguage(incomingText, client);
  if (detectedLang !== 'en') {
      await Conversation.findByIdAndUpdate(convo._id, { $set: { detectedLanguage: detectedLang } });
      convo.detectedLanguage = detectedLang; // Update local copy
  }
  parsedMessage._detectedLanguage = detectedLang;

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
      const negotiatedResponse = await NegotiationEngine.processNegotiation(client, lead, incomingText);
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
       await Conversation.findByIdAndUpdate(convo._id, { botPaused: true, isBotPaused: true });
       ruleIntercepted = true;
    }

    // Phase 22 Routing Handoff trigger
    if (results.handoff) {
       // Just flag for routing engine processing (done later in phase 22)
       convo.assignedAgent = results.handoff;
       await Conversation.findByIdAndUpdate(convo._id, { assignedAgent: results.handoff });
    }

    if (ruleIntercepted) {
      log.info(`Rules Engine Intercepted message processing for ${phone}`);
      return; 
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
           assigned = routingDirective.agentIds[Math.floor(Math.random() * routingDirective.agentIds.length)];
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
  
  const optOutKeywords = ['stop', 'unsubscribe', 'opt out', 'halt', 'cancel', 'block bot'];
  const optInKeywords  = ['start', 'opt in', 'subscribe', 'resume', 'unpause'];

  if (optOutKeywords.some(k => userTextLower === k)) {
    log.info(`🛑 Opt-out detected for ${phone}. Pausing bot.`);
    
    await Conversation.findByIdAndUpdate(convo._id, { 
       botPaused: true, 
       isBotPaused: true, 
       status: 'OPTED_OUT' 
    });

    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      { 
        $set: { 
          optStatus: 'opted_out', 
          optOutDate: new Date(), 
          optOutReason: 'user_keyword',
          optOutKeyword: userTextRaw 
        },
        $addToSet: { tags: 'Opted Out' },
        $push: {
          optInHistory: {
            action: 'opted_out',
            timestamp: new Date(),
            source: 'user_keyword',
            note: `User sent: "${userTextRaw}"`
          }
        }
      }
    );

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
          optInSource: 'whatsapp_re_optin' 
        },
        $pull: { tags: 'Opted Out' },
        $addToSet: { tags: 'Opted In' },
        $push: {
          optInHistory: {
            action: 're_opted_in',
            timestamp: new Date(),
            source: 'user_keyword'
          }
        }
      }
    );

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

  if (convo.botPaused || ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT', 'OPTED_OUT'].includes(convo.status)) {
    log.info(`⏸️ Bot paused for ${phone} (Status: ${convo.status}). Skipping.`);
    analyzeConversationIntelligence(client, phone, convo);
    return true;
  }

  // MANUAL MODE: Only respond if an EXPLICIT trigger is matched

  if (handoffMode === 'MANUAL') {
    const trigger = findMatchingFlow(userText, client.flowNodes, client.flowEdges);
    if (!trigger) {
      log.info(`🙊 Manual Mode: No trigger match for "${userText}". Bot silent.`);
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
      const flatNodes = flattenFlowNodes(client.flowNodes || []);
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
            $set: { status: 'HUMAN_SUPPORT', waitingForVariable: null, captureResumeNodeId: null, captureRetries: 0 }
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
          lastStepId:          nodeId
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
          convo.captureResumeNodeId, flatNodes, client.flowEdges || [],
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
    await runAIFallback(parsedMessage, client, phone, lead, channel);
    analyzeConversationIntelligence(client, phone, convo);
    return true;
  }
  
  // Return false so the engine can process legacy interactive IDs
  analyzeConversationIntelligence(client, phone, convo);
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
    log.info(`Graph: Jumping to node ${jumpNode.id} based on keyword/role match "${userTextLower}"`);
    await trackNodeVisit(client, jumpNode.id);
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
    log.info(`Graph: edge match from ${currentStepId} → ${matchingEdge.target}`);
    await trackNodeVisit(client, matchingEdge.target);
    return await executeNode(matchingEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel);
  }

  // D) GLOBAL RESET / GREETING / AI INTENT
  if (!incomingTrigger.buttonId) {
      // 1. Check Keywords
      let matchingTrigger = flowNodes.find(n => (n.type === 'trigger' || n.type === 'TriggerNode') && (n.data?.keyword || '').toLowerCase().split(',').map(k => k.trim()).includes(userTextLower));
      
      // 2. AI Intent Detection Fallback (Priority 1B)
      if (!matchingTrigger && userText.length > 3) {
          const intentNodes = flowNodes.filter(n => (n.type === 'trigger' || n.type === 'TriggerNode') && n.data?.triggerType === 'intent' && n.data?.intentDescription);
          const apiKey = process.env.GEMINI_API_KEY;
          
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
          await trackNodeVisit(client, matchingTrigger.id);
          return await executeNode(matchingTrigger.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
      }
      
      // If none matched, check for basic greeting reset
      if (isGreeting(userTextLower) || userTextLower === 'start' || userTextLower === 'menu') {
          const firstTrigger = flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode');
          if (firstTrigger) {
              log.info(`Graph: Greeting reset to node ${firstTrigger.id}`);
              await trackNodeVisit(client, firstTrigger.id);
              return await executeNode(firstTrigger.id, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
          }
      }
  }

  // E) No currentStepId — Fresh Start
  if (!currentStepId) {
    const startNode = flowNodes.find(n => n.type === 'trigger' || n.type === 'TriggerNode') || flowNodes.find(n => n.data?.role === 'welcome') || flowNodes[0];
    if (startNode) {
      log.info(`Graph: Starting fresh from node ${startNode.id}`);
      await trackNodeVisit(client, startNode.id);
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
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE A SPECIFIC NODE
// ─────────────────────────────────────────────────────────────────────────────
async function executeNode(nodeId, flowNodes, flowEdges, client, convo, lead, phone, io, channel = 'whatsapp', parsedMessage = {}) {
  const rawNode = flowNodes.find(n => n.id === nodeId);
  if (!rawNode) { log.warn(`Node ${nodeId} not found`); return false; }

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

  // Increment visitCount for Flow Convergence Analytics (Phase 23 Track 5)
  try {
    const updatedNodes = incrementNodeVisit(client.flowNodes || [], nodeId);
    await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes });
    // Update local reference for this execution chain
    client.flowNodes = updatedNodes;

    // Track on the specific Visual Flow if it's a multi-flow architecture
    if (convo?.currentFlowId) {
       await Client.updateOne(
         { _id: client._id, "visualFlows.id": convo.currentFlowId },
         { $inc: { "visualFlows.$.nodes.$[n].visitCount": 1 } },
         { arrayFilters: [{ "n.id": nodeId }] }
       );
    }
  } catch (err) {
    log.error(`Failed to increment visit count for node ${nodeId}:`, { error: err.message });
  }


  const sent = await withTimeout(
    sendNodeContent(node, client, phone, lead, convo, channel, parsedMessage),
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
      if (leftValue === undefined) leftValue = (lead?.capturedData?.[variable] || convo?.metadata?.[variable]) ?? '';
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

    log.info(`Logic: ${variable}(${leftValue}) ${operator} ${compValue} → ${result ? 'TRUE' : 'FALSE'}`);
    const targetHandle = result ? 'true' : 'false';
    const nextEdge = flowEdges.find(e =>
      e.source === nodeId && (e.sourceHandle === targetHandle || normalizeHandleId(e.sourceHandle) === targetHandle)
    );
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
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

  // Phase 21: Admin Alert Node
  if (node.type === 'admin_alert' || node.type === 'AdminAlertNode') {
    const { topic, channel: alertChannel, priority } = node.data || {};
    const alertMsg = topic || "🚨 Human Support Requested";
    
    // 1. Mark conversation as needing attention
    await Conversation.findByIdAndUpdate(convo._id, { 
      requiresAttention: true, 
      attentionReason: alertMsg,
      lastInteraction: new Date()
    });

    // 2. Emit real-time socket event to dashboard
    if (io) {
      io.to(`client_${client.clientId}`).emit('admin_alert', {
        type: 'escalation',
        topic: alertMsg,
        priority: priority || 'high',
        phone,
        leadName: lead?.name || 'Customer',
        timestamp: new Date()
      });
    }

    log.info(`AdminAlert triggered for ${phone}: ${alertMsg}`);
    
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    if (nextEdge) return await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, phone, io, channel, parsedMessage);
  }

  // Phase 17: Delay / Wait Node
  if (node.type === 'delay' || node.type === 'WaitNode') {
    let { duration, unit } = node.data; // duration: 5, unit: 'minutes' or duration: '15m'
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

  // USP Section: Shopify-Native AI Actions
  if (node.type === 'shopify_call' || node.type === 'ShopifyNode') {
    const { action, query, variable } = node.data;
    const { getShopifyClient, withShopifyRetry } = require("./shopifyHelper");
    
    try {
      let resultData = null;

      // --- USP 1: DYNAMNIC PRODUCT CARDS ---
      if (action === 'PRODUCT_CARD') {
        const products = client.knowledgeBase?.products || [];
        if (products.length > 0) {
          const rand = products[Math.floor(Math.random() * products.length)];
          const msg = `Check this out! 🛍️\n\n*${rand.name}*\n${rand.description?.substring(0, 100)}...\n\n*Price:* ₹${rand.price}\n\nLink: ${rand.url || 'Visit our store'}`;
          await sendWhatsAppText(client, phone, msg);
          resultData = { product: rand.name, status: 'sent' };
        } else {
          await sendWhatsAppText(client, phone, "I'd love to show you our products, but our catalog is being updated. One moment! 🛒");
        }
      } 
      
      // --- USP 2: REAL-TIME ORDER TRACKING ---
      else if (action === 'ORDER_STATUS' || action === 'get_order') {
        resultData = await withShopifyRetry(client.clientId, async (shopify) => {
          const res = await shopify.get(`/orders.json?status=any&limit=1&phone=${phone.replace('+', '')}`);
          const order = res.data.orders?.[0];
          if (!order) return { error: 'No order found for this number' };
          
          const status = order.fulfillment_status || 'Unfulfilled';
          const msg = `📦 *Order #${order.order_number} Update*\n\nStatus: *${status.toUpperCase()}*\nItems: ${order.line_items.map(i => i.title).join(', ')}\nTotal: ${order.currency} ${order.total_price}\n\nTrack here: ${order.order_status_url}`;
          await sendWhatsAppText(client, phone, msg);
          return { status, id: order.id };
        });
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
          return { code, discount: '10%' };
        });
      }

      // --- USP 4: COD TO PREPAID CONVERSION ---
      else if (action === 'COD_TO_PREPAID') {
        const { createCODPaymentLink } = require("./razorpay");
        const AdOrder = require("../models/AdOrder");
        const latestOrder = await AdOrder.findOne({ customerPhone: phone, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        
        if (latestOrder && latestOrder.paymentMethod === 'cod') {
          const rzpLink = await createCODPaymentLink(latestOrder, client);
          const msg = `Hey! We noticed you chose COD for Order #${latestOrder.orderNumber}. 💳\n\nIf you pre-pay now via this link, we'll fulfill your order *Priority Faster* and add a surprise gift! 🎁\n\nPay here: ${rzpLink.short_url}`;
          await sendWhatsAppText(client, phone, msg);
          resultData = { link: rzpLink.short_url, status: 'sent' };
        } else {
          log.info(`[COD_TO_PREPAID] No eligible COD order found for ${phone}`);
        }
      }

      // Save to variable if requested
      if (variable && resultData) {
        const updatedMetadata = { ...(convo.metadata || {}), [variable]: resultData };
        await Conversation.findByIdAndUpdate(convo._id, { metadata: updatedMetadata });
        convo.metadata = updatedMetadata;
      }
    } catch (err) {
      log.error(`Shopify Action ${action} Failed:`, { error: err.message });
      await sendWhatsAppText(client, phone, "I'm having a bit of trouble connecting to the store right now. Please try again in a minute! 🔄");
    }
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
    } catch (err) { log.error("HTTP Node Error:", { error: err.message }); }
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

  // Auto-forward or enter WAIT state
  if (isWaitNode) {
    // Correctly enter WAITING_FOR_INPUT state
    const targetVar = node.data?.variable || 'last_input';
    const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output'));
    
    log.info(`⏳ Node ${nodeId} entering wait state for variable "${targetVar}"`);
    await Conversation.findByIdAndUpdate(convo._id, {
      status: 'WAITING_FOR_INPUT',
      waitingForVariable: targetVar,
      captureResumeNodeId: nextEdge ? nextEdge.target : null,
      captureRetries: 0,
      lastStepId: nodeId
    });
  } else if (node.type !== 'logic') {
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

  switch (type) {
    case 'image': {
      const imageUrl = data.imageUrl || '';
      const caption = data.caption || '';
      if (!imageUrl) return true;
      if (channel === 'instagram') {
        await Instagram.sendImage(client, phone, imageUrl, caption, options);
      } else {
        await WhatsApp.sendImage(client, phone, imageUrl, caption);
      }
      return true;
    }

    case 'folder': return true;

    case 'capture_input':
    case 'CaptureNode': {
      let body = data.text || data.body || data.label || 'Please provide the requested information:';
      // Variables already hydrated via deepInject in executeNode
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);
      if (channel === 'instagram') await Instagram.sendText(client, phone, body, options);
      else await WhatsApp.sendText(client, phone, body);
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
      
      if (channel === 'instagram') {
        if (data.imageUrl) await Instagram.sendImage(client, phone, data.imageUrl, body, options);
        else await Instagram.sendText(client, phone, body, options);
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
      body = await translateToUserLanguage(body, convo?.detectedLanguage, client);

      if (data.btnUrlLink) {
        if (channel === 'instagram') {
            await Instagram.sendInteractive(client, phone, {
                type: 'button',
                text: body,
                buttons: [{ type: 'web_url', url: data.btnUrlLink, title: (data.btnUrlTitle || 'Visit').substring(0, 20) }]
            }, body, options);
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
        if (channel === 'instagram') await Instagram.sendText(client, phone, body, options);
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
        }, body, options);
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
            text: p.substring(0, 1024)
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
      let subject = data.subject || 'Update';
      let body = data.body || '';
      await emailService.sendEmail(client, { to: recipient, subject, html: body.replace(/\n/g, '<br/>') });
      return true;
    }

    case 'catalog': {
      const { catalogType, productId, productIds, body, header, footer } = data;
      const bodyText = (body || data.text || "Check out our collection!").substring(0, 1024);
      const replacedBody = bodyText;
      
      if (catalogType === 'multi') {
        const ids = (productIds || '').split(',').map(id => id.trim()).filter(Boolean);
        const sections = [{ title: 'Our Picks', product_items: ids.map(id => ({ product_retailer_id: id })) }];
        await WhatsApp.sendMultiProduct(client, phone, header || 'Catalog', replacedBody, sections);
      } else {
        // Handle 'full' and 'single'
        await WhatsApp.sendCatalog(client, phone, replacedBody, footer || '', catalogType === 'single' ? productId : null);
      }
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
      log.warn(`Skipping send content for node type: ${type}`);
      return true;
  }

  // After sending the message, check for special actions
  if (node.data?.action) {
    const { handleNodeAction } = require("./nodeActions");
    // Execute action asynchronously
    handleNodeAction(node.data.action, node, client, phone, convo, lead).catch(err => {
      log.error(`Action Error (${node.data.action}):`, { error: err.message });
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

async function runAIFallback(parsedMessage, client, phone, lead, channel = 'whatsapp') {
  const text = parsedMessage.text?.body;
  if (!text) return false;

  try {
    const callIntentRegex = /\b(call|phone|talk|speak|representative|human|agent|person|connect|callback|calling)\b/i;
    if (callIntentRegex.test(text)) {
      await NotificationService.sendAdminAlert(client, { customerPhone: phone, topic: 'Customer Requesting Call/Human', triggerSource: 'AI Active Listener' });
      await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $set: { status: 'HUMAN_TAKEOVER', lastInteraction: new Date() } });
      await sendWhatsAppText(client, phone, `I've just notified our team that you'd like to speak with someone. A representative will reach out to you shortly! 📞✨`);
      return true;
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
    const knowledgeBase = (client.nicheData?.products || []).map(p => `PRODUCT: ${p.title} - ${p.price}. LINK: ${p.url}`).join('\n') || 'General product information available.';

    const prompt = [
      client.nicheData?.aiPromptContext || 'You are a friendly sales assistant.',
      knowledgeBase,
      `INSTRUCTIONS:\n- Keep response under 3 sentences.\n- Be warm and conversational.\n- ${langInstruction}\n- ${bargainingInstruction}\n- If unsure, say: "Let me connect you to our team."`,
      `Customer: ${text}`
    ].join('\n\n');

    const reply = await generateText(prompt, client.geminiApiKey || client.config?.geminiApiKey);
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
    const updatedConvo = await Conversation.findOneAndUpdate({ phone, clientId: client.clientId }, { $inc: { consecutiveFailedMessages: 1 } }, { new: true });
    if (updatedConvo && updatedConvo.consecutiveFailedMessages >= 3) {
      await handleUniversalEscalate(client, phone, updatedConvo);
      return;
    }
    await sendWhatsAppText(client, phone, "I'm having a bit of trouble understanding. Let me check with my team! 😊");
  }
}

async function sendWhatsAppText(client, phone, body, channel = 'whatsapp') {
  if (channel === 'instagram') {
    try {
      const resp = await sendInstagramReply(client, phone, body);
      await saveOutboundMessage(phone, client.clientId, 'text', body, resp.message_id || '', 'instagram');
      return resp;
    } catch (err) { log.error('IG sendReply error:', { error: err.message }); return; }
  }
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const translated = await translateToUserLanguage(body, convo?.detectedLanguage, client);
    const res = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: translated || body }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'text', translated || body, res.data.messages[0].id);
  } catch (err) { log.error('sendText error:', { error: err.response?.data?.error?.message || err.message }); }
}

async function sendWhatsAppImage(client, phone, imageUrl, caption) {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const convo = await Conversation.findOne({ phone, clientId: client.clientId });
    const translatedCaption = await translateToUserLanguage(caption, convo?.detectedLanguage, client);
    const res = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: imageUrl, caption: translatedCaption || caption }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'image', translatedCaption || caption || '[Image]', res.data.messages[0].id);
  } catch (err) { log.error('sendImage error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppAudio(client, phone, audioUrl) {
  const token = client.premiumAccessToken || client.whatsappToken;
  const phoneNumberId = client.premiumPhoneId || client.phoneNumberId;
  if (!token || !phoneNumberId) return;
  try {
    const res = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { link: audioUrl }
    }, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'audio', '[Voice Note]', res.data.messages[0].id);
  } catch (err) { log.error('sendAudio error:', { error: err.response?.data?.error?.message || err.message }); }
}


async function sendWhatsAppInteractive(client, phone, interactive) {
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

    const data = {
      messaging_product: 'whatsapp', to: phone, type: 'interactive',
      interactive
    };

    if (interactive.footer) {
      data.interactive.footer = { text: (interactive.footer.text || interactive.footer || '').substring(0, 60) };
    }

    const res = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, data, { headers: { Authorization: `Bearer ${token}` } });
    await saveOutboundMessage(phone, client.clientId, 'interactive', interactive.body?.text || '[Interactive]', res.data.messages[0].id);
    return true;
  } catch (err) {
    log.error('sendInteractive error:', { error: err.response?.data || err.message });
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

    const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: templateName, language: { code: finalLang }, components }
    }, { headers: { Authorization: `Bearer ${token}` } });
    
    await saveOutboundMessage(phone, client.clientId, 'template', `[Template: ${templateName}]`, res.data.messages[0].id);
  } catch (err) { log.error('sendTemplate error:', { error: err.response?.data || err.message }); }
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

    const res = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
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
// INSTAGRAM API HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function sendInstagramText(client, phone, text) {
  try {
    const res = await sendInstagramMessage(client, phone, { text });
    await saveOutboundMessage(phone, client.clientId, 'text', text, res.message_id || '', 'instagram');
    return true;
  } catch (err) {
    log.error('IG sendText error:', { error: err.message });
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
    log.error('IG sendImage error:', { error: err.message });
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
    log.error('IG sendInteractive error:', { error: err.message });
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
    log.error('Voice transcription error:', { error: err.message });
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

    // --- Phase 26: Sentiment Analysis ---
    const client = await Client.findOne({ clientId }, { ai: 1, geminiApiKey: 1 });
    const sentimentResult = await analyzeSentiment(content, client || {});
    const sentiment = sentimentResult.sentiment || 'Neutral';
    const sentimentScore = sentimentResult.score || 0;

    // Message schema normalized via createMessage
    const msg = await createMessage({
      clientId,
      conversationId: finalConvoId,
      phone,
      direction: 'inbound',
      type:      parsedMessage.type || 'text',
      body:      content,
      messageId: parsedMessage.messageId || '',
      channel:   channel, 
      rawData:   parsedMessage,
      sentiment,
      sentimentScore
    });

    // Update Conversation with sentiment and auto-escalation flags
    if (finalConvoId) {
      const isNegative = ['Frustrated', 'Urgent', 'Negative'].includes(sentiment);
      await Conversation.findByIdAndUpdate(finalConvoId, {
        $set: { 
          sentiment, 
          sentimentScore,
          requiresAttention: isNegative,
          attentionReason: isNegative ? `AI Detected: ${sentimentResult.summary || content.substring(0, 50)}` : ''
        }
      });

      // Notify agents for frustrated/urgent cases
      if (sentiment === 'Frustrated' || sentiment === 'Urgent') {
        NotificationService.createNotification(clientId, {
          type: 'alert',
          title: `${sentiment} Sentiment Detected 🚨`,
          message: `Customer ${phone} needs immediate attention. Summary: ${sentimentResult.summary || 'High priority alert.'}`,
          customerPhone: phone,
          priority: 'high'
        }).catch(err => log.error("Sentiment notification failed", err.message));
      }
    }
    // --- Phase 23: Track 6 CSAT Interceptor ---
    if (parsedMessage.interactive?.button_reply?.id?.startsWith('csat_')) {
      const { handleCSATResponse } = require('./csatService');
      const response = await handleCSATResponse(finalConvoId, parsedMessage.interactive.button_reply.id);
      if (response && channel === 'whatsapp') {
        const client = await Client.findOne({ clientId });
        const WhatsApp = require('./whatsapp');
        await WhatsApp.sendText(client, phone, response);
      }
    }

    // Phase 23: Track Metrics
    const updateFields = { 
      lastMessage: content.substring(0, 100), 
      lastMessageAt: new Date(),
      channel: channel 
    };

    // If this is the start of a new interaction cycle, set firstInboundAt
    const existingConvo = await Conversation.findOne({ phone, clientId });
    if (!existingConvo?.firstInboundAt || (Date.now() - existingConvo?.lastInteraction > 24 * 60 * 60 * 1000)) {
        updateFields.firstInboundAt = new Date();
        updateFields.firstResponseAt = null; // Reset response timer for new cycle
    }

    await Conversation.findOneAndUpdate(
      { phone, clientId },
      { $set: updateFields }
    );

    // Phase 23: Track Conversation Intelligence
    const client = await Client.findOne({ clientId });
    if (client) {
      analyzeConversationIntelligence(client, phone, existingConvo || { _id: finalConvoId });
    }

    if (io) io.to(`client_${clientId}`).emit('new_message', msg);
    return msg;
  } catch (err) {
    log.error('saveInboundMessage error:', { error: err.message });
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
    // Phase 23: Track FRT
    const updateFields = { 
      lastMessage: `Bot: ${content.substring(0, 90)}`, 
      lastMessageAt: new Date(),
      channel: channel || 'whatsapp'
    };

    if (convo && convo.firstInboundAt && !convo.firstResponseAt) {
        updateFields.firstResponseAt = new Date();
    }

    await Conversation.findOneAndUpdate(
      { phone, clientId },
      { $set: updateFields }
    );

    const io = global.io;
    if (io) io.to(`client_${clientId}`).emit('new_message', msg);

    // Phase 23: Track Conversation Intelligence (Sentiment/Summary)
    const client = await Client.findOne({ clientId });
    if (client) {
      const convo = await Conversation.findOne({ phone, clientId });
      if (convo) analyzeConversationIntelligence(client, phone, convo);
    }

    return msg;
  } catch (err) {
    log.error('saveOutboundMessage error:', { error: err.message });
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
    // 1. LIFETIME VISIT (stored on graph)
    const updatedNodes = incrementNodeVisit(client.flowNodes, nodeId);
    await Client.findByIdAndUpdate(client._id, { flowNodes: updatedNodes });

    // 2. DAILY ANALYTICS (Heatmap)
    const today = new Date().toISOString().split('T')[0];
    await DailyStat.findOneAndUpdate(
      { clientId: client.clientId, date: today },
      { $inc: { [`flowHeatmap.${nodeId}`]: 1 } },
      { upsert: true }
    );

    // 3. Emit real-time socket event to dashboard
    const io = global.io;
    if (io) io.to(`client_${client.clientId}`).emit('heatmap_update', { nodeId });
  } catch (err) {
    log.error('Heatmap tracking error:', { error: err.message });
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

async function checkIntent(userText, intentDescription, apiKey) {
  try {
    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(apiKey);
    const result = await model.generateContent(
      `Does this message express the intent: "${intentDescription}"?\nMessage: "${userText}"\nAnswer only YES or NO.`
    );
    const text = result.response.text().toUpperCase();
    return text.includes("YES");
  } catch (err) {
    log.error(`checkIntent Error:`, { error: err.message });
    return false;
  }
}

/**
 * PHASE 23: Track 6 - Conversation Intelligence
 * Analyzes sentiment and updates conversation summary in the background.
 */
async function analyzeConversationIntelligence(client, phone, convo) {
  try {
    const apiKey = client.geminiApiKey;
    if (!apiKey) return;

    // 1. Fetch last 10 messages to provide context
    const Message = require('../models/Message');
    const recentMessages = await Message.find({ 
      clientId: client.clientId, 
      $or: [{ from: phone }, { to: phone }] 
    })
    .sort({ timestamp: -1 })
    .limit(10);

    if (recentMessages.length < 2) return; // Not enough context yet

    const historyText = recentMessages.reverse().map(m => 
      `${m.direction === 'incoming' ? 'User' : 'Bot'}: ${m.content}`
    ).join('\n');

    const { getGeminiModel } = require('./gemini');
    const model = getGeminiModel(apiKey);
    
    const prompt = `
      Analyze the following chat history and provide two things in valid JSON format:
      1. "sentiment": One of "Positive", "Neutral", "Negative".
      2. "summary": A concise 1-sentence summary of the conversation status.

      Chat History:
      ${historyText}

      JSON Response:
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{.*\}/s);
    
    if (jsonMatch) {
      const { sentiment, summary } = JSON.parse(jsonMatch[0]);
      
      await Conversation.findByIdAndUpdate(convo._id, {
        sentiment: sentiment || 'Neutral',
        summary: summary || convo.summary,
        lastSummaryUpdate: new Date()
      });

      // Emit update to dashboard
      const io = global.io;
      if (io) {
        io.to(`client_${client.clientId}`).emit('conversation_intelligence_update', {
          phone,
          sentiment,
          summary
        });
      }
      
      log.info(`${phone} -> ${sentiment} | ${summary}`);
    }
  } catch (err) {
    log.error('Intelligence Error:', { error: err.message });
  }
}

module.exports = { 
    handleWhatsAppMessage,
    runDualBrainEngine,
    runFlow,
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
    replaceVariables,
    analyzeConversationIntelligence
};
