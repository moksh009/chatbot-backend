"use strict";

const Client = require("../models/Client");
const { getSlotById, getCatalogGroups } = require("../constants/templateCatalog/catalog");
const { STANDARD_TEMPLATES } = require("../constants/standardTemplates");
const { getOrderMessageBlueprint } = require("../constants/orderMessageWaBlueprints");
const { getPrebuiltByKey } = require("../constants/prebuiltTemplateLibrary");

const MULTI_STORE_MODEL = {
  id: "one_client_one_waba",
  label: "One workspace (clientId) = one WhatsApp Business Account",
  description:
    "Multiple Shopify stores under the same client share one WABA and the same approved Meta templates. Per-store copy is applied via brand overrides and order/cart context at send time.",
};

const PATCHABLE_FIELDS = [
  "headerImageUrl",
  "bodyText",
  "footerText",
  "variableMappings",
  "disabled",
];

function normalizeOverridesMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw instanceof Map) {
    const out = {};
    for (const [k, v] of raw.entries()) out[k] = v;
    return out;
  }
  return { ...raw };
}

function getClientOverrides(client) {
  return normalizeOverridesMap(client?.templateBrandOverrides);
}

function getOverrideForSlot(client, slotId) {
  if (!slotId) return null;
  const overrides = getClientOverrides(client);
  const hit = overrides[slotId];
  return hit && typeof hit === "object" ? hit : null;
}

/** Customer-facing default body — blueprints / prebuilt library, not catalog slot.description. */
function resolveCatalogDefaultBody(slot, eco) {
  const ecoBody = eco?.components?.find((c) => c.type === "BODY")?.text;
  if (ecoBody) return ecoBody;

  const seedKey = slot.prebuiltKey || slot.canonicalMetaName || slot.id;
  const blueprint = getOrderMessageBlueprint(seedKey);
  const blueprintBody = blueprint?.components?.find(
    (c) => String(c.type).toUpperCase() === "BODY"
  )?.text;
  if (blueprintBody) return blueprintBody;

  const prebuilt = getPrebuiltByKey(seedKey);
  if (prebuilt?.bodyText) return prebuilt.bodyText;

  return "";
}

function sanitizeOverridePatch(patch = {}) {
  const out = {};
  if (patch.headerImageUrl !== undefined) {
    out.headerImageUrl = String(patch.headerImageUrl || "").trim() || null;
  }
  if (patch.bodyText !== undefined) {
    out.bodyText = String(patch.bodyText || "").trim() || null;
  }
  if (patch.footerText !== undefined) {
    out.footerText = String(patch.footerText || "").trim() || null;
  }
  if (patch.variableMappings !== undefined) {
    out.variableMappings =
      patch.variableMappings && typeof patch.variableMappings === "object"
        ? patch.variableMappings
        : null;
  }
  if (patch.disabled !== undefined) {
    out.disabled = !!patch.disabled;
  }
  out.updatedAt = new Date();
  return out;
}

async function listOverridesForClient(clientId) {
  const client = await Client.findOne({ clientId })
    .select("templateBrandOverrides brand.businessName businessName")
    .lean();
  if (!client) return null;

  const overrides = getClientOverrides(client);
  const groups = getCatalogGroups();
  const ecoById = new Map(STANDARD_TEMPLATES.map((t) => [t.id, t]));

  const slots = [];
  for (const group of groups) {
    for (const slot of group.slots || []) {
      const eco = ecoById.get(slot.id);
      const ov = overrides[slot.id] || null;
      const defaultBody = resolveCatalogDefaultBody(slot, eco);
      const defaultFooter =
        eco?.components?.find((c) => c.type === "FOOTER")?.text || "";
      const defaultHeader =
        eco?.components?.find((c) => c.type === "HEADER" && c.format === "IMAGE")
          ?.example?.header_handle?.[0] || null;

      slots.push({
        slotId: slot.id,
        title: slot.title,
        canonicalMetaName: slot.canonicalMetaName,
        pushKind: slot.pushKind,
        hasEcoStarter: !!eco,
        defaults: {
          headerImageUrl: defaultHeader,
          bodyText: defaultBody,
          footerText: defaultFooter,
        },
        override: ov,
        effective: {
          headerImageUrl: ov?.headerImageUrl || defaultHeader,
          bodyText: ov?.bodyText || defaultBody,
          footerText: ov?.footerText || defaultFooter,
          disabled: !!ov?.disabled,
        },
      });
    }
  }

  return {
    clientId,
    multiStoreModel: MULTI_STORE_MODEL,
    slots,
  };
}

async function patchOverrideForSlot(clientId, slotId, patch) {
  const slot = getSlotById(slotId);
  if (!slot) {
    const err = new Error("Unknown catalog slot");
    err.status = 404;
    throw err;
  }

  const sanitized = sanitizeOverridePatch(patch);
  const key = `templateBrandOverrides.${slotId}`;

  if (patch.clear === true) {
    await Client.updateOne({ clientId }, { $unset: { [key]: "" } });
    return { slotId, cleared: true };
  }

  const client = await Client.findOne({ clientId }).select("templateBrandOverrides").lean();
  const existing = getOverrideForSlot(client, slotId) || {};
  const merged = { ...existing, ...sanitized };

  const allEmpty =
    !merged.headerImageUrl &&
    !merged.bodyText &&
    !merged.footerText &&
    !merged.variableMappings &&
    !merged.disabled;

  if (allEmpty) {
    await Client.updateOne({ clientId }, { $unset: { [key]: "" } });
    return { slotId, cleared: true };
  }

  await Client.updateOne({ clientId }, { $set: { [key]: merged } });
  return { slotId, override: merged };
}

function applyOverridesToStandardTemplate(standardTemplate, slotId, client) {
  const ov = getOverrideForSlot(client, slotId);
  if (!ov || ov.disabled) {
    return { template: standardTemplate, applied: false, skipped: !!ov?.disabled };
  }

  const tpl = JSON.parse(JSON.stringify(standardTemplate));

  if (ov.bodyText) {
    const body = tpl.components?.find((c) => c.type === "BODY");
    if (body) body.text = ov.bodyText;
  }
  if (ov.footerText) {
    const footer = tpl.components?.find((c) => c.type === "FOOTER");
    if (footer) footer.text = ov.footerText;
  }
  const headerUrl = ov.headerImageUrl;
  if (headerUrl) {
    const header = tpl.components?.find((c) => c.type === "HEADER" && c.format === "IMAGE");
    if (header) {
      header.example = { header_handle: [headerUrl] };
    }
  }

  return { template: tpl, applied: true };
}

function mergeSendOverrides({ templatePayload, slotId, client }) {
  const ov = getOverrideForSlot(client, slotId);
  if (!ov || ov.disabled) {
    return { ...templatePayload, _sendDisabled: !!ov?.disabled };
  }

  const merged = { ...templatePayload };
  if (ov.variableMappings) {
    merged.variableMappings = ov.variableMappings;
  }
  if (ov.headerImageUrl) {
    merged._headerImageOverride = ov.headerImageUrl;
  }
  return merged;
}

/** Resolve a header IMAGE URL for templates that declare a HEADER:IMAGE.
 *  WS-2 C3: previously the production sender only checked
 *  `first_product_image`/`brand_logo_url` on the context, neither of which
 *  is populated by `orderStatusAutomationHandler.buildContextOrder`. That
 *  made every eco_* template (which all require an image header) fail at
 *  Meta with a missing-header error while the test-send button worked.
 *
 *  Fallback chain (first non-empty wins):
 *    1. Per-slot brand override
 *    2. Template payload override
 *    3. context.first_product_image  → context.brand_logo_url
 *    4. first item image from context/payload
 *    5. client.brand.logoUrl / businessLogo
 *    6. nicheData.brandLogoUrl / brandLogo / businessLogo
 *    7. nicheData.bannerImageUrl
 *    8. null — caller's `buildMetaTemplateComponents` will omit the
 *       header, which Meta will then reject if it is required — surfaced
 *       to merchant as `template_send_failed` (preferable to silent gaps).
 */
function resolveHeaderImageUrl(context = {}, template, client, slotId) {
  const ov = getOverrideForSlot(client, slotId);
  if (ov?.headerImageUrl) return ov.headerImageUrl;
  if (template?._headerImageOverride) return template._headerImageOverride;

  const mappings = template?.variableMappings || template?.variableMapping || {};
  const headerKey = mappings.header || mappings.headerVariable || template?.headerVariable;
  if (headerKey) {
    const key = String(headerKey);
    const fromContext = context[key];
    if (fromContext && /^https?:\/\//i.test(String(fromContext))) return fromContext;
    if (key === "first_product_image" && context.first_product_image) return context.first_product_image;
    if (key === "brand_logo_url" && context.brand_logo_url) return context.brand_logo_url;
  }

  if (context.first_product_image) return context.first_product_image;
  if (context.brand_logo_url) return context.brand_logo_url;

  const items =
    context?.order?.line_items ||
    context?.lead?.cartSnapshot?.items ||
    context?.cartItems ||
    [];
  const itemImage = Array.isArray(items) && items[0]
    ? items[0].image || items[0].image_url || items[0].imageUrl || null
    : null;
  if (itemImage && /^https?:\/\//i.test(itemImage)) return itemImage;

  const brandLogo =
    client?.brand?.logoUrl ||
    client?.brand?.businessLogo ||
    client?.businessLogo ||
    client?.brandLogo ||
    client?.nicheData?.brandLogoUrl ||
    client?.nicheData?.brandLogo ||
    client?.nicheData?.businessLogo ||
    client?.nicheData?.bannerImageUrl ||
    null;
  if (brandLogo && /^https?:\/\//i.test(brandLogo)) return brandLogo;

  return null;
}

module.exports = {
  MULTI_STORE_MODEL,
  PATCHABLE_FIELDS,
  getClientOverrides,
  getOverrideForSlot,
  listOverridesForClient,
  patchOverrideForSlot,
  applyOverridesToStandardTemplate,
  mergeSendOverrides,
  resolveHeaderImageUrl,
};
