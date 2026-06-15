'use strict';

const express = require('express');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { buildAbandonedCartWorkspace, buildAbandonHeatmap } = require('../utils/commerce/abandonedCartWorkspace');
const {
  buildAbandonedCartReadiness,
  enableAbandonedCartRecovery,
  saveThirdPartyWebhookSecret,
  sendTestRecoveryMessage,
  generateWebhookSecret,
} = require('../utils/commerce/abandonedCartReadiness');
const {
  buildConfigPayload,
  saveCartRecoveryConfig,
} = require('../utils/commerce/cartRecoveryConfigService');
const { logAction } = require('../middleware/audit');
const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

const router = express.Router();

/**
 * GET /api/abandoned-carts/workspace
 * Metrics + table rows for Audience → Abandoned carts (date range / preset).
 */
router.get('/workspace', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const data = await buildAbandonedCartWorkspace(clientId, req.query);
    res.json(data);
  } catch (err) {
    console.error('[AbandonedCarts] workspace error:', err);
    res.status(500).json({ success: false, message: 'Failed to load abandoned cart workspace' });
  }
});

/**
 * GET /api/abandoned-carts/workspace/heatmap
 * 24×7 IST abandon heatmap (NEW-3).
 */
router.get('/workspace/heatmap', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const data = await buildAbandonHeatmap(clientId, req.query);
    res.json(data);
  } catch (err) {
    console.error('[AbandonedCarts] heatmap error:', err);
    res.status(500).json({ success: false, message: 'Failed to load abandon heatmap' });
  }
});

/**
 * GET /api/abandoned-carts/template-performance/:clientId
 * Cart recovery template sends / read / recovery rates (F5.2).
 */
router.get('/template-performance/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { parseDateRange } = require('../utils/commerce/abandonedCartWorkspace');
    const { getCartRecoveryTemplatePerformance } = require('../utils/commerce/cartRecoveryAttemptService');
    const { from, to, preset } = parseDateRange(req.query);
    const templates = await getCartRecoveryTemplatePerformance(clientId, from, to);
    res.json({ success: true, range: { from, to, preset }, templates });
  } catch (err) {
    console.error('[AbandonedCarts] template-performance error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load template performance' });
  }
});

/**
 * GET /api/abandoned-carts/readiness/:clientId
 * Go-live checklist for abandoned cart recovery.
 */
router.get('/readiness/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const readiness = await buildAbandonedCartReadiness(clientId);
    if (!readiness) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    res.json({ success: true, readiness });
  } catch (err) {
    console.error('[AbandonedCarts] readiness error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load readiness' });
  }
});

/**
 * GET /api/abandoned-carts/workspace/export
 * CSV export for abandoned cart workspace rows.
 */
router.get('/workspace/export', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req) || req.query.clientId;
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const data = await buildAbandonedCartWorkspace(clientId, req.query);
    const rows = data.rows || [];
    const header = [
      'customer_name',
      'phone',
      'cart_value',
      'cart_status',
      'abandoned_at',
      'recovery_step',
      'cart_value_tier',
      'recovery_url',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const cells = [
        row.customer?.name || '',
        row.customer?.phone || '',
        row.cartValue ?? '',
        row.recoveryStatus?.label || row.currentStatus?.label || '',
        row.abandonedAt || '',
        row.recoveryStep ?? '',
        row.cartValueTier || '',
        row.recoveryUrl || '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abandoned-carts-${clientId}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[AbandonedCarts] export error:', err);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

/**
 * POST /api/abandoned-carts/bulk/:clientId
 * Bulk suppress / unsuppress recovery sends.
 */
router.post('/bulk/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, leadIds = [] } = req.body || {};
    const ids = (leadIds || []).filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'leadIds required' });
    }
    const AdLead = require('../models/AdLead');
    if (action === 'suppress') {
      await AdLead.updateMany(
        { clientId, _id: { $in: ids } },
        { $set: { suppressRecovery: true } }
      );
    } else if (action === 'unsuppress') {
      await AdLead.updateMany(
        { clientId, _id: { $in: ids } },
        { $set: { suppressRecovery: false } }
      );
    } else if (action === 'send_now') {
      if (ids.length > 10) {
        return res.status(400).json({ success: false, message: 'Max 10 leads per send_now batch' });
      }
      const { sendCartRecoveryNow } = require('../utils/commerce/cartRecoveryManualSend');
      const results = [];
      for (const leadId of ids) {
        try {
          const out = await sendCartRecoveryNow({ clientId, leadId });
          results.push({ leadId, ok: true, ...out });
        } catch (e) {
          results.push({ leadId, ok: false, code: e.code || 'failed', message: e.message });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      return res.json({ success: true, action, sent, failed: results.length - sent, results });
    } else {
      return res.status(400).json({ success: false, message: 'Unknown action' });
    }
    res.json({ success: true, updated: ids.length, action });
  } catch (err) {
    console.error('[AbandonedCarts] bulk error:', err);
    res.status(400).json({ success: false, message: err.message || 'Bulk action failed' });
  }
});

/**
 * GET /api/abandoned-carts/config/:clientId
 * Merchant cart recovery timing + smart send settings.
 */
router.get('/config/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const Client = require('../models/Client');
    const client = await Client.findOne({ clientId })
      .select('cartRecoveryConfig wizardFeatures commerceAutomations')
      .lean();
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    res.json({ success: true, config: buildConfigPayload(client) });
  } catch (err) {
    console.error('[AbandonedCarts] config get error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load config' });
  }
});

/**
 * PATCH /api/abandoned-carts/config/:clientId
 * Update promotion + step delays and smart send window.
 */
router.patch('/config/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const config = await saveCartRecoveryConfig(clientId, req.body || {});
    res.json({ success: true, config });
  } catch (err) {
    console.error('[AbandonedCarts] config patch error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to save config' });
  }
});

/**
 * POST /api/abandoned-carts/enable/:clientId
 * Turn on wizardFeatures + activate cart rules when templates are approved.
 */
router.post('/enable/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await enableAbandonedCartRecovery(clientId);
    res.json(result);
  } catch (err) {
    console.error('[AbandonedCarts] enable error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to enable recovery' });
  }
});

/**
 * POST /api/abandoned-carts/test-recovery/:clientId
 * Send cart_recovery_1 (or body.templateName) to merchant test phone.
 */
router.post('/test-recovery/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { phone, templateName } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const result = await sendTestRecoveryMessage(
      clientId,
      phone,
      templateName || 'cart_recovery_1'
    );
    res.json(result);
  } catch (err) {
    console.error('[AbandonedCarts] test-recovery error:', err);
    res.status(400).json({ success: false, message: err.message || 'Test send failed' });
  }
});

/**
 * PUT /api/abandoned-carts/third-party/:clientId/:provider
 * Save webhook secret for GoKwik / Razorpay / Shiprocket.
 */
router.put('/third-party/:clientId/:provider', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId, provider } = req.params;
    let { webhookSecret } = req.body || {};
    const providerMap = {
      gokwik: 'gokwik',
      razorpay: 'razorpay_magic',
      'razorpay-magic': 'razorpay_magic',
      razorpay_magic: 'razorpay_magic',
      cashfree: 'cashfree_checkout',
      'cashfree-checkout': 'cashfree_checkout',
      cashfree_checkout: 'cashfree_checkout',
      shiprocket: 'shiprocket_checkout',
      'shiprocket-checkout': 'shiprocket_checkout',
      shiprocket_checkout: 'shiprocket_checkout',
    };
    const integrationKey = providerMap[provider];
    if (!webhookSecret && integrationKey) {
      const Client = require('../models/Client');
      const client = await Client.findOne({ clientId }).select('audienceContext').lean();
      webhookSecret =
        client?.audienceContext?.integrations?.[integrationKey]?.webhookSecret || '';
    }
    if (!webhookSecret) {
      webhookSecret = generateWebhookSecret();
    }
    if (!integrationKey) {
      return res.status(400).json({ success: false, message: 'Unknown provider' });
    }
    const saved = await saveThirdPartyWebhookSecret(clientId, integrationKey, webhookSecret);
    res.json({ success: true, ...saved, webhookSecret });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Failed to save secret' });
  }
});

/**
 * POST /api/abandoned-carts/third-party/:clientId/:provider/test
 * Verify live webhook events from the partner — does not simulate inbound traffic.
 */
router.post(
  '/third-party/:clientId/:provider/test',
  protect,
  verifyClientAccess,
  async (req, res) => {
    try {
      const { clientId, provider } = req.params;
      const providerMap = {
        gokwik: 'gokwik',
        razorpay: 'razorpay_magic',
        'razorpay-magic': 'razorpay_magic',
        cashfree: 'cashfree_checkout',
        'cashfree-checkout': 'cashfree_checkout',
        shiprocket: 'shiprocket',
        'shiprocket-checkout': 'shiprocket',
      };
      const key = providerMap[provider];
      if (!key) {
        return res.status(400).json({ success: false, message: 'Unknown provider' });
      }

      const integrationKey =
        key === 'shiprocket' ? 'shiprocket_checkout' : key === 'cashfree_checkout' ? 'cashfree_checkout' : key;

      const Client = require('../models/Client');
      const client = await Client.findOne({ clientId }).select('audienceContext').lean();
      const cfg = client?.audienceContext?.integrations?.[integrationKey] || {};
      const lastReceivedAt = cfg.partnerWebhookReceivedAt || null;

      if (!lastReceivedAt) {
        const partnerLabel =
          key === 'gokwik'
            ? 'GoKwik'
            : key === 'razorpay_magic'
              ? 'Razorpay Magic'
              : key === 'cashfree_checkout'
                ? 'Cashfree'
                : key === 'shiprocket_checkout'
                  ? 'Shiprocket'
                  : 'your checkout partner';
        return res.status(422).json({
          success: false,
          linked: false,
          lastReceivedAt: null,
          message: `No live webhook events from ${partnerLabel} yet. Paste the URL in your partner panel and wait for an abandoned checkout event.`,
        });
      }

      res.json({
        success: true,
        linked: true,
        lastReceivedAt,
        message: 'Live webhook events detected from your checkout partner.',
      });
    } catch (err) {
      console.error('[AbandonedCarts] third-party test error:', err);
      res.status(500).json({ success: false, message: err.message || 'Webhook check failed' });
    }
  }
);

/**
 * GET /api/abandoned-carts/workspace/leads/:leadId/gdpr-export
 */
router.get('/workspace/leads/:leadId/gdpr-export', protect, verifyClientAccess, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const format = String(req.query.format || 'json').toLowerCase();
    const { exportLeadBundle } = require('../services/gdpr/leadGdprService');
    const bundle = await exportLeadBundle({
      leadId: req.params.leadId,
      actor: { type: 'user', id: req.user?._id, email: req.user?.email },
      clientId,
    });
    if (bundle.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    if (format === 'pdf') {
      const { streamCartLeadGdprPdf } = require('../utils/commerce/cartLeadGdprPdf');
      const lead = bundle?.records?.AdLead?.[0] || {};
      const slug = String(lead.name || 'cart-lead').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
      const filename = `cart-lead-${slug}-${new Date().toISOString().split('T')[0]}`;
      return streamCartLeadGdprPdf(bundle, res, { filename });
    }

    res.json({ success: true, bundle });
  } catch (err) {
    const status = err.message === 'lead_not_found' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message || 'Export failed' });
  }
});

/**
 * POST /api/abandoned-carts/workspace/leads/:leadId/gdpr-erase
 */
router.post('/workspace/leads/:leadId/gdpr-erase', protect, verifyClientAccess, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const AdLead = require('../models/AdLead');
    const lead = await AdLead.findById(req.params.leadId).select('clientId').lean();
    if (!lead || lead.clientId !== clientId) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const { eraseLeadPii } = require('../services/gdpr/leadGdprService');
    const out = await eraseLeadPii({
      leadId: req.params.leadId,
      actor: { type: 'user', id: req.user?._id, email: req.user?.email },
    });
    res.json({ success: true, ...out });
  } catch (err) {
    const status = err.message === 'lead_not_found' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message || 'Erase failed' });
  }
});

module.exports = router;
