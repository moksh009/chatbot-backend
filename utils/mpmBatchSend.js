"use strict";

/** Meta MPM / product-list UI shows up to 10 SKUs per message — batch larger sets. */
const MPM_ITEMS_PER_MESSAGE = 10;

function parseProductIds(raw) {
  return String(raw || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id) => !/^SHOPIFY_/i.test(id));
}

function chunkIds(ids, size = MPM_ITEMS_PER_MESSAGE) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

/**
 * Send one or more MPM template messages (10 products max per WhatsApp carousel open).
 */
async function sendMpmInBatches(WhatsApp, client, phone, opts = {}) {
  const ids = Array.isArray(opts.productIds) ? opts.productIds : parseProductIds(opts.productIds);
  if (!ids.length) throw new Error("sendMpmInBatches requires productIds");

  const templateName = opts.templateName;
  const chunks = chunkIds(ids, opts.perMessage || MPM_ITEMS_PER_MESSAGE);
  const sectionTitle = opts.sectionTitle || "Products";
  const total = ids.length;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const partNum = i + 1;
    const partTotal = chunks.length;
    const headerCount = String(chunk.length);

    let bodyVariables = opts.bodyVariables;
    if (partTotal > 1) {
      const section = String(sectionTitle).substring(0, 40);
      if (partNum === 1) {
        bodyVariables =
          opts.bodyVariables ||
          `Showing ${section} — part ${partNum} of ${partTotal} (${total} items). Tap View items on each message.`;
      } else {
        bodyVariables = `More from ${section} — part ${partNum} of ${partTotal}. Tap View items.`;
      }
    }

    await WhatsApp.sendMpmMarketingTemplate(client, phone, {
      templateName,
      languageCode: opts.languageCode || "en",
      bodyVariables,
      mpmHeaderText: headerCount,
      headerText: headerCount,
      headerImage: opts.headerImage || null,
      thumbnailProductRetailerId: chunk[0],
      productIds: chunk.join(","),
      sectionTitle:
        partTotal > 1
          ? `${String(sectionTitle).substring(0, 16)} ${partNum}/${partTotal}`.substring(0, 24)
          : sectionTitle,
      mpmButtonIndex: opts.mpmButtonIndex,
    });

    if (i < chunks.length - 1 && opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }

  return { sent: chunks.length, totalProducts: total };
}

module.exports = {
  MPM_ITEMS_PER_MESSAGE,
  parseProductIds,
  chunkIds,
  sendMpmInBatches,
};
