"use strict";

/**
 * Keeps wizard / product Meta templates visually aligned with the live Shopify catalog:
 * after approval (and on periodic sync), refresh IMAGE header + imageUrl from the product handle.
 */

const Client = require("../models/Client");
const { withShopifyRetry } = require("./shopifyHelper");
const log = require("./logger")("TemplateImageHydrate");

function patchTemplateHeaderImage(components, imageUrl) {
  if (!imageUrl || !Array.isArray(components)) {
    return Array.isArray(components) ? [...components] : [];
  }
  return components.map((c) => {
    const t = String(c.type || "").toUpperCase();
    const f = String(c.format || "").toUpperCase();
    if (t !== "HEADER" || f !== "IMAGE") return { ...c };
    return {
      ...c,
      _imageUrl: imageUrl,
      example: { header_handle: [imageUrl] },
    };
  });
}

function isWizardProductTemplate(tpl) {
  if (!tpl) return false;
  return String(tpl.name || "").startsWith("prod_") || tpl.source === "wizard_product";
}

async function fetchShopifyProductImageByHandle(clientId, handle) {
  if (!clientId || !handle) return null;
  const h = String(handle).trim();
  if (!h) return null;
  try {
    const product = await withShopifyRetry(clientId, async (shop) => {
      const r = await shop.get(
        `/products.json?handle=${encodeURIComponent(h)}&fields=images,handle,title`
      );
      return r.data?.products?.[0];
    });
    return product?.images?.[0]?.src || null;
  } catch (e) {
    log.warn(`[Hydrate] Shopify image fetch failed (${h}): ${e.message}`);
    return null;
  }
}

/**
 * @param {string} clientId
 * @param {object} tpl — messageTemplates row (mutated copy returned)
 * @param {{ force?: boolean, maxAgeMs?: number }} opts
 */
async function hydrateProductTemplateRecord(clientId, tpl, opts = {}) {
  const { force = false, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = opts;
  if (!isWizardProductTemplate(tpl)) return tpl;
  const handle = tpl.productHandle || "";
  if (!handle) return tpl;
  const st = String(tpl.status || "").toUpperCase();
  if (st !== "APPROVED") return tpl;

  const last = tpl.lastImageHydrateAt ? new Date(tpl.lastImageHydrateAt).getTime() : 0;
  const ageOk = last && Date.now() - last < maxAgeMs;
  if (ageOk && tpl.imageUrl && !force) return tpl;

  const img = await fetchShopifyProductImageByHandle(clientId, handle);
  if (!img) return tpl;

  const patched = patchTemplateHeaderImage(tpl.components || [], img);
  const header = (tpl.components || []).find((c) => String(c.type || "").toUpperCase() === "HEADER");
  const headerImg = header?._imageUrl || header?.example?.header_handle?.[0];
  if (!force && img === tpl.imageUrl && headerImg === img) return tpl;

  return {
    ...tpl,
    imageUrl: img,
    components: patched,
    lastImageHydrateAt: new Date(),
  };
}

/**
 * Scan all messageTemplates for approved product templates and refresh stale imagery.
 * @param {object} clientDoc — lean or mongoose doc with clientId + messageTemplates
 */
async function hydrateApprovedProductTemplatesForClient(clientDoc, opts = {}) {
  const clientId = clientDoc.clientId;
  const messageTemplates = Array.isArray(clientDoc.messageTemplates) ? clientDoc.messageTemplates : [];
  const out = [];
  let changed = 0;
  for (const tpl of messageTemplates) {
    const next = await hydrateProductTemplateRecord(clientId, tpl, opts);
    if (next.imageUrl !== tpl.imageUrl || String(next.lastImageHydrateAt || "") !== String(tpl.lastImageHydrateAt || "")) {
      changed += 1;
    }
    out.push(next);
  }
  if (changed > 0) {
    await Client.updateOne({ clientId }, { $set: { messageTemplates: out } });
    log.info(`[Hydrate] Updated ${changed} product template image(s) for ${clientId}`);
  }
  return { updated: changed, templates: out };
}

module.exports = {
  patchTemplateHeaderImage,
  fetchShopifyProductImageByHandle,
  hydrateProductTemplateRecord,
  hydrateApprovedProductTemplatesForClient,
  isWizardProductTemplate,
};
