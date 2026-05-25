"use strict";

/**
 * Unified multi-tenant canvas layout (editor-only parentId folders).
 * Uses data.layoutSection metadata first; generic inference for legacy graphs.
 * No per-client Apex vs wizard folderizers.
 */

const {
  FLOW_LAYOUT_SECTIONS,
  SECTION_BY_KEY,
  LAYOUT_FOLDER_PREFIX,
  LAYOUT_SPEC_VERSION,
  layoutFolderId,
  normalizeLayoutSection,
} = require('./flowLayoutSections');

const ROOT_LAYOUT_TYPES = new Set(["folder", "trigger", "link"]);
const LEGACY_LAYOUT_FOLDER_PREFIXES = ["f_wiz_", "f_apex_", "f_layout_"];

function nodeLabelBlob(node) {
  return String(
    node?.data?.label ||
      node?.data?.header ||
      node?.data?.sectionTitle ||
      node?.data?.body ||
      ""
  ).toLowerCase();
}

function nodeId(node) {
  return String(node?.id || "");
}

/**
 * Infer layout section for any tenant graph (wizard, apex, manual, imported).
 * @returns {string|null} section key or null (root / sticky)
 */
function inferLayoutSection(node) {
  const fromMeta = normalizeLayoutSection(node?.data?.layoutSection || node?.data?.flowSection);
  if (fromMeta) return fromMeta;

  if (node.type === "sticky") return null;

  const id = nodeId(node);
  const label = nodeLabelBlob(node);

  if (node.type === "catalog") return "catalog";
  if (node.type === "shopify_call") return "orders";
  if (node.type === "loyalty_action") return "loyalty";
  if (node.type === "warranty_check") return "warranty";
  if (node.type === "schedule" || node.type === "admin_alert") return "support";

  if (node.type === "trigger") {
    if (/^trig_(cart|order|fulfill|abandon|review|cod)/i.test(id)) return "automation";
    return "entry";
  }

  if (/^ai_|_ai_fallback$|ai_fallback$/i.test(id)) return "ai";

  if (
    /^(trig_main|trig_ad|trig_ig|welcome|ad_welcome|ig_welcome|main_menu|n_main_menu|n_service_menu|n_footer)_?/.test(id) ||
    id === "n_main_menu" ||
    id === "n_service_menu" ||
    id === "n_footer"
  ) {
    return "entry";
  }

  if (
    /^cat_|^cat_mpm_|^collection_|^n_cat_|^n_product_menu$|^n_catalog$|^n_buy_intro$|^n_cat_browse_done$/.test(id) ||
    /mpm|product catalog|catalog carousel|view items|browse catalog/i.test(label)
  ) {
    return "catalog";
  }

  if (
    /^ord_|^can_|^n_order$|^n_tt\d$/.test(id) ||
    (/order|cancel|track|shipment|fulfillment/i.test(label) && /lookup|status|cancel|select order|track/i.test(label))
  ) {
    return "orders";
  }

  if (/^ret_|^ref_/.test(id) || /return|refund/i.test(label)) return "returns";
  if (/^war_|^n_w_|^n_warranty$/.test(id) || /warranty|claim/i.test(label)) return "warranty";
  if (/^ins_|^help_|^n_install_|^n_inst_|^n_have_|^n_hub21$|^n_hub20$|^n_m21_|^n_m20_|^n_other_products$|^n_govee_line$/.test(id)) {
    return "install";
  }
  if (/^loy_/.test(id) || /loyalty|redeem|referral|points/i.test(label)) return "loyalty";
  if (/^sup_|^faq_|^n_faq_|^n_support_pre$|^n_tr_menu$|^n_human_handoff$|^n_admin_alert$/.test(id)) {
    return "support";
  }
  if (
    /^trig_(cart|order|fulfill)_/.test(id) ||
    /^cart_|^cod|^codcf_|^conf_|^rev_|cart_term|cod_conf/.test(id) ||
    /abandoned cart|cod confirm|review request/i.test(label)
  ) {
    return "automation";
  }

  if (/^(n_tv_|n_monitor_|n_govee_|n_floor_|n_gaming_|n_strip_)/.test(id)) return "catalog";

  if (node.type === "message" || node.type === "interactive" || node.type === "template") {
    if (/faq|support|live chat|handoff|human/i.test(label)) return "support";
    if (/install|setup guide|hdmi/i.test(label)) return "install";
  }

  return "misc";
}

function stampLayoutSections(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    if (node.type === "folder") return node;
    const section = inferLayoutSection(node);
    if (!section) return node;
    return {
      ...node,
      data: {
        ...(node.data || {}),
        layoutSection: normalizeLayoutSection(node.data?.layoutSection) || section,
        layoutSpecVersion: node.data?.layoutSpecVersion || LAYOUT_SPEC_VERSION,
      },
    };
  });
}

function isLayoutFolderNode(node) {
  if (node?.type !== "folder") return false;
  const id = nodeId(node);
  return LEGACY_LAYOUT_FOLDER_PREFIXES.some((p) => id.startsWith(p));
}

function countOrphanLayoutNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (n) => !n.parentId && n.type !== "folder" && !ROOT_LAYOUT_TYPES.has(n.type)
  ).length;
}

function layoutFolderChildren(nodes, folderId, opts = {}) {
  const cols = opts.cols || 4;
  const dx = opts.dx || 260;
  const dy = opts.dy || 140;
  const children = nodes
    .filter((n) => (n.parentId || null) === folderId && n.type !== "folder")
    .sort((a, b) => nodeId(a).localeCompare(nodeId(b)));

  const posById = new Map();
  children.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    posById.set(n.id, { x: 64 + col * dx, y: 64 + row * dy });
  });

  return nodes.map((n) => {
    const pos = posById.get(n.id);
    if (!pos) return n;
    if (opts.keepPositions && n.position?.x != null) return n;
    return { ...n, position: pos };
  });
}

/**
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {{ keepPositions?: boolean, addEntryEdges?: boolean, stampSections?: boolean }} [opts]
 */
function organizeFlowGraph(nodes, edges, opts = {}) {
  const addEntryEdges = opts.addEntryEdges !== false;
  const keepPositions = opts.keepPositions !== false;
  const stampSections = opts.stampSections !== false;

  let working = (Array.isArray(nodes) ? nodes : []).filter((n) => !isLayoutFolderNode(n));
  if (stampSections) working = stampLayoutSections(working);

  const reassigned = working.map((node) => {
    if (node.type === "trigger") {
      const section = inferLayoutSection(node);
      if (section === "entry" || section === "automation") {
        const folderId = layoutFolderId(section);
        return { ...node, parentId: folderId };
      }
      return { ...node, parentId: null };
    }
    if (node.type === "folder") {
      return { ...node, parentId: null };
    }
    const section = inferLayoutSection(node);
    if (!section) return { ...node, parentId: null };
    return { ...node, parentId: layoutFolderId(section) };
  });

  const folderNodes = FLOW_LAYOUT_SECTIONS.map((spec) => {
    const fid = layoutFolderId(spec.key);
    const childCount = reassigned.filter(
      (n) => (n.parentId || null) === fid && n.type !== "folder"
    ).length;
    return {
      id: fid,
      type: "folder",
      parentId: null,
      position: spec.position,
      data: {
        label: spec.label,
        color: spec.color,
        childHint: spec.childHint,
        childCount,
        layoutSection: spec.key,
        layoutSpecVersion: LAYOUT_SPEC_VERSION,
      },
    };
  }).filter((f) => f.data.childCount > 0);

  let outNodes = [...reassigned, ...folderNodes];
  for (const spec of FLOW_LAYOUT_SECTIONS) {
    const fid = layoutFolderId(spec.key);
    if (!folderNodes.some((f) => f.id === fid)) continue;
    outNodes = layoutFolderChildren(outNodes, fid, { keepPositions });
  }

  const edgeList = [...(Array.isArray(edges) ? edges : [])].filter(
    (e) => !String(e.id || "").startsWith("e_layout_folder_entry_")
  );

  if (addEntryEdges) {
    const edgeIds = new Set(edgeList.map((e) => e.id));
    for (const spec of FLOW_LAYOUT_SECTIONS) {
      const fid = layoutFolderId(spec.key);
      const children = outNodes
        .filter((n) => (n.parentId || null) === fid && n.type !== "folder")
        .sort((a, b) => nodeId(a).localeCompare(nodeId(b)));
      if (!children.length) continue;
      const entryId = `e_layout_folder_entry_${spec.key}`;
      if (!edgeIds.has(entryId)) {
        edgeList.push({
          id: entryId,
          source: fid,
          target: children[0].id,
          animated: true,
          style: { strokeDasharray: "6 4", stroke: "#94a3b8", opacity: 0.35 },
        });
        edgeIds.add(entryId);
      }
    }
  }

  return {
    nodes: outNodes,
    edges: edgeList,
    layoutSpecVersion: LAYOUT_SPEC_VERSION,
  };
}

/**
 * Read-time layout: stamp metadata + folderize only when orphans exist.
 */
function applyCanvasLayout(nodes, edges, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  const orphans = countOrphanLayoutNodes(list);
  if (orphans === 0 && !opts.force) {
    return { nodes: list, edges: edgeList, layoutApplied: false, orphansBefore: 0 };
  }
  const organized = organizeFlowGraph(list, edgeList, opts);
  return {
    nodes: organized.nodes,
    edges: organized.edges,
    layoutApplied: true,
    orphansBefore: orphans,
    orphansAfter: countOrphanLayoutNodes(organized.nodes),
    layoutSpecVersion: LAYOUT_SPEC_VERSION,
  };
}

module.exports = {
  LAYOUT_SPEC_VERSION,
  ROOT_LAYOUT_TYPES,
  inferLayoutSection,
  stampLayoutSections,
  countOrphanLayoutNodes,
  organizeFlowGraph,
  applyCanvasLayout,
  layoutFolderId,
  SECTION_BY_KEY,
};
