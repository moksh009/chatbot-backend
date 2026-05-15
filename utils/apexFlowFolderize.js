"use strict";

/**
 * Organize Apex Light owner flow into in-canvas folder groups (parentId).
 * Runtime routing is unchanged — only edges matter live; parentId is editor-only.
 */

const APEX_FOLDER_PREFIX = "f_apex_";

/** @type {Array<{ id: string, label: string, color: string, childHint: string, position: { x: number, y: number }, assign: (node: object) => boolean }>} */
const APEX_FLOW_FOLDERS = [
  {
    id: `${APEX_FOLDER_PREFIX}notes`,
    label: "📌 Planning notes",
    color: "slate",
    childHint: "Sticky notes — editor reference only",
    position: { x: -520, y: -480 },
    assign: (node) => node.type === "sticky" || String(node.id).startsWith("note_"),
  },
  {
    id: `${APEX_FOLDER_PREFIX}hub`,
    label: "🏠 Hub & menus",
    color: "indigo",
    childHint: "Main menu · services · footer loop",
    position: { x: 520, y: 60 },
    assign: (node) => ["n_main_menu", "n_service_menu", "n_footer"].includes(node.id),
  },
  {
    id: `${APEX_FOLDER_PREFIX}explore`,
    label: "🛍️ Explore & MPM catalog",
    color: "emerald",
    childHint: "Category list · MPM nodes · full catalog",
    position: { x: 1280, y: 60 },
    assign: (node) => {
      const id = node.id;
      return (
        id === "n_product_menu" ||
        id === "n_catalog" ||
        id === "n_buy_intro" ||
        id === "n_cat_browse_done" ||
        (id.startsWith("n_cat_") && node.type === "catalog")
      );
    },
  },
  {
    id: `${APEX_FOLDER_PREFIX}fallback`,
    label: "📋 Text product lists",
    color: "amber",
    childHint: "no_catalog fallback copy + CTAs",
    position: { x: 1280, y: 400 },
    assign: (node) =>
      /^(n_tv_|n_monitor_|n_govee_|n_floor_|n_gaming_|n_strip_)/.test(node.id),
  },
  {
    id: `${APEX_FOLDER_PREFIX}install`,
    label: "📦 Installation guides",
    color: "blue",
    childHint: "Install hub · HDMI 2.1/2.0 · other products",
    position: { x: 520, y: 480 },
    assign: (node) => {
      const id = node.id;
      return (
        id.startsWith("n_install_") ||
        id.startsWith("n_inst_") ||
        id.startsWith("n_have_") ||
        id === "n_hub21" ||
        id === "n_hub20" ||
        id.startsWith("n_m21_") ||
        id.startsWith("n_m20_") ||
        id === "n_other_products" ||
        id === "n_govee_line"
      );
    },
  },
  {
    id: `${APEX_FOLDER_PREFIX}support`,
    label: "🎧 Support · FAQ · handoff",
    color: "rose",
    childHint: "FAQ packs · warranty · order · live chat",
    position: { x: 1280, y: 760 },
    assign: (node) => {
      const id = node.id;
      return (
        id.startsWith("n_faq_") ||
        id === "n_support_pre" ||
        id === "n_tr_menu" ||
        /^n_tt\d$/.test(id) ||
        id === "n_warranty" ||
        id.startsWith("n_w_") ||
        id === "n_order" ||
        id === "n_admin_alert" ||
        id === "n_human_handoff"
      );
    },
  },
];

function isApexFolderNode(node) {
  return node?.type === "folder" && String(node.id || "").startsWith(APEX_FOLDER_PREFIX);
}

function resolveFolderId(node) {
  for (const spec of APEX_FLOW_FOLDERS) {
    if (spec.assign(node)) return spec.id;
  }
  return null;
}

function layoutFolderChildren(nodes, folderId, opts = {}) {
  const cols = opts.cols || 4;
  const dx = opts.dx || 280;
  const dy = opts.dy || 150;
  const children = nodes
    .filter((n) => (n.parentId || null) === folderId && n.type !== "folder")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const posById = new Map();
  children.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    posById.set(n.id, { x: 72 + col * dx, y: 72 + row * dy });
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
 * @param {{ keepPositions?: boolean, addEntryEdges?: boolean }} [opts]
 */
function folderizeApexFlowGraph(nodes, edges, opts = {}) {
  const addEntryEdges = opts.addEntryEdges !== false;
  const keepPositions = !!opts.keepPositions;

  const apexFolderIds = new Set(APEX_FLOW_FOLDERS.map((f) => f.id));
  const stripped = (nodes || []).filter((n) => !isApexFolderNode(n));

  const reassigned = stripped.map((node) => {
    if (node.type === "trigger") {
      return { ...node, parentId: null };
    }
    if (node.type === "folder") {
      return { ...node, parentId: null };
    }
    const folderId = resolveFolderId(node);
    if (!folderId) {
      return { ...node, parentId: null };
    }
    return { ...node, parentId: folderId };
  });

  const folderNodes = APEX_FLOW_FOLDERS.map((spec) => {
    const childCount = reassigned.filter(
      (n) => (n.parentId || null) === spec.id && n.type !== "folder"
    ).length;
    return {
      id: spec.id,
      type: "folder",
      parentId: null,
      position: spec.position,
      data: {
        label: spec.label,
        color: spec.color,
        childHint: spec.childHint,
        childCount,
      },
    };
  });

  let outNodes = [...reassigned, ...folderNodes];
  for (const spec of APEX_FLOW_FOLDERS) {
    outNodes = layoutFolderChildren(outNodes, spec.id, { keepPositions });
  }

  const edgeList = [...(edges || [])].filter(
    (e) => !String(e.id || "").startsWith("e_apex_folder_entry_")
  );

  if (addEntryEdges) {
    const edgeIds = new Set(edgeList.map((e) => e.id));
    for (const spec of APEX_FLOW_FOLDERS) {
      const children = outNodes
        .filter((n) => (n.parentId || null) === spec.id && n.type !== "folder")
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (!children.length) continue;
      const first = children[0];
      const entryId = `e_apex_folder_entry_${spec.id}`;
      if (!edgeIds.has(entryId)) {
        edgeList.push({
          id: entryId,
          source: spec.id,
          target: first.id,
          animated: true,
        });
        edgeIds.add(entryId);
      }
    }
  }

  const counts = {};
  for (const spec of APEX_FLOW_FOLDERS) {
    counts[spec.id] = outNodes.filter((n) => n.parentId === spec.id && n.type !== "folder").length;
  }
  const rootCount = outNodes.filter((n) => !n.parentId && n.type !== "folder").length;

  return {
    nodes: outNodes,
    edges: edgeList,
    stats: {
      folderCount: folderNodes.length,
      rootNodeCount: rootCount,
      nodesPerFolder: counts,
      totalNodes: outNodes.length,
      totalEdges: edgeList.length,
    },
  };
}

module.exports = {
  APEX_FLOW_FOLDERS,
  APEX_FOLDER_PREFIX,
  folderizeApexFlowGraph,
  resolveFolderId,
};
