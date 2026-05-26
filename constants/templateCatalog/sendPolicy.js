"use strict";

/**
 * Send-time policy (Phase 3) — canonical names and fallbacks when resolving templates to send.
 * Catalog display names stay unchanged; send layer may try alternate Meta names.
 */

/** Canonical Meta name for COD → prepaid (webhook + commerce hub). */
const COD_PREPAID_CANONICAL_META_NAME = "eco_cod_prepaid_switch";

/** Legacy COD template names → canonical eco name at send time. */
const COD_PREPAID_SEND_ALIASES = [
  "cod_to_prepaid",
  "cod_to_prepaid_discount",
  "razorpay_cod_converter",
  "cashfree_cod_converter",
  "shopify_cod_converter",
];

/** Slot id → extra Meta names to try if primary slot names are missing on WABA. */
const SLOT_SEND_META_FALLBACKS = {
  eco_abandoned_cart: ["cart_recovery_1", "abandoned_cart_r1_v1", "eco_abandoned_cart"],
  wizard_cart_1: ["cart_recovery_1", "abandoned_cart_r1_v1"],
  wizard_cart_2: ["cart_recovery_2", "abandoned_cart_r2_v1"],
  gate_cart_recovery: ["cart_recovery", "cart_recovery_1"],
  wizard_warranty: ["warranty_certificate", "warranty_registration_v1", "warranty_confirmation"],
  gate_ndr: ["rto_ndr_rescue"],
};

/** Order status → catalog slot id (eco pack). */
const ORDER_STATUS_SLOT_BY_KEY = {
  paid: "eco_order_confirmed",
  processing: "eco_order_confirmed",
  shipped: "eco_shipping_update",
  fulfilled: "eco_shipping_update",
  delivered: "eco_delivered",
};

/** Context type → default autoTrigger for resolution. */
const CONTEXT_DEFAULT_TRIGGER = {
  order: null,
  abandoned_cart: "abandoned_cart",
  flow: null,
  warranty: "order_placed",
  cod_prepaid: null,
};

function normalizeCodPrepaidTemplateName(name) {
  const n = String(name || "").trim();
  if (!n) return COD_PREPAID_CANONICAL_META_NAME;
  if (n === COD_PREPAID_CANONICAL_META_NAME) return n;
  if (COD_PREPAID_SEND_ALIASES.includes(n)) return COD_PREPAID_CANONICAL_META_NAME;
  return n;
}

function getSendMetaNameCandidates(slotId, explicitMetaName) {
  const { getSlotById, getSlotByMetaName, expandSlotLookupNames } = require("./catalog");
  const names = [];
  const push = (x) => {
    const s = String(x || "").trim();
    if (s && !names.includes(s)) names.push(s);
  };

  if (explicitMetaName) {
    push(normalizeCodPrepaidTemplateName(explicitMetaName));
    const slot = getSlotByMetaName(explicitMetaName);
    if (slot) expandSlotLookupNames(slot).forEach(push);
  }

  if (slotId) {
    const slot = getSlotById(slotId);
    if (slot) {
      push(slot.canonicalMetaName);
      expandSlotLookupNames(slot).forEach(push);
      (SLOT_SEND_META_FALLBACKS[slotId] || []).forEach(push);
    }
  }

  return names;
}

module.exports = {
  COD_PREPAID_CANONICAL_META_NAME,
  COD_PREPAID_SEND_ALIASES,
  SLOT_SEND_META_FALLBACKS,
  ORDER_STATUS_SLOT_BY_KEY,
  CONTEXT_DEFAULT_TRIGGER,
  normalizeCodPrepaidTemplateName,
  getSendMetaNameCandidates,
};
