"use strict";

const { platformGenerateJSON } = require("./gemini");

function buildPlannerPrompt({ prompt, strategy = {}, businessCtx = "" }) {
  const safePrompt = String(prompt || "").trim().slice(0, 2000);
  const s = strategy || {};

  return `You are an enterprise WhatsApp automation planner for ecommerce/support.
Return ONLY JSON.

INPUT:
- User request: ${safePrompt}
- Strategy:
  - flowType: ${s.flowType || ""}
  - primaryKpi: ${s.primaryKpi || ""}
  - riskPosture: ${s.riskPosture || ""}
  - audienceProfile: ${s.audienceProfile || ""}
  - channelMix: ${s.channelMix || ""}
  - tone: ${s.tone || ""}
  - language: ${s.language || ""}
- Business context:
${businessCtx || "(none)"}

OUTPUT SCHEMA (JSON):
{
  "intent": {
    "flowType": "support|sales|retention|post_purchase|compliance|hybrid",
    "primaryKpi": "conversion|aov|deflection|review_rate|retention",
    "riskPosture": "conservative|balanced|aggressive",
    "audienceProfile": "all|new|returning|vip|high_cart_value|at_risk",
    "channelMix": "whatsapp_only|whatsapp_email|whatsapp_ig",
    "tone": "friendly|professional|direct",
    "language": "English|Hindi|Hinglish|...",
    "notes": "string"
  },
  "lanes": [
    {
      "id": "main",
      "goal": "string",
      "kpis": ["string"],
      "entryTriggers": [
        { "type": "first_message|keyword|shopify_event|ig_event", "keywords": ["string"], "matchMode": "contains|exact" }
      ]
    }
  ],
  "outline": [
    { "step": "string", "node": "trigger|message|interactive|capture_input|template|livechat|shopify_call|order_action|loyalty_action|warranty_check|review|delay|logic", "copyBrief": "string",
      "buttons": [ { "id": "string", "title": "string", "targetStep": "string" } ]
    }
  ],
  "compliance": { "avoidClaims": ["string"], "requiredDisclaimers": ["string"], "consentSensitive": false }
}

RULES:
- Keep outline 6-18 steps.
- Use quick replies/buttons wherever possible.
- Avoid unverifiable scarcity/guarantee claims.
- Include escalation/handoff in support flows.
`;
}

async function planFlow({ prompt, strategy = {}, client = null }) {
  const businessCtx = [
    client?.businessName ? `Business: ${client.businessName}` : null,
    client?.name ? `Brand name: ${client.name}` : null,
    client?.shopDomain ? `Shopify: ${client.shopDomain}` : null,
    client?.brand?.currency ? `Currency: ${client.brand.currency}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const plannerPrompt = buildPlannerPrompt({ prompt, strategy, businessCtx });
  const planned = await platformGenerateJSON(plannerPrompt, {
    maxTokens: 2200,
    temperature: 0.1,
    timeout: 30000,
  });
  if (!planned || typeof planned !== "object") return null;
  return planned;
}

module.exports = { planFlow };

