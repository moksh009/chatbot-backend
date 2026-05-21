"use strict";

/**
 * Pre-submit checks for WhatsApp message templates (Meta Graph API).
 * Used before queueing or calling message_templates — not a guarantee of approval.
 */

function extractBodyVarIndices(body) {
  const matches = String(body || "").match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return [...new Set(matches.map((m) => parseInt(m.replace(/\D/g, ""), 10)))].sort((a, b) => a - b);
}

function sanitizeMetaTemplateBodyForSubmission(text) {
  let s = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!s) return "Thanks for choosing us — we will keep you posted here.";
  if (/^\{\{\s*\d+\s*\}\}/.test(s)) {
    s = `Thanks — ${s}`;
  }
  if (/\{\{\s*\d+\s*\}\}\s*$/s.test(s)) {
    s = `${s}\n\n— Team`;
  }
  return s;
}

/**
 * @param {object} template - MetaTemplate-like document
 * @returns {{ valid: boolean, errors: string[], sanitizedBody?: string }}
 */
function validateMetaTemplateForSubmission(template) {
  const errors = [];
  const body = sanitizeMetaTemplateBodyForSubmission(template.body);
  const indices = extractBodyVarIndices(body);

  if (body.length < 12) errors.push("Message body is too short for Meta.");
  if (body.length > 1024) errors.push("Message body exceeds Meta limit (1024 characters).");

  if (indices.length > 0) {
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] !== i + 1) {
        errors.push("Variables must be numbered consecutively from {{1}} with no gaps.");
        break;
      }
    }
    let vm = template.variableMapping;
    if (vm && !(vm instanceof Map)) vm = new Map(Object.entries(vm));
    const mapSize = vm instanceof Map ? vm.size : 0;
    if (mapSize > 0 && mapSize !== indices.length) {
      errors.push(`Body has ${indices.length} variable(s) but ${mapSize} sample value(s) configured.`);
    }
  }

  const category = String(template.category || "").toUpperCase();
  if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(category)) {
    errors.push(`Invalid category "${template.category}". Use UTILITY or MARKETING.`);
  }

  const name = String(template.name || "").trim();
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(name)) {
    errors.push("Template name must be lowercase letters, numbers, and underscores only.");
  }

  const ht = String(template.headerType || "NONE").toUpperCase();
  if (ht === "IMAGE" && !template.headerValue) {
    errors.push("IMAGE header requires a sample image URL before submission.");
  }
  if (ht === "TEXT" && template.headerValue && String(template.headerValue).length > 60) {
    errors.push("TEXT header must be 60 characters or fewer.");
  }

  const buttons = Array.isArray(template.buttons) ? template.buttons : [];
  if (buttons.length > 3) errors.push("Maximum 3 buttons allowed.");
  for (const btn of buttons) {
    if (btn.type === "URL") {
      const url = String(btn.url || "").trim();
      if (!url || !/^https:\/\//i.test(url)) {
        errors.push(`URL button "${btn.text || "link"}" needs a valid https:// URL.`);
      }
    }
  }

  if (/\b(click here|buy now|limited time|act now|hurry)\b/i.test(body) && category === "UTILITY") {
    errors.push("Promotional language is not allowed in UTILITY templates — use MARKETING category.");
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedBody: body,
  };
}

module.exports = {
  extractBodyVarIndices,
  sanitizeMetaTemplateBodyForSubmission,
  validateMetaTemplateForSubmission,
};
