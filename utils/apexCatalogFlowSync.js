"use strict";

/**
 * Sync Apex Light explore menu + MPM nodes from Meta-imported collections (Mongo).
 * Keeps fixed list row ids (cat_tv, …) and flow edges intact — only updates labels & product IDs.
 */

const WhatsAppFlow = require("../models/WhatsAppFlow");
const Client = require("../models/Client");
const ShopifyCollection = require("../models/ShopifyCollection");
const ShopifyProduct = require("../models/ShopifyProduct");
const log = require("./logger")("ApexCatalogFlowSync");

const DEFAULT_FLOW_ID = "flow_apex_owner_support_hub_v2";
const MENU_NODE_ID = "n_product_menu";
const MAX_MENU_ROWS = 10;
const MAX_PRODUCTS_PER_MPM = 10;

/** Fixed slots — row id + MPM node id + keywords to match Meta product sets / collections */
const APEX_CATALOG_SLOTS = [
  { menuRowId: "cat_tv", nodeId: "n_cat_tv_pl", matchTerms: ["tv", "television", "hdmi", "backlight", "sync tv"] },
  { menuRowId: "cat_monitor", nodeId: "n_cat_monitor_pl", matchTerms: ["monitor", "screen sync", "pc", "desk"] },
  { menuRowId: "cat_govee", nodeId: "n_cat_govee_pl", matchTerms: ["govee"] },
  { menuRowId: "cat_floor", nodeId: "n_cat_floor_pl", matchTerms: ["floor", "table lamp", "uplighter", "standing", "lamp"] },
  { menuRowId: "cat_gaming", nodeId: "n_cat_gaming_pl", matchTerms: ["gaming", "game", "bar light", "triangle", "hexagon", "wall"] },
  { menuRowId: "cat_strip", nodeId: "n_cat_strip_pl", matchTerms: ["strip", "neon", "rope", "cob", "edge"] },
];

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCollectionForSlot(collection, slot) {
  const title = norm(collection.title);
  const label = norm(collection.whatsappMenuLabel || collection.title);
  let score = 0;
  for (const term of slot.matchTerms) {
    const t = norm(term);
    if (!t) continue;
    if (title.includes(t) || label.includes(t)) score += t.length + 2;
  }
  if ((collection.productsCount || 0) > 0) score += 1;
  return score;
}

function assignCollectionsToSlots(collections, slots = APEX_CATALOG_SLOTS) {
  const available = [...collections].sort((a, b) => (b.productsCount || 0) - (a.productsCount || 0));
  const assignments = [];
  const used = new Set();

  for (const slot of slots) {
    let best = null;
    let bestScore = 0;
    for (const col of available) {
      if (used.has(col.shopifyCollectionId)) continue;
      const sc = scoreCollectionForSlot(col, slot);
      if (sc > bestScore) {
        bestScore = sc;
        best = col;
      }
    }
    if (best && bestScore > 0) {
      used.add(best.shopifyCollectionId);
      assignments.push({ slot, collection: best, score: bestScore });
    } else if (available.length) {
      const fallback = available.find((c) => !used.has(c.shopifyCollectionId));
      if (fallback) {
        used.add(fallback.shopifyCollectionId);
        assignments.push({ slot, collection: fallback, score: 0, fallback: true });
      }
    }
  }

  return assignments;
}

function productsForCollection(products, collectionId) {
  const cid = String(collectionId);
  return products
    .filter(
      (p) =>
        p.inStock !== false &&
        (Array.isArray(p.collectionIds) ? p.collectionIds.map(String).includes(cid) : false)
    )
    .sort((a, b) => (a.price || 0) - (b.price || 0))
    .slice(0, MAX_PRODUCTS_PER_MPM);
}

function menuLabel(collection) {
  let raw = String(collection.whatsappMenuLabel || collection.title || "Products").trim();
  raw = raw.replace(/\s*\([^)]*$/, "").trim();
  if (raw.length <= 24) return raw;
  const cut = raw.slice(0, 24);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 12 ? cut.slice(0, lastSpace) : cut.slice(0, 23)).trim();
}

function menuDescription(collection) {
  const n = collection.productsCount || 0;
  const base = String(collection.title || "").trim();
  if (n > 0) return `${n} item${n === 1 ? "" : "s"}`.slice(0, 72);
  return base.slice(0, 72) || "Browse products";
}

/**
 * Patch explore list + MPM catalog nodes on the published Apex flow.
 */
async function syncApexCatalogFlowFromMeta(clientId, opts = {}) {
  const flowId = opts.flowId || DEFAULT_FLOW_ID;

  const collections = await ShopifyCollection.find({
    clientId,
    whatsappEnabled: { $ne: false },
  })
    .sort({ sortOrder: 1, productsCount: -1 })
    .lean();

  const products = await ShopifyProduct.find({ clientId, inStock: true })
    .select(
      "shopifyVariantId title variantTitle productType collectionIds collectionTitles tags vendor price inStock"
    )
    .lean();

  if (!products.length) {
    log.warn(`[ApexCatalogFlowSync] No products in Mongo for ${clientId} — run Meta import first`);
    return { ok: false, reason: "no_products", menuUpdated: false, mpmPatched: 0 };
  }

  const flowDoc = await WhatsAppFlow.findOne({
    clientId,
    flowId,
    status: "PUBLISHED",
  }).lean();

  if (!flowDoc?.nodes?.length) {
    return { ok: false, reason: "no_flow", flowId };
  }

  const assignments = assignCollectionsToSlots(collections);
  const menuPatches = {};
  const mpmPatches = {};

  for (const { slot, collection } of assignments) {
    const label = menuLabel(collection);
    const desc = menuDescription(collection);
    menuPatches[slot.menuRowId] = { title: label, description: desc, collectionId: collection.shopifyCollectionId };

    let matched = productsForCollection(products, collection.shopifyCollectionId);
    if (!matched.length) {
      const titleNorm = norm(collection.title);
      matched = products
        .filter((p) => {
          const hay = norm(
            [p.title, ...(p.collectionTitles || []), ...(p.tags || [])].join(" ")
          );
          return titleNorm.split(" ").some((w) => w.length > 2 && hay.includes(w));
        })
        .slice(0, MAX_PRODUCTS_PER_MPM);
    }

    if (!matched.length) continue;

    const ids = matched.map((p) => String(p.shopifyVariantId));
    mpmPatches[slot.nodeId] = {
      productIds: ids.join(","),
      thumbnailProductRetailerId: ids[0],
      sectionTitle: label,
      header: label,
      metaCollectionId: collection.shopifyCollectionId,
      collectionTitle: collection.title,
      count: ids.length,
    };
  }

  const patchNodes = (nodes) =>
    (nodes || []).map((n) => {
      if (n.id === MENU_NODE_ID && n.data?.sections) {
        const sections = (n.data.sections || []).map((sec) => ({
          ...sec,
          rows: (sec.rows || []).map((row) => {
            const mp = menuPatches[row.id];
            if (!mp) return row;
            return {
              ...row,
              title: mp.title || row.title,
              description: mp.description || row.description,
            };
          }),
        }));
        return { ...n, data: { ...n.data, sections } };
      }

      const mp = mpmPatches[n.id];
      if (!mp) return n;
      return {
        ...n,
        data: {
          ...n.data,
          productIds: mp.productIds,
          thumbnailProductRetailerId: mp.thumbnailProductRetailerId,
          sectionTitle: mp.sectionTitle,
          header: mp.header,
          metaCollectionId: mp.metaCollectionId,
          mpmHeaderText: String(mp.count),
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
  const vfIndex = (client?.visualFlows || []).findIndex((f) => f.id === flowId);
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId, "visualFlows.id": flowId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: patchNodes(client.visualFlows[vfIndex].nodes),
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  const menuUpdated = Object.keys(menuPatches).length > 0;
  const mpmPatched = Object.keys(mpmPatches).length;

  log.info(
    `[ApexCatalogFlowSync] ${clientId} menuRows=${Object.keys(menuPatches).length} mpmNodes=${mpmPatched}`
  );

  return {
    ok: true,
    flowId,
    collectionsInDb: collections.length,
    assignments: assignments.map((a) => ({
      slot: a.slot.menuRowId,
      collection: a.collection.title,
      collectionId: a.collection.shopifyCollectionId,
      products: mpmPatches[a.slot.nodeId]?.count || 0,
      fallback: !!a.fallback,
    })),
    menuUpdated,
    mpmPatched,
    menuPatches,
    mpmPatches,
  };
}

module.exports = {
  syncApexCatalogFlowFromMeta,
  assignCollectionsToSlots,
  APEX_CATALOG_SLOTS,
  MENU_NODE_ID,
  DEFAULT_FLOW_ID,
};
