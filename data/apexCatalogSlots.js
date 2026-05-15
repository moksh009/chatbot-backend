"use strict";

/**
 * Apex Light — 10 explore categories (WhatsApp list max 10 rows).
 * Synced from Meta product sets via utils/apexCatalogFlowSync.js
 */

const APEX_MPM_TEMPLATE = Object.freeze({
  metaTemplateName: "carosuel",
  languageCode: "en",
});

/** Order matters: bestseller first, then priority categories, then overflow. */
const APEX_CATALOG_SLOTS = [
  {
    menuRowId: "cat_bestseller",
    nodeId: "n_cat_bestseller_pl",
    defaultTitle: "Best Sellers",
    defaultDescription: "Top picks from Apex",
    matchTerms: ["best seller", "bestseller", "bestselling", "top seller", "popular", "featured"],
    sortProducts: "price_desc",
  },
  {
    menuRowId: "cat_tv",
    nodeId: "n_cat_tv_pl",
    defaultTitle: "TV Backlights",
    defaultDescription: "HDMI sync for TV",
    matchTerms: ["tv", "television", "hdmi", "backlight", "sync tv"],
  },
  {
    menuRowId: "cat_gaming",
    nodeId: "n_cat_gaming_pl",
    defaultTitle: "Gaming Lights",
    defaultDescription: "Setup & wall lines",
    matchTerms: ["gaming", "game", "gaming bar", "gaming light", "triangle", "hexagon"],
  },
  {
    menuRowId: "cat_govee",
    nodeId: "n_cat_govee_pl",
    defaultTitle: "Govee Collection",
    defaultDescription: "Authorized Govee",
    matchTerms: ["govee"],
  },
  {
    menuRowId: "cat_monitor",
    nodeId: "n_cat_monitor_pl",
    defaultTitle: "Monitor Sync",
    defaultDescription: "PC & desk lighting",
    matchTerms: ["monitor", "screen sync", "pc", "desk"],
  },
  {
    menuRowId: "cat_floor",
    nodeId: "n_cat_floor_pl",
    defaultTitle: "Floor Lamps",
    defaultDescription: "Floor & table lamps",
    matchTerms: ["floor", "table lamp", "uplighter", "standing lamp"],
  },
  {
    menuRowId: "cat_strip",
    nodeId: "n_cat_strip_pl",
    defaultTitle: "LED Strips",
    defaultDescription: "COB, neon, RGB",
    matchTerms: ["strip", "neon", "rope", "cob", "edge"],
  },
  {
    menuRowId: "cat_wall",
    nodeId: "n_cat_wall_pl",
    defaultTitle: "Wall & Panels",
    defaultDescription: "Hexagon, lines",
    matchTerms: ["wall", "panel", "hexagon", "triangle", "line light"],
  },
  {
    menuRowId: "cat_hdmi",
    nodeId: "n_cat_hdmi_pl",
    defaultTitle: "HDMI & Sync Kits",
    defaultDescription: "Boxes & accessories",
    matchTerms: ["hdmi", "sync box", "accessories", "kit"],
  },
  {
    menuRowId: "cat_smart",
    nodeId: "n_cat_smart_pl",
    defaultTitle: "Smart Home",
    defaultDescription: "Docks & smart gear",
    matchTerms: ["smart", "stream", "dock", "camera", "sensor"],
  },
];

const MENU_NODE_ID = "n_product_menu";
const DEFAULT_FLOW_ID = "flow_apex_owner_support_hub_v2";
const BROWSE_DONE_NODE_ID = "n_cat_browse_done";
const TOP_SECTION_TITLE = "⭐ Top picks";
const MORE_SECTION_TITLE = "🛍️ More to explore";
const ROWS_PER_SECTION = 5;

function makeMpmNode(slot, y) {
  const title = slot.defaultTitle || "Products";
  return {
    id: slot.nodeId,
    type: "catalog",
    position: { x: 1380, y },
    data: {
      label: `MPM — ${title}`,
      catalogType: "mpm_template",
      metaTemplateName: APEX_MPM_TEMPLATE.metaTemplateName,
      languageCode: APEX_MPM_TEMPLATE.languageCode,
      apexDualMethod: true,
      header: title,
      sectionTitle: title,
      text: `Here are our *${title}* — tap *View items* for the WhatsApp carousel.`,
      body: `Here are our *${title}* — tap *View items* for the WhatsApp carousel.`,
      productIds: "",
      thumbnailProductRetailerId: "",
    },
  };
}

/**
 * Ensures all 10 MPM nodes + menu/list edges exist in the seed graph.
 */
function injectApexCatalogGraph(nodes, edges) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));

  APEX_CATALOG_SLOTS.forEach((slot, i) => {
    if (!nodeIds.has(slot.nodeId)) {
      nodes.push(makeMpmNode(slot, -220 + i * 120));
      nodeIds.add(slot.nodeId);
    }

    const menuEdgeId = `e_cat_${slot.menuRowId}`;
    if (!edgeIds.has(menuEdgeId)) {
      edges.push({
        id: menuEdgeId,
        source: MENU_NODE_ID,
        sourceHandle: slot.menuRowId,
        target: slot.nodeId,
      });
      edgeIds.add(menuEdgeId);
    }

    const shortId = slot.nodeId.replace("n_cat_", "").replace("_pl", "");
    const defId = `e_${shortId}_pl_def`;
    if (!edgeIds.has(defId)) {
      edges.push({
        id: defId,
        source: slot.nodeId,
        target: BROWSE_DONE_NODE_ID,
      });
      edgeIds.add(defId);
    }

    const ncId = `e_${shortId}_nc`;
    if (!edgeIds.has(ncId)) {
      edges.push({
        id: ncId,
        source: slot.nodeId,
        sourceHandle: "no_catalog",
        target: BROWSE_DONE_NODE_ID,
      });
      edgeIds.add(ncId);
    }
  });

  return { nodes, edges };
}

module.exports = {
  APEX_CATALOG_SLOTS,
  APEX_MPM_TEMPLATE,
  MENU_NODE_ID,
  DEFAULT_FLOW_ID,
  BROWSE_DONE_NODE_ID,
  TOP_SECTION_TITLE,
  MORE_SECTION_TITLE,
  ROWS_PER_SECTION,
  injectApexCatalogGraph,
};
