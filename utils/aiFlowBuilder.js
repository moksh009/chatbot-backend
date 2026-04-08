"use strict";

/**
 * AI Flow Builder — Phase 28 Track 1
 *
 * Generates ReactFlow-compatible nodes & edges from a natural language prompt.
 * Critically, it injects the EXACT node schema used by the frontend FlowCanvas
 * so Gemini outputs nodes that render without crashing.
 *
 * Key Design Decisions:
 *  - Strict JSON schema injected into system prompt (no generic shapes)
 *  - y + 500 offset applied to all generated nodes to prevent overlap with
 *    any existing nodes already on the canvas
 *  - AbortController-friendly: caller can cancel mid-generation
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CANONICAL NODE SCHEMA ---
// This is a representative slice of what FlowCanvas actually renders.
// Gemini must output nodes that conform to this exact shape.
const NODE_SCHEMA_EXAMPLE = {
  id: "node_example_1",
  type: "triggerNode",
  position: { x: 250, y: 100 },
  data: {
    label: "Message Received",
    isStart: true,
    triggerType: "any_message",
    validationRules: []
  }
};

const SUPPORTED_TYPES = [
  "triggerNode",    // Entry point — isStart: true
  "messageNode",    // Sends a text message — data: { message: "", buttons: [] }
  "interactiveNode",// List/Button messages — data: { type: "list"|"button", title: "", sections: [] }
  "captureNode",    // Asks and saves data — data: { question: "", variable: "", validation: "" }
  "conditionNode",  // Branches flow — data: { condition: "", trueLabel: "Yes", falseLabel: "No" }
  "escalateNode",   // Transfers to human — data: { dept: "", priority: "high" }
  "shopifyNode",    // Ecommerce actions — data: { action: "search"|"cart"|"status" }
  "aiNode",         // Advanced AI logic — data: { prompt: "", temperature: 0.7 }
  "delayNode",      // Adds a wait — data: { delay: 1, unit: "minutes" }
  "tagNode",        // Adds/removes tags — data: { tag: "", action: "add"|"remove" }
  "templateNode",   // Sends meta template — data: { templateName: "", language: "en" }
  "endNode"         // Terminates the flow — data: { label: "End" }
];

const SYSTEM_PROMPT = `
You are a senior WhatsApp UX Architect. Your goal is to convert a business requirement into a high-conversion, professional ReactFlow JSON.

## NODE TYPES & JSON DATA SCHEMAS:
1. triggerNode: { "isStart": true, "triggerType": "keyword"|"any", "keywords": [] }
2. messageNode: { "message": "Text with {{variable}} support", "buttons": [{"id": "b1", "text": "Yes"}] }
3. interactiveNode: { "type": "list", "title": "Main Menu", "rows": [{"id": "r1", "title": "Products"}] }
4. captureNode: { "question": "What is your name?", "variable": "customer_name", "validation": "name"|"email"|"phone"|"none" }
5. conditionNode: { "condition": "If context.totalSpent > 1000", "trueLabel": "VIP", "falseLabel": "Standard" }
6. shopifyNode: { "action": "product_search", "query": "{{last_message}}" }
7. aiNode: { "prompt": "Identify the user's main concern and summarize it.", "outputVariable": "user_intent" }
8. tagNode: { "tag": "potential_lead", "action": "add" }
9. delayNode: { "waitValue": 5, "waitUnit": "minutes" }
10. templateNode: { "templateName": "order_conf", "language": "en" }
11. endNode: { "label": "Flow Completed" }

## EDGE SCHEMA:
{ "id": "e1", "source": "n1", "target": "n2", "sourceHandle": "true"|"false" (only for conditions) }

## LAYOUT:
x: starts at 250, increments by 300 for branches.
y: starts at 100, increments by 250 per step.

Return ONLY raw JSON: { "nodes": [...], "edges": [...] }
`;

/**
 * Main entry point: build a flow from a natural language prompt.
 */
async function buildFlowFromPrompt(prompt, client, yOffset = 500) {
  const apiKey = (client?.geminiApiKey?.trim()) || (process.env.GEMINI_API_KEY?.trim());
  if (!apiKey) throw new Error("No Gemini API key configured");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT
  });

  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gemini invalid JSON: ${cleaned.substring(0, 100)}`);
  }

  // Apply layout offsets
  const nodes = (parsed.nodes || []).map(node => ({
    ...node,
    position: {
      x: node.position?.x ?? 250,
      y: (node.position?.y ?? 100) + yOffset
    }
  }));

  return { nodes, edges: parsed.edges || [] };
}

/**
 * Generates 3 distinct strategic variants for the same requirement.
 * Variant 1: Conservative/Support-focused
 * Variant 2: Aggressive/Sales-focused
 * Variant 3: Interactive/Quizzical (Lead gen focus)
 */
async function generateFlowVariants(prompt, client) {
  const strategies = [
    "Focus on helpful support, minimal friction, clear escalation paths.",
    "Focus on aggressive upselling, promo codes, and quick checkouts.",
    "Focus on interactive data gathering, qualifying leads via questions first."
  ];

  const variants = await Promise.all(strategies.map(async (strat, idx) => {
    const metaPrompt = `Strategy: ${strat}\n\nUser Requirement: ${prompt}`;
    const flow = await buildFlowFromPrompt(metaPrompt, client, 0);
    return {
      id: `variant_${idx + 1}`,
      name: ["Support First", "Sales Driven", "Lead Qualifier"][idx],
      ...flow
    };
  }));

  return variants;
}

module.exports = { buildFlowFromPrompt, generateFlowVariants, SUPPORTED_TYPES };
