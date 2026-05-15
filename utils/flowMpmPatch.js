"use strict";

const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const ShopifyCollection = require("../models/ShopifyCollection");
const ShopifyProduct = require("../models/ShopifyProduct");
const log = require("./logger")("FlowMpmPatch");

/** Max SKUs stored on flow node (send logic batches 10 per WhatsApp message). */
const MAX_PER_SECTION = 30;
const MPM_SEND_BATCH_SIZE = 10;
const STOP_WORDS = new Set([
  "m1", "m2", "mpm", "carousel", "catalog", "our", "the", "and", "for", "here", "are", "tap",
  "view", "items", "browse", "whatsapp", "picks", "highlights", "kits", "lines",
]);

/** Apex seed flow — optional explicit keywords per node (overrides auto-derive) */
const APEX_NODE_KEYWORDS = {
  n_cat_bestseller_pl: ["best seller", "bestseller", "top", "popular", "featured"],
  n_cat_tv_pl: ["tv", "television", "hdmi", "backlight", "sync tv"],
  n_cat_monitor_pl: ["monitor", "screen sync"],
  n_cat_govee_pl: ["govee"],
  n_cat_floor_pl: ["floor", "table lamp", "uplighter", "standing", "lamp"],
  n_cat_gaming_pl: ["gaming", "game", "bar light", "triangle", "hexagon", "wall light", "wall line"],
  n_cat_strip_pl: ["strip", "neon", "rope light", "cob", "edge light"],
  n_cat_wall_pl: ["wall", "panel", "hexagon", "triangle", "line"],
  n_cat_hdmi_pl: ["hdmi", "sync box", "accessories"],
  n_cat_smart_pl: ["smart", "stream", "dock"],
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

/** Approved Meta marketing template with MPM / carousel button (tenant-specific name). */
function resolveMpmTemplateNameForClient(client = {}) {
  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const approved = synced.filter((t) => String(t.status || "APPROVED").toUpperCase() === "APPROVED");
  const carousel = approved.find((t) => /carosuel|carousel|mpm/i.test(String(t.name || "")));
  return carousel?.name || approved[0]?.name || "";
}

function applyMpmFieldsToNodeData(data, patch, templateName) {
  const next = { ...data };
  if (patch?.productIds) next.productIds = patch.productIds;
  if (patch?.thumbnailProductRetailerId) {
    next.thumbnailProductRetailerId = patch.thumbnailProductRetailerId;
  }
  if (patch?.sectionTitle) next.sectionTitle = patch.sectionTitle;
  if (patch?.header) next.header = patch.header;
  if (patch?.metaCollectionId) next.metaCollectionId = patch.metaCollectionId;
  if (patch?.count != null) next.mpmHeaderText = String(patch.count);
  const tpl = String(templateName || data.metaTemplateName || data.templateName || "").trim();
  if (tpl) {
    next.metaTemplateName = tpl;
    next.templateName = tpl;
  }
  return next;
}

/**
 * Runtime: fill missing MPM fields from Mongo products + client templates (no flow DB write).
 */
async function enrichMpmNodeDataFromDb(clientId, node) {
  const client = await Client.findOne({ clientId })
    .select("syncedMetaTemplates messageTemplates")
    .lean();
  const products = await ShopifyProduct.find({ clientId, inStock: true })
    .select("shopifyVariantId title variantTitle productType collectionTitles tags vendor price inStock collectionIds")
    .lean();
  if (!products.length) return null;

  const patches = buildPatchesForNodes(
    [{ id: node?.id || "runtime", data: node?.data || {} }],
    products,
    resolveMpmTemplateNameForClient(client)
  );
  const patch = patches[node?.id || "runtime"];
  if (!patch?.productIds) return null;
  return applyMpmFieldsToNodeData(node?.data || {}, patch, resolveMpmTemplateNameForClient(client));
}

/**
 * Ensure every mpm_template node has productIds (slot match → keywords → broad title match).
 */
function fillMissingMpmNodePatches(nodes, products, templateName = "", existingPatches = {}) {
  const patches = { ...existingPatches };
  const mpmNodes = (nodes || []).filter(
    (n) => n.type === "catalog" && n.data?.catalogType === "mpm_template"
  );

  for (const node of mpmNodes) {
    const cur = patches[node.id];
    if (cur?.productIds && String(cur.productIds).trim()) continue;

    const single = buildPatchesForNodes([node], products, templateName);
    if (single[node.id]?.productIds) {
      patches[node.id] = { ...single[node.id], ...cur };
      continue;
    }

    const label = String(
      node.data?.sectionTitle || node.data?.header || node.data?.label || ""
    ).toLowerCase();
    const terms = [
      ...(APEX_NODE_KEYWORDS[node.id] || []),
      ...label.split(/[\s,—–\-|/]+/).filter((w) => w.length > 2),
    ];
    let matched = products.filter((p) => matchesKeywords(p, terms));
    if (!matched.length && label) {
      matched = products.filter((p) => {
        const hay = [
          p.title,
          p.variantTitle,
          p.productType,
          ...(p.collectionTitles || []),
          ...(p.tags || []),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(label.slice(0, Math.min(label.length, 12)));
      });
    }
    matched.sort((a, b) => (a.price || 0) - (b.price || 0));
    matched = matched.slice(0, MAX_PER_SECTION);
    if (!matched.length) continue;

    const ids = matched.map((p) => String(p.shopifyVariantId));
    patches[node.id] = {
      productIds: ids.join(","),
      thumbnailProductRetailerId: ids[0],
      count: ids.length,
      sectionTitle: node.data?.sectionTitle || node.data?.header || "Products",
      header: node.data?.header || node.data?.sectionTitle,
      metaTemplateName: templateName || node.data?.metaTemplateName || "",
    };
  }

  return patches;
}

function buildPatchesForNodes(mpmNodes, products, templateName = "") {
  const patches = {};

  for (const node of mpmNodes) {
    const collectionId = String(node.data?.metaCollectionId || "").trim();
    let matched = [];
    if (collectionId) {
      matched = products.filter(
        (p) =>
          p.inStock !== false &&
          Array.isArray(p.collectionIds) &&
          p.collectionIds.map(String).includes(collectionId)
      );
    }
    if (!matched.length) {
      const keywords = deriveKeywordsFromNode(node);
      matched = products.filter((p) => matchesKeywords(p, keywords));
    }
    matched.sort((a, b) => (a.price || 0) - (b.price || 0));
    matched = matched.slice(0, MAX_PER_SECTION);

    if (!matched.length) continue;

    const ids = matched.map((p) => String(p.shopifyVariantId));
    patches[node.id] = {
      productIds: ids.join(","),
      thumbnailProductRetailerId: ids[0],
      count: ids.length,
      metaTemplateName: templateName || node.data?.metaTemplateName || node.data?.templateName || "",
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

  const clientDoc = await Client.findOne({ clientId })
    .select("syncedMetaTemplates messageTemplates visualFlows")
    .lean();
  const mpmTemplateName = resolveMpmTemplateNameForClient(clientDoc);

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

  let patches = buildPatchesForNodes(mpmNodes, products, mpmTemplateName);
  patches = fillMissingMpmNodePatches(flowDoc.nodes, products, mpmTemplateName, patches);
  if (!Object.keys(patches).length) {
    return { patched: 0, flowId: flowDoc.flowId, message: "No keyword matches", mpmTemplateName };
  }

  const patchNodes = (nodes) =>
    (nodes || []).map((n) => {
      const p = patches[n.id];
      if (!p) {
        if (n.type === "catalog" && n.data?.catalogType === "mpm_template" && mpmTemplateName) {
          return {
            ...n,
            data: applyMpmFieldsToNodeData(n.data, { metaTemplateName: mpmTemplateName }, mpmTemplateName),
          };
        }
        return n;
      }
      return {
        ...n,
        data: applyMpmFieldsToNodeData(n.data, p, p.metaTemplateName || mpmTemplateName),
      };
    });

  const newNodes = patchNodes(flowDoc.nodes);
  const newPublished = patchNodes(flowDoc.publishedNodes || flowDoc.nodes);

  await WhatsAppFlow.updateOne(
    { _id: flowDoc._id },
    { $set: { nodes: newNodes, publishedNodes: newPublished, updatedAt: new Date() } }
  );

  const vfIndex = (clientDoc?.visualFlows || []).findIndex((f) => f.id === flowDoc.flowId);
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId, "visualFlows.id": flowDoc.flowId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: patchNodes(clientDoc.visualFlows[vfIndex].nodes),
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  const patched = Object.keys(patches).length;
  log.info(
    `[FlowMpmPatch] ${clientId} flow=${flowDoc.flowId} patched ${patched} MPM nodes` +
      (mpmTemplateName ? ` template=${mpmTemplateName}` : " (no approved MPM template on client)")
  );

  return { patched, flowId: flowDoc.flowId, patches, mpmTemplateName };
}

/** Wizard-generated flows: category list node id / label hints */
const WIZARD_MENU_NODE_IDS = ["n_cat_category_menu", "cat_category_menu", "cat_category_menu_more"];
const TOP_SECTION = "Top picks";
const MORE_SECTION = "More ranges";
const FOOTER_AFTER_CATALOG = "n_footer";

const {
  splitCollectionsForWhatsAppMenu,
  MORE_ROW_ID,
  OVERFLOW_PAGE_TITLE,
} = require("./catalogMenuBuilder");

function extractMenuSeedFromNodeId(nodeId) {
  const m = String(nodeId || "").match(/cat_category_menu(?:_more)?_(.+)$/);
  return m ? m[1] : "";
}

function findOverflowMenuNode(nodes, primaryMenuId) {
  const seed = extractMenuSeedFromNodeId(primaryMenuId);
  if (seed) {
    const exact = nodes.find((n) => n.id === `cat_category_menu_more_${seed}`);
    if (exact) return exact;
  }
  return nodes.find(
    (n) =>
      n.type === "interactive" &&
      n.data?.interactiveType === "list" &&
      (String(n.id || "").includes("cat_category_menu_more") ||
        /more categor/i.test(n.data?.label || n.data?.text || ""))
  );
}

function mpmNodeIdForCollection(col, seed) {
  return `cat_mpm_${seed}_${String(col.shopifyCollectionId || "").replace(/\W/g, "")}`;
}

function findMpmNodeForCollection(nodes, col) {
  const cid = String(col.shopifyCollectionId || "");
  return nodes.find(
    (n) =>
      n.type === "catalog" &&
      n.data?.catalogType === "mpm_template" &&
      String(n.data?.metaCollectionId || "") === cid
  );
}

function ensureOverflowMenuNode(nodes, primaryMenu, menuSplit) {
  if (!menuSplit?.hasOverflow || !primaryMenu) return { nodes, overflowNode: null };

  let overflowNode = findOverflowMenuNode(nodes, primaryMenu.id);
  const seed = extractMenuSeedFromNodeId(primaryMenu.id) || "menu";
  const overflowId = overflowNode?.id || `cat_category_menu_more_${seed}`;

  if (!overflowNode) {
    overflowNode = {
      id: overflowId,
      type: "interactive",
      position: {
        x: (primaryMenu.position?.x || 0) + 40,
        y: (primaryMenu.position?.y || 0) + 120,
      },
      data: {
        label: "More categories",
        interactiveType: "list",
        text: `*${OVERFLOW_PAGE_TITLE}*\n\nAdditional collections from {{brand_name}}.`,
        buttonText: "View more",
        populateFromShopify: true,
        sections: menuSplit.overflowSections,
        heatmapCount: 0,
      },
    };
    nodes = [...nodes, overflowNode];
  }

  return { nodes, overflowNode };
}

function ensureMenuOverflowEdges(edges, primaryMenuId, overflowNodeId, menuSplit) {
  if (!menuSplit?.hasOverflow || !primaryMenuId || !overflowNodeId) return edges;

  const edgeId = `e_${primaryMenuId}_${MORE_ROW_ID}`;
  const rest = (edges || []).filter(
    (e) => !(e.source === primaryMenuId && e.sourceHandle === MORE_ROW_ID)
  );
  const hasEdge = rest.some(
    (e) => e.source === primaryMenuId && e.target === overflowNodeId && e.sourceHandle === MORE_ROW_ID
  );
  if (!hasEdge) {
    rest.push({
      id: edgeId,
      source: primaryMenuId,
      target: overflowNodeId,
      sourceHandle: MORE_ROW_ID,
    });
  }
  return rest;
}

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function menuLabelFromCollection(collection, slot) {
  let raw = String(collection.whatsappMenuLabel || collection.title || slot?.defaultTitle || "Products").trim();
  raw = raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (raw.length <= 24) return raw;
  const cut = raw.slice(0, 24);
  const sp = cut.lastIndexOf(" ");
  return (sp > 10 ? cut.slice(0, sp) : cut.slice(0, 23)).trim();
}

function assignCollectionsToSlots(collections, slots) {
  const available = [...collections].sort((a, b) => (b.productsCount || 0) - (a.productsCount || 0));
  const assignments = [];
  const used = new Set();

  const bsSlot = slots.find((s) => s.menuRowId === "cat_bestseller" || s.menuRowId === "featured");
  const bsCol = available.find((c) => {
    const t = normTitle(c.title);
    return t.includes("best seller") || t.includes("bestseller") || t.includes("top seller");
  });
  if (bsSlot && bsCol) {
    used.add(bsCol.shopifyCollectionId);
    assignments.push({ slot: bsSlot, collection: bsCol, isBestseller: true });
  }

  for (const slot of slots) {
    if (assignments.some((a) => a.slot.menuRowId === slot.menuRowId)) continue;
    let best = null;
    let bestScore = 0;
    for (const col of available) {
      if (used.has(col.shopifyCollectionId)) continue;
      let score = 0;
      for (const term of slot.matchTerms || []) {
        const t = normTitle(term);
        if (!t) continue;
        const title = normTitle(col.title);
        if (title.includes(t)) score += t.length + 2;
      }
      if (slot.menuRowId === "cat_gaming" && normTitle(col.title).includes("wall") && !normTitle(col.title).includes("gaming")) {
        score -= 8;
      }
      if ((col.productsCount || 0) > 0) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = col;
      }
    }
    if (best && bestScore > 0) {
      used.add(best.shopifyCollectionId);
      assignments.push({ slot, collection: best });
    } else {
      const fallback = available.find((c) => !used.has(c.shopifyCollectionId));
      if (fallback) {
        used.add(fallback.shopifyCollectionId);
        assignments.push({ slot, collection: fallback, fallback: true });
      }
    }
  }
  return assignments;
}

function buildTwoSectionMenu(assignments, slots) {
  const rows = assignments.map(({ slot, collection }) => ({
    id: slot.menuRowId,
    title: menuLabelFromCollection(collection, slot),
      description: "Tap to browse".slice(0, 72),
    collectionId: collection.shopifyCollectionId,
  }));
  return [
    { title: TOP_SECTION.slice(0, 24), rows: rows.slice(0, 5) },
    { title: MORE_SECTION.slice(0, 24), rows: rows.slice(5, 10) },
  ].filter((s) => s.rows.length > 0);
}

function findExploreMenuNode(nodes, menuNodeId) {
  if (menuNodeId) return nodes.find((n) => n.id === menuNodeId);
  return nodes.find(
    (n) =>
      n.type === "interactive" &&
      n.data?.interactiveType === "list" &&
      (n.data?.populateFromShopify ||
        WIZARD_MENU_NODE_IDS.includes(n.id) ||
        String(n.id || "").includes("cat_category_menu") ||
        /category menu|explore our store/i.test(n.data?.label || n.data?.text || ""))
  );
}

/**
 * Multi-tenant: rebuild explore list (2 sections, up to 10 rows) + MPM product IDs from Mongo collections.
 * Apex passes custom `slots` + `menuNodeId` from data/apexCatalogSlots.js.
 */
async function syncExploreMenuFromCollections(clientId, opts = {}) {
  const flowId = opts.flowId;
  const menuNodeId = opts.menuNodeId;
  const slots = opts.slots;
  const injectGraph = opts.injectGraph === true;

  const collections = await ShopifyCollection.find({
    clientId,
    whatsappEnabled: { $ne: false },
  })
    .sort({ sortOrder: 1, productsCount: -1 })
    .lean();

  const products = await ShopifyProduct.find({ clientId, inStock: true })
    .select("shopifyVariantId title collectionIds collectionTitles tags price inStock")
    .lean();

  if (!products.length) {
    return { ok: false, reason: "no_products" };
  }

  const flowQuery = { clientId, status: "PUBLISHED" };
  if (flowId) flowQuery.flowId = flowId;
  const flowDoc = await WhatsAppFlow.findOne(flowQuery).sort({ updatedAt: -1 });
  if (!flowDoc?.nodes?.length) {
    return { ok: false, reason: "no_flow" };
  }

  let nodes = [...flowDoc.nodes];
  let edges = [...(flowDoc.edges || [])];

  if (injectGraph && slots?.length) {
    try {
      const { injectApexCatalogGraph } = require("../data/apexCatalogSlots");
      ({ nodes, edges } = injectApexCatalogGraph(nodes, edges));
    } catch (_) {}
  }

  const menuNode = findExploreMenuNode(nodes, menuNodeId);
  if (!menuNode && !slots?.length && !collections.length) {
    return { ok: false, reason: "no_menu_node", flowId: flowDoc.flowId };
  }

  let mpmPatches = {};
  let menuSections = null;
  let overflowMenuSections = null;
  let menuSplit = null;
  let overflowNode = null;

  if (!slots?.length && collections.length && menuNode) {
    menuSplit = splitCollectionsForWhatsAppMenu(collections);
    menuSections = menuSplit.primarySections;
    overflowMenuSections = menuSplit.hasOverflow ? menuSplit.overflowSections : null;

    const ensured = ensureOverflowMenuNode(nodes, menuNode, menuSplit);
    nodes = ensured.nodes;
    overflowNode = ensured.overflowNode;
    if (menuSplit.hasOverflow && overflowNode) {
      edges = ensureMenuOverflowEdges(edges, menuNode.id, overflowNode.id, menuSplit);
    }

    for (const col of menuSplit.allCollections || []) {
      const label = menuLabelFromCollection(col, null);
      let matched = products.filter(
        (p) =>
          p.inStock !== false &&
          Array.isArray(p.collectionIds) &&
          p.collectionIds.map(String).includes(String(col.shopifyCollectionId))
      );
      matched.sort((a, b) => (a.price || 0) - (b.price || 0));
      matched = matched.slice(0, MAX_PER_SECTION);
      if (!matched.length) continue;
      const ids = matched.map((p) => String(p.shopifyVariantId));
      const existing = findMpmNodeForCollection(nodes, col);
      const nodeId = existing?.id || mpmNodeIdForCollection(col, extractMenuSeedFromNodeId(menuNode.id));
      mpmPatches[nodeId] = {
        productIds: ids.join(","),
        thumbnailProductRetailerId: ids[0],
        sectionTitle: label,
        header: label,
        metaCollectionId: col.shopifyCollectionId,
        count: ids.length,
      };
    }
  }

  if (slots?.length && collections.length) {
    const assignments = assignCollectionsToSlots(collections, slots);
    menuSections = buildTwoSectionMenu(assignments, slots);

    for (const { slot, collection, isBestseller } of assignments) {
      const label = menuLabelFromCollection(collection, slot);
      let matched = products.filter(
        (p) =>
          p.inStock !== false &&
          Array.isArray(p.collectionIds) &&
          p.collectionIds.map(String).includes(String(collection.shopifyCollectionId))
      );
      if (isBestseller) matched.sort((a, b) => (b.price || 0) - (a.price || 0));
      else matched.sort((a, b) => (a.price || 0) - (b.price || 0));
      matched = matched.slice(0, MAX_PER_SECTION);
      if (!matched.length) continue;
      const ids = matched.map((p) => String(p.shopifyVariantId));
      mpmPatches[slot.nodeId] = {
        productIds: ids.join(","),
        thumbnailProductRetailerId: ids[0],
        sectionTitle: label,
        header: label,
        metaCollectionId: collection.shopifyCollectionId,
        count: ids.length,
      };
    }
  }

  const clientDoc = await Client.findOne({ clientId }).select("syncedMetaTemplates messageTemplates").lean();
  const mpmTemplateName = resolveMpmTemplateNameForClient(clientDoc);

  mpmPatches = fillMissingMpmNodePatches(nodes, products, mpmTemplateName, {
    ...buildPatchesForNodes(
      nodes.filter((n) => n.type === "catalog" && n.data?.catalogType === "mpm_template"),
      products,
      mpmTemplateName
    ),
    ...mpmPatches,
  });

  const patchNodes = (nodeList) =>
    nodeList.map((n) => {
      if (menuNode && n.id === menuNode.id && menuSections) {
        const overflowHint = menuSplit?.hasOverflow
          ? " Tap *More categories* for additional ranges."
          : "";
        return {
          ...n,
          data: {
            ...n.data,
            buttonText: "Explore products",
            text:
              (n.data?.text && !/explore apex light/i.test(n.data.text)
                ? n.data.text
                : `✨ *Explore our store*\n\nTop collections below.${overflowHint} Tap a range, then *View items* on each product message.`),
            sections: menuSections,
            populateFromShopify: true,
          },
        };
      }
      if (overflowNode && n.id === overflowNode.id && overflowMenuSections) {
        return {
          ...n,
          data: {
            ...n.data,
            buttonText: "View more",
            sections: overflowMenuSections,
            populateFromShopify: true,
          },
        };
      }
      const mp = mpmPatches[n.id];
      if (!mp) {
        if (n.type === "catalog" && n.data?.catalogType === "mpm_template" && mpmTemplateName) {
          return {
            ...n,
            data: applyMpmFieldsToNodeData(n.data, { metaTemplateName: mpmTemplateName }, mpmTemplateName),
          };
        }
        return n;
      }
      return {
        ...n,
        data: applyMpmFieldsToNodeData(n.data, mp, mp.metaTemplateName || mpmTemplateName),
      };
    });

  const newNodes = patchNodes(nodes);
  await WhatsAppFlow.updateOne(
    { _id: flowDoc._id },
    {
      $set: {
        nodes: newNodes,
        edges,
        publishedNodes: newNodes,
        publishedEdges: edges,
        updatedAt: new Date(),
      },
    }
  );

  const client = await Client.findOne({ clientId }).select("visualFlows").lean();
  const vfIndex = (client?.visualFlows || []).findIndex((f) => f.id === flowDoc.flowId);
  if (vfIndex !== -1) {
    await Client.updateOne(
      { clientId, "visualFlows.id": flowDoc.flowId },
      {
        $set: {
          [`visualFlows.${vfIndex}.nodes`]: patchNodes(client.visualFlows[vfIndex].nodes),
          [`visualFlows.${vfIndex}.edges`]: edges,
          [`visualFlows.${vfIndex}.updatedAt`]: new Date(),
        },
      }
    );
  }

  const mpmNodeIds = nodes
    .filter((n) => n.type === "catalog" && n.data?.catalogType === "mpm_template")
    .map((n) => n.id);
  const patchedWithIds = mpmNodeIds.filter((id) => {
    const n = newNodes.find((x) => x.id === id);
    return String(n?.data?.productIds || "").trim().length > 0;
  });

  return {
    ok: true,
    flowId: flowDoc.flowId,
    menuUpdated: !!menuSections,
    overflowMenuUpdated: !!overflowMenuSections,
    hasOverflowMenu: !!menuSplit?.hasOverflow,
    mpmPatched: Object.keys(mpmPatches).length,
    mpmNodesTotal: mpmNodeIds.length,
    mpmNodesWithIds: patchedWithIds.length,
    mpmNodeIdsMissing: mpmNodeIds.filter((id) => !patchedWithIds.includes(id)),
    collectionsInDb: collections.length,
    productsInDb: products.length,
  };
}

module.exports = {
  autoPatchMpmFlowNodes,
  syncExploreMenuFromCollections,
  buildPatchesForNodes,
  fillMissingMpmNodePatches,
  enrichMpmNodeDataFromDb,
  resolveMpmTemplateNameForClient,
  applyMpmFieldsToNodeData,
  deriveKeywordsFromNode,
  APEX_NODE_KEYWORDS,
};
