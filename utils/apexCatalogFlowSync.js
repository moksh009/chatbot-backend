"use strict";

/**
 * Apex Light–specific wrapper — core logic lives in utils/flowMpmPatch.js (multi-tenant).
 * Seed graph slots: data/apexCatalogSlots.js
 */

const {
  APEX_CATALOG_SLOTS,
  MENU_NODE_ID,
  DEFAULT_FLOW_ID,
  injectApexCatalogGraph,
} = require("../data/apexCatalogSlots");
const { syncExploreMenuFromCollections } = require("./flowMpmPatch");

async function syncApexCatalogFlowFromMeta(clientId, opts = {}) {
  return syncExploreMenuFromCollections(clientId, {
    flowId: opts.flowId || DEFAULT_FLOW_ID,
    menuNodeId: MENU_NODE_ID,
    slots: APEX_CATALOG_SLOTS,
    injectGraph: true,
    ...opts,
  });
}

module.exports = {
  syncApexCatalogFlowFromMeta,
  APEX_CATALOG_SLOTS,
  MENU_NODE_ID,
  DEFAULT_FLOW_ID,
  injectApexCatalogGraph,
};
