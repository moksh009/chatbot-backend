'use strict';

const { getCachedClient } = require('../core/clientCache');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { buildMetaHubHealth } = require('./metaHubHealth');
const {
  resolveSlotsForClient,
  getCatalogVersion,
  loadCatalog,
  validateEcoStandardPack,
} = require('../../constants/templateCatalog');
const { MULTI_STORE_MODEL } = require('../../services/templateBrandOverrides');
const { getUnifiedTemplateReadiness } = require('../../constants/templateCatalog/readiness');
const { STANDARD_TEMPLATES } = require('../../constants/standardTemplates');
const { buildMetaTemplatesListPayload } = require('../../controllers/metaTemplates/metaTemplatesApiController');

async function safeTemplateContext(clientId) {
  const client = await getCachedClient(clientId, 'syncedMetaTemplates whatsappToken phoneNumberId wabaId');
  const flags = buildConnectionStatusPayload(client || {});
  if (!flags.whatsapp_connected) {
    return { synced: [], whatsappConfigured: false };
  }
  const synced = Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  return { synced, whatsappConfigured: true };
}

async function isWhatsAppConnected(clientId) {
  const client = await getCachedClient(clientId, 'whatsappToken phoneNumberId wabaId');
  const flags = buildConnectionStatusPayload(client || {});
  return !!flags.whatsapp_connected;
}

async function buildSlotsSection(clientId) {
  const { synced, whatsappConfigured } = await safeTemplateContext(clientId);
  if (!whatsappConfigured) {
    const catalog = loadCatalog();
    return {
      success: true,
      data: {
        version: getCatalogVersion(),
        clientId,
        summary: { total: 0, approved: 0, pending: 0, missing: 0 },
        groups: [],
        nameAliases: catalog.nameAliases || {},
        prebuiltRequiredMetaNames: catalog.prebuiltRequiredMetaNames || [],
        featureAutomations: catalog.featureAutomations || [],
        multiStoreModel: MULTI_STORE_MODEL,
        whatsappConfigured: false,
      },
      meta: {
        catalogVersion: getCatalogVersion(),
        multiStoreModel: MULTI_STORE_MODEL,
        ecoPackValid: true,
      },
    };
  }

  const resolved = await resolveSlotsForClient(clientId, { syncedTemplates: synced });
  const catalog = loadCatalog();
  const ecoValidation = validateEcoStandardPack(STANDARD_TEMPLATES);

  return {
    success: true,
    data: {
      version: getCatalogVersion(),
      clientId,
      summary: resolved.summary,
      groups: resolved.groups,
      nameAliases: catalog.nameAliases || {},
      prebuiltRequiredMetaNames: catalog.prebuiltRequiredMetaNames || [],
      featureAutomations: catalog.featureAutomations || [],
      multiStoreModel: MULTI_STORE_MODEL,
    },
    meta: {
      catalogVersion: getCatalogVersion(),
      multiStoreModel: MULTI_STORE_MODEL,
      ecoPackValid: ecoValidation.ok,
    },
  };
}

async function buildReadinessSection(clientId) {
  const { synced, whatsappConfigured } = await safeTemplateContext(clientId);
  if (!whatsappConfigured) {
    return {
      success: true,
      data: {
        whatsappConfigured: false,
        slots: {},
        summary: { approved: 0, pending: 0, missing: 0 },
      },
    };
  }
  const data = await getUnifiedTemplateReadiness(clientId, { syncedTemplates: synced });
  return { success: true, data: { ...data, whatsappConfigured: true } };
}

async function buildTemplateListSection(clientId, user) {
  const templatesRouter = require('../../routes/templates');
  if (typeof templatesRouter.buildTemplateListForClient !== 'function') {
    throw new Error('Template list builder unavailable');
  }
  return templatesRouter.buildTemplateListForClient(clientId, user);
}

async function buildMetaWorkspaceShell(clientId, options = {}) {
  const { user, clientConfig, tab = 'library', page = 1 } = options;
  const sectionsRaw = String(options.sections || 'templates,health')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const wantTemplates = sectionsRaw.includes('templates') || sectionsRaw.includes('library');
  const wantHealth = sectionsRaw.includes('health');

  const waConnected = await isWhatsAppConnected(clientId);
  const [slotsResult, readinessResult] = await Promise.allSettled([
    buildSlotsSection(clientId),
    buildReadinessSection(clientId),
  ]);
  const emptyTemplates = {
    list: { success: true, data: [], syncedAt: null },
    libraryPage: {
      success: true,
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 1 },
      availableUsageTags: [],
    },
    slots: slotsResult.status === 'fulfilled' ? slotsResult.value : { success: false, data: null },
    readiness: readinessResult.status === 'fulfilled' ? readinessResult.value : { success: false, data: null },
  };

  if (!waConnected) {
    return {
      whatsappLive: false,
      templates: emptyTemplates,
      health: wantHealth ? null : undefined,
      meta: { partial: false, tab, disconnected: true },
    };
  }

  const tasks = [];
  const taskKeys = [];

  if (wantTemplates) {
    taskKeys.push('list', 'libraryPage', 'slots', 'readiness');
    tasks.push(
      buildTemplateListSection(clientId, user),
      buildMetaTemplatesListPayload(clientId, { page, search: '', statuses: '', usageTags: '' }),
      buildSlotsSection(clientId),
      buildReadinessSection(clientId)
    );
  } else if (tab === 'library') {
    taskKeys.push('slots', 'readiness');
    tasks.push(buildSlotsSection(clientId), buildReadinessSection(clientId));
  }

  if (wantHealth) {
    taskKeys.push('health');
    // Cap health check at 6 s — it calls live Shopify webhook API which can be slow.
    const HEALTH_TIMEOUT_MS = 6000;
    tasks.push(
      Promise.race([
        buildMetaHubHealth(clientId, clientConfig),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('health_section_timeout')), HEALTH_TIMEOUT_MS)
        ),
      ])
    );
  }

  const results = await Promise.allSettled(tasks);
  const failedSections = [];
  const out = {
    whatsappLive: true,
    templates: {},
    health: null,
    meta: { partial: false, tab },
  };

  results.forEach((result, i) => {
    const key = taskKeys[i];
    if (result.status === 'fulfilled') {
      if (key === 'list') out.templates.list = result.value;
      else if (key === 'libraryPage') out.templates.libraryPage = result.value;
      else if (key === 'slots') out.templates.slots = result.value;
      else if (key === 'readiness') out.templates.readiness = result.value;
      else if (key === 'health') out.health = result.value;
    } else {
      failedSections.push(key);
      console.warn(`[meta/workspace/shell] ${key}:`, result.reason?.message || result.reason);
    }
  });

  out.meta.partial = failedSections.length > 0;
  out.meta.failedSections = failedSections;
  return out;
}

module.exports = {
  buildMetaWorkspaceShell,
  isWhatsAppConnected,
};
