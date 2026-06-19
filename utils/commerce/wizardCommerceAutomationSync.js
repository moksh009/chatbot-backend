"use strict";

/**
 * Apply wizard feature toggles to canonical commerceAutomations (Order messages).
 * Called on wizard launch so COD confirmation, cart recovery, etc. match Step 3/6 choices.
 */

const Client = require("../../models/Client");
const {
  mergeSystemAutomations,
  CART_FOLLOWUP_DEFAULT_MINUTES,
} = require("./commerceAutomationPresets");
const log = require("../core/logger")("WizardCommerceSync");

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {string} clientId
 * @param {object} wizardData - launch payload (features, cartTiming, templates)
 * @returns {Promise<{ ok: boolean, patched?: string[] }>}
 */
async function syncWizardCommerceAutomations(clientId, wizardData = {}) {
  if (!clientId) return { ok: false, reason: "missing_client" };

  const f = wizardData.features || {};
  const client = await Client.findOne({ clientId })
    .select("commerceAutomations wizardFeatures")
    .lean();
  if (!client) return { ok: false, reason: "client_not_found" };

  const base =
    Array.isArray(client.commerceAutomations) && client.commerceAutomations.length
      ? client.commerceAutomations
      : mergeSystemAutomations([]);
  let rules = mergeSystemAutomations(base);
  const patched = [];

  const codEnabled = f.enableOrderConfirmTpl !== false;
  const codDelay = clampNum(
    f.codConfirmationMinutes ??
      wizardData.codConfirmationMinutes ??
      client.wizardFeatures?.codConfirmationMinutes,
    0,
    180,
    10
  );

  rules = rules.map((rule) => {
    if (rule.id === "sys_commerce_cod_confirm") {
      const next = {
        ...rule,
        isActive: codEnabled,
        templateName: rule.templateName || "cod_confirmation_v1",
        delayMinutes: codDelay,
      };
      if (next.isActive !== rule.isActive || next.delayMinutes !== rule.delayMinutes) {
        patched.push("sys_commerce_cod_confirm");
      }
      return next;
    }
    return rule;
  });

  const cartEnabled = f.enableAbandonedCart !== false;
  const ct = wizardData.cartTiming || {};
  const cartDelays = {
    followup_1: clampNum(
      f.cartNudgeMinutes1 ?? ct.msg1 ?? client.wizardFeatures?.cartNudgeMinutes1,
      1,
      1440,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_1
    ),
    followup_2: clampNum(
      (f.cartNudgeHours2 ?? ct.msg2 ?? client.wizardFeatures?.cartNudgeHours2) * 60,
      1,
      10080,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_2
    ),
    followup_3: clampNum(
      (f.cartNudgeHours3 ?? ct.msg3 ?? client.wizardFeatures?.cartNudgeHours3) * 60,
      1,
      43200,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_3
    ),
  };

  const tplBySlot = {};
  for (const tpl of wizardData.templates || []) {
    const slot = tpl.__slotRow?.slot?.id || tpl.slotId || tpl.id;
    const name = tpl.name || tpl.metaName;
    if (slot && name) tplBySlot[slot] = name;
    if (name === "cart_recovery_1") tplBySlot.cart_recovery_1 = name;
    if (name === "cart_recovery_2") tplBySlot.cart_recovery_2 = name;
    if (name === "cart_recovery_3") tplBySlot.cart_recovery_3 = name;
  }

  rules = rules.map((rule) => {
    const slot = rule.meta?.systemSlot;
    if (!slot || !["followup_1", "followup_2", "followup_3"].includes(slot)) return rule;
    const tplName =
      tplBySlot[`cart_recovery_${String(slot).replace(/\D/g, "")}`] ||
      tplBySlot[`cart_recovery_${slot === "followup_1" ? 1 : slot === "followup_2" ? 2 : 3}`] ||
      rule.templateName;
    const next = {
      ...rule,
      isActive: cartEnabled,
      delayMinutes: cartDelays[slot] ?? rule.delayMinutes,
      ...(tplName ? { templateName: tplName } : {}),
    };
    if (
      next.isActive !== rule.isActive ||
      next.delayMinutes !== rule.delayMinutes ||
      (tplName && tplName !== rule.templateName)
    ) {
      patched.push(rule.id);
    }
    return next;
  });

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        commerceAutomations: rules,
        commerceAutomationVersion: 3,
      },
    }
  );

  try {
    const { emitToClient } = require("../core/socket");
    emitToClient(clientId, "commerceAutomationsChanged", {
      clientId,
      at: new Date().toISOString(),
    });
  } catch (_) {
    /* non-fatal */
  }

  const rtoPatch = {
    "rtoProtection.requireCodConfirmation": false,
  };
  if (codEnabled) {
    rtoPatch["rtoProtection.codConfirmationHours"] = Math.max(
      1,
      Math.ceil(codDelay / 60) || 24
    );
  }
  await Client.findOneAndUpdate({ clientId }, { $set: rtoPatch });

  if (patched.length) {
    log.info(`[Wizard] commerce automations synced for ${clientId}: ${patched.join(", ")}`);
  }

  return { ok: true, patched };
}

module.exports = { syncWizardCommerceAutomations };
