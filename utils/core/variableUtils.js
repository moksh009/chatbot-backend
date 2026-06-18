"use strict";

/**
 * Normalize flow variable keys — plain snake_case names for storage/interpolation.
 * Strips optional {{ }} wrappers from builder UI habits.
 */
function normalizeVariableKey(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  const m = s.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (m) return m[1];
  return s.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
}

/** Map Flow Builder validationType to engine expectedType. */
function normalizeCaptureValidationType(raw) {
  const t = String(raw || "string").toLowerCase().trim();
  if (t === "any") return "string";
  if (["string", "number", "email", "phone", "date"].includes(t)) return t;
  return "string";
}

/**
 * Apply tenant custom variable schema defaults onto a flat context object.
 * Runtime metadata / capturedData values always win.
 */
function applyTenantCustomVariableDefaults(merged, clientLean) {
  if (!merged || typeof merged !== "object") return merged;
  const customDefs = Array.isArray(clientLean?.customVariables) ? clientLean.customVariables : [];
  for (const def of customDefs) {
    const name = normalizeVariableKey(def?.name);
    if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
    const current = merged[name];
    if (current !== undefined && current !== null && String(current).trim() !== "") continue;
    const dv = def?.defaultValue;
    if (dv !== undefined && dv !== null && String(dv).trim() !== "") {
      merged[name] = String(dv);
    }
  }
  return merged;
}

module.exports = {
  normalizeVariableKey,
  normalizeCaptureValidationType,
  applyTenantCustomVariableDefaults,
};
