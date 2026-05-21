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
const NodeCache = require("node-cache");
const { invalidateFlowGraphCache, invalidateTriggerListCache } = require("./flowGraphCache");
const { getAppRedis } = require("./redisFactory");
const { createTimer } = require("./perfLogger");
const triggerCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min L1
const TRIGGER_CACHE_TTL_SEC = 300;
const TRIGGER_REDIS_KEY_PREFIX = "triggers:v2:";

const FLOW_SELECT =
  "flowId name status triggerConfig publishedNodes publishedEdges nodes edges isAutomation platform channel";

const TRIGGER_NODE_TYPES = new Set([
  "trigger",
  "TriggerNode",
  "intent_trigger",
  "IntentTriggerNode",
]);

/** Slim routing index — trigger nodes + edges only (no 100+ node blobs in Redis). */
function buildSlimRoutingBundles(flows) {
  return (flows || []).map((flow) => {
    const pubNodes =
      flow.publishedNodes?.length > 0 ? flow.publishedNodes : flow.nodes || [];
    const pubEdges =
      flow.publishedEdges?.length > 0 ? flow.publishedEdges : flow.edges || [];
    const triggerNodes = pubNodes.filter((n) => TRIGGER_NODE_TYPES.has(n.type));
    const triggerIds = new Set(triggerNodes.map((n) => n.id));
    const routingEdges = pubEdges.filter((e) => triggerIds.has(e.source));
    return {
      _id: flow._id,
      flowId: flow.flowId,
      id: flow.flowId || flow.id,
      name: flow.name,
      status: flow.status,
      triggerConfig: flow.triggerConfig,
      channel: flow.channel,
      isAutomation: flow.isAutomation,
      triggerNodes,
      routingEdges,
    };
  });
}

async function loadSlimFlowsForClient(client) {
  const timer = createTimer("TriggerEngine.loadSlimFlowsForClient", client.clientId);
  const cacheKey = `flows_${client.clientId}`;
  let flows = triggerCache.get(cacheKey);
  if (flows?.[0]?.publishedNodes?.length > 0) {
    triggerCache.del(cacheKey);
    flows = null;
  }
  if (flows) {
    timer.checkpoint("L1 trigger cache HIT", { count: flows.length });
    timer.finish("l1_hit");
    return flows;
  }
  timer.checkpoint("L1 trigger cache MISS");

  if (!flows) {
    const redis = getAppRedis();
    const redisKey = `${TRIGGER_REDIS_KEY_PREFIX}${client.clientId}`;
    if (redis && redis.status === "ready") {
      try {
        const raw = await timer.time("Redis GET triggers:v2", () => redis.get(redisKey));
        if (raw) {
          flows = JSON.parse(raw);
          if (flows?.[0]?.publishedNodes?.length > 0) {
            flows = null;
            timer.log("Redis payload had full publishedNodes — invalidating");
          } else {
            triggerCache.set(cacheKey, flows);
            timer.checkpoint("Redis trigger cache HIT", { count: flows?.length });
            timer.finish("redis_hit");
            return flows;
          }
        } else {
          timer.checkpoint("Redis trigger cache MISS");
        }
      } catch (err) {
        timer.log(`Redis read failed: ${err.message}`);
      }
    } else {
      timer.log("Redis not available");
    }
  }

  if (!flows) {
    const { loadRoutingIndexForClient } = require("./flowGraphResolver");
    const { bundles } = await timer.time("loadRoutingIndexForClient", () =>
      loadRoutingIndexForClient(client.clientId)
    );
    flows = bundles;

    timer.checkpoint("buildSlimRoutingBundles done", { count: flows?.length });

    triggerCache.set(cacheKey, flows);
    const redis = getAppRedis();
    if (redis && redis.status === "ready") {
      await timer.time("Redis SET triggers:v2", () =>
        redis.setex(
          `${TRIGGER_REDIS_KEY_PREFIX}${client.clientId}`,
          TRIGGER_CACHE_TTL_SEC,
          JSON.stringify(flows)
        )
      ).catch(() => {});
    }
    timer.finish("mongodb_load");
    return flows;
  }

  timer.finish("done");
  return flows;
}

const GREETING_WORDS = new Set([
  "hi",
  "hello",
  "hey",
  "hola",
  "namaste",
  "greetings",
  "start",
  "menu",
]);

function isGreetingLikeText(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return false;
  if (GREETING_WORDS.has(raw)) return true;
  const first = raw.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, "") || "";
  return GREETING_WORDS.has(first);
}

/**
 * Given an incoming message and a client's flows array,
 * returns which flow (if any) should be activated.
 */
async function findMatchingFlow(parsedMessage, client, convo) {
  const timer = createTimer("TriggerEngine.findMatchingFlow", client.clientId);
  const text    = (parsedMessage.text?.body || "").trim();
  const channel = parsedMessage.channel || "whatsapp";
  timer.checkpoint("params parsed", {
    textLen: text.length,
    channel,
    hasReferral: !!parsedMessage.referral,
  });

  let flows = await loadSlimFlowsForClient(client);
  timer.checkpoint("flows loaded", { count: flows?.length });

  // Shopify / wizard automations must never steal keyword or first_message routing.
  flows = flows.filter((f) => !f.isAutomation);

  const getFlowNodes = (flow) => flow.triggerNodes || [];
  const getFlowEdges = (flow) => flow.routingEdges || [];

  // ── PRIORITY 1: Check keyword triggers (trigger nodes only — not full 100+ node scan) ───
  let keywordHit = null;
  for (const flow of flows) {
    const nodes =
      flow.triggerNodes?.length > 0 ? flow.triggerNodes : getFlowNodes(flow);
    const edges = getFlowEdges(flow);
    const entry = findKeywordTriggerEntry(text, nodes, edges, channel);
    if (entry?.startNodeId) {
      keywordHit = {
        flow,
        flowId: flow.flowId || String(flow._id),
        triggerType: "keyword",
        startNodeId: entry.startNodeId,
        triggerNodeId: entry.triggerNodeId,
      };
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
        flowId: keywordFlow.flowId || String(keywordFlow._id),
        triggerType: "keyword",
        startNodeId: findFlowStartNode(nodes, edges),
      };
    }
  }

  if (keywordHit) {
    timer.checkpoint("trigger matched: keyword", { flowId: keywordHit.flowId });
    timer.finish("keyword_match");
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
    if (adFlow) {
      timer.finish("meta_ad_match");
      return { flow: adFlow, triggerType: "meta_ad" };
    }
  }

  // ── PRIORITY 1.5: Check event triggers (story_mention, intent_match) ─────────
  if (parsedMessage.event === "story_mention") {
    const eventFlow = flows.find((flow) => {
      const trigger = flow.triggerConfig || flow.trigger || getTriggerFromNodes(getFlowNodes(flow));
      return trigger?.type === "story_mention" || trigger?.type === "STORY_MENTION";
    });
    if (eventFlow) {
      timer.finish("story_mention_match");
      return { flow: eventFlow, triggerType: "story_mention" };
    }
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
      if (intentFlow) {
        timer.finish("intent_match");
        return { flow: intentFlow, triggerType: "intent_match" };
      }
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
      const nodes = getFlowNodes(welcomeFlow);
      const edges = getFlowEdges(welcomeFlow);
      timer.finish("first_message_match");
      return {
        flow: welcomeFlow,
        triggerType: "first_message",
        startNodeId: findFlowStartNode(nodes, edges),
        flowId: welcomeFlow.flowId || String(welcomeFlow._id),
      };
    }

    // legacy fallback
    if (client.flowNodes?.length > 0) {
      timer.finish("first_message_legacy");
      return {
        flow: { nodes: client.flowNodes, edges: client.flowEdges, isLegacy: true },
        triggerType: "first_message",
        startNodeId: findFlowStartNode(client.flowNodes, client.flowEdges || []),
        isLegacy: true,
      };
    }
  }

  timer.log("no trigger matched");
  timer.finish("no_match");
  return null;
}

/**
 * Fast greeting routing — slim trigger index only; caller loads full graph via loadPublishedFlowByRef.
 */
async function findGreetingFlowFast(client, convo, text, channel = "whatsapp") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  let flows = await loadSlimFlowsForClient(client);
  flows = flows.filter((f) => !f.isAutomation);

  for (const flow of flows) {
    const entry = findKeywordTriggerEntry(
      trimmed,
      flow.triggerNodes || [],
      flow.routingEdges || [],
      channel
    );
    if (entry?.startNodeId) {
      return {
        flowId: flow.flowId || String(flow._id),
        startNodeId: entry.startNodeId,
        triggerType: "keyword",
        triggerNodeId: entry.triggerNodeId,
      };
    }
  }

  if (!isGreetingLikeText(trimmed)) return null;

  const isNewConversation =
    !convo ||
    !convo.lastStepId ||
    !convo.lastMessageAt ||
    convo.status === "new" ||
    convo.lastStepId === null ||
    convo.lastStepId === "";

  if (!isNewConversation) return null;

  for (const flow of flows) {
    const trigger =
      flow.triggerConfig || getTriggerFromNodes(flow.triggerNodes || []);
    if (!trigger || (trigger.type !== "first_message" && trigger.type !== "FIRST_MESSAGE")) {
      continue;
    }
    const flowChannel = (trigger.channel || flow.channel || "both").toLowerCase();
    if (flowChannel !== "both" && flowChannel !== channel) continue;

    const startNodeId = findFlowStartNode(
      flow.triggerNodes || [],
      flow.routingEdges || []
    );
    if (startNodeId) {
      return {
        flowId: flow.flowId || String(flow._id),
        startNodeId,
        triggerType: "first_message",
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

  let keywords = [];
  if (Array.isArray(d.keywords)) {
    keywords = d.keywords.map((k) => String(k).trim()).filter(Boolean);
  } else if (typeof d.keywords === "string" && d.keywords.trim()) {
    keywords = d.keywords.split(",").map((k) => k.trim()).filter(Boolean);
  } else if (typeof d.keyword === "string" && d.keyword.trim()) {
    keywords = d.keyword.split(",").map((k) => k.trim()).filter(Boolean);
  }

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
  invalidateFlowGraphCache(clientId);
  invalidateTriggerListCache(clientId);
}

module.exports = {
  isGreetingLikeText,
  findMatchingFlow,
  findGreetingFlowFast,
  loadSlimFlowsForClient,
  findKeywordTriggerEntry,
  checkKeywordMatch,
  getTriggerFromNodes,
  getTriggerConfigFromNode,
  findFlowStartNode,
  matchEventTrigger,
  findEventTriggeredFlow,
  clearTriggerCache,
};
