#!/usr/bin/env node
'use strict';

/**
 * Static E2E health check for template catalog + commerce automations wiring.
 * Writes NDJSON lines to .cursor/debug-6aeec5.log (session 6aeec5).
 */

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../../.cursor/debug-6aeec5.log');
const SESSION = '6aeec5';

function log(hypothesisId, message, data = {}) {
  const line = JSON.stringify({
    sessionId: SESSION,
    hypothesisId,
    location: 'scripts/debugTemplateE2EHealth.js',
    message,
    data,
    timestamp: Date.now(),
    runId: 'static-health',
  });
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function slotIds(catalog) {
  return (catalog.groups || []).flatMap((g) => (g.slots || []).map((s) => s.id)).sort();
}

function main() {
  const root = path.join(__dirname, '../..');
  const catalogPaths = {
    shared: path.join(root, 'shared/template-catalog.json'),
    backend: path.join(root, 'chatbot-backend-main/constants/templateCatalog/template-catalog.json'),
    frontend: path.join(root, 'chatbot-dashboard-frontend-main/src/config/template-catalog.json'),
  };

  const catalogs = {};
  for (const [key, p] of Object.entries(catalogPaths)) {
    catalogs[key] = fs.existsSync(p) ? readJson(p) : null;
  }

  const sharedIds = catalogs.shared ? slotIds(catalogs.shared) : [];
  const backendIds = catalogs.backend ? slotIds(catalogs.backend) : [];
  const frontendIds = catalogs.frontend ? slotIds(catalogs.frontend) : [];

  const drift =
    JSON.stringify(sharedIds) !== JSON.stringify(backendIds) ||
    JSON.stringify(sharedIds) !== JSON.stringify(frontendIds);

  log('H1', 'catalog_file_drift', {
    drift,
    sharedCount: sharedIds.length,
    backendCount: backendIds.length,
    frontendCount: frontendIds.length,
    onlyInBackend: backendIds.filter((id) => !sharedIds.includes(id)),
    onlyInFrontend: frontendIds.filter((id) => !sharedIds.includes(id)),
    onlyInShared: sharedIds.filter((id) => !backendIds.includes(id)),
  });

  const { PREBUILT_TEMPLATE_LIBRARY } = require('../constants/prebuiltTemplateLibrary');
  const prebuiltMetaNames = PREBUILT_TEMPLATE_LIBRARY.map((t) => t.metaName);

  const catalogPrebuiltSlots = (catalogs.backend?.groups || [])
    .flatMap((g) => g.slots || [])
    .filter((s) => s.pushKind === 'prebuilt' || s.prebuiltKey);

  const missingPrebuilt = catalogPrebuiltSlots
    .filter((s) => {
      const key = s.prebuiltKey || s.canonicalMetaName;
      return !PREBUILT_TEMPLATE_LIBRARY.find(
        (t) => t.key === key || t.metaName === key || t.metaName === s.canonicalMetaName
      );
    })
    .map((s) => s.id);

  log('H1', 'prebuilt_catalog_coverage', {
    prebuiltLibraryCount: PREBUILT_TEMPLATE_LIBRARY.length,
    catalogPrebuiltSlotCount: catalogPrebuiltSlots.length,
    missingPrebuilt,
    prebuiltRequired: catalogs.backend?.prebuiltRequiredMetaNames || [],
    cartRecovery3InRequired: (catalogs.backend?.prebuiltRequiredMetaNames || []).includes('cart_recovery_3'),
  });

  const { buildSystemAutomations, ORDER_NOTIFICATION_SLOTS, ABANDONED_CART_SLOTS } = require('../utils/commerce/commerceAutomationPresets');
  const { ORDER_STATUS_ECO_REGISTRY } = require('../utils/commerce/orderStatusTemplatePolicy');
  const systemRules = buildSystemAutomations();

  const orderRules = systemRules.filter((r) => r.meta?.category === 'order_notification');
  const cartRules = systemRules.filter((r) => r.meta?.category === 'abandoned_cart');

  const ecoStatuses = Object.keys(ORDER_STATUS_ECO_REGISTRY);
  const sacOrderEvents = orderRules.map((r) => r.event);
  const missingEcoInSac = ecoStatuses.filter((s) => !sacOrderEvents.includes(s));

  log('H4', 'order_status_sac_vs_eco', {
    sacOrderEvents,
    ecoStatuses,
    missingEcoInSac,
    sacOrderRuleCount: orderRules.length,
    expectedOrderSlots: ORDER_NOTIFICATION_SLOTS,
    cartRuleCount: cartRules.length,
    cartDelays: cartRules.map((r) => ({
      slot: r.meta?.systemSlot,
      delayMinutes: r.delayMinutes,
    })),
  });

  const { cartFollowupSyncPatch } = require('../utils/commerce/commerceAutomationPresets');
  const syncPatches = cartRules.map((r) => ({
    slot: r.meta?.systemSlot,
    patch: cartFollowupSyncPatch(r),
  }));

  log('H3', 'cart_followup_sync_patch', { syncPatches });

  log('H5', 'system_automation_shape', {
    totalSystemRules: systemRules.length,
    allHaveIds: systemRules.every((r) => r.id),
    cartTriggerType: cartRules.every((r) => r.triggerType === 'abandoned_cart'),
    orderTriggerType: orderRules.every((r) => r.triggerType === 'order_status'),
  });

  console.log('Template E2E health check written to', LOG_PATH);
  console.log('catalog drift:', drift);
  console.log('missing prebuilt slots:', missingPrebuilt.length);
}

main();
