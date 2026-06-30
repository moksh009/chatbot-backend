"use strict";

/**
 * AI Flow Builder — Enterprise Edition
 *
 * Generates ReactFlow-compatible nodes & edges from a natural language prompt.
 * Uses the EXACT node type IDs and data schemas the FlowCanvas renders.
 *
 * Key behaviours:
 *  - System prompt injects canonical node schemas so Gemini cannot produce
 *    unknown types
 *  - Business context (brand, products, integrations) fed in automatically
 *  - validateAndCleanFlow() ensures output is safe to render before returning
 *  - generateFlowVariants() returns 3 strategically distinct versions
 *  - Graceful fallback: if Gemini returns invalid JSON, returns a default
 *    welome flow rather than throwing
 */

const { callAIJSON } = require("../core/aiGateway");
const { V1_FORBIDDEN_NODE_TYPES } = require("./flowNodeContract");

// ─── CANONICAL NODE TYPE REGISTRY ────────────────────────────────────────────
// Synced with FlowCanvas nodeTypes + flowNodeContract.js (V1 shippable set).

const NODE_TYPES = {
  trigger:        { handles: { out: ['bottom'] }, desc: 'Flow entry. data: { triggerType: "first_message|keyword|abandoned_cart|...", keywords?:[], matchMode? }' },
  intent_trigger: { handles: { in: ['top'], out: ['a'] }, desc: 'AI intent match entry. data: { intentName, threshold }' },
  message:        { handles: { in: ['top'], out: ['bottom'] }, desc: 'Send text. data: { text: "..." }' },
  interactive:    { handles: { in: ['top'], dynamic: true }, desc: 'Buttons/List. data: { interactiveType: "button"|"list", text, buttonsList:[{id,title}] }' },
  image:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Image/media message.' },
  email:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Email node. data: { subject, body }' },
  whatsapp_flow:  { handles: { in: ['top'], out: ['submitted', 'timeout', 'error'] }, desc: 'Meta WhatsApp Flow form. data: { flowId, buttonLabel, flowPrefillMappings, flowResponseMappings, flowTimeoutHours }' },
  capture_input:  { handles: { in: ['top'], out: ['bottom'] }, desc: 'Save reply. data: { question, variable }' },
  logic:          { handles: { in: ['top'], out: ['true','false'] }, desc: 'Branch. data: { variable, operator, value }' },
  delay:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Wait. data: { waitValue, waitUnit }' },
  link:           { handles: { in: ['top'], out: ['bottom'] }, desc: 'Jump to another flow folder.' },
  set_variable:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Set conversation variable.' },
  ab_test:        { handles: { in: ['top'], out: ['a','b'] }, desc: 'A/B split. data: { splitRatio }' },
  schedule:       { handles: { in: ['top'], out: ['open','closed'] }, desc: 'Business hours gate.' },
  catalog:        { handles: { in: ['top'], out: ['bottom','cart'] }, desc: 'WhatsApp catalog. data: { catalogType, body/text }' },
  shopify_call:   { handles: { in: ['top'], out: ['bottom','success','not_found'] }, desc: 'Shopify action. data: { action }' },
  cart_handler:   { handles: { in: ['top'], out: ['a'] }, desc: 'Checkout link after catalog cart.' },
  livechat:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Human agent handoff.' },
  warranty_check: { handles: { in: ['top'], out: ['bottom'] }, desc: 'Warranty lookup by phone.' },
  persona:        { handles: { in: ['top'], out: ['a'] }, desc: 'AI reply from knowledge base.' },
  admin_alert:    { handles: { in: ['top'], out: ['bottom'] }, desc: 'Email admin alert (no WhatsApp).' },
  tag_lead:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'CRM tag. data: { tag, action: "add"|"remove" }' },
  webhook:        { handles: { in: ['top'], out: ['success','error'] }, desc: 'HTTPS webhook.' },
  http_request:   { handles: { in: ['top'], out: ['success','error'] }, desc: 'HTTP request.' },
  automation:     { handles: { in: ['top'], out: ['bottom'] }, desc: 'Automation trigger helper.' },
  template:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Approved Meta template (prefer message for AI drafts).' },
  folder:         { handles: {}, desc: 'Layout folder only — do not use in AI-generated flows.' },
};

const SUPPORTED_TYPES = Object.keys(NODE_TYPES).filter((t) => t !== 'folder');
const FORBIDDEN_AI_TYPES = new Set(V1_FORBIDDEN_NODE_TYPES);

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const buildSystemPrompt = (businessCtx) => `
You are a WhatsApp Flow Architect. Convert business requirements into production-ready ReactFlow JSON.

## STRICT RULES
1. Use ONLY these exact "type" strings: ${SUPPORTED_TYPES.join(', ')}
2. Every node MUST have: id (string), type (one of above), position {x, y}, data {}
3. Every flow MUST start with exactly one "trigger" type node
4. Edges: { id, source, target, sourceHandle? } — sourceHandle required for interactive, logic, ab_test, schedule, webhook, http_request
5. Positions: start at x=300,y=50 for trigger; add y+220 per step; branches split x±300
6. Return RAW JSON ONLY: { "nodes": [...], "edges": [...] } — no markdown, no explanation
7. Minimum 6 nodes, maximum 25 nodes
8. Every interactive node needs at least 2 buttons in buttonsList with unique ids
9. EVERY edge from an interactive node MUST have sourceHandle matching a button/list row id
10. V1 scope: NO in-chat order tracking menus, NO cod_prepaid, NO review nodes. Cart recovery = trigger type abandoned_cart + delay + message chain. Admin alerts = email only.
11. Prefer Indian D2C copy: catalog browse, cancel/modify order, returns, warranty, install help, agent handoff

## NODE DATA SCHEMAS
${Object.entries(NODE_TYPES).map(([k,v]) => `- ${k}: ${v.desc}`).join('\n')}

## BUSINESS CONTEXT
${businessCtx}
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildBusinessContext(client, extras = {}) {
  const lines = [];
  if (client?.businessName)       lines.push(`Business: ${client.businessName}`);
  if (client?.name)               lines.push(`Brand name: ${client.name}`);
  if (client?.shopDomain)         lines.push(`E-commerce: Shopify (${client.shopDomain})`);
  if (client?.razorpayKeyId)      lines.push(`Payments: Razorpay enabled`);
  if (client?.nicheData?.niche)   lines.push(`Industry: ${client.nicheData.niche}`);
  if (client?.nicheData?.storeUrl) lines.push(`Store URL: ${client.nicheData.storeUrl}`);
  if (client?.platformVars?.brandName) lines.push(`Display brand: ${client.platformVars.brandName}`);
  if (client?.platformVars?.agentName) lines.push(`Bot name: ${client.platformVars.agentName}`);
  if (client?.ai?.persona?.tone || client?.platformVars?.defaultTone) {
    lines.push(`Tone: ${client.ai?.persona?.tone || client.platformVars.defaultTone}`);
  }
  if (client?.ai?.persona?.language || client?.platformVars?.defaultLanguage) {
    lines.push(`Language: ${client.ai?.persona?.language || client.platformVars.defaultLanguage}`);
  }
  if (extras.personaSummary) lines.push(`AI persona: ${extras.personaSummary}`);
  if (extras.knowledgeSummary) lines.push(`Knowledge base:\n${extras.knowledgeSummary}`);
  if (extras.approvedTemplateSlots?.length) {
    lines.push(`Approved template slots: ${extras.approvedTemplateSlots.join(', ')}`);
  }
  // Phase 5.3 — surface canonical store-category slug so the AI flow builder
  // knows whether to scaffold warranty / install nodes vs catalog-only flows.
  const slug =
    extras.storeCategory ||
    client?.onboardingData?.storeCategory ||
    '';
  if (slug) {
    try {
      const { getStoreCategoryBySlug } = require('../../constants/storeCategories');
      const cat = getStoreCategoryBySlug(slug);
      if (cat?.label) {
        lines.push(`Store category: ${cat.label} (slug: ${slug})`);
        if (cat.warranty === false) lines.push('Do NOT scaffold warranty registration nodes.');
        if (cat.install === false) lines.push('Do NOT scaffold install / product-help nodes.');
        if (cat.catalog === false) lines.push('Skip catalog browsing nodes — this is a services workspace.');
      }
    } catch (_) {
      lines.push(`Store category slug: ${slug}`);
    }
  }
  const wf = client?.wizardFeatures;
  if (wf && typeof wf === 'object') {
    const enabled = Object.entries(wf).filter(([, v]) => v === true).map(([k]) => k);
    if (enabled.length) lines.push(`Enabled automations: ${enabled.join(', ')}`);
  }
  const integrations = [];
  if (client?.shopifyAccessToken) integrations.push('Shopify');
  if (client?.razorpayKeyId)      integrations.push('Razorpay');
  if (client?.emailProvider)      integrations.push('Email');
  if (integrations.length)        lines.push(`Active integrations: ${integrations.join(', ')}`);
  return lines.join('\n') || 'General business (no specific integrations configured)';
}


function verifyAllEdgesMatchButtonIds(nodes, edges) {
  // Ensure that every edge originating from an interactive node has a sourceHandle that matches an actual button ID
  const interactiveNodes = nodes.filter(n => n.type === 'interactive');
  
  let valid = true;
  let errorMsgs = [];

  for (const node of interactiveNodes) {
    const validIds = new Set();
    if (node.data?.interactiveType === 'button' && node.data.buttonsList) {
      node.data.buttonsList.forEach(b => validIds.add(String(b.id)));
    } else if (node.data?.interactiveType === 'list' && node.data.sections) {
      node.data.sections.forEach(s => {
        (s.rows || []).forEach(r => validIds.add(String(r.id)));
      });
    }

    const outgoingEdges = edges.filter(e => e.source === node.id);
    const fallbackHandles = Array.from(validIds);
    for (const edge of outgoingEdges) {
      if (!edge.sourceHandle || !validIds.has(String(edge.sourceHandle))) {
        if (fallbackHandles.length > 0) {
          const idx = outgoingEdges.indexOf(edge);
          edge.sourceHandle = fallbackHandles[idx] || fallbackHandles[0];
          continue;
        }
        valid = false;
        errorMsgs.push(`Edge ${edge.id} from node ${node.id} has invalid sourceHandle "${edge.sourceHandle}". Allowed IDs: ${Array.from(validIds).join(', ')}`);
      }
    }
  }
  
  if (!valid) {
    console.warn("[AI Flow Builder] Edge validation warnings:", errorMsgs);
  }
  return { nodes, edges, valid, errorMsgs };
}

function validateAndCleanFlow(parsed, yOffset = 0) {
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];

  const validNodes = [];
  const seenIds = new Set();

  for (const node of nodes) {
    // Must have id, type, position
    if (!node.id || !node.type || !node.position) continue;
    if (FORBIDDEN_AI_TYPES.has(node.type)) continue;
    // Must be a known type
    if (!SUPPORTED_TYPES.includes(node.type)) {
      // Attempt type coercion for common Gemini mistakes
      const typeMap = {
        messagenode: 'message', message_node: 'message',
        triggernode: 'trigger', trigger_node: 'trigger',
        conditionNode: 'logic', condition: 'logic',
        buttonNode: 'interactive', button: 'interactive',
        escalateNode: 'livechat', human_handoff: 'livechat',
        payment: 'message', payment_link: 'message',
        order: 'message', order_action: 'message',
        cod_prepaid: 'message', review: 'message',
        abandoned_cart: 'message',
        ab_test: 'ab_test',
        template: 'message', wa_template: 'message',
      };
      const coerced = typeMap[node.type] || typeMap[node.type?.toLowerCase()];
      if (!coerced) continue; // Skip entirely unknown types
      node.type = coerced;
    }
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);

    // Normalize common data-key drifts from AI output.
    if (node.type === 'template') {
      // Keep AI builder low-template by default: render template-like copy as message.
      const fallbackText =
        node.data?.text ||
        node.data?.body ||
        "Hello! How can we help you today?";
      node.type = 'message';
      node.data = {
        ...node.data,
        label: node.data?.label || 'Message',
        text: String(fallbackText).slice(0, 1024),
      };
    }
    if ((node.type === 'interactive' || node.type === 'message' || node.type === 'catalog') && !node.data?.text && node.data?.body) {
      node.data = { ...node.data, text: node.data.body };
    }
    if (node.type === 'trigger' && !node.data?.triggerType && node.data?.trigger?.type) {
      node.data = { ...node.data, triggerType: node.data.trigger.type };
    }

    // Ensure interactive nodes have buttonsList
    if (node.type === 'interactive' && !Array.isArray(node.data?.buttonsList)) {
      node.data = {
        ...node.data,
        interactiveType: node.data?.interactiveType || 'button',
        text: node.data?.text || node.data?.body || 'Choose an option:',
        buttonsList: [{ id: 'btn_1', title: 'Yes' }, { id: 'btn_2', title: 'No' }],
      };
    }

    // Apply y offset
    validNodes.push({
      ...node,
      position: {
        x: node.position.x ?? 300,
        y: (node.position.y ?? 100) + yOffset
      },
      data: { ...(node.data || {}) }
    });
  }

  // Ensure there is always one trigger node as flow entry.
  if (!validNodes.some((n) => n.type === 'trigger')) {
    const firstNode = validNodes[0];
    const triggerNode = {
      id: 'ai_trigger_0',
      type: 'trigger',
      position: { x: 300, y: 50 + yOffset },
      data: { label: 'Start', triggerType: 'first_message' },
    };
    validNodes.unshift(triggerNode);
    if (firstNode) {
      edges.unshift({ id: 'e_ai_trigger_0', source: 'ai_trigger_0', target: firstNode.id });
    }
  }

  // Clean edges: remove any that reference non-existent nodes
  const nodeIdSet = new Set(validNodes.map(n => n.id));
  const validEdges = edges
    .filter(e => e.source && e.target && nodeIdSet.has(e.source) && nodeIdSet.has(e.target))
    .map((e, i) => ({
      id: e.id || `e_${i}`,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      animated: false
    }));

  const healed = verifyAllEdgesMatchButtonIds(validNodes, validEdges);
  return {
    ...healed,
    nodes: healed.nodes.slice(0, 40),
  };
}

async function maybeAppendCatalogBranch(flow, prompt, client, contextExtras = {}) {
  try {
    const {
      detectBrowseCatalogIntent,
      loadCatalogBranchContext,
      appendCatalogBranchIfMissing,
    } = require('./catalogBranchBuilder');
    const slug =
      contextExtras?.storeCategory ||
      client?.onboardingData?.storeCategory ||
      '';
    if (slug) {
      try {
        const { getStoreCategoryBySlug } = require('../../constants/storeCategories');
        const cat = getStoreCategoryBySlug(slug);
        if (cat?.catalog === false) return flow;
      } catch (_) {}
    }
    if (!detectBrowseCatalogIntent(prompt, contextExtras)) {
      return flow;
    }
    const clientId = client?.clientId;
    if (!clientId) return flow;
    const ctx = await loadCatalogBranchContext(clientId);
    if (!ctx.products.length && !ctx.collections.length) return flow;
    return appendCatalogBranchIfMissing(flow, ctx);
  } catch (err) {
    console.warn('[AI Flow Builder] catalog branch append skipped:', err.message);
    return flow;
  }
}

// ─── FALLBACK FLOW ────────────────────────────────────────────────────────────
// Returned when Gemini fails entirely. Ensures user can always work.
function buildFallbackFlow(prompt, yOffset = 0) {
  return {
    nodes: [
      { id: 'f1', type: 'trigger',     position: { x: 300, y: 50 + yOffset },  data: { label: 'Entry', trigger: { type: 'first_message', channel: 'both' } } },
      { id: 'f2', type: 'message',     position: { x: 300, y: 270 + yOffset }, data: { label: 'Welcome', body: `Hello! I'm here to help. ${prompt.substring(0, 60)}...` } },
      { id: 'f3', type: 'interactive', position: { x: 300, y: 490 + yOffset }, data: { label: 'Options', body: 'How can I assist?', interactiveType: 'button', buttonsList: [{ id: 'btn_1', title: 'Learn More' }, { id: 'btn_2', title: 'Talk to Agent' }] } },
      { id: 'f4', type: 'livechat',    position: { x: 600, y: 710 + yOffset }, data: { label: 'Agent Handoff', dept: 'support' } },
    ],
    edges: [
      { id: 'ef1', source: 'f1', target: 'f2' },
      { id: 'ef2', source: 'f2', target: 'f3' },
      { id: 'ef3', source: 'f3', target: 'f4', sourceHandle: 'btn_2' },
    ]
  };
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

/**
 * Build a ReactFlow JSON from a natural language prompt.
 *
 * @param {string} prompt   - Natural language description of the flow
 * @param {object} client   - Mongoose client doc (for business context)
 * @param {number} yOffset  - Y pixels to offset all nodes (avoid overlap on existing canvas)
 * @param {string} strategy - Optional strategy hint injected at start of prompt
 */
async function buildFlowFromPrompt(prompt, client, yOffset = 0, strategy = null, contextExtras = {}) {
  const clientId = client?.clientId;
  if (!clientId) throw new Error("No client configured for AI flow builder");

  const businessCtx = buildBusinessContext(client, contextExtras);
  const systemPrompt = buildSystemPrompt(businessCtx);

  const fullPrompt = strategy
    ? `Strategy directive: ${strategy}\n\nBusiness requirement: ${prompt}`
    : `Business requirement: ${prompt}`;

  let parsed;
  try {
    const result = await callAIJSON({
      clientId,
      feature: 'flow_builder',
      prompt: fullPrompt,
      systemPrompt,
      maxTokens: 8192,
      fast: false,
      temperature: 0.3,
    });
    parsed = result.data;
  } catch (geminiErr) {
    if (geminiErr.code === 'AI_NOT_CONFIGURED') {
      const err = new Error(geminiErr.userMessage || 'AI_NOT_CONFIGURED');
      err.code = 'AI_NOT_CONFIGURED';
      throw err;
    }
    console.error("[AI Flow Builder] AI API error:", geminiErr.message);
    return buildFallbackFlow(prompt, yOffset);
  }

  if (!parsed) {
    return buildFallbackFlow(prompt, yOffset);
  }

  let cleaned = validateAndCleanFlow(parsed, yOffset);
  cleaned = await maybeAppendCatalogBranch(cleaned, prompt, client, contextExtras);
  return cleaned;
}

// ─── VARIANT GENERATION ───────────────────────────────────────────────────────

const STRATEGIES = [
  {
    id:   'support',
    name: 'Support-First',
    hint: 'Prioritise helpful support. Minimal friction, clear escalation paths. No aggressive selling. Every dead end leads to a human agent.'
  },
  {
    id:   'sales',
    name: 'Sales-Driven',
    hint: 'Maximise conversions. Use urgency, social proof, discount offers, and direct checkout links. Keep it punchy and action-oriented.'
  },
  {
    id:   'qualify',
    name: 'Lead Qualifier',
    hint: 'Gather rich lead data first. Ask qualifying questions, capture name/email/budget before offering products. Tag lead based on answers.'
  }
];

/**
 * Generates 3 strategically-distinct variants of the same flow requirement.
 */
async function generateFlowVariants(prompt, client) {
  const results = await Promise.allSettled(
    STRATEGIES.map(strat =>
      buildFlowFromPrompt(prompt, client, 0, strat.hint)
        .then(flow => ({ id: strat.id, name: strat.name, ...flow }))
    )
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: STRATEGIES[i].id, name: STRATEGIES[i].name, nodes: [], edges: [], error: r.reason?.message }
  );
}

module.exports = {
  buildFlowFromPrompt,
  generateFlowVariants,
  validateAndCleanFlow,
  SUPPORTED_TYPES,
  STRATEGIES
};
