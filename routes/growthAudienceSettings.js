'use strict';

const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { buildGrowthEmbedOverview } = require('../utils/core/growthEmbedOverview');

/** Audience opt-in routes — mounted on /api/settings and /api/growth (same paths). */
function mountGrowthAudienceSettingsRoutes(router) {
  router.get('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const doc = await Client.findOne({ clientId }).select('growthCompliance growthWidgetConfig').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
      const compliance = doc.growthCompliance || {};
      res.json({
        success: true,
        compliance: {
          cartRecoveryRequiresOptIn: compliance.cartRecoveryRequiresOptIn === true,
          defaultOptInPolicy: compliance.defaultOptInPolicy || 'single',
          applyPolicyToNewSignups: compliance.applyPolicyToNewSignups !== false,
          stopKeywords: compliance.stopKeywords?.length
            ? compliance.stopKeywords
            : ['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'REMOVE', 'CANCEL'],
          doubleOptInEnabled: doc.growthWidgetConfig?.doubleOptInEnabled === true,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.put('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const updates = {};
      if (req.body.cartRecoveryRequiresOptIn !== undefined) {
        updates['growthCompliance.cartRecoveryRequiresOptIn'] = req.body.cartRecoveryRequiresOptIn === true;
      }
      if (req.body.defaultOptInPolicy) {
        updates['growthCompliance.defaultOptInPolicy'] =
          req.body.defaultOptInPolicy === 'double' ? 'double' : 'single';
      }
      if (req.body.applyPolicyToNewSignups !== undefined) {
        updates['growthCompliance.applyPolicyToNewSignups'] = req.body.applyPolicyToNewSignups !== false;
      }
      if (Array.isArray(req.body.stopKeywords)) {
        updates['growthCompliance.stopKeywords'] = req.body.stopKeywords
          .map((k) => String(k || '').trim().toUpperCase())
          .filter(Boolean);
      }
      const widgetUpdates = {};
      if (req.body.doubleOptInEnabled !== undefined) {
        widgetUpdates['growthWidgetConfig.doubleOptInEnabled'] = req.body.doubleOptInEnabled === true;
      }
      const doc = await Client.findOneAndUpdate(
        { clientId },
        { $set: { ...updates, ...widgetUpdates } },
        { new: true }
      ).select('growthCompliance growthWidgetConfig');
      if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
      res.json({
        success: true,
        compliance: doc.growthCompliance || {},
        growthWidgetConfig: doc.growthWidgetConfig,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/:clientId/capture-activity', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const { buildCaptureActivity } = require('../utils/core/captureActivity');
      const payload = await buildCaptureActivity(clientId, req.query);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/:clientId/capture-activity/export', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const { buildCaptureExport } = require('../utils/core/captureActivity');
      const rows = await buildCaptureExport(clientId, req.query);
      const header =
        'phone,email,source,canonical_source,status,timestamp,consent_text,ip,user_agent\n';
      const csv =
        header +
        rows
          .map((r) =>
            [
              r.phone,
              r.email,
              r.source,
              r.canonicalSource,
              r.status,
              r.timestamp ? new Date(r.timestamp).toISOString() : '',
              `"${String(r.consentText || '').replace(/"/g, '""')}"`,
              r.ip,
              `"${String(r.userAgent || '').replace(/"/g, '""')}"`,
            ].join(',')
          )
          .join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="consent-records.csv"');
      res.send(csv);
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/:clientId/opt-in-sources-status', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const { buildOptInSourcesStatus } = require('../utils/core/optInSourcesStatus');
      const payload = await buildOptInSourcesStatus(clientId);
      if (!payload) return res.status(404).json({ success: false, message: 'Client not found' });
      res.json(payload);
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/:clientId/growth-embed-overview', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const period = String(req.query.period || '30d').toLowerCase();
      const { buildTrackingHealth } = require('../utils/commerce/trackingHealth');
      const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
      const tracking = await buildTrackingHealth(clientId, days).catch(() => null);
      const payload = await buildGrowthEmbedOverview(clientId, period, tracking);
      if (!payload) return res.status(404).json({ success: false, message: 'Client not found' });
      res.json(payload);
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = { mountGrowthAudienceSettingsRoutes };
