"use strict";

/**
 * TRIGGER ENGINE — Phase 20
 * Matches an incoming message to the correct flow based on trigger configuration.
 * Priority: Keyword triggers > First Message triggers > Legacy flow
 */

const WhatsAppFlow = require("../models/WhatsAppFlow");

/**
 * Given an incoming message and a client's flows array,
 * returns which flow (if any) should be activated.
 */
async function findMatchingFlow(parsedMessage, client, convo) {
  const text    = (parsedMessage.text?.body || "").trim();
  const channel = parsedMessage.channel || "whatsapp";

  // ── NEW ARCHITECTURE: Check WhatsAppFlow collection first ──────────────────
  let flows = await WhatsAppFlow.find({ clientId: client.clientId, status: 'PUBLISHED' }).lean();

  // Fallback to client.visualFlows for non-migrated clients
  if (flows.length === 0 && client.visualFlows?.length > 0) {
    flows = client.visualFlows;
  }

  // ── PRIORITY 1: Check keyword triggers ─────────────────────────────────────
  const keywordFlow = flows.find((flow) => {
    const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
    if (!trigger || (trigger.type !== "keyword" && trigger.type !== "KEYWORD")) return false;

    // Channel check
    const flowChannel = (trigger.channel || flow.channel || "both").toLowerCase();
    if (flowChannel !== "both" && flowChannel !== channel) return false;

    const keywords  = trigger.keywords || [];
    const matchMode = trigger.matchMode || "contains";

    return keywords.some((keyword) => checkKeywordMatch(text, keyword, matchMode));
  });

  if (keywordFlow) {
    return { flow: keywordFlow, triggerType: "keyword" };
  }

  // ── PRIORITY 1.2: Check Meta Ad triggers ───────────────────────────────────
  if (parsedMessage.referral && parsedMessage.referral.source_id) {
    const adId = parsedMessage.referral.source_id;
    const adFlow = flows.find(flow => {
       const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
       if (!trigger || (trigger.type !== "meta_ad" && trigger.type !== "META_AD")) return false;
       return trigger.adId === adId || trigger.adId === "any";
    });
    if (adFlow) return { flow: adFlow, triggerType: "meta_ad" };
  }

  // ── PRIORITY 1.5: Check event triggers (e.g. story_mention) ────────────────
  if (parsedMessage.event === "story_mention") {
    const eventFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
      return trigger?.type === "story_mention" || trigger?.type === "STORY_MENTION";
    });
    if (eventFlow) return { flow: eventFlow, triggerType: "story_mention" };
  }

  // ── PRIORITY 2: Check first_message triggers ────────────────────────────────
  const isNewConversation = !convo
    || !convo.lastStepId
    || !convo.lastMessageAt
    || convo.status === "new"
    || (convo.lastStepId === null || convo.lastStepId === "");

  if (isNewConversation) {
    const welcomeFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
      if (!trigger || (trigger.type !== "first_message" && trigger.type !== "FIRST_MESSAGE")) return false;

      const flowChannel = (trigger.channel || flow.channel || "both").toLowerCase();
      return flowChannel === "both" || flowChannel === channel;
    });

    if (welcomeFlow) {
      return { flow: welcomeFlow, triggerType: "first_message" };
    }

    // legacy fallback
    if (client.flowNodes?.length > 0) {
      return {
        flow: { nodes: client.flowNodes, edges: client.flowEdges, isLegacy: true },
        triggerType: "first_message",
        isLegacy: true,
      };
    }
  }

  return null;
}

/**
 * NEW: Match an event (Orders, Cart) to a flow.
 * Used by webhooks (Shopify/WooCommerce).
 */
async function matchEventTrigger(eventName, eventData, client) {
  const flows = await WhatsAppFlow.find({ 
    clientId: client.clientId, 
    status: 'PUBLISHED',
    'triggerConfig.type': 'EVENT',
    'triggerConfig.event': eventName
  }).lean();

  if (flows.length === 0) return null;

  // 1. Check SKU-specific matches first if event involves products (order, cart)
  const items = eventData.line_items || eventData.items || [];
  if (items.length > 0) {
    const skuMatches = flows.filter(f => f.triggerConfig.skuMatches?.length > 0);
    for (const flow of skuMatches) {
      const hasMatch = items.some(item => flow.triggerConfig.skuMatches.includes(item.sku));
      if (hasMatch) return flow;
    }
  }

  // 2. Return the first matching general event flow
  return flows.find(f => !f.triggerConfig.skuMatches || f.triggerConfig.skuMatches.length === 0);
}

/**
 * Extract trigger configuration from the TriggerNode inside a flow's nodes array.
 */
function getTriggerFromNodes(nodes) {
  if (!Array.isArray(nodes)) return null;
  const triggerNode = nodes.find(
    (n) => n.type === "TriggerNode" || n.type === "trigger"
  );
  if (!triggerNode) return null;

  const d = triggerNode.data || {};

  if (d.trigger) return d.trigger;

  // Legacy format
  const legacyKeyword = d.keyword || d.keywords || "";
  
  const type = d.triggerType === "first_message" ? "first_message" : 
               (d.triggerType === "story_mention" ? "story_mention" : 
               (d.triggerType === "meta_ad" ? "meta_ad" : "keyword"));

  if (type === "first_message") {
    return { type: "first_message", channel: d.channel || "both" };
  }

  if (type === "story_mention") {
    return { type: "story_mention", channel: d.channel || "instagram" };
  }

  if (type === "meta_ad") {
    return { type: "meta_ad", adId: d.adId || "any", channel: d.channel || "both" };
  }

  const keywords = legacyKeyword.split(",").map((k) => k.trim()).filter(Boolean);

  return {
    type:      "keyword",
    keywords,
    matchMode: d.matchType || d.matchMode || "contains",
    channel:   d.channel || "both",
  };
}

function checkKeywordMatch(text, keyword, matchMode = "contains") {
  if (!text || !keyword) return false;
  const trimmedKeyword = keyword.trim();
  if (!trimmedKeyword) return false;

  switch (matchMode) {
    case "exact":
      return text.toLowerCase() === trimmedKeyword.toLowerCase();
    case "contains_case_sensitive":
      return text.includes(trimmedKeyword);
    case "contains":
    default:
      return text.toLowerCase().includes(trimmedKeyword.toLowerCase());
  }
}

function findFlowStartNode(flowNodes, flowEdges) {
  if (!flowNodes || !flowNodes.length) return null;
  const triggerNode = flowNodes.find((n) => n.type === "TriggerNode" || n.type === "trigger");

  if (triggerNode) {
    const firstEdge = (flowEdges || []).find((e) => e.source === triggerNode.id);
    if (firstEdge?.target) return firstEdge.target;
  }

  const startNode = flowNodes.find((n) => n.type !== "folder" && n.type !== "group" && n.type !== "sticky");
  return startNode?.id || null;
}

module.exports = { findMatchingFlow, checkKeywordMatch, getTriggerFromNodes, findFlowStartNode, matchEventTrigger };
