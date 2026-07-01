'use strict';

const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const loadClientConfig = require('../middleware/clientConfig');
const { apiCache } = require('../middleware/apiCache');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const { decrypt } = require('../utils/core/encryption');
const { buildMetaWorkspaceShell } = require('../utils/hub/metaWorkspaceBundle');

function maskSecret(val) {
  if (!val || val === '••••••••') return null;
  const s = String(val);
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function hasToken(client, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = client;
    for (const part of parts) {
      cur = cur?.[part];
    }
    if (cur && String(cur).trim() && cur !== '••••••••') return true;
  }
  return false;
}

/**
 * GET /api/meta/workspace/:clientId/shell
 * Meta Manager library bundle: templates/list + meta-templates page 1 + slots + readiness + health.
 * Gate: FEATURE_META_WORKSPACE_SHELL=true (frontend: VITE_FEATURE_META_WORKSPACE_SHELL)
 */
router.get('/:clientId/shell', protect, verifyClientAccess, loadClientConfig, apiCache(30), async (req, res) => {
  if (process.env.FEATURE_META_WORKSPACE_SHELL !== 'true') {
    return res.status(404).json({ success: false, error: 'Meta workspace shell not enabled' });
  }

  try {
    const { clientId } = req.params;
    const tab = String(req.query.tab || 'library').toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const sections = req.query.sections || 'templates,health';

    const SHELL_TIMEOUT_MS = 22000;
    const payload = await Promise.race([
      buildMetaWorkspaceShell(clientId, {
        user: req.user,
        clientConfig: req.clientConfig,
        tab,
        page,
        sections,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('shell_timeout'), { code: 'SHELL_TIMEOUT' })), SHELL_TIMEOUT_MS)
      ),
    ]);

    return res.json({ success: true, clientId, ...payload });
  } catch (err) {
    if (err.code === 'SHELL_TIMEOUT') {
      console.warn('[meta/workspace/shell] Timed out — returning empty shell');
      return res.json({
        success: true,
        clientId: req.params.clientId,
        whatsappLive: false,
        templates: {},
        health: null,
        meta: { partial: true, tab: req.query.tab || 'library', timedOut: true },
      });
    }
    console.error('[meta/workspace/shell]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/meta/workspace/:clientId
 * Business Manager–style snapshot: WABA, catalog, apps, tokens (masked).
 */
router.get('/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId })
      .select({
        clientId: 1,
        name: 1,
        businessName: 1,
        wabaId: 1,
        phoneNumberId: 1,
        whatsappToken: 1,
        whatsapp: 1,
        wabaAccounts: 1,
        metaAppId: 1,
        facebookCatalogId: 1,
        waCatalogId: 1,
        metaCatalogAccessToken: 1,
        metaAdsConnected: 1,
        metaAdAccountId: 1,
        metaAdsToken: 1,
        instagramConnected: 1,
        instagramUsername: 1,
        social: 1,
        shopDomain: 1,
        shopifyAccessToken: 1,
        commerce: 1,
        wizardCompleted: 1,
        verifyToken: 1,
      })
      .lean();

    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const flags = buildConnectionStatusPayload(client);

    let waTokenOk = false;
    try {
      const tok = decrypt(client.whatsappToken || '') || client.whatsappToken || '';
      waTokenOk = !!String(tok).trim();
    } catch (_) {
      waTokenOk = hasToken(client, ['whatsappToken', 'whatsapp.accessToken']);
    }

    const catalogId = String(client.facebookCatalogId || client.waCatalogId || '').trim();
    const catalogTokenOk = hasToken(client, ['metaCatalogAccessToken']);

    let templateStats = { total: 0, approved: 0 };
    try {
      const MetaTemplate = require('../models/MetaTemplate');
      const rows = await MetaTemplate.find({ clientId }).select('status').lean();
      templateStats.total = rows.length;
      templateStats.approved = rows.filter(
        (t) => String(t.status || '').toUpperCase() === 'APPROVED'
      ).length;
    } catch (_) {
      /* optional */
    }

    const wabaAccounts = Array.isArray(client.wabaAccounts) ? client.wabaAccounts : [];

    return res.json({
      success: true,
      clientId,
      businessName: client.businessName || client.name || '',
      wizardCompleted: !!client.wizardCompleted,
      connections: flags,
      whatsapp: {
        connected: flags.whatsapp_connected,
        wabaId: client.wabaId || client.whatsapp?.wabaId || '',
        phoneNumberId: client.phoneNumberId || client.whatsapp?.phoneNumberId || '',
        hasAccessToken: waTokenOk,
        verifyTokenSet: !!String(client.verifyToken || '').trim(),
        wabaAccountCount: wabaAccounts.length,
        wabaAccounts: wabaAccounts.slice(0, 5).map((a) => ({
          id: a.id || a.wabaId || '',
          name: a.name || a.businessName || '',
        })),
      },
      catalog: {
        catalogId,
        waCatalogId: client.waCatalogId || catalogId,
        hasCatalogAccessToken: catalogTokenOk,
        catalogTokenPreview: maskSecret(client.metaCatalogAccessToken),
      },
      metaApp: {
        metaAppId: client.metaAppId || '',
        configured: !!String(client.metaAppId || '').trim(),
      },
      systemUser: {
        label: 'Catalog system user token',
        configured: catalogTokenOk,
        tokenPreview: maskSecret(client.metaCatalogAccessToken),
        hint: 'Commerce Manager → System users → Generate token with catalog_management',
      },
      metaAds: {
        connected: !!client.metaAdsConnected || flags.meta_connected,
        adAccountId: client.metaAdAccountId || '',
        hasToken: hasToken(client, ['metaAdsToken']),
      },
      instagram: {
        connected: flags.instagram_connected || !!client.instagramConnected,
        username: client.instagramUsername || client.social?.instagram?.username || '',
      },
      shopify: {
        connected: flags.shopify_connected,
        domain: client.shopDomain || client.commerce?.shopify?.domain || '',
      },
      templates: templateStats,
      quickLinks: {
        settingsIntegrations: '/settings?tab=integrations',
        settingsCommerce: '/settings?tab=commerce',
        metaTemplates: '/meta-manager?tab=library',
        metaCatalog: '/meta-manager?tab=catalog',
        metaFlows: '/meta-manager?tab=flows',
      },
    });
  } catch (err) {
    console.error('[meta/workspace]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
