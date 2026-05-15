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

  // Shopify / wizard automations must never steal keyword or first_message routing.
  flows = flows.filter((f) => !f.isAutomation);

  // Helper: extract nodes from a flow, preferring publishedNodes over draft nodes
  const getFlowNodes = (flow) => flow.publishedNodes?.length > 0 ? flow.publishedNodes : (flow.nodes || []);
  const getFlowEdges = (flow) => flow.publishedEdges?.length > 0 ? flow.publishedEdges : (flow.edges || []);

  // ── PRIORITY 1: Check keyword triggers (all trigger nodes in each flow) ───
  let keywordHit = null;
  for (const flow of flows) {
    const nodes = getFlowNodes(flow);
    const edges = getFlowEdges(flow);
    const entry = findKeywordTriggerEntry(text, nodes, edges, channel);
    if (entry?.startNodeId) {
      keywordHit = { flow, triggerType: "keyword", startNodeId: entry.startNodeId, triggerNodeId: entry.triggerNodeId };
      break;
    }
  }

  // Legacy: flow-level triggerConfig only (single trigger blob)
  if (!keywordHit) {
    const keywordFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
      if (!trigger || (trigger.type !== "keyword" && trigger.type !== "KEYWORD")) return false;

      const flowChannel = (trigger.channel || flow.channel || "both").toLowerCase();
      if (flowChannel !== "both" && flowChannel !== channel) return false;

      const keywords = trigger.keywords || [];
      const matchMode = trigger.matchMode || "contains";
      return keywords.some((keyword) => checkKeywordMatch(text, keyword, matchMode));
    });
    if (keywordFlow) {
      const nodes = getFlowNodes(keywordFlow);
      const edges = getFlowEdges(keywordFlow);
      keywordHit = {
        flow: keywordFlow,
        triggerType: "keyword",
        startNodeId: findFlowStartNode(nodes, edges),
      };
    }
  }

  if (keywordHit) {
    return keywordHit;
  }

  // ── PRIORITY 1.2: Check Meta Ad triggers ───────────────────────────────────
  if (parsedMessage.referral && parsedMessage.referral.source_id) {
    const adId = parsedMessage.referral.source_id;
    const adFlow = flows.find(flow => {
       const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
       if (!trigger || (trigger.type !== "meta_ad" && trigger.type !== "META_AD")) return false;
       return trigger.adId === adId || trigger.adId === "any";
    });
    if (adFlow) return { flow: adFlow, triggerType: "meta_ad" };
  }

  // ── PRIORITY 1.5: Check event triggers (story_mention, intent_match) ─────────
  if (parsedMessage.event === "story_mention") {
    const eventFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
      return trigger?.type === "story_mention" || trigger?.type === "STORY_MENTION";
    });
    if (eventFlow) return { flow: eventFlow, triggerType: "story_mention" };
  }

  // ── PRIORITY 1.6: Check AI intent_match triggers ────────────────────────────
  // Wrapped in try/catch — if NLP engine times out or crashes, skip gracefully
  if (parsedMessage.detectedIntentId) {
    try {
      const intentFlow = flows.find((flow) => {
        const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
        if (!trigger || trigger.type !== "intent_match") return false;
        // If intentId is blank on the node → matches any detected intent
        return !trigger.intentId || trigger.intentId === parsedMessage.detectedIntentId;
      });
      if (intentFlow) return { flow: intentFlow, triggerType: "intent_match" };
    } catch (intentErr) {
      console.warn(`[TriggerEngine] Intent match skipped (NLP error): ${intentErr.message}`);
      // Fall through to next priority tier
    }
  }

  // ── PRIORITY 2: Check first_message triggers ────────────────────────────────
  const isNewConversation = !convo
    || !convo.lastStepId
    || !convo.lastMessageAt
    || convo.status === "new"
    || (convo.lastStepId === null || convo.lastStepId === "");

  if (isNewConversation) {
    const welcomeFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
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

// Helper to get nodes from a flow preferring publishedNodes
function _getFlowNodes(flow) {
  return flow.publishedNodes?.length > 0 ? flow.publishedNodes : (flow.nodes || []);
}
function _getFlowEdges(flow) {
  return flow.publishedEdges?.length > 0 ? flow.publishedEdges : (flow.edges || []);
}

const COMMERCE_TRIGGER_TYPES = [
  "order_placed",
  "order_fulfilled",
  "order_status_changed",
  "abandoned_cart",
  "payment_received",
];

/**
 * Normalised trigger config from a single flow-canvas trigger node.
 */
function getTriggerConfigFromNode(node) {
  if (!node) return null;
  if (
    node.type !== "trigger" &&
    node.type !== "TriggerNode" &&
    node.type !== "intent_trigger" &&
    node.type !== "IntentTriggerNode"
  ) {
    return null;
  }

  const d = node.data || {};

  if (d.trigger && d.trigger.type) return d.trigger;

  const rawType = (d.triggerType || "keyword").toLowerCase();

  if (rawType === "shopify_event") {
    const eventMap = {
      order_created: "order_placed",
      checkout_abandoned: "abandoned_cart",
      order_fulfilled: "order_fulfilled",
    };
    const mapped = eventMap[String(d.event || "").toLowerCase()];
    if (mapped) {
      return {
        type: mapped,
        orderStatus: d.orderStatus || "any",
        cartDelayMinutes: d.cartDelayMinutes || 15,
        skuMatches: d.skuMatches || [],
      };
    }
  }

  if (COMMERCE_TRIGGER_TYPES.includes(rawType)) {
    return {
      type: rawType,
      orderStatus: d.orderStatus || "any",
      cartDelayMinutes: d.cartDelayMinutes || 15,
      skuMatches: d.skuMatches || [],
    };
  }

  if (rawType === "first_message") {
    return { type: "first_message", channel: d.channel || "both" };
  }

  if (rawType === "story_mention") {
    return { type: "story_mention", channel: d.channel || "instagram" };
  }

  if (rawType === "meta_ad") {
    return { type: "meta_ad", adId: d.adId || "any", channel: d.channel || "both" };
  }

  if (rawType === "intent_match") {
    return { type: "intent_match", intentId: d.intentId || "", channel: d.channel || "both" };
  }

  const legacyKeyword = d.keyword || d.keywords || "";
  const keywords = Array.isArray(d.keywords)
    ? d.keywords
    : legacyKeyword.split(",").map((k) => k.trim()).filter(Boolean);

  return {
    type: "keyword",
    keywords,
    matchMode: d.matchType || d.matchMode || "contains",
    channel: d.channel || "both",
  };
}

function commerceTriggerMatchesEvent(trigger, eventNameNorm, status) {
  if (!trigger) return false;
  const tType = (trigger.type || "").toLowerCase();
  if (tType !== eventNameNorm) return false;
  if (eventNameNorm === "order_status_changed" && status) {
    const cfgStatus = trigger.orderStatus || "any";
    if (cfgStatus !== "any" && cfgStatus !== String(status).toLowerCase()) return false;
  }
  return true;
}

function skuMatchesItems(trigger, items) {
  const list = trigger?.skuMatches;
  if (!list || list.length === 0) return true;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.some((item) => list.includes(item.sku));
}

/**
 * Scan all trigger nodes in all published flows for a commerce event (multi-trigger / unified flow).
 */
async function findCommerceFlowAndEntry(eventName, eventData, client, status = null) {
  const ev = String(eventName || "").toLowerCase();
  const cacheKey = `flows_${client.clientId}`;
  let flows = triggerCache.get(cacheKey);

  if (!flows) {
    flows = await WhatsAppFlow.find({
      clientId: client.clientId,
      status: "PUBLISHED",
    }).lean();
    triggerCache.set(cacheKey, flows);
  }

  const items = eventData.line_items || eventData.items || [];
  const candidates = [];

  for (const flow of flows) {
    for (const n of _getFlowNodes(flow)) {
      const cfg = getTriggerConfigFromNode(n);
      if (!cfg) continue;
      const tType = (cfg.type || "").toLowerCase();
      if (!COMMERCE_TRIGGER_TYPES.includes(tType)) continue;
      if (!commerceTriggerMatchesEvent(cfg, ev, status)) continue;
      if (!skuMatchesItems(cfg, items)) continue;
      candidates.push({
        flow,
        entryTriggerNodeId: n.id,
        skuSpecific: !!(cfg.skuMatches && cfg.skuMatches.length),
      });
    }
  }

  const pool = candidates.filter((c) => c.flow?.isAutomation === true).length
    ? candidates.filter((c) => c.flow?.isAutomation === true)
    : candidates;

  const skuHits = pool.filter((c) => c.skuSpecific);
  if (skuHits.length) return skuHits[0];
  const general = pool.filter((c) => !c.skuSpecific);
  return general[0] || null;
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
  const hit = await findCommerceFlowAndEntry(eventName, eventData, client, status);
  if (hit) return hit.flow;

  const ev = String(eventName || "").toLowerCase();
  const cacheKey = `flows_${client.clientId}`;
  let flows = triggerCache.get(cacheKey);

  if (!flows) {
    flows = await WhatsAppFlow.find({
      clientId: client.clientId,
      status: "PUBLISHED",
    }).lean();
    triggerCache.set(cacheKey, flows);
  }

  const matching = flows.filter((flow) => {
    const trigger =
      flow.triggerConfig || flow.trigger || getTriggerFromNodes(_getFlowNodes(flow));
    if (!trigger) return false;

    const tType = (trigger.type || "").toLowerCase();

    if (tType !== ev) return false;

    if (ev === "order_status_changed" && status) {
      const cfgStatus = trigger.orderStatus || "any";
      if (cfgStatus !== "any" && cfgStatus !== String(status).toLowerCase()) return false;
    }

    return true;
  });

  if (matching.length === 0) return null;

  const items = eventData.line_items || eventData.items || [];
  if (items.length > 0) {
    for (const flow of matching) {
      const trigger =
        flow.triggerConfig || flow.trigger || getTriggerFromNodes(_getFlowNodes(flow));
      if (trigger?.skuMatches?.length > 0) {
        const hasMatch = items.some((item) => trigger.skuMatches.includes(item.sku));
        if (hasMatch) return flow;
      }
    }
  }

  return (
    matching.find((f) => {
      const trigger =
        f.triggerConfig || f.trigger || getTriggerFromNodes(_getFlowNodes(f));
      return !trigger?.skuMatches || trigger.skuMatches.length === 0;
    }) || matching[0]
  );
}

/**
 * Convenience wrapper that finds AND returns start node ID for a commerce event flow.
 * Returns null if no flow matches.
 */
async function findEventTriggeredFlow(eventName, eventData, client, status = null) {
  const hit = await findCommerceFlowAndEntry(eventName, eventData, client, status);
  if (hit) {
    const edges = _getFlowEdges(hit.flow);
    const firstEdge = edges.find((e) => e.source === hit.entryTriggerNodeId);
    const startNodeId = firstEdge?.target || null;
    return { flow: hit.flow, startNodeId };
  }

  const flow = await matchEventTrigger(eventName, eventData, client, status);
  if (!flow) return null;
  const nodes = _getFlowNodes(flow);
  const edges = _getFlowEdges(flow);
  const startNodeId = findFlowStartNode(nodes, edges);
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
  return getTriggerConfigFromNode(triggerNode);
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

/**
 * Match incoming text against every keyword trigger node in a flow.
 * Longest keyword wins (e.g. "track my order" beats "order").
 */
function findKeywordTriggerEntry(text, nodes, edges, channel = "whatsapp") {
  if (!text || !Array.isArray(nodes)) return null;

  const triggerNodes = nodes.filter((n) => n.type === "trigger" || n.type === "TriggerNode");
  let best = null;
  let bestLen = 0;

  for (const node of triggerNodes) {
    const cfg = getTriggerConfigFromNode(node);
    if (!cfg || (cfg.type !== "keyword" && cfg.type !== "KEYWORD")) continue;

    const flowChannel = (cfg.channel || "both").toLowerCase();
    if (flowChannel !== "both" && flowChannel !== channel) continue;

    const keywords = cfg.keywords || [];
    const matchMode = cfg.matchMode || "contains";

    for (const kw of keywords) {
      if (!checkKeywordMatch(text, kw, matchMode)) continue;
      const len = String(kw).trim().length;
      if (len >= bestLen) {
        const edge = (edges || []).find((e) => e.source === node.id);
        bestLen = len;
        best = {
          triggerNodeId: node.id,
          startNodeId: edge?.target || null,
        };
      }
    }
  }

  return best;
}

function findFlowStartNode(flowNodes, flowEdges) {
  // Accept either raw arrays or use publishedNodes when available
  const nodes = Array.isArray(flowNodes) ? flowNodes : [];
  const edges = Array.isArray(flowEdges) ? flowEdges : [];
  if (!nodes.length) return null;
  const triggerNode = nodes.find((n) => n.type === "TriggerNode" || n.type === "trigger");

  if (triggerNode) {
    const firstEdge = edges.find((e) => e.source === triggerNode.id);
    if (firstEdge?.target) return firstEdge.target;
  }

  const startNode = nodes.find((n) => n.type !== "folder" && n.type !== "group" && n.type !== "sticky");
  return startNode?.id || null;
}

function clearTriggerCache(clientId) {
  triggerCache.del(`flows_${clientId}`);
}

module.exports = {
  findMatchingFlow,
  findKeywordTriggerEntry,
  checkKeywordMatch,
  getTriggerFromNodes,
  getTriggerConfigFromNode,
  findFlowStartNode,
  matchEventTrigger,
  findEventTriggeredFlow,
  clearTriggerCache,
};
