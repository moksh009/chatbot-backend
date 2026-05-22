"use strict";

/**
 * @deprecated Use flowLayoutOrganize.organizeFlowGraph (multi-tenant).
 */
const { organizeFlowGraph } = require("./flowLayoutOrganize");

function folderizeWizardFlowGraph(nodes, edges, opts = {}) {
  return organizeFlowGraph(nodes, edges, opts);
}

module.exports = {
  folderizeWizardFlowGraph,
};
