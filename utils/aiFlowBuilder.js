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
  trigger:        { handles: { out: ['bottom'] }, desc: 'Flow entry point. data: { triggerType: "first_message|keyword|...", keywords?:[], matchMode? }' },
  message:        { handles: { in: ['top'], out: ['bottom'] }, desc: 'Send text message. data: { text: "..." } (body is accepted and normalized)' },
  interactive:    { handles: { in: ['top'], dynamic: true }, desc: 'Buttons/List. data: { interactiveType: "button"|"list", text: "...", buttonsList:[{id,title}] }' },
  template:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Meta WA template node. data: { templateName: "..." }' },
  image:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Image/media message node.' },
  capture_input:  { handles: { in: ['top'], out: ['bottom'] }, desc: 'Save user reply. data: { question: "...", variable: "..." }' },
  logic:          { handles: { in: ['top'], out: ['true','false'] }, desc: 'Conditional branch. data: { variable, operator, value }' },
  delay:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Wait node. data: { waitValue, waitUnit }' },
  shopify_call:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Shopify action. data: { action: "CHECK_ORDER_STATUS|search_products|..." }' },
  catalog:        { handles: { in: ['top'], out: ['bottom'] }, desc: 'WhatsApp catalog message. data: { catalogType, body/text, header?, footer? }' },
  cart_handler:   { handles: { in: ['top'], out: ['a'] }, desc: 'Checkout/cart handler. data: { checkoutMessage?: "..." }' },
  order_action:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Order operation node.' },
  abandoned_cart: { handles: { in: ['top'], out: ['recovered'] }, desc: 'Cart recovery automation step.' },
  cod_prepaid:    { handles: { in: ['top'], out: ['paid','cod'] }, desc: 'COD conversion branch.' },
  review:         { handles: { in: ['top'], out: ['positive','negative'] }, desc: 'Review collection node.' },
  loyalty_action: { handles: { in: ['top'], out: ['success','fail'] }, desc: 'Loyalty branch node.' },
  warranty_check: { handles: { in: ['top'], out: ['active','expired','none'] }, desc: 'Warranty lookup node.' },
  email:          { handles: { in: ['top'], out: ['bottom'] }, desc: 'Email node.' },
  tag_lead:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Tag lead. data: { tag, action }' },
  admin_alert:    { handles: { in: ['top'], out: ['bottom'] }, desc: 'Alert admin.' },
  http_request:   { handles: { in: ['top'], out: ['bottom'] }, desc: 'Call external API.' },
  link:           { handles: { in: ['top'], out: ['bottom'] }, desc: 'Redirect/link node.' },
  automation:     { handles: { in: ['top'], out: ['bottom'] }, desc: 'Automation helper node.' },
  livechat:       { handles: { in: ['top'], out: ['bottom'] }, desc: 'Transfer to live agent.' },
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
9. EVERY edge originating from an 'interactive' node MUST have a 'sourceHandle' that EXACTLY matches the 'id' of the corresponding button/list item in the node's data.

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
        loyalty: 'loyalty_action', order: 'order_action',
        ab_test: 'logic',
      };
      const coerced = typeMap[node.type] || typeMap[node.type?.toLowerCase()];
      if (!coerced) continue; // Skip entirely unknown types
      node.type = coerced;
    }
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);

    // Normalize common data-key drifts from AI output.
    if (node.type === 'template' && !node.data?.templateName && node.data?.metaTemplateName) {
      node.data = { ...node.data, templateName: node.data.metaTemplateName };
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
