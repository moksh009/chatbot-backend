"use strict";

/**
 * Multi-tenant flow graph resolution — single place to load graphs for:
 * - WhatsApp trigger engine (slim routing index)
 * - Dual-brain execution (full published graph)
 * - Flow Builder API (list + canvas)
 *
 * Never rely on webhook-cached Client docs (they exclude visualFlows / flowNodes).
 */

const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { sanitizeFlowNodesMedia } = require("./sanitizeFlowMedia");
const { normalizeFlowNodes } = require("./normalizeFlowVariables");

const RUNTIME_SKIP_NODE_TYPES = new Set(["folder", "group", "sticky", "StickyNote"]);

function flattenFlowNodes(nodes) {
  const flat = [];
  function traverse(nodeList) {
    if (!Array.isArray(nodeList)) return;
    for (const node of nodeList) {
      if (node.type && !RUNTIME_SKIP_NODE_TYPES.has(node.type)) {
        flat.push(node);
      }
      if (node.children && Array.isArray(node.children)) traverse(node.children);
      if (node.data?.nodes && Array.isArray(node.data.nodes)) traverse(node.data.nodes);
      if (node.nodes && Array.isArray(node.nodes)) traverse(node.nodes);
    }
  }
  traverse(nodes);
  return flat;
}

const TRIGGER_NODE_TYPES = new Set([
  "trigger",
  "TriggerNode",
  "intent_trigger",
  "IntentTriggerNode",
]);

function pickGraphFromFlowDoc(doc) {
  if (!doc) return null;
  const pubNodes = doc.publishedNodes?.length ? doc.publishedNodes : null;
  const pubEdges = doc.publishedEdges?.length ? doc.publishedEdges : null;
  const draftNodes = doc.nodes?.length ? doc.nodes : null;
  const rawNodes = pubNodes || draftNodes;
  if (!rawNodes?.length) return null;
  const rawEdges = pubEdges || doc.edges || [];
  return {
    nodes: normalizeFlowNodes(sanitizeFlowNodesMedia(rawNodes)),
    edges: rawEdges,
    status: doc.status || "DRAFT",
    fromPublished: !!pubNodes?.length,
  };
}

function pickGraphFromVisualEntry(vf) {
  if (!vf?.nodes?.length) return null;
  return {
    nodes: normalizeFlowNodes(sanitizeFlowNodesMedia(vf.nodes)),
    edges: vf.edges || [],
    status: vf.isActive ? "PUBLISHED" : "DRAFT",
    fromPublished: !!vf.isActive,
  };
}

/**
 * Load all flow sources for a tenant (always hits Mongo).
 */
async function loadClientFlowSources(clientId) {
  if (!clientId) {
    return {
      whatsappFlows: [],
      visualFlows: [],
      legacyNodes: [],
      legacyEdges: [],
      flowFolders: [],
    };
  }

  const [whatsappFlows, clientLean] = await Promise.all([
    WhatsAppFlow.find({ clientId })
      .select(
        "flowId name platform folderId status version nodes edges publishedNodes publishedEdges triggerConfig isAutomation channel updatedAt createdAt"
      )
      .lean(),
    Client.findOne({ clientId })
      .select("visualFlows flowNodes flowEdges flowFolders clientId")
      .lean(),
  ]);

  return {
    whatsappFlows: whatsappFlows || [],
    visualFlows: clientLean?.visualFlows || [],
    legacyNodes: clientLean?.flowNodes || [],
    legacyEdges: clientLean?.flowEdges || [],
    flowFolders: clientLean?.flowFolders || [],
  };
}

/** Slim routing bundles for triggerEngine (trigger nodes + edges only). */
function buildSlimRoutingBundles(flows) {
  return (flows || []).map((flow) => {
    const pubNodes =
      flow.publishedNodes?.length > 0 ? flow.publishedNodes : flow.nodes || [];
    const pubEdges =
      flow.publishedEdges?.length > 0 ? flow.publishedEdges : flow.edges || [];
    const triggerNodes = pubNodes.filter((n) => TRIGGER_NODE_TYPES.has(n.type));
    const triggerIds = new Set(triggerNodes.map((n) => n.id));
    const routingEdges = pubEdges.filter((e) => triggerIds.has(e.source));
    return {
      _id: flow._id,
      flowId: flow.flowId || flow.id,
      id: flow.flowId || flow.id,
      name: flow.name,
      status: flow.status,
      triggerConfig: flow.triggerConfig,
      channel: flow.channel,
      isAutomation: flow.isAutomation,
      triggerNodes,
      routingEdges,
      nodes: pubNodes,
      edges: pubEdges,
    };
  });
}

/**
 * Routing index for trigger matching — prefers PUBLISHED WhatsAppFlow, then any WA flow, then visualFlows, then legacy flowNodes.
 */
async function loadRoutingIndexForClient(clientId) {
  const sources = await loadClientFlowSources(clientId);
  const published = sources.whatsappFlows.filter((f) => f.status === "PUBLISHED");
  let pool = published.length ? published : sources.whatsappFlows;

  let bundles = buildSlimRoutingBundles(pool);

  if (!bundles.length && sources.visualFlows.length) {
    pool = sources.visualFlows.map((vf) => ({
      flowId: vf.id,
      id: vf.id,
      name: vf.name,
      platform: vf.platform || "whatsapp",
      folderId: vf.folderId || "",
      status: vf.isActive ? "PUBLISHED" : "DRAFT",
      nodes: vf.nodes,
      edges: vf.edges,
      isAutomation: !!vf.isAutomation,
      triggerConfig: vf.triggerConfig,
    }));
    bundles = buildSlimRoutingBundles(pool);
  }

  if (!bundles.length && sources.legacyNodes.length) {
    const flat = flattenFlowNodes(sources.legacyNodes);
    const triggerNodes = flat.filter((n) => TRIGGER_NODE_TYPES.has(n.type));
    const triggerIds = new Set(triggerNodes.map((n) => n.id));
    bundles = [
      {
        flowId: "legacy_main",
        id: "legacy_main",
        name: "Main automation",
        status: "PUBLISHED",
        isAutomation: false,
        isLegacy: true,
        triggerNodes,
        routingEdges: (sources.legacyEdges || []).filter((e) => triggerIds.has(e.source)),
        nodes: sources.legacyNodes,
        edges: sources.legacyEdges || [],
      },
    ];
  }

  return { bundles, sources };
}

/**
 * Full flattened graph for execution / canvas.
 */
async function resolveFlowGraphByRef(clientId, flowRef, options = {}) {
  if (!clientId || !flowRef) return null;
  const ref = String(flowRef);
  const sources = options.sources || (await loadClientFlowSources(clientId));

  for (const doc of sources.whatsappFlows) {
    if (String(doc.flowId) !== ref && String(doc._id) !== ref) continue;
    const graph = pickGraphFromFlowDoc(doc);
    if (graph) {
      return {
        id: doc.flowId || String(doc._id),
        mongoId: String(doc._id),
        name: doc.name || "",
        nodes: flattenFlowNodes(graph.nodes),
        edges: graph.edges,
        status: graph.status,
      };
    }
  }

  const vf = sources.visualFlows.find(
    (f) => String(f.id) === ref || String(f._id) === ref
  );
  if (vf) {
    const graph = pickGraphFromVisualEntry(vf);
    if (graph) {
      return {
        id: vf.id,
        name: vf.name || "",
        nodes: flattenFlowNodes(graph.nodes),
        edges: graph.edges,
        status: graph.status,
      };
    }
  }

  if (ref === "legacy_main" && sources.legacyNodes.length) {
    return {
      id: "legacy_main",
      name: "Main automation",
      nodes: flattenFlowNodes(sources.legacyNodes),
      edges: sources.legacyEdges || [],
      status: "PUBLISHED",
      isLegacy: true,
    };
  }

  return null;
}

/** Primary live graph when conversation has no activeFlowId. */
async function resolvePrimaryFlowGraph(clientId) {
  const sources = await loadClientFlowSources(clientId);

  const activeVf = sources.visualFlows.find((f) => f.isActive && f.nodes?.length);
  if (activeVf) {
    const g = pickGraphFromVisualEntry(activeVf);
    if (g) {
      return {
        id: activeVf.id,
        name: activeVf.name || "",
        nodes: flattenFlowNodes(g.nodes),
        edges: g.edges,
      };
    }
  }

  const publishedDoc = sources.whatsappFlows.find(
    (f) => f.status === "PUBLISHED" && (f.publishedNodes?.length || f.nodes?.length)
  );
  if (publishedDoc) {
    const g = pickGraphFromFlowDoc(publishedDoc);
    if (g) {
      return {
        id: publishedDoc.flowId || String(publishedDoc._id),
        name: publishedDoc.name || "",
        nodes: flattenFlowNodes(g.nodes),
        edges: g.edges,
      };
    }
  }

  const anyDoc = sources.whatsappFlows.find(
    (f) => f.publishedNodes?.length || f.nodes?.length
  );
  if (anyDoc) {
    const g = pickGraphFromFlowDoc(anyDoc);
    if (g) {
      return {
        id: anyDoc.flowId || String(anyDoc._id),
        name: anyDoc.name || "",
        nodes: flattenFlowNodes(g.nodes),
        edges: g.edges,
      };
    }
  }

  const vfWithNodes = sources.visualFlows.find((f) => f.nodes?.length);
  if (vfWithNodes) {
    const g = pickGraphFromVisualEntry(vfWithNodes);
    if (g) {
      return {
        id: vfWithNodes.id,
        name: vfWithNodes.name || "",
        nodes: flattenFlowNodes(g.nodes),
        edges: g.edges,
      };
    }
  }

  if (sources.legacyNodes.length) {
    return {
      id: "legacy_main",
      name: "Main automation",
      nodes: flattenFlowNodes(sources.legacyNodes),
      edges: sources.legacyEdges || [],
      isLegacy: true,
    };
  }

  return { id: null, name: "", nodes: [], edges: [] };
}

/**
 * Merge WhatsAppFlow rows + visualFlows-only entries for Flow Builder list API.
 */
function mergeFlowsListForDashboard(dbFlows, visualFlows = [], flowFolders = []) {
  const byId = new Map();

  for (const f of dbFlows || []) {
    const id = f.flowId || f.id;
    if (!id) continue;
    byId.set(String(id), {
      id,
      name: f.name,
      platform: f.platform || "whatsapp",
      folderId: f.folderId || "",
      isActive: f.status === "PUBLISHED",
      status: f.status || "DRAFT",
      version: f.version || 1,
      nodeCount: Array.isArray(f.nodes) ? f.nodes.length : f.publishedNodes?.length || 0,
      edgeCount: Array.isArray(f.edges) ? f.edges.length : f.publishedEdges?.length || 0,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      lastSyncedAt: f.lastSyncedAt,
      source: "whatsapp_flow",
    });
  }

  for (const vf of visualFlows || []) {
    const id = vf.id;
    if (!id || byId.has(String(id))) continue;
    byId.set(String(id), {
      id,
      name: vf.name || "Untitled flow",
      platform: vf.platform || "whatsapp",
      folderId: vf.folderId || "",
      isActive: !!vf.isActive,
      status: vf.isActive ? "PUBLISHED" : "DRAFT",
      version: vf.version || 1,
      nodeCount: Array.isArray(vf.nodes) ? vf.nodes.length : 0,
      edgeCount: Array.isArray(vf.edges) ? vf.edges.length : 0,
      createdAt: vf.createdAt,
      updatedAt: vf.updatedAt,
      source: "visual_flow",
    });
  }

  return {
    flows: Array.from(byId.values()),
    flowFolders: flowFolders || [],
  };
}

module.exports = {
  flattenFlowNodes,
  loadClientFlowSources,
  buildSlimRoutingBundles,
  loadRoutingIndexForClient,
  resolveFlowGraphByRef,
  resolvePrimaryFlowGraph,
  mergeFlowsListForDashboard,
};
