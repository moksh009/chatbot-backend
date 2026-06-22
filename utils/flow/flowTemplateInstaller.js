'use strict';

const Client = require('../../models/Client');
const {
  getTemplateDefinition,
  folderIdForTemplate,
  buildInstallChecklist,
} = require('./flowTemplateCatalog');
const { generateEcommerceFlow, generateCommerceWizardPack, verifyFlowIntegrity } = require('./flowGenerator');
const { organizeFlowGraph, stampLayoutSections } = require('./flowLayoutOrganize');
const { createFlowsFromCommercePack } = require('./wizardCommercePackPersist');
const { clearClientCache } = require('../../middleware/apiCache');
const { clearTriggerCache } = require('./triggerEngine');

function verifyAllEdgesMatchButtonIds(nodes, edges) {
  const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
  for (const edge of edges || []) {
    if (!edge.sourceHandle) continue;
    const src = nodeById.get(edge.source);
    if (!src || src.type !== 'interactive') continue;
    const buttons = src.data?.buttonsList || [];
    const sections = src.data?.sections || [];
    const rowIds = sections.flatMap((s) => (s.rows || []).map((r) => r.id));
    const ids = [...buttons.map((b) => b.id), ...rowIds].filter(Boolean);
    if (ids.length && !ids.includes(edge.sourceHandle)) {
      console.warn('[flowTemplateInstaller] edge handle mismatch', edge.id, edge.sourceHandle);
    }
  }
}

function extractCanvasFolderLabels(nodes = []) {
  return (nodes || [])
    .filter((n) => n.type === 'folder')
    .map((n) => String(n.data?.label || n.data?.title || '').trim())
    .filter(Boolean);
}

async function generateTemplateGraph(client, templateDef) {
  let nodes = [];
  let edges = [];
  let flowName = templateDef.flowName(client);

  if (templateDef.useWizardPack) {
    const pack = await generateCommerceWizardPack(client, {
      features: templateDef.featurePreset,
      mainFlowName: flowName,
    });
    const main = pack.flows[0];
    nodes = main.nodes || [];
    edges = main.edges || [];
    flowName = main.name || flowName;
  } else {
    const main = await generateEcommerceFlow(client, {
      features: templateDef.featurePreset,
      useAiCopy: false,
      _splitAutomations: false,
    });
    const stamped = stampLayoutSections(main.nodes);
    const folderized = organizeFlowGraph(stamped, main.edges, {
      keepPositions: true,
      addEntryEdges: true,
      stampSections: false,
    });
    nodes = folderized.nodes;
    edges = folderized.edges;
  }

  verifyAllEdgesMatchButtonIds(nodes, edges);
  if (!verifyFlowIntegrity(nodes, edges)) {
    throw new Error(`Flow integrity validation failed for template ${templateDef.key}`);
  }

  return {
    slug: templateDef.key,
    name: flowName,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    canvasFolders: extractCanvasFolderLabels(nodes),
  };
}

function resolveInstallFolder(client, templateDef, { replace = false } = {}) {
  const baseId = folderIdForTemplate(templateDef.key);
  const existing = (client.flowFolders || []).find((f) => f.id === baseId);

  if (!existing) {
    return {
      folderId: baseId,
      folderName: templateDef.sidebarFolderName,
      replaced: false,
    };
  }

  if (replace) {
    return {
      folderId: baseId,
      folderName: templateDef.sidebarFolderName,
      replaced: true,
      priorFolderId: baseId,
    };
  }

  const copySuffix = Date.now().toString().slice(-4);
  return {
    folderId: `${baseId}_${copySuffix}`,
    folderName: `${templateDef.sidebarFolderName} (${copySuffix})`,
    replaced: false,
  };
}

async function removePriorTemplateInstall(clientId, folderId) {
  const WhatsAppFlow = require('../../models/WhatsAppFlow');
  const client = await Client.findOne({ clientId }).select('visualFlows flowFolders').lean();
  if (!client) return;

  const flowIdsInFolder = (client.visualFlows || [])
    .filter((f) => f.folderId === folderId)
    .map((f) => f.id || f.flowId)
    .filter(Boolean);

  if (flowIdsInFolder.length) {
    await WhatsAppFlow.deleteMany({ clientId, flowId: { $in: flowIdsInFolder } });
  }

  await Client.updateOne(
    { clientId },
    {
      $pull: {
        visualFlows: { folderId },
        flowFolders: { id: folderId },
      },
    }
  );
}

/**
 * Install a catalog template as DRAFT flow(s) in a dedicated sidebar folder.
 */
async function installFlowTemplate(client, templateKey, options = {}) {
  const templateDef = getTemplateDefinition(templateKey);
  if (!templateDef) {
    const err = new Error('Unknown flow template');
    err.statusCode = 404;
    throw err;
  }

  const clientId = client.clientId;
  const { replace = false } = options;
  const folderPlan = resolveInstallFolder(client, templateDef, { replace });

  if (folderPlan.replaced) {
    await removePriorTemplateInstall(clientId, folderPlan.priorFolderId);
  }

  const graph = await generateTemplateGraph(client, templateDef);

  const persisted = await createFlowsFromCommercePack(clientId, [graph], {
    generatedBy: `template_${templateKey}`,
    status: 'DRAFT',
    idPrefix: `flow_tpl_${templateKey}`,
    folderId: folderPlan.folderId,
    visualInlineGraph: false,
    visualMaxNodes: 0,
  });

  const folderEntry = {
    id: folderPlan.folderId,
    name: folderPlan.folderName,
    createdAt: new Date(),
    templateKey,
  };

  const folders = Array.isArray(client.flowFolders) ? [...client.flowFolders] : [];
  const withoutDup = folders.filter((f) => f.id !== folderPlan.folderId);
  withoutDup.push(folderEntry);

  for (const entry of persisted.visualEntries) {
    await Client.updateOne({ clientId }, { $push: { visualFlows: entry } });
  }

  await Client.updateOne({ clientId }, { $set: { flowFolders: withoutDup } });

  try {
    const { autoPatchMpmFlowNodes } = require('./flowMpmPatch');
    if (typeof autoPatchMpmFlowNodes === 'function' && templateDef.requiresShopify && persisted.primaryFlowId) {
      await autoPatchMpmFlowNodes(clientId, { flowId: persisted.primaryFlowId });
    }
  } catch (err) {
    console.warn('[flowTemplateInstaller] MPM patch skipped:', err?.message || err);
  }

  clearClientCache(clientId);
  clearTriggerCache(clientId);

  const checklist = buildInstallChecklist(templateDef);

  return {
    templateKey,
    folderId: folderPlan.folderId,
    folderName: folderPlan.folderName,
    primaryFlowId: persisted.primaryFlowId,
    flowIds: persisted.flowIds,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    canvasFolders: graph.canvasFolders,
    checklist,
    replaced: folderPlan.replaced,
  };
}

module.exports = {
  generateTemplateGraph,
  installFlowTemplate,
  extractCanvasFolderLabels,
};
