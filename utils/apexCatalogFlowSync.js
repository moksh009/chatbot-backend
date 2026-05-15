"use strict";

/**
 * Sync Apex Light explore menu (2 sections × 5 rows) + MPM nodes from Meta collections.
 */

const WhatsAppFlow = require("../models/WhatsAppFlow");
const Client = require("../models/Client");
const ShopifyCollection = require("../models/ShopifyCollection");
const ShopifyProduct = require("../models/ShopifyProduct");
const {
  APEX_CATALOG_SLOTS,
  MENU_NODE_ID,
  TOP_SECTION_TITLE,
  MORE_SECTION_TITLE,
  ROWS_PER_SECTION,
  injectApexCatalogGraph,
} = require("../data/apexCatalogSlots");
const log = require("./logger")("ApexCatalogFlowSync");

const DEFAULT_FLOW_ID = "flow_apex_owner_support_hub_v2";
const MAX_MENU_ROWS = 10;
const MAX_PRODUCTS_PER_MPM = 10;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBestsellerCollection(collections) {
  return collections.find((c) => {
    const t = norm(c.title);
    return (
      t.includes("best seller") ||
      t.includes("bestseller") ||
      t.includes("best selling") ||
      t.includes("top seller")
    );
  });
}

function scoreCollectionForSlot(collection, slot) {
  const title = norm(collection.title);
  const label = norm(collection.whatsappMenuLabel || collection.title);
  let score = 0;
  for (const term of slot.matchTerms || []) {
    const t = norm(term);
    if (!t) continue;
    if (title.includes(t) || label.includes(t)) score += t.length + 2;
  }
  if (slot.menuRowId === "cat_gaming" && title.includes("wall") && !title.includes("gaming")) {
    score -= 8;
  }
  if (slot.menuRowId === "cat_wall" && title.includes("gaming")) score -= 4;
  if (slot.menuRowId === "cat_hdmi" && title.includes("all product")) score -= 6;
  if ((collection.productsCount || 0) > 0) score += 1;
  return score;
}

function assignCollectionsToSlots(collections, slots = APEX_CATALOG_SLOTS) {
  const available = [...collections].sort((a, b) => (b.productsCount || 0) - (a.productsCount || 0));
  const assignments = [];
  const used = new Set();

  const bsSlot = slots.find((s) => s.menuRowId === "cat_bestseller");
  let bsCol = findBestsellerCollection(available);
  if (bsSlot) {
    if (bsCol) {
      used.add(bsCol.shopifyCollectionId);
      assignments.push({ slot: bsSlot, collection: bsCol, score: 100, isBestseller: true });
    } else if (available.length) {
      bsCol = available[0];
      used.add(bsCol.shopifyCollectionId);
      assignments.push({
        slot: bsSlot,
        collection: bsCol,
        score: 0,
        isBestseller: true,
        fallback: true,
      });
    }
  }

  for (const slot of slots) {
    if (assignments.some((a) => a.slot.menuRowId === slot.menuRowId)) continue;

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
    } else {
      const fallback = available.find((c) => !used.has(c.shopifyCollectionId));
      if (fallback) {
        used.add(fallback.shopifyCollectionId);
        assignments.push({ slot, collection: fallback, score: 0, fallback: true });
      }
    }
  }

  return assignments;
}

function productsForCollection(products, collectionId, sortMode = "price_asc") {
  const cid = String(collectionId);
  let matched = products.filter(
    (p) =>
      p.inStock !== false &&
      Array.isArray(p.collectionIds) &&
      p.collectionIds.map(String).includes(cid)
  );
  if (sortMode === "price_desc") {
    matched.sort((a, b) => (b.price || 0) - (a.price || 0));
  } else {
    matched.sort((a, b) => (a.price || 0) - (b.price || 0));
  }
  return matched.slice(0, MAX_PRODUCTS_PER_MPM);
}

function menuLabel(collection, slot) {
  let raw = String(collection.whatsappMenuLabel || collection.title || slot?.defaultTitle || "Products").trim();
  raw = raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (slot?.menuRowId === "cat_bestseller" && !raw.startsWith("🔥")) {
    raw = `🔥 ${raw}`;
  }
  if (raw.length <= 24) return raw;
  const cut = raw.slice(0, 24);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut.slice(0, 23)).trim();
}

function menuDescription(collection, slot) {
  const n = collection.productsCount || 0;
  if (n > 0) {
    const prefix = slot?.menuRowId === "cat_bestseller" ? "🔥 " : "";
    return `${prefix}${n} item${n === 1 ? "" : "s"}`.slice(0, 72);
  }
  return String(slot?.defaultDescription || "Browse products").slice(0, 72);
}

function buildExploreMenuSections(assignments) {
  const rows = assignments.map(({ slot, collection }) => ({
    id: slot.menuRowId,
    title: menuLabel(collection, slot),
    description: menuDescription(collection, slot),
  }));

  const topRows = rows.slice(0, ROWS_PER_SECTION);
  const moreRows = rows.slice(ROWS_PER_SECTION, MAX_MENU_ROWS);

  const sections = [];
  if (topRows.length) {
    sections.push({ title: TOP_SECTION_TITLE.slice(0, 24), rows: topRows });
  }
  if (moreRows.length) {
    sections.push({ title: MORE_SECTION_TITLE.slice(0, 24), rows: moreRows });
  }
  return sections;
}

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
    log.warn(`[ApexCatalogFlowSync] No products in Mongo for ${clientId}`);
    return { ok: false, reason: "no_products", menuUpdated: false, mpmPatched: 0 };
  }

  const flowDoc = await WhatsAppFlow.findOne({ clientId, flowId, status: "PUBLISHED" }).lean();
  if (!flowDoc?.nodes?.length) {
    return { ok: false, reason: "no_flow", flowId };
  }

  let nodes = [...flowDoc.nodes];
  let edges = [...(flowDoc.edges || flowDoc.publishedEdges || [])];
  ({ nodes, edges } = injectApexCatalogGraph(nodes, edges));

  const assignments = assignCollectionsToSlots(collections);
  const menuSections = buildExploreMenuSections(assignments);
  const mpmPatches = {};

  for (const { slot, collection, isBestseller } of assignments) {
    const label = menuLabel(collection, slot);
    const sortMode = slot.sortProducts || (isBestseller ? "price_desc" : "price_asc");

    let matched = productsForCollection(products, collection.shopifyCollectionId, sortMode);
    if (!matched.length) {
      const titleNorm = norm(collection.title);
      matched = products
        .filter((p) => {
          const hay = norm([p.title, ...(p.collectionTitles || []), ...(p.tags || [])].join(" "));
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

  const patchNodes = (nodeList) =>
    nodeList.map((n) => {
      if (n.id === MENU_NODE_ID) {
        return {
          ...n,
          data: {
            ...n.data,
            buttonText: "Explore products",
            text:
              "✨ *Explore Apex Light*\n\n" +
              "Pick a category below — *Best Sellers* and top collections first, then more ranges.\n\n" +
              "Each opens a WhatsApp product carousel (tap *View items* on the next message).",
            sections: menuSections,
          },
        };
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
          text: `*${mp.sectionTitle}* — tap *View items* to browse ${mp.count} products in WhatsApp.`,
          body: `*${mp.sectionTitle}* — tap *View items* to browse ${mp.count} products in WhatsApp.`,
        },
      };
    });

  const newNodes = patchNodes(nodes);
  const newEdges = edges;

  await WhatsAppFlow.updateOne(
    { _id: flowDoc._id },
    {
      $set: {
        nodes: newNodes,
        edges: newEdges,
        publishedNodes: newNodes,
        publishedEdges: newEdges,
        updatedAt: new Date(),
      },
    }
  );

  const client = await Client.findOne({ clientId }).select("visualFlows").lean();
  const vfIndex = (client?.visualFlows || []).findIndex((f) => f.id === flowId);
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId, "visualFlows.id": flowId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: patchNodes(client.visualFlows[vfIndex].nodes),
          [`visualFlows.${vfIndex}.edges`]: newEdges,
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  log.info(
    `[ApexCatalogFlowSync] ${clientId} sections=${menuSections.length} rows=${assignments.length} mpm=${Object.keys(mpmPatches).length}`
  );

  return {
    ok: true,
    flowId,
    collectionsInDb: collections.length,
    menuSections: menuSections.map((s) => ({ title: s.title, rows: s.rows.length })),
    assignments: assignments.map((a) => ({
      slot: a.slot.menuRowId,
      collection: a.collection.title,
      products: mpmPatches[a.slot.nodeId]?.count || 0,
      isBestseller: !!a.isBestseller,
      fallback: !!a.fallback,
    })),
    menuUpdated: true,
    mpmPatched: Object.keys(mpmPatches).length,
  };
}

module.exports = {
  syncApexCatalogFlowFromMeta,
  assignCollectionsToSlots,
  buildExploreMenuSections,
  APEX_CATALOG_SLOTS,
  MENU_NODE_ID,
  DEFAULT_FLOW_ID,
};
