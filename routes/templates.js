const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/core/queryHelpers');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');
const log = require('../utils/core/logger')('TemplateAPI');
const { decrypt } = require('../utils/core/encryption');
const Client = require('../models/Client');
const User = require('../models/User');
const { STANDARD_TEMPLATES } = require('../constants/standardTemplates');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { uploadToCloud } = require('../utils/core/cloudinary');
const { getFastScore, analyzeWithGeminiAndRewrite } = require('../utils/meta/templateScorer');
const { getPrebuiltTemplates } = require('../utils/flow/flowGenerator');
const { hydrateApprovedProductTemplatesForClient } = require('../utils/meta/templateImageHydrate');
const MetaTemplate = require('../models/MetaTemplate');
const { normalizeTemplateStatus } = require('../constants/templateLifecycle');
const {
  resolveSlotsForClient,
  getCatalogVersion,
  loadCatalog,
  validateEcoStandardPack,
} = require('../constants/templateCatalog');
const { getUnifiedTemplateReadiness } = require('../constants/templateCatalog/readiness');
const {
  listOverridesForClient,
  patchOverrideForSlot,
  applyOverridesToStandardTemplate,
  MULTI_STORE_MODEL,
} = require('../services/templateBrandOverrides');
const {
  assertSuperAdmin,
  bulkPushEcoPack,
  getApprovalBoard,
} = require('../services/templateAdminOps');
const { getLatestAudits, runCatalogValidationJob } = require('../constants/templateCatalog/validation');
const {
  recordTemplateSubmission,
  reconcileSyncedTemplatesWithCatalog,
  pollPendingMetaTemplatesForClient,
} = require('../services/templateLifecycleBridge');
const { normalizePurpose } = require('../utils/meta/templateEligibility');
const { apiCache } = require('../middleware/apiCache');

/** In-process list cache — avoids 40s+ stalls when Redis/Mongo is contended. */
const templateListMemCache = new Map();
const TEMPLATE_LIST_MEM_TTL_MS = 45_000;

function templateListMemKey(clientId, contextPurpose) {
  return `${clientId || ''}:${contextPurpose || '*'}`;
}

function readTemplateListMemCache(key) {
  const row = templateListMemCache.get(key);
  if (!row || row.exp < Date.now()) return null;
  return row.body;
}

function writeTemplateListMemCache(key, body, ttlMs) {
  const ttl = Number(ttlMs) > 0 ? ttlMs : TEMPLATE_LIST_MEM_TTL_MS;
  templateListMemCache.set(key, { exp: Date.now() + ttl, body });
}

// --- Helper Functions ---
async function getClientCredentials(clientId, userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // SUPER_ADMIN can access any client; others can only access their own clientId
    if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
        throw new Error('Unauthorized: You can only manage templates for your own client.');
    }

    const client = await Client.findOne({ clientId });

    if (!client) throw new Error('Client not found');
    const wabaId = client.wabaId || client.whatsapp?.wabaId;
    const rawToken = client.whatsappToken || client.whatsapp?.accessToken;
    if (!wabaId) throw new Error('WABA ID (WhatsApp Business Account ID) is not configured for this client.');
    if (!rawToken) throw new Error('WhatsApp Token is not configured for this client.');
    client.wabaId = wabaId;
    client.whatsappToken = decrypt(rawToken) || rawToken;

    return client;
}

// 1. Fetch All Templates from Meta
router.get('/sync', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

        const client = await getClientCredentials(clientId, req.user.id);

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates?fields=name,status,category,language,components`;
        
        try {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` },
                timeout: 12000,
            });
            let templates = response.data.data || [];
            
            // Enrich with variable metrics
            templates = templates.map(tpl => {
                let bodyVars = 0;
                let headerVars = 0;
                let headerFormat = 'NONE';
                
                if (tpl.components) {
                    const bodyComp = tpl.components.find(c => c.type === 'BODY');
                    if (bodyComp && bodyComp.text) {
                        const paramMatches = bodyComp.text.match(/{{(\d+)}}/g) || [];
                        if (paramMatches.length > 0) {
                            bodyVars = Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0])));
                        }
                    }
                    
                    const headerComp = tpl.components.find(c => c.type === 'HEADER');
                    if (headerComp) {
                        headerFormat = headerComp.format || 'NONE';
                        if (headerComp.text) {
                            const paramMatches = headerComp.text.match(/{{(\d+)}}/g) || [];
                            if (paramMatches.length > 0) {
                                headerVars = Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0])));
                            }
                        }
                    }
                }
                
                return {
                    ...tpl,
                    primaryPurpose: normalizePurpose(tpl.primaryPurpose || 'utility'),
                    secondaryPurposes: Array.isArray(tpl.secondaryPurposes)
                      ? tpl.secondaryPurposes.map((p) => normalizePurpose(p))
                      : [],
                    variableMetrics: {
                        bodyVariables: bodyVars,
                        headerVariables: headerVars,
                        totalVariables: bodyVars + headerVars,
                        headerFormat
                    }
                };
            });

            // PERSIST to Client model so backend can use them for param detection
            await Client.updateOne(
                { clientId },
                { $set: { syncedMetaTemplates: templates, templatesSyncedAt: new Date() } }
            );

            try {
              await reconcileSyncedTemplatesWithCatalog(clientId, templates);
              await pollPendingMetaTemplatesForClient(clientId);
            } catch (lifeErr) {
              console.warn('[Template API] Post-sync lifecycle:', lifeErr.message);
            }

            try {
                const fresh = await Client.findOne({ clientId }).lean();
                if (fresh) {
                    await hydrateApprovedProductTemplatesForClient(fresh, { force: false, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
                }
            } catch (hErr) {
                console.warn('[Template API] Post-sync product image hydrate:', hErr.message);
            }

            res.json({ success: true, data: templates });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            const timedOut =
              metaErr.code === 'ECONNABORTED' ||
              String(metaErr.message || '').toLowerCase().includes('timeout');
            console.error('[Template API] Meta Sync Error:', metaErr.response?.data || metaErr.message);
            if (timedOut) {
              const cached = await Client.findOne({ clientId })
                .select('syncedMetaTemplates templatesSyncedAt')
                .lean();
              const stale = Array.isArray(cached?.syncedMetaTemplates) ? cached.syncedMetaTemplates : [];
              if (stale.length) {
                return res.json({
                  success: true,
                  data: stale,
                  stale: true,
                  syncedAt: cached.templatesSyncedAt,
                });
              }
            }
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to sync templates from Meta', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        console.error('[Template API] Sync Error:', error.message);
        const isMissingCredentials = error.message.includes('not configured') || error.message.includes('Unauthorized');
        res.status(isMissingCredentials ? 400 : 500).json({ 
            success: false, 
            message: error.message,
            isIntegrationAuthError: isMissingCredentials
        });
    }
});

// 1b. Fetch Templates from Local DB Cache (Lightweight)
async function handleGetTemplateList(req, res) {
    const { createTimer } = require('../utils/core/perfLogger');
    const { getCachedClient } = require('../utils/core/clientCache');
    const timer = createTimer('GET /api/templates/list', tenantClientId(req) || '');
    try {
        const clientId = tenantClientId(req);
        if (!clientId) {
            timer.finish('403');
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const contextPurpose = req.query.contextPurpose
          ? normalizePurpose(req.query.contextPurpose, 'utility')
          : null;
        const skipCanonical = req.query.skipCanonical === '1' || req.query.liveChat === '1';
        const isUnifiedQuery = req.query.unified === '1' || req.query.unified === 'true';
        const memKey = templateListMemKey(
          clientId,
          `${contextPurpose || ''}:${skipCanonical ? 'fast' : 'full'}:${isUnifiedQuery ? 'unified' : 'plain'}`
        );
        const memHit = readTemplateListMemCache(memKey);
        if (memHit) {
          timer.finish(`200 ok mem-cache | count=${memHit.data?.length || 0}`);
          return res.setHeader('X-Cache', 'HIT-MEMORY').json(memHit);
        }

        const client = await timer.time('getCachedClient', () =>
          getCachedClient(
            clientId,
            'syncedMetaTemplates templatesSyncedAt messageTemplates pendingTemplates clientId'
          )
        );
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
        const localTemplates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
        const pendingMap = new Map((Array.isArray(client.pendingTemplates) ? client.pendingTemplates : []).map(t => [t.name, String(t.status || 'PENDING').toUpperCase()]));
        const syncedStatusByName = new Map(
          synced.filter((t) => t?.name).map((t) => [t.name, String(t.status || 'APPROVED').toUpperCase()])
        );

        const mergedMap = new Map();
        localTemplates.forEach((tpl) => {
          if (!tpl?.name) return;
          const pendingStatus = pendingMap.get(tpl.name);
          const status = pendingStatus || String(tpl.status || 'PENDING').toUpperCase();
          mergedMap.set(tpl.name, { ...tpl, status, source: tpl.source || 'message_templates' });
        });

        let canonical = [];
        const META_LIST_MAX_MS = parseInt(process.env.META_TEMPLATE_LIST_MAX_MS || '8000', 10) || 8000;
        if (!skipCanonical) {
        timer.checkpoint('before_meta_find');
        canonical = await timer.time('meta_template_find', () =>
          MetaTemplate.find({ clientId })
          .select(
            'name internalName status category language components formData body footerText buttons headerType headerValue productImageUrl bodySamples usageTags templateKind readinessRequired submissionStatus primaryPurpose secondaryPurposes metaApiError variableMapping metaTemplateId source updatedAt'
          )
          .sort({ updatedAt: -1 })
          .maxTimeMS(META_LIST_MAX_MS)
          .lean()
        );
        timer.checkpoint(`meta_find_done | count=${canonical.length}`);
        } else {
          timer.checkpoint('skip_canonical_meta_find');
        }
        const usageTagToPurpose = (tag) => {
          const legacy = {
            Campaign: 'campaign',
            Sequence: 'sequence',
            'Flow Builder': 'flow',
            Utility: 'utility',
          };
          return legacy[tag] || 'utility';
        };

        if (!skipCanonical) {
        canonical.forEach((tpl) => {
          if (!tpl?.name) return;
          const mappedStatus = normalizeTemplateStatus(tpl.submissionStatus);
          const status =
            mappedStatus === 'APPROVED' ? 'APPROVED' :
            mappedStatus === 'REJECTED' ? 'REJECTED' :
            mappedStatus === 'FAILED' ? 'FAILED' :
            mappedStatus === 'QUEUED' ? 'QUEUED' :
            mappedStatus === 'SUBMITTING' ? 'SUBMITTING' :
            mappedStatus === 'DRAFT' ? 'DRAFT' : 'PENDING';
          const components = [];
          const fd = tpl.formData && typeof tpl.formData === 'object' ? tpl.formData : null;
          const hasRichForm =
            fd &&
            (fd.bodyText != null ||
              fd.headerText ||
              fd.headerImageUrl ||
              (fd.buttons && fd.buttons.length));

          if (hasRichForm) {
            const bodyTxt = fd.bodyText != null ? fd.bodyText : tpl.body || '';
            if (fd.mediaSample === 'Image' && fd.headerImageUrl) {
              components.push({ type: 'HEADER', format: 'IMAGE', _imageUrl: fd.headerImageUrl });
            } else if (fd.headerText && String(fd.headerText).trim()) {
              components.push({ type: 'HEADER', format: 'TEXT', text: fd.headerText });
            }
            const bodySamples =
              (Array.isArray(fd.bodySamples) && fd.bodySamples.length ? fd.bodySamples : null) ||
              (Array.isArray(tpl.bodySamples) && tpl.bodySamples.length ? tpl.bodySamples : null);
            const bodyComp = { type: 'BODY', text: bodyTxt };
            if (bodySamples?.length) {
              bodyComp.example = { body_text: [bodySamples] };
            }
            components.push(bodyComp);
            const foot = fd.footerText != null ? fd.footerText : tpl.footerText;
            if (foot) components.push({ type: 'FOOTER', text: foot });
            const btnSrc = fd.buttons && fd.buttons.length ? fd.buttons : tpl.buttons;
            if (Array.isArray(btnSrc) && btnSrc.length) {
              const mappedBtns = btnSrc.map((b) => {
                if (b.buttonType) {
                  if (b.buttonType === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
                  if (b.buttonType === 'URL') {
                    const row = { type: 'URL', text: b.text, url: b.url || '' };
                    if (b.urlType === 'Dynamic' && b.sampleUrl) row.example = [b.sampleUrl];
                    return row;
                  }
                  if (b.buttonType === 'PHONE_NUMBER') {
                    return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phoneNumber || '' };
                  }
                  if (b.buttonType === 'COPY_CODE') {
                    return { type: 'COPY_CODE', text: b.text, example: b.couponCode || '' };
                  }
                }
                return b;
              });
              components.push({ type: 'BUTTONS', buttons: mappedBtns });
            }
          } else {
            if (tpl.headerType && tpl.headerType !== 'NONE') {
              if (String(tpl.headerType).toUpperCase() === 'IMAGE') {
                components.push({ type: 'HEADER', format: 'IMAGE', _imageUrl: tpl.headerValue || tpl.productImageUrl || '' });
              } else {
                components.push({ type: 'HEADER', format: 'TEXT', text: tpl.headerValue || '' });
              }
            }
            const legacyBodySamples = Array.isArray(tpl.bodySamples) && tpl.bodySamples.length ? tpl.bodySamples : null;
            const legacyBody = { type: 'BODY', text: tpl.body || '' };
            if (legacyBodySamples) legacyBody.example = { body_text: [legacyBodySamples] };
            components.push(legacyBody);
            if (tpl.footerText) components.push({ type: 'FOOTER', text: tpl.footerText });
            if (Array.isArray(tpl.buttons) && tpl.buttons.length) components.push({ type: 'BUTTONS', buttons: tpl.buttons });
          }

          const usageTags = Array.isArray(tpl.usageTags) ? tpl.usageTags : [];
          const primaryFromUsage = usageTags.length ? usageTagToPurpose(usageTags[0]) : null;
          const secondaryFromUsage = usageTags.length > 1
            ? usageTags.slice(1).map(usageTagToPurpose)
            : [];

          const headerImageUrl =
            (fd && fd.headerImageUrl) ||
            (String(tpl.headerType || '').toUpperCase() === 'IMAGE' ? tpl.headerValue || tpl.productImageUrl || null : null);

          const syncedStatus = syncedStatusByName.get(tpl.name);
          const finalStatus =
            syncedStatus === 'APPROVED' ? 'APPROVED' : status;

          const prior = mergedMap.get(tpl.name) || {};
          mergedMap.set(tpl.name, {
            ...prior,
            id: tpl.metaTemplateId || tpl._id?.toString?.() || prior.id || tpl.name,
            name: tpl.name,
            internalName: tpl.internalName || prior.internalName || null,
            status: finalStatus,
            category: tpl.category,
            language: tpl.language || 'en',
            components,
            source: tpl.source || 'canonical_meta_template',
            templateKind: tpl.templateKind || 'custom',
            readinessRequired: !!tpl.readinessRequired,
            submissionStatus: tpl.submissionStatus,
            primaryPurpose: primaryFromUsage || tpl.primaryPurpose || 'utility',
            secondaryPurposes: usageTags.length ? secondaryFromUsage : (Array.isArray(tpl.secondaryPurposes) ? tpl.secondaryPurposes : []),
            metaApiError: tpl.metaApiError,
            formData: fd || undefined,
            usageTags: usageTags.length ? usageTags : (Array.isArray(prior.usageTags) ? prior.usageTags : []),
            headerImageUrl: headerImageUrl || prior.headerImageUrl,
            _canonicalId: tpl._id || prior._canonicalId,
            variableMapping:
              tpl.variableMapping instanceof Map
                ? Object.fromEntries(tpl.variableMapping)
                : tpl.variableMapping || {},
            bodySamples: tpl.bodySamples || fd?.bodySamples,
          });
        });

        } /* end if (!skipCanonical) */

        const canonicalByName = new Map(canonical.filter((t) => t?.name).map((t) => [t.name, t]));
        synced.forEach((tpl) => {
          if (!tpl?.name || mergedMap.has(tpl.name)) return;
          const meta = canonicalByName.get(tpl.name);
          const headerComp = Array.isArray(tpl.components)
            ? tpl.components.find((c) => String(c.type || '').toUpperCase() === 'HEADER')
            : null;
          const headerImageUrl =
            headerComp && String(headerComp.format || '').toUpperCase() === 'IMAGE'
              ? headerComp.example?.header_handle?.[0] || headerComp.example?.header_url?.[0] || null
              : null;
          mergedMap.set(tpl.name, {
            id: tpl.id || tpl.name,
            name: tpl.name,
            internalName: meta?.internalName || null,
            usageTags: Array.isArray(meta?.usageTags) ? meta.usageTags : [],
            status: String(tpl.status || 'APPROVED').toUpperCase(),
            category: tpl.category,
            language: tpl.language || 'en',
            components: tpl.components || [],
            source: 'synced_meta',
            _canonicalId: meta?._id,
            headerImageUrl,
          });
        });

        let merged = Array.from(mergedMap.values()).map((tpl) => ({
          ...tpl,
          id: tpl.id || tpl.name || tpl._id?.toString?.(),
          primaryPurpose: normalizePurpose(tpl.primaryPurpose || 'utility'),
          secondaryPurposes: Array.isArray(tpl.secondaryPurposes)
            ? tpl.secondaryPurposes.map((p) => normalizePurpose(p))
            : [],
        }));
        if (contextPurpose) {
          merged = merged.filter((tpl) => {
            const primary = normalizePurpose(tpl.primaryPurpose || 'utility');
            const secondary = Array.isArray(tpl.secondaryPurposes)
              ? tpl.secondaryPurposes.map((p) => normalizePurpose(p))
              : [];
            return primary === contextPurpose || secondary.includes(contextPurpose) || primary === 'utility';
          });
        }
        const isUnified = req.query.unified === '1' || req.query.unified === 'true';
        let responseData = merged;
        let meta = null;

        if (isUnified) {
          const {
            buildUnifiedLibraryResponse,
            buildUnifiedContextResponse,
          } = require('../utils/meta/unifiedTemplateList');
          const ctx = req.query.contextPurpose
            ? normalizePurpose(req.query.contextPurpose, 'utility')
            : null;
          if (ctx && ctx !== 'manager') {
            const u = buildUnifiedContextResponse(merged, ctx);
            responseData = u.data;
            meta = u.meta;
          } else {
            const u = buildUnifiedLibraryResponse(merged);
            responseData = u.data;
            meta = u.meta;
          }
        } else if (contextPurpose === 'manager') {
          const { filterTemplatesForManagerList } = require('../utils/meta/templateListPolicy');
          responseData = filterTemplatesForManagerList(merged);
        }

        const payload = {
          success: true,
          data: responseData,
          syncedAt: client.templatesSyncedAt,
          ...(meta ? { meta } : {}),
        };
        const memTtlMs = skipCanonical ? 120_000 : TEMPLATE_LIST_MEM_TTL_MS;
        writeTemplateListMemCache(memKey, payload, memTtlMs);
        timer.finish(`200 ok | count=${responseData.length}`);
        res.json(payload);
    } catch (error) {
        timer.finish(`500 ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
}

router.get('/list', protect, apiCache(60), handleGetTemplateList);

/** Unified template library — merged sources + eligibility meta (Module 12). */
router.get('/unified', protect, apiCache(60), (req, res) => {
  req.query.unified = '1';
  if (!req.query.contextPurpose) req.query.contextPurpose = 'manager';
  return handleGetTemplateList(req, res);
});

/** Per-feature readiness (order messages, flows, commerce) — Phase 2 unified API. */
/** WhatsApp optional — return empty readiness instead of 500 when WA not configured. */
async function safeTemplateContext(req, clientId) {
  try {
    await getClientCredentials(clientId, req.user.id);
    const { getCachedClient } = require('../utils/core/clientCache');
    const client = await getCachedClient(clientId, 'syncedMetaTemplates');
    const synced = Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
    return { synced, whatsappConfigured: true };
  } catch (error) {
    const msg = String(error?.message || '');
    const waMissing =
      msg.includes('WABA') ||
      msg.includes('WhatsApp') ||
      msg.includes('not configured');
    if (waMissing) {
      return { synced: [], whatsappConfigured: false };
    }
    throw error;
  }
}

router.get('/readiness', protect, apiCache(20), async (req, res) => {
    try {
        const clientId = tenantClientId(req) || req.query.clientId;
        if (!clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const { synced, whatsappConfigured } = await safeTemplateContext(req, clientId);
        if (!whatsappConfigured) {
            return res.json({
                success: true,
                data: {
                    whatsappConfigured: false,
                    slots: {},
                    summary: { approved: 0, pending: 0, missing: 0 },
                },
            });
        }
        const data = await getUnifiedTemplateReadiness(clientId, { syncedTemplates: synced });
        return res.json({ success: true, data: { ...data, whatsappConfigured: true } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/** Automation slots merged with per-tenant sync + MetaTemplate resolution (Phase 1 catalog). */
router.get('/slots', protect, apiCache(30), async (req, res) => {
    try {
        const clientId = tenantClientId(req) || req.query.clientId;
        if (!clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const { synced, whatsappConfigured } = await safeTemplateContext(req, clientId);
        if (!whatsappConfigured) {
            const catalog = loadCatalog();
            return res.json({
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
            });
        }

        const resolved = await resolveSlotsForClient(clientId, { syncedTemplates: synced });
        const catalog = loadCatalog();
        const ecoValidation = validateEcoStandardPack(STANDARD_TEMPLATES);

        res.json({
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
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1c. Update template purpose tags for campaign/sequence/flow routing
router.put('/purpose', protect, async (req, res) => {
    try {
        const tenantId = tenantClientId(req);
        const {
            clientId: bodyClientId,
            templateName,
            primaryPurpose = 'utility',
            secondaryPurposes = [],
        } = req.body || {};
        const clientId = bodyClientId || tenantId;

        if (!tenantId || tenantId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        if (!templateName) {
            return res.status(400).json({ success: false, message: 'templateName is required' });
        }

        const normalizedPrimary = normalizePurpose(primaryPurpose, 'utility');
        const normalizedSecondary = Array.from(new Set(
            (Array.isArray(secondaryPurposes) ? secondaryPurposes : [])
                .map((p) => normalizePurpose(p))
                .filter((p) => p !== normalizedPrimary)
        ));

        // Persist on local client template collections (used by list/sync views).
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const mutateByName = (list = []) => {
            if (!Array.isArray(list)) return list;
            return list.map((tpl) => {
                if (!tpl || tpl.name !== templateName) return tpl;
                return {
                    ...tpl,
                    primaryPurpose: normalizedPrimary,
                    secondaryPurposes: normalizedSecondary,
                };
            });
        };

        client.messageTemplates = mutateByName(client.messageTemplates);
        client.syncedMetaTemplates = mutateByName(client.syncedMetaTemplates);
        await client.save();

        // Persist in canonical templates too for durable routing.
        await MetaTemplate.updateMany(
            { clientId, name: templateName },
            {
                $set: {
                    primaryPurpose: normalizedPrimary,
                    secondaryPurposes: normalizedSecondary,
                    updatedAt: new Date(),
                }
            }
        );

        return res.json({
            success: true,
            data: {
                templateName,
                primaryPurpose: normalizedPrimary,
                secondaryPurposes: normalizedSecondary,
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Update AI-generated product template locally before Meta publish.
router.put('/product-template/:clientId/:templateName', protect, async (req, res) => {
    try {
        const { clientId, templateName } = req.params;
        const { body, footer, imageUrl, variables = {} } = req.body || {};
        if (!templateName) return res.status(400).json({ success: false, message: 'templateName required' });

        const user = await User.findById(req.user.id);
        if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const templates = Array.isArray(client.messageTemplates) ? [...client.messageTemplates] : [];
        const idx = templates.findIndex(t => t?.name === templateName);
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Template not found in local workspace' });
        }

        const tpl = { ...templates[idx] };
        if (String(tpl.name || '').startsWith('prod_') === false && tpl.source !== 'wizard_product') {
          return res.status(400).json({ success: false, message: 'Only AI-generated product templates can be edited here' });
        }

        const components = Array.isArray(tpl.components) ? [...tpl.components] : [];
        const bodyIndex = components.findIndex(c => c.type === 'BODY');
        const footerIndex = components.findIndex(c => c.type === 'FOOTER');
        const headerIndex = components.findIndex(c => c.type === 'HEADER' && c.format === 'IMAGE');

        if (body !== undefined) {
          if (bodyIndex >= 0) components[bodyIndex] = { ...components[bodyIndex], text: body };
          else components.push({ type: 'BODY', text: body });
          tpl.body = body;
        }
        if (footer !== undefined) {
          if (footerIndex >= 0) components[footerIndex] = { ...components[footerIndex], text: footer };
          else components.push({ type: 'FOOTER', text: footer });
        }
        if (imageUrl !== undefined) {
          if (headerIndex >= 0) components[headerIndex] = { ...components[headerIndex], _imageUrl: imageUrl };
          else components.unshift({ type: 'HEADER', format: 'IMAGE', _imageUrl: imageUrl });
          tpl.imageUrl = imageUrl;
        }

        const vars = Array.isArray(tpl.variables) ? [...tpl.variables] : ['product_name', 'product_price', 'product_features'];
        if (variables.productName !== undefined) vars[0] = variables.productName;
        if (variables.productPrice !== undefined) vars[1] = variables.productPrice;
        if (variables.productFeatures !== undefined) vars[2] = variables.productFeatures;
        tpl.variables = vars;
        tpl.components = components;
        tpl.updatedAt = new Date();
        tpl.status = String(tpl.status || 'DRAFT').toUpperCase() === 'APPROVED' ? 'APPROVED' : 'DRAFT';

        templates[idx] = tpl;
        await Client.updateOne({ clientId }, { $set: { messageTemplates: templates } });

        res.json({ success: true, template: tpl });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Get Template Statistics (Read Rate and Revenue)
router.get('/:clientId/stats', protect, apiCache(60), async (req, res) => {
    const { createTimer } = require('../utils/core/perfLogger');
    const { getCachedClient } = require('../utils/core/clientCache');
    const timer = createTimer('GET /api/templates/:clientId/stats', req.params.clientId || '');
    try {
        const { clientId } = req.params;
        const Message = require('../models/Message');
        const Order = require('../models/Order');

        await getClientCredentials(clientId, req.user.id);

        const since = new Date();
        since.setDate(since.getDate() - 90);

        const [statusBreakdown, stats, client] = await Promise.all([
          Message.aggregate([
            {
              $match: {
                clientId,
                direction: 'outgoing',
                type: 'template',
                createdAt: { $gte: since },
              },
            },
            { $group: { _id: '$status', n: { $sum: 1 } } },
          ]).option({ maxTimeMS: 8000 }),
          Order.aggregate([
            { $match: { clientId, createdAt: { $gte: since } } },
            { $group: { _id: null, totalRevenue: { $sum: '$totalPrice' } } },
          ]).option({ maxTimeMS: 8000 }),
          getCachedClient(clientId, 'syncedMetaTemplates clientId'),
        ]);

        let totalSent = 0;
        let totalRead = 0;
        let totalDelivered = 0;
        for (const row of statusBreakdown) {
          const n = row.n || 0;
          totalSent += n;
          if (row._id === 'read') totalRead = n;
          if (row._id === 'delivered') totalDelivered = n;
        }

        const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0;
        const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0;

        const revenue = stats.length > 0 ? stats[0].totalRevenue : 0;
        
        timer.finish('ok');
        res.json({
            success: true,
            globalReadRate: readRate || 32, // Weighted fallback
            globalRevenue: revenue || 0,
            deliveryRate: deliveryRate || 98,
            totalSent,
            activeTemplates: (client?.syncedMetaTemplates || []).length,
            attribution: {
                direct: Math.round(revenue * 0.45), // 45% estimated from templates
                organic: Math.round(revenue * 0.55),
                roi: totalSent > 0 ? ((revenue / (totalSent * 0.8)) * 100).toFixed(1) : "0.0"
            }
        });

    } catch (error) {
        timer.finish(`error: ${error.message}`);
        console.error('[Template Stats API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Create a Template on Meta
router.post('/create', protect, async (req, res) => {
    try {
        const { clientId, name, category, language, components } = req.body;
        if (!clientId || !name || !category || !language || !components) {
            return res.status(400).json({ success: false, message: 'Missing required template fields' });
        }

        const client = await getClientCredentials(clientId, req.user.id);

        // --- Meta API Rate Limiting (approx 6 per hour for new WABAs) ---
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let recentSubmissions = client.templateSubmissionTimestamps || [];
        recentSubmissions = recentSubmissions.filter(ts => new Date(ts) > oneHourAgo);
        
        if (recentSubmissions.length >= 6) {
            return res.status(429).json({
                success: false,
                message: 'Meta API Rate Limit reached: You can only submit 6 templates per hour. Please wait before submitting more.',
                code: 'RATE_LIMIT_EXCEEDED'
            });
        }

        // Required API parameters for Meta Template creation
        const payload = {
            name,
            language,
            category,
            components
        };

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;

        try {
            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json'
                }
            });

            // Track submission
            recentSubmissions.push(new Date());
            await Client.updateOne(
                { clientId },
                { $set: { templateSubmissionTimestamps: recentSubmissions } }
            );

            res.json({ success: true, data: response.data });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] Meta Create Error:', metaErr.response?.data || metaErr.message);
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to create template on Meta', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }

    } catch (error) {
        console.error('[Template API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2b. Submit a locally stored template (messageTemplates / pending) to Meta for review
router.post('/push-local', protect, async (req, res) => {
    try {
        const { clientId, templateName } = req.body || {};
        if (!clientId || !templateName) {
            return res.status(400).json({ success: false, message: 'clientId and templateName are required' });
        }

        const tenantId = tenantClientId(req);
        if (!tenantId || tenantId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await getClientCredentials(clientId, req.user.id);
        const templates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
        let local = templates.find((t) => t && t.name === templateName);
        let source = 'message_templates';

        if (!local) {
            const metaDoc = await MetaTemplate.findOne({ clientId, name: templateName })
                .sort({ updatedAt: -1 })
                .lean();
            if (metaDoc) {
                local = {
                    name: metaDoc.name,
                    category: metaDoc.category,
                    language: metaDoc.language,
                    components: [],
                    body: metaDoc.body,
                    headerType: metaDoc.headerType,
                    headerValue: metaDoc.headerValue,
                    footerText: metaDoc.footerText,
                    buttons: metaDoc.buttons,
                    variableMapping: metaDoc.variableMapping,
                    primaryPurpose: metaDoc.primaryPurpose,
                    secondaryPurposes: metaDoc.secondaryPurposes,
                    source: metaDoc.source || 'meta_template',
                };
                source = 'meta_template';
            }
        }

        if (!local) {
            return res.status(404).json({ success: false, message: 'Template not found in workspace. Sync from Meta or generate from the wizard first.' });
        }

        const { buildComponentsForMetaSubmit } = require('../utils/meta/templateSubmitComponents');
        let rawComponents = buildComponentsForMetaSubmit(local);
        if (!rawComponents.length && Array.isArray(local.components)) {
            rawComponents = local.components;
        }
        if (rawComponents.length === 0) {
            const wd = {
                businessName: client.businessName || client.name || 'Your brand',
                businessLogo: client.businessLogo || client.logoUrl || '',
            };
            const canned =
                getPrebuiltTemplates(wd).find((t) => t.name === templateName) ||
                getPrebuiltTemplates({}).find((t) => t.name === templateName);
            if (canned?.components?.length) {
                local = { ...local, ...canned, components: canned.components };
                rawComponents = local.components;
            }
        }
        if (rawComponents.length === 0) {
            return res.status(400).json({ success: false, message: 'Template has no components to submit. Re-run the onboarding wizard or create the template in Meta Manager.' });
        }

        const components = rawComponents.map((c) => {
            const comp = { ...c };
            delete comp._imageUrl;
            if (comp.type === 'HEADER' && comp.format === 'IMAGE') {
                const url =
                    local.imageUrl ||
                    rawComponents.find((x) => x.type === 'HEADER' && x._imageUrl)?._imageUrl ||
                    'https://via.placeholder.com/800x400.png?text=Header';
                comp.example = comp.example?.header_handle?.length
                    ? comp.example
                    : { header_handle: [url] };
            }
            return comp;
        });

        const category = (local.category || 'MARKETING').toUpperCase();
        const language = local.language || 'en';
        const name = String(local.name).toLowerCase().replace(/[^a-z0-9_]/g, '_');

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        let recentSubmissions = client.templateSubmissionTimestamps || [];
        recentSubmissions = recentSubmissions.filter((ts) => new Date(ts) > oneHourAgo);
        if (recentSubmissions.length >= 6) {
            return res.status(429).json({
                success: false,
                message: 'Meta allows roughly 6 new template submissions per hour. Try again shortly.',
                code: 'RATE_LIMIT_EXCEEDED',
            });
        }

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;
        const payload = { name, language, category, components };

        try {
            const response = await axios.post(url, payload, {
                headers: {
                    Authorization: `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json',
                },
            });

            recentSubmissions.push(new Date());
            await Client.updateOne(
                { clientId },
                {
                    $set: { templateSubmissionTimestamps: recentSubmissions },
                    $pull: { messageTemplates: { name: templateName }, pendingTemplates: { name: templateName } },
                }
            );

            const newTemplate = {
                id: response.data.id || `pending_${name}`,
                name,
                status: 'PENDING',
                category,
                components: rawComponents,
                source: local.source || source || 'push_local',
                primaryPurpose: normalizePurpose(local.primaryPurpose || 'utility'),
                secondaryPurposes: Array.isArray(local.secondaryPurposes)
                  ? local.secondaryPurposes.map((p) => normalizePurpose(p))
                  : [],
                createdAt: new Date(),
            };

            await Client.updateOne(
                { clientId },
                {
                    $push: {
                        messageTemplates: newTemplate,
                        pendingTemplates: {
                            name,
                            status: 'PENDING',
                            metaId: response.data.id || '',
                            submittedAt: new Date(),
                        },
                    },
                }
            );

            return res.json({ success: true, data: response.data, message: 'Template submitted to Meta for approval' });
        } catch (metaErr) {
            const msg = metaErr.response?.data?.error?.message || metaErr.message;
            if (/already exists|duplicate/i.test(String(msg))) {
                return res.json({
                    success: true,
                    duplicate: true,
                    message: 'This template name already exists on Meta. Sync templates to refresh status.',
                });
            }
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] push-local Meta Error:', metaErr.response?.data || metaErr.message);
            return res.status(isClientError ? 400 : 500).json({
                success: false,
                message: msg || 'Failed to submit template to Meta',
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403,
            });
        }
    } catch (error) {
        console.error('[Template API] push-local:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Delete a Template from Meta
router.delete('/:clientId/:templateName', protect, async (req, res) => {
    try {
        const { clientId, templateName } = req.params;
        const tenantId = tenantClientId(req);
        if (!tenantId || tenantId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await getClientCredentials(clientId, req.user.id);
        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates?name=${encodeURIComponent(templateName)}`;

        try {
            const response = await axios.delete(url, {
                headers: { Authorization: `Bearer ${client.whatsappToken}` }
            });
            res.json({ success: true, message: 'Template deleted successfully' });
        } catch (metaErr) {
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to delete template', 
                details: metaErr.response?.data,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. AI Copy Generation (Gemini)
router.post('/:clientId/ai-generate', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { prompt, tone, audience } = req.body;
        
        const client = await Client.findOne({ clientId });
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const apiKey = client.geminiApiKey?.trim() || client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const finalPrompt = `
        Act as a master WhatsApp marketer.
        Write 3 short diverse WhatsApp template body copies.
        They must be 1-2 paragraphs max. Tone: ${tone}. Target: ${audience}.
        Context: ${prompt}
        Output ONLY a JSON array of 3 strings. Provide NO other text, markdown blocks are okay if standard JSON.
        `;
        const result = await model.generateContent(finalPrompt);
        let outputText = result.response.text().trim();
        if (outputText.startsWith('\`\`\`json')) outputText = outputText.slice(7, -3).trim();
        
        res.json({ success: true, copies: JSON.parse(outputText) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4b. Template Scorer & Fix Suggestion
router.post('/:clientId/score', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const { templateContent, category, action } = req.body;
        // action can be 'score' (fast, regex based) or 'suggest' (deep Gemini analysis)

        if (!templateContent || !category) {
            return res.status(400).json({ success: false, message: 'Missing templateContent or category' });
        }

        if (action === 'score') {
            const scoreData = getFastScore(templateContent, category);
            return res.json({ success: true, ...scoreData });
        } else if (action === 'suggest') {
            const client = await Client.findOne({ clientId });
            if (!client) throw new Error('Client not found');

            const apiKey = client.geminiKey?.trim() || client.openaiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
            if (!apiKey) throw new Error('AI API Key not configured');

            const geminiAnalysis = await analyzeWithGeminiAndRewrite(templateContent, category, apiKey);
            if (!geminiAnalysis) {
                return res.status(500).json({ success: false, message: 'Failed to generate suggestions' });
            }

            return res.json({ success: true, data: geminiAnalysis });
        } else {
            return res.status(400).json({ success: false, message: 'Invalid action type' });
        }
    } catch (error) {
        console.error('[Template Scorer API] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. Template History
router.get('/:clientId/:templateId/history', protect, async (req, res) => {
    // Dummy return, ideally we store historical documents in a separate collection.
    res.json({ success: true, history: [] });
});

// 6. Fetch Standard Templates Library
router.get('/standard', protect, async (req, res) => {
    res.json({ success: true, data: STANDARD_TEMPLATES });
});

/** Phase 4 — per-client brand overrides for catalog slots. */
router.get('/overrides', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req) || req.query.clientId;
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
        await getClientCredentials(clientId, req.user.id);
        const data = await listOverridesForClient(clientId);
        if (!data) return res.status(404).json({ success: false, message: 'Client not found' });
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/overrides/:slotId', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req) || req.body?.clientId;
        if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
        await getClientCredentials(clientId, req.user.id);
        const result = await patchOverrideForSlot(clientId, req.params.slotId, req.body || {});
        return res.json({ success: true, data: result });
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/** SUPER_ADMIN — approval board across clients. */
router.get('/admin/board', protect, async (req, res) => {
    try {
        await assertSuperAdmin(req.user.id);
        const needsActionOnly = req.query.needsAction === 'true';
        const limit = Math.min(parseInt(req.query.limit, 10) || 80, 200);
        const data = await getApprovalBoard({ limit, needsActionOnly });
        return res.json({ success: true, data });
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/** SUPER_ADMIN — bulk push eco pack. */
router.post('/admin/bulk-push-eco', protect, async (req, res) => {
    try {
        await assertSuperAdmin(req.user.id);
        const { clientIds = [], skipExisting = true } = req.body || {};
        const data = await bulkPushEcoPack({ clientIds, skipExisting });
        return res.json({ success: true, data });
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/** SUPER_ADMIN — latest catalog drift audits. */
router.get('/admin/audits', protect, async (req, res) => {
    try {
        await assertSuperAdmin(req.user.id);
        const needsActionOnly = req.query.needsAction === 'true';
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const audits = await getLatestAudits({ limit, needsActionOnly });
        return res.json({ success: true, data: { audits, multiStoreModel: MULTI_STORE_MODEL } });
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/** SUPER_ADMIN — run validation now (same as nightly cron). */
router.post('/admin/validate-catalog', protect, async (req, res) => {
    try {
        await assertSuperAdmin(req.user.id);
        const limit = Math.min(parseInt(req.body?.limit, 10) || 200, 500);
        const data = await runCatalogValidationJob({ limit });
        return res.json({ success: true, data });
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
});

// 7. Push Standard Template to Meta
router.post('/push-standard', protect, async (req, res) => {
    try {
        const { clientId, templateId, headerHandle } = req.body;
        if (!clientId || !templateId) {
            return res.status(400).json({ success: false, message: 'clientId and templateId are required' });
        }

        const baseTemplate = STANDARD_TEMPLATES.find(t => t.id === templateId);
        if (!baseTemplate) {
            return res.status(404).json({ success: false, message: 'Standard template not found' });
        }

        const client = await getClientCredentials(clientId, req.user.id);
        const clientDoc = await Client.findOne({ clientId }).select('templateBrandOverrides').lean();

        const { template: standardTemplate, applied: overridesApplied, skipped } =
            applyOverridesToStandardTemplate(
                JSON.parse(JSON.stringify(baseTemplate)),
                templateId,
                clientDoc
            );

        if (skipped) {
            return res.status(400).json({
                success: false,
                message: 'This automation slot is disabled via brand overrides.',
            });
        }

        // Request header handle wins over stored override
        if (headerHandle) {
            const headerComp = standardTemplate.components.find(c => c.type === 'HEADER' && c.format === 'IMAGE');
            if (headerComp) {
                headerComp.example = { header_handle: [headerHandle] };
            }
        }

        const payload = {
            name: standardTemplate.name,
            language: standardTemplate.language,
            category: standardTemplate.category,
            components: standardTemplate.components
        };

        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;

        try {
            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${client.whatsappToken}`,
                    'Content-Type': 'application/json'
                }
            });
            const metaResult = response.data || {};
            try {
              await recordTemplateSubmission({
                clientId,
                metaName: standardTemplate.name,
                metaTemplateId: metaResult.id || null,
                metaStatus: metaResult.status || 'PENDING',
                components: standardTemplate.components,
                category: standardTemplate.category,
                language: standardTemplate.language,
                source: 'eco_push',
                catalogSlotId: standardTemplate.id,
                body: standardTemplate.components?.find((c) => c.type === 'BODY')?.text,
              });
            } catch (lifeErr) {
              console.warn('[Template API] push-standard lifecycle:', lifeErr.message);
            }
            res.json({ success: true, data: metaResult, overridesApplied: !!overridesApplied });
        } catch (metaErr) {
            const errData = metaErr.response?.data || metaErr.message;
            const status = metaErr.response?.status;
            const isClientError = status >= 400 && status < 500;
            console.error('[Template API] Meta Push Error:', JSON.stringify(errData, null, 2));
            res.status(isClientError ? 400 : 500).json({ 
                success: false, 
                message: 'Failed to push template to Meta', 
                details: errData,
                isIntegrationAuthError: status === 401 || status === 403
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Submit a single workspace template (MetaTemplate / messageTemplates) to Meta for review
router.post('/submit-workspace', protect, async (req, res) => {
    try {
        const { clientId, templateName } = req.body || {};
        if (!clientId || !templateName) {
            return res.status(400).json({ success: false, message: 'clientId and templateName are required' });
        }
        const tenantId = tenantClientId(req);
        if (!tenantId || tenantId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const { submitWorkspaceTemplateToMeta } = require('../utils/meta/submitWorkspaceTemplateToMeta');
        const out = await submitWorkspaceTemplateToMeta({
            clientId,
            templateName: String(templateName).trim(),
            userId: req.user?.id || req.user?._id,
        });
        if (out.success) {
            return res.json({ success: true, message: out.message || 'Submitted to Meta for review.' });
        }
        return res.status(400).json({
            success: false,
            message: out.message || 'Submit failed',
            duplicate: !!out.duplicate,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. Upload Media to Meta (Resumable Upload API)
router.post('/upload-media', protect, upload.single('file'), async (req, res) => {
    try {
        const { clientId } = req.body;
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const client = await getClientCredentials(clientId, req.user.id);
        const accessToken = client.whatsappToken;

        // Meta requires App ID for uploads. 
        // We prioritize process.env.META_APP_ID, then fallback to client.metaAppId from DB.
        const appId = process.env.META_APP_ID || client.metaAppId; 
        
        if (!appId) {
            throw new Error('Meta App ID is not configured. Please set META_APP_ID in your environment or add it in Settings → WhatsApp to use media templates.');
        }
        
        // 1. Initialize Upload
        // Documentation: https://developers.facebook.com/docs/graph-api/resumable-upload-api/
        const initUrl = `https://graph.facebook.com/v21.0/${appId}/uploads`;
        const initRes = await axios.post(initUrl, null, {
            params: {
                file_name: req.file.originalname || `upload_${Date.now()}.jpg`,
                file_length: req.file.size,
                file_type: req.file.mimetype,
                access_token: accessToken
            }
        });

        const sessionId = initRes.data.id;
        if (!sessionId) {
            throw new Error('Failed to initialize upload session with Meta.');
        }

        // 2. Upload Data (Binary)
        const uploadUrl = `https://graph.facebook.com/v21.0/${sessionId}`;
        const uploadRes = await axios.post(uploadUrl, req.file.buffer, {
            headers: {
                'Authorization': `OAuth ${accessToken}`,
                'file_offset': '0',
                'Content-Type': req.file.mimetype
            }
        });

        if (!uploadRes.data.h) {
            throw new Error('Meta did not return a media handle (h).');
        }

        let mediaUrl = null;
        try {
            mediaUrl = await uploadToCloud(req.file.buffer, 'template_media', 'image');
        } catch (cloudErr) {
            log.warn(`[Template API] Cloudinary mirror failed (handle still returned): ${cloudErr.message}`);
        }

        res.json({ success: true, handle: uploadRes.data.h, mediaUrl });
    } catch (error) {
        const errData = error.response?.data || error.message;
        console.error('[Template API] Media Upload Error Details:', JSON.stringify(errData, null, 2));
        
        // Provide cleaner message for common Meta errors
        let userMsg = 'Failed to upload media to Meta';
        if (error.response?.data?.error?.message) {
            userMsg += `: ${error.response.data.error.message}`;
        }

        res.status(500).json({ 
            success: false, 
            message: userMsg, 
            details: errData 
        });
    }
});

module.exports = router;
