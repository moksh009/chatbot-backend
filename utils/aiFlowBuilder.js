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

const { GoogleGenerativeAI } = require("@google/generative-ai");

// ─── CANONICAL NODE TYPE REGISTRY ────────────────────────────────────────────
// This MUST stay in sync with the nodeTypes object in FlowCanvas.jsx.
// Gemini is strictly constrained to only these type strings.

const NODE_TYPES = {
  trigger:        { handles: { out: ['bottom'] }, desc: 'Flow entry point. data: { trigger: { type, keywords?, matchMode?, channel? } }' },
  message:        { handles: { in: ['top'], out: ['bottom'] }, desc: 'Send text message. data: { body: "...", action?: "ESCALATE_HUMAN" | "GIVE_LOYALTY" | "GENERATE_PAYMENT" }' },
  interactive:    { handles: { in: ['top'], dynamic: true }, desc: 'Buttons/List. data: { interactiveType: "button"|"list", body: "...", buttonsList: [{id,title}] }' },
  template:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Meta WA Template. data: { templateName: "..." }' },
  capture_input:  { handles: { in: ['top'], out: ['bottom'] }, desc: 'Save user reply. data: { question: "...", variable: "..." }' },
  logic:          { handles: { in: ['top'], out: ['true','false'] }, desc: 'Conditional branch. data: { variable: "...", operator: "eq|gt|lt|contains|exists", value: "..." }' },
  delay:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Wait. data: { waitValue: 1, waitUnit: "minutes"|"hours"|"days" }' },
  shopify_call:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Shopify action. data: { action: "product_search"|"order_status"|"cart_recovery" }' },
  http_request:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Call external API. data: { url: "...", method: "GET"|"POST", body: {} }' },
  tag_lead:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Tag lead. data: { tag: "...", action: "add"|"remove" }' },
  escalate:       { handles: { in: ['top'] }, desc: 'Hand off to human agent. data: { dept: "support", priority: "high" }' },
  ab_test:        { handles: { in: ['top'], out: ['a','b'] }, desc: 'A/B split. data: { splitRatio: 50 }' },
  payment_link:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Send payment link. data: { amount: 500, description: "...", action: "GENERATE_PAYMENT" }' },
  loyalty_action: { handles: { in: ['top'], out: ['bottom'] }, desc: 'Loyalty. data: { loyaltyAction: "add"|"redeem", points: 50 }' },
  order_action:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Order ops. data: { action: "CHECK_ORDER_STATUS"|"CANCEL_ORDER"|"INITIATE_RETURN" }' },
  cod_prepaid:    { handles: { in: ['top'], out: ['paid','cod'] }, desc: 'COD conversion. data: { discountAmount: 50, action: "CONVERT_COD_TO_PREPAID" }' },
  abandoned_cart: { handles: { in: ['top'], out: ['recovered'] }, desc: 'Cart recovery step. data: { stepNumber: 1, action: "CART_RECOVERY_SEND_STEP" }' },
  review:         { handles: { in: ['top'], out: ['bottom'] }, desc: 'Review collection. data: { action: "SEND_REVIEW_REQUEST" }' },
  warranty_check: { handles: { in: ['top'], out: ['bottom'] }, desc: 'Warranty lookup. data: { action: "WARRANTY_CHECK" }' },
  admin_alert:    { handles: { in: ['top'], out: ['bottom'] }, desc: 'Alert admin. data: { topic: "..." }' },
  livechat:       { handles: { in: ['top'] }, desc: 'Transfer to live agent. data: { dept: "support" }' },
};

const SUPPORTED_TYPES = Object.keys(NODE_TYPES);

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const buildSystemPrompt = (businessCtx) => `
You are a WhatsApp Flow Architect. Convert business requirements into production-ready ReactFlow JSON.

## STRICT RULES
1. Use ONLY these exact "type" strings: ${SUPPORTED_TYPES.join(', ')}
2. Every node MUST have: id (string), type (one of above), position {x, y}, data {}
3. Every flow MUST start with exactly one "trigger" type node
4. Edges: { id, source, target, sourceHandle? } — sourceHandle required for interactive, logic, ab_test, cod_prepaid, abandoned_cart
5. Positions: start at x=300,y=50 for trigger; add y+220 per step; branches split x±300
6. Return RAW JSON ONLY: { "nodes": [...], "edges": [...] } — no markdown, no explanation
7. Minimum 6 nodes, maximum 25 nodes
8. Every interactive node needs at least 2 buttons in buttonsList with unique ids

## NODE DATA SCHEMAS
${Object.entries(NODE_TYPES).map(([k,v]) => `- ${k}: ${v.desc}`).join('\n')}

## BUSINESS CONTEXT
${businessCtx}
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildBusinessContext(client) {
  const lines = [];
  if (client?.businessName)       lines.push(`Business: ${client.businessName}`);
  if (client?.name)               lines.push(`Brand name: ${client.name}`);
  if (client?.shopDomain)         lines.push(`E-commerce: Shopify (${client.shopDomain})`);
  if (client?.razorpayKeyId)      lines.push(`Payments: Razorpay enabled`);
  if (client?.nicheData?.niche)   lines.push(`Industry: ${client.nicheData.niche}`);
  if (client?.nicheData?.storeUrl) lines.push(`Store URL: ${client.nicheData.storeUrl}`);
  const integrations = [];
  if (client?.shopifyAccessToken) integrations.push('Shopify');
  if (client?.razorpayKeyId)      integrations.push('Razorpay');
  if (client?.emailProvider)      integrations.push('Email');
  if (integrations.length)        lines.push(`Active integrations: ${integrations.join(', ')}`);
  return lines.join('\n') || 'General business (no specific integrations configured)';
}

function validateAndCleanFlow(parsed, yOffset = 0) {
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];

  const validNodes = [];
  const seenIds = new Set();

  for (const node of nodes) {
    // Must have id, type, position
    if (!node.id || !node.type || !node.position) continue;
    // Must be a known type
    if (!SUPPORTED_TYPES.includes(node.type)) {
      // Attempt type coercion for common Gemini mistakes
      const typeMap = {
        messagenode: 'message', message_node: 'message',
        triggernode: 'trigger', trigger_node: 'trigger',
        conditionNode: 'logic', condition: 'logic',
        buttonNode: 'interactive', button: 'interactive',
        escalateNode: 'escalate', human_handoff: 'livechat',
        payment: 'payment_link', loyalty: 'loyalty_action',
        order: 'order_action',
      };
      const coerced = typeMap[node.type] || typeMap[node.type?.toLowerCase()];
      if (!coerced) continue; // Skip entirely unknown types
      node.type = coerced;
    }
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);

    // Ensure interactive nodes have buttonsList
    if (node.type === 'interactive' && !Array.isArray(node.data?.buttonsList)) {
      node.data = { ...node.data, buttonsList: [{ id: 'btn_1', title: 'Yes' }, { id: 'btn_2', title: 'No' }] };
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

  return { nodes: validNodes, edges: validEdges };
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
async function buildFlowFromPrompt(prompt, client, yOffset = 0, strategy = null) {
  const apiKey = (client?.geminiApiKey?.trim()) || (process.env.GEMINI_API_KEY?.trim());
  if (!apiKey) throw new Error("No Gemini API key configured");

  const businessCtx = buildBusinessContext(client);
  const systemPrompt = buildSystemPrompt(businessCtx);

  const fullPrompt = strategy
    ? `Strategy directive: ${strategy}\n\nBusiness requirement: ${prompt}`
    : `Business requirement: ${prompt}`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: systemPrompt
  });

  let raw = '';
  try {
    const result = await model.generateContent(fullPrompt);
    raw = result.response.text();
  } catch (geminiErr) {
    console.error("[AI Flow Builder] Gemini API error:", geminiErr.message);
    return buildFallbackFlow(prompt, yOffset);
  }

  // Strip markdown fences
  const cleaned = raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try extracting JSON from within prose
    const match = cleaned.match(/\{[\s\S]*"nodes"[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
    }
  }

  if (!parsed) {
    console.warn("[AI Flow Builder] Could not parse JSON from Gemini. Using fallback.");
    return buildFallbackFlow(prompt, yOffset);
  }

  return validateAndCleanFlow(parsed, yOffset);
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
