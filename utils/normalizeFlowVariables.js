"use strict";

/**
 * Canonicalize {{variable}} tokens in generated / imported flows so runtime injection
 * matches VARIABLE_REGISTRY names (snake_case).
 */
const TOKEN_ALIASES = [
  [/\{\{\s*supportPhone(\s*\|[^}]*)?\s*\}\}/gi, "{{support_phone$1}}"],
  [/\{\{\s*googleReviewUrl(\s*\|[^}]*)?\s*\}\}/gi, "{{google_review_url$1}}"],
  [/\{\{\s*brandName(\s*\|[^}]*)?\s*\}\}/gi, "{{brand_name$1}}"],
  [/\{\{\s*botName(\s*\|[^}]*)?\s*\}\}/gi, "{{bot_name$1}}"],
  [/\{\{\s*agentName(\s*\|[^}]*)?\s*\}\}/gi, "{{agent_name$1}}"],
  [/\{\{\s*checkoutUrl(\s*\|[^}]*)?\s*\}\}/gi, "{{checkout_url$1}}"],
  [/\{\{\s*cartTotal(\s*\|[^}]*)?\s*\}\}/gi, "{{cart_total$1}}"],
  [/\{\{\s*orderId(\s*\|[^}]*)?\s*\}\}/gi, "{{order_id$1}}"],
  [/\{\{\s*trackingUrl(\s*\|[^}]*)?\s*\}\}/gi, "{{tracking_url$1}}"],
  [/\{\{\s*businessHours(\s*\|[^}]*)?\s*\}\}/gi, "{{open_hours$1}}"],
];

function normalizeString(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const [re, repl] of TOKEN_ALIASES) {
    out = out.replace(re, repl);
  }
  return out;
}

function walkValue(val) {
  if (typeof val === "string") return normalizeString(val);
  if (Array.isArray(val)) return val.map(walkValue);
  if (val && typeof val === "object" && val.constructor === Object) {
    const next = {};
    for (const [k, v] of Object.entries(val)) {
      next[k] = walkValue(v);
    }
    return next;
  }
  return val;
}

function normalizeFlowNodes(nodes = []) {
  return (nodes || []).map((n) => {
    if (!n?.data) return n;
    return { ...n, data: walkValue(n.data) };
  });
}

module.exports = { normalizeString, normalizeFlowNodes, TOKEN_ALIASES };
