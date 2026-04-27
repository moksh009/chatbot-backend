"use strict";

/**
 * TRIGGER ENGINE — Enterprise Edition
 *
 * Matches an incoming message or commerce event to the correct published flow.
 *
 * Priority order for message triggers:
 *   1. keyword / intent_match  (most specific)
 *   2. meta_ad / story_mention (channel-specific)
 *   3. first_message           (catch-all for new contacts)
 *   4. legacy client.flowNodes (backward compat)
 *
 * Commerce event triggers (order_placed, order_fulfilled, etc.) are handled
 * via matchEventTrigger() — called directly by webhook handlers.
 */

const WhatsAppFlow = require("../models/WhatsAppFlow");
const NodeCache = require('node-cache');
const triggerCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

/**
 * Given an incoming message and a client's flows array,
 * returns which flow (if any) should be activated.
 */
async function findMatchingFlow(parsedMessage, client, convo) {
  const text    = (parsedMessage.text?.body || "").trim();
  const channel = parsedMessage.channel || "whatsapp";

  const cacheKey = `flows_${client.clientId}`;
  let flows = triggerCache.get(cacheKey);

  if (!flows) {
    // ── NEW ARCHITECTURE: Check WhatsAppFlow collection first ──────────────────
    flows = await WhatsAppFlow.find({ clientId: client.clientId, status: 'PUBLISHED' }).lean();

    // Fallback to client.visualFlows for non-migrated clients
    if (flows.length === 0 && client.visualFlows?.length > 0) {
      flows = client.visualFlows;
    }
    triggerCache.set(cacheKey, flows);
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

  // ── PRIORITY 1.5: Check event triggers (story_mention, intent_match) ─────────
  if (parsedMessage.event === "story_mention") {
    const eventFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
      return trigger?.type === "story_mention" || trigger?.type === "STORY_MENTION";
    });
    if (eventFlow) return { flow: eventFlow, triggerType: "story_mention" };
  }

  // ── PRIORITY 1.6: Check AI intent_match triggers ────────────────────────────
  if (parsedMessage.detectedIntentId) {
    const intentFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
      if (!trigger || trigger.type !== "intent_match") return false;
      // If intentId is blank on the node → matches any detected intent
      return !trigger.intentId || trigger.intentId === parsedMessage.detectedIntentId;
    });
    if (intentFlow) return { flow: intentFlow, triggerType: "intent_match" };
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
 * Match a commerce event (order_placed, order_fulfilled, abandoned_cart, etc.) to a flow.
 * Called directly by shopifyWebhook.js and razorpay webhook handlers.
 *
 * @param {string} eventName  - 'order_placed' | 'order_fulfilled' | 'order_status_changed' | 'abandoned_cart' | 'payment_received'
 * @param {object} eventData  - Raw webhook payload
 * @param {object} client     - Mongoose client doc
 * @param {string} [status]   - For 'order_status_changed' — the new status string
 */
async function matchEventTrigger(eventName, eventData, client, status = null) {
  const cacheKey = `flows_${client.clientId}`;
  let flows = triggerCache.get(cacheKey);

  if (!flows) {
    flows = await WhatsAppFlow.find({
      clientId: client.clientId,
      status: 'PUBLISHED'
    }).lean();
    triggerCache.set(cacheKey, flows);
  }

  const matching = flows.filter(flow => {
    const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
    if (!trigger) return false;

    const tType = (trigger.type || '').toLowerCase();

    if (tType !== eventName && tType !== eventName.toUpperCase()) return false;

    // For order_status_changed: also check if configured status matches
    if (eventName === 'order_status_changed' && status) {
      const cfgStatus = trigger.orderStatus || 'any';
      if (cfgStatus !== 'any' && cfgStatus !== status.toLowerCase()) return false;
    }

    return true;
  });

  if (matching.length === 0) return null;

  // SKU-level matching for order events
  const items = eventData.line_items || eventData.items || [];
  if (items.length > 0) {
    for (const flow of matching) {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(flow.nodes || []);
      if (trigger?.skuMatches?.length > 0) {
        const hasMatch = items.some(item => trigger.skuMatches.includes(item.sku));
        if (hasMatch) return flow;
      }
    }
  }

  // Return first general match (no SKU filter)
  return matching.find(f => {
    const trigger = f.triggerConfig || f.trigger || getTriggerFromNodes(f.nodes || []);
    return !trigger?.skuMatches || trigger.skuMatches.length === 0;
  }) || matching[0];
}

/**
 * Convenience wrapper that finds AND returns start node ID for a commerce event flow.
 * Returns null if no flow matches.
 */
async function findEventTriggeredFlow(eventName, eventData, client, status = null) {
  const flow = await matchEventTrigger(eventName, eventData, client, status);
  if (!flow) return null;
  const startNodeId = findFlowStartNode(flow.nodes || [], flow.edges || []);
  return { flow, startNodeId };
}

/**
 * Extract a normalised trigger configuration object from a flow's trigger node.
 * Handles both the new data.trigger shape and legacy flat data fields.
 */
function getTriggerFromNodes(nodes) {
  if (!Array.isArray(nodes)) return null;

  const triggerNode = nodes.find(
    (n) => n.type === 'trigger' || n.type === 'TriggerNode' ||
           n.type === 'intent_trigger' || n.type === 'IntentTriggerNode'
  );
  if (!triggerNode) return null;

  const d = triggerNode.data || {};

  // ── New canonical format: data.trigger = { type, ... } ──────────────────────
  if (d.trigger && d.trigger.type) return d.trigger;

  // ── Legacy flat fields ───────────────────────────────────────────────────────
  const rawType = (d.triggerType || 'keyword').toLowerCase();

  // Backward compatibility: old generator used triggerType=shopify_event + data.event.
  if (rawType === 'shopify_event') {
    const eventMap = {
      order_created: 'order_placed',
      checkout_abandoned: 'abandoned_cart',
      order_fulfilled: 'order_fulfilled'
    };
    const mapped = eventMap[String(d.event || '').toLowerCase()];
    if (mapped) {
      return {
        type: mapped,
        orderStatus: d.orderStatus || 'any',
        cartDelayMinutes: d.cartDelayMinutes || 15,
        skuMatches: d.skuMatches || []
      };
    }
  }

  // Commerce event types (pass-through)
  const commerceTypes = ['order_placed', 'order_fulfilled', 'order_status_changed', 'abandoned_cart', 'payment_received'];
  if (commerceTypes.includes(rawType)) {
    return {
      type: rawType,
      orderStatus: d.orderStatus || 'any',
      cartDelayMinutes: d.cartDelayMinutes || 15,
      skuMatches: d.skuMatches || []
    };
  }

  if (rawType === 'first_message') {
    return { type: 'first_message', channel: d.channel || 'both' };
  }

  if (rawType === 'story_mention') {
    return { type: 'story_mention', channel: d.channel || 'instagram' };
  }

  if (rawType === 'meta_ad') {
    return { type: 'meta_ad', adId: d.adId || 'any', channel: d.channel || 'both' };
  }

  if (rawType === 'intent_match') {
    return { type: 'intent_match', intentId: d.intentId || '', channel: d.channel || 'both' };
  }

  // Default: keyword
  const legacyKeyword = d.keyword || d.keywords || '';
  const keywords = Array.isArray(d.keywords)
    ? d.keywords
    : legacyKeyword.split(',').map(k => k.trim()).filter(Boolean);

  return {
    type:      'keyword',
    keywords,
    matchMode: d.matchType || d.matchMode || 'contains',
    channel:   d.channel || 'both',
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

function clearTriggerCache(clientId) {
  triggerCache.del(`flows_${clientId}`);
}

module.exports = {
  findMatchingFlow,
  checkKeywordMatch,
  getTriggerFromNodes,
  findFlowStartNode,
  matchEventTrigger,
  findEventTriggeredFlow,
  clearTriggerCache
};
