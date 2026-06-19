"use strict";

const { getAllSlots } = require("../../constants/templateCatalog/catalog");
const { getPrebuiltByKey, PREBUILT_TEMPLATE_LIBRARY } = require("../../constants/prebuiltTemplateLibrary");
const { STANDARD_TEMPLATES } = require("../../constants/standardTemplates");

/** Wizard Messages pack slot ids (template-catalog.json, pack: wizard). */
const WIZARD_SLOT_IDS = [
  "admin_human_alert",
  "om_order_confirm",
  "om_cod_confirm",
  "om_shipped_flow",
  "cart_recovery_1",
  "cart_recovery_2",
  "cart_recovery_3",
  "warranty_certificate",
  "eco_cod_prepaid",
];

function libraryEntryToWizardTemplate(entry, opts = {}) {
  if (!entry) return null;
  const components = [];
  const ht = String(entry.headerType || "NONE").toUpperCase();
  if (ht === "IMAGE") {
    components.push({
      type: "HEADER",
      format: "IMAGE",
      _imageUrl: opts.imageUrl || "",
    });
  } else if (ht === "TEXT" && entry.headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: entry.headerText });
  }
  if (entry.bodyText) components.push({ type: "BODY", text: entry.bodyText });
  if (entry.footerText) components.push({ type: "FOOTER", text: entry.footerText });
  if (Array.isArray(entry.buttons) && entry.buttons.length) {
    components.push({ type: "BUTTONS", buttons: entry.buttons });
  }
  const vars = entry.variableMappings?.body
    ? Object.values(entry.variableMappings.body)
    : [];
  return {
    id: opts.id || entry.key,
    name: entry.metaName || entry.key,
    category: entry.category || "UTILITY",
    language: "en",
    status: "not_submitted",
    required: opts.required !== false,
    description: opts.description || entry.displayName || entry.metaName,
    libraryKey: entry.key,
    isPrebuilt: true,
    variableMappings: entry.variableMappings || null,
    components,
    body: entry.bodyText || "",
    variables: vars,
  };
}

function standardEntryToWizardTemplate(stdTpl, slot, opts = {}) {
  if (!stdTpl) return null;
  const components = (stdTpl.components || []).map((c) => {
    const copy = { ...c };
    if (String(copy.type).toUpperCase() === "HEADER" && String(copy.format).toUpperCase() === "IMAGE") {
      copy._imageUrl = opts.imageUrl || "";
    }
    return copy;
  });
  const bodyComp = components.find((c) => String(c.type).toUpperCase() === "BODY");
  return {
    id: stdTpl.id || stdTpl.name,
    name: slot?.canonicalMetaName || stdTpl.name,
    category: stdTpl.category || "UTILITY",
    language: stdTpl.language || "en",
    status: "not_submitted",
    required: !!opts.required,
    description: slot?.title || slot?.description || stdTpl.name,
    libraryKey: null,
    isPrebuilt: true,
    variableMappings: stdTpl.variableMapping ? { body: stdTpl.variableMapping } : null,
    components,
    body: bodyComp?.text || "",
    variables: [],
  };
}

function attachSlotMetadata(tpl, slot) {
  if (!tpl || !slot) return tpl;
  return {
    ...tpl,
    slotId: slot.id,
    catalogUsedIn: slot.usedIn || [],
    eligibleFor: {
      order_status: (slot.usedIn || []).some((u) => /order/i.test(u)),
      campaign: false,
      sequence: (slot.usedIn || []).some((u) => /cart|flow/i.test(u)),
    },
    __slotRow: { slot },
    autoTrigger: slot.autoTrigger || tpl.autoTrigger || null,
  };
}

function shouldIncludeSlot(slotId, features = {}, adminAlertPreferences = "both") {
  const f = features || {};
  switch (slotId) {
    case "admin_human_alert":
      return adminAlertPreferences !== "email";
    case "om_order_confirm":
      return true;
    case "om_cod_confirm":
      return f.enableOrderConfirmTpl !== false;
    case "om_shipped_flow":
      return true;
    case "cart_recovery_1":
    case "cart_recovery_2":
    case "cart_recovery_3":
      return f.enableAbandonedCart !== false;
    case "warranty_certificate":
      return !!f.enableWarranty;
    case "eco_cod_prepaid":
      return !!f.enableCodToPrepaid;
    default:
      return false;
  }
}

function resolvePrebuiltEntry(prebuiltKey) {
  if (!prebuiltKey) return null;
  return (
    getPrebuiltByKey(prebuiltKey) ||
    PREBUILT_TEMPLATE_LIBRARY.find((t) => t.key === prebuiltKey || t.metaName === prebuiltKey) ||
    null
  );
}

function resolveSlotTemplate(slot, wizardData = {}) {
  const imageUrl = wizardData.businessLogo || "";
  const prebuiltKey = slot.prebuiltKey;
  if (prebuiltKey) {
    const entry = resolvePrebuiltEntry(prebuiltKey);
    const tpl = libraryEntryToWizardTemplate(entry, {
      id: slot.id,
      description: slot.title || slot.description,
      required: true,
      imageUrl,
    });
    return attachSlotMetadata(tpl, slot);
  }
  if (slot.pushFromStandard || slot.pushKind === "eco-standard") {
    const std = STANDARD_TEMPLATES.find(
      (t) => t.name === slot.canonicalMetaName || t.id === slot.canonicalMetaName
    );
    const tpl = standardEntryToWizardTemplate(std, slot, { required: false, imageUrl });
    if (tpl && slot.id === "eco_cod_prepaid") {
      tpl.legacyNames = ["cod_to_prepaid", "cod_to_prepaid_discount"];
    }
    return attachSlotMetadata(tpl, slot);
  }
  return null;
}

/**
 * Canonical wizard pack templates — same slots as Meta Manager catalog (pack: wizard).
 */
function getWizardPackTemplates(wizardData = {}) {
  const features = wizardData.features || {};
  const pref = wizardData.adminAlertPreferences || "both";
  const slotsById = new Map(getAllSlots().map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();

  for (const slotId of WIZARD_SLOT_IDS) {
    if (!shouldIncludeSlot(slotId, features, pref)) continue;
    const slot = slotsById.get(slotId);
    if (!slot) continue;
    const tpl = resolveSlotTemplate(slot, wizardData);
    if (!tpl?.name || seen.has(tpl.name)) continue;
    seen.add(tpl.name);
    out.push(tpl);
  }

  return out;
}

function hydrateWizardTemplateStatuses(client, templates) {
  const pendingMap = new Map(
    (client?.pendingTemplates || []).map((t) => [t.name, String(t.status || "PENDING").toUpperCase()])
  );
  const syncedMap = new Map(
    (client?.syncedMetaTemplates || []).map((t) => [t.name, String(t.status || "APPROVED").toUpperCase()])
  );
  const msgMap = new Map(
    (client?.messageTemplates || []).map((t) => [t.name, String(t.status || "").toUpperCase()])
  );

  return templates.map((tpl) => {
    const metaStatus =
      syncedMap.get(tpl.name) ||
      pendingMap.get(tpl.name) ||
      msgMap.get(tpl.name) ||
      tpl.status ||
      "not_submitted";
    const normalized = String(metaStatus).toUpperCase();
    const onMeta = normalized === "APPROVED" || normalized === "PENDING" || normalized === "ACTIVE";
    const samplePreview =
      !onMeta &&
      (normalized === "NOT_SUBMITTED" ||
        normalized === "DRAFT" ||
        normalized === "" ||
        !normalized);

    return {
      ...tpl,
      status: metaStatus,
      __samplePreview: samplePreview,
    };
  });
}

function shouldRefreshDraftFromCatalog(existing, metaStatus) {
  const normalized = String(metaStatus || existing?.status || "").toUpperCase();
  if (normalized === "APPROVED" || normalized === "ACTIVE") return false;
  if (existing?.source && existing.source !== "wizard" && normalized === "PENDING") return false;
  return true;
}

module.exports = {
  WIZARD_SLOT_IDS,
  libraryEntryToWizardTemplate,
  getWizardPackTemplates,
  hydrateWizardTemplateStatuses,
  shouldRefreshDraftFromCatalog,
};
