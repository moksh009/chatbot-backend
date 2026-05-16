"use strict";

/**
 * Organize wizard / ecommerce-generated flows into in-canvas folder groups (parentId).
 * Runtime routing is unchanged — only edges matter live; parentId is editor-only.
 * Pattern mirrors utils/apexFlowFolderize.js (Apex Light reference).
 */

const WIZ_FOLDER_PREFIX = "f_wiz_";

/** @type {Array<{ id: string, label: string, color: string, childHint: string, position: { x: number, y: number }, assign: (node: object) => boolean }>} */
const WIZARD_FLOW_FOLDERS = [
  {
    id: `${WIZ_FOLDER_PREFIX}entry`,
    label: "🏠 Entry & main menu",
    color: "indigo",
    childHint: "Triggers · welcome · hub menu",
    position: { x: 80, y: 40 },
    assign: (node) => {
      const id = String(node.id || "");
      if (node.type === "trigger") return !/trig_(cart|order|fulfill)/.test(id);
      return /^(trig_main|trig_ad|trig_ig|welcome|ad_welcome|ig_welcome|main_menu)_/.test(id);
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}catalog`,
    label: "🛍️ Catalog & checkout",
    color: "emerald",
    childHint: "Browse · MPM · cart · address",
    position: { x: 720, y: 40 },
    assign: (node) => {
      const id = String(node.id || "");
      return (
        id.startsWith("cat_") ||
        id.startsWith("cat_mpm_") ||
        node.type === "catalog" ||
        /^collection_/.test(id)
      );
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}orders`,
    label: "📦 Orders & cancel",
    color: "blue",
    childHint: "Track · status · cancel flow",
    position: { x: 80, y: 420 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("ord_") || id.startsWith("can_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}returns`,
    label: "↩️ Returns & refunds",
    color: "amber",
    childHint: "Return hub · refund check",
    position: { x: 720, y: 420 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("ret_") || id.startsWith("ref_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}warranty`,
    label: "🛡️ Warranty",
    color: "violet",
    childHint: "Lookup · claims · PDF",
    position: { x: 1360, y: 420 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("war_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}install`,
    label: "🔧 Install & product help",
    color: "cyan",
    childHint: "Install guides · help desk",
    position: { x: 80, y: 800 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("ins_") || id.startsWith("help_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}loyalty`,
    label: "⭐ Loyalty",
    color: "yellow",
    childHint: "Points · redeem · refer",
    position: { x: 720, y: 800 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("loy_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}support`,
    label: "🎧 Support & FAQ",
    color: "rose",
    childHint: "Live chat · schedule · FAQ",
    position: { x: 1360, y: 40 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("sup_") || id.startsWith("faq_");
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}automation`,
    label: "⚡ Commerce automations",
    color: "orange",
    childHint: "Cart · COD · reviews (webhook triggers)",
    position: { x: 1360, y: 800 },
    assign: (node) => {
      const id = String(node.id || "");
      if (/^trig_(cart|order|fulfill)_/.test(id)) return true;
      return (
        id.startsWith("cart_") ||
        id.startsWith("cod") ||
        id.startsWith("codcf_") ||
        id.startsWith("conf_") ||
        id.startsWith("rev_") ||
        id.includes("cart_term") ||
        id.includes("cod_conf")
      );
    },
  },
  {
    id: `${WIZ_FOLDER_PREFIX}ai`,
    label: "🤖 AI fallback",
    color: "slate",
    childHint: "AI capture · escalate",
    position: { x: 720, y: 1160 },
    assign: (node) => {
      const id = String(node.id || "");
      return id.startsWith("ai_");
    },
  },
];

function isWizardFolderNode(node) {
  return node?.type === "folder" && String(node.id || "").startsWith(WIZ_FOLDER_PREFIX);
}

function resolveFolderId(node) {
  if (node.type === "sticky") return null;
  for (const spec of WIZARD_FLOW_FOLDERS) {
    if (spec.assign(node)) return spec.id;
  }
  return null;
}

function layoutFolderChildren(nodes, folderId, opts = {}) {
  const cols = opts.cols || 4;
  const dx = opts.dx || 260;
  const dy = opts.dy || 140;
  const children = nodes
    .filter((n) => (n.parentId || null) === folderId && n.type !== "folder")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

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
 * @param {{ keepPositions?: boolean, addEntryEdges?: boolean }} [opts]
 */
function folderizeWizardFlowGraph(nodes, edges, opts = {}) {
  const addEntryEdges = opts.addEntryEdges !== false;
  const keepPositions = !!opts.keepPositions;

  const stripped = (nodes || []).filter((n) => !isWizardFolderNode(n));

  const reassigned = stripped.map((node) => {
    if (node.type === "trigger") {
      const folderId = resolveFolderId(node);
      return folderId ? { ...node, parentId: folderId } : { ...node, parentId: null };
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

  const folderNodes = WIZARD_FLOW_FOLDERS.map((spec) => {
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
  }).filter((f) => f.data.childCount > 0);

  let outNodes = [...reassigned, ...folderNodes];
  for (const spec of WIZARD_FLOW_FOLDERS) {
    if (!folderNodes.some((f) => f.id === spec.id)) continue;
    outNodes = layoutFolderChildren(outNodes, spec.id, { keepPositions });
  }

  const edgeList = [...(edges || [])].filter(
    (e) => !String(e.id || "").startsWith("e_wiz_folder_entry_")
  );

  if (addEntryEdges) {
    const edgeIds = new Set(edgeList.map((e) => e.id));
    for (const spec of WIZARD_FLOW_FOLDERS) {
      const folderNode = folderNodes.find((f) => f.id === spec.id);
      if (!folderNode) continue;
      const children = outNodes
        .filter((n) => (n.parentId || null) === spec.id && n.type !== "folder")
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (!children.length) continue;
      const first = children[0];
      const entryId = `e_wiz_folder_entry_${spec.id}`;
      if (!edgeIds.has(entryId)) {
        edgeList.push({
          id: entryId,
          source: spec.id,
          target: first.id,
          animated: true,
          style: { strokeDasharray: "6 4", stroke: "#94a3b8", opacity: 0.35 },
        });
        edgeIds.add(entryId);
      }
    }
  }

  return { nodes: outNodes, edges: edgeList };
}

module.exports = {
  WIZARD_FLOW_FOLDERS,
  WIZ_FOLDER_PREFIX,
  folderizeWizardFlowGraph,
};
