"use strict";

const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const ShopifyProduct = require("../models/ShopifyProduct");
const log = require("./logger")("FlowMpmPatch");

const MAX_PER_SECTION = 10;
const STOP_WORDS = new Set([
  "m1", "m2", "mpm", "carousel", "catalog", "our", "the", "and", "for", "here", "are", "tap",
  "view", "items", "browse", "whatsapp", "picks", "highlights", "kits", "lines",
]);

/** Apex seed flow — optional explicit keywords per node (overrides auto-derive) */
const APEX_NODE_KEYWORDS = {
  n_cat_tv_pl: ["tv", "television", "hdmi", "backlight", "sync tv"],
  n_cat_monitor_pl: ["monitor", "screen sync"],
  n_cat_govee_pl: ["govee"],
  n_cat_floor_pl: ["floor", "table lamp", "uplighter", "standing", "lamp"],
  n_cat_gaming_pl: ["gaming", "game", "bar light", "triangle", "hexagon", "wall light", "wall line"],
  n_cat_strip_pl: ["strip", "neon", "rope light", "cob", "edge light"],
};

function deriveKeywordsFromNode(node) {
  if (APEX_NODE_KEYWORDS[node.id]) return APEX_NODE_KEYWORDS[node.id];

  const raw = [node.data?.sectionTitle, node.data?.header, node.data?.label]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return raw
    .split(/[\s,—–\-|/]+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, "").trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function matchesKeywords(product, keywords) {
  if (!keywords.length) return false;
  const haystack = [
    product.title,
    product.variantTitle,
    product.productType,
    product.vendor,
    ...(product.collectionTitles || []),
    ...(product.tags || []),
  ]
    .join(" ")
    .toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

function buildPatchesForNodes(mpmNodes, products) {
  const patches = {};

  for (const node of mpmNodes) {
    const keywords = deriveKeywordsFromNode(node);
    let matched = products.filter((p) => matchesKeywords(p, keywords));
    matched.sort((a, b) => (a.price || 0) - (b.price || 0));
    matched = matched.slice(0, MAX_PER_SECTION);

    if (!matched.length) continue;

    const ids = matched.map((p) => String(p.shopifyVariantId));
    patches[node.id] = {
      productIds: ids.join(","),
      thumbnailProductRetailerId: ids[0],
      count: ids.length,
    };
  }

  return patches;
}

/**
 * Auto-fill productIds on all mpm_template catalog nodes in the client's published flow.
 */
async function autoPatchMpmFlowNodes(clientId, opts = {}) {
  const flowId = opts.flowId;
  const flowQuery = { clientId, status: "PUBLISHED" };
  if (flowId) flowQuery.flowId = flowId;

  const flowDoc = await WhatsAppFlow.findOne(flowQuery).sort({ updatedAt: -1 }).lean();
  if (!flowDoc?.nodes?.length) {
    log.warn(`[FlowMpmPatch] No published flow for ${clientId}`);
    return { patched: 0, flowId: null };
  }

  const products = await ShopifyProduct.find({ clientId, inStock: true })
    .select("shopifyVariantId title variantTitle productType collectionTitles tags vendor price")
    .lean();

  if (!products.length) {
    log.warn(`[FlowMpmPatch] No cached products for ${clientId}`);
    return { patched: 0, flowId: flowDoc.flowId };
  }

  const mpmNodes = flowDoc.nodes.filter(
    (n) => n.type === "catalog" && n.data?.catalogType === "mpm_template"
  );
  if (!mpmNodes.length) {
    return { patched: 0, flowId: flowDoc.flowId, message: "No mpm_template nodes" };
  }

  const patches = buildPatchesForNodes(mpmNodes, products);
  if (!Object.keys(patches).length) {
    return { patched: 0, flowId: flowDoc.flowId, message: "No keyword matches" };
  }

  const patchNodes = (nodes) =>
    (nodes || []).map((n) => {
      const p = patches[n.id];
      if (!p) return n;
      return {
        ...n,
        data: {
          ...n.data,
          productIds: p.productIds,
          thumbnailProductRetailerId: p.thumbnailProductRetailerId,
        },
      };
    });

  const newNodes = patchNodes(flowDoc.nodes);
  const newPublished = patchNodes(flowDoc.publishedNodes || flowDoc.nodes);

  await WhatsAppFlow.updateOne(
    { _id: flowDoc._id },
    { $set: { nodes: newNodes, publishedNodes: newPublished, updatedAt: new Date() } }
  );

  const client = await Client.findOne({ clientId }).select("visualFlows").lean();
  const vfIndex = (client?.visualFlows || []).findIndex((f) => f.id === flowDoc.flowId);
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId, "visualFlows.id": flowDoc.flowId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: patchNodes(client.visualFlows[vfIndex].nodes),
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  const patched = Object.keys(patches).length;
  log.info(`[FlowMpmPatch] ${clientId} flow=${flowDoc.flowId} patched ${patched} MPM nodes`);

  return { patched, flowId: flowDoc.flowId, patches };
}

module.exports = {
  autoPatchMpmFlowNodes,
  buildPatchesForNodes,
  deriveKeywordsFromNode,
  APEX_NODE_KEYWORDS,
};
