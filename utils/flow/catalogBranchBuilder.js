"use strict";

/**
 * Shared catalog branch builder — SSOT for Flow Builder drop, AI scaffold, and collections-menu API.
 * Extracted from flowGenerator.buildCatalogBranch + catalogMenuBuilder + flowMpmPatch patterns.
 */

const Client = require("../../models/Client");
const ShopifyCollection = require("../../models/ShopifyCollection");
const ShopifyProduct = require("../../models/ShopifyProduct");
const { resolveCatalogId } = require("../meta/metaCatalogSync");
const {
  resolveMpmTemplateNameForClient,
  buildPatchesForNodes,
} = require("./flowMpmPatch");
const {
  splitCollectionsForWhatsAppMenu,
  MORE_ROW_ID,
  OVERFLOW_PAGE_TITLE,
  MAX_EXPLORE_MENU_ROWS,
  menuLabelForCollection,
  collectionToRow,
  truncate,
} = require("../commerce/catalogMenuBuilder");

const MAX_PER_SECTION = 30;
const MAX_BUCKET_ROWS = 10;

function productsForCollection(products, collectionId) {
  const cid = String(collectionId || "").trim();
  if (!cid) return [];
  return (products || []).filter(
    (p) =>
      p.inStock !== false &&
      Array.isArray(p.collectionIds) &&
      p.collectionIds.map(String).includes(cid)
  );
}

function variantIdsFromProducts(products, limit = MAX_PER_SECTION) {
  const ids = (products || [])
    .map((p) => String(p.shopifyVariantId || "").trim())
    .filter(Boolean);
  
  if (ids.length > limit) {
    try {
      const log = require('../core/logger')("CatalogBuilder");
      log.info(`[Catalog] Truncating ${ids.length} products to ${limit} (WhatsApp MPM limit)`);
    } catch (e) {}
  }
  
  return ids.slice(0, limit);
}

function buildProductBuckets(products) {
  const buckets = new Map();
  for (const p of products || []) {
    const key =
      String(p.category || p.productType || p.vendor || "General").trim() || "General";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_BUCKET_ROWS);
}

/** Browse-branch catalog nodes use native product_list (no Meta marketing template). */
function makeBrowseListNodeData({
  label,
  sectionTitle,
  body,
  productIds,
  metaCollectionId,
  browseBranch = true,
}) {
  const ids = Array.isArray(productIds) ? productIds : String(productIds || "").split(",");
  const cleanIds = ids.map((s) => String(s).trim()).filter(Boolean);
  const title = sectionTitle || label || "Products";
  const defaultBody = `Browse our *${title}* — tap to view items in WhatsApp.`;
  return {
    label: label || title || "Product list",
    catalogType: "multi",
    header: title,
    sectionTitle: title,
    body: body || defaultBody,
    text: body || defaultBody,
    metaCollectionId: metaCollectionId || "",
    productIds: cleanIds.join(","),
    apexDualMethod: true,
    browseBranch,
    heatmapCount: 0,
  };
}

/** @deprecated Use makeBrowseListNodeData for browse branches. Kept for legacy imports. */
function makeMpmNodeData(opts) {
  return makeBrowseListNodeData(opts);
}

/** Collections that appear on primary or overflow WhatsApp list menus (max 19). */
function getMenuVisibleCollections(menuSplit) {
  if (!menuSplit) return [];
  if (!menuSplit.hasOverflow) {
    return menuSplit.allCollections || [];
  }
  const primary = menuSplit.primary || [];
  const overflow = (menuSplit.overflow || []).slice(0, MAX_EXPLORE_MENU_ROWS);
  return [...primary, ...overflow];
}

function productIdCount(nodeData) {
  return String(nodeData?.productIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function collectEmptyProductWarnings(nodes) {
  const warnings = [];
  for (const n of nodes) {
    if (n.type !== "catalog" || !n.data?.browseBranch) continue;
    if (productIdCount(n.data) > 0) continue;
    warnings.push({
      code: "empty_products",
      nodeId: n.id,
      collectionId: n.data.metaCollectionId || null,
      label: n.data.label || n.data.sectionTitle || "Category",
    });
  }
  return warnings;
}

async function loadCatalogBranchContext(clientId) {
  const [client, collections, products] = await Promise.all([
    Client.findOne({ clientId })
      .select("syncedMetaTemplates waCatalogId facebookCatalogId catalogEnabled metaCatalogId")
      .lean(),
    ShopifyCollection.find({ clientId, whatsappEnabled: { $ne: false } })
      .sort({ sortOrder: 1, productsCount: -1 })
      .lean(),
    ShopifyProduct.find({ clientId, inStock: true })
      .select(
        "shopifyVariantId title variantTitle productType category vendor collectionIds collectionTitles tags price inStock"
      )
      .lean(),
  ]);

  const catalogLinked = !!resolveCatalogId(client);
  const mpmTemplateName = resolveMpmTemplateNameForClient(client || {});
  const useCollections = Array.isArray(collections) && collections.length > 0;
  const menuSplit = useCollections ? splitCollectionsForWhatsAppMenu(collections) : null;

  return {
    client,
    collections: collections || [],
    products: products || [],
    catalogLinked,
    mpmTemplateName,
    useCollections,
    menuSplit,
    buckets: useCollections ? [] : buildProductBuckets(products || []),
  };
}

/**
 * Preview payload for GET /collections-menu — properties, simulator, drop UI.
 */
async function getCollectionsMenuForClient(clientId) {
  const ctx = await loadCatalogBranchContext(clientId);
  const { menuSplit, useCollections, buckets, products, mpmTemplateName, catalogLinked } = ctx;

  const collectionPreviews = useCollections
    ? (menuSplit?.allCollections || []).map((c) => {
        const matched = productsForCollection(products, c.shopifyCollectionId);
        return {
          shopifyCollectionId: c.shopifyCollectionId,
          title: c.title,
          menuLabel: menuLabelForCollection(c),
          productCount: matched.length || c.productsCount || 0,
        };
      })
    : buckets.map(([name, items], idx) => ({
        shopifyCollectionId: null,
        title: name,
        menuLabel: truncate(name, 24),
        productCount: items.length,
        bucketIndex: idx,
      }));

  return {
    success: true,
    catalogLinked,
    mpmTemplateName,
    useCollections,
    hasOverflow: !!menuSplit?.hasOverflow,
    primarySections: menuSplit?.primarySections || [],
    overflowSections: menuSplit?.overflowSections || [],
    moreRowId: menuSplit?.moreRowId || MORE_ROW_ID,
    collections: collectionPreviews,
    productCount: products.length,
    categoryCount: collectionPreviews.length,
  };
}

function pos(base, dx, dy) {
  return { x: (base?.x || 0) + dx, y: (base?.y || 0) + dy };
}

/**
 * Build insertable subgraph for Flow Builder canvas drop.
 */
function buildInsertableCatalogBranch(ctx, options = {}) {
  const {
    position = { x: 0, y: 0 },
    seed = Date.now(),
    nextNodeOrder = 1,
  } = options;

  const {
    products,
    mpmTemplateName,
    useCollections,
    menuSplit,
    buckets,
    catalogLinked,
  } = ctx;

  const ids = {
    seed,
    menu: `cat_menu_${seed}`,
    menuMore: `cat_menu_more_${seed}`,
    cart: `cat_cart_${seed}`,
    next: `cat_next_${seed}`,
    noCatalog: `cat_no_catalog_${seed}`,
  };

  const nodes = [];
  const edges = [];
  let order = nextNodeOrder;

  const pushNode = (node) => {
    nodes.push({
      ...node,
      data: {
        ...node.data,
        nodeOrder: order++,
        heatmapCount: node.data?.heatmapCount || 0,
      },
    });
  };

  const mpmNodeId = (key) => `cat_mpm_${seed}_${String(key).replace(/\W/g, "")}`;

  // ── Category menu(s) ──────────────────────────────────────────────────────
  let menuSections;
  let menuIntro;
  const hasOverflow = !!menuSplit?.hasOverflow;

  if (useCollections && menuSplit) {
    menuSections = menuSplit.primarySections;
    menuIntro = hasOverflow
      ? "Welcome to the *{{brand_name}} store*! ✨\n\nBrowse by collection — tap *More categories* for additional ranges."
      : "Welcome to the *{{brand_name}} store*! ✨\n\nChoose a category below to explore our products right here in WhatsApp.";
  } else {
    const rows = buckets.map(([name, items], idx) => ({
      id: `cat_${idx}`,
      title: truncate(name, 24),
      description: `${items.length} item${items.length === 1 ? "" : "s"}`,
    }));
    if (!rows.length) {
      rows.push({ id: "cat_0", title: "All products", description: "Browse our range" });
    }
    menuSections = [{ title: "{{brand_name}} collections", rows }];
    menuIntro = "Welcome to the *{{brand_name}} store*! ✨\n\nPick a category to browse products in WhatsApp.";
  }

  pushNode({
    id: ids.menu,
    type: "interactive",
    position: pos(position, 0, 0),
    data: {
      label: "Category menu",
      interactiveType: "list",
      text: menuIntro,
      buttonText: "Explore products",
      populateFromShopify: useCollections,
      browseBranchMenu: true,
      sections: menuSections,
    },
  });

  if (hasOverflow && menuSplit) {
    pushNode({
      id: ids.menuMore,
      type: "interactive",
      position: pos(position, 0, 180),
      data: {
        label: "More categories",
        interactiveType: "list",
        text: `*${OVERFLOW_PAGE_TITLE}*\n\nAdditional collections from {{brand_name}}.`,
        buttonText: "View more",
        populateFromShopify: true,
        browseBranchMenu: true,
        sections: menuSplit.overflowSections,
      },
    });
    edges.push({
      id: `e_${ids.menu}_more_${seed}`,
      source: ids.menu,
      target: ids.menuMore,
      sourceHandle: MORE_ROW_ID,
    });
  }

  // ── Tail: cart + next actions ─────────────────────────────────────────────
  pushNode({
    id: ids.cart,
    type: "cart_handler",
    position: pos(position, 520, 120),
    data: {
      label: "Cart & checkout",
      checkoutMessage:
        "Complete your checkout 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}",
    },
  });

  pushNode({
    id: ids.next,
    type: "interactive",
    position: pos(position, 520, 0),
    data: {
      label: "After browsing",
      interactiveType: "button",
      text: "Found something you like? Get your checkout link or ask for help.",
      buttonsList: [
        { id: "checkout", title: "Get checkout link" },
        { id: "menu", title: "Main menu" },
      ],
    },
  });

  if (!catalogLinked) {
    pushNode({
      id: ids.noCatalog,
      type: "message",
      position: pos(position, 520, 240),
      data: {
        label: "Catalog not connected",
        text: "Connect your Meta catalog in Settings → Connections to show live products.",
      },
    });
  }

  edges.push(
    { id: `e_${ids.cart}_next_${seed}`, source: ids.cart, target: ids.next, sourceHandle: "a" },
    {
      id: `e_${ids.next}_checkout_${seed}`,
      source: ids.next,
      target: ids.cart,
      sourceHandle: "checkout",
    },
    {
      id: `e_${ids.next}_menu_${seed}`,
      source: ids.next,
      target: ids.menu,
      sourceHandle: "menu",
    }
  );

  // ── Per-category product_list nodes (menu-visible collections only) ───────
  const wireCatalogNode = (menuId, handleId, nodeId, nodeData) => {
    pushNode({
      id: nodeId,
      type: "catalog",
      position: pos(position, 280, nodes.filter((n) => n.type === "catalog").length * 72),
      data: nodeData,
    });
    edges.push(
      { id: `e_${menuId}_${handleId}_${seed}`, source: menuId, target: nodeId, sourceHandle: handleId },
      { id: `e_${nodeId}_next_${seed}`, source: nodeId, target: ids.next, sourceHandle: "a" },
      { id: `e_${nodeId}_cart_${seed}`, source: nodeId, target: ids.cart, sourceHandle: "cart" }
    );
    if (!catalogLinked) {
      edges.push({
        id: `e_${nodeId}_no_${seed}`,
        source: nodeId,
        target: ids.noCatalog,
        sourceHandle: "no_catalog",
      });
    }
  };

  if (useCollections && menuSplit) {
    const visibleCols = getMenuVisibleCollections(menuSplit);
    for (const col of visibleCols) {
      const handleId = `collection_${col.shopifyCollectionId}`;
      const label = menuLabelForCollection(col);
      const matched = productsForCollection(products, col.shopifyCollectionId);
      let idsList = variantIdsFromProducts(matched);
      const nid = mpmNodeId(col.shopifyCollectionId);
      const draftNode = {
        id: nid,
        type: "catalog",
        data: makeBrowseListNodeData({
          label: `${truncate(col.title, 22)}`,
          sectionTitle: label,
          body: `Browse our *${label}* — tap to view items in WhatsApp.`,
          productIds: idsList,
          metaCollectionId: col.shopifyCollectionId,
        }),
      };
      if (!idsList.length && products.length) {
        const patches = buildPatchesForNodes([draftNode], products, mpmTemplateName);
        const patch = patches[nid];
        if (patch?.productIds) {
          draftNode.data = {
            ...draftNode.data,
            productIds: patch.productIds,
          };
        }
      }
      const menuId =
        menuSplit.overflow.some((c) => c.shopifyCollectionId === col.shopifyCollectionId) &&
        hasOverflow
          ? ids.menuMore
          : ids.menu;
      wireCatalogNode(menuId, handleId, nid, draftNode.data);
    }
  } else {
    const bucketList = buckets.length ? buckets : [["All products", products.slice(0, MAX_PER_SECTION)]];
    bucketList.forEach(([name, items], idx) => {
      const handleId = `cat_${idx}`;
      const catLabel = truncate(name, 24);
      const idsList = variantIdsFromProducts(items);
      const nid = mpmNodeId(`bucket_${idx}`);
      const draftNode = {
        id: nid,
        type: "catalog",
        data: makeBrowseListNodeData({
          label: truncate(name, 22),
          sectionTitle: catLabel,
          body: `Browse *${name}* from {{brand_name}}.`,
          productIds: idsList,
        }),
      };
      if (!idsList.length && products.length) {
        const patches = buildPatchesForNodes([draftNode], products, mpmTemplateName);
        const patch = patches[nid];
        if (patch?.productIds) {
          draftNode.data = { ...draftNode.data, productIds: patch.productIds };
        }
      }
      wireCatalogNode(ids.menu, handleId, nid, draftNode.data);
    });
  }

  const warnings = collectEmptyProductWarnings(nodes);

  return {
    nodes,
    edges,
    entryNodeId: ids.menu,
    overflowNodeId: hasOverflow ? ids.menuMore : null,
    catalogLinked,
    categoryCount: nodes.filter((n) => n.type === "catalog").length,
    warnings,
  };
}

async function buildCatalogBranchForClient(clientId, options = {}) {
  const ctx = await loadCatalogBranchContext(clientId);
  const graph = buildInsertableCatalogBranch(ctx, options);
  return { success: true, ...graph, mpmTemplateName: ctx.mpmTemplateName };
}

/**
 * Append catalog branch to an existing AI-generated graph when browse intent detected.
 */
function appendCatalogBranchIfMissing(existingGraph, ctx, options = {}) {
  const nodes = Array.isArray(existingGraph?.nodes) ? existingGraph.nodes : [];
  const edges = Array.isArray(existingGraph?.edges) ? existingGraph.edges : [];

  const hasBranch =
    nodes.some((n) => n.data?.browseBranchMenu) ||
    nodes.some(
      (n) =>
        n.type === "interactive" &&
        n.data?.interactiveType === "list" &&
        n.data?.populateFromShopify
    ) ||
    nodes.filter((n) => n.type === "catalog" && n.data?.browseBranch).length >= 2;

  if (hasBranch) return existingGraph;

  const maxY = nodes.reduce((m, n) => Math.max(m, n.position?.y || 0), 0);
  const maxX = nodes.reduce((m, n) => Math.max(m, n.position?.x || 0), 0);
  const maxOrder = nodes.reduce((m, n) => Math.max(m, n.data?.nodeOrder || 0), 0);

  const branch = buildInsertableCatalogBranch(ctx, {
    position: { x: maxX + 80, y: maxY + 40 },
    seed: Date.now(),
    nextNodeOrder: maxOrder + 1,
    ...options,
  });

  return {
    nodes: [...nodes, ...branch.nodes],
    edges: [...edges, ...branch.edges],
    catalogBranchEntryNodeId: branch.entryNodeId,
  };
}

function detectBrowseCatalogIntent(prompt = "", contextExtras = {}) {
  const t = String(prompt || "").toLowerCase();
  const keywords =
    /\b(browse|catalog|shop|products|collection|store|buy|purchase|carousel|mpm)\b/.test(t);
  const catalogEnabled = contextExtras?.features?.catalog !== false;
  return keywords || catalogEnabled;
}

module.exports = {
  loadCatalogBranchContext,
  getCollectionsMenuForClient,
  buildInsertableCatalogBranch,
  buildCatalogBranchForClient,
  appendCatalogBranchIfMissing,
  detectBrowseCatalogIntent,
  productsForCollection,
  variantIdsFromProducts,
  makeBrowseListNodeData,
  makeMpmNodeData,
  getMenuVisibleCollections,
};
