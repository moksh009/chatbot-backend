"use strict";

/**
 * TRIGGER ENGINE — Phase 20
 * Matches an incoming message to the correct flow based on trigger configuration.
 * Priority: Keyword triggers > First Message triggers > Legacy flow
 */

/**
 * Given an incoming message and a client's flows array,
 * returns which flow (if any) should be activated.
 *
 * @param {Object} parsedMessage - The normalized incoming message
 * @param {Object} client        - The Client document from MongoDB
 * @param {Object} convo         - The Conversation document (may be null for brand new users)
 * @returns {{ flow, triggerType, isLegacy } | null}
 */
async function findMatchingFlow(parsedMessage, client, convo) {
  const text    = (parsedMessage.text?.body || "").trim();
  const channel = parsedMessage.channel || "whatsapp";

  // Use visualFlows (multi-flow architecture) OR legacy flows array
  const flows = client.visualFlows || client.flows || [];

  // ── PRIORITY 1: Check keyword triggers ─────────────────────────────────────
  // These always win over first_message triggers
  const keywordFlow = flows.find((flow) => {
    if (!flow.isActive) return false;

    // Get trigger config — support both .trigger and .nodes-based trigger
    const trigger = flow.trigger || getTriggerFromNodes(flow.nodes || []);
    if (!trigger || trigger.type !== "keyword") return false;

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
       if (!flow.isActive) return false;
       const trigger = flow.trigger || getTriggerFromNodes(flow.nodes || []);
       if (!trigger || trigger.type !== "meta_ad") return false;
       
       return trigger.adId === adId || trigger.adId === "any";
    });
    if (adFlow) return { flow: adFlow, triggerType: "meta_ad" };
  }

  // ── PRIORITY 1.5: Check event triggers (e.g. story_mention) ────────────────
  if (parsedMessage.event === "story_mention") {
    const eventFlow = flows.find((flow) => {
      if (!flow.isActive) return false;
      const trigger = flow.trigger || getTriggerFromNodes(flow.nodes || []);
      return trigger?.type === "story_mention";
    });
    if (eventFlow) return { flow: eventFlow, triggerType: "story_mention" };
  }

  // ── PRIORITY 2: Check first_message triggers ────────────────────────────────
  // Only fires for truly new conversations (no prior messages / no lastStepId)
  const isNewConversation = !convo
    || !convo.lastStepId
    || !convo.lastMessageAt
    || convo.status === "new"
    || (convo.lastStepId === null || convo.lastStepId === "");

  if (isNewConversation) {
    const welcomeFlow = flows.find((flow) => {
      if (!flow.isActive) return false;

      const trigger = flow.trigger || getTriggerFromNodes(flow.nodes || []);
      if (!trigger || trigger.type !== "first_message") return false;

      const flowChannel = (trigger.channel || flow.channel || "both").toLowerCase();
      return flowChannel === "both" || flowChannel === channel;
    });

    if (welcomeFlow) {
      return { flow: welcomeFlow, triggerType: "first_message" };
    }

    // Backward compatibility: if no visualFlows but has legacy flowNodes/flowEdges
    const legacyNodes = client.flowNodes || [];
    const legacyEdges = client.flowEdges || [];
    if (legacyNodes.length > 0) {
      return {
        flow: { nodes: legacyNodes, edges: legacyEdges, isLegacy: true },
        triggerType: "first_message",
        isLegacy: true,
      };
    }
  }

  // ── No matching trigger ──────────────────────────────────────────────────────
  return null;
}

/**
 * Extract trigger configuration from the TriggerNode inside a flow's nodes array.
 * Supports both the flat data.trigger object and data.triggerType / data.keywords fields.
 */
function getTriggerFromNodes(nodes) {
  if (!Array.isArray(nodes)) return null;
  const triggerNode = nodes.find(
    (n) => n.type === "TriggerNode" || n.type === "trigger"
  );
  if (!triggerNode) return null;

  const d = triggerNode.data || {};

  // New format: data.trigger = { type, matchMode, keywords, channel }
  if (d.trigger) return d.trigger;

  // Legacy format from TriggerNode.jsx: data.triggerType, data.keyword
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

  // Parse comma-separated keywords into array
  const keywords = legacyKeyword
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return {
    type:      "keyword",
    keywords,
    matchMode: d.matchType || d.matchMode || "contains",
    channel:   d.channel || "both",
  };
}

/**
 * Check if a specific keyword matches the incoming text.
 * Used both by findMatchingFlow and by flow builder live preview.
 *
 * @param {string} text      - Incoming message text
 * @param {string} keyword   - The keyword to match against
 * @param {string} matchMode - "exact" | "contains" | "contains_case_sensitive"
 * @returns {boolean}
 */
function checkKeywordMatch(text, keyword, matchMode = "contains") {
  if (!text || !keyword) return false;
  const trimmedKeyword = keyword.trim();
  if (!trimmedKeyword) return false;

  switch (matchMode) {
    case "exact":
      // Case-insensitive exact match
      return text.toLowerCase() === trimmedKeyword.toLowerCase();

    case "contains_case_sensitive":
      // Case-sensitive contains
      return text.includes(trimmedKeyword);

    case "contains":
    default:
      // Case-insensitive contains (recommended)
      return text.toLowerCase().includes(trimmedKeyword.toLowerCase());
  }
}

/**
 * Find the start node for a flow (the first content node after the TriggerNode).
 * Returns the nodeId to executeNode with.
 */
function findFlowStartNode(flowNodes, flowEdges) {
  if (!flowNodes || !flowNodes.length) return null;

  // Find the TriggerNode
  const triggerNode = flowNodes.find(
    (n) => n.type === "TriggerNode" || n.type === "trigger"
  );

  if (triggerNode) {
    // Get the first edge from the trigger node
    const firstEdge = (flowEdges || []).find(
      (e) => e.source === triggerNode.id
    );
    if (firstEdge?.target) return firstEdge.target;
  }

  // No trigger node — start from the first non-folder node
  const startNode = flowNodes.find(
    (n) => n.type !== "folder" && n.type !== "group" && n.type !== "sticky"
  );
  return startNode?.id || null;
}

module.exports = { findMatchingFlow, checkKeywordMatch, getTriggerFromNodes, findFlowStartNode };
